// Deterministic unit tests for the versioned Herdr ops helpers (WAVE2-6).
// No wall-clock dependence: every parser call pins nowMs explicitly. Deploy
// tests run inside fresh mkdtemp sandboxes; the only wall-clock-derived
// value (deployedAt) is asserted by shape, never by exact value.

import assert from 'node:assert/strict';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  mapSlotsToSessions,
  normalizeCwd,
  parseAgyQuotaResponse,
  parseOpenCodeQuotaResponse,
} from './telemetry-parsers.mjs';
import { MANIFEST_NAME, applyDeploy, main as deployMain, planDeploy } from './deploy-herdr.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const NOW = Date.parse('2026-11-26T20:00:00.000Z');
const HAS_PYTHON3 = spawnSync('python3', ['--version'], { stdio: 'ignore' }).status === 0;

function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

const execFileAsync = promisify(execFile);

async function runFile(command, args, options = {}) {
  try {
    const result = await execFileAsync(command, args, options);
    return { code: 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  } catch (error) {
    return {
      code: typeof error.code === 'number' ? error.code : 1,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
    };
  }
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

test('quota parsers treat numeric values below 1e12 as epoch seconds, not milliseconds', () => {
  // 999,999,999 epoch seconds is 999,999,999,000 ms: one second after the
  // pinned nowMs. If it were misread as milliseconds it would be a 1970-era
  // already-expired reset instead.
  const nowMs = 999_999_998_000;
  const epochSeconds = 999_999_999;
  const agy = parseAgyQuotaResponse({
    groups: [{ buckets: [{ window: '5h', remainingFraction: 0.5, resetTime: epochSeconds }] }],
  }, nowMs);
  assert.equal(agy.windows[0].resetIn, 1000);

  const opencode = parseOpenCodeQuotaResponse({
    rollingUsage: { usagePercent: 10, resetTime: epochSeconds },
  }, nowMs);
  assert.equal(opencode.windows[0].resetIn, 1000);

  // The exact 1e12 boundary is already epoch milliseconds. Multiplying it by
  // 1000 would push the reset far into the future instead of one second out.
  const boundary = parseOpenCodeQuotaResponse({
    usage: { rolling: { percent: 10, resetsAt: 1e12 } },
  }, 999_999_999_000);
  assert.equal(boundary.windows[0].resetIn, 1000);
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

test('df-watch-task.sh validates --lines and --interval as positive integers', async () => {
  const script = join(HERE, 'df-watch-task.sh');
  for (const args of [
    ['--lines', '0'],
    ['--lines', '000'],
    ['--lines', '-1'],
    ['--lines', '1.5'],
    ['--lines', 'x'],
    ['--interval', '0'],
    ['--interval', '000'],
    ['--interval', '-1'],
    ['--interval', 'x'],
  ]) {
    const result = await runFile(script, args, { timeout: 5000 });
    assert.equal(result.code, 2, `${args.join(' ')} should be a usage error`);
    assert.match(result.stderr, /positive integer >= 1/);
  }

  // Leading zeroes still denote positive decimal integers, and validation is
  // regex-based so very large values cannot wrap negative in shell arithmetic.
  const emptyRoot = join(await mkdtemp(join(tmpdir(), 'df-watch-empty-')), 'state');
  for (const args of [
    ['--lines', '0001'],
    ['--lines', '999999999999999999999999999'],
    ['--interval', '0001'],
    ['--interval', '999999999999999999999999999'],
  ]) {
    const result = await runFile(script, [
      '--state-root', emptyRoot, '--once', ...args,
    ], { timeout: 5000 });
    assert.equal(result.code, 0, `${args.join(' ')} should be accepted: ${result.stderr}`);
  }
});

test('df-watch-task.sh passes -- and a whitelisted thread id to hc and strips control sequences', async () => {
  const root = await mkdtemp(join(tmpdir(), 'df-watch-stream-'));
  const stateRoot = join(root, 'state');
  const attemptDir = join(stateRoot, 'daemon-state-slot2');
  const bin = join(HERE, 'test-fixtures');
  const capture = join(root, 'hc-args.txt');
  await mkdir(attemptDir, { recursive: true });
  await writeFile(join(attemptDir, 'attempt.json'), JSON.stringify({
    task_id: '10366',
    phase: 'implement',
    thread_id: 'df-10366-3482f80c09',
  }));

  const result = await runFile(join(HERE, 'df-watch-task.sh'), [
    '--state-root', stateRoot,
    '--slot', '2',
    '--lines', '10',
    '--once',
  ], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, HC_CAPTURE: capture },
    timeout: 5000,
  });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual((await readFile(capture, 'utf8')).trimEnd().split('\n'), [
    'read', '--', 'df-10366-3482f80c09',
  ]);
  assert.equal(result.stdout.includes('\u001b'), false);
  assert.equal(result.stdout.includes('evil-title'), false);
  assert.match(result.stdout, /plainRED/);
  assert.match(result.stdout, /after-osc/);
  assert.match(result.stdout, /link-text/);
  assert.match(result.stdout, /csiUNDER/);
  assert.equal(result.stdout.includes('[4:3m'), false);
});

test('df-watch-task.sh refuses a thread id outside the whitelist before invoking hc', async () => {
  const root = await mkdtemp(join(tmpdir(), 'df-watch-invalid-'));
  const stateRoot = join(root, 'state');
  const attemptDir = join(stateRoot, 'daemon-state-slot1');
  const bin = join(HERE, 'test-fixtures');
  const capture = join(root, 'hc-args.txt');
  await mkdir(attemptDir, { recursive: true });
  await writeFile(join(attemptDir, 'attempt.json'), JSON.stringify({
    task_id: '10366',
    thread_id: 'df-10366;injected',
  }));

  const result = await runFile(join(HERE, 'df-watch-task.sh'), [
    '--state-root', stateRoot,
    '--slot', '1',
    '--once',
  ], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, HC_CAPTURE: capture },
    timeout: 5000,
  });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /invalid thread id/);
  assert.equal(result.stdout.includes('unexpected'), false);
  await assert.rejects(stat(capture), { code: 'ENOENT' });
});

test('df-watch-task.sh slot matching uses only -s<N> or slot-?<N> suffixes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'df-watch-slots-'));
  const stateRoot = join(root, 'state');
  const writeAttempt = async (dirName, taskId, mtime) => {
    const dir = join(stateRoot, dirName);
    await mkdir(dir, { recursive: true });
    const file = join(dir, 'attempt.json');
    await writeFile(file, JSON.stringify({ task_id: taskId, phase: 'implement' }));
    await utimes(file, mtime, mtime);
  };
  await writeAttempt('daemon-state-slot2', 'valid-slot2', new Date('2024-01-01T00:00:00Z'));
  // The first digit in this middle-of-name date is 2. It must not steer the
  // directory into slot 2 even when its attempt snapshot is newer.
  await writeAttempt('daemon-state-2026', 'middle-digit-not-slot2', new Date('2025-01-01T00:00:00Z'));
  await writeAttempt('daemon-state-s3', 'valid-s3', new Date('2024-01-01T00:00:00Z'));
  const validLog = join(stateRoot, 'daemon-slot2.log');
  await writeFile(validLog, 'valid-slot2-log\n');
  await utimes(validLog, new Date('2024-01-01T00:00:00Z'), new Date('2024-01-01T00:00:00Z'));
  const middleLog = join(stateRoot, 'daemon-2026.log');
  await writeFile(middleLog, 'middle-digit-log\n');
  await utimes(middleLog, new Date('2025-01-01T00:00:00Z'), new Date('2025-01-01T00:00:00Z'));

  const script = join(HERE, 'df-watch-task.sh');
  const slot2 = await runFile(script, [
    '--state-root', stateRoot, '--slot', '2', '--once', '--no-stream',
  ], { timeout: 5000 });
  assert.equal(slot2.code, 0, slot2.stderr);
  assert.match(slot2.stdout, /valid-slot2/);
  assert.equal(slot2.stdout.includes('middle-digit-not-slot2'), false);
  assert.match(slot2.stdout, /valid-slot2-log/);
  assert.equal(slot2.stdout.includes('middle-digit-log'), false);

  const slot3 = await runFile(script, [
    '--state-root', stateRoot, '--slot', '3', '--once', '--no-stream',
  ], { timeout: 5000 });
  assert.equal(slot3.code, 0, slot3.stderr);
  assert.match(slot3.stdout, /valid-s3/);
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

test('applyDeploy refuses a symlinked target directory', async () => {
  const { root, repo } = await makeSandbox();
  await writeFile(join(repo, 'helper.mjs'), VALID_MJS);
  const realTarget = join(root, 'real-target');
  const linkedTarget = join(root, 'linked-target');
  await mkdir(realTarget, { recursive: true });
  await symlink(realTarget, linkedTarget);

  const plan = await planDeploy({
    repoRoot: repo, targetDir: linkedTarget, sha: 'abc1234', files: ['helper.mjs'],
  });
  await assert.rejects(applyDeploy(plan, { dryRun: false }), /target_dir_not_directory/);
  await assert.rejects(stat(join(realTarget, 'helper.mjs')), { code: 'ENOENT' });
});

test('applyDeploy refuses a symlinked concrete backup parent directory', async () => {
  const { root, repo, target } = await makeSandbox();
  await mkdir(target, { recursive: true });
  await writeFile(join(repo, 'helper.mjs'), VALID_MJS);
  const realOutside = join(root, 'outside-parent');
  const linkedParent = join(root, 'linked-parent');
  await mkdir(realOutside, { recursive: true });
  await symlink(realOutside, linkedParent);

  const plan = await planDeploy({
    repoRoot: repo, targetDir: target, sha: 'abc1234', files: ['helper.mjs'],
  });
  const malformedPlan = {
    ...plan,
    files: [{ ...plan.files[0], backup: join(linkedParent, 'helper.mjs.bak') }],
  };
  await assert.rejects(applyDeploy(malformedPlan, { dryRun: false }), /target_dir_not_directory/);
  await assert.rejects(stat(join(target, 'helper.mjs')), { code: 'ENOENT' });
});

test('applyDeploy refuses symlinked target and backup paths without following them', async () => {
  const { root, repo, target } = await makeSandbox();
  await mkdir(target, { recursive: true });
  await writeFile(join(repo, 'helper.mjs'), VALID_MJS);
  const victim = join(root, 'victim.txt');
  await writeFile(victim, 'victim-original\n');
  await symlink(victim, join(target, 'helper.mjs'));

  const plan = await planDeploy({
    repoRoot: repo, targetDir: target, sha: 'abc1234', files: ['helper.mjs'],
  });
  await assert.rejects(applyDeploy(plan, { dryRun: false }), /target_is_symlink/);
  assert.equal(await readFile(victim, 'utf8'), 'victim-original\n');

  // A planted .bak symlink is likewise fatal before any backup copy starts.
  await rm(join(target, 'helper.mjs'));
  await writeFile(join(target, 'helper.mjs'), 'legacy target\n');
  const backupLink = join(target, 'helper.mjs.bak');
  await symlink(victim, backupLink);
  await assert.rejects(applyDeploy(plan, { dryRun: false }), /backup_is_symlink/);
  assert.equal(await readFile(victim, 'utf8'), 'victim-original\n');
  assert.equal(await readFile(join(target, 'helper.mjs'), 'utf8'), 'legacy target\n');
});

test('applyDeploy does not write through a preplanted predictable temp-file symlink', async () => {
  const { root, repo, target } = await makeSandbox();
  await mkdir(target, { recursive: true });
  await writeFile(join(repo, 'helper.mjs'), VALID_MJS);
  const victim = join(root, 'tmp-victim.txt');
  await writeFile(victim, 'victim-original\n');
  const predictableTmp = `${join(target, 'helper.mjs')}.tmp-${process.pid}`;
  await symlink(victim, predictableTmp);

  const plan = await planDeploy({
    repoRoot: repo, targetDir: target, sha: 'abc1234', files: ['helper.mjs'],
  });
  const result = await applyDeploy(plan, { dryRun: false });
  assert.equal(result.actions[0].action, 'copied');
  assert.equal(await readFile(victim, 'utf8'), 'victim-original\n');
  assert.equal(await readFile(join(target, 'helper.mjs'), 'utf8'), VALID_MJS);
});

test('applyDeploy never clobbers an existing backup file', async () => {
  const { repo, target } = await makeSandbox();
  await mkdir(target, { recursive: true });
  await writeFile(join(repo, 'helper.mjs'), VALID_MJS);
  await writeFile(join(target, 'helper.mjs'), 'deployed-before\n');
  await writeFile(join(target, 'helper.mjs.bak'), 'original-backup\n');

  const plan = await planDeploy({
    repoRoot: repo, targetDir: target, sha: 'abc1234', files: ['helper.mjs'],
  });
  const result = await applyDeploy(plan, { dryRun: false });
  assert.equal(result.actions[0].action, 'copied');
  assert.equal(result.actions[0].backup, false);
  assert.equal(await readFile(join(target, 'helper.mjs.bak'), 'utf8'), 'original-backup\n');
  assert.equal(await readFile(join(target, 'helper.mjs'), 'utf8'), VALID_MJS);
  assert.equal((await readdir(target)).filter(name => name.includes('.tmp-')).length, 0);
});

test('planDeploy verifies sha against git HEAD unless skipGitVerify is set', async (t) => {
  const { root, repo, target } = await makeSandbox();
  await writeFile(join(repo, 'helper.mjs'), VALID_MJS);
  await mkdir(join(repo, '.git'));
  const head = '1'.repeat(40);
  const fixtureBin = join(HERE, 'test-fixtures');
  const gitArgs = join(root, 'git-args.txt');
  const originalPath = process.env.PATH;
  const originalGitArgs = process.env.HERDR_TEST_GIT_ARGS;
  process.env.PATH = `${fixtureBin}:${originalPath ?? ''}`;
  process.env.HERDR_TEST_GIT_ARGS = gitArgs;
  t.after(() => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalGitArgs === undefined) delete process.env.HERDR_TEST_GIT_ARGS;
    else process.env.HERDR_TEST_GIT_ARGS = originalGitArgs;
  });

  const verified = await planDeploy({
    repoRoot: repo, targetDir: target, sha: head, files: ['helper.mjs'],
  });
  assert.equal(verified.sha, head);
  assert.deepEqual((await readFile(gitArgs, 'utf8')).trimEnd().split('\n'), [
    '-C', repo, 'rev-parse', 'HEAD',
  ]);

  await assert.rejects(planDeploy({
    repoRoot: repo, targetDir: target, sha: '0'.repeat(40), files: ['helper.mjs'],
  }), /git_sha_mismatch/);

  const invocationsBeforeSkip = (await readFile(gitArgs, 'utf8')).trimEnd().split('\n').length;
  const skipped = await planDeploy({
    repoRoot: repo,
    targetDir: target,
    sha: '0'.repeat(40),
    files: ['helper.mjs'],
    skipGitVerify: true,
  });
  assert.equal(skipped.sha, '0'.repeat(40));
  assert.equal((await readFile(gitArgs, 'utf8')).trimEnd().split('\n').length, invocationsBeforeSkip);

  let cliOut = '';
  let cliErr = '';
  const cliCode = await deployMain([
    '--repo-root', repo,
    '--target-dir', target,
    '--sha', '0'.repeat(40),
    '--files', 'helper.mjs',
    '--dry-run',
    '--skip-git-verify',
  ], {
    out: { write(chunk) { cliOut += chunk; } },
    err: { write(chunk) { cliErr += chunk; } },
  });
  assert.equal(cliCode, 0, cliErr);
  assert.match(cliOut, /dry-run/);
  assert.equal((await readFile(gitArgs, 'utf8')).trimEnd().split('\n').length, invocationsBeforeSkip);
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

// --- gitmark.py regression coverage ------------------------------------------

const GITMARK = join(HERE, '../memory-index/gitmark.py');

function runGitmark(args, options = {}) {
  return runFile('python3', [GITMARK, ...args], options);
}

function gitmarkRegression(contractMarks, body) {
  return async () => {
    if (HAS_PYTHON3) {
      await body();
    } else {
      const source = await readFile(GITMARK, 'utf8');
      for (const mark of contractMarks) assert.match(source, mark);
    }
  };
}

async function putGitmarkFile(root, relativePath, content) {
  const file = join(root, relativePath);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content);
}

async function writeGitmarkFixture(root) {
  await putGitmarkFile(root, 'memory/decisions.md',
    '# Owner Decisions\n\nOwner approved the controller design in phase review.\n');
  await putGitmarkFile(root, 'memory/notes.md',
    '# Notes\n\nВеха V2-3 добавляет шину событий и пульт управления.\n');
}

async function waitForFile(file, timeoutMs = 5000) {
  const started = Date.now();
  for (;;) {
    try {
      await stat(file);
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (Date.now() - started > timeoutMs) throw new Error(`timeout waiting for ${file}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test('gitmark reindex atomically replaces the database while an open reader keeps the old inode', gitmarkRegression([
  /db\.parent \/ f["']\{db\.name\}\.tmp\.\{os\.getpid\(\)\}["']/,
  /PRAGMA journal_mode=WAL/,
  /PRAGMA busy_timeout=5000/,
  /os\.replace\(tmp, db\)/,
], async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'gitmark-atomic-')));
  await writeGitmarkFixture(root);
  await putGitmarkFile(root, 'memory/replace-me.md', '# Replace\n\nalphaunique\n');
  const first = await runGitmark(['index', root, '--json']);
  assert.equal(first.code, 0, first.stderr);

  const db = join(root, '.gitmark', 'index.db');
  const ready = join(root, 'reader-ready');
  const release = join(root, 'reader-release');
  const rowsFile = join(root, 'reader-rows.json');
  const readerScript = `
import json, sqlite3, sys, time
from pathlib import Path
db, ready, release, out = sys.argv[1:5]
con = sqlite3.connect(db)
con.execute('select count(*) from chunks').fetchone()
Path(ready).write_text('ready')
deadline = time.time() + 10
while not Path(release).exists():
    if time.time() > deadline:
        sys.exit(3)
    time.sleep(0.01)
rows = [row[0] for row in con.execute('select text from chunks order by id')]
Path(out).write_text(json.dumps(rows))
con.close()
`;
  const reader = spawn('python3', ['-c', readerScript, db, ready, release, rowsFile], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let readerStdout = '';
  let readerStderr = '';
  reader.stdout.on('data', chunk => { readerStdout += chunk; });
  reader.stderr.on('data', chunk => { readerStderr += chunk; });
  const readerExit = new Promise((resolve, reject) => {
    reader.on('error', reject);
    reader.on('close', code => resolve({ code, stdout: readerStdout, stderr: readerStderr }));
  });

  await waitForFile(ready);
  await putGitmarkFile(root, 'memory/replace-me.md', '# Replace\n\nzzzzzzzzzz\n');
  const second = await runGitmark(['index', root, '--json']);
  assert.equal(second.code, 0, second.stderr);
  await writeFile(release, 'release\n');
  const readerResult = await readerExit;
  assert.equal(readerResult.code, 0, readerResult.stderr);

  // The already-open SQLite handle still reads the old inode. A DROP TABLE
  // rebuild would have mutated that same inode and alphaunique would vanish.
  const oldRows = JSON.parse(await readFile(rowsFile, 'utf8')).join('\n');
  assert.match(oldRows, /alphaunique/);
  assert.equal(oldRows.includes('zzzzzzzzzz'), false);

  // New readers open the replacement and see only the rebuilt content.
  const beta = await runGitmark(['search', root, 'zzzzzzzzzz', '--json']);
  assert.equal(beta.code, 0, beta.stderr);
  assert.equal(JSON.parse(beta.stdout).results[0].path, 'memory/replace-me.md');
  const alpha = await runGitmark(['search', root, 'alphaunique', '--json']);
  assert.equal(alpha.code, 0, alpha.stderr);
  assert.equal(JSON.parse(alpha.stdout).results.length, 0);

  const third = await runGitmark(['index', root, '--json']);
  assert.equal(third.code, 0, third.stderr);
  const indexDirEntries = await readdir(join(root, '.gitmark'));
  assert.deepEqual(indexDirEntries.filter(name => name !== 'index.db'), []);
}));

test('gitmark search catches a missing grams table cleanly', gitmarkRegression([
  /WHERE g\.gram IN \(\{marks\}\)[\s\S]*?except sqlite3\.OperationalError:/,
], async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'gitmark-no-grams-')));
  await writeGitmarkFixture(root);
  const indexed = await runGitmark(['index', root, '--json']);
  assert.equal(indexed.code, 0, indexed.stderr);
  const db = join(root, '.gitmark', 'index.db');
  await execFileAsync('python3', [
    '-c',
    'import sqlite3,sys; con=sqlite3.connect(sys.argv[1]); con.execute("DROP TABLE chunks_grams"); con.commit(); con.close()',
    db,
  ]);

  const result = await runGitmark(['search', root, 'controller design', '--json']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).results[0].path, 'memory/decisions.md');
}));

test('gitmark search accepts a query with more than 200 distinct 4-grams', gitmarkRegression([
  /qgrams = sorted\(grams4\(query\)\)\[:200\]/,
], async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'gitmark-qgrams-')));
  await writeGitmarkFixture(root);
  const indexed = await runGitmark(['index', root, '--json']);
  assert.equal(indexed.code, 0, indexed.stderr);

  const tokens = [];
  for (let i = 0; i < 240; i += 1) {
    tokens.push(
      String.fromCharCode(97 + Math.floor(i / 26)) +
      String.fromCharCode(97 + (i % 26)) +
      String.fromCharCode(97 + ((i * 7) % 26)) +
      String.fromCharCode(97 + ((i * 11) % 26)),
    );
  }
  const query = tokens.join(' ');
  const normalized = query.toLowerCase().replace(/\s+/g, ' ');
  const distinct = new Set();
  for (let i = 0; i < normalized.length - 3; i += 1) {
    distinct.add(normalized.slice(i, i + 4));
  }
  assert.ok(distinct.size > 200, `fixture should exceed the qgram cap, got ${distinct.size}`);

  const result = await runGitmark(['search', root, query, '--json']);
  assert.equal(result.code, 0, result.stderr);
  JSON.parse(result.stdout);
}));

test('gitmark cmd_search caps fuzzy qgram bindings at 200 and survives OperationalError', gitmarkRegression([
  /qgrams = sorted\(grams4\(query\)\)\[:200\]/,
  /WHERE g\.gram IN \(\{marks\}\)[\s\S]*?except sqlite3\.OperationalError:/,
], async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'gitmark-qcap-')));
  const db = join(root, 'index.db');
  await writeFile(db, '');

  const tokens = [];
  for (let i = 0; i < 240; i += 1) {
    tokens.push(
      String.fromCharCode(97 + Math.floor(i / 26)) +
      String.fromCharCode(97 + (i % 26)) +
      String.fromCharCode(97 + ((i * 7) % 26)) +
      String.fromCharCode(97 + ((i * 11) % 26)),
    );
  }
  const query = tokens.join(' ');
  const harness = `
import importlib.util, json, sys
from pathlib import Path
gitmark_path, root, db, query, raise_fuzz = sys.argv[1:6]
spec = importlib.util.spec_from_file_location('gitmark_module', gitmark_path)
gm = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gm)
operational_error = gm.sqlite3.OperationalError
class FakeConnection:
    def __init__(self):
        self.fuzz_bind_counts = []
    def execute(self, sql, params=()):
        if 'g.gram IN' in sql:
            self.fuzz_bind_counts.append(len(params))
            if raise_fuzz == '1':
                raise operational_error('boom')
        return iter(())
    def close(self):
        pass
fake = FakeConnection()
original_connect = gm.sqlite3.connect
gm.sqlite3.connect = lambda path: fake
try:
    code, payload = gm.cmd_search(Path(root), Path(db), query, 10, True)
finally:
    gm.sqlite3.connect = original_connect
print(json.dumps({'code': code, 'counts': fake.fuzz_bind_counts, 'payload': payload}))
`;

  for (const raiseFuzz of ['0', '1']) {
    const result = await execFileAsync('python3', [
      '-c', harness, GITMARK, root, db, query, raiseFuzz,
    ]);
    const observed = JSON.parse(result.stdout);
    assert.equal(observed.code, 0);
    assert.deepEqual(observed.counts, [200]);
    assert.deepEqual(observed.payload, { results: [] });
  }
}));

test('gitmark non-json search renders text and an empty query returns no hits', gitmarkRegression([
  /return 0, \{'text':/,
  /if args\.json or args\.cmd != "search":/,
], async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'gitmark-text-')));
  await writeGitmarkFixture(root);
  const indexed = await runGitmark(['index', root, '--json']);
  assert.equal(indexed.code, 0, indexed.stderr);

  const result = await runGitmark(['search', root, 'controller design']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim().startsWith('{'), false);
  assert.match(result.stdout, /memory\/decisions\.md:\d+  score=/);

  const empty = await runGitmark(['search', root, '']);
  assert.equal(empty.code, 0, empty.stderr);
  assert.match(empty.stdout, /no hits/);
}));

test('gitmark secrets scans exactly 2MiB regular files and skips larger or non-regular files', gitmarkRegression([
  /stat\.S_ISREG\(st\.st_mode\)/,
  /st\.st_size > 2 \* 1024 \* 1024/,
], async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'gitmark-secret-size-')));
  const secret = 'ghp' + '_' + 'abcdefghijklmnopqrstuvwxyz012345';
  const bigFile = join(root, 'big.txt');
  const exact = Buffer.alloc(2 * 1024 * 1024, 'a');
  Buffer.from(secret).copy(exact, 0);
  await writeFile(bigFile, exact);

  const exactHit = await runGitmark(['secrets', root, '--json'], { timeout: 5000 });
  assert.equal(exactHit.code, 1, exactHit.stderr);
  assert.equal(JSON.parse(exactHit.stdout).secrets[0].path, 'big.txt');

  const tooLarge = Buffer.alloc(2 * 1024 * 1024 + 1, 'a');
  Buffer.from(secret).copy(tooLarge, 0);
  await writeFile(bigFile, tooLarge);
  const skippedLarge = await runGitmark(['secrets', root, '--json'], { timeout: 5000 });
  assert.equal(skippedLarge.code, 0, skippedLarge.stderr);
  assert.equal(JSON.parse(skippedLarge.stdout).secrets.length, 0);

  await writeFile(bigFile, 'clean\n');
  const fifo = join(root, 'input.fifo');
  const mkfifo = await runFile('mkfifo', [fifo], { timeout: 5000 });
  assert.equal(mkfifo.code, 0, mkfifo.stderr);
  const skippedFifo = await runGitmark(['secrets', root, '--json'], { timeout: 5000 });
  assert.equal(skippedFifo.code, 0, skippedFifo.stderr);
  assert.equal(JSON.parse(skippedFifo.stdout).secrets.length, 0);
}));
