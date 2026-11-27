import { createReadStream } from 'node:fs';
import { lstat, open, readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadModelRegistry, registrySnapshot } from '../../board_pipeline/model-registry.mjs';
import { collectTelemetry } from '../../board_pipeline/telemetry-collector.mjs';
import { normalizeCost, normalizeUsage, parseTelemetryLines } from '../../board_pipeline/telemetry.mjs';
import { modelKey, normalizeDomain, normalizeSize, roleInvoked,
  SCORE_ROLES, SCORECARD_SCHEMA } from '../../board_pipeline/model-scorecard.mjs';
import { sanitizeTerminalText } from './origin-guard.mjs';
import { firstText, taskRepoId, textValue, timeValue } from './board-observer.mjs';

export const DEFAULT_TELEMETRY_DIR = join(
  process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'),
  'darkfactory', 'telemetry');
export const TELEMETRY_MAX_BYTES = 1024 * 1024;
export const TELEMETRY_MAX_FILES = 32;

const finiteNumber = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const firstNumber = (...values) => values.map(finiteNumber).find(value => value !== null) ?? null;

function copyUsage(raw) {
  const usage = normalizeUsage(raw);
  return usage ? { input: usage.input, output: usage.output, cached: usage.cached } : null;
}

function copyModel(raw) {
  if (typeof raw === 'string' && raw.trim()) {
    const value = sanitizeTerminalText(raw.trim());
    const slash = value.indexOf('/');
    return slash > 0 && slash < value.length - 1
      ? { provider: value.slice(0, slash), model: value.slice(slash + 1) }
      : { provider: null, model: value };
  }
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    const provider = textValue(raw.provider);
    const model = textValue(raw.model ?? raw.id ?? raw.model_id);
    if (provider || model) return { provider, model };
  }
  return { provider: null, model: null };
}

function compactTelemetryAttempt(entry) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const taskId = firstText(entry.task_id, entry.taskId, entry.id);
  if (!taskId) return null;
  const startedMs = timeValue(entry.started_at ?? entry.startedAt ?? entry.created_at ?? entry.createdAt);
  const endedMs = timeValue(entry.ended_at ?? entry.endedAt ?? entry.completed_at ?? entry.completedAt);
  const objectValue = value => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
  const rawPhases = objectValue(entry.phases_ms) ?? objectValue(entry.phasesMs) ?? {};
  const phaseFailures = {};
  const phasesMs = Object.fromEntries(Object.entries(rawPhases)
    .map(([key, value]) => {
      if (value === null) return [key, null];
      const elapsed = finiteNumber(value) ?? finiteNumber(value?.ms) ?? finiteNumber(value?.elapsedMs);
      if (elapsed === null) return null;
      const failureMarker = marker => marker === true ||
        (typeof marker === 'string' && /fail|error|hold|rework/i.test(marker)) ||
        (finiteNumber(marker) ?? 0) > 0;
      const failed = value !== null && typeof value === 'object' && !Array.isArray(value) &&
        (failureMarker(value.failed) || failureMarker(value.fail) || failureMarker(value.failures) ||
          failureMarker(value.status) || failureMarker(value.outcome));
      if (failed) phaseFailures[key] = true;
      return [key, Number(elapsed)];
    })
    .filter(Boolean));
  for (const source of [entry.phase_failures, entry.phaseFailures, entry.failed_phases, entry.failedPhases]) {
    if (Array.isArray(source)) {
      for (const key of source) if (typeof key === 'string') phaseFailures[key] = true;
    } else if (objectValue(source)) {
      for (const [key, value] of Object.entries(source)) {
        if (value === true || (typeof value === 'string' && /fail|error|hold|rework/i.test(value)) ||
            (finiteNumber(value) ?? 0) > 0) phaseFailures[key] = true;
      }
    }
  }
  const rawRounds = objectValue(entry.rounds);
  const rounds = rawRounds
    ? {
        total: finiteNumber(rawRounds.total),
        rework: finiteNumber(rawRounds.rework),
        pass: finiteNumber(rawRounds.pass),
        arbitration: finiteNumber(rawRounds.arbitration),
        open: finiteNumber(rawRounds.open),
        gates: objectValue(rawRounds.gates) ? { ...rawRounds.gates } : {},
      }
    : { total: null, rework: null, pass: null, arbitration: null, open: null, gates: {} };
  const reworkRounds = finiteNumber(rounds.rework) ?? firstNumber(entry.rework_rounds, entry.reworkRounds);
  if (rounds.rework === null) rounds.rework = reworkRounds;
  const roleCost = role => normalizeCost(entry.costs?.[role]);
  const roleCosts = [roleCost('worker'), roleCost('critic'), roleCost('arbiter')].filter(v => v !== null);
  const roleCostTotal = roleCosts.length ? roleCosts.reduce((a, b) => a + b, 0) : null;
  const labels = entry.labels !== null && typeof entry.labels === 'object' && !Array.isArray(entry.labels)
    ? entry.labels : {};
  return {
    taskId,
    attemptId: firstText(entry.attempt_id, entry.attemptId),
    epoch: Number.isSafeInteger(entry.epoch) ? entry.epoch : null,
    channel: firstText(entry.channel, entry.project, labels.channel),
    title: firstText(entry.title),
    repoId: firstText(entry.repo_id, entry.repoId, labels.repo_id, labels.project),
    outcome: firstText(entry.outcome),
    open: entry.open === true,
    startedAt: startedMs === null ? null : new Date(startedMs).toISOString(),
    endedAt: endedMs === null ? null : new Date(endedMs).toISOString(),
    elapsedMs: finiteNumber(phasesMs.total) ?? firstNumber(entry.elapsed_ms, entry.elapsedMs) ??
      (startedMs !== null && endedMs !== null && endedMs >= startedMs ? endedMs - startedMs : null),
    phasesMs,
    phaseFailures,
    rounds,
    reworkRounds,
    reason: firstText(entry.reason),
    models: {
      worker: copyModel(entry.models?.worker),
      critic: copyModel(entry.models?.critic),
      arbiter: copyModel(entry.models?.arbiter),
    },
    tokens: {
      worker: copyUsage(entry.tokens?.worker),
      critic: copyUsage(entry.tokens?.critic),
      arbiter: copyUsage(entry.tokens?.arbiter),
    },
    costUsd: normalizeCost(entry) ?? roleCostTotal,
    threadId: firstText(entry.thread_id, entry.bb_thread_id, entry.threadId, entry.bbThreadId),
  };
}

async function readTailText(path, maxBytes, size) {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0 || !Number.isFinite(size) || size <= 0) return '';
  const bytes = Math.floor(maxBytes);
  if (bytes <= 0) return '';
  const start = Math.max(0, size - bytes);
  const chunks = [];
  const stream = createReadStream(path, { start: start > 0 ? start - 1 : 0, end: size - 1 });
  for await (const chunk of stream) chunks.push(chunk);
  let buffer = Buffer.concat(chunks);
  if (start > 0) {
    const precededByNewline = buffer[0] === 10;
    buffer = buffer.subarray(1);
    let text = buffer.toString('utf8');
    if (!precededByNewline) {
      const firstBreak = /\r?\n/.exec(text);
      if (!firstBreak) return '';
      text = text.slice(firstBreak.index + firstBreak[0].length);
    }
    return text;
  }
  return buffer.toString('utf8');
}

// Entries-only analogue of aggregateScorecard(lines, { seed: [] }). Telemetry
// JSONL is parsed exactly once by createTelemetryProvider; collector,
// scorecard and compact attempts all share the same parsed entries instead of
// reparsing the same strings for every snapshot.
function telemetryFirstPassOf(entry) {
  return entry.open !== true && entry.outcome === 'done' && (entry.rounds?.rework ?? 0) === 0;
}

function telemetryIsClosed(entry) {
  return entry.open !== true;
}

function telemetryTokensPerRound(entry, role) {
  const usage = entry.tokens?.[role];
  const rounds = entry.rounds?.total;
  if (usage === null || typeof usage !== 'object' ||
      !Number.isFinite(rounds) || rounds < 1) return null;
  if (usage.input == null && usage.output == null) return null;
  const sum = (usage.input ?? 0) + (usage.output ?? 0);
  return Number.isFinite(sum) ? sum / rounds : null;
}

const emptyTelemetryScoreCell = () => ({
  n: 0, seed_n: 0,
  pass_n: 0, first_pass: 0,
  rounds_sum: 0, rounds_n: 0,
  wall_sum: 0, wall_n: 0,
  token_sum: 0, token_n: 0,
  catch_n: 0, caught: 0,
});

function addTelemetryScore(cell, { firstPass, rounds, wallMs, tokens, caught }) {
  cell.n += 1;
  if (firstPass !== null) { cell.pass_n += 1; if (firstPass) cell.first_pass += 1; }
  if (Number.isFinite(rounds)) { cell.rounds_sum += rounds; cell.rounds_n += 1; }
  if (Number.isFinite(wallMs)) { cell.wall_sum += wallMs; cell.wall_n += 1; }
  if (Number.isFinite(tokens)) { cell.token_sum += tokens; cell.token_n += 1; }
  if (caught !== null) { cell.catch_n += 1; if (caught) cell.caught += 1; }
}

function finalizeTelemetryScore(cell, meta) {
  const rate = (num, den) => den > 0 ? num / den : null;
  return {
    ...meta,
    observations: cell.n,
    seed_observations: cell.seed_n,
    measured: cell.n - cell.seed_n,
    first_pass_rate: rate(cell.first_pass, cell.pass_n),
    avg_rounds: rate(cell.rounds_sum, cell.rounds_n),
    avg_wall_ms: rate(cell.wall_sum, cell.wall_n),
    token_efficiency: rate(cell.token_sum, cell.token_n),
    defect_catch_rate: rate(cell.caught, cell.catch_n),
  };
}

function aggregateTelemetryScorecardEntries(entries, corrupt = 0) {
  const buckets = new Map();
  const report = { schema: SCORECARD_SCHEMA, corrupt, entries: 0, cells: {} };
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (entry?.kind !== 'attempt_summary') continue;
    report.entries += 1;
    const domain = normalizeDomain(entry?.labels?.domain ?? entry?.domain);
    const size = normalizeSize(entry?.labels?.size ?? entry?.size);
    const firstPass = telemetryFirstPassOf(entry);
    const rounds = Number.isFinite(entry.rounds?.total) ? entry.rounds.total : null;
    const wallMs = Number.isFinite(entry.phases_ms?.total) ? entry.phases_ms.total : null;
    for (const role of SCORE_ROLES) {
      const model = entry.models?.[role];
      const key = modelKey(model);
      if (key === null || !roleInvoked(entry, role)) continue;
      const phaseKey = role === 'critic' ? 'l2_critic' : role === 'arbiter' ? 'arbiter' : null;
      const roleWallMs = phaseKey !== null && Number.isFinite(entry.phases_ms?.[phaseKey])
        ? entry.phases_ms[phaseKey] : wallMs;
      const id = `${key}|${role}|${domain}|${size}`;
      const slot = buckets.get(id) ?? { cell: emptyTelemetryScoreCell(),
        meta: { model: { provider: model.provider, model: model.model }, role, domain, size } };
      addTelemetryScore(slot.cell, {
        firstPass: telemetryIsClosed(entry) ? firstPass : null,
        rounds,
        wallMs: roleWallMs,
        tokens: telemetryTokensPerRound(entry, role),
        caught: role === 'critic' ? (entry.rounds?.gates?.l2 ?? 0) > 0 : null,
      });
      buckets.set(id, slot);
    }
  }
  for (const [id, slot] of [...buckets.entries()].sort(([a], [b]) => a < b ? -1 : 1)) {
    report.cells[id] = finalizeTelemetryScore(slot.cell, slot.meta);
  }
  return report;
}

function boundedCacheSet(map, key, value, maxEntries) {
  map.delete(key);
  map.set(key, value);
  while (map.size > maxEntries) map.delete(map.keys().next().value);
}

// Safe read-only telemetry provider. It reads only regular telemetry*.jsonl
// files, caps both file count and per-file tail bytes, ignores corrupt JSONL
// rows, and returns null when no valid run record exists. Missing directories
// and filesystem races are observation gaps, never server failures.
// Parsed file tails are cached by path+mtime+size; unchanged rotated journals
// are not parsed again on every 5s poll.
export function createTelemetryProvider({
  telemetryDir,
  stateDirs = [],
  maxBytes = TELEMETRY_MAX_BYTES,
  maxFiles = TELEMETRY_MAX_FILES,
  now = () => Date.now(),
} = {}) {
  const fileCache = new Map();
  const resultCache = new Map();
  return async () => {
    try {
      const validDirectory = async dir => {
        if (typeof dir !== 'string' || !dir) return false;
        const dirStat = await lstat(dir).catch(() => null);
        return Boolean(dirStat?.isDirectory() && !dirStat.isSymbolicLink());
      };
      const explicitTelemetryDir = telemetryDir !== undefined;
      const primaryDir = telemetryDir ?? process.env.DF_TELEMETRY_DIR ?? DEFAULT_TELEMETRY_DIR;
      const directories = [];
      if (await validDirectory(primaryDir)) directories.push(primaryDir);
      // Без явного telemetryDir дефолт — только первый кандидат: stateDirs
      // остаются источниками даже если общий дефолт существует. Явно заданный
      // путь использует stateDirs только когда сам missing/invalid.
      if (!explicitTelemetryDir || !directories.length) {
        for (const dir of Array.isArray(stateDirs) ? stateDirs : []) {
          if (await validDirectory(dir) && !directories.includes(dir)) directories.push(dir);
        }
      }
      if (!directories.length) return null;

      const files = [];
      for (const dir of directories) {
        const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
          if (entry.isFile() && entry.name.startsWith('telemetry') && entry.name.endsWith('.jsonl')) {
            files.push({ dir, name: entry.name });
          }
        }
      }
      files.sort((a, b) => join(a.dir, a.name).localeCompare(join(b.dir, b.name)));
      const numericMaxFiles = Number(maxFiles);
      const fileLimit = Number.isFinite(numericMaxFiles)
        ? Math.max(0, Math.floor(numericMaxFiles)) : TELEMETRY_MAX_FILES;
      const selected = fileLimit ? files.slice(-fileLimit) : [];
      if (!selected.length) return null;

      const parsedFiles = [];
      let latestMtimeMs = 0;
      for (const file of selected) {
        const path = join(file.dir, file.name);
        const fileStat = await lstat(path).catch(() => null);
        if (!fileStat?.isFile() || fileStat.isSymbolicLink()) continue;
        latestMtimeMs = Math.max(latestMtimeMs, fileStat.mtimeMs);
        const signature = `${fileStat.mtimeMs}:${fileStat.size}`;
        let cached = fileCache.get(path);
        if (!cached || cached.signature !== signature) {
          const text = await readTailText(path, maxBytes, fileStat.size).catch(() => '');
          const lines = [];
          for (const line of text.split(/\r?\n/)) if (line.trim()) lines.push(line);
          const parsed = parseTelemetryLines(lines);
          cached = { signature, entries: parsed.entries, corrupt: parsed.corrupt,
            mtimeMs: fileStat.mtimeMs, size: fileStat.size };
        }
        boundedCacheSet(fileCache, path, cached, Math.max(fileLimit, 8));
        parsedFiles.push({ path, ...cached });
      }
      if (!parsedFiles.length) return null;

      const cacheKey = parsedFiles.map(file =>
        `${file.path}:${file.mtimeMs}:${file.size}`).join('\n');
      const cachedResult = resultCache.get(cacheKey);
      if (cachedResult !== undefined) return cachedResult;

      const entries = parsedFiles.flatMap(file => file.entries);
      const corrupt = parsedFiles.reduce((sum, file) => sum + file.corrupt, 0);
      const collected = await collectTelemetry({ telemetryRuns: entries, clock: now });
      if (!collected.sources.telemetry_runs) {
        boundedCacheSet(resultCache, cacheKey, null, 8);
        return null;
      }
      const scorecard = aggregateTelemetryScorecardEntries(entries, corrupt);
      const result = {
        runs: collected.sources.telemetry_runs,
        attempts: entries.map(compactTelemetryAttempt).filter(Boolean).slice(-128),
        firstRoundPassRate: collected.portfolio.first_round_pass_rate,
        avgReworkRounds: collected.portfolio.avg_rework_rounds,
        medianWallClockMs: collected.portfolio.median_wall_clock_ms,
        models: scorecard.cells,
        updatedAt: latestMtimeMs
          ? new Date(latestMtimeMs).toISOString()
          : collected.generated_at,
      };
      boundedCacheSet(resultCache, cacheKey, result, 8);
      return result;
    } catch {
      return null;
    }
  };
}

// --- fleet telemetry -----------------------------------------------------------

export const FLEET_STALE_MS = 900_000;
export const FLEET_MAX_FILE_BYTES = 64 * 1024;
const FLEET_NUMERIC_FIELDS = ['uptimeSec', 'cpuCores', 'load1m', 'memTotalMb',
  'memUsedMb', 'memPct', 'diskTotalGb', 'diskUsedGb', 'diskPct'];

const nowMilliseconds = now => {
  const value = typeof now === 'function' ? now() : now;
  if (value instanceof Date) return value.getTime();
  return timeValue(value) ?? Date.now();
};

const roundMetric = value => Number(value.toFixed(4));

// Normalize one collector record. Records with missing, non-finite, negative,
// or semantically impossible core fields are observation noise and are dropped
// by the caller; a partial host object must never become a confident metric.
export function normalizeFleetHost(raw, nowMs = Date.now()) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const host = textValue(raw.host);
  if (!host || typeof raw.ts !== 'string' || !raw.ts.trim()) return null;
  const tsMs = timeValue(raw.ts);
  if (tsMs === null) return null;
  const metrics = {};
  for (const field of FLEET_NUMERIC_FIELDS) {
    const value = finiteNumber(raw[field]);
    if (value === null || value < 0) return null;
    metrics[field] = value;
  }
  if (!Number.isSafeInteger(metrics.cpuCores) || metrics.cpuCores <= 0 ||
      metrics.memTotalMb <= 0 || metrics.diskTotalGb <= 0) return null;
  if (metrics.memPct > 100 || metrics.diskPct > 100) return null;
  if (metrics.memUsedMb > metrics.memTotalMb || metrics.diskUsedGb > metrics.diskTotalGb) return null;

  const ageMs = nowMs - tsMs;
  const ageSec = Math.floor(ageMs / 1000);
  const stale = ageMs > FLEET_STALE_MS;
  const loadThreshold = metrics.cpuCores * 1.5;
  const alerts = [];
  if (metrics.memPct >= 85) alerts.push(`memory usage ${metrics.memPct}% >= 85%`);
  if (metrics.diskPct >= 85) alerts.push(`disk usage ${metrics.diskPct}% >= 85%`);
  if (metrics.load1m >= loadThreshold) {
    alerts.push(`load1m ${metrics.load1m} >= ${roundMetric(loadThreshold)} (cpuCores * 1.5)`);
  }
  if (stale) alerts.push(`host telemetry stale: age ${ageSec}s > 900s`);

  return {
    host,
    ts: textValue(raw.ts) ?? new Date(tsMs).toISOString(),
    ageSec,
    stale,
    uptimeSec: metrics.uptimeSec,
    cpuCores: metrics.cpuCores,
    load1m: metrics.load1m,
    memTotalMb: metrics.memTotalMb,
    memUsedMb: metrics.memUsedMb,
    memPct: metrics.memPct,
    diskTotalGb: metrics.diskTotalGb,
    diskUsedGb: metrics.diskUsedGb,
    diskPct: metrics.diskPct,
    alerts,
  };
}

// Read bounded regular *.json files only. Missing directories, symlinks,
// malformed JSON, oversized files, and filesystem races all degrade to skipped
// records because fleet telemetry is observational, never a control-plane input.
export async function readFleetTelemetryFiles(fleetDir, {
  maxFileBytes = FLEET_MAX_FILE_BYTES } = {}) {
  if (typeof fleetDir !== 'string' || !fleetDir) return [];
  const dirStat = await lstat(fleetDir).catch(() => null);
  if (!dirStat?.isDirectory() || dirStat.isSymbolicLink()) return [];
  const entries = await readdir(fleetDir, { withFileTypes: true }).catch(() => []);
  const names = entries
    .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
    .map(entry => entry.name)
    .sort();
  const records = [];
  for (const name of names) {
    const path = join(fleetDir, name);
    const fileStat = await lstat(path).catch(() => null);
    if (!fileStat?.isFile() || fileStat.isSymbolicLink() || fileStat.size > maxFileBytes) continue;
    try {
      records.push(JSON.parse(await readFile(path, 'utf8')));
    } catch { /* malformed host snapshot is ignored */ }
  }
  return records;
}

export function createFleetHostsProvider({ fleetDir = null, now = () => Date.now(),
  maxFileBytes = FLEET_MAX_FILE_BYTES } = {}) {
  return async () => {
    const nowMs = nowMilliseconds(now);
    const records = await readFleetTelemetryFiles(fleetDir, { maxFileBytes });
    return records
      .map(record => normalizeFleetHost(record, nowMs))
      .filter(Boolean)
      .sort((a, b) => a.host.localeCompare(b.host));
  };
}

function hostFleetAnomalies(host) {
  const anomalies = [];
  const push = (kind, message, metric, threshold) => anomalies.push({
    kind, severity: 'warn', host: host.host, message, metric, threshold });
  if (host.memPct >= 85) {
    push('memory_pressure', `${host.host}: memory usage ${host.memPct}% >= 85%`, host.memPct, 85);
  }
  if (host.diskPct >= 85) {
    push('disk_pressure', `${host.host}: disk usage ${host.diskPct}% >= 85%`, host.diskPct, 85);
  }
  const loadThreshold = roundMetric(host.cpuCores * 1.5);
  if (host.load1m >= host.cpuCores * 1.5) {
    push('load_pressure', `${host.host}: load1m ${host.load1m} >= ${loadThreshold}`,
      host.load1m, loadThreshold);
  }
  if (host.stale) {
    push('host_stale', `${host.host}: telemetry age ${host.ageSec}s exceeds 900s`,
      host.ageSec, 900);
  }
  return anomalies;
}

function liveFactoryBurnRate(activeTrees, telemetry) {
  const direct = firstNumber(telemetry?.burnRatePerHrUsd, telemetry?.hourlyBurnUsd,
    telemetry?.liveFactory?.burnRatePerHrUsd, telemetry?.liveFactoryBurnRatePerHrUsd);
  if (direct !== null && direct >= 0) return roundMetric(direct);
  const liveTrees = (Array.isArray(activeTrees) ? activeTrees : [])
    .filter(tree => ['running', 'rework'].includes(tree?.status));
  return roundMetric(liveTrees.reduce((sum, tree) =>
    sum + (finiteNumber(tree?.burnRatePerHr) ?? 0), 0));
}

function recentReworkStats(telemetry) {
  const attempts = Array.isArray(telemetry?.attempts) ? telemetry.attempts : [];
  const runCount = finiteNumber(telemetry?.runs) ?? attempts.length;
  if (runCount < 3) return null;
  const direct = firstNumber(telemetry?.reworkRatio, telemetry?.reworkRate,
    telemetry?.rework_rate, telemetry?.recentReworkRatio);
  if (direct !== null && direct >= 0 && direct <= 1) return { ratio: direct, runCount };
  let evaluatedRuns = 0;
  let reworkedRuns = 0;
  for (const attempt of attempts.slice(-32)) {
    const rework = finiteNumber(attempt?.rounds?.rework);
    if (rework === null) continue;
    evaluatedRuns += 1;
    if (rework > 0) reworkedRuns += 1;
  }
  if (evaluatedRuns < 3) return null;
  return { ratio: reworkedRuns / evaluatedRuns, runCount: evaluatedRuns };
}

// Pure fleet/cost anomaly composition, kept separate from filesystem reads so
// boundary values and repeated invocation are deterministic under test.
export function buildFleetTelemetry({ hosts = [], telemetry = null, activeTrees = [] } = {}) {
  const normalizedHosts = (Array.isArray(hosts) ? hosts : [])
    .filter(host => host !== null && typeof host === 'object')
    .sort((a, b) => String(a.host ?? '').localeCompare(String(b.host ?? '')));
  const anomalies = normalizedHosts.flatMap(hostFleetAnomalies);

  const hourlyBurnUsd = liveFactoryBurnRate(activeTrees, telemetry);
  if (hourlyBurnUsd !== null && hourlyBurnUsd > 2.0) {
    anomalies.push({ kind: 'burn_rate_high', severity: 'bad', host: null,
      message: `factory burn rate $${hourlyBurnUsd}/h exceeds $2/h`,
      metric: hourlyBurnUsd, threshold: 2.0 });
  }

  const rework = recentReworkStats(telemetry);
  if (rework && rework.ratio > 0.5) {
    const ratio = roundMetric(rework.ratio);
    anomalies.push({ kind: 'high_rework_rate', severity: 'warn', host: null,
      message: `recent telemetry rework ratio ${ratio} exceeds 0.5 across ${rework.runCount} runs`,
      metric: ratio, threshold: 0.5 });
  }

  return {
    hosts: normalizedHosts,
    anomalies,
    summary: {
      hostCount: normalizedHosts.length,
      healthyCount: normalizedHosts.filter(host => Array.isArray(host.alerts) && host.alerts.length === 0).length,
      alertCount: anomalies.length,
      hourlyBurnUsd,
      projectedDailyUsd: hourlyBurnUsd === null ? null : roundMetric(hourlyBurnUsd * 24),
    },
  };
}

// --- чтение хвоста events.ndjson ----------------------------------------------

export const EVENTS_TAIL_CHUNK_BYTES = 64 * 1024;
export const EVENTS_TAIL_MAX_BYTES_PER_FILE = 4 * 1024 * 1024;

function eventFileGeneration(name) {
  if (name === 'events.ndjson') return 0;
  const rotated = /^events\.(\d+)\.ndjson$/.exec(name);
  if (rotated) return Number(rotated[1]);
  return /^events(?:\..+)?\.ndjson$/.test(name) ? Number.MAX_SAFE_INTEGER : null;
}

function countNewlines(buffer) {
  let count = 0;
  for (const byte of buffer) if (byte === 10) count += 1;
  return count;
}

// Читает только хвост файла bounded chunks с конца к началу. Первый фрагмент
// в середине файла всегда отбрасывается как потенциально неполная строка;
// чтение останавливается, как только набрано достаточно завершённых строк,
// либо по жёсткому байтовому потолку. Ротированный журнал объёмом сотни MiB
// никогда не загружается в память целиком.
async function readNdjsonTailLines(path, needed, {
  chunkBytes = EVENTS_TAIL_CHUNK_BYTES,
  maxBytes = EVENTS_TAIL_MAX_BYTES_PER_FILE,
} = {}) {
  if (!Number.isSafeInteger(needed) || needed <= 0) return [];
  const handle = await open(path, 'r').catch(() => null);
  if (!handle) return [];
  try {
    const st = await handle.stat().catch(() => null);
    if (!st?.isFile() || st.size <= 0) return [];
    const chunkLimit = Math.max(1024, Math.floor(chunkBytes));
    const byteLimit = Math.max(chunkLimit, Math.floor(maxBytes));
    let position = st.size;
    let scanned = 0;
    let newlineCount = 0;
    const parts = [];
    while (position > 0 && scanned < byteLimit && newlineCount <= needed) {
      const amount = Math.min(chunkLimit, position, byteLimit - scanned);
      position -= amount;
      const buffer = Buffer.alloc(amount);
      const { bytesRead } = await handle.read(buffer, 0, amount, position);
      if (bytesRead <= 0) break;
      const chunk = bytesRead === amount ? buffer : buffer.subarray(0, bytesRead);
      parts.unshift(chunk);
      scanned += bytesRead;
      newlineCount += countNewlines(chunk);
    }
    let text = Buffer.concat(parts).toString('utf8');
    if (position > 0) {
      const firstBreak = /\r?\n/.exec(text);
      if (!firstBreak) return [];
      text = text.slice(firstBreak.index + firstBreak[0].length);
    }
    return text.split(/\r?\n/).filter(line => line.trim()).slice(-needed);
  } finally {
    await handle.close().catch(() => {});
  }
}

async function listEventFilesNewestFirst(dir) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) {
    const generation = eventFileGeneration(entry.name);
    if (generation === null) continue;
    const path = join(dir, entry.name);
    const st = await lstat(path).catch(() => null);
    if (!st?.isFile() || st.isSymbolicLink()) continue;
    files.push({ path, generation, name: entry.name });
  }
  files.sort((a, b) => a.generation - b.generation || a.name.localeCompare(b.name));
  return files.map(file => file.path);
}

export async function readEventsTail(stateDirs, limit) {
  const cap = Math.max(0, Math.floor(limit));
  if (!cap) return [];
  const events = [];
  for (const dir of Array.isArray(stateDirs) ? stateDirs : []) {
    const collected = [];
    for (const path of await listEventFilesNewestFirst(dir)) {
      if (collected.length >= cap) break;
      const fileEvents = [];
      for (const line of await readNdjsonTailLines(path, cap - collected.length)) {
        try { fileEvents.push(JSON.parse(line)); } catch { /* пропуск битой строки */ }
      }
      // Файлы обходятся newest→oldest только ради раннего stop; в журнале
      // события остаются в хронологическом порядке даже без ts.
      collected.unshift(...fileEvents);
    }
    events.push(...collected);
  }
  events.sort((a, b) => String(a.ts ?? '').localeCompare(String(b.ts ?? '')));
  return events.slice(-cap);
}

// Read-only провайдер модельного реестра. Любая ошибка конфигурации —
// fail-open для Control Room: snapshot живёт, но видит явный models.ok=false.
export function createModelsProvider({ catalogPath, policyPath, configDir, now, quotas } = {}) {
  return async () => {
    try {
      const at = typeof now === 'function' ? now() : now ?? new Date();
      const registry = await loadModelRegistry({ catalogPath, policyPath, configDir, now: at });
      return { ok: true, ...registrySnapshot(registry, { now: at, quotas }) };
    } catch (error) {
      return { ok: false, error: sanitizeTerminalText(error.message) };
    }
  };
}

const TREE_STAGE_ORDER = ['l1_local', 'tamper', 'scope_fence', 'l2_critic', 'arbiter'];
const ACTIVE_TREE_STATES = new Set(['claimed', 'working', 'blocked', 'awaiting_answer', 'hold',
  'completed', 'done']);

function canonicalStageKind(raw) {
  const value = String(raw ?? '').toLowerCase();
  if (!value) return null;
  if (value.includes('scope')) return 'scope_fence';
  if (value.includes('tamper')) return 'tamper';
  if (value.includes('arbiter') || value.includes('arbitr')) return 'arbiter';
  if (value.includes('l2') || value.includes('critic') || value.includes('review')) return 'l2_critic';
  if (value.includes('l1') || value.includes('local') || value.includes('docker')) return 'l1_local';
  return null;
}

function eventTime(event, fallback = 0) {
  return timeValue(event?.ts) ?? (Number.isSafeInteger(event?.seq) ? event.seq : fallback);
}

function latestEvent(events) {
  return events.length ? events[events.length - 1] : null;
}

function eventModelParts(raw) {
  const model = copyModel(raw);
  return model;
}

function stageVerdictStatus(value) {
  const verdict = String(value ?? '').trim().toLowerCase();
  if (!verdict) return null;
  if (['pass', 'passed', 'ok', 'success', 'done', 'completed'].includes(verdict)) return 'pass';
  if (['skip', 'skipped', 'not_applicable', 'disabled'].includes(verdict)) return 'skipped';
  if (['fail', 'failed', 'rework', 'blocked', 'hold', 'error'].includes(verdict)) return 'fail';
  if (['running', 'started', 'pending'].includes(verdict)) return verdict;
  return null;
}

const FAILED_ATTEMPT_OUTCOMES = new Set(['hold', 'fail', 'failed', 'error', 'provider_error',
  'crashed', 'timeout', 'aborted', 'uncertain', 'lease_lost', 'rework']);

function telemetryFailedStages(telemetry) {
  const failed = new Set();
  const outcome = String(telemetry?.outcome ?? '').trim().toLowerCase();
  if (!FAILED_ATTEMPT_OUTCOMES.has(outcome) &&
      !/(hold|fail|error|crash|timeout|abort|uncertain|lease_lost|rework|blocked|needs_input)/.test(outcome)) return failed;
  const add = raw => {
    const kind = canonicalStageKind(raw);
    if (kind) failed.add(kind);
  };
  for (const key of Object.keys(telemetry?.phaseFailures ?? {})) add(key);
  for (const key of Object.keys(telemetry?.rounds?.gates ?? {})) add(key);
  const reason = String(telemetry?.reason ?? '').toLowerCase();
  if (/review|critic|\bl2\b/.test(reason)) failed.add('l2_critic');
  if (/local_checks|\bl1\b/.test(reason)) failed.add('l1_local');
  if (/tamper/.test(reason)) failed.add('tamper');
  if (/scope/.test(reason)) failed.add('scope_fence');
  if (/arbiter|arbitration/.test(reason)) failed.add('arbiter');
  return failed;
}

function buildStageNodes(events, telemetry, nowMs) {
  const nodes = new Map(TREE_STAGE_ORDER.map(kind => [kind, {
    kind, status: 'pending', model: null, round: null, elapsedMs: null, reason: null,
  }]));
  const telemetryPhases = telemetry?.phasesMs ?? {};
  const telemetryHasAttempt = telemetry !== null && telemetry !== undefined;
  const telemetryFailures = telemetryFailedStages(telemetry);
  for (const kind of ['l1_local', 'tamper', 'l2_critic', 'arbiter']) {
    if (!Object.hasOwn(telemetryPhases, kind)) continue;
    const node = nodes.get(kind);
    const elapsed = finiteNumber(telemetryPhases[kind]);
    if (elapsed !== null) {
      node.status = telemetryFailures.has(kind) ? 'fail' : 'pass';
      node.elapsedMs = elapsed;
      if (telemetryFailures.has(kind)) node.reason = textValue(telemetry?.reason);
    } else if (telemetryHasAttempt) {
      node.status = telemetryFailures.has(kind) ? 'fail' : 'skipped';
    }
  }
  const gateRound = (node, keys) => {
    const gates = telemetry?.rounds?.gates ?? {};
    for (const key of keys) {
      const value = finiteNumber(gates[key]);
      if (value !== null) node.round = value;
    }
  };
  gateRound(nodes.get('l1_local'), ['l1', 'l1_local', 'local']);
  gateRound(nodes.get('tamper'), ['tamper']);
  gateRound(nodes.get('scope_fence'), ['scope', 'scope_fence']);
  gateRound(nodes.get('l2_critic'), ['l2', 'l2_critic', 'critic']);
  gateRound(nodes.get('arbiter'), ['arbiter', 'arbitration']);
  if (!nodes.get('arbiter').round) {
    nodes.get('arbiter').round = finiteNumber(telemetry?.rounds?.arbitration);
  }
  const criticModel = telemetry?.models?.critic?.model ?? null;
  const arbiterModel = telemetry?.models?.arbiter?.model ?? null;
  if (criticModel) nodes.get('l2_critic').model = criticModel;
  if (arbiterModel) nodes.get('arbiter').model = arbiterModel;

  const started = new Map();
  for (const event of events) {
    if (String(event?.kind ?? '').toLowerCase() === 'adaptive_gate_decision') continue;
    const detail = event?.detail !== null && typeof event?.detail === 'object' ? event.detail : {};
    const kind = [detail.stage, detail.kind, event.role, event.phase, event.kind]
      .map(canonicalStageKind).find(value => value !== null) ?? null;
    if (!kind) continue;
    const node = nodes.get(kind);
    const at = eventTime(event);
    const eventKind = String(event.kind ?? '').toLowerCase();
    const explicit = stageVerdictStatus(detail.status ?? detail.verdict ?? detail.outcome ?? event.reason);
    if (event.model) {
      const model = eventModelParts(event.model).model;
      if (model) node.model = model;
    }
    if (Number.isFinite(event.round)) node.round = event.round;
    if (event.reason) node.reason = textValue(event.reason);
    if (detail.reason) node.reason = textValue(detail.reason);
    if (eventKind.includes('started') || eventKind.includes('start')) {
      started.set(kind, at);
      node.status = 'running';
      node.elapsedMs = Math.max(0, nowMs - at);
    } else if (eventKind.includes('completed') || eventKind.includes('finished') || explicit) {
      node.status = explicit ?? (eventKind.includes('completed') ? 'pass' : 'running');
      const began = started.get(kind);
      if (began !== undefined && at >= began) node.elapsedMs = at - began;
      if (detail.verdict) node.reason = textValue(detail.verdict);
    } else if (event.phase === kind || eventKind === kind) {
      node.status = explicit ?? 'running';
      node.elapsedMs = Math.max(0, nowMs - at);
    }
  }
  return TREE_STAGE_ORDER.map(kind => nodes.get(kind));
}

function threadMatchesTask(thread, taskId, threadId) {
  if (!thread || typeof thread !== 'object') return false;
  if (threadId && [thread.id, thread.threadId, thread.thread_id].some(id => String(id ?? '') === String(threadId))) return true;
  return [thread.task_id, thread.taskId, thread.card_id, thread.cardId].some(id => String(id ?? '') === String(taskId));
}

function treeStatus(boardState, telemetry, last, reworkRounds) {
  const phase = String(last?.phase ?? '').toLowerCase();
  const outcome = String(telemetry?.outcome ?? '').toLowerCase();
  const board = String(boardState ?? '').toLowerCase();
  if (['completed', 'done'].includes(board) || ['completed', 'done'].includes(phase) ||
      ['completed', 'done', 'verified', 'deployed'].includes(outcome)) return 'done';
  if (['blocked', 'awaiting_answer', 'hold'].includes(board) ||
      ['hold', 'uncertain', 'lease_lost', 'awaiting_answer', 'blocked', 'blocking'].includes(phase) ||
      ['hold', 'blocked', 'uncertain', 'lease_lost'].includes(outcome)) return 'hold';
  if (String(last?.kind ?? '').toLowerCase() === 'rework' || reworkRounds > 0) return 'rework';
  return 'running';
}

function buildTreeForTask(taskId, { boardTask, events, telemetry, threads, nowMs }) {
  const last = latestEvent(events);
  const first = events[0] ?? null;
  const labels = boardTask?.labels !== null && typeof boardTask?.labels === 'object' ? boardTask.labels : {};
  const detail = last?.detail !== null && typeof last?.detail === 'object' ? last.detail : {};
  const detailValue = (...keys) => {
    for (const event of [...events].reverse()) {
      const item = event?.detail !== null && typeof event?.detail === 'object' ? event.detail : {};
      for (const key of keys) {
        if (item[key] !== undefined && item[key] !== null) return item[key];
      }
    }
    return null;
  };
  const startedMs = timeValue(telemetry?.startedAt) ?? timeValue(first?.ts);
  const terminal = ['done', 'hold'].includes(treeStatus(boardTask?.state, telemetry, last,
    finiteNumber(telemetry?.rounds?.rework) ?? events.filter(e => String(e.kind ?? '').toLowerCase() === 'rework').length));
  const endedMs = terminal
    ? timeValue(telemetry?.endedAt) ?? timeValue(last?.ts) ?? startedMs
    : nowMs;
  const elapsedMs = finiteNumber(telemetry?.elapsedMs) ??
    (startedMs !== null && endedMs !== null ? Math.max(0, endedMs - startedMs) : null);
  const reworkRounds = finiteNumber(telemetry?.rounds?.rework) ??
    events.filter(e => String(e.kind ?? '').toLowerCase() === 'rework').length;
  const eventRounds = events.map(e => finiteNumber(e.round)).filter(v => v !== null);
  const rounds = finiteNumber(telemetry?.rounds?.total) ??
    (eventRounds.length ? Math.max(...eventRounds) : null) ??
    (events.length ? reworkRounds + 1 : null);
  const estCostUsd = finiteNumber(telemetry?.costUsd);
  const burnRatePerHr = estCostUsd !== null && elapsedMs !== null && elapsedMs > 0
    ? Number((estCostUsd / (elapsedMs / 3_600_000)).toFixed(4)) : null;
  const threadId = firstText(detailValue('threadId', 'thread_id'), last?.bb_thread_id,
    telemetry?.threadId, boardTask?.thread_id, boardTask?.bb_thread_id);
  const thread = (Array.isArray(threads) ? threads : []).find(item => threadMatchesTask(item, taskId, threadId)) ?? null;
  const telemetryWorker = telemetry?.models?.worker ?? { provider: null, model: null };
  const workerEvent = [...events].reverse().find(event =>
    event?.role === 'worker' || event?.phase === 'working' ||
    (event?.model && !canonicalStageKind(event?.detail?.stage ?? event?.role))) ?? last;
  const parsedEventModel = copyModel(workerEvent?.model);
  const provider = firstText(telemetryWorker.provider, parsedEventModel.provider,
    thread?.provider, thread?.providerId, thread?.provider_id);
  const model = firstText(telemetryWorker.model, parsedEventModel.model,
    thread?.model, thread?.modelId, thread?.model_id, boardTask?.executor?.model);
  const eventTokens = [...events].reverse().map(event => finiteNumber(event?.tokens))
    .find(value => value !== null) ?? null;
  const workerTokens = copyUsage(telemetry?.tokens?.worker) ??
    copyUsage(thread?.usage) ?? eventTokens;
  const contextPct = firstNumber(detailValue('contextPct', 'context_pct', 'contextPercent',
    'context_usage_pct'), thread?.contextPct, thread?.context_pct, thread?.context?.pct,
    thread?.context?.percent, thread?.context?.usagePct);
  const workerElapsedMs = finiteNumber(telemetry?.phasesMs?.worker) ?? elapsedMs;
  const usageCache = workerTokens !== null && typeof workerTokens === 'object'
    ? finiteNumber(workerTokens.cached) : null;
  const cacheStatus = firstText(detailValue('cacheStatus', 'cache_status'),
    thread?.cacheStatus, thread?.cache_status) ??
    (usageCache !== null ? (usageCache > 0 ? 'hit' : 'miss') : null);
  const status = treeStatus(boardTask?.state, telemetry, last, reworkRounds);
  return {
    taskId: String(taskId),
    title: firstText(boardTask?.title, telemetry?.title) ?? '',
    channel: firstText(last?.channel, telemetry?.channel, boardTask?.channel, labels.channel) ?? 'unassigned',
    repoId: firstText(telemetry?.repoId, taskRepoId(boardTask ?? {}), detailValue('repoId', 'repo_id')),
    status,
    elapsedMs,
    rounds,
    reworkRounds,
    estCostUsd,
    burnRatePerHr,
    worker: {
      threadId,
      provider,
      model,
      branch: firstText(detailValue('branch', 'worktreeBranch'), thread?.branch, thread?.currentBranch,
        thread?.gitBranch, labels.branch),
      phase: firstText(last?.phase, boardTask?.state) ?? null,
      elapsedMs: workerElapsedMs,
      contextPct,
      cacheStatus,
      tokens: workerTokens,
    },
    stages: buildStageNodes(events, telemetry, nowMs),
  };
}

export function buildActiveTrees({ events = [], tasks = [], telemetryAttempts = [], threads = [],
  now = () => Date.now(), limit = 100 } = {}) {
  const nowValue = now();
  const nowMs = timeValue(nowValue) ?? (nowValue instanceof Date ? nowValue.getTime() : Date.now());
  const boardById = new Map();
  for (const task of Array.isArray(tasks) ? tasks : []) {
    const id = task?.task_id ?? task?.id;
    if (id !== undefined && id !== null) boardById.set(String(id), task);
  }
  const telemetryByTask = new Map();
  for (const raw of Array.isArray(telemetryAttempts) ? telemetryAttempts : []) {
    const compact = compactTelemetryAttempt(raw);
    if (!compact) continue;
    if (!telemetryByTask.has(compact.taskId)) telemetryByTask.set(compact.taskId, []);
    telemetryByTask.get(compact.taskId).push(compact);
  }
  const telemetryTime = entry => timeValue(entry?.endedAt) ?? timeValue(entry?.startedAt) ?? 0;
  for (const list of telemetryByTask.values()) {
    list.sort((a, b) => telemetryTime(a) - telemetryTime(b));
  }
  const groups = new Map();
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.task_id === undefined || event?.task_id === null) continue;
    const taskId = String(event.task_id);
    const key = [taskId, event.attempt_id ?? '', event.epoch ?? ''].join('|');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(event);
  }
  const latestGroupByTask = new Map();
  for (const group of groups.values()) {
    group.sort((a, b) => eventTime(a) - eventTime(b));
    const taskId = String(group[0].task_id);
    const currentMax = eventTime(group[group.length - 1]);
    const previous = latestGroupByTask.get(taskId);
    const previousMax = previous ? eventTime(previous[previous.length - 1]) : -Infinity;
    if (!previous || currentMax >= previousMax) latestGroupByTask.set(taskId, group);
  }
  const groupIdentity = group => {
    const withAttempt = [...(group ?? [])].reverse().find(event => textValue(event?.attempt_id));
    const withEpoch = [...(group ?? [])].reverse().find(event => Number.isSafeInteger(event?.epoch));
    return {
      attemptId: textValue(withAttempt?.attempt_id),
      epoch: Number.isSafeInteger(withEpoch?.epoch) ? withEpoch.epoch : null,
    };
  };
  const telemetryForGroup = (taskId, group) => {
    const list = telemetryByTask.get(taskId) ?? [];
    if (!list.length) return null;
    const latest = list[list.length - 1];
    if (!group?.length) return latest;
    const identity = groupIdentity(group);
    if (!identity.attemptId && identity.epoch === null) return latest;
    const matches = list.filter(entry => {
      if (identity.attemptId && entry.attemptId !== identity.attemptId) return false;
      if (identity.epoch !== null && entry.epoch !== identity.epoch) return false;
      return true;
    });
    return matches.length ? matches[matches.length - 1] : null;
  };
  const ids = new Set([...latestGroupByTask.keys(), ...telemetryByTask.keys()]);
  for (const [taskId, task] of boardById) {
    if (ACTIVE_TREE_STATES.has(String(task?.state ?? '').toLowerCase())) ids.add(taskId);
  }
  const trees = [...ids].map(taskId => buildTreeForTask(taskId, {
    boardTask: boardById.get(taskId) ?? null,
    events: latestGroupByTask.get(taskId) ?? [],
    telemetry: telemetryForGroup(taskId, latestGroupByTask.get(taskId)),
    threads,
    nowMs,
  }));
  const rank = { running: 0, rework: 1, hold: 2, done: 3 };
  trees.sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9) ||
    String(a.taskId).localeCompare(String(b.taskId), undefined, { numeric: true }));
  return trees.slice(0, limit);
}

export function buildRepoSlots(trees = []) {
  const activeByRepo = {};
  for (const tree of Array.isArray(trees) ? trees : []) {
    if (!['running', 'rework'].includes(tree?.status)) continue;
    const repoId = textValue(tree.repoId);
    if (!repoId) continue;
    activeByRepo[repoId] = (activeByRepo[repoId] ?? 0) + 1;
  }
  const multiWriterWarnings = Object.entries(activeByRepo)
    .filter(([, count]) => count > 1)
    .map(([repoId, count]) =>
      `repo_id ${repoId} has ${count} active writers (default max 1); parallelize across repos instead`);
  return { defaultMaxPerRepo: 1, activeByRepo, multiWriterWarnings };
}
