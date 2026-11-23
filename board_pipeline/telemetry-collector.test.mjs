import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';

import { computeMedian, createTelemetryRecorder, normalizeCost, sumCosts, TELEMETRY_SCHEMA } from './telemetry.mjs';
import {
  collectTelemetry,
  COLLECTOR_SCHEMA,
  diffSnapshots,
  escapeHtml,
  formatDiffMarkdown,
  formatSnapshotMarkdown,
  HISTORY_SCHEMA,
  loadBbThreadsFromCli,
  loadBoardTasksFromApi,
  readHistory,
  renderTelemetryDashboardHtml,
  writeSnapshot,
} from './telemetry-collector.mjs';

const exec = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const collectorCli = join(here, 'telemetry-collector.mjs');

test('telemetry helpers: normalizeCost, sumCosts, computeMedian строго сохраняют null', () => {
  assert.equal(normalizeCost(null), null);
  assert.equal(normalizeCost(undefined), null);
  assert.equal(normalizeCost({}), null);
  assert.equal(normalizeCost({ cost_usd: -1 }), null);
  assert.equal(normalizeCost({ cost_usd: Number.NaN }), null);
  assert.equal(normalizeCost({ cost_usd: 0 }), 0);
  assert.equal(normalizeCost({ totalCostUsd: 0.25 }), 0.25);
  assert.equal(normalizeCost({ usage: { cost_usd: 0.05 } }), 0.05);

  assert.equal(sumCosts([null, undefined, {}]), null);
  assert.equal(sumCosts([null, 0.1, { cost_usd: 0.2 }]), 0.30000000000000004);
  assert.equal(sumCosts([0]), 0);

  assert.equal(computeMedian([]), null);
  assert.equal(computeMedian([null, undefined]), null);
  assert.equal(computeMedian([30, 10, 20]), 20);
  assert.equal(computeMedian([40, 10, 20, 30]), 25);
});

test('collectTelemetry: все 4 уровня метрик (портфель, каналы, задачи, модели) через инъекцию источников', async () => {
  const boardTasks = [
    {
      id: '101',
      channel: 'alpha',
      title: 'Implement auth',
      task: { state: 'done' },
    },
    {
      id: '102',
      channel: 'alpha',
      title: 'Fix cache',
      task: { state: 'done' },
    },
    {
      id: '103',
      channel: 'beta',
      title: 'Pending migration',
      task: { state: 'ready' },
    },
  ];

  const telemetryRuns = [
    {
      kind: 'attempt_summary',
      schema: TELEMETRY_SCHEMA,
      task_id: '101',
      attempt_id: 'att-101',
      thread_id: 'thr_101',
      phases_ms: { total: 10_000 },
      rounds: { total: 1, rework: 0, pass: 1, arbitration: 0, open: 0 },
      models: {
        worker: { provider: 'acp-devin', model: 'swe-2-high' },
        critic: { provider: 'google', model: 'gemini-4-neon' },
        arbiter: null,
      },
      tokens: {
        worker: null, // провайдер не отдаёт usage → строго null
        critic: { input: 1000, output: 500, cached: 200 },
        arbiter: null,
      },
      costs: {
        worker: null,
        critic: 0.02,
        arbiter: null,
      },
      outcome: 'done',
      open: false,
    },
    {
      kind: 'attempt_summary',
      schema: TELEMETRY_SCHEMA,
      task_id: '102',
      attempt_id: 'att-102',
      phases_ms: { total: 30_000 },
      rounds: { total: 3, rework: 2, pass: 1, arbitration: 0, open: 0 },
      models: {
        worker: { provider: 'acp-devin', model: 'swe-2-high' },
        critic: { provider: 'google', model: 'gemini-4-neon' },
        arbiter: { provider: 'openai', model: 'gpt-6.2-sol' },
      },
      tokens: {
        worker: null,
        critic: { input: 2000, output: 1000, cached: null },
        arbiter: { input: 500, output: 250, cached: 0 },
      },
      costs: {
        worker: null,
        critic: 0.04,
        arbiter: 0.01,
      },
      outcome: 'done',
      open: false,
    },
  ];

  const bbThreads = [
    // Дублирующий тред thr_101 (уже связан с attempt_summary) — не должен удваивать runs!
    {
      id: 'thr_101',
      project: 'alpha',
      task_id: '101',
      provider: 'acp-devin',
      model: 'swe-2-high',
      status: 'completed',
    },
    // Несвязанный упавший тред провайдера для задачи 103
    {
      id: 'thr_103_fail',
      project: 'beta',
      task_id: '103',
      provider: 'anthropic',
      model: 'claude-4',
      status: 'failed',
      error: 'rate_limit',
      duration_ms: 5_000,
    },
  ];

  const snapshot = await collectTelemetry({
    sources: {
      loadBoardTasks: async () => boardTasks,
      loadBbThreads: async () => bbThreads,
      loadTelemetryRuns: async () => telemetryRuns,
    },
    clock: () => Date.parse('2026-11-23T10:00:00.000Z'),
  });

  assert.equal(snapshot.schema, COLLECTOR_SCHEMA);
  assert.equal(snapshot.generated_at, '2026-11-23T10:00:00.000Z');

  // (а) Портфель
  assert.equal(snapshot.portfolio.total_tasks, 3);
  assert.equal(snapshot.portfolio.closed_tasks, 2);
  assert.equal(snapshot.portfolio.open_tasks, 1);
  assert.equal(snapshot.portfolio.completion_rate, 2 / 3);
  // Wall clocks: 101=10000, 102=30000, 103=5000 (from thread) → median = 10000
  assert.equal(snapshot.portfolio.median_wall_clock_ms, 10_000);
  // Closed tasks with rounds: 101 (rework 0 → pass), 102 (rework 2 → fail 1st round) → 0.5
  assert.equal(snapshot.portfolio.first_round_pass_rate, 0.5);
  assert.equal(snapshot.portfolio.avg_rework_rounds, 1);
  assert.deepEqual(snapshot.portfolio.tokens, { input: 3500, output: 1750, cached: 200 });
  assert.ok(Math.abs(snapshot.portfolio.cost_usd - 0.07) < 1e-9);

  // (б) Каналы
  assert.equal(snapshot.channels.length, 2);
  const alpha = snapshot.channels.find(c => c.channel === 'alpha');
  const beta = snapshot.channels.find(c => c.channel === 'beta');
  assert.equal(alpha.total_tasks, 2);
  assert.equal(alpha.closed_tasks, 2);
  assert.equal(alpha.completion_rate, 1);
  assert.equal(alpha.median_wall_clock_ms, 20_000);
  assert.equal(alpha.first_round_pass_rate, 0.5);

  assert.equal(beta.total_tasks, 1);
  assert.equal(beta.closed_tasks, 0);
  assert.equal(beta.open_tasks, 1);
  assert.equal(beta.completion_rate, 0);
  assert.equal(beta.median_wall_clock_ms, 5_000);
  assert.equal(beta.first_round_pass_rate, null);

  // (в) Задачи
  const t101 = snapshot.tasks.find(t => t.task_id === '101');
  const t102 = snapshot.tasks.find(t => t.task_id === '102');
  const t103 = snapshot.tasks.find(t => t.task_id === '103');
  assert.equal(t101.wall_clock_ms, 10_000);
  assert.equal(t101.rework_rounds, 0);
  assert.equal(t101.status, 'done');
  assert.deepEqual(t101.models, ['acp-devin/swe-2-high', 'google/gemini-4-neon']);

  assert.equal(t102.wall_clock_ms, 30_000);
  assert.equal(t102.rework_rounds, 2);
  assert.deepEqual(t102.models, ['acp-devin/swe-2-high', 'google/gemini-4-neon', 'openai/gpt-6.2-sol']);

  assert.equal(t103.status, 'ready');
  assert.equal(t103.closed, false);
  assert.deepEqual(t103.models, ['anthropic/claude-4']);

  // (г) Модели — проверяем дедупликацию, отказы и СТРОГИЙ null для usage/cost
  const devin = snapshot.models.find(m => m.model_id === 'acp-devin/swe-2-high');
  assert.equal(devin.runs, 2); // thr_101 не удвоил запуск!
  assert.equal(devin.first_round_pass_rate, 0.5);
  assert.equal(devin.avg_rework_rounds, 1);
  assert.equal(devin.provider_failures, 0);
  assert.equal(devin.tokens, null); // строго null, не {0,0,0}!
  assert.equal(devin.cost_usd, null); // строго null, не 0!

  const neon = snapshot.models.find(m => m.model_id === 'google/gemini-4-neon');
  assert.equal(neon.runs, 2);
  assert.deepEqual(neon.tokens, { input: 3000, output: 1500, cached: 200 });
  assert.ok(Math.abs(neon.cost_usd - 0.06) < 1e-9);

  const claude = snapshot.models.find(m => m.model_id === 'anthropic/claude-4');
  assert.equal(claude.runs, 1);
  assert.equal(claude.provider_failures, 1);
  assert.equal(claude.first_round_pass_rate, 0);
  assert.equal(claude.tokens, null);
  assert.equal(claude.cost_usd, null);
});

test('collectTelemetry: честный null при отсутствии usage/cost и подсчёт битых JSONL-строк', async () => {
  const lines = [
    'not-valid-json',
    JSON.stringify({
      kind: 'attempt_summary',
      schema: TELEMETRY_SCHEMA,
      task_id: '201',
      phases_ms: { total: 4000 },
      rounds: { total: 1, rework: 0, pass: 0, arbitration: 0, open: 0 },
      models: { worker: { provider: 'openai', model: 'gpt-6.2-sol' }, critic: null, arbiter: null },
      tokens: { worker: null, critic: null, arbiter: null },
      outcome: 'hold',
      reason: 'spawn_failed',
      open: false,
    }),
  ];

  const snapshot = await collectTelemetry({
    telemetryLines: lines,
    clock: () => Date.parse('2026-11-23T11:00:00.000Z'),
  });

  assert.equal(snapshot.sources.corrupt_telemetry_lines, 1);
  assert.equal(snapshot.portfolio.tokens, null);
  assert.equal(snapshot.portfolio.cost_usd, null);
  assert.equal(snapshot.models.length, 1);
  assert.equal(snapshot.models[0].provider_failures, 1);
  assert.equal(snapshot.models[0].tokens, null);
  assert.equal(snapshot.models[0].cost_usd, null);
  assert.equal(snapshot.models[0].first_round_pass_rate, 0);
});

test('инжектируемые адаптеры: loadBoardTasksFromApi и loadBbThreadsFromCli', async () => {
  const tasks = await loadBoardTasksFromApi({
    url: 'http://localhost:9999/tasks',
    token: 'test-tok',
    fetchImpl: async (url, opts) => {
      assert.equal(url, 'http://localhost:9999/tasks');
      assert.equal(opts.headers.authorization, 'Bearer test-tok');
      return { ok: true, json: async () => ({ tasks: [{ id: '1', channel: 'core', status: 'done' }] }) };
    },
  });
  assert.equal(tasks.length, 1);

  const threads = await loadBbThreadsFromCli({
    project: 'proj-1',
    execBb: async args => {
      assert.deepEqual(args, ['thread', 'list', '--json', '--project', 'proj-1']);
      return { stdout: JSON.stringify({ threads: [{ id: 'thr_1', status: 'completed' }] }) };
    },
  });
  assert.equal(threads.length, 1);
});

test('diffSnapshots: честный расчёт дельт и обработка null (без подмены на 0)', () => {
  const snapA = {
    schema: COLLECTOR_SCHEMA,
    generated_at: '2026-11-20T00:00:00.000Z',
    portfolio: {
      total_tasks: 10,
      closed_tasks: 6,
      open_tasks: 4,
      completion_rate: 0.6,
      median_wall_clock_ms: 20_000,
      first_round_pass_rate: 0.5,
      avg_rework_rounds: 1.5,
      tokens: null,
      cost_usd: null,
    },
    channels: [
      { channel: 'alpha', total_tasks: 10, closed_tasks: 6, completion_rate: 0.6, median_wall_clock_ms: 20_000, first_round_pass_rate: 0.5, avg_rework_rounds: 1.5, cost_usd: null },
    ],
    models: [
      { model_id: 'google/gemini-4-neon', runs: 5, first_round_pass_rate: 0.6, avg_rework_rounds: 1.0, provider_failures: 2, tokens: { input: 1000, output: 500, cached: null }, cost_usd: 0.1 },
    ],
  };

  const snapB = {
    schema: COLLECTOR_SCHEMA,
    generated_at: '2026-11-23T00:00:00.000Z',
    portfolio: {
      total_tasks: 10,
      closed_tasks: 8,
      open_tasks: 2,
      completion_rate: 0.8,
      median_wall_clock_ms: 15_000,
      first_round_pass_rate: 0.75,
      avg_rework_rounds: 0.5,
      tokens: { input: 2000, output: 1000, cached: 100 },
      cost_usd: 0.25,
    },
    channels: [
      { channel: 'alpha', total_tasks: 10, closed_tasks: 8, completion_rate: 0.8, median_wall_clock_ms: 15_000, first_round_pass_rate: 0.75, avg_rework_rounds: 0.5, cost_usd: 0.25 },
    ],
    models: [
      { model_id: 'google/gemini-4-neon', runs: 10, first_round_pass_rate: 0.8, avg_rework_rounds: 0.5, provider_failures: 0, tokens: { input: 2500, output: 1500, cached: 200 }, cost_usd: 0.2 },
    ],
  };

  const diff = diffSnapshots(snapA, snapB);
  assert.ok(Math.abs(diff.portfolio.completion_rate.delta - 0.2) < 1e-9);
  assert.equal(diff.portfolio.median_wall_clock_ms.delta, -5000);
  assert.equal(diff.portfolio.median_wall_clock_ms.speedup_pct, 0.25); // 25% ускорение
  assert.equal(diff.portfolio.first_round_pass_rate.delta, 0.25);
  assert.equal(diff.portfolio.avg_rework_rounds.delta, -1.0);
  // Было null → стало число: delta обязана быть null, а не (after - 0)!
  assert.equal(diff.portfolio.tokens.total.before, null);
  assert.equal(diff.portfolio.tokens.total.after, 3000);
  assert.equal(diff.portfolio.tokens.total.delta, null);
  assert.equal(diff.portfolio.cost_usd.before, null);
  assert.equal(diff.portfolio.cost_usd.after, 0.25);
  assert.equal(diff.portfolio.cost_usd.delta, null);

  // Модель: оба значения есть → честная дельта
  const mDiff = diff.models[0];
  assert.equal(mDiff.runs.delta, 5);
  assert.equal(mDiff.provider_failures.delta, -2);
  assert.equal(mDiff.tokens.total.delta, 2500);
  assert.equal(mDiff.tokens.cached.delta, null); // cached был null
  assert.ok(Math.abs(mDiff.cost_usd.delta - 0.1) < 1e-9);

  const md = formatDiffMarkdown(diff);
  assert.match(md, /speedup: \+25\.0%/);
  assert.match(md, /N\/A -> \$0\.2500/);
});

test('writeSnapshot + history.jsonl append + CLI snapshot & diff integration', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'telemetry-collector-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const boardFile = join(dir, 'board.json');
  const threadsFile = join(dir, 'threads.json');
  const telemetryFile = join(dir, 'telemetry.jsonl');
  const outDir = join(dir, 'snapshots');

  await writeFile(boardFile, JSON.stringify([
    { id: '1', channel: 'core', title: 'Task One', status: 'done', wall_clock_ms: 20_000, rework_rounds: 1 },
  ]), 'utf8');
  await writeFile(threadsFile, JSON.stringify([
    { id: 'thr_a', project: 'core', task_id: '1', provider: 'google', model: 'gemini-4-neon', status: 'completed', usage: { input_tokens: 100, output_tokens: 50 } },
  ]), 'utf8');
  await writeFile(telemetryFile, '', 'utf8');

  // Первый прогон CLI snapshot (с --html)
  const r1 = await exec(process.execPath, [
    collectorCli, 'snapshot',
    '--out-dir', outDir,
    '--date', '2026-11-22',
    '--board-tasks', boardFile,
    '--bb-threads', threadsFile,
    '--telemetry', telemetryFile,
    '--html',
  ]);
  assert.match(r1.stdout, /snapshot-2026-11-22\.json/);

  // Обновляем входные данные для второго дня
  await writeFile(boardFile, JSON.stringify([
    { id: '1', channel: 'core', title: 'Task One', status: 'done', wall_clock_ms: 20_000, rework_rounds: 1 },
    { id: '2', channel: 'core', title: 'Task Two', status: 'done', wall_clock_ms: 10_000, rework_rounds: 0 },
  ]), 'utf8');

  const r2 = await exec(process.execPath, [
    collectorCli, 'snapshot',
    '--out-dir', outDir,
    '--date', '2026-11-23',
    '--board-tasks', boardFile,
    '--bb-threads', threadsFile,
    '--telemetry', telemetryFile,
  ]);
  assert.match(r2.stdout, /snapshot-2026-11-23\.json/);

  const history = await readHistory(join(outDir, 'history.jsonl'));
  assert.equal(history.length, 2);
  assert.equal(history[0].schema, HISTORY_SCHEMA);
  assert.equal(history[0].date, '2026-11-22');
  assert.equal(history[1].date, '2026-11-23');
  assert.equal(history[1].portfolio.total_tasks, 2);

  const mdText = await readFile(join(outDir, 'snapshot-2026-11-23.md'), 'utf8');
  assert.match(mdText, /# Telemetry Snapshot/);
  assert.match(mdText, /\| core \|/);

  // CLI diff
  const diffRes = await exec(process.execPath, [
    collectorCli, 'diff',
    join(outDir, 'snapshot-2026-11-22.json'),
    join(outDir, 'snapshot-2026-11-23.json'),
    '--json',
  ]);
  const parsedDiff = JSON.parse(diffRes.stdout);
  assert.equal(parsedDiff.portfolio.total_tasks.delta, 1);
  assert.equal(parsedDiff.portfolio.median_wall_clock_ms.speedup_pct, 0.25);

  // Проверка защиты от path traversal в date
  const latestSnap = JSON.parse(await readFile(join(outDir, 'snapshot-2026-11-23.json'), 'utf8'));
  await assert.rejects(
    () => writeSnapshot(latestSnap, { outDir, date: '../evil' }),
    /Invalid snapshot date/,
  );
});

test('renderTelemetryDashboardHtml: автономный single-file HTML без CDN и с XSS-экранированием', async () => {
  const xssPayload = '<script>alert("xss")</script><img src=x onerror=alert(1)>';
  const snapshot = await collectTelemetry({
    boardTasks: [
      { id: '999', channel: `chan-${xssPayload}`, title: `Title ${xssPayload}`, status: 'done', wall_clock_ms: 12_000, rework_rounds: 0 },
    ],
    bbThreads: [
      { id: 'thr_xss', project: `chan-${xssPayload}`, task_id: '999', provider: 'prov<x>', model: 'mod"y\'z', status: 'completed' },
    ],
    clock: () => Date.parse('2026-11-23T12:00:00.000Z'),
  });

  const history = [
    {
      schema: HISTORY_SCHEMA,
      date: '2026-11-22',
      generated_at: '2026-11-22T12:00:00.000Z',
      portfolio: { total_tasks: 1, closed_tasks: 0, open_tasks: 1, completion_rate: 0, median_wall_clock_ms: 20_000, first_round_pass_rate: 0, cost_usd: null },
    },
    {
      schema: HISTORY_SCHEMA,
      date: '2026-11-23',
      generated_at: '2026-11-23T12:00:00.000Z',
      portfolio: snapshot.portfolio,
    },
  ];

  const html = renderTelemetryDashboardHtml(history, snapshot);

  assert.match(html, /^<!DOCTYPE html>/);
  // Нет внешних CDN/скриптов/стилей
  assert.doesNotMatch(html, /https?:\/\//i);
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /<img src=x/i);
  // XSS-строка экранирована
  assert.ok(html.includes(escapeHtml(xssPayload)));
  assert.ok(html.includes('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'));
  // Присутствуют все 4 секции и SVG-график трендов
  assert.match(html, /<h2>Portfolio<\/h2>/);
  assert.match(html, /<h2>Trends \(history\.jsonl\)<\/h2>/);
  assert.match(html, /<h2>Projects \/ Channels<\/h2>/);
  assert.match(html, /<h2>Models \/ Providers<\/h2>/);
  assert.match(html, /<h2>Tasks<\/h2>/);
  assert.match(html, /<svg /);
  // Markdown snapshot helper smoke check
  assert.match(formatSnapshotMarkdown(snapshot), /## Portfolio/);
});

// ---------------------------------------------------------------------------
// Регрессионные тесты по итогам независимого ревью Pi/Sol (#1268).
// ---------------------------------------------------------------------------

test('ревью #1: createTelemetryRecorder сохраняет bb_thread_id и дедуплицируется с тем же BB-тредом', async t => {
  const journal = await mkdtemp(join(tmpdir(), 'telemetry-bb-dedupe-'));
  t.after(() => rm(journal, { recursive: true, force: true }));

  let now = 1000;
  const rec = createTelemetryRecorder({
    journal,
    clock: () => now,
    subject: { task_id: '1', attempt_id: 'a1', bb_thread_id: 'thr_a' },
    models: { worker: { provider: 'openai', model: 'gpt-6.2-sol' } },
  });
  await rec.phase('spawn', async () => { now = 2000; });
  rec.roundStart();
  rec.recordUsage('worker', { input_tokens: 100, output_tokens: 40 }, 'bb_thread');
  rec.recordRound({ outcome: 'verified' });
  const { record } = await rec.finish({ outcome: 'done', open: false });

  assert.equal(record.bb_thread_id, 'thr_a');

  const lines = (await readFile(join(journal, 'telemetry.jsonl'), 'utf8')).split('\n').filter(Boolean);
  const snapshot = await collectTelemetry({
    telemetryLines: lines,
    bbThreads: [
      {
        id: 'thr_a',
        projectId: 'pj_alpha',
        task_id: '1',
        provider: 'openai',
        model: 'gpt-6.2-sol',
        status: 'completed',
        usage: { input_tokens: 100, output_tokens: 40 },
      },
    ],
  });

  assert.equal(snapshot.models.length, 1);
  assert.equal(snapshot.models[0].runs, 1);
  assert.equal(snapshot.models[0].tokens.input, 100);
  assert.equal(snapshot.models[0].tokens.output, 40);
  assert.equal(snapshot.tasks[0].channel, 'pj_alpha');
});

test('ревью #2: дубликат строки BB-треда с одним id не удваивает total_bb_threads, runs, tokens и cost', async () => {
  const thread = {
    id: 'thr_dup',
    project: 'core',
    task_id: '55',
    provider: 'google',
    model: 'gemini-4-neon',
    status: 'completed',
    usage: { input_tokens: 100, output_tokens: 25 },
    cost_usd: 0.1,
  };

  const snapshot = await collectTelemetry({
    bbThreads: [thread, { ...thread }],
  });

  assert.equal(snapshot.sources.bb_threads, 1);
  assert.equal(snapshot.portfolio.total_bb_threads, 1);
  assert.equal(snapshot.models.length, 1);
  assert.equal(snapshot.models[0].runs, 1);
  assert.equal(snapshot.models[0].tokens.input, 100);
  assert.equal(snapshot.models[0].cost_usd, 0.1);
});

test('ревью #3: адаптер BB CLI со штатной формой {id, projectId, providerId, status} сохраняет projectId и не выдумывает модель/задачу', async () => {
  const cliThreads = await loadBbThreadsFromCli({
    execBb: async args => {
      assert.deepEqual(args, ['thread', 'list', '--json']);
      return {
        stdout: JSON.stringify([
          { id: 'thr_a', projectId: 'pj_a', providerId: 'pi', status: 'idle' },
        ]),
      };
    },
  });

  const snapshot = await collectTelemetry({ bbThreads: cliThreads });

  assert.equal(snapshot.portfolio.total_bb_threads, 1);
  assert.equal(snapshot.portfolio.total_tasks, 0);
  assert.deepEqual(snapshot.tasks, []);
  assert.deepEqual(snapshot.models, []);
  assert.equal(snapshot.channels.length, 1);
  assert.equal(snapshot.channels[0].channel, 'pj_a');
  assert.equal(snapshot.channels[0].bb_threads, 1);
});

test('ревью #4: повторная успешная попытка без Board (hold -> done) обновляет статус и закрывает задачу', async () => {
  const snapshot = await collectTelemetry({
    telemetryRuns: [
      {
        kind: 'attempt_summary',
        schema: TELEMETRY_SCHEMA,
        task_id: '77',
        attempt_id: 'att-1',
        phases_ms: { spawn: 500, total: 2000 },
        rounds: { total: 1, rework: 1, pass: 0, arbitration: 0, open: 0 },
        models: { worker: { provider: 'acp-devin', model: 'swe-2-high' }, critic: null, arbiter: null },
        tokens: { worker: null, critic: null, arbiter: null },
        outcome: 'hold',
        open: false,
      },
      {
        kind: 'attempt_summary',
        schema: TELEMETRY_SCHEMA,
        task_id: '77',
        attempt_id: 'att-2',
        phases_ms: { spawn: 500, total: 3000 },
        rounds: { total: 1, rework: 0, pass: 1, arbitration: 0, open: 0 },
        models: { worker: { provider: 'acp-devin', model: 'swe-2-high' }, critic: null, arbiter: null },
        tokens: { worker: null, critic: null, arbiter: null },
        outcome: 'done',
        open: false,
      },
    ],
  });

  assert.equal(snapshot.tasks.length, 1);
  assert.equal(snapshot.tasks[0].status, 'done');
  assert.equal(snapshot.tasks[0].closed, true);
  assert.equal(snapshot.portfolio.closed_tasks, 1);
  assert.equal(snapshot.portfolio.open_tasks, 0);
});

test('ревью #5: настроенный арбитр без recordArbitration() не даёт runs: 1, а вызванная роль без usage учитывается', async () => {
  let now = 1000;
  const rec = createTelemetryRecorder({
    clock: () => now,
    subject: { task_id: '88', attempt_id: 'att-88' },
    models: {
      worker: { provider: 'acp-devin', model: 'swe-2-high' },
      critic: { provider: 'google', model: 'gemini-4-neon' },
      arbiter: { provider: 'openai', model: 'gpt-6.2-sol' },
    },
  });
  await rec.phase('spawn', async () => { now = 1500; });
  rec.roundStart();
  // Критик реально вызван (фаза l2_critic измерена), но usage = null
  await rec.phase('l2_critic', async () => { now = 2500; });
  rec.recordRound({ outcome: 'verified' });
  // Арбитр НЕ вызывался (нет фазы arbiter и нет recordArbitration)
  const { record } = await rec.finish({ outcome: 'done', open: false });

  const snapshot = await collectTelemetry({
    telemetryRuns: [{ kind: 'attempt_summary', schema: TELEMETRY_SCHEMA, ...record }],
  });

  const modelIds = snapshot.models.map(m => m.model_id);
  assert.deepEqual(modelIds, ['acp-devin/swe-2-high', 'google/gemini-4-neon']);
  assert.equal(snapshot.models.find(m => m.model_id === 'openai/gpt-6.2-sol'), undefined);
  const critic = snapshot.models.find(m => m.model_id === 'google/gemini-4-neon');
  assert.equal(critic.runs, 1);
  assert.equal(critic.tokens, null);
});

test('ревью #6: неполный usage ({input: 100, output: null}) даёт строго null в total/delta/pct_change в diffSnapshots', () => {
  const snapA = {
    schema: COLLECTOR_SCHEMA,
    generated_at: '2026-11-22T00:00:00.000Z',
    portfolio: { tokens: { input: 100, output: null, cached: null } },
    channels: [],
    models: [],
  };
  const snapB = {
    schema: COLLECTOR_SCHEMA,
    generated_at: '2026-11-23T00:00:00.000Z',
    portfolio: { tokens: { input: 100, output: 50, cached: null } },
    channels: [],
    models: [],
  };

  const diff = diffSnapshots(snapA, snapB);
  assert.equal(diff.portfolio.tokens.total.before, null);
  assert.equal(diff.portfolio.tokens.total.after, 150);
  assert.equal(diff.portfolio.tokens.total.delta, null);
  assert.equal(diff.portfolio.tokens.total.pct_change, null);
});

test('ревью #7: writeSnapshot отклоняет historyFile с разделителями/traversal до записи артефактов', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'telemetry-hist-valid-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const outDir = join(dir, 'out');
  const snap = await collectTelemetry({ clock: () => Date.parse('2026-11-23T00:00:00.000Z') });

  for (const bad of ['nested/history.jsonl', '../x', '..\\x', '..', '.']) {
    await assert.rejects(
      () => writeSnapshot(snap, { outDir, date: '2026-11-23', historyFile: bad }),
      /Invalid historyFile/,
    );
  }
  // Ни один файл/каталог не был создан при отклонённых вызовах
  const entries = await readdir(dir);
  assert.deepEqual(entries, []);
});

test('ревью #8: повторный снимок за ту же дату не затирает предыдущий, а append в history.jsonl без \\n сохраняет обе строки', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'telemetry-collision-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const snap1 = await collectTelemetry({
    boardTasks: [{ id: '1', channel: 'core', status: 'ready' }],
    clock: () => Date.parse('2026-11-23T08:00:00.000Z'),
  });
  const snap2 = await collectTelemetry({
    boardTasks: [{ id: '1', channel: 'core', status: 'done' }],
    clock: () => Date.parse('2026-11-23T12:00:00.000Z'),
  });

  const w1 = await writeSnapshot(snap1, { outDir: dir, date: '2026-11-23' });
  // Симулируем history.jsonl без завершающего \n
  const rawHist = await readFile(w1.historyPath, 'utf8');
  await writeFile(w1.historyPath, rawHist.replace(/\n+$/, ''), 'utf8');

  const w2 = await writeSnapshot(snap2, { outDir: dir, date: '2026-11-23' });

  // Файлы раздельные, первый снимок не затёрт
  assert.notEqual(w1.jsonPath, w2.jsonPath);
  assert.notEqual(w1.mdPath, w2.mdPath);
  assert.equal(w1.snapshotFile, 'snapshot-2026-11-23.json');
  assert.equal(w2.snapshotFile, 'snapshot-2026-11-23-2.json');

  const saved1 = JSON.parse(await readFile(w1.jsonPath, 'utf8'));
  const saved2 = JSON.parse(await readFile(w2.jsonPath, 'utf8'));
  assert.equal(saved1.portfolio.closed_tasks, 0);
  assert.equal(saved2.portfolio.closed_tasks, 1);

  // Обе записи валидно читаются из history.jsonl
  const history = await readHistory(w1.historyPath);
  assert.equal(history.length, 2);
  assert.equal(history[0].snapshot_file, 'snapshot-2026-11-23.json');
  assert.equal(history[1].snapshot_file, 'snapshot-2026-11-23-2.json');
});
