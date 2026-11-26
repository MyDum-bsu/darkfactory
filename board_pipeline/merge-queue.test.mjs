// Детерминированные тесты merge-очереди: все эффекты через моки портов,
// внешних зависимостей нет. Каждый сценарий проверяет и результат, и
// отсутствие запрещённого эффекта на targetBranch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PROTECTED_BRANCH_PATTERNS, isProtectedBranch, validateMergeCandidate,
  processMergeCandidate, drainMergeQueue } from './merge-queue.mjs';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);
const SHA_R = 'd'.repeat(40);

const validCandidate = (over = {}) => ({
  sha: SHA_B, taskId: '7914', receipt: { outcome: 'verified' },
  targetBranch: 'dev', ...over,
});

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
    tryFastForward: async (branch, sha) => { calls.fastForward.push([branch, sha]); return { ok: true }; },
    tryRebase: async (branch, sha) => { calls.rebase.push([branch, sha]); return rebase; },
    runSmokeCheck: async sha => { calls.smoke.push(sha); return smoke; },
    updateBranch: async (branch, sha) => { calls.update.push([branch, sha]); return { ok: true }; },
  };
}

test('protected branch patterns match exactly and by prefix', () => {
  assert.deepEqual([...PROTECTED_BRANCH_PATTERNS], ['main', 'master', 'production', 'release/*']);
  for (const branch of ['main', 'master', 'production', 'release/v2', 'release/1.0-rc']) {
    assert.equal(isProtectedBranch(branch), true, branch);
  }
  for (const branch of ['dev', 'feat/x', 'mainline', 'masterful', 'production2', 'release', 'releases/v2']) {
    assert.equal(isProtectedBranch(branch), false, branch);
  }
  assert.equal(isProtectedBranch(undefined), false);
  assert.equal(isProtectedBranch(''), false);
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
  ]) {
    const candidate = patch === null || patch === undefined ? patch : validCandidate(patch);
    assert.throws(() => validateMergeCandidate(candidate),
      error => error.message === code, JSON.stringify(patch));
  }
});

test('protected target branches require explicit owner approval', () => {
  for (const branch of ['main', 'master', 'production', 'release/v2']) {
    assert.throws(() => validateMergeCandidate(validCandidate({ targetBranch: branch })),
      /protected_branch_requires_owner_approval/, branch);
    // Допуск владельца: approved строго true и токен — строка не короче 8.
    assert.equal(validateMergeCandidate(validCandidate({ targetBranch: branch,
      ownerApproval: { approved: true, token: 'owner-token' } })), true, branch);
  }
  for (const approval of [
    undefined, null, {}, { approved: false, token: 'owner-token' },
    { approved: 'true', token: 'owner-token' }, { approved: true },
    { approved: true, token: 'short' }, { approved: true, token: 12345678 },
  ]) {
    assert.throws(() => validateMergeCandidate(validCandidate({ targetBranch: 'main',
      ownerApproval: approval })), /protected_branch_requires_owner_approval/,
      JSON.stringify(approval));
  }
  // Незащищённая ветка не требует допуска.
  assert.equal(validateMergeCandidate(validCandidate({ targetBranch: 'feat/dev' })), true);
});

test('fast-forward merge when head is an ancestor of the candidate', async () => {
  const ports = portsMock({ ancestor: true });
  const result = await processMergeCandidate(validCandidate(), ports);
  assert.deepEqual(result, { status: 'merged', mode: 'fast_forward', sha: SHA_B, retested: false });
  assert.deepEqual(ports.calls.fastForward, [['dev', SHA_B]]);
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
  assert.deepEqual(ports.calls.update, [['dev', SHA_R]]);
  assert.equal(ports.calls.fastForward.length, 0);
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

test('protected branches refuse auto-merge even with valid review evidence', async () => {
  for (const branch of ['main', 'master', 'release/v2']) {
    const ports = portsMock();
    await assert.rejects(() => processMergeCandidate(validCandidate({ targetBranch: branch }), ports),
      /protected_branch_requires_owner_approval/);
    assert.equal(ports.calls.fastForward.length, 0);
    assert.equal(ports.calls.rebase.length, 0);
    assert.equal(ports.calls.update.length, 0);
  }
  // Явный допуск владельца пропускает merge в защищённую ветку.
  const ports = portsMock();
  const result = await processMergeCandidate(validCandidate({ targetBranch: 'main',
    ownerApproval: { approved: true, token: 'owner-token-123' } }), ports);
  assert.equal(result.status, 'merged');
  assert.deepEqual(ports.calls.fastForward, [['main', SHA_B]]);
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
  assert.deepEqual(ports.calls.fastForward, [['dev', SHA_B]]);
  await assert.rejects(() => drainMergeQueue(null, ports), /merge_queue_invalid/);
  assert.deepEqual(await drainMergeQueue([], ports), []);
});

test('fast-forward and updateBranch port failures are fail-closed errors', async () => {
  const ports = portsMock({ ancestor: true });
  ports.tryFastForward = async () => ({ ok: false, reason: 'ff_rejected' });
  await assert.rejects(() => processMergeCandidate(validCandidate(), ports), /ff_rejected/);
  const ports2 = portsMock({ ancestor: false });
  ports2.updateBranch = async () => ({ ok: false, reason: 'update_rejected' });
  // Smoke прошёл, но обновление ветки отклонено — молчаливого merge нет.
  await assert.rejects(() => processMergeCandidate(validCandidate(), ports2), /update_rejected/);
  assert.deepEqual(ports2.calls.smoke, [SHA_R]);
});
