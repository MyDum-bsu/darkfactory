import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';

import { computeMedian, normalizeCost, sumCosts, TELEMETRY_SCHEMA } from './telemetry.mjs';
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
