import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';

import { acceptHeld } from './acceptance.mjs';
import agyStream from './agy-stream.cjs';
import { nativeBoardPort } from './native-board.mjs';
import { isolatedNeonReviewRunner } from './neon-review.mjs';
import { NEON_CRITIC } from './review-policy.mjs';
import { parseReviewTranscript } from './review-runner.mjs';
import { commitFile, neonFixture } from './review-test-fixture.mjs';
import { loadSdk } from './sdk.mjs';
import { aggregateTelemetry, createTelemetryRecorder, formatTelemetryReport, formatTelemetrySummary,
  normalizeUsage, roundGateOf, threadUsage, TELEMETRY_PHASES } from './telemetry.mjs';

const exec = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));

const subject_digest = 'a'.repeat(64);
const verdict = { verdict: 'PASS', subject_digest, summary: 'Matches the spec',
  findings: [], checked_invariants: ['arithmetic'] };

// Поток agy с заданным usage в result (валидные поля RESULT_FIELDS).
function agyStreamWithUsage(cwd, usage, { reads = ['candidate/sum.js'] } = {}) {
  const conversation_id = 'synthetic-review';
  return [
    { event: 'init', conversation_id, init: { model: NEON_CRITIC.model, cwd, permission_mode: 'request-review', tools: [] } },
    { event: 'step_update', step_update: { conversation_id, step_index: 0, state: 'DONE', step_type: 'user_input' } },
    ...reads.map((path, i) => ({ event: 'step_update', step_update: {
      conversation_id, step_index: i + 1, state: 'DONE', step_type: 'tool', tool_name: 'read_file',
      tool_info: { name: 'read_file', parameters: { Path: path } },
    } })),
    { event: 'step_update', step_update: { conversation_id, step_index: reads.length + 1,
      state: 'DONE', step_type: 'agent_response' } },
    { event: 'result', result: { conversation_id, status: 'SUCCESS', num_turns: 1,
      response: JSON.stringify(verdict), ...(usage ? { usage } : {}) } },
  ].map(x => JSON.stringify(x)).join('\n');
}

test('normalizeUsage: agy/openai/camelCase/pi формы, ноль валиден, мусор — null', () => {
  assert.deepEqual(normalizeUsage({ input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 2 }),
    { input: 10, output: 3, cached: 2 });
  assert.deepEqual(normalizeUsage({ prompt_tokens: 7, completion_tokens: 5, cached_tokens: 1 }),
    { input: 7, output: 5, cached: 1 });
  assert.deepEqual(normalizeUsage({ inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 0 }),
    { input: 1, output: 2, cached: 0 });
  // pi-форма: плоское cacheRead и вложенный prompt_tokens_details.
  assert.deepEqual(normalizeUsage({ input: 11, output: 4, cacheRead: 6 }),
    { input: 11, output: 4, cached: 6 });
  assert.deepEqual(normalizeUsage({ prompt_tokens: 9, completion_tokens: 2,
    prompt_tokens_details: { cached_tokens: 7 } }), { input: 9, output: 2, cached: 7 });
  assert.deepEqual(normalizeUsage({ input_tokens: 0 }), { input: 0, output: null, cached: null });
  assert.equal(normalizeUsage(null), null);
  assert.equal(normalizeUsage('42'), null);
  assert.equal(normalizeUsage({ foo: 'bar' }), null);
  assert.equal(normalizeUsage({ input_tokens: -3 }), null);
  assert.equal(normalizeUsage({ input_tokens: Number.POSITIVE_INFINITY }), null);
});

test('threadUsage: защита от неизвестных форм снимков bb/pi', () => {
  assert.deepEqual(threadUsage({ thread: { usage: { input_tokens: 5, output_tokens: 2 } } }),
    { input: 5, output: 2, cached: null });
  assert.deepEqual(threadUsage({ event: { usage: { prompt_tokens: 3, completion_tokens: 1 } } }),
    { input: 3, output: 1, cached: null });
  assert.deepEqual(threadUsage({ usage: { input_tokens: 9 } }), { input: 9, output: null, cached: null });
  assert.equal(threadUsage({ thread: { status: 'idle' } }), null);
  assert.equal(threadUsage(null), null);
});

test('roundGateOf: те же соответствия гейтов, что в worker-selector', () => {
  assert.equal(roundGateOf('local_checks_failed'), 'l1');
  assert.equal(roundGateOf('tamper_gate_failed'), 'tamper');
  assert.equal(roundGateOf('visual_gate_failed'), 'l3');
  assert.equal(roundGateOf('review_verdict:REVIEW_BLOCKED'), 'l2');
  assert.equal(roundGateOf('arbiter_directed_rework'), 'arbiter');
  assert.equal(roundGateOf('no_progress_deterministic_gate'), null);
  assert.equal(roundGateOf(undefined), null);
});

test('телеметрия попытки: фазы, окно воркера, раунды, токены, JSONL 0600', async t => {
  const journal = await mkdtemp(join(tmpdir(), 'telemetry-unit-'));
  t.after(() => rm(journal, { recursive: true, force: true }));
  let now = 1000;
  const rec = createTelemetryRecorder({ journal, clock: () => now,
    models: { critic: NEON_CRITIC, arbiter: { provider: 'openai', model: 'gpt-6.2-sol' } } });

  // spawn: 1000 → 2200.
  const spawned = await rec.phase('spawn', async () => { now = 2200; return { id: 'thr_x' }; },
    { worker: { provider: 'acp-devin', model: 'swe-2-high' } });
  assert.deepEqual(spawned, { id: 'thr_x' });
  rec.workerResume({ subject: { task_id: '9001', attempt_id: 'att-1', epoch: 3 } });
  // Окно воркера закрывается в начале l1_local: 3000 − 2200 = 800.
  now = 3000;
  rec.roundStart();
  await rec.phase('l1_local', async () => { now = 3900; }, { workerWindow: true });
  await rec.phase('tamper', async () => { now = 4100; }, { workerWindow: true });
  await rec.phase('worker_feedback', async () => { now = 4200; });
  rec.recordRound({ outcome: 'rework', reason: 'local_checks_failed' });
  rec.workerResume({});
  // Окно воркера: 8000 − 4200 = 3800; итого 4600.
  now = 8000;
  rec.roundStart();
  await rec.phase('l2_critic', async () => { now = 11500; }, { workerWindow: true });
  rec.recordUsage('critic', { input_tokens: 1234, output_tokens: 567, cache_read_input_tokens: 890 }, 'agy_stream');
  rec.recordRound({ outcome: 'verified' });
  const { record, summary } = await rec.finish({ outcome: 'done', open: false });

  assert.equal(record.task_id, '9001');
  assert.equal(record.attempt_id, 'att-1');
  assert.equal(record.epoch, 3);
  assert.deepEqual(record.phases_ms, { spawn: 1200, worker: 4600, l1_local: 900, tamper: 200,
    l3_visual: null, l2_critic: 3500, arbiter: null, total: 10500, worker_feedback: 100 });
  assert.deepEqual(record.rounds, { total: 2, rework: 1, pass: 1, arbitration: 0, open: 0,
    gates: { l1: 1 } });
  assert.deepEqual(record.tokens.critic, { input: 1234, output: 567, cached: 890, source: 'agy_stream' });
  assert.equal(record.tokens.worker, null);
  assert.deepEqual(record.models.worker, { provider: 'acp-devin', model: 'swe-2-high' });
  assert.deepEqual(record.models.critic, { provider: 'google', model: 'gemini-4-neon' });
  assert.equal(record.partial, false);
  assert.equal(record.outcome, 'done');
  assert.equal(record.open, false);
  assert.match(summary, /total=10\.5s/);
  assert.match(summary, /spawn=1\.2s/);
  assert.match(summary, /worker=4\.6s/);
  assert.match(summary, /l1_local=0\.9s/);
  assert.match(summary, /rounds=2 rw=1 pass=1/);
  assert.match(summary, /tok\[critic\]=1234 \/ 567 \/ 890/);
  assert.match(summary, /tok\[worker\]=-/);
  // Не измеренное не выдумывается: arbiter/l3 отсутствуют среди фаз строки.
  const parts = summary.split(' ');
  assert.equal(parts.some(part => part.startsWith('arbiter=')), false);
  assert.equal(parts.some(part => part.startsWith('l3_visual=')), false);
  assert.equal(parts.some(part => part.startsWith('worker_feedback=')), false);
  for (const phase of TELEMETRY_PHASES) assert.ok(Object.hasOwn(record.phases_ms, phase));

  // Полная запись — одна строка в приватном JSONL-журнале попытки.
  const file = join(journal, 'telemetry.jsonl');
  const stats = await lstat(file);
  assert.equal(stats.mode & 0o777, 0o600);
  const lines = (await readFile(file, 'utf8')).trim().split('\n');
  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.kind, 'attempt_summary');
  assert.equal(entry.schema, 1);
  assert.equal(entry.outcome, 'done');
  assert.equal(entry.phases_ms.total, 10500);
  assert.match(entry.started_at, /^\d{4}-/);
});

test('fail-open: ошибка шага проходит без изменений, длительность фиксируется', async t => {
  const journal = await mkdtemp(join(tmpdir(), 'telemetry-fail-'));
  t.after(() => rm(journal, { recursive: true, force: true }));
  let now = 0;
  const rec = createTelemetryRecorder({ journal, clock: () => now });
  await assert.rejects(rec.phase('l1_local', async () => { now += 123; throw new Error('boom'); }),
    { message: 'boom' });
  const { record, summary } = await rec.finish({ outcome: 'hold', open: false });
  assert.equal(record.phases_ms.l1_local, 123);
  assert.equal(record.rounds.total, 0);
  assert.ok(summary.includes('l1_local=0.1s'));
});

test('fail-open: недоступный журнал не ломает finish; повторный finish кэшируется', async t => {
  const journal = await mkdtemp(join(tmpdir(), 'telemetry-write-'));
  t.after(() => rm(journal, { recursive: true, force: true }));
  const rec = createTelemetryRecorder({ journal: join(journal, 'missing', 'deeper'), clock: () => 5 });
  await rec.phase('spawn', async () => {});
  const first = await rec.finish({ outcome: 'done', open: false });
  assert.ok(first.summary);
  assert.equal(first.record.outcome, 'done');
  const again = await rec.finish({ outcome: 'hold', open: true });
  assert.equal(again, first);
});

test('fail-open: пустая телеметрия не создаёт файл', async t => {
  const journal = await mkdtemp(join(tmpdir(), 'telemetry-empty-'));
  t.after(() => rm(journal, { recursive: true, force: true }));
  const rec = createTelemetryRecorder({ journal, clock: () => 0 });
  const { record, summary } = await rec.finish({ outcome: 'idle' });
  assert.equal(record, null);
  assert.equal(summary, null);
  await assert.rejects(lstat(join(journal, 'telemetry.jsonl')), { code: 'ENOENT' });
});

test('partial: попытка, подхваченная после рестарта, помечается partial', async t => {
  const journal = await mkdtemp(join(tmpdir(), 'telemetry-partial-'));
  t.after(() => rm(journal, { recursive: true, force: true }));
  const rec = createTelemetryRecorder({ journal, clock: () => 0 });
  await rec.phase('l2_critic', async () => {});
  const { record } = await rec.finish({ outcome: 'uncertain', open: true });
  assert.equal(record.partial, true);
  assert.equal(record.open, true);
  assert.equal(record.outcome, 'uncertain');
  // workerResume ни разу не вызывался — фаза worker null, а не ноль.
  assert.equal(record.phases_ms.worker, null);
});

test('recordUsage: суммирует токены по раундам, null не выдумывается', async t => {
  const journal = await mkdtemp(join(tmpdir(), 'telemetry-sum-'));
  t.after(() => rm(journal, { recursive: true, force: true }));
  const rec = createTelemetryRecorder({ journal, clock: () => 0 });
  rec.recordUsage('critic', { input: 100, output: 50, cacheRead: 10 }, 'pi_stream');
  rec.recordUsage('critic', { input_tokens: 30, output_tokens: 20 }, 'agy_stream');
  // Числа раундов сложились, cached первого раунда сохранился, источник — последний.
  assert.deepEqual(rec.summary().tokens.critic,
    { input: 130, output: 70, cached: 10, source: 'agy_stream' });
  assert.deepEqual(rec.summary().tokens.worker, null);
  // Раунд без чисел (null) не ломает накопленное и не выдумывает нули.
  rec.recordUsage('critic', null);
  rec.recordUsage('critic', { garbage: true });
  assert.deepEqual(rec.summary().tokens.critic,
    { input: 130, output: 70, cached: 10, source: 'agy_stream' });
});

test('embed: сводка в квитанции ≤1000, не влезла — квитанция без неё', async t => {
  const journal = await mkdtemp(join(tmpdir(), 'telemetry-embed-'));
  t.after(() => rm(journal, { recursive: true, force: true }));
  const rec = createTelemetryRecorder({ journal, clock: () => 0 });
  await rec.phase('l2_critic', async () => {});
  rec.recordRound({ outcome: 'verified' });
  rec.recordUsage('critic', { input_tokens: 100, output_tokens: 5 }, 'agy_stream');
  const evidence = { v: 1, sha: 'a'.repeat(40), checks: { ok: true, n: 1 } };
  const embedded = rec.embed(evidence);
  assert.ok(JSON.stringify(embedded).length <= 1000);
  assert.equal(embedded.telemetry, rec.summaryLine());
  // Квитанция у лимита: телеметрия не пролезает, исход не меняется.
  const big = { v: 1, blob: 'x'.repeat(985) };
  assert.equal(rec.embed(big), big);
  assert.equal(rec.embed('raw'), 'raw');
  assert.equal(rec.embed(null), null);
  // Закрываемый раунд отражается в квитанции complete как pass, без open.
  const closing = createTelemetryRecorder({ journal, clock: () => 0 });
  await closing.phase('l2_critic', async () => {});
  closing.roundStart();
  const projected = closing.embed({ v: 1 });
  assert.match(projected.telemetry, /rounds=1 rw=0 pass=1/);
  assert.doesNotMatch(projected.telemetry, /open=/);
});

test('aggregate + отчёт: суммы фаз/раундов/токенов, фильтры, битые строки', () => {
  const lines = [
    JSON.stringify({ kind: 'attempt_summary', schema: 1, task_id: '9001', attempt_id: 'a1', epoch: 1,
      outcome: 'done', reason: null, open: false,
      started_at: '2026-11-23T10:00:00.000Z', ended_at: '2026-11-23T10:01:00.000Z',
      phases_ms: { spawn: 1200, worker: 4700, l1_local: 900, tamper: null, l3_visual: null,
        l2_critic: 3500, arbiter: null, total: 60000 },
      rounds: { total: 2, rework: 1, pass: 1, arbitration: 0 },
      models: { worker: { provider: 'acp-devin', model: 'swe-2-high' },
        critic: { provider: 'google', model: 'gemini-4-neon' } },
      tokens: { worker: null, critic: { input: 100, output: 50, cached: 10 }, arbiter: null } }),
    JSON.stringify({ kind: 'attempt_summary', schema: 1, task_id: '9002', attempt_id: 'a2', epoch: 1,
      outcome: 'hold', reason: 'local_checks_failed', open: false,
      started_at: '2026-11-23T09:00:00.000Z',
      phases_ms: { spawn: 900, worker: 2000, l1_local: 500, tamper: null, l3_visual: null,
        l2_critic: null, arbiter: null, total: 30000 },
      rounds: { total: 1, rework: 0, pass: 0, arbitration: 0 },
      models: { worker: { provider: 'acp-devin', model: 'swe-2-high' } },
      tokens: { worker: null, critic: null, arbiter: null } }),
    '{corrupt',
    JSON.stringify({ kind: 'attempt_summary', schema: 2, outcome: 'done' }),
    JSON.stringify({ kind: 'other', schema: 1 }),
  ];
  const agg = aggregateTelemetry(lines);
  assert.equal(agg.attempts, 2);
  assert.equal(agg.corrupt, 1);
  assert.equal(agg.open_attempts, 0);
  assert.deepEqual(agg.outcomes, { done: 1, hold: 1 });
  assert.equal(agg.phases_ms.spawn.n, 2);
  assert.equal(agg.phases_ms.spawn.sum, 2100);
  assert.equal(agg.phases_ms.spawn.max, 1200);
  assert.equal(agg.phases_ms.spawn.mean, 1050);
  assert.equal(agg.phases_ms.l2_critic.n, 1);
  assert.deepEqual(agg.rounds, { total: 3, rework: 1, pass: 1, arbitration: 0, open: 0 });
  assert.deepEqual(agg.tokens.critic, { attempts_with_usage: 1, input: 100, output: 50, cached: 10 });
  assert.deepEqual(agg.models.worker, { 'acp-devin/swe-2-high': 2 });
  assert.equal(agg.first, Date.parse('2026-11-23T09:00:00.000Z'));
  assert.equal(agg.last, Date.parse('2026-11-23T10:00:00.000Z'));

  assert.equal(aggregateTelemetry(lines, { task: '9001' }).attempts, 1);
  assert.equal(aggregateTelemetry(lines, { open: true }).attempts, 0);
  assert.equal(aggregateTelemetry(lines, { open: false }).attempts, 2);
  assert.equal(aggregateTelemetry(lines, { since: Date.parse('2026-11-23T09:30:00Z') }).attempts, 1);
  assert.equal(aggregateTelemetry([]).attempts, 0);

  const report = formatTelemetryReport(agg);
  assert.match(report, /VS-3 telemetry: 2 attempts \(0 open\), corrupt lines: 1/);
  assert.match(report, /Outcomes: done=1 hold=1/);
  assert.match(report, /spawn 1\.1s \/ 1\.2s \/ n=2/);
  assert.match(report, /Rounds: total=3 \(mean 1\.50\/attempt\), rework=1, pass=1, arbitration=0/);
  assert.match(report, /critic: in 100 \/ out 50 \/ cached 10 \(attempts with usage: 1\)/);
  assert.match(report, /acp-devin\/swe-2-high x2/);
  // formatTelemetrySummary на чужих входах не выдумывает строку.
  assert.equal(formatTelemetrySummary(null), null);
});

test('agy-stream: usage из result доходит до наблюдателя, отсутствие — null', async t => {
  // Реальный снимок под cwd: шаги read_file валидируются checkSnapshotTool.
  const cwd = await mkdtemp(join(tmpdir(), 'agy-usage-'));
  await mkdir(join(cwd, 'candidate'), { recursive: true });
  await writeFile(join(cwd, 'candidate', 'sum.js'), 'export const sum = (a,b) => a+b;\n');
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const withUsage = agyStream.parseAgyStream(
    agyStreamWithUsage(cwd, { input_tokens: 42, output_tokens: 7 }), cwd, { snapshotTools: true });
  assert.deepEqual(withUsage.usage, { input_tokens: 42, output_tokens: 7 });
  assert.equal(withUsage.text, JSON.stringify(verdict));
  const withoutUsage = agyStream.parseAgyStream(
    agyStreamWithUsage(cwd, null), cwd, { snapshotTools: true });
  assert.equal(withoutUsage.usage, null);
});

test('parseReviewTranscript: usage ассистентских message_end суммируется', () => {
  const piMsg = (over = {}) => JSON.stringify({ type: 'message_end', message: {
    role: 'assistant', provider: 'openai', model: 'gpt-6.2-sol', thinkingLevel: 'medium',
    responseId: 'resp_1', stopReason: 'stop',
    content: [{ type: 'text', text: 'looks fine\nREVIEW_OK' }], ...over } });
  const settledEvent = JSON.stringify({ type: 'agent_settled', aborted: false });
  // Два хода pi: числа usage складываются, cacheRead и вложенный
  // prompt_tokens_details.cached_tokens распознаются.
  const parsed = parseReviewTranscript([
    piMsg({ usage: { input: 100, output: 50, cacheRead: 10 } }),
    piMsg({ usage: { input: 30, output: 20, prompt_tokens_details: { cached_tokens: 5 } },
      content: [{ type: 'text', text: 'final\nREVIEW_OK' }] }),
    settledEvent,
  ].join('\n'));
  assert.deepEqual(parsed.usage, { input: 130, output: 70, cached: 15 });
  // Провайдер не отдал usage — явный null.
  const withoutUsage = parseReviewTranscript([piMsg(), settledEvent].join('\n'));
  assert.equal(withoutUsage.usage, null);
  // Нечисловой usage хода не ломает разбор.
  const garbage = parseReviewTranscript([
    piMsg({ usage: 'bogus' }), piMsg({ usage: { input: 7 },
      content: [{ type: 'text', text: 'final\nREVIEW_OK' }] }), settledEvent,
  ].join('\n'));
  assert.deepEqual(garbage.usage, { input: 7, output: null, cached: null });
});

test('neon-review: usage из потока попадает в квитанцию критика', async t => {
  const { repo, journal, binding, profile } = await neonFixture(t);
  const candidate_sha = await commitFile(repo, 'export const sum = (a,b) => a+b;\n');
  const run = usage => isolatedNeonReviewRunner({ journal, prompt: 'approved logika and specification',
    sandbox: async () => ({ code: 0, stdout: '["candidate/sum.js"]' }),
    transport: async ({ snapshot: cwd, publishSnapshot }) => {
      await publishSnapshot();
      return { code: 0, cwd, stdout: agyStreamWithUsage(cwd, usage) };
    } });
  const withUsage = await run({ input_tokens: 42, output_tokens: 7 })(
    { ...binding, candidate_sha, subject_digest }, profile);
  // Квитанция несёт usage потока как есть; нормализация — в рекордере.
  assert.deepEqual(withUsage.usage, { input_tokens: 42, output_tokens: 7 });
  assert.equal(withUsage.verdict, 'REVIEW_OK');
  // Провайдер не отдал usage — явный null в квитанции, приёмка зелёная.
  const withoutUsage = await run(null)({ ...binding, candidate_sha, subject_digest }, profile);
  assert.equal(withoutUsage.usage, null);
  assert.equal(withoutUsage.verdict, 'REVIEW_OK');
});

// Минимальный стенд изолированной доски (как в accept-held.test.mjs).
const { board, local } = loadSdk();
const BASE = '0'.repeat(40);
const CAND = 'a'.repeat(40);
const REVIEW_ROUTE = { provider: 'openai', model: 'gpt-6.2-sol', reasoningLevel: 'medium' };

async function isolated(t) {
  const backend = local({ memory: true });
  t.after(() => backend.close());
  const handle = board({ backend });
  await handle.createChannel('pilot');
  return handle;
}

async function task(handle) {
  const { task: card } = await handle.tasks.create('pilot', { text: 'Synthetic telemetry acceptance', noSync: true });
  return card.id;
}

async function held(handle, id) {
  const port = nativeBoardPort(handle, { channel: 'pilot' });
  const { epoch } = await port.claim(id);
  return { epoch, port };
}

function policy(taskId) {
  return { version: '2', profiles: { pilot: { task: taskId, worker: 'thr_fixture', worktree: '/tmp/wt',
    branch: 'pilot', base: BASE, review: REVIEW_ROUTE } } };
}

function attempt(taskId, epoch) {
  return { attempt_id: 'att-1', task_id: taskId, epoch, bb_thread_id: 'thr_fixture', worktree: '/tmp/wt',
    base_sha: BASE, check_profile: 'pilot', finish: 'verified' };
}

function submission(taskId, epoch) {
  return { task_id: taskId, epoch, attempt_id: 'att-1', worker_thread_id: 'thr_fixture', candidate_sha: CAND };
}

function stubs() {
  return { ports: {
    inspect: async (binding) => ({ head: binding.candidate_sha, clean: true, baseAncestor: true }),
    local: async (binding) => ({ sha: binding.candidate_sha, ok: true, evidence: 'checks.json', exit: 0 }),
    tamper: async (binding) => ({ ok: true, sha: binding.candidate_sha, base_sha: binding.base_sha,
      violations: [], digest: 't'.repeat(64) }),
    review: async (binding) => ({ task: binding.task_id, sha: binding.candidate_sha,
      actual: { ...REVIEW_ROUTE }, verdict: 'REVIEW_OK', checkpoint: 'feed80ab' }),
  } };
}

async function settled(handle, id) {
  const { message } = await handle.thread(id);
  const raw = message.task.result;
  return { state: message.task.state, result: typeof raw === 'string' ? JSON.parse(raw) : raw };
}

test('интеграция: телеметрия вокруг acceptHeld попадает в квитанцию карточки', async t => {
  const handle = await isolated(t);
  const id = await task(handle);
  const { epoch, port: boardPort } = await held(handle, id);
  const journal = await mkdtemp(join(tmpdir(), 'telemetry-it-'));
  t.after(() => rm(journal, { recursive: true, force: true }));
  const rec = createTelemetryRecorder({ journal });
  // Обвязка квитанции закрытия — как в run-isolated: complete через embed.
  const completeCard = boardPort.complete.bind(boardPort);
  boardPort.complete = (taskId, ep, evidence) => completeCard(taskId, ep, rec.embed(evidence));
  const { ports } = stubs();

  rec.roundStart();
  const result = await acceptHeld({ attempt: attempt(id, epoch), submission: submission(id, epoch),
    policy: policy(id), journal, ports: {
      ...ports,
      inspect: rec.port('inspect', ports.inspect),
      local: rec.port('l1_local', ports.local),
      tamper: rec.port('tamper', ports.tamper),
      review: async (binding) => {
        const receipt = await rec.phase('l2_critic', () => ports.review(binding));
        rec.recordUsage('critic', receipt?.usage, 'agy_stream');
        return receipt;
      },
      board: boardPort,
    } });
  assert.equal(result.outcome, 'verified');
  rec.recordRound({ outcome: result.outcome });
  const { record, summary } = await rec.finish({ outcome: 'done', open: false });

  assert.equal(record.rounds.total, 1);
  assert.equal(record.rounds.open, 0);
  assert.equal(record.rounds.pass, 1);
  assert.notEqual(record.phases_ms.l1_local, null);
  assert.notEqual(record.phases_ms.tamper, null);
  assert.notEqual(record.phases_ms.l2_critic, null);
  // Воркер в этом стенде не спавнился — фаза явный null, а не ноль.
  assert.equal(record.phases_ms.spawn, null);
  assert.equal(Number.isFinite(record.phases_ms.total), true);
  // Legacy-квитанция без usage: явный null, приёмка зелёная.
  assert.equal(record.tokens.critic, null);
  assert.match(summary, /tok\[critic\]=-/);
  assert.match(summary, /rounds=1 rw=0 pass=1/);

  // Компактная строка телеметрии дошла до карточки на Board. Закрываемый
  // раунд отражён как pass (complete строится внутри acceptHeld).
  const after = await settled(handle, id);
  assert.equal(after.state, 'completed');
  assert.equal(typeof after.result.telemetry, 'string');
  assert.match(after.result.telemetry, /total=/);
  assert.match(after.result.telemetry, /rounds=1 rw=0 pass=1/);
  assert.doesNotMatch(after.result.telemetry, /open=/);
  // В квитанции нет секретов: только тайминги, раунды и токены.
  assert.doesNotMatch(after.result.telemetry, /thr_|att-1|\/tmp|worktree/);
});

test('CLI: сводка по журналу — текст, --json, отсутствующий файл', async t => {
  const journal = await mkdtemp(join(tmpdir(), 'telemetry-cli-'));
  t.after(() => rm(journal, { recursive: true, force: true }));
  const rec = createTelemetryRecorder({ journal, clock: () => 1000 });
  await rec.phase('spawn', async () => {}, { subject: { task_id: '9001', attempt_id: 'a1', epoch: 1 } });
  rec.recordRound({ outcome: 'verified' });
  rec.recordUsage('critic', { input_tokens: 10, output_tokens: 2 }, 'agy_stream');
  await rec.finish({ outcome: 'done', open: false });

  const files = await readdir(journal);
  assert.deepEqual(files, ['telemetry.jsonl']);
  const cli = join(here, 'telemetry-report.mjs');
  const json = await exec(process.execPath, [cli, journal, '--json']);
  const agg = JSON.parse(json.stdout);
  assert.equal(agg.attempts, 1);
  assert.deepEqual(agg.outcomes, { done: 1 });
  assert.equal(agg.tokens.critic.input, 10);
  const text = await exec(process.execPath, [cli, journal]);
  assert.match(text.stdout, /VS-3 telemetry: 1 attempt/);
  assert.match(text.stdout, /Outcomes: done=1/);
  assert.match(text.stdout, /critic: in 10 \/ out 2 \/ cached 0/);
  // Fail-open: недоступный файл — пустой отчёт, а не сбой.
  const missing = await exec(process.execPath, [cli, join(journal, 'missing.jsonl')]);
  assert.match(missing.stdout, /0 attempts/);
});
