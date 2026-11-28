import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseArgs, ROLE_DEFAULT_TIMERS, runFleetSmoke } from './check-fleet.mjs';

const snapshotUrl = 'https://example.invalid/snapshot';
const snapshot = { boardStatus: { ok: true }, telemetry: { sources: { telemetry_runs: 1 } },
  fleetTelemetry: { hosts: [{ stale: false }, { stale: false }] } };
const snapshotReport = (changes, status = 200) => runFleetSmoke({ snapshotUrl, skipTimers: true,
  fetchImpl: (url, { method, signal }) => {
    assert.equal(url, snapshotUrl);
    assert.equal(method, 'GET');
    assert.ok(signal instanceof AbortSignal);
    return Response.json({ ...snapshot, ...changes }, { status });
  } });

for (const telemetry of [snapshot.telemetry, { sources: { telemetry_runs: 0 }, portfolio: { total_runs: 2 } },
  { attempts: [{}] }]) {
  test(`control_room accepts runs from ${Object.keys(telemetry).at(-1)}`, async () => {
    const { ok, checks } = await snapshotReport({ telemetry });
    assert.equal(ok, true);
    assert.deepEqual(checks.map(c => [c.name, c.ok]), [['control_room', true]]);
  });
}

for (const [name, changes, detail] of [
  ['null telemetry', { telemetry: null }, /no telemetry runs/],
  ['zero runs', { telemetry: { sources: { telemetry_runs: 0 }, attempts: [] } }, /no telemetry runs/],
  ['stale host', { fleetTelemetry: { hosts: [{ stale: false }, { stale: true }] } }, /stale/],
  ['empty fleet', { fleetTelemetry: { hosts: [] } }, /no fleet hosts/],
  ['missing hosts', { fleetTelemetry: {} }, /no fleet hosts/],
  ['blind Board', { boardStatus: { ok: false } }, /Board not OK/],
  ['HTTP error', {}, /HTTP 503/],
]) {
  test(`control_room fails for ${name}`, async () => {
    const { ok, checks: [c] } = await snapshotReport(changes, name === 'HTTP error' ? 503 : 200);
    assert.equal(ok, false);
    assert.equal(c.ok, false);
    assert.match(c.detail, detail);
  });
}

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'df-check-fleet-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function seed(path, sql) {
  const db = new DatabaseSync(path);
  try { db.exec(sql); } finally { db.close(); }
}

test('archive needs both tables populated; ledger counts only active decisions', async t => {
  const dir = tempDir(t);
  const archiveDb = join(dir, 'archive.db');
  const ledgerDb = join(dir, 'ledger.db');
  seed(archiveDb, 'CREATE TABLE sessions(id); CREATE TABLE messages(id)');
  seed(ledgerDb, "CREATE TABLE decisions(status); INSERT INTO decisions VALUES ('retired')");
  async function verify(archive, ledger) {
    const report = await runFleetSmoke({ archiveDb, ledgerDb, skipTimers: true });
    assert.equal(report.ok, archive && ledger);
    assert.deepEqual(report.checks.map(c => [c.name, c.ok]), [['session_archive', archive], ['unified_ledger', ledger]]);
  }
  await verify(false, false);
  seed(archiveDb, 'INSERT INTO sessions VALUES (1)');
  seed(ledgerDb, "INSERT INTO decisions VALUES ('active')");
  await verify(false, true);
  seed(archiveDb, 'INSERT INTO messages VALUES (1)');
  await verify(true, true);
  seed(archiveDb, 'DELETE FROM sessions');
  await verify(false, true);
});

test('store checks reject missing files without creating them, directories, and symlinks to valid stores', async t => {
  const dir = tempDir(t);
  const missing = join(dir, 'missing');
  const valid = join(dir, 'valid.db');
  seed(valid, `CREATE TABLE sessions AS SELECT 1; CREATE TABLE messages AS SELECT 1;
    CREATE TABLE decisions AS SELECT 'active' AS status`);
  const link = join(dir, 'link');
  symlinkSync(valid, link);
  for (const path of [missing, dir, link]) {
    const report = await runFleetSmoke({ archiveDb: path, ledgerDb: path, skipTimers: true });
    assert.equal(report.ok, false);
    assert.deepEqual(report.checks.map(c => c.ok), [false, false]);
  }
  assert.equal(existsSync(missing), false);
});

const common = ['df-auto-update.timer', 'resource-steward.timer', 'df-fleet-telemetry.timer'];
for (const [role, expected] of Object.entries({ hub: [...common, 'df-archive.timer'],
  brain: [...common, 'df-telemetry-pull.timer'], worker: [...common, 'df-telemetry-sync.timer', 'df-sentinel.timer'] })) {
  test(`systemd_timers checks each default ${role} timer`, async () => {
    assert.ok(Object.isFrozen(ROLE_DEFAULT_TIMERS) && Object.isFrozen(ROLE_DEFAULT_TIMERS[role]));
    const calls = [];
    const report = await runFleetSmoke({ role, execImpl: (cmd, args) => { calls.push([cmd, ...args]); return 'active\n'; } });
    assert.deepEqual(calls, expected.map(name => ['systemctl', '--user', 'is-active', name]));
    assert.equal(report.ok, true);
    assert.equal(report.role, role);
    assert.deepEqual(report.checks.map(c => [c.name, c.ok]), [['systemd_timers', true]]);
    assert.equal(new Date(report.checkedAt).toISOString(), report.checkedAt);
  });
}

test('systemd_timers reports all inactive and missing overrides', async () => {
  const timers = ['off.timer', 'absent.timer', 'ok.timer'];
  const report = await runFleetSmoke({ timers, execImpl: (_, args) => {
    if (args[2] === 'absent.timer') throw new Error('unit missing');
    return args[2] === 'ok.timer' ? 'active' : 'inactive';
  } });
  assert.equal(report.ok, false);
  const [check] = report.checks;
  assert.equal(check.ok, false);
  assert.match(check.detail, /off\.timer: inactive/);
  assert.match(check.detail, /absent\.timer/);
  assert.doesNotMatch(check.detail, /ok\.timer/);
});

test('parses supported flags and omits skipped checks', async () => {
  assert.equal(parseArgs([]).role, 'hub');
  const opts = parseArgs(['--role', 'brain', '--snapshot-url', snapshotUrl, '--archive-db', 'a', '--ledger-db', 'b',
    '--timers', 'a.timer, b.timer', '--json', '--skip-timers']);
  assert.deepEqual(opts, { role: 'brain', snapshotUrl, archiveDb: 'a', ledgerDb: 'b',
    timers: ['a.timer', 'b.timer'], json: true, skipTimers: true });
  const report = await runFleetSmoke({ ...parseArgs(['--skip-timers']), execImpl: assert.fail });
  assert.deepEqual(report.checks, []);
  assert.equal(report.ok, true);
});

test('rejects unknown flags, invalid roles and missing values as usage errors', () => {
  for (const argv of [['--bad'], ['--role', 'constructor'], ['--role', 'unknown'], ['--snapshot-url'],
    ['--archive-db', '--json'], ['--timers', 'good.timer,--version']]) {
    assert.throws(() => parseArgs(argv), { code: 'check_fleet_usage' });
  }
});

test('CLI distinguishes success, failed checks, and bad usage', t => {
  const cli = fileURLToPath(new URL('./check-fleet.mjs', import.meta.url));
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
  const success = run('--skip-timers', '--json');
  assert.equal(success.status, 0);
  assert.equal(JSON.parse(success.stdout).ok, true);
  const failed = run('--skip-timers', '--archive-db', join(tempDir(t), 'absent.db'));
  assert.equal(failed.status, 1);
  assert.match(failed.stdout, /FAIL session_archive/);
  const invalid = run('--unknown');
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /unknown argument/);
});
