import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import {
  executorFamily, assertCrossFamily, parseReviewTranscript, parseReviewVerdict,
  hasValidFinding, isolatedArbiterRunner, isolatedPiReviewRunner, runInReadOnlySandbox, snapshotDigest,
  worktreeFingerprint, assertToolsAllowed, ReviewDenied, REVIEW_IMAGE, l2CriticSpec,
} from './review-runner.mjs';
import { isNeonReview } from './review-policy.mjs';
import { buildSubject, subjectDigest } from './subject.mjs';
import { acceptHeld } from './acceptance.mjs';

const exec = promisify(execFile);

const CRITIC = { provider: 'openai', model: 'gpt-6.2-sol', reasoningLevel: 'medium' };
const inputJson = input => JSON.parse(Buffer.isBuffer(input) ? input.toString('utf8') : String(input));

async function nodePreloadHarness(dir, name, source) {
  const binary = join(dir, name);
  const hook = join(dir, `${name}-hook.cjs`);
  await symlink(process.execPath, binary);
  await writeFile(hook, source, { mode: 0o600 });
  const prefix = process.env.NODE_OPTIONS ? `${process.env.NODE_OPTIONS} ` : '';
  return { binary, nodeOptions: `${prefix}--require ${hook}` };
}

test('family: строгая таблица provider/model без подстрок', () => {
  // Голый провайдер без модели не аттестуется: обязательны оба поля.
  assert.equal(executorFamily('acp-devin'), null);
  assert.equal(executorFamily('acp-zcode-start'), null);
  assert.equal(executorFamily('acp-antigravity-acp'), null);
  assert.equal(executorFamily({ provider: 'acp-devin', model: 'swe-2-high' }), 'cognition');
  for (const model of ['swe-2-1', 'swe-2-1-low', 'swe-2-1-medium',
    'swe-2-1-high', 'swe-2-1-xhigh', 'swe-2-1-max']) {
    assert.equal(executorFamily({ provider: 'acp-devin', model }), 'cognition');
  }
  assert.equal(executorFamily({ provider: 'acp-zcode-start',
    model: 'builtin:zai-start-plan\\GLM-5.3-Flash' }), 'glm');
  assert.equal(executorFamily('opencode-go/deepseek-v4'), 'deepseek');
  assert.equal(executorFamily('openai/gpt-6.2-sol'), 'openai');
  assert.equal(executorFamily({ provider: 'openai', model: 'gpt-6.2-astra' }), 'openai');
  assert.equal(executorFamily({ provider: 'acp-antigravity-acp', model: 'gemini-4-neon' }), 'google');
  // Routing Policy v2: escalation-слот Opus 5.5 — семейство anthropic.
  assert.equal(executorFamily({ provider: 'agy', model: 'claude-opus-5.5' }), 'anthropic');
  // Провайдер без модели и модель без провайдера — отказ.
  assert.equal(executorFamily({ provider: 'openai' }), null);
  assert.equal(executorFamily({ model: 'gpt-6.2-sol' }), null);
  // Голый id модели без провайдера не аттестуется: подстроки недостаточно.
  assert.equal(executorFamily('swe-2-medium'), null);
  assert.equal(executorFamily('builtin:zai-start-plan\\GLM-5.3-Flash'), null);
  assert.equal(executorFamily('deepseek-reasoner'), null);
  assert.equal(executorFamily('gemini-4-neon'), null);
  assert.equal(executorFamily('codex-exec'), null);
  assert.equal(executorFamily({ provider: 'acp-devin', model: 'swe-2-1-fake' }), null);
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
  const neon = { provider: 'google', model: 'gemini-4-neon' };
  for (const model of ['swe-2-1-medium', 'swe-2-1-high', 'swe-2-1-max']) {
    assert.deepEqual(assertCrossFamily({ provider: 'acp-devin', model }, neon),
      { executor: 'cognition', critic: 'google' });
  }
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

test('transcript: нормальные rawStopReason провайдеров — завершённый ход', () => {
  for (const rawStopReason of ['completed', 'stop', 'STOP', 'end_turn']) {
    const parsed = parseReviewTranscript([msg({ rawStopReason }), settled].join('\n'));
    assert.match(parsed.finalText, /REVIEW_OK/);
  }
});

test('transcript: аномальные rawStopReason — отказ', () => {
  for (const rawStopReason of ['cancelled', 'length', 'max_tokens', 'error', 'tool_calls', '', null]) {
    assert.throws(() => parseReviewTranscript([
      msg({ rawStopReason }), settled,
    ].join('\n')), (e) => e.reason === 'review_incomplete_turn');
  }
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
  // agent_settled без поля aborted или с null — не валидное завершение.
  assert.throws(() => parseReviewTranscript([
    msg(), JSON.stringify({ type: 'agent_settled' }),
  ].join('\n')), (e) => e.reason === 'review_incomplete_turn');
  assert.throws(() => parseReviewTranscript([
    msg(), JSON.stringify({ type: 'agent_settled', aborted: null }),
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

test('sandbox: docker run receives resource limits, -i and exact staged stdin', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'review-docker-args-'));
  const oldPath = process.env.PATH;
  const oldLog = process.env.FAKE_DOCKER_LOG;
  const oldNodeOptions = process.env.NODE_OPTIONS;
  try {
    const bin = join(scratch, 'bin');
    const source = join(scratch, 'candidate');
    const log = join(scratch, 'docker-log.jsonl');
    await mkdir(bin);
    await mkdir(source, { mode: 0o755 });
    const harness = await nodePreloadHarness(bin, 'docker', `
const fs = require('fs');
const path = require('path');
const args = [path.basename(process.argv[1] ?? ''), ...process.argv.slice(2)];
if (args[0] === 'info') {
  process.stdout.write('["name=rootless"]\\n');
  process.exit(0);
}
if (args[0] === 'rm') process.exit(0);
if (args[0] !== 'run') process.exit(2);
const input = fs.readFileSync(0, 'utf8');
fs.appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify({ args, input }) + '\\n');
process.exit(0);
`);
    process.env.PATH = `${bin}:${oldPath}`;
    process.env.FAKE_DOCKER_LOG = log;
    process.env.NODE_OPTIONS = harness.nodeOptions;
    const input = JSON.stringify({ openai: { type: 'oauth', access: 'stdin-only' } });
    const run = await runInReadOnlySandbox({ snapshot: source,
      argv: ['/bin/sh', '-c', 'cat >/tmp/.pi/agent/auth.json'], input, timeoutMs: 10_000 });
    assert.equal(run.code, 0);
    const entries = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(entries.length, 1);
    for (const flag of ['--pids-limit=256', '--memory=2g', '--memory-swap=2g', '--cpus=2', '-i']) {
      assert.ok(entries[0].args.includes(flag), `missing ${flag}`);
    }
    assert.equal(entries[0].input, input);
    await assert.rejects(runInReadOnlySandbox({ snapshot: source,
      argv: ['/bin/sh'], input: 42 }), (e) => e.reason === 'sandbox_request_invalid');
  } finally {
    process.env.PATH = oldPath;
    if (oldLog === undefined) delete process.env.FAKE_DOCKER_LOG;
    else process.env.FAKE_DOCKER_LOG = oldLog;
    if (oldNodeOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = oldNodeOptions;
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
    // Непрошенный subject_digest в вердикте при пустом binding — отказ,
    // непроверенный дайджест не должен доходить до квитанции.
    const rogue = isolatedPiReviewRunner({ journal, piRoot,
      sandbox: stubSandbox(stream(`{"verdict":"PASS","subject_digest":"${digest}"}`)) });
    await assert.rejects(rogue({ ...binding, subject_digest: null }, profile),
      (e) => e.reason === 'review_verdict_subject_mismatch');
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(journal, { recursive: true, force: true });
    await rm(piRoot, { recursive: true, force: true });
  }
});

test('runner: Round 2+ diff failure throws ReviewDenied, not ReferenceError', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'runner-round-repo-'));
  const journal = await mkdtemp(join(tmpdir(), 'runner-round-journal-'));
  const piRoot = await mkdtemp(join(tmpdir(), 'runner-round-pi-'));
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
    let sandboxCalls = 0;
    const runner = isolatedPiReviewRunner({ journal, piRoot,
      sandbox: async () => {
        sandboxCalls++;
        return { code: 0, stdout: '', stderr: '' };
      } });
    await assert.rejects(
      runner({ task_id: '1', candidate_sha: sha, worktree: repo,
        executor: 'acp-devin/swe-2-high', review_round: 2,
        prior_sha: 'e'.repeat(40) }, { review: CRITIC }),
      (e) => e instanceof ReviewDenied && !(e instanceof ReferenceError) &&
        typeof e.reason === 'string' && e.reason.startsWith('review_round_diff_failed:'));
    assert.equal(sandboxCalls, 0);
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
  const candidateExists = await lstat('/candidate').then(() => true, () => false);
  const guard = new URL('./pi-guard.cjs', import.meta.url).pathname;
  const script = `
    const fs = require('fs');
    require(${JSON.stringify(guard)});
    // Файла на диске уже нет; не-креденшельное чтение — EACCES.
    try { fs.readFileSync('/tmp/.pi/agent/auth.json', 'utf8'); console.log('read1:allowed'); }
    catch (e) { console.log('read1:' + e.code); }
    // Даже имя RuntimeCredentials без /pi-ro в стеке — не креденшельный код.
    class RuntimeCredentials {
      read() { return fs.readFileSync('/tmp/.pi/agent/auth.json', 'utf8'); }
    }
    try { new RuntimeCredentials().read(); console.log('cred:allowed'); }
    catch (e) { console.log('cred:' + e.code); }
    try { fs.existsSync('/tmp/.pi/agent/auth.json'); console.log('exists:allowed'); }
    catch (e) { console.log('exists:' + e.code); }
    try { fs.readFileSync('/tmp/.pi/agent/settings.json'); console.log('cfg:allowed'); }
    catch (e) { console.log('cfg:' + e.code); }
    try { fs.readdirSync('/tmp/.pi'); console.log('piDir:allowed'); }
    catch (e) { console.log('piDir:' + e.code); }
    try { fs.readFileSync('/etc/passwd'); console.log('etc:allowed'); }
    catch (e) { console.log('etc:' + e.code); }
    try { fs.readFileSync(new URL('file:///tmp/.%70i/agent/settings.json')); console.log('encodedUrl:allowed'); }
    catch (e) { console.log('encodedUrl:' + e.code); }
    try { fs.readFileSync(new URL('https://example.invalid/tmp/.pi/agent/settings.json')); console.log('nonFileUrl:allowed'); }
    catch (e) { console.log('nonFileUrl:' + e.code); }
    try { fs.copyFileSync('/etc/passwd', '/tmp/.pi/agent/settings.json'); console.log('copySync:allowed'); }
    catch (e) { console.log('copySync:' + e.code); }
    const copyProbe = fs.promises.copyFile('/etc/passwd', '/pi-cfg/copied-auth')
      .then(() => console.log('copyAsync:allowed'))
      .catch(e => console.log('copyAsync:' + e.code));
    // child_process: внешние бинарники закрыты, read-only утилиты — нет.
    const cp = require('child_process');
    // spawnSync не бросает, а возвращает result с error — как реальный сбой.
    const probe = (label, r) =>
      console.log(label + ':' + (r.error ? r.error.code : 'allowed:' + r.status));
    probe('sh', cp.spawnSync('sh', ['-c', 'echo hi']));
    probe('curl', cp.spawnSync('curl', ['-s', 'x'], { timeout: 3000 }));
    probe('findExec', cp.spawnSync('find', ['/tmp', '-exec', 'ls', ';']));
    probe('findOk', cp.spawnSync('find', [], { timeout: 3000 }));
    probe('rgPiCfg', cp.spawnSync('rg', ['.', '/pi-cfg/auth.json']));
    probe('rgPre', cp.spawnSync('rg', ['--pre=sh', 'foo', '/candidate']));
    probe('findFollow', cp.spawnSync('find', ['-L', '/candidate']));
    probe('lsPiCfg', cp.spawnSync('ls', ['/pi-cfg']));
    probe('lsTmp', cp.spawnSync('ls', ['/tmp']));
    probe('shellOpt', cp.spawnSync('ls', ['/tmp'], { shell: true }));
    probe('cwdOut', cp.spawnSync('ls', { cwd: '/etc' }));
    probe('cwdNoReal', cp.spawnSync('ls', { cwd: '/candidate/df-guard-no-such-cwd' }));
    probe('cwdCand', cp.spawnSync('ls', { cwd: '/candidate' }));
    // PATH не участвует: пустой PATH не должен помешать системному ls.
    probe('pinPath', cp.spawnSync('ls', [], { env: { PATH: '/nonexistent' }, timeout: 3000 }));
    try { cp.execSync('ls /tmp'); console.log('execSync:allowed'); }
    catch (e) { console.log('execSync:' + e.code); }
    try { const f = cp.fork('/tmp/evil.js'); f.on('error', e => console.log('fork:' + e.code)); }
    catch (e) { console.log('fork:' + e.code); }
    probe('candPath', cp.spawnSync('/candidate/evil.sh'));
    probe('sysPath', cp.spawnSync('/usr/bin/ls', [], { timeout: 3000 }));
    probe('tmpPath', cp.spawnSync('/tmp/ls'));
    try { cp.execFileSync('sh', ['-c', 'echo hi']); console.log('execSh:allowed'); }
    catch (e) { console.log('execSh:' + e.code); }
    probe('ls', cp.spawnSync('ls', [], { timeout: 3000 }));
    cp.exec('ls /tmp', (e) => console.log('exec:' + (e ? e.code : 'allowed')));
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
    copyProbe.then(next);
  `;
  const run = await exec(process.execPath, ['-e', script],
    { timeout: 15_000, env: { ...process.env, PI_ALLOW_CONNECT: '127.0.0.1:9' } });
  const out = run.stdout;
  assert.match(out, /read1:EACCES/, `auth.json доступен обычному чтению:\n${out}`);
  assert.match(out, /cred:EACCES/, `имя без /pi-ro в стеке прошло:\n${out}`);
  assert.match(out, /exists:EACCES/);
  assert.match(out, /cfg:EACCES/);
  assert.match(out, /piDir:EACCES/);
  assert.match(out, /etc:allowed/);
  assert.match(out, /encodedUrl:EACCES/, `percent-encoded URL обошёл guard:\n${out}`);
  assert.match(out, /nonFileUrl:EACCES/, `non-file URL обошёл guard:\n${out}`);
  assert.match(out, /copySync:EACCES/, `copyFileSync в /tmp/.pi не заблокирован:\n${out}`);
  assert.match(out, /copyAsync:EACCES/, `promises.copyFile в /pi-cfg не заблокирован:\n${out}`);
  assert.match(out, /sh:EACCES/, `sh внутри песочницы не заблокирован:\n${out}`);
  assert.match(out, /curl:EACCES/);
  assert.match(out, /findExec:EACCES/, `find -exec не заблокирован:\n${out}`);
  assert.match(out, /findOk:allowed:0/, `чистый find должен работать:\n${out}`);
  assert.match(out, /rgPiCfg:EACCES/, `rg смог прочитать /pi-cfg/auth.json:\n${out}`);
  assert.match(out, /rgPre:EACCES/, `rg --pre не заблокирован:\n${out}`);
  assert.match(out, /findFollow:EACCES/, `find -L не заблокирован:\n${out}`);
  assert.match(out, /lsPiCfg:EACCES/, `ls /pi-cfg не заблокирован:\n${out}`);
  assert.match(out, /lsTmp:EACCES/, `явный путь /tmp для ls не заблокирован:\n${out}`);
  assert.match(out, /shellOpt:EACCES/, `shell:true не заблокирован:\n${out}`);
  assert.match(out, /cwdOut:EACCES/, `cwd вне /candidate не заблокирован:\n${out}`);
  assert.match(out, /cwdNoReal:EACCES/, `cwd без realpath в /candidate не заблокирован:\n${out}`);
  assert.match(out, candidateExists ? /cwdCand:allowed:0/ : /cwdCand:EACCES/,
    `реальный cwd /candidate обработан неправильно:\n${out}`);
  assert.match(out, /pinPath:allowed:0/, `PATH-подмена сломала системный бинарник:\n${out}`);
  assert.match(out, /execSync:EACCES/, `execSync (шелл) не заблокирован:\n${out}`);
  assert.match(out, /fork:EACCES/, `fork не заблокирован:\n${out}`);
  assert.match(out, /candPath:EACCES/, `бинарник из /candidate запущен:\n${out}`);
  assert.match(out, /sysPath:allowed:0/, `системный /usr/bin/ls должен работать:\n${out}`);
  assert.match(out, /tmpPath:EACCES/, `бинарник из /tmp запущен:\n${out}`);
  assert.match(out, /execSh:EACCES/);
  assert.match(out, /exec:EACCES/, `exec (шелл) не заблокирован:\n${out}`);
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
    // Симлинк наружу для проверки cwd-эскейпа через '..' и напрямую.
    await symlink('/tmp', join(source, 'out'));
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
      // cwd через симлинк наружу и через '..' — ядро резолвит симлинк до '..',
      // поэтому проверка обязана идти по native realpath, а не лексически.
      const cwdP = (c) => { const r = cp.spawnSync('ls', ['.'], { cwd: c });
        return r.error ? r.error.code : 'allowed:' + r.status; };
      console.log('cwdSym:' + cwdP('/candidate/out'));
      console.log('cwdEsc:' + cwdP('/candidate/out/..'));
      console.log('cwdOk:' + cwdP('/candidate'));
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
    assert.match(out, /cwdSym:EACCES/, `cwd через симлинк наружу разрешён:\n${out}`);
    assert.match(out, /cwdEsc:EACCES/, `cwd '/candidate/out/..' ушёл наружу:\n${out}`);
    assert.match(out, /cwdOk:allowed:0/, `cwd=/candidate не работает:\n${out}`);
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

test('guard: /review читается критиком, запись запрещена', async () => {
  const dir = join(tmpdir(), '.pi', 'agent');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'auth.json'), '{"openai":{"token":"s"}}');
  const guard = new URL('./pi-guard.cjs', import.meta.url).pathname;
  const script = `
    const fs = require('fs');
    require(${JSON.stringify(guard)});
    // Чтение /review разрешено гардом: несуществующий файл — ENOENT, не EACCES.
    try { fs.readFileSync('/review/diff.patch'); console.log('read:allowed'); }
    catch (e) { console.log('read:' + e.code); }
    // Запись в /review запрещена (гардом или :ro-монтом) — никогда не «allowed».
    try { fs.writeFileSync('/review/diff.patch', 'x'); console.log('write:allowed'); }
    catch (e) { console.log('write:' + e.code); }
    // Контроль: путь вне ALLOW_DIRS отклоняется самим гардом.
    try { fs.readFileSync('/notallowed/x'); console.log('ctl:allowed'); }
    catch (e) { console.log('ctl:' + e.code); }
  `;
  const { stdout } = await exec(process.execPath, ['-e', script],
    { timeout: 15_000 });
  const out = Object.fromEntries(stdout.trim().split('\n')
    .map((l) => l.split(':')));
  assert.equal(out.read, 'ENOENT', `гард запретил чтение /review: ${stdout}`);
  assert.notEqual(out.write, 'allowed', `запись в /review не отклонена: ${stdout}`);
  assert.equal(out.ctl, 'EACCES', `контрольный путь не отклонён: ${stdout}`);
});

test('runner: в контейнер уходит кред без refresh и без auth.openai.com', async () => {
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
    // OAuth-кред с длинным сроком: хостовый refresh не понадобится.
    const oauth = { type: 'oauth', access: 'acc-token', refresh: 'rt-real',
      expires: Date.now() + 3600_000, clientId: 'cid' };
    await writeFile(join(piRoot, 'auth.json'), JSON.stringify({ openai: oauth }));

    let seen = null;
    let cred = null;
    const stream = [
      msg({ content: [{ type: 'text', text: '{"verdict":"PASS","summary":"ok"}' }] }),
      settled,
    ].join('\n');
    const runner = isolatedPiReviewRunner({ journal, piRoot,
      sandbox: async (opts) => {
        seen = opts;
        // scratch живёт только внутри вызова — /pi-cfg не должен нести auth.json.
        const cfg = opts.mounts.find((m) => m.dst === '/pi-cfg');
        await assert.rejects(readFile(join(cfg.src, 'auth.json'), 'utf8'), { code: 'ENOENT' });
        const payload = inputJson(opts.input);
        assert.deepEqual(Object.keys(payload), ['openai']);
        cred = payload.openai;
        return { code: 0, stdout: stream, stderr: '' };
      } });
    await runner({ task_id: '1', candidate_sha: sha, worktree: repo,
      executor: 'acp-devin/swe-2-high' }, { review: CRITIC });

    assert.equal(cred.refresh, 'sandbox-redacted');
    assert.equal(cred.access, 'acc-token');
    assert.deepEqual(cred, { type: 'oauth', access: 'acc-token', expires: oauth.expires,
      refresh: 'sandbox-redacted' });
    const preamble = seen.argv[2];
    assert.match(preamble, /cat > \/tmp\/\.pi\/agent\/auth\.json/);
    assert.match(preamble, /chmod 600 \/tmp\/\.pi\/agent\/auth\.json/);
    assert.match(preamble, /exec \/pi-ro\/bin\/pi "\$@" <\/dev\/null/);
    assert.match(preamble, /exec node \/model-proxy\/client\.cjs \/bin\/sh -c/);
    assert.ok(!String(seen.env.PI_ALLOW_CONNECT).includes('auth.openai.com'),
      `в allow попал auth.openai.com: ${seen.env.PI_ALLOW_CONNECT}`);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(journal, { recursive: true, force: true });
    await rm(piRoot, { recursive: true, force: true });
  }
});

test('runner: истекающий OAuth (<10m) обновляется на хосте до sandbox и перечитывается', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'runner-repo-'));
  const journal = await mkdtemp(join(tmpdir(), 'runner-journal-'));
  const piRoot = await mkdtemp(join(tmpdir(), 'runner-pi-'));
  const oldNodeOptions = process.env.NODE_OPTIONS;
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

    const expiring = { type: 'oauth', access: 'acc-old', refresh: 'rt-old',
      expires: Date.now() + 60_000, clientId: 'cid' };
    const authPath = join(piRoot, 'auth.json');
    const argvLog = join(piRoot, 'pi-argv.json');
    await writeFile(authPath, JSON.stringify({ openai: expiring }));
    await mkdir(join(piRoot, 'bin'), { recursive: true });
    const harness = await nodePreloadHarness(join(piRoot, 'bin'), 'pi', `
const fs = require('node:fs');
const path = require('node:path');
const argv = [path.basename(process.argv[1] ?? ''), ...process.argv.slice(2)];
fs.writeFileSync(${JSON.stringify(argvLog)}, JSON.stringify(argv));
fs.writeFileSync(${JSON.stringify(authPath)}, JSON.stringify({
  openai: { type: 'oauth', access: 'acc-refreshed', refresh: 'rt-rotated',
    expires: Date.now() + 7200_000, clientId: 'cid' },
}));
fs.writeSync(1, 'acc-refreshed\\n');
process.exit(0);
`);
    process.env.NODE_OPTIONS = harness.nodeOptions;

    let cred = null;
    const stream = [
      msg({ content: [{ type: 'text', text: '{"verdict":"PASS","summary":"ok"}' }] }),
      settled,
    ].join('\n');
    const runner = isolatedPiReviewRunner({ journal, piRoot,
      sandbox: async (opts) => {
        const cfg = opts.mounts.find((m) => m.dst === '/pi-cfg');
        await assert.rejects(readFile(join(cfg.src, 'auth.json'), 'utf8'), { code: 'ENOENT' });
        const payload = inputJson(opts.input);
        assert.deepEqual(Object.keys(payload), ['openai']);
        cred = payload.openai;
        return { code: 0, stdout: stream, stderr: '' };
      } });
    await runner({ task_id: '1', candidate_sha: sha, worktree: repo,
      executor: 'acp-devin/swe-2-high' }, { review: CRITIC });

    const seenArgv = JSON.parse(await readFile(argvLog, 'utf8'));
    assert.deepEqual(seenArgv, ['auth', 'print-bearer-token', '--provider', 'openai', '--min-expiry', '10m']);
    assert.equal(cred.access, 'acc-refreshed');
    assert.equal(cred.refresh, 'sandbox-redacted');
    assert.deepEqual(Object.keys(cred).sort(), ['access', 'expires', 'refresh', 'type']);
  } finally {
    if (oldNodeOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = oldNodeOptions;
    await rm(repo, { recursive: true, force: true });
    await rm(journal, { recursive: true, force: true });
    await rm(piRoot, { recursive: true, force: true });
  }
});

test('Sol arbiter authenticates model effort and subject without mounting the OAuth refresh token', async t => {
  const piRoot = await mkdtemp(join(tmpdir(), 'arbiter-pi-'));
  t.after(() => rm(piRoot, { recursive: true, force: true }));
  const hostAuth = { type: 'oauth', access: 'short-lived',
    refresh: 'host-only-refresh', expires: Date.now() + 3_600_000 };
  await writeFile(join(piRoot, 'auth.json'), JSON.stringify({ openai: hostAuth }));
  const subject_digest = 'a'.repeat(64);
  const decision = { subject_digest, decision: 'directed_rework', directive: 'Correct sum.' };
  const req = { task_id: '9', epoch: 1, attempt_id: 'abc', subject_digest, arbiter: CRITIC };
  for (const [body, effort, reason] of [[decision, 'medium'], [decision, 'high', 'arbiter_effort_mismatch'],
      [{ ...decision, subject_digest: 'b'.repeat(64) }, 'medium', 'arbiter_subject_mismatch']]) {
    const runner = isolatedArbiterRunner({ piRoot, sandbox: async opts => {
      const source = opts.mounts.find(m => m.dst === '/pi-cfg').src;
      await assert.rejects(readFile(join(source, 'auth.json'), 'utf8'), { code: 'ENOENT' });
      const payload = inputJson(opts.input);
      assert.deepEqual(Object.keys(payload), ['openai']);
      assert.deepEqual(payload.openai, { type: 'oauth', access: 'short-lived',
        expires: hostAuth.expires, refresh: 'sandbox-redacted' });
      assert.equal(opts.argv[opts.argv.indexOf('--thinking') + 1], 'medium');
      assert.ok(opts.argv.includes('--no-mcp'));
      const reply = msg({ thinkingLevel: effort, content: [{ type: 'text', text: JSON.stringify(body) }] });
      return { code: 0, stdout: `${reply}\n${settled}` };
    } });
    if (reason) await assert.rejects(runner(req), { reason });
    // Решение арбитра несёт usage ходов pi (здесь транскрипт без usage — null).
    else assert.deepEqual(await runner(req), { ...decision, usage: null });
  }
});

test('runner: ошибка host OAuth refresh отклоняет ревью до запуска sandbox', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'runner-repo-'));
  const journal = await mkdtemp(join(tmpdir(), 'runner-journal-'));
  const piRoot = await mkdtemp(join(tmpdir(), 'runner-pi-'));
  const oldNodeOptions = process.env.NODE_OPTIONS;
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

    const expiring = { type: 'oauth', access: 'acc-old', refresh: 'rt-old',
      expires: Date.now() + 60_000, clientId: 'cid' };
    await writeFile(join(piRoot, 'auth.json'), JSON.stringify({ openai: expiring }));
    await mkdir(join(piRoot, 'bin'), { recursive: true });
    const harness = await nodePreloadHarness(join(piRoot, 'bin'), 'pi',
      'require(\'node:fs\').writeSync(2, \'invalid_grant\\n\'); process.exit(1);\n');
    process.env.NODE_OPTIONS = harness.nodeOptions;

    let sandboxCalls = 0;
    const runner = isolatedPiReviewRunner({ journal, piRoot,
      sandbox: async () => {
        sandboxCalls++;
        return { code: 0, stdout: '', stderr: '' };
      } });
    await assert.rejects(
      () => runner({ task_id: '1', candidate_sha: sha, worktree: repo,
        executor: 'acp-devin/swe-2-high' }, { review: CRITIC }),
      (e) => e instanceof ReviewDenied && e.reason === 'review_auth_refresh_failed',
    );
    assert.equal(sandboxCalls, 0);
  } finally {
    if (oldNodeOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = oldNodeOptions;
    await rm(repo, { recursive: true, force: true });
    await rm(journal, { recursive: true, force: true });
    await rm(piRoot, { recursive: true, force: true });
  }
});

test('runner: routed-критик с egress исполняется, acp-devin — отказ до sandbox (#1263 r3)', async () => {
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
    const digest = 'f'.repeat(64);
    // Закреплённый критик в worker-форме pi-харнесса — нормализуется к
    // реальному pi-провайдеру 'opencode-go' (штатный egress opencode.ai,
    // провайдер НЕ переименовывается) и доходит до контейнера.
    await writeFile(join(piRoot, 'auth.json'), '{"opencode-go":{"k":"v"}}');
    const routed = { provider: 'pi', model: 'opencode-go/deepseek-v4.1-flash',
      reasoningLevel: 'medium' };
    const stream = [
      msg({ provider: 'opencode-go', model: 'deepseek-v4.1-flash',
        content: [{ type: 'text',
          text: `{"verdict":"PASS","subject_digest":"${digest}"}` }] }), settled,
    ].join('\n');
    let allow = null;
    const runner = isolatedPiReviewRunner({ journal, piRoot,
      sandbox: async (opts) => {
        allow = opts.allow;
        return { code: 0, stdout: stream, stderr: '' };
      } });
    const receipt = await runner(
      { task_id: '1', candidate_sha: sha, worktree: repo,
        executor: 'acp-devin/swe-2-high', subject_digest: digest },
      { review: routed });
    assert.equal(receipt.actual.provider, 'opencode-go');
    assert.equal(receipt.actual.model, 'deepseek-v4.1-flash');
    assert.ok(allow.length > 0, 'egress allowlist заполнен — нет model_proxy_allowlist_invalid');

    // 'acp-devin' как критик — у раннера адресов нет: отказ ДО sandbox,
    // не model_proxy_allowlist_invalid внутри контейнера.
    let calls = 0;
    const unrunnable = isolatedPiReviewRunner({ journal, piRoot,
      sandbox: async () => { calls++; return { code: 0, stdout: '', stderr: '' }; } });
    await assert.rejects(
      () => unrunnable({ task_id: '1', candidate_sha: sha, worktree: repo,
        executor: 'acp-devin/swe-2-high' },
        { review: { provider: 'acp-devin', model: 'swe-2-high',
          reasoningLevel: 'medium' } }),
      (e) => e instanceof ReviewDenied && e.reason === 'review_profile_not_approved');
    assert.equal(calls, 0);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(journal, { recursive: true, force: true });
    await rm(piRoot, { recursive: true, force: true });
  }
});

test('l2CriticSpec: google-критик без reasoningLevel наследует его и идёт в Neon-раннер (#1263 r6)', () => {
  // Neon без reasoningLevel + Sol: наследование 'medium' до проверки —
  // выбирается Neon-раннер (isNeonReview), а не Pi-раннер, иначе acceptHeld
  // отклонил бы квитанцию review_isolation_missing.
  const noLevel = l2CriticSpec({ provider: 'google', model: 'gemini-4-neon' });
  assert.equal(noLevel.reasoningLevel, 'medium');
  assert.equal(isNeonReview(noLevel), true);

  // agy-форма нормализуется к 'google' с наследованием из профиля.
  const agy = l2CriticSpec(
    { provider: 'acp-antigravity-acp', model: 'gemini-4-neon' },
    { defaultReasoningLevel: 'high' });
  assert.equal(agy.provider, 'google');
  assert.equal(agy.reasoningLevel, 'high');

  // Явный уровень закреплённого критика сильнее наследства.
  const explicit = l2CriticSpec(
    { provider: 'acp-antigravity-acp', model: 'gemini-4-neon',
      reasoningLevel: 'high' },
    { defaultReasoningLevel: 'medium' });
  assert.equal(explicit.reasoningLevel, 'high');

  // Не-google критик — без наследования.
  const ds = l2CriticSpec({ provider: 'pi', model: 'opencode-go/deepseek-v4.1-flash' });
  assert.equal(ds.provider, 'opencode-go');
  assert.equal(ds.reasoningLevel, undefined);
  assert.equal(isNeonReview(ds), false);

  // Неисполняемый спек — null.
  assert.equal(l2CriticSpec({ provider: 'acp-devin', model: 'swe-2-high' }), null);
});

// --- P1: hardened diff generation, symlink unpack rejection, mount injection ---

async function gitRepo(dir, ...args) {
  return (await exec('git', ['-C', dir, ...args], { timeout: 15_000 })).stdout.trim();
}

async function initRunnerRepo(repo) {
  await gitRepo(repo, 'init', '-q', '-b', 'pilot');
  await gitRepo(repo, 'config', 'user.email', 't@l');
  await gitRepo(repo, 'config', 'user.name', 't');
}

const passStream = [
  msg({ content: [{ type: 'text', text: '{"verdict":"PASS","summary":"ok"}' }] }),
  settled,
].join('\n');

test('runner: diff base→candidate и round.diff не suppressируются атрибутами и не исполняют репо-конфиг', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'runner-diff-repo-'));
  const journal = await mkdtemp(join(tmpdir(), 'runner-diff-journal-'));
  const piRoot = await mkdtemp(join(tmpdir(), 'runner-diff-pi-'));
  const attack = await mkdtemp(join(tmpdir(), 'runner-diff-attack-'));
  try {
    await initRunnerRepo(repo);
    await writeFile(join(repo, 'a.txt'), 'first\n');
    await gitRepo(repo, 'add', 'a.txt');
    await gitRepo(repo, 'commit', '-qm', 'base');
    const base = await gitRepo(repo, 'rev-parse', 'HEAD');
    await writeFile(join(repo, 'a.txt'), 'first\nsecond\n');
    await gitRepo(repo, 'add', 'a.txt');
    await gitRepo(repo, 'commit', '-qm', 'prior');
    const prior = await gitRepo(repo, 'rev-parse', 'HEAD');
    await writeFile(join(repo, 'a.txt'), 'first\nsecond\nthird\n');
    // Атакующие атрибуты — в самом дереве кандидата ('* -diff' скрывает текст
    // под «Binary files differ») и в info/attributes (textconv-драйвер на
    // '*.txt'): оба вектора без защиты исполняются/suppressируют.
    await writeFile(join(repo, '.gitattributes'), '* -diff\n');
    await gitRepo(repo, 'add', 'a.txt', '.gitattributes');
    await gitRepo(repo, 'commit', '-qm', 'candidate');
    const sha = await gitRepo(repo, 'rev-parse', 'HEAD');
    await mkdir(join(repo, '.git', 'info'), { recursive: true });
    await writeFile(join(repo, '.git', 'info', 'attributes'), '*.txt diff=pwn\n');
    // Репо-локальный конфиг воркера: внешний diff-драйвер и textconv пишут
    // маркер при исполнении — с защитой ни один не запускается.
    const markerExt = join(attack, 'pwned-external');
    const markerTx = join(attack, 'pwned-textconv');
    const evilDiff = join(attack, 'evil-diff.sh');
    const evilTx = join(attack, 'evil-textconv.sh');
    await writeFile(evilDiff, `#!/bin/sh\necho x >> "${markerExt}"\nexit 0\n`, { mode: 0o755 });
    await writeFile(evilTx, `#!/bin/sh\necho x >> "${markerTx}"\nexit 0\n`, { mode: 0o755 });
    await gitRepo(repo, 'config', 'diff.external', evilDiff);
    await gitRepo(repo, 'config', 'diff.pwn.textconv', evilTx);
    // Контроль атаки, вектор внешнего драйвера: незащищённый вызов исполняет
    // diff.external из репо-конфига вместо генерации патча — маркер создан.
    await exec('git', ['-C', repo, 'diff', `${base}..${sha}`], { timeout: 15_000 }).catch(() => {});
    assert.ok(await lstat(markerExt).catch(() => null) !== null,
      'контроль: diff.external не исполнился в незащищённом вызове');
    // Контроль атаки, вектор атрибутов (без внешнего драйвера): '* -diff'
    // скрывает текст патча, назначенный textconv-драйвер исполняется.
    const attrsOnly = (await exec('git',
      ['-c', 'diff.external=', '-C', repo, 'diff', '--no-ext-diff', `${base}..${sha}`],
      { timeout: 15_000 })).stdout;
    assert.match(attrsOnly, /Binary files .* differ/, 'атака атрибутов не воспроизвелась');
    assert.ok(!attrsOnly.includes('+second'), 'незащищённый diff неожиданно текстовый');
    assert.ok(await lstat(markerTx).catch(() => null) !== null,
      'контроль: textconv не исполнился в незащищённом вызове');
    // Маркеры сняты: их отсутствие после прогона раннера доказывает защиту.
    await rm(markerExt, { force: true });
    await rm(markerTx, { force: true });
    await writeFile(join(piRoot, 'auth.json'), '{"openai":{"k":"v"}}');

    const captured = {};
    const runner = isolatedPiReviewRunner({ journal, piRoot,
      sandbox: async (opts) => {
        for (const mount of opts.mounts) {
          if (mount.dst === '/review/diff.patch') {
            captured.diff = await readFile(mount.src, 'utf8');
          }
          if (mount.dst === '/review/round.diff') {
            captured.round = await readFile(mount.src, 'utf8');
          }
        }
        return { code: 0, stdout: passStream, stderr: '' };
      } });
    const receipt = await runner({ task_id: '1', candidate_sha: sha, worktree: repo,
      base_sha: base, executor: 'acp-devin/swe-2-high',
      review_round: 2, prior_sha: prior }, { review: CRITIC });
    assert.equal(receipt.status, 'PASS');
    // Ни атрибутная suppression, ни textconv-драйвер не действуют: точный
    // текстовый diff смонтирован критику и в base-, и в round-патче.
    assert.ok(captured.diff?.includes('+second'), `base diff не текстовый:\n${captured.diff}`);
    assert.ok(captured.diff?.includes('+third'), `base diff неполный:\n${captured.diff}`);
    assert.ok(!captured.diff?.includes('Binary files'), `base diff suppressирован:\n${captured.diff}`);
    assert.ok(captured.round?.includes('+third'), `round diff не текстовый:\n${captured.round}`);
    assert.ok(!captured.round?.includes('Binary files'), `round diff suppressирован:\n${captured.round}`);
    assert.equal(await lstat(markerExt).catch(() => null), null,
      'diff.external из репо-конфига исполнился');
    assert.equal(await lstat(markerTx).catch(() => null), null,
      'textconv из репо-конфига исполнился');
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(journal, { recursive: true, force: true });
    await rm(piRoot, { recursive: true, force: true });
    await rm(attack, { recursive: true, force: true });
  }
});

test('runner: симлинк кандидата, уводящий за /candidate — review_snapshot_unsafe_link до sandbox', async () => {
  const journal = await mkdtemp(join(tmpdir(), 'runner-link-journal-'));
  const piRoot = await mkdtemp(join(tmpdir(), 'runner-link-pi-'));
  try {
    await writeFile(join(piRoot, 'auth.json'), '{"openai":{"k":"v"}}');
    // Варианты враждебных ссылок: абсолютная, относительная с выходом за
    // корень, битая, петля, резолвящаяся в сам корень снимка.
    const variants = {
      absolute: async (repo) => symlink('/etc/passwd', join(repo, 'evil')),
      relativeEscape: async (repo) => symlink('../../../../etc/passwd', join(repo, 'evil')),
      broken: async (repo) => symlink('no/such/target', join(repo, 'evil')),
      loop: async (repo) => {
        await symlink('loop-b', join(repo, 'loop-a'));
        await symlink('loop-a', join(repo, 'loop-b'));
      },
      rootItself: async (repo) => symlink('.', join(repo, 'selflink')),
    };
    for (const [kind, plant] of Object.entries(variants)) {
      const repo = await mkdtemp(join(tmpdir(), `runner-link-${kind}-`));
      try {
        await initRunnerRepo(repo);
        await writeFile(join(repo, 'a.txt'), 'x\n');
        await plant(repo);
        await gitRepo(repo, 'add', '-A');
        await gitRepo(repo, 'commit', '-qm', 'cand');
        const sha = await gitRepo(repo, 'rev-parse', 'HEAD');
        let sandboxCalls = 0;
        const runner = isolatedPiReviewRunner({ journal, piRoot,
          sandbox: async () => {
            sandboxCalls++;
            return { code: 0, stdout: passStream, stderr: '' };
          } });
        await assert.rejects(
          runner({ task_id: '1', candidate_sha: sha, worktree: repo,
            executor: 'acp-devin/swe-2-high' }, { review: CRITIC }),
          (e) => e instanceof ReviewDenied && e.reason === 'review_snapshot_unsafe_link',
          `${kind} не отклонён`);
        assert.equal(sandboxCalls, 0, `${kind}: sandbox запущен`);
      } finally {
        await rm(repo, { recursive: true, force: true });
      }
    }
  } finally {
    await rm(journal, { recursive: true, force: true });
    await rm(piRoot, { recursive: true, force: true });
  }
});

test('runner: внутридревовые симлинки кандидата допустимы', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'runner-linkok-repo-'));
  const journal = await mkdtemp(join(tmpdir(), 'runner-linkok-journal-'));
  const piRoot = await mkdtemp(join(tmpdir(), 'runner-linkok-pi-'));
  try {
    await initRunnerRepo(repo);
    await mkdir(join(repo, 'dir', 'sub'), { recursive: true });
    await writeFile(join(repo, 'dir', 'real.txt'), 'x\n');
    // Ссылка на файл внутри дерева, относительная ссылка из вложенного
    // каталога через '..' внутрь дерева и ссылка на каталог дерева.
    await symlink('dir/real.txt', join(repo, 'link.txt'));
    await symlink('../real.txt', join(repo, 'dir', 'sub', 'rel.txt'));
    await symlink('dir', join(repo, 'dirlink'));
    await gitRepo(repo, 'add', '-A');
    await gitRepo(repo, 'commit', '-qm', 'cand');
    const sha = await gitRepo(repo, 'rev-parse', 'HEAD');
    await writeFile(join(piRoot, 'auth.json'), '{"openai":{"k":"v"}}');
    let sandboxCalls = 0;
    const runner = isolatedPiReviewRunner({ journal, piRoot,
      sandbox: async () => {
        sandboxCalls++;
        return { code: 0, stdout: passStream, stderr: '' };
      } });
    const receipt = await runner({ task_id: '1', candidate_sha: sha, worktree: repo,
      executor: 'acp-devin/swe-2-high' }, { review: CRITIC });
    assert.equal(receipt.status, 'PASS');
    assert.equal(sandboxCalls, 1);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(journal, { recursive: true, force: true });
    await rm(piRoot, { recursive: true, force: true });
  }
});

test('sandbox: запятая или равно в путях --mount — sandbox_mount_invalid до вызова docker', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'review-mountinj-'));
  try {
    const source = join(scratch, 'candidate');
    await mkdir(source, { mode: 0o755 });
    // Docker здесь не нужен совсем: валидация обязана идти до docker info.
    const badMounts = [
      { src: '/tmp/evil,rw', dst: '/x' },
      { src: '/tmp/evil=x', dst: '/x' },
      { src: '/tmp/x', dst: '/dst,rw' },
      { src: '/tmp/x', dst: '/dst=x' },
      { src: '/tmp/a,b', dst: '/c,d' },
    ];
    for (const bad of badMounts) {
      await assert.rejects(
        runInReadOnlySandbox({ snapshot: source, argv: ['true'], mounts: [bad], timeoutMs: 1000 }),
        (e) => e instanceof ReviewDenied && e.reason === 'sandbox_mount_invalid',
        JSON.stringify(bad));
    }
    // Относительные пути отклоняются той же причиной, что и раньше.
    await assert.rejects(
      runInReadOnlySandbox({ snapshot: source, argv: ['true'],
        mounts: [{ src: 'relative', dst: '/x' }], timeoutMs: 1000 }),
      (e) => e.reason === 'sandbox_mount_invalid');
    // Сам snapshot — часть спецификации --mount: те же символы запрещены.
    for (const badSnapshot of ['/tmp/snap,evil', '/tmp/snap=evil']) {
      await assert.rejects(
        runInReadOnlySandbox({ snapshot: badSnapshot, argv: ['true'], timeoutMs: 1000 }),
        (e) => e.reason === 'sandbox_mount_invalid', badSnapshot);
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('sandbox: канонические mount-пути без запятых проходят в docker run verbatim', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'review-mountok-'));
  const oldPath = process.env.PATH;
  const oldLog = process.env.FAKE_DOCKER_LOG;
  const oldNodeOptions = process.env.NODE_OPTIONS;
  try {
    const bin = join(scratch, 'bin');
    const source = join(scratch, 'candidate');
    const extra = join(scratch, 'extra-dir');
    const log = join(scratch, 'docker-log.jsonl');
    await mkdir(bin);
    await mkdir(source, { mode: 0o755 });
    await mkdir(extra);
    const harness = await nodePreloadHarness(bin, 'docker', `
const fs = require('fs');
const path = require('path');
const args = [path.basename(process.argv[1] ?? ''), ...process.argv.slice(2)];
if (args[0] === 'info') {
  process.stdout.write('["name=rootless"]\\n');
  process.exit(0);
}
if (args[0] === 'rm') process.exit(0);
if (args[0] !== 'run') process.exit(2);
fs.appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify({ args }) + '\\n');
process.exit(0);
`);
    process.env.PATH = `${bin}:${oldPath}`;
    process.env.FAKE_DOCKER_LOG = log;
    process.env.NODE_OPTIONS = harness.nodeOptions;
    const run = await runInReadOnlySandbox({ snapshot: source, argv: ['true'],
      mounts: [{ src: extra, dst: '/pi-ro/bin' }], timeoutMs: 10_000 });
    assert.equal(run.code, 0);
    const entries = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(entries.length, 1);
    const spec = entries[0].args.filter((arg, i) => entries[0].args[i - 1] === '--mount');
    assert.ok(spec.includes(`type=bind,src=${extra},dst=/pi-ro/bin,readonly`),
      `extra mount missing: ${spec.join(' | ')}`);
    assert.ok(spec.includes(`type=bind,src=${source},dst=/candidate,readonly`),
      `snapshot mount missing: ${spec.join(' | ')}`);
  } finally {
    process.env.PATH = oldPath;
    if (oldLog === undefined) delete process.env.FAKE_DOCKER_LOG;
    else process.env.FAKE_DOCKER_LOG = oldLog;
    if (oldNodeOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = oldNodeOptions;
    await rm(scratch, { recursive: true, force: true });
  }
});
