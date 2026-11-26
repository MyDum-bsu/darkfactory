// Детерминированные тесты merge-очереди: все эффекты через моки портов,
// внешних зависимостей нет. Каждый сценарий проверяет и результат, и
// отсутствие запрещённого эффекта на targetBranch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PROTECTED_BRANCH_PATTERNS, canonicalizeBranchName, isProtectedBranch,
  computeOwnerApprovalToken, validateMergeCandidate, processMergeCandidate,
  drainMergeQueue } from './merge-queue.mjs';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);
const SHA_R = 'd'.repeat(40);
const SECRET = 'owner-approval-test-secret';

const validCandidate = (over = {}) => ({
  sha: SHA_B, taskId: '7914', receipt: { outcome: 'verified' },
  targetBranch: 'dev', ...over,
});

// Валидный HMAC-токен допуска владельца для кандидата: связка
// taskId|sha|canonicalBranch, ровно как считает верификатор.
function approvalFor(candidate, secret = SECRET, branch = 'main') {
  return { approved: true,
    token: computeOwnerApprovalToken(secret, candidate.taskId, candidate.sha, branch) };
}

// Мок портов с записью вызовов: state.head — голова ветки, ancestor — ответ
// isAncestor, rebase — сценарий rebase, smoke — сценарий smoke-проверки.
function portsMock(options = {}) {
  const has = key => Object.prototype.hasOwnProperty.call(options, key);
  const head = has('head') ? options.head : SHA_A;
  const ancestor = has('ancestor') ? options.ancestor : true;
  const rebase = has('rebase') ? options.rebase : { ok: true, rebasedSha: SHA_R };
  const smoke = has('smoke') ? options.smoke : { ok: true };
  const calls = { fastForward: [], rebase: [], smoke: [], update: [], isAncestor: [] };
  return {
    calls,
    isAncestor: async (base, sha) => { calls.isAncestor.push([base, sha]); return ancestor; },
    getHead: async () => head,
    tryFastForward: async (branch, sha, cas) => { calls.fastForward.push([branch, sha, cas]); return { ok: true }; },
    tryRebase: async (branch, sha) => { calls.rebase.push([branch, sha]); return rebase; },
    runSmokeCheck: async sha => { calls.smoke.push(sha); return smoke; },
    updateBranch: async (branch, sha, cas) => { calls.update.push([branch, sha, cas]); return { ok: true }; },
  };
}

test('canonicalizeBranchName strips ref prefixes to a fixpoint and trims', () => {
  assert.equal(canonicalizeBranchName('main'), 'main');
  assert.equal(canonicalizeBranchName('  main  '), 'main');
  assert.equal(canonicalizeBranchName('refs/heads/main'), 'main');
  assert.equal(canonicalizeBranchName('refs/remotes/origin/main'), 'main');
  assert.equal(canonicalizeBranchName('refs/remotes/upstream/release/v2'), 'release/v2');
  assert.equal(canonicalizeBranchName('origin/main'), 'main');
  // Многослойные обёртки снимаются до неподвижной точки.
  assert.equal(canonicalizeBranchName('refs/heads/refs/heads/main'), 'main');
  assert.equal(canonicalizeBranchName('refs/remotes/origin/refs/heads/main'), 'main');
  assert.equal(canonicalizeBranchName('origin/origin/main'), 'main');
  assert.equal(canonicalizeBranchName('feat/dev'), 'feat/dev');
});

test('canonicalizeBranchName rejects empty, whitespace, control chars and dot-dot', () => {
  assert.equal(canonicalizeBranchName(undefined), null);
  assert.equal(canonicalizeBranchName(null), null);
  assert.equal(canonicalizeBranchName(42), null);
  assert.equal(canonicalizeBranchName(''), null);
  assert.equal(canonicalizeBranchName('   '), null);
  assert.equal(canonicalizeBranchName('refs/heads/'), null);
  assert.equal(canonicalizeBranchName('origin/'), null);
  assert.equal(canonicalizeBranchName('refs/remotes/origin'), null);
  assert.equal(canonicalizeBranchName('a b'), null);
  assert.equal(canonicalizeBranchName('a\tb'), null);
  assert.equal(canonicalizeBranchName('a\0b'), null);
  assert.equal(canonicalizeBranchName('a\x07b'), null);
  assert.equal(canonicalizeBranchName('a\x7fb'), null);
  assert.equal(canonicalizeBranchName('../main'), null);
  assert.equal(canonicalizeBranchName('refs/heads/../main'), null);
  assert.equal(canonicalizeBranchName('main..x'), null);
  // Краевой whitespace снимается trim — валидное ядро остаётся.
  assert.equal(canonicalizeBranchName(' main '), 'main');
});

test('protected branch patterns match exactly and by prefix', () => {
  // Паттерн 'release' + '/' + '*' записан конкатенацией: литерал со смежными
  // символами '/' и '*' tamper-gate читал бы как незакрытый блок-комментарий.
  assert.deepEqual([...PROTECTED_BRANCH_PATTERNS], ['main', 'master', 'production', 'release/' + '*']);
  for (const branch of ['main', 'master', 'production', 'release/v2', 'release/1.0-rc']) {
    assert.equal(isProtectedBranch(branch), true, branch);
  }
  for (const branch of ['dev', 'feat/x', 'mainline', 'masterful', 'production2', 'release', 'releases/v2']) {
    assert.equal(isProtectedBranch(branch), false, branch);
  }
  assert.equal(isProtectedBranch(undefined), false);
  assert.equal(isProtectedBranch(''), false);
});

test('isProtectedBranch cannot be bypassed by ref spelling or case', () => {
  for (const branch of [
    'refs/heads/main', 'origin/main', 'MAIN', 'Main', 'refs/remotes/origin/main',
    '  main  ', 'MASTER', 'refs/heads/master',
    'origin/production', 'refs/heads/release/v2', 'origin/release/v2', 'RELEASE/V2',
    'refs/remotes/upstream/release/v2',
  ]) {
    assert.equal(isProtectedBranch(branch), true, branch);
  }
  // Незащищённые ветки в ref-форме остаются незащищёнными.
  for (const branch of ['refs/heads/dev', 'origin/feat/x', 'refs/remotes/origin/mainline']) {
    assert.equal(isProtectedBranch(branch), false, branch);
  }
});

test('validateMergeCandidate rejects incomplete or unproven candidates', () => {
  assert.equal(validateMergeCandidate(validCandidate()), true);
  // verdict === 'REVIEW_OK' — равноправное доказательство приёмки.
  assert.equal(validateMergeCandidate(validCandidate({ receipt: undefined, verdict: 'REVIEW_OK' })), true);
  assert.equal(validateMergeCandidate(validCandidate({
    receipt: { verdict: 'REVIEW_OK', outcome: 'other' } })), true);
  // Числовой идентификатор задачи Board допустим наравне со строковым.
  assert.equal(validateMergeCandidate(validCandidate({ taskId: 7914 })), true);
  for (const [patch, code] of [
    [null, 'merge_candidate_invalid'],
    [undefined, 'merge_candidate_invalid'],
    [{ sha: undefined }, 'merge_candidate_sha_invalid'],
    [{ sha: '' }, 'merge_candidate_sha_invalid'],
    [{ sha: 'abc' }, 'merge_candidate_sha_invalid'],
    [{ sha: 'z'.repeat(40) }, 'merge_candidate_sha_invalid'],
    [{ sha: SHA_B.toUpperCase() }, 'merge_candidate_sha_invalid'],
    [{ taskId: undefined }, 'merge_candidate_task_id_required'],
    [{ taskId: '' }, 'merge_candidate_task_id_required'],
    [{ taskId: null }, 'merge_candidate_task_id_required'],
    [{ taskId: NaN }, 'merge_candidate_task_id_required'],
    [{ taskId: {} }, 'merge_candidate_task_id_required'],
    [{ receipt: undefined }, 'merge_candidate_review_evidence_required'],
    [{ receipt: { outcome: 'rework' } }, 'merge_candidate_review_evidence_required'],
    [{ targetBranch: undefined }, 'merge_target_branch_required'],
    [{ targetBranch: '' }, 'merge_target_branch_required'],
    [{ targetBranch: '   ' }, 'merge_target_branch_invalid'],
    [{ targetBranch: '../etc' }, 'merge_target_branch_invalid'],
    [{ targetBranch: 'a\0b' }, 'merge_target_branch_invalid'],
    [{ targetBranch: 'refs/heads/' }, 'merge_target_branch_invalid'],
    [{ targetBranch: 'has space' }, 'merge_target_branch_invalid'],
  ]) {
    const candidate = patch === null || patch === undefined ? patch : validCandidate(patch);
    assert.throws(() => validateMergeCandidate(candidate),
      error => error.message === code, JSON.stringify(patch));
  }
  // Структурная валидация не решает допуск: защищённая ветка без него —
  // валидная форма, отказ наступает в processMergeCandidate.
  assert.equal(validateMergeCandidate(validCandidate({ targetBranch: 'main' })), true);
});

test('protected targets fail closed without verifier or secret', async () => {
  for (const branch of ['main', 'master', 'production', 'release/v2']) {
    const ports = portsMock();
    await assert.rejects(() => processMergeCandidate(validCandidate({ targetBranch: branch }), ports),
      /protected_branch_requires_owner_approval/, branch);
    assert.equal(ports.calls.fastForward.length, 0);
    assert.equal(ports.calls.rebase.length, 0);
    assert.equal(ports.calls.update.length, 0);
  }
  // Даже правдоподобный на вид объект допуска не открывает гейт без
  // верификатора или секрета.
  const ports = portsMock();
  await assert.rejects(() => processMergeCandidate(validCandidate({ targetBranch: 'main',
    ownerApproval: { approved: true, token: 'owner-token-123' } }), ports),
    /protected_branch_requires_owner_approval/);
  assert.equal(ports.calls.fastForward.length, 0);
});

test('dummy tokens and missing approvals never pass HMAC verification', async () => {
  const options = { ownerApprovalSecret: SECRET };
  for (const approval of [
    undefined, null, {}, { approved: true }, { approved: true, token: 'owner-token' },
    { approved: true, token: 'x'.repeat(64) }, { approved: true, token: 12345678 },
    { approved: true, token: 'Z'.repeat(64) }, { approved: true, token: 'a'.repeat(63) },
    { approved: true, token: 'a'.repeat(65) }, { token: '' },
  ]) {
    const ports = portsMock();
    await assert.rejects(() => processMergeCandidate(validCandidate({ targetBranch: 'main',
      ownerApproval: approval }), ports, options), /protected_branch_requires_owner_approval/,
      JSON.stringify(approval));
    assert.equal(ports.calls.fastForward.length, 0, JSON.stringify(approval));
  }
});

test('valid HMAC approval opens the protected gate; binding is exact', async () => {
  const options = { ownerApprovalSecret: SECRET };
  const candidate = validCandidate({ targetBranch: 'main' });
  candidate.ownerApproval = approvalFor(candidate);
  const ports = portsMock();
  const result = await processMergeCandidate(candidate, ports, options);
  assert.equal(result.status, 'merged');
  assert.deepEqual(ports.calls.fastForward, [['main', SHA_B, { expectedHead: SHA_A }]]);

  // Токен, выписанный на другую задачу, SHA или ветку, не проходит.
  for (const wrong of [
    { taskId: 'other' }, { sha: SHA_C }, { branch: 'master' }, { branch: 'dev' },
  ]) {
    const token = computeOwnerApprovalToken(SECRET,
      wrong.taskId ?? candidate.taskId, wrong.sha ?? candidate.sha, wrong.branch ?? 'main');
    const ports2 = portsMock();
    await assert.rejects(() => processMergeCandidate(validCandidate({ targetBranch: 'main',
      ownerApproval: { approved: true, token } }), ports2, options),
      /protected_branch_requires_owner_approval/, JSON.stringify(wrong));
    assert.equal(ports2.calls.fastForward.length, 0);
  }
  // Неверный секрет не verifies.
  const wrongSecretToken = computeOwnerApprovalToken('wrong-secret', candidate.taskId, candidate.sha, 'main');
  await assert.rejects(() => processMergeCandidate(validCandidate({ targetBranch: 'main',
    ownerApproval: { approved: true, token: wrongSecretToken } }), portsMock(), options),
    /protected_branch_requires_owner_approval/);
});

test('HMAC binding uses the canonical branch, not the raw spelling', async () => {
  const options = { ownerApprovalSecret: SECRET };
  // Кандидат целится в refs/heads/main: каноническая ветка — main, токен
  // выписан на main. Порт получает каноническое имя.
  const candidate = validCandidate({ targetBranch: 'refs/heads/main' });
  candidate.ownerApproval = approvalFor(candidate, SECRET, 'main');
  const ports = portsMock();
  const result = await processMergeCandidate(candidate, ports, options);
  assert.equal(result.status, 'merged');
  assert.deepEqual(ports.calls.fastForward, [['main', SHA_B, { expectedHead: SHA_A }]]);
  // Токен на сырое написание refs/heads/main не проходит.
  const rawToken = computeOwnerApprovalToken(SECRET, candidate.taskId, candidate.sha, 'refs/heads/main');
  await assert.rejects(() => processMergeCandidate(validCandidate({ targetBranch: 'refs/heads/main',
    ownerApproval: { approved: true, token: rawToken } }), portsMock(), options),
    /protected_branch_requires_owner_approval/);
});

test('bypass attempts via ref spelling hit the protected gate', async () => {
  const options = { ownerApprovalSecret: SECRET };
  for (const branch of ['refs/heads/main', 'origin/main', 'MAIN', 'refs/remotes/origin/master']) {
    const ports = portsMock();
    await assert.rejects(() => processMergeCandidate(validCandidate({ targetBranch: branch,
      ownerApproval: { approved: true, token: 'dummy-dummy' } }), ports, options),
      /protected_branch_requires_owner_approval/, branch);
    assert.equal(ports.calls.fastForward.length, 0, branch);
    assert.equal(ports.calls.rebase.length, 0, branch);
  }
});

test('injected verifyOwnerApproval port is the sole authority when present', async () => {
  const seen = [];
  const verifier = async (candidate, approval) => {
    seen.push([candidate.taskId, approval]);
    return approval?.token === 'owner-signature';
  };
  const candidate = validCandidate({ targetBranch: 'main',
    ownerApproval: { approved: true, token: 'owner-signature' } });
  const ports = { ...portsMock(), verifyOwnerApproval: verifier };
  const result = await processMergeCandidate(candidate, ports);
  assert.equal(result.status, 'merged');
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0][0], '7914');
  assert.deepEqual(seen[0][1], { approved: true, token: 'owner-signature' });

  // Верификатор отклоняет — даже валидный по HMAC токен не спасает:
  // приоритет порта над секретом.
  const rejecting = async () => false;
  const candidate2 = validCandidate({ targetBranch: 'main' });
  candidate2.ownerApproval = approvalFor(candidate2);
  const ports2 = { ...portsMock(), verifyOwnerApproval: rejecting };
  await assert.rejects(() => processMergeCandidate(candidate2, ports2,
    { ownerApprovalSecret: SECRET }), /protected_branch_requires_owner_approval/);

  // Синхронный верификатор тоже поддерживается.
  const ports3 = { ...portsMock(), verifyOwnerApproval: () => true };
  const result3 = await processMergeCandidate(candidate, ports3);
  assert.equal(result3.status, 'merged');
});

test('verifyOwnerApproval can also be injected via options', async () => {
  const candidate = validCandidate({ targetBranch: 'main',
    ownerApproval: { approved: true, token: 'signed' } });
  const options = { verifyOwnerApproval: async (cand, approval) =>
    cand.sha === SHA_B && approval?.token === 'signed' };
  const result = await processMergeCandidate(candidate, portsMock(), options);
  assert.equal(result.status, 'merged');
  // ports-верификатор имеет приоритет над options-верификатором.
  const ports = { ...portsMock(), verifyOwnerApproval: async () => false };
  await assert.rejects(() => processMergeCandidate(candidate, ports, options),
    /protected_branch_requires_owner_approval/);
});

test('verifier exceptions fail closed, never open the gate', async () => {
  const ports = { ...portsMock(), verifyOwnerApproval: async () => { throw new Error('verifier down'); } };
  await assert.rejects(() => processMergeCandidate(validCandidate({ targetBranch: 'main',
    ownerApproval: { approved: true, token: 'whatever' } }), ports),
    /protected_branch_requires_owner_approval/);
  assert.equal(ports.calls.fastForward.length, 0);
});

test('unprotected branches never require owner approval', async () => {
  for (const branch of ['dev', 'feat/x', 'mainline', 'release']) {
    const ports = portsMock();
    const result = await processMergeCandidate(validCandidate({ targetBranch: branch }), ports);
    assert.equal(result.status, 'merged', branch);
  }
});

test('fast-forward merge when head is an ancestor of the candidate', async () => {
  const ports = portsMock({ ancestor: true });
  const result = await processMergeCandidate(validCandidate(), ports);
  assert.deepEqual(result, { status: 'merged', mode: 'fast_forward', sha: SHA_B, retested: false });
  assert.deepEqual(ports.calls.fastForward, [['dev', SHA_B, { expectedHead: SHA_A }]]);
  // FF не перебазирует и не перепроверяет: история линейна, SHA тот же.
  assert.equal(ports.calls.rebase.length, 0);
  assert.equal(ports.calls.smoke.length, 0);
  assert.equal(ports.calls.update.length, 0);
  assert.deepEqual(ports.calls.isAncestor, [[SHA_A, SHA_B]]);
});

test('non-FF rebase runs the mandatory smoke check and merges the rebased sha', async () => {
  const ports = portsMock({ ancestor: false });
  const result = await processMergeCandidate(validCandidate(), ports);
  assert.deepEqual(result, { status: 'merged', mode: 'rebased', sha: SHA_R, retested: true });
  assert.deepEqual(ports.calls.rebase, [['dev', SHA_B]]);
  // Smoke обязателен и идёт строго по перебазированному SHA, до updateBranch.
  assert.deepEqual(ports.calls.smoke, [SHA_R]);
  assert.deepEqual(ports.calls.update, [['dev', SHA_R, { expectedHead: SHA_A }]]);
  assert.equal(ports.calls.fastForward.length, 0);
});

test('compare-and-swap: expectedHead is the head read at the start', async () => {
  const head = 'e'.repeat(40);
  // FF-путь: expectedHead уходит в tryFastForward и не доходит до updateBranch.
  const ports = portsMock({ ancestor: true, head });
  await processMergeCandidate(validCandidate(), ports);
  assert.deepEqual(ports.calls.fastForward, [['dev', SHA_B, { expectedHead: head }]]);
  // Rebase-путь: updateBranch получает ту же прочитанную голову.
  const ports2 = portsMock({ ancestor: false, head });
  await processMergeCandidate(validCandidate(), ports2);
  assert.deepEqual(ports2.calls.update, [['dev', SHA_R, { expectedHead: head }]]);
  // Невалидная голова (пустая ветка) передаётся как есть — порт решает.
  const ports3 = portsMock({ ancestor: false, head: null });
  await processMergeCandidate(validCandidate(), ports3);
  assert.deepEqual(ports3.calls.update, [['dev', SHA_R, { expectedHead: null }]]);
});

test('smoke failure after rebase returns the candidate without touching the branch', async () => {
  const ports = portsMock({ ancestor: false, smoke: { ok: false, reason: 'l1_smoke_failed' } });
  const result = await processMergeCandidate(validCandidate(), ports);
  assert.deepEqual(result, { status: 'smoke_failed', rebasedSha: SHA_R,
    reason: 'l1_smoke_failed', action: 'return_to_worker' });
  assert.deepEqual(ports.calls.smoke, [SHA_R]);
  assert.equal(ports.calls.update.length, 0, 'ветка не обновлена');
  assert.equal(ports.calls.fastForward.length, 0);
});

test('smoke result without ok also fails closed with a default reason', async () => {
  for (const smoke of [{}, null, undefined, { ok: false }]) {
    const ports = portsMock({ ancestor: false, smoke });
    const result = await processMergeCandidate(validCandidate(), ports);
    assert.equal(result.status, 'smoke_failed');
    assert.equal(result.action, 'return_to_worker');
    assert.equal(typeof result.reason, 'string');
    assert.equal(ports.calls.update.length, 0);
  }
});

test('rebase conflict returns diagnostics without touching the branch', async () => {
  const conflicts = [{ path: 'a.js', detail: 'both modified' }];
  const ports = portsMock({ ancestor: false, rebase: { ok: false, conflicts } });
  const result = await processMergeCandidate(validCandidate(), ports);
  assert.deepEqual(result, { status: 'conflict', conflicts, action: 'return_to_worker' });
  assert.equal(ports.calls.update.length, 0, 'ветка не обновлена');
  assert.equal(ports.calls.smoke.length, 0, 'smoke не запускался при конфликте');
  assert.equal(ports.calls.fastForward.length, 0);
});

test('a missing or malformed rebase result is a conflict, never a merge', async () => {
  for (const rebase of [null, undefined, {}, { ok: false }]) {
    const ports = portsMock({ ancestor: false, rebase });
    const result = await processMergeCandidate(validCandidate(), ports);
    assert.equal(result.status, 'conflict');
    assert.deepEqual(result.conflicts, []);
    assert.equal(ports.calls.update.length, 0);
    assert.equal(ports.calls.smoke.length, 0);
  }
  // Перебазированный SHA обязан быть валидным коммитом — иначе отказ.
  const ports = portsMock({ ancestor: false, rebase: { ok: true, rebasedSha: 'bogus' } });
  await assert.rejects(() => processMergeCandidate(validCandidate(), ports), /rebase_result_invalid/);
  assert.equal(ports.calls.update.length, 0);
  assert.equal(ports.calls.smoke.length, 0);
});

test('transient fast-forward failure returns retryable error, not invalid', async () => {
  const ports = portsMock({ ancestor: true });
  ports.tryFastForward = async () => ({ ok: false, reason: 'head_moved' });
  const result = await processMergeCandidate(validCandidate(), ports);
  assert.deepEqual(result, { status: 'error', reason: 'head_moved', action: 'retry' });
  assert.equal(ports.calls.update.length, 0);
  // Без reason — кодированная причина по умолчанию.
  const ports2 = portsMock({ ancestor: true });
  ports2.tryFastForward = async () => ({ ok: false });
  const result2 = await processMergeCandidate(validCandidate(), ports2);
  assert.equal(result2.status, 'error');
  assert.equal(result2.reason, 'fast_forward_failed');
});

test('transient updateBranch failure returns retryable error after successful smoke', async () => {
  const ports = portsMock({ ancestor: false });
  ports.updateBranch = async () => ({ ok: false, reason: 'cas_mismatch' });
  const result = await processMergeCandidate(validCandidate(), ports);
  assert.deepEqual(result, { status: 'error', reason: 'cas_mismatch', action: 'retry' });
  assert.deepEqual(ports.calls.smoke, [SHA_R]);
  // Молчаливого merge нет, но и постоянного отказа нет — повтор возможен.
  const ports2 = portsMock({ ancestor: false });
  ports2.updateBranch = async () => ({ ok: false });
  const result2 = await processMergeCandidate(validCandidate(), ports2);
  assert.equal(result2.reason, 'update_branch_failed');
});

test('throwing ports are transient errors, never exceptions escaping to the caller', async () => {
  for (const [patch, label] of [
    ['getHead', 'getHead'], ['isAncestor', 'isAncestor'], ['tryRebase', 'tryRebase'],
    ['runSmokeCheck', 'runSmokeCheck'], ['updateBranch', 'updateBranch'], ['tryFastForward', 'tryFastForward'],
  ]) {
    const ports = portsMock({ ancestor: patch !== 'tryRebase' && patch !== 'runSmokeCheck' && patch !== 'updateBranch' });
    ports[patch] = async () => { throw new Error(`${label} io failure`); };
    const result = await processMergeCandidate(validCandidate(), ports);
    assert.equal(result.status, 'error', label);
    assert.equal(result.action, 'retry', label);
    assert.equal(result.reason, `${label} io failure`, label);
  }
  // Ошибка без сообщения — причина по умолчанию.
  const ports = portsMock();
  ports.getHead = async () => { throw new Error(); };
  const result = await processMergeCandidate(validCandidate(), ports);
  assert.equal(result.status, 'error');
  assert.equal(result.reason, 'merge_port_failure');
});

test('processMergeCandidate validates before any port call and requires all ports', async () => {
  const ports = portsMock();
  await assert.rejects(() => processMergeCandidate({ sha: 'bogus' }, ports),
    /merge_candidate_sha_invalid/);
  assert.equal(ports.calls.fastForward.length, 0);
  await assert.rejects(() => processMergeCandidate(validCandidate(), {}), /merge_port_missing/);
  await assert.rejects(() => processMergeCandidate(validCandidate(), null), /merge_ports_required/);
  await assert.rejects(() => processMergeCandidate(validCandidate(), {
    ...ports, updateBranch: undefined }), /merge_port_missing/);
});

test('drainMergeQueue processes FIFO and continues past conflicts and invalid items', async () => {
  const order = [];
  const scenario = {
    // Первый кандидат — FF merge; второй — конфликт; третий — снова merge:
    // конфликт середины не прерывает независимые хвостовые кандидаты.
    perSha: {
      [SHA_A]: { ancestor: true },
      [SHA_B]: { ancestor: false, rebase: { ok: false, conflicts: [{ path: 'x' }] } },
      [SHA_C]: { ancestor: true },
    },
  };
  const ports = {
    isAncestor: async (base, sha) => scenario.perSha[sha]?.ancestor === true,
    getHead: async () => SHA_R,
    tryFastForward: async (branch, sha) => { order.push(`ff:${sha[0]}`); return { ok: true }; },
    tryRebase: async (branch, sha) => { order.push(`rebase:${sha[0]}`); return scenario.perSha[sha]?.rebase ?? { ok: true, rebasedSha: SHA_R }; },
    runSmokeCheck: async () => ({ ok: true }),
    updateBranch: async (branch, sha) => { order.push(`update:${sha[0]}`); return { ok: true }; },
  };
  const candidates = [
    validCandidate({ sha: SHA_A, taskId: '1' }),
    validCandidate({ sha: SHA_B, taskId: '2' }),
    validCandidate({ sha: SHA_C, taskId: '3' }),
  ];
  const results = await drainMergeQueue(candidates, ports);
  assert.equal(results.length, 3);
  assert.deepEqual(results.map(r => r.status), ['merged', 'conflict', 'merged']);
  assert.deepEqual(results.map(r => r.taskId), ['1', '2', '3']);
  assert.equal(results[1].action, 'return_to_worker');
  // FIFO: порядок эффектов совпадает с порядком входа.
  assert.deepEqual(order, ['ff:a', 'rebase:b', 'ff:c']);
});

test('drainMergeQueue captures invalid items per-slot and keeps draining', async () => {
  const ports = portsMock();
  const results = await drainMergeQueue([
    { sha: 'bogus', taskId: 'bad' },
    validCandidate({ sha: SHA_B, taskId: 'good' }),
    null,
    validCandidate({ sha: SHA_C, taskId: 'protected', targetBranch: 'main' }),
  ], ports);
  assert.equal(results.length, 4);
  assert.equal(results[0].status, 'invalid');
  assert.equal(results[0].reason, 'merge_candidate_sha_invalid');
  assert.equal(results[0].taskId, 'bad');
  assert.equal(results[1].status, 'merged');
  assert.equal(results[2].status, 'invalid');
  assert.equal(results[3].status, 'invalid');
  assert.equal(results[3].reason, 'protected_branch_requires_owner_approval');
  // Эффект только у валидного кандидата.
  assert.deepEqual(ports.calls.fastForward, [['dev', SHA_B, { expectedHead: SHA_A }]]);
  await assert.rejects(() => drainMergeQueue(null, ports), /merge_queue_invalid/);
  assert.deepEqual(await drainMergeQueue([], ports), []);
});

test('drainMergeQueue distinguishes retryable errors from permanent invalid', async () => {
  const ports = portsMock({ ancestor: true });
  let calls = 0;
  ports.tryFastForward = async () => {
    calls += 1;
    return calls === 1 ? { ok: false, reason: 'head_moved' } : { ok: true };
  };
  const candidates = [
    validCandidate({ sha: SHA_A, taskId: 'flaky' }),
    validCandidate({ sha: SHA_B, taskId: 'steady' }),
    { sha: 'bogus', taskId: 'broken' },
  ];
  const results = await drainMergeQueue(candidates, ports);
  assert.deepEqual(results.map(r => r.status), ['error', 'merged', 'invalid']);
  assert.equal(results[0].action, 'retry');
  assert.equal(results[0].reason, 'head_moved');
  assert.equal(results[2].reason, 'merge_candidate_sha_invalid');
});

test('drainMergeQueue threads options to HMAC verification', async () => {
  const ports = portsMock();
  const candidate = validCandidate({ sha: SHA_C, taskId: 'protected', targetBranch: 'main' });
  candidate.ownerApproval = approvalFor(candidate);
  const results = await drainMergeQueue([candidate], ports, { ownerApprovalSecret: SECRET });
  assert.equal(results[0].status, 'merged');
  // Без секрета — постоянный invalid, а не error.
  const results2 = await drainMergeQueue([candidate], portsMock());
  assert.equal(results2[0].status, 'invalid');
  assert.equal(results2[0].reason, 'protected_branch_requires_owner_approval');
});

test('numeric taskId binds into the HMAC exactly like its string form', async () => {
  const options = { ownerApprovalSecret: SECRET };
  const candidate = validCandidate({ taskId: 7914, targetBranch: 'main' });
  candidate.ownerApproval = { approved: true,
    token: computeOwnerApprovalToken(SECRET, 7914, candidate.sha, 'main') };
  const result = await processMergeCandidate(candidate, portsMock(), options);
  assert.equal(result.status, 'merged');
});
