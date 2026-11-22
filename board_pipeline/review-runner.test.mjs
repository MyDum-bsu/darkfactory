import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import {
  executorFamily, assertCrossFamily, parseReviewTranscript, parseReviewVerdict,
  hasValidFinding, isolatedPiReviewRunner, runInReadOnlySandbox, snapshotDigest,
  worktreeFingerprint, assertToolsAllowed, ReviewDenied, REVIEW_IMAGE,
} from './review-runner.mjs';
import { buildSubject, subjectDigest } from './subject.mjs';
import { acceptHeld } from './acceptance.mjs';

const exec = promisify(execFile);

const CRITIC = { provider: 'openai', model: 'gpt-6.2-sol', reasoningLevel: 'medium' };

test('family: строгая таблица provider/model без подстрок', () => {
  // Голый провайдер без модели не аттестуется: обязательны оба поля.
  assert.equal(executorFamily('acp-devin'), null);
  assert.equal(executorFamily('acp-zcode-start'), null);
  assert.equal(executorFamily('acp-antigravity-acp'), null);
  assert.equal(executorFamily({ provider: 'acp-devin', model: 'swe-2-high' }), 'cognition');
  assert.equal(executorFamily({ provider: 'acp-zcode-start',
    model: 'builtin:zai-start-plan\\GLM-5.3-Flash' }), 'glm');
  assert.equal(executorFamily('opencode-go/deepseek-v4'), 'deepseek');
  assert.equal(executorFamily('openai/gpt-6.2-sol'), 'openai');
  assert.equal(executorFamily({ provider: 'openai', model: 'gpt-6.2-astra' }), 'openai');
  assert.equal(executorFamily({ provider: 'acp-antigravity-acp', model: 'gemini-4-neon' }), 'google');
  // Провайдер без модели и модель без провайдера — отказ.
  assert.equal(executorFamily({ provider: 'openai' }), null);
  assert.equal(executorFamily({ model: 'gpt-6.2-sol' }), null);
  // Голый id модели без провайдера не аттестуется: подстроки недостаточно.
  assert.equal(executorFamily('swe-2-medium'), null);
  assert.equal(executorFamily('builtin:zai-start-plan\\GLM-5.3-Flash'), null);
  assert.equal(executorFamily('deepseek-reasoner'), null);
  assert.equal(executorFamily('gemini-4-neon'), null);
  assert.equal(executorFamily('codex-exec'), null);
  assert.equal(executorFamily('mystery-model'), null);
  assert.equal(executorFamily(null), null);
});

test('family: противоречивая пара provider/model и подстрока-обманка', () => {
  // provider из одного семейства + model другого — отказ.
  assert.equal(executorFamily({ provider: 'acp-devin', model: 'gpt-6.2-sol' }), null);
  assert.equal(executorFamily({ provider: 'openai', model: 'swe-2-high' }), null);
  // Незнакомый id, содержащий подстроку известного семейства, — отказ.
  assert.equal(executorFamily('my-gpt-wrapper'), null);
  assert.equal(executorFamily({ provider: 'vendor', model: 'gpt-6.2-sol' }), null);
  assert.throws(() => assertCrossFamily(
    { provider: 'acp-devin', model: 'gpt-6.2-sol' }, CRITIC),
    (e) => e.reason === 'review_unknown_family');
  assert.throws(() => assertCrossFamily('my-gpt-wrapper', CRITIC),
    (e) => e.reason === 'review_unknown_family');
});

test('family: кросс-семейственный инвариант', () => {
  for (const executor of ['acp-devin/swe-2-high',
      'acp-zcode-start/builtin:zai-start-plan\\GLM-5.3-Flash',
      'opencode-go/deepseek-v4', 'acp-antigravity-acp/gemini-4-neon']) {
    assert.deepEqual(assertCrossFamily(executor, CRITIC).critic, 'openai');
  }
  // Только провайдер без модели — семейство не аттестовано.
  assert.throws(() => assertCrossFamily({ provider: 'acp-devin' }, CRITIC),
    (e) => e.reason === 'review_unknown_family');
  assert.throws(
    () => assertCrossFamily({ provider: 'openai', model: 'gpt-6.2-astra' }, CRITIC),
    (e) => e instanceof ReviewDenied && e.reason === 'review_same_family');
  assert.throws(() => assertCrossFamily('mystery', CRITIC),
    (e) => e.reason === 'review_unknown_family');
  assert.throws(() => assertCrossFamily('acp-devin', { provider: 'x', model: 'y' }),
    (e) => e.reason === 'review_unknown_family');
});

const msg = (over = {}) => JSON.stringify({ type: 'message_end', message: {
  role: 'assistant', provider: 'openai', model: 'gpt-6.2-sol',
  thinkingLevel: 'medium', responseId: 'resp_abc123', stopReason: 'stop',
  content: [{ type: 'text', text: 'looks fine\nREVIEW_OK' }], ...over } });
const settled = JSON.stringify({ type: 'agent_settled', aborted: false });

test('transcript: аттестация actual и checkpoint-данных из NDJSON', () => {
  const parsed = parseReviewTranscript([
    JSON.stringify({ type: 'session_info', toolsAdded: ['read', 'grep', 'find', 'ls'] }),
    msg(), msg({ content: [{ type: 'text', text: 'final\nREVIEW_OK' }] }), settled,
  ].join('\n'));
  assert.deepEqual(parsed.actual, { provider: 'openai', model: 'gpt-6.2-sol', reasoningLevel: 'medium' });
  assert.equal(parsed.responseId, 'resp_abc123');
  assert.match(parsed.finalText, /REVIEW_OK/);
  assert.deepEqual(parsed.toolsAdded, ['read', 'grep', 'find', 'ls']);
});

test('transcript: подмена модели/провайдера в одном из ходов — отказ', () => {
  assert.throws(() => parseReviewTranscript([
    msg(), msg({ model: 'gpt-6.2-astra' }),
  ].join('\n')), (e) => e.reason === 'review_model_mismatch');
  assert.throws(() => parseReviewTranscript([
    msg(), msg({ provider: 'anthropic' }),
  ].join('\n')), (e) => e.reason === 'review_model_mismatch');
  assert.throws(() => parseReviewTranscript([
    msg(), msg({ thinkingLevel: 'high' }),
  ].join('\n')), (e) => e.reason === 'review_effort_mismatch');
});

test('transcript: responseModel и providerThinkingLevel сверяются, toolsAdded объединяются', () => {
  // responseModel/actualModel, расходящийся с профилем, — отказ.
  assert.throws(() => parseReviewTranscript([
    msg(), msg({ responseModel: 'gpt-6.2-astra' }),
  ].join('\n')), (e) => e.reason === 'review_model_mismatch');
  assert.throws(() => parseReviewTranscript([
    msg(), msg({ actualModel: 'gpt-4o' }),
  ].join('\n')), (e) => e.reason === 'review_model_mismatch');
  // providerThinkingLevel/reasoningEffort, расходящийся с профилем, — отказ.
  assert.throws(() => parseReviewTranscript([
    msg(), msg({ providerThinkingLevel: 'high' }),
  ].join('\n')), (e) => e.reason === 'review_effort_mismatch');
  assert.throws(() => parseReviewTranscript([
    msg(), msg({ reasoningEffort: 'low' }),
  ].join('\n')), (e) => e.reason === 'review_effort_mismatch');
  // Совпадающие допполя — проходят.
  const ok = parseReviewTranscript([
    msg({ providerThinkingLevel: 'medium', responseModel: 'gpt-6.2-sol' }), settled,
  ].join('\n'));
  assert.equal(ok.actual.model, 'gpt-6.2-sol');
  // Union toolsAdded: инструмент из любого события виден в объединении,
  // включая НЕ первое сообщение в agent_end.messages.
  const union = parseReviewTranscript([
    JSON.stringify({ type: 'session_info', toolsAdded: [{ name: 'read' }, { name: 'grep' }] }),
    msg(),
    JSON.stringify({ type: 'agent_end', messages: [
      { toolsAdded: ['find', 'ls'] }, { toolsAdded: [{ name: 'find' }] }] }),
    JSON.stringify({ type: 'message_end', message: { toolsAdded: ['ls'] } }),
    settled,
  ].join('\n'));
  assert.deepEqual([...union.toolsAdded].sort(), ['find', 'grep', 'ls', 'read']);
  // Запрещённый инструмент в не-первом сообщении agent_end тоже попадает
  // в объединение и отсекается assertToolsAllowed.
  const blocked = [...parseReviewTranscript([
    msg(),
    JSON.stringify({ type: 'agent_end', messages: [
      { toolsAdded: ['read'] }, { toolsAdded: ['bash'] }] }),
    settled,
  ].join('\n')).toolsAdded];
  assert.throws(() => assertToolsAllowed(blocked),
    (e) => e.reason === 'review_forbidden_tool:bash');
  assert.throws(() => assertToolsAllowed(['read', 'bash']),
    (e) => e.reason === 'review_forbidden_tool:bash');
  assert.throws(() => assertToolsAllowed(['write']),
    (e) => e.reason === 'review_forbidden_tool:write');
  assert.doesNotThrow(() => assertToolsAllowed(['read', 'grep', 'find', 'ls']));
});

test('transcript: незавершённый/пустой финальный ход — отказ', () => {
  // Последний ход обязан stop/completed с непустым текстом.
  assert.throws(() => parseReviewTranscript([
    msg(), msg({ stopReason: 'length' }),
  ].join('\n')), (e) => e.reason === 'review_incomplete_turn');
  assert.throws(() => parseReviewTranscript([
    msg(), msg({ stopReason: 'error' }),
  ].join('\n')), (e) => e.reason === 'review_incomplete_turn');
  assert.throws(() => parseReviewTranscript([
    msg(), msg({ rawStopReason: 'cancelled' }),
  ].join('\n')), (e) => e.reason === 'review_incomplete_turn');
  // Пустой финал не засчитывается даже при живом раннем тексте.
  assert.throws(() => parseReviewTranscript([
    msg(), msg({ content: [] }),
  ].join('\n')), (e) => e.reason === 'review_incomplete_turn');
  // Событие error или aborted в потоке — отказ.
  assert.throws(() => parseReviewTranscript([
    msg(), JSON.stringify({ type: 'error', message: 'boom' }),
  ].join('\n')), (e) => e.reason === 'review_incomplete_turn');
  assert.throws(() => parseReviewTranscript([
    msg(), JSON.stringify({ type: 'agent_settled', aborted: true }),
  ].join('\n')), (e) => e.reason === 'review_incomplete_turn');
  // Поток без финального agent_settled вообще — отказ, даже при stop-ходе.
  assert.throws(() => parseReviewTranscript([
    msg(), msg({ content: [{ type: 'text', text: 'final\nREVIEW_OK' }] }),
  ].join('\n')), (e) => e.reason === 'review_incomplete_turn');
});

test('transcript: пустой и битый поток — отказ', () => {
  assert.throws(() => parseReviewTranscript(''), (e) => e.reason === 'review_transcript_empty');
  assert.throws(() => parseReviewTranscript('not json\n'), (e) => e.reason === 'review_transcript_corrupt');
});

test('verdict: канонический JSON-блок PASS', () => {
  const v = parseReviewVerdict('notes\n```json\n{"verdict":"PASS","summary":"ok",' +
    '"findings":[],"checked_invariants":["i1","i2"]}\n```\n');
  assert.equal(v.status, 'PASS');
  assert.equal(v.verdict, 'REVIEW_OK');
  assert.deepEqual(v.checked_invariants, ['i1', 'i2']);
});

test('verdict: REWORK с findings и маппинг REVIEW_BLOCKED', () => {
  const v = parseReviewVerdict('```json\n{"verdict":"REWORK","summary":"bad sum",' +
    '"findings":[{"file":"src/sum.js","line":3,"input":"sum(2,2)","expected":"4",' +
    '"actual":"5","freq":"always","harm":"wrong result"}],"checked_invariants":[]}\n```');
  assert.equal(v.status, 'REWORK');
  assert.equal(v.verdict, 'REVIEW_BLOCKED');
  assert.equal(v.findings.length, 1);
  assert.ok(hasValidFinding(v.findings));
  assert.match(v.excerpt, /src\/sum\.js/);
});

test('verdict: ESCALATE маппится в REVIEW_ESCALATE', () => {
  const v = parseReviewVerdict('{"verdict":"ESCALATE","summary":"spec conflict","findings":[]}');
  assert.equal(v.status, 'ESCALATE');
  assert.equal(v.verdict, 'REVIEW_ESCALATE');
});

test('verdict: legacy REVIEW_OK / REVIEW_BLOCKED строки', () => {
  assert.equal(parseReviewVerdict('all good\nREVIEW_OK\n').verdict, 'REVIEW_OK');
  const blocked = parseReviewVerdict('src/a.js: expected 4, actual 5\nREVIEW_BLOCKED\n');
  assert.equal(blocked.status, 'REWORK');
  assert.match(blocked.excerpt, /expected 4/);
});

test('verdict: двусмысленный или отсутствующий вердикт — отказ', () => {
  // Два verdict-объекта или оба legacy-маркера — двусмысленность.
  assert.throws(() => parseReviewVerdict(
    '{"verdict":"PASS"}\n```json\n{"verdict":"PASS"}\n```'),
    (e) => e.reason === 'review_ambiguous_verdict');
  assert.throws(() => parseReviewVerdict('REVIEW_OK\nREVIEW_BLOCKED\n'),
    (e) => e.reason === 'review_ambiguous_verdict');
  assert.throws(() => parseReviewVerdict('{"verdict":"PASS"} text {"verdict":"REWORK","excerpt":"x","findings":[]}'),
    (e) => e.reason === 'review_ambiguous_verdict');
  // JSON-вердикт + противоречащий текстовый маркер — двусмысленность.
  assert.throws(() => parseReviewVerdict('{"verdict":"PASS","summary":"ok"}\nREVIEW_BLOCKED\n'),
    (e) => e.reason === 'review_ambiguous_verdict');
  assert.throws(() => parseReviewVerdict(
    'REVIEW_OK\n{"verdict":"REWORK","excerpt":"bug"}'),
    (e) => e.reason === 'review_ambiguous_verdict');
  assert.throws(() => parseReviewVerdict('{"verdict":"ESCALATE"}\nREVIEW_OK\n'),
    (e) => e.reason === 'review_ambiguous_verdict');
  // Согласованный маркер при JSON-вердикте — не противоречие.
  assert.equal(parseReviewVerdict('{"verdict":"PASS","summary":"ok"}\nREVIEW_OK\n').status, 'PASS');
  // Маркер в середине ответа не засчитывается.
  assert.throws(() => parseReviewVerdict('REVIEW_OK looks fine but actually\nsome more analysis\n'),
    (e) => e.reason === 'review_verdict_missing');
  assert.throws(() => parseReviewVerdict('no verdict here'),
    (e) => e.reason === 'review_verdict_missing');
  assert.throws(() => parseReviewVerdict('{"verdict":"MAYBE"}'),
    (e) => e.reason === 'review_verdict_unknown');
});

test('verdict: REWORK без finding/excerpt — objection missing, summary не подставляется', () => {
  assert.throws(() => parseReviewVerdict(
    '{"verdict":"REWORK","summary":"code is bad","findings":[]}'),
    (e) => e.reason === 'review_objection_missing');
  assert.throws(() => parseReviewVerdict(
    '{"verdict":"REWORK","summary":"code is bad","findings":[{"file":"a.js"}]}'),
    (e) => e.reason === 'review_objection_missing');
  assert.throws(() => parseReviewVerdict('REVIEW_BLOCKED\n'),
    (e) => e.reason === 'review_objection_missing');
  // Явный excerpt — принимается.
  const v = parseReviewVerdict('{"verdict":"REWORK","summary":"s","excerpt":"a.js: expected 4","findings":[]}');
  assert.equal(v.status, 'REWORK');
  assert.equal(v.excerpt, 'a.js: expected 4');
});

test('finding: обязательные поля валидного замечания', () => {
  assert.ok(hasValidFinding([{ file: 'a.js', expected: 'x', actual: 'y' }]));
  assert.ok(!hasValidFinding([{ file: 'a.js', expected: '', actual: 'y' }]));
  assert.ok(!hasValidFinding([{ file: 'a.js' }]));
  assert.ok(!hasValidFinding([]));
  assert.ok(!hasValidFinding(null));
});

test('sandbox: реальный негативный тест системной read-only изоляции', async (t) => {
  let rootless = false;
  try {
    rootless = JSON.parse((await exec('docker', ['info', '--format',
      '{{json .SecurityOptions}}'], { timeout: 12_000 })).stdout).includes('name=rootless');
  } catch { /* docker недоступен */ }
  if (!rootless) return t.skip('rootless Docker unavailable');

  const scratch = await mkdtemp(join(tmpdir(), 'review-sandbox-test-'));
  try {
    const source = join(scratch, 'candidate');
    await mkdir(source, { mode: 0o755 });
    await writeFile(join(source, 'file.txt'), 'pinned\n');
    const before = await snapshotDigest(source);

    // Внутри того же hardened-контура, что и у критика: запись, chmod, удаление,
    // чтение env и host-путей — всё обязано физически отказать.
    const probe = [
      'echo x > /candidate/new.txt 2>/tmp/e1; echo "write:$?"; head -1 /tmp/e1',
      'chmod u+w /candidate/file.txt 2>/tmp/e2; echo "chmod:$?"; head -1 /tmp/e2',
      'rm /candidate/file.txt 2>/tmp/e3; echo "rm:$?"; head -1 /tmp/e3',
      'echo "BOARD_TOKEN=${BOARD_TOKEN:-unset}"; echo "BB=${BB_THREAD_ID:-unset}"',
      'ls /candidate >/dev/null && echo "candidate:present"',
      'ls /state 2>/dev/null || echo "state:absent"',
      'ls /home 2>/dev/null | head -3 || true',
    ].join('; ');
    const run = await runInReadOnlySandbox({
      snapshot: source,
      argv: ['/bin/sh', '-c', probe],
      env: {},
      timeoutMs: 60_000,
    });
    const out = run.stdout;
    assert.match(out, /write:[1-9]/, `запись в /candidate не отклонена:\n${out}${run.stderr}`);
    assert.match(run.stdout + run.stderr, /[Rr]ead.only|EROFS/);
    assert.match(out, /chmod:[1-9]/, `chmod в /candidate не отклонён:\n${out}`);
    assert.match(out, /rm:[1-9]/, `удаление в /candidate не отклонено:\n${out}`);
    assert.match(out, /BOARD_TOKEN=unset/);
    assert.match(out, /BB=unset/);
    assert.match(out, /candidate:present/);
    assert.match(out, /state:absent/);

    // Снимок обязан быть побайтово неизменен после враждебного прогона.
    const after = await snapshotDigest(source);
    assert.equal(after.digest, before.digest);
    assert.equal(after.files, before.files);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('fingerprint: изменение байтов уже модифицированного файла ловится', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'fp-repo-'));
  try {
    const git = async (...args) =>
      (await exec('git', ['-C', repo, ...args], { timeout: 15_000 })).stdout.trim();
    await git('init', '-q', '-b', 'pilot');
    await git('config', 'user.email', 't@l');
    await git('config', 'user.name', 't');
    await writeFile(join(repo, 'a.txt'), 'one\n');
    await git('add', 'a.txt');
    await git('commit', '-qm', 'init');
    // Файл уже модифицирован до снимка fingerprint.
    await writeFile(join(repo, 'a.txt'), 'two\n');
    const before = await worktreeFingerprint(repo);
    // Правка того же уже-modified файла: status не меняется, байты — да.
    await writeFile(join(repo, 'a.txt'), 'three\n');
    const after = await worktreeFingerprint(repo);
    assert.notEqual(after.files, before.files, 'содержимое файла не вошло в fingerprint');
    assert.notEqual(after.diff, before.diff, 'diff не вошёл в fingerprint');
    assert.equal(after.head, before.head);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('fingerprint: битые и меняющие цель симлинки различаются', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'fp-link-'));
  try {
    const git = async (...args) =>
      (await exec('git', ['-C', repo, ...args], { timeout: 15_000 })).stdout.trim();
    await git('init', '-q', '-b', 'pilot');
    await git('config', 'user.email', 't@l');
    await git('config', 'user.name', 't');
    await writeFile(join(repo, 'a.txt'), 'one\n');
    await git('add', 'a.txt');
    await git('commit', '-qm', 'init');
    // Битый симлинк: readFile падал бы, цель ссылки обязана войти в хэш.
    await symlink('/nonexistent/one', join(repo, 'link.txt'));
    const before = await worktreeFingerprint(repo);
    await rm(join(repo, 'link.txt'));
    await symlink('/nonexistent/two', join(repo, 'link.txt'));
    const after = await worktreeFingerprint(repo);
    assert.notEqual(after.files, before.files,
      'смена цели симлинка не изменила fingerprint');
    assert.equal(after.head, before.head);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('runner: verdict без subject_digest при заданном binding — отказ', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'runner-repo-'));
  const journal = await mkdtemp(join(tmpdir(), 'runner-journal-'));
  const piRoot = await mkdtemp(join(tmpdir(), 'runner-pi-'));
  try {
    const git = async (...args) =>
      (await exec('git', ['-C', repo, ...args], { timeout: 15_000 })).stdout.trim();
    await git('init', '-q', '-b', 'pilot');
    await git('config', 'user.email', 't@l');
    await git('config', 'user.name', 't');
    await writeFile(join(repo, 'a.txt'), 'x\n');
    await git('add', 'a.txt');
    await git('commit', '-qm', 'cand');
    const sha = await git('rev-parse', 'HEAD');
    await writeFile(join(piRoot, 'auth.json'), '{"openai":{"k":"v"}}');

    const digest = 'f'.repeat(64);
    const stream = (text) => [
      msg({ content: [{ type: 'text', text }] }), settled,
    ].join('\n');
    const stubSandbox = (ndjson) => async () => ({ code: 0, stdout: ndjson, stderr: '' });
    const binding = {
      task_id: '1', candidate_sha: sha, worktree: repo,
      executor: 'acp-devin/swe-2-high', subject_digest: digest,
    };
    const profile = { review: CRITIC };

    // PASS без subject_digest в JSON при заданном binding.subject_digest.
    const missing = isolatedPiReviewRunner({ journal, piRoot,
      sandbox: stubSandbox(stream('{"verdict":"PASS","summary":"ok"}')) });
    await assert.rejects(missing(binding, profile),
      (e) => e.reason === 'review_verdict_subject_mismatch');
    // Несовпадающий subject_digest — тот же отказ.
    const wrong = isolatedPiReviewRunner({ journal, piRoot,
      sandbox: stubSandbox(stream(`{"verdict":"PASS","subject_digest":"${'9'.repeat(64)}"}`)) });
    await assert.rejects(wrong(binding, profile),
      (e) => e.reason === 'review_verdict_subject_mismatch');
    // Совпадающий — receipt несёт проверенный дайджест.
    const ok = isolatedPiReviewRunner({ journal, piRoot,
      sandbox: stubSandbox(stream(`{"verdict":"PASS","subject_digest":"${digest}"}`)) });
    const receipt = await ok(binding, profile);
    assert.equal(receipt.subject_digest, digest);
    // Без binding.subject_digest поле необязательно и в receipt — null.
    const free = isolatedPiReviewRunner({ journal, piRoot,
      sandbox: stubSandbox(stream('{"verdict":"PASS","summary":"ok"}')) });
    const receipt2 = await free({ ...binding, subject_digest: null }, profile);
    assert.equal(receipt2.subject_digest, null);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(journal, { recursive: true, force: true });
    await rm(piRoot, { recursive: true, force: true });
  }
});

test('guard: auth.json стёрт при загрузке и отдаётся только креденшельному стеку', async () => {
  const dir = join(tmpdir(), '.pi', 'agent');
  await mkdir(dir, { recursive: true });
  const auth = join(dir, 'auth.json');
  await writeFile(auth, '{"openai":{"token":"secret-value"}}');
  await writeFile(join(dir, 'settings.json'), '{"theme":"dark"}');
  const guard = new URL('./pi-guard.cjs', import.meta.url).pathname;
  const script = `
    const fs = require('fs');
    require(${JSON.stringify(guard)});
    // Файла на диске уже нет; не-креденшельное чтение — EACCES.
    try { fs.readFileSync('/tmp/.pi/agent/auth.json', 'utf8'); console.log('read1:allowed'); }
    catch (e) { console.log('read1:' + e.code); }
    // Креденшельный код pi получает байты из памяти: имя функции в стеке.
    class RuntimeCredentials {
      read() { return fs.readFileSync('/tmp/.pi/agent/auth.json', 'utf8'); }
    }
    console.log('cred:' + new RuntimeCredentials().read().includes('secret-value'));
    try { fs.existsSync('/tmp/.pi/agent/auth.json'); console.log('exists:allowed'); }
    catch (e) { console.log('exists:' + e.code); }
    try { fs.readFileSync('/tmp/.pi/agent/settings.json'); console.log('cfg:allowed'); }
    catch (e) { console.log('cfg:' + e.code); }
    try { fs.readdirSync('/tmp/.pi'); console.log('piDir:allowed'); }
    catch (e) { console.log('piDir:' + e.code); }
    try { fs.readFileSync('/etc/passwd'); console.log('etc:allowed'); }
    catch (e) { console.log('etc:' + e.code); }
    // child_process: внешние бинарники закрыты, read-only утилиты — нет.
    const cp = require('child_process');
    // spawnSync не бросает, а возвращает result с error — как реальный сбой.
    let r = cp.spawnSync('sh', ['-c', 'echo hi']);
    console.log('sh:' + (r.error ? r.error.code : 'allowed:' + r.status));
    r = cp.spawnSync('curl', ['-s', 'x'], { timeout: 3000 });
    console.log('curl:' + (r.error ? r.error.code : 'allowed:' + r.status));
    try { cp.execFileSync('sh', ['-c', 'echo hi']); console.log('execSh:allowed'); }
    catch (e) { console.log('execSh:' + e.code); }
    try { cp.spawnSync('ls', ['/tmp'], { timeout: 3000 }); console.log('ls:allowed'); }
    catch (e) { console.log('ls:' + e.code); }
    const net = require('net');
    // Приватный endpoint отклоняется ДО allowlist — даже явно разрешённый.
    const targets = [[44100, '127.0.0.1'], [9, '127.0.0.1'], [443, '10.1.2.3']];
    let i = 0;
    const next = () => {
      if (i >= targets.length) process.exit(0);
      const [port, host] = targets[i++];
      const s = net.connect({ port, host });
      s.on('error', e => { console.log(host + ':' + port + '=' + e.code); next(); });
      s.on('connect', () => { console.log(host + ':' + port + '=ALLOWED'); next(); });
    };
    next();
  `;
  const run = await exec(process.execPath, ['-e', script],
    { timeout: 15_000, env: { ...process.env, PI_ALLOW_CONNECT: '127.0.0.1:9' } });
  const out = run.stdout;
  assert.match(out, /read1:EACCES/, `auth.json доступен обычному чтению:\n${out}`);
  assert.match(out, /cred:true/, `креденшельный стек не получил auth из памяти:\n${out}`);
  assert.match(out, /exists:EACCES/);
  assert.match(out, /cfg:EACCES/);
  assert.match(out, /piDir:EACCES/);
  assert.match(out, /etc:allowed/);
  assert.match(out, /sh:EACCES/, `sh внутри песочницы не заблокирован:\n${out}`);
  assert.match(out, /curl:EACCES/);
  assert.match(out, /execSh:EACCES/);
  assert.match(out, /ls:allowed/, `read-only ls должен работать:\n${out}`);
  assert.match(out, /127\.0\.0\.1:44100=ENETUNREACH/);
  assert.match(out, /127\.0\.0\.1:9=ENETUNREACH/, 'приватный прокси прошёл allowlist');
  assert.match(out, /10\.1\.2\.3:443=ENETUNREACH/);
  assert.ok(!/ALLOWED/.test(out), out);
});

test('sandbox: обращение к 127.0.0.1:44100 изнутри песочницы заблокировано', async (t) => {
  let rootless = false;
  try {
    rootless = JSON.parse((await exec('docker', ['info', '--format',
      '{{json .SecurityOptions}}'], { timeout: 12_000 })).stdout).includes('name=rootless');
  } catch { /* docker недоступен */ }
  if (!rootless) return t.skip('rootless Docker unavailable');

  const scratch = await mkdtemp(join(tmpdir(), 'review-net-test-'));
  try {
    const source = join(scratch, 'candidate');
    await mkdir(source, { mode: 0o755 });
    await writeFile(join(source, 'f.txt'), 'x\n');
    const guard = new URL('./pi-guard.cjs', import.meta.url).pathname;
    const probe = `
      const net = require('net');
      const targets = [[44100,'127.0.0.1'],[80,'localhost'],[443,'10.1.2.3'],[63438,'203.0.113.10']];
      let i = 0;
      const next = () => {
        if (i >= targets.length) return;
        const [port, host] = targets[i++];
        const s = net.connect({ port, host });
        s.setTimeout(3000);
        s.on('connect', () => { console.log(host + ':' + port + '=connected'); s.destroy(); next(); });
        s.on('error', e => { console.log(host + ':' + port + '=' + e.code); next(); });
        s.on('timeout', () => { console.log(host + ':' + port + '=TIMEOUT'); s.destroy(); next(); });
      };
      next();
    `;
    const run = await runInReadOnlySandbox({
      snapshot: source,
      argv: ['node', '--require', '/pi-guard/pi-guard.cjs', '-e', probe],
      mounts: [{ src: guard, dst: '/pi-guard/pi-guard.cjs' }],
      env: { PI_ALLOW_CONNECT: '203.0.113.10:63438' },
      timeoutMs: 60_000,
      // Публичный раннер всегда --network=none: даже allowlist-адрес не
      // отвечает (ENETUNREACH уже на уровне ядра), а приватные цели рубит гард.
    });
    const out = run.stdout + run.stderr;
    assert.match(out, /127\.0\.0\.1:44100=ENETUNREACH/, `Board loopback не заблокирован:\n${out}`);
    assert.match(out, /localhost:80=ENETUNREACH/, `localhost не заблокирован:\n${out}`);
    assert.match(out, /10\.1\.2\.3:443=ENETUNREACH/, `приватный адрес не заблокирован:\n${out}`);
    assert.match(out, /203\.0\.113\.10:63438=(ENETUNREACH|TIMEOUT|ETIMEDOUT|ECONNREFUSED)/,
      `ожидался отказ соединения:\n${out}`);
    assert.ok(!/connected/.test(out), `в network=none соединение установлено:\n${out}`);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('sandbox: симлинк из /candidate наружу и child_process в песочнице', async (t) => {
  let rootless = false;
  try {
    rootless = JSON.parse((await exec('docker', ['info', '--format',
      '{{json .SecurityOptions}}'], { timeout: 12_000 })).stdout).includes('name=rootless');
  } catch { /* docker недоступен */ }
  if (!rootless) return t.skip('rootless Docker unavailable');

  const scratch = await mkdtemp(join(tmpdir(), 'review-link-test-'));
  try {
    const source = join(scratch, 'candidate');
    await mkdir(source, { mode: 0o755 });
    await writeFile(join(source, 'f.txt'), 'safe\n');
    // Ссылка на секрет ревьюера: даже отсутствующий файл-цель обязан быть
    // недоступен — realpath/readlink уводит за пределы /candidate.
    await symlink('/tmp/.pi/agent/auth.json', join(source, 'evil.json'));
    const guard = new URL('./pi-guard.cjs', import.meta.url).pathname;
    const probe = `
      const fs = require('fs');
      try { fs.readFileSync('/candidate/evil.json', 'utf8'); console.log('evil:allowed'); }
      catch (e) { console.log('evil:' + e.code); }
      try { fs.readFileSync('/tmp/.pi/agent/auth.json', 'utf8'); console.log('direct:allowed'); }
      catch (e) { console.log('direct:' + e.code); }
      try { console.log('safe:' + fs.readFileSync('/candidate/f.txt', 'utf8').trim()); }
      catch (e) { console.log('safe:' + e.code); }
      const cp = require('child_process');
      const r = cp.spawnSync('sh', ['-c', 'cat /tmp/.pi/agent/auth.json']);
      console.log('sh:' + (r.error ? r.error.code : 'allowed:' + r.status));
      try { cp.execFileSync('ls', ['/candidate'], { encoding: 'utf8' }); console.log('ls:allowed'); }
      catch (e) { console.log('ls:' + e.code); }
    `;
    const run = await runInReadOnlySandbox({
      snapshot: source,
      argv: ['node', '--require', '/pi-guard/pi-guard.cjs', '-e', probe],
      mounts: [{ src: guard, dst: '/pi-guard/pi-guard.cjs' }],
      timeoutMs: 60_000,
    });
    const out = run.stdout + run.stderr;
    assert.match(out, /evil:EACCES/, `симлинк на auth.json читается:\n${out}`);
    assert.match(out, /direct:EACCES/, `прямое чтение auth.json открыто:\n${out}`);
    assert.match(out, /safe:safe/, `обычный файл не читается:\n${out}`);
    assert.match(out, /sh:EACCES/, `шелл в песочнице не заблокирован:\n${out}`);
    assert.match(out, /ls:allowed/, `read-only ls должен работать:\n${out}`);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

// --- acceptHeld + аттестованный ReviewReceipt (регрессии №1 и №2) ---

const SPEC_D = 'a'.repeat(64);
const POLICY_D = 'b'.repeat(64);
const TREE = 'c'.repeat(40);
const BASE = '0'.repeat(40);
const CAND = 'd'.repeat(40);
const ROUTE = { provider: 'openai', model: 'gpt-6.2-sol', reasoningLevel: 'medium' };

function heldAttempt(taskId, epoch) {
  return {
    attempt_id: 'att-1', task_id: taskId, epoch, bb_thread_id: 'thr_w',
    worktree: '/tmp/wt', base_sha: BASE, check_profile: 'pilot', finish: 'verified',
    repo_id: 'repo-x', spec_digest: SPEC_D, policy_digest: POLICY_D,
    executor: 'acp-devin/swe-2-high',
  };
}

function heldPolicy(taskId) {
  return {
    version: '3', digest: POLICY_D,
    profiles: { pilot: {
      task: taskId, worker: 'thr_w', worktree: '/tmp/wt', base: BASE,
      review: { ...ROUTE, requireAttestation: true },
    } },
  };
}

function manifestDigest() {
  const subject = buildSubject({
    kind: 'git_tree', repoId: 'repo-x', baseSha: BASE, candidateSha: CAND, treeSha: TREE,
    specDigest: SPEC_D, policyDigest: POLICY_D, fixturesDigest: null,
    releaseTarget: { finish: 'verified' },
  });
  return subjectDigest(subject);
}

function heldPorts(journal, review, calls = {}) {
  return {
    board: {
      verifyHeld: async () => ({ epoch: 5, until: '2099-01-01T00:00:00Z' }),
      block: async () => { calls.blocked = (calls.blocked ?? 0) + 1; },
      complete: async () => { calls.completed = (calls.completed ?? 0) + 1; },
      labels: async () => ({
        repo_id: 'repo-x', profile_id: 'pilot', finish: 'verified',
        spec_digest: SPEC_D, policy_digest: POLICY_D,
      }),
      lookup: async () => ({ state: 'claimed' }),
    },
    inspect: async (binding) => ({
      head: binding.candidate_sha, tree: TREE, clean: true, baseAncestor: true,
    }),
    local: async (binding) => ({ sha: binding.candidate_sha, ok: true, evidence: 'checks.json', exit: 0 }),
    tamper: async (binding) => ({
      ok: true, sha: binding.candidate_sha, base_sha: binding.base_sha,
      violations: [], digest: 't'.repeat(64),
    }),
    review: async (binding) => { calls.binding = binding; return review; },
  };
}

async function writeTranscript(journal, body) {
  const name = `review-test-${Math.random().toString(36).slice(2)}.ndjson`;
  await writeFile(join(journal, name), body, { mode: 0o600 });
  return { name, sha256: createHash('sha256').update(body).digest('hex') };
}

test('acceptHeld: манифест + полная аттестация PASS → completed', async () => {
  const journal = await mkdtemp(join(tmpdir(), 'ah-journal-'));
  try {
    const digest = manifestDigest();
    const tr = await writeTranscript(journal, '{"type":"message_end"}\n');
    const review = {
      task: '42', sha: CAND, actual: { ...ROUTE }, verdict: 'REVIEW_OK',
      checkpoint: 'feed80ab', isolation: 'docker-ro-v1',
      transcript_sha256: tr.sha256, transcript_file: tr.name,
      subject_digest: digest, status: 'PASS', findings: [], checked_invariants: [],
    };
    const calls = {};
    const result = await acceptHeld({
      attempt: heldAttempt('42', 5),
      submission: { task_id: '42', epoch: 5, attempt_id: 'att-1',
        worker_thread_id: 'thr_w', candidate_sha: CAND },
      policy: heldPolicy('42'),
      journal,
      ports: heldPorts(journal, review, calls),
    });
    assert.equal(result.outcome, 'verified', JSON.stringify(result));
    assert.equal(calls.completed, 1);
    // Рецензент получил subject_digest манифеста в запросе (№1).
    assert.equal(calls.binding.subject_digest, digest);
  } finally {
    await rm(journal, { recursive: true, force: true });
  }
});

test('acceptHeld: несовпадающий subject_digest в квитанции → hold', async () => {
  const journal = await mkdtemp(join(tmpdir(), 'ah-journal-'));
  try {
    const tr = await writeTranscript(journal, '{}\n');
    const review = {
      task: '43', sha: CAND, actual: { ...ROUTE }, verdict: 'REVIEW_OK',
      checkpoint: 'feed80ab', isolation: 'docker-ro-v1',
      transcript_sha256: tr.sha256, transcript_file: tr.name,
      subject_digest: 'f'.repeat(64), status: 'PASS',
    };
    const calls = {};
    const result = await acceptHeld({
      attempt: heldAttempt('43', 5),
      submission: { task_id: '43', epoch: 5, attempt_id: 'att-1',
        worker_thread_id: 'thr_w', candidate_sha: CAND },
      policy: heldPolicy('43'),
      journal,
      ports: heldPorts(journal, review, calls),
    });
    assert.equal(result.outcome, 'hold');
    assert.equal(result.reason, 'review_subject_mismatch');
    assert.equal(calls.completed ?? 0, 0);
  } finally {
    await rm(journal, { recursive: true, force: true });
  }
});

test('acceptHeld: отсутствующий или подменённый файл транскрипта → hold', async () => {
  const journal = await mkdtemp(join(tmpdir(), 'ah-journal-'));
  try {
    const digest = manifestDigest();
    const base = {
      task: '44', sha: CAND, actual: { ...ROUTE }, verdict: 'REVIEW_OK',
      checkpoint: 'feed80ab', isolation: 'docker-ro-v1',
      subject_digest: digest, status: 'PASS',
    };
    // Файла нет вовсе.
    let calls = {};
    let result = await acceptHeld({
      attempt: heldAttempt('44', 5),
      submission: { task_id: '44', epoch: 5, attempt_id: 'att-1',
        worker_thread_id: 'thr_w', candidate_sha: CAND },
      policy: heldPolicy('44'),
      journal,
      ports: heldPorts(journal, { ...base, transcript_sha256: 'e'.repeat(64),
        transcript_file: 'missing.ndjson' }, calls),
    });
    assert.equal(result.outcome, 'hold');
    assert.equal(result.reason, 'review_transcript_mismatch');
    // Файл есть, но его байтовый хэш не совпадает с заявленным.
    const tr = await writeTranscript(journal, '{"type":"x"}\n');
    calls = {};
    result = await acceptHeld({
      attempt: heldAttempt('44', 6),
      submission: { task_id: '44', epoch: 6, attempt_id: 'att-1',
        worker_thread_id: 'thr_w', candidate_sha: CAND },
      policy: heldPolicy('44'),
      journal,
      ports: heldPorts(journal, { ...base, transcript_sha256: 'e'.repeat(64),
        transcript_file: tr.name }, calls),
    });
    assert.equal(result.outcome, 'hold');
    assert.equal(result.reason, 'review_transcript_mismatch');
    // Квитанция без полей аттестации при requireAttestation — тот же стоп.
    calls = {};
    result = await acceptHeld({
      attempt: heldAttempt('44', 7),
      submission: { task_id: '44', epoch: 7, attempt_id: 'att-1',
        worker_thread_id: 'thr_w', candidate_sha: CAND },
      policy: heldPolicy('44'),
      journal,
      ports: heldPorts(journal, { task: '44', sha: CAND, actual: { ...ROUTE },
        verdict: 'REVIEW_OK', checkpoint: 'feed80ab', subject_digest: digest }, calls),
    });
    assert.equal(result.outcome, 'hold');
    assert.equal(result.reason, 'review_isolation_missing');
    assert.equal(calls.completed ?? 0, 0);
    // Симлинк transcript_file, уводящий за пределы журнала, — подмена.
    const outside = join(tmpdir(), `leak-${Math.random().toString(36).slice(2)}.ndjson`);
    await writeFile(outside, 'x\n');
    const link = join(journal, 'linked.ndjson');
    await symlink(outside, link);
    calls = {};
    result = await acceptHeld({
      attempt: heldAttempt('44', 8),
      submission: { task_id: '44', epoch: 8, attempt_id: 'att-1',
        worker_thread_id: 'thr_w', candidate_sha: CAND },
      policy: heldPolicy('44'),
      journal,
      ports: heldPorts(journal, { ...base,
        transcript_sha256: createHash('sha256').update('x\n').digest('hex'),
        transcript_file: 'linked.ndjson' }, calls),
    });
    assert.equal(result.outcome, 'hold');
    assert.equal(result.reason, 'review_transcript_mismatch');
    assert.equal(calls.completed ?? 0, 0);
    await rm(outside, { force: true });
  } finally {
    await rm(journal, { recursive: true, force: true });
  }
});
