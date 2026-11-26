// Deterministic unit tests for the versioned Herdr ops helpers (WAVE2-6).
// No wall-clock dependence: every parser call pins nowMs explicitly. Deploy
// tests run inside fresh mkdtemp sandboxes; the only wall-clock-derived
// value (deployedAt) is asserted by shape, never by exact value.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  mapSlotsToSessions,
  normalizeCwd,
  parseAgyQuotaResponse,
  parseOpenCodeQuotaResponse,
} from './telemetry-parsers.mjs';
import { MANIFEST_NAME, applyDeploy, planDeploy } from './deploy-herdr.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const NOW = Date.parse('2026-11-26T20:00:00.000Z');

function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

// --- parseAgyQuotaResponse ---------------------------------------------------

test('parseAgyQuotaResponse parses modern groups/buckets with resetTime', () => {
  const json = {
    groups: [
      {
        label: 'Gemini 3 Pro',
        buckets: [
          { window: '5h', remainingFraction: 0.42, resetTime: '2026-11-26T22:30:00.000Z' },
          { window: 'weekly', remainingFraction: 0.8, resetTime: '2026-11-30T00:00:00.000Z' },
        ],
      },
    ],
  };
  const result = parseAgyQuotaResponse(json, NOW);
  assert.equal(result.id, 'antigravity');
  assert.equal(result.label, 'Antigravity (Ultra)');
  assert.equal(result.status, 'ok');
  assert.equal(result.windows.length, 2);

  const fiveHour = result.windows[0];
  assert.equal(fiveHour.label, 'Gemini 3 Pro 5h');
  assert.equal(fiveHour.remPct, 42);
  assert.equal(fiveHour.usedPct, 58);
  assert.equal(fiveHour.usedPct + fiveHour.remPct, 100);
  // 2.5 hours until the pinned reset time.
  assert.equal(fiveHour.resetIn, 2.5 * 60 * 60 * 1000);

  const weekly = result.windows[1];
  assert.equal(weekly.label, 'Gemini 3 Pro Weekly');
  assert.equal(weekly.remPct, 80);
  assert.equal(weekly.usedPct, 20);
  assert.equal(weekly.resetIn, Date.parse('2026-11-30T00:00:00.000Z') - NOW);
});

test('parseAgyQuotaResponse never fabricates resetIn when resetTime is absent', () => {
  const json = {
    groups: [
      {
        label: 'Claude',
        buckets: [
          { window: '5h', remainingFraction: 0.5 },
          { window: 'weekly', remainingFraction: 0.25 },
        ],
      },
    ],
  };
  const result = parseAgyQuotaResponse(json, NOW);
  assert.equal(result.windows.length, 2);
  for (const window of result.windows) {
    assert.equal(window.resetIn, null);
  }
  assert.equal(result.windows[0].remPct, 50);
  assert.equal(result.windows[1].usedPct, 75);
});

test('parseAgyQuotaResponse parses legacy modelQuotaGroups/quotaWindows shape', () => {
  const json = {
    modelQuotaGroups: [
      {
        name: 'Gemini 2.5 Pro',
        quotaWindows: [
          { window: '5h', remainingFraction: 0.1, resetTime: '2026-11-26T21:00:00.000Z' },
          { window: 'weekly', remainingFraction: 0.66 },
        ],
      },
    ],
  };
  const result = parseAgyQuotaResponse(json, NOW);
  assert.equal(result.status, 'ok');
  assert.equal(result.windows.length, 2);
  assert.equal(result.windows[0].label, 'Gemini 2.5 Pro 5h');
  assert.equal(result.windows[0].remPct, 10);
  assert.equal(result.windows[0].resetIn, 60 * 60 * 1000);
  assert.equal(result.windows[1].label, 'Gemini 2.5 Pro Weekly');
  assert.equal(result.windows[1].remPct, 66);
  assert.equal(result.windows[1].resetIn, null);
});

test('parseAgyQuotaResponse clamps expired resets to zero and rejects unknown shapes', () => {
  const json = {
    groups: [
      { buckets: [{ window: '5h', remainingFraction: 1, resetTime: '2026-11-26T19:00:00.000Z' }] },
    ],
  };
  const result = parseAgyQuotaResponse(json, NOW);
  // Unlabeled group: plain window label, and a past reset never goes negative.
  assert.equal(result.windows[0].label, '5h');
  assert.equal(result.windows[0].resetIn, 0);

  assert.throws(() => parseAgyQuotaResponse({ somethingElse: true }, NOW), /agy_response_shape_unknown/);
  assert.throws(() => parseAgyQuotaResponse(null, NOW), /agy_response_invalid/);
  assert.throws(
    () => parseAgyQuotaResponse({ groups: [{ buckets: [{ window: '5h' }] }] }, NOW),
    /agy_fraction_missing/,
  );
});

// --- parseOpenCodeQuotaResponse ----------------------------------------------

test('parseOpenCodeQuotaResponse parses modern usage.{rolling,weekly,monthly}', () => {
  const json = {
    usage: {
      rolling: { percent: 33.4, resetsAt: '2026-11-26T23:00:00.000Z' },
      weekly: { percent: 61, resetsAt: '2026-11-28T00:00:00.000Z' },
      monthly: { percent: 12 },
    },
  };
  const result = parseOpenCodeQuotaResponse(json, NOW);
  assert.equal(result.id, 'opencode');
  assert.equal(result.label, 'OpenCode Go');
  assert.equal(result.status, 'ok');
  assert.equal(result.plan, 'Go');
  assert.equal(result.windows.length, 3);

  assert.deepEqual(result.windows.map(window => window.label), ['Rolling', 'Weekly', 'Monthly']);
  const [rolling, weekly, monthly] = result.windows;
  assert.equal(rolling.usedPct, 33);
  assert.equal(rolling.remPct, 67);
  assert.equal(rolling.resetIn, 3 * 60 * 60 * 1000);
  assert.equal(weekly.usedPct, 61);
  assert.equal(weekly.resetIn, Date.parse('2026-11-28T00:00:00.000Z') - NOW);
  // No resetsAt upstream: resetIn must stay null, never invented.
  assert.equal(monthly.resetIn, null);
  assert.equal(monthly.usedPct, 12);
  assert.equal(monthly.remPct, 88);
});

test('parseOpenCodeQuotaResponse parses legacy rollingUsage/weeklyUsage/monthlyUsage', () => {
  const json = {
    rollingUsage: { usagePercent: 70, resetInSec: 1800 },
    weeklyUsage: { usagePercent: 45.5, resetInSec: 86400 },
    monthlyUsage: { usagePercent: 5 },
  };
  const result = parseOpenCodeQuotaResponse(json, NOW);
  assert.equal(result.plan, 'Go');
  assert.equal(result.windows.length, 3);
  const [rolling, weekly, monthly] = result.windows;
  assert.equal(rolling.label, 'Rolling');
  assert.equal(rolling.usedPct, 70);
  assert.equal(rolling.remPct, 30);
  assert.equal(rolling.resetIn, 1800 * 1000);
  assert.equal(weekly.usedPct, 46);
  assert.equal(weekly.resetIn, 86400 * 1000);
  assert.equal(monthly.resetIn, null);

  // Partial payloads are valid: only the present windows are emitted.
  const partial = parseOpenCodeQuotaResponse({ rollingUsage: { usagePercent: 1 } }, NOW);
  assert.equal(partial.windows.length, 1);

  assert.throws(() => parseOpenCodeQuotaResponse({ nope: true }, NOW), /opencode_response_shape_unknown/);
  assert.throws(() => parseOpenCodeQuotaResponse('x', NOW), /opencode_response_invalid/);
});

// --- mapSlotsToSessions ------------------------------------------------------

test('mapSlotsToSessions matches sessions to four slots by normalized cwd', () => {
  const slots = [
    { slot: 'S1', cwd: '/home/o/df-slot-1/', taskId: '101', phase: 'implement' },
    { slot: 'S2', cwd: '/home/o/df-slot-2', taskId: '8282', phase: 'verify' },
    { slot: 'S3', cwd: '/home/o/df-slot-3', taskId: '103', phase: 'review' },
    { slot: 'S4', cwd: '/home/o/df-slot-4', taskId: null, phase: 'idle' },
  ];
  const sessions = [
    // Trailing-slash-free spelling must still match S1.
    { threadId: 'df-101-aaaa', cwd: '/home/o/df-slot-1', ctxPct: 41.6, tokPerSec: 12.34 },
    // Lexically redundant spelling must normalize onto S2; raw counters
    // derive ctxPct and tokPerSec when precomputed values are absent.
    { threadId: 'df-8282-ad09', cwd: '/home/o//df-slot-2/./', contextUsed: 81920, contextLimit: 200000, tokens: 5000, elapsedSec: 200 },
    { threadId: 'df-103-bbbb', cwd: '/home/o/df-slot-3/', tokensPerSecond: 30 },
    // Unmatched session: outside every slot worktree.
    { threadId: 'foreign', cwd: '/home/o/other-project' },
  ];
  const result = mapSlotsToSessions({ slots, sessions });

  assert.equal(result.sessions.length, 4);
  const [s1, s2, s3, foreign] = result.sessions;
  assert.equal(s1.slot, 'S1');
  assert.equal(s1.taskId, '101');
  assert.equal(s1.phase, 'implement');
  assert.equal(s1.threadId, 'df-101-aaaa');

  assert.equal(s2.slot, 'S2');
  assert.equal(s2.taskId, '8282');
  assert.equal(s2.phase, 'verify');

  assert.equal(s3.slot, 'S3');
  assert.equal(foreign.slot, null);
  assert.equal(foreign.taskId, null);
  assert.equal(foreign.phase, null);
  assert.equal(foreign.threadId, 'foreign');

  assert.equal(result.slots.length, 4);
  const [c1, c2, c3, c4] = result.slots;
  assert.deepEqual(Object.keys(c1).sort(), ['ctxPct', 'phase', 'slot', 'taskId', 'threadId', 'tokPerSec']);

  assert.equal(c1.slot, 'S1');
  assert.equal(c1.ctxPct, 42);
  assert.equal(c1.tokPerSec, 12.3);
  assert.equal(c1.threadId, 'df-101-aaaa');

  assert.equal(c2.slot, 'S2');
  assert.equal(c2.ctxPct, Math.round((81920 / 200000) * 100));
  assert.equal(c2.tokPerSec, 25);
  assert.equal(c2.threadId, 'df-8282-ad09');

  assert.equal(c3.slot, 'S3');
  assert.equal(c3.tokPerSec, 30);
  assert.equal(c3.ctxPct, null);

  // Idle slot without a live session: nulls, never fabricated numbers.
  assert.equal(c4.slot, 'S4');
  assert.equal(c4.ctxPct, null);
  assert.equal(c4.tokPerSec, null);
  assert.equal(c4.threadId, null);
});

test('normalizeCwd collapses duplicate slashes, dot segments and trailing slashes', () => {
  assert.equal(normalizeCwd('/home/o/df-slot-1/'), '/home/o/df-slot-1');
  assert.equal(normalizeCwd('/home/o//df-slot-1/./x/..'), '/home/o/df-slot-1');
  assert.equal(normalizeCwd('/'), '/');
  assert.equal(normalizeCwd(''), '');
  assert.equal(normalizeCwd(null), '');
});

// --- df-watch-task.sh --------------------------------------------------------

test('df-watch-task.sh is executable and free of legacy getbb/bb-thread references', async () => {
  const script = await readFile(join(HERE, 'df-watch-task.sh'), 'utf8');
  assert.equal(script.includes('getbb.app'), false);
  assert.equal(script.includes('getbb'), false);
  assert.equal(script.includes('bb thread'), false);
  // No bare `bb` token anywhere: the monitor must be fully BB-free.
  assert.equal(/\bbb\b/.test(script), false);
  // And it must genuinely stream through the hc runtime.
  assert.equal(script.includes('hc read'), true);

  const info = await stat(join(HERE, 'df-watch-task.sh'));
  assert.notEqual(info.mode & 0o111, 0);
});

// --- planDeploy / applyDeploy ------------------------------------------------

async function makeSandbox() {
  const root = await mkdtemp(join(tmpdir(), 'herdr-ops-test-'));
  const repo = join(root, 'repo');
  const target = join(root, 'target');
  await mkdir(repo, { recursive: true });
  return { root, repo: await realpath(repo), target };
}

const VALID_MJS = 'export const answer = 42;\n';
const VALID_SH = '#!/usr/bin/env bash\nprintf ok\n';

test('planDeploy validates sources and applyDeploy dry-run writes nothing', async () => {
  const { repo, target } = await makeSandbox();
  await writeFile(join(repo, 'helper.mjs'), VALID_MJS);

  const plan = await planDeploy({
    repoRoot: repo, targetDir: target, sha: 'abc1234', files: ['helper.mjs'],
  });
  assert.equal(plan.files.length, 1);
  assert.equal(plan.files[0].name, 'helper.mjs');
  assert.equal(plan.files[0].sha256, sha256Hex(Buffer.from(VALID_MJS)));

  const result = await applyDeploy(plan, { dryRun: true });
  assert.equal(result.dryRun, true);
  assert.deepEqual(result.actions.map(action => action.action), ['would-copy']);
  assert.equal(result.manifest.sha, 'abc1234');
  assert.deepEqual(result.manifest.files, [{ name: 'helper.mjs', sha256: sha256Hex(Buffer.from(VALID_MJS)) }]);
  // deployedAt exists and is an ISO timestamp; exact value is wall-clock and
  // intentionally not pinned.
  assert.match(result.manifest.deployedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

  // Dry-run default: applying without options must also write nothing.
  const defaulted = await applyDeploy(plan);
  assert.equal(defaulted.dryRun, true);
  await assert.rejects(stat(join(target, 'helper.mjs')), { code: 'ENOENT' });
  await assert.rejects(stat(join(target, MANIFEST_NAME)), { code: 'ENOENT' });
});

test('applyDeploy copies files, writes .bak backup and SHA-stamped manifest, idempotent on rerun', async () => {
  const { repo, target } = await makeSandbox();
  await mkdir(target, { recursive: true });
  await writeFile(join(repo, 'helper.mjs'), VALID_MJS);
  await writeFile(join(repo, 'watcher.sh'), VALID_SH, { mode: 0o755 });

  const sha = '061c73c192696984a9c0fba46df382cdf798537174c2f76e00f2f7a3c7acd0d2'.slice(0, 40);
  const plan = await planDeploy({
    repoRoot: repo, targetDir: target, sha, files: ['helper.mjs', 'watcher.sh'],
  });

  // First real deploy: no pre-existing targets, so no backups.
  const first = await applyDeploy(plan, { dryRun: false });
  assert.equal(first.dryRun, false);
  assert.deepEqual(first.actions.map(action => action.action), ['copied', 'copied']);
  assert.deepEqual(first.actions.map(action => action.backup), [false, false]);
  assert.equal((await readFile(join(target, 'helper.mjs'), 'utf8')), VALID_MJS);
  assert.equal((await readFile(join(target, 'watcher.sh'), 'utf8')), VALID_SH);
  // Executable permission bits survive deployment for shell helpers.
  assert.notEqual((await stat(join(target, 'watcher.sh'))).mode & 0o111, 0);
  await assert.rejects(stat(join(target, 'helper.mjs.bak')), { code: 'ENOENT' });

  const manifest = JSON.parse(await readFile(join(target, MANIFEST_NAME), 'utf8'));
  assert.equal(manifest.sha, sha);
  assert.equal(typeof manifest.deployedAt, 'string');
  assert.deepEqual(manifest.files, [
    { name: 'helper.mjs', sha256: sha256Hex(Buffer.from(VALID_MJS)) },
    { name: 'watcher.sh', sha256: sha256Hex(Buffer.from(VALID_SH)) },
  ]);

  // Idempotent rerun: identical content is skipped, no backup churn.
  const second = await applyDeploy(plan, { dryRun: false });
  assert.deepEqual(second.actions.map(action => action.action), ['unchanged', 'unchanged']);
  await assert.rejects(stat(join(target, 'helper.mjs.bak')), { code: 'ENOENT' });

  // Change the source: redeploy must back up the previous target first.
  const updated = 'export const answer = 43;\n';
  await writeFile(join(repo, 'helper.mjs'), updated);
  const plan2 = await planDeploy({
    repoRoot: repo, targetDir: target, sha, files: ['helper.mjs', 'watcher.sh'],
  });
  const third = await applyDeploy(plan2, { dryRun: false });
  assert.deepEqual(third.actions.map(action => action.action), ['copied', 'unchanged']);
  assert.equal(third.actions[0].backup, true);
  assert.equal((await readFile(join(target, 'helper.mjs.bak'), 'utf8')), VALID_MJS);
  assert.equal((await readFile(join(target, 'helper.mjs'), 'utf8')), updated);
  const manifest2 = JSON.parse(await readFile(join(target, MANIFEST_NAME), 'utf8'));
  assert.deepEqual(manifest2.files[0], { name: 'helper.mjs', sha256: sha256Hex(Buffer.from(updated)) });
});

test('planDeploy rejects traversal, missing files, empty scripts and broken ESM', async () => {
  const { repo, target } = await makeSandbox();
  await writeFile(join(repo, 'good.mjs'), VALID_MJS);
  await writeFile(join(repo, 'empty.sh'), '');
  await writeFile(join(repo, 'broken.mjs'), 'export const = ;\n');
  await writeFile(join(repo, 'secret-outside.mjs'), VALID_MJS);
  // A file outside the repo root that traversal would reach.
  await writeFile(join(dirname(repo), 'outside.mjs'), VALID_MJS);

  const base = { repoRoot: repo, targetDir: target, sha: 'abc1234' };
  await assert.rejects(planDeploy({ ...base, files: ['../outside.mjs'] }), /source_escapes_repo|source_missing/);
  await assert.rejects(planDeploy({ ...base, files: ['/etc/passwd'] }), /source_path_absolute/);
  await assert.rejects(planDeploy({ ...base, files: ['missing.mjs'] }), /source_missing/);
  await assert.rejects(planDeploy({ ...base, files: ['empty.sh'] }), /source_empty/);
  await assert.rejects(planDeploy({ ...base, files: ['broken.mjs'] }), /source_syntax_invalid/);
  await assert.rejects(planDeploy({ ...base, files: ['good.mjs', 'good.mjs'] }), /duplicate_file_name/);
  await assert.rejects(planDeploy({ ...base, files: [] }), /files_required/);
  await assert.rejects(planDeploy({ ...base, sha: 'not-a-sha', files: ['good.mjs'] }), /sha_invalid/);

  // Nested relative paths inside the repo are legitimate and deploy flat.
  await mkdir(join(repo, 'ops/herdr'), { recursive: true });
  await writeFile(join(repo, 'ops/herdr/nested.mjs'), VALID_MJS);
  const plan = await planDeploy({ ...base, files: ['ops/herdr/nested.mjs'] });
  assert.equal(plan.files[0].name, 'nested.mjs');
  assert.equal(plan.files[0].target, join(target, 'nested.mjs'));
});
