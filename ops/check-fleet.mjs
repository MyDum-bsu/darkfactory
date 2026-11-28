import { execFileSync } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

const commonTimers = ['df-auto-update.timer', 'resource-steward.timer', 'df-fleet-telemetry.timer'];
export const ROLE_DEFAULT_TIMERS = Object.freeze({
  hub: Object.freeze([...commonTimers, 'df-archive.timer']),
  brain: Object.freeze([...commonTimers, 'df-telemetry-pull.timer']),
  worker: Object.freeze([...commonTimers, 'df-telemetry-sync.timer', 'df-sentinel.timer']),
});

function usage(message) {
  throw Object.assign(new Error(message), { code: 'check_fleet_usage' });
}

function validateRole(role) {
  if (!Object.hasOwn(ROLE_DEFAULT_TIMERS, role)) usage(`invalid role: ${role}`);
}

function validateTimers(timers) {
  if (!timers.length || timers.some(timer => !timer || timer.startsWith('-'))) {
    usage('expected a comma-separated list of timer names');
  }
}

export function parseArgs(argv) {
  const options = { role: 'hub', skipTimers: false, json: false };
  const fields = { '--role': 'role', '--snapshot-url': 'snapshotUrl', '--archive-db': 'archiveDb',
    '--ledger-db': 'ledgerDb', '--timers': 'timers' };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--skip-timers') options.skipTimers = true;
    else if (flag === '--json') options.json = true;
    else {
      if (!Object.hasOwn(fields, flag)) usage(`unknown argument: ${flag}`);
      const value = argv[++i];
      if (!value || value.startsWith('--')) usage(`missing value for ${flag}`);
      if (flag === '--role') validateRole(value);
      if (flag === '--timers') {
        options.timers = value.split(',').map(timer => timer.trim());
        validateTimers(options.timers);
      } else options[fields[flag]] = value;
    }
  }
  return options;
}

async function checkSnapshot(url, fetchImpl) {
  const response = await fetchImpl(url, { method: 'GET', signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`snapshot HTTP ${response.status}`);
  const { boardStatus, telemetry, fleetTelemetry } = await response.json();
  const problems = [];
  if (boardStatus?.ok !== true) problems.push('Board not OK');
  if (!((telemetry?.sources?.telemetry_runs ?? 0) > 0 || (telemetry?.portfolio?.total_runs ?? 0) > 0 ||
    (telemetry?.attempts?.length ?? 0) > 0)) problems.push('no telemetry runs');
  const hosts = fleetTelemetry?.hosts;
  if (!Array.isArray(hosts) || !hosts.length) problems.push('no fleet hosts');
  else if (!hosts.every(h => h != null && h.stale !== true)) problems.push('stale or missing fleet host');
  if (problems.length) throw new Error(problems.join('; '));
  return `Board OK, telemetry present, ${hosts.length} fresh host(s)`;
}

function checkStore(path, query) {
  const absolute = resolve(path);
  if (!lstatSync(absolute).isFile()) throw new Error(`not a non-symlink regular file: ${path}`);
  const db = new DatabaseSync(absolute, { readOnly: true });
  try {
    const counts = db.prepare(query).get();
    const detail = Object.entries(counts).map(([name, n]) => `${name}=${n}`).join(', ');
    if (!Object.values(counts).every(n => n > 0)) throw new Error(detail);
    return detail;
  } finally {
    db.close();
  }
}

async function checkTimers(timers, execImpl) {
  const failures = [];
  for (const timer of timers) {
    try {
      const output = await execImpl('systemctl', ['--user', 'is-active', timer], {
        encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'],
      });
      const state = String(output.stdout ?? output).trim();
      if (state !== 'active') failures.push(`${timer}: ${state || 'unknown'}`);
    } catch (error) {
      const reason = String(error.stdout ?? '').trim() || error.code || 'systemctl failed';
      failures.push(`${timer}: ${reason}`);
    }
  }
  if (failures.length) throw new Error(failures.join('; '));
  return `${timers.length} active timer(s)`;
}

export async function runFleetSmoke({ role = 'hub', snapshotUrl, archiveDb, ledgerDb, timers,
  skipTimers = false, fetchImpl = fetch, execImpl = execFileSync } = {}) {
  validateRole(role);
  const checks = [];
  async function check(name, probe) {
    try {
      checks.push({ name, ok: true, detail: await probe() });
    } catch (error) {
      checks.push({ name, ok: false, detail: error.message ?? String(error) });
    }
  }
  if (snapshotUrl) await check('control_room', () => checkSnapshot(snapshotUrl, fetchImpl));
  if (archiveDb) await check('session_archive', () => checkStore(archiveDb,
    'SELECT (SELECT count(*) FROM sessions) AS sessions, (SELECT count(*) FROM messages) AS messages'));
  if (ledgerDb) await check('unified_ledger', () => checkStore(ledgerDb,
    "SELECT count(*) AS active FROM decisions WHERE status = 'active'"));
  if (skipTimers !== true) {
    const selected = timers ?? ROLE_DEFAULT_TIMERS[role];
    validateTimers(selected);
    await check('systemd_timers', () => checkTimers(selected, execImpl));
  }
  return { ok: checks.every(c => c.ok), role, checkedAt: new Date().toISOString(), checks };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const report = await runFleetSmoke(options);
    if (options.json) console.log(JSON.stringify(report));
    else {
      console.log(`${report.role}: ${report.ok ? 'OK' : 'FAIL'} (${report.checks.length} checks)`);
      for (const c of report.checks) console.log(`${c.ok ? 'OK' : 'FAIL'} ${c.name}: ${c.detail}`);
    }
    process.exitCode = report.ok ? 0 : 1;
  } catch (error) {
    console.error(`check-fleet: ${error.message}`);
    process.exitCode = error.code === 'check_fleet_usage' ? 2 : 1;
  }
}
