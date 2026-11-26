// Adaptive 2-tier verification gate selection (V2-9). Pure and
// repo-agnostic: no filesystem, clock, network, or mutable module state.

export const ADAPTIVE_GATE_DEFAULTS = Object.freeze({
  fastMaxMs: 90_000,
  asyncMinMs: 120_000,
  breakerTripRate: 0.10,
  breakerRecoverRate: 0.05,
  rollingWindowRuns: 20,
  minSample: 5,
});

const CHECK_KINDS = new Set(['fast', 'heavy', 'formal']);
const MEDIAN_KEYS = ['medianMs', 'median_ms', 'median', 'p50Ms', 'p50_ms'];
const ROLLBACK_MARKERS = ['rollback', 'rolled_back', 'rolled-back'];

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const finiteMs = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const firstText = (...values) => values
  .map(value => typeof value === 'string' && value.trim() ? value.trim() : null)
  .find(value => value !== null) ?? null;

function firstNumber(source, keys, fallback) {
  if (!isObject(source)) return fallback;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return fallback;
}

function validRate(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
    ? value : fallback;
}

function positiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export function normalizeAdaptiveThresholds(thresholds = {}) {
  const d = ADAPTIVE_GATE_DEFAULTS;
  let fastMaxMs = finiteMs(firstNumber(thresholds, ['fastMaxMs', 'fast_max_ms'], d.fastMaxMs)) ?? d.fastMaxMs;
  let asyncMinMs = finiteMs(firstNumber(thresholds, ['asyncMinMs', 'async_min_ms'], d.asyncMinMs)) ?? d.asyncMinMs;
  let breakerTripRate = validRate(firstNumber(thresholds,
    ['breakerTripRate', 'breaker_trip_rate'], d.breakerTripRate), d.breakerTripRate);
  let breakerRecoverRate = validRate(firstNumber(thresholds,
    ['breakerRecoverRate', 'breaker_recover_rate'], d.breakerRecoverRate), d.breakerRecoverRate);
  if (asyncMinMs <= fastMaxMs) {
    fastMaxMs = d.fastMaxMs;
    asyncMinMs = d.asyncMinMs;
  }
  if (breakerTripRate <= 0 || breakerRecoverRate >= breakerTripRate) {
    breakerTripRate = d.breakerTripRate;
    breakerRecoverRate = d.breakerRecoverRate;
  }
  const rollingWindowRuns = positiveInteger(firstNumber(thresholds,
    ['rollingWindowRuns', 'rolling_window_runs', 'windowRuns', 'window_runs', 'window'], d.rollingWindowRuns),
    d.rollingWindowRuns);
  const minSample = positiveInteger(firstNumber(thresholds,
    ['minSample', 'min_sample', 'minSampleRuns', 'min_sample_runs'], d.minSample), d.minSample);
  return { fastMaxMs, asyncMinMs, breakerTripRate, breakerRecoverRate, rollingWindowRuns, minSample };
}

function normalizePath(path) {
  if (typeof path !== 'string') return null;
  let normalized = path.trim().replaceAll('\\', '/');
  while (normalized.startsWith('./')) normalized = normalized.slice(2);
  normalized = normalized.replace(/\/+/g, '/');
  return normalized || null;
}

function normalizePatternList(value) {
  const list = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  const seen = new Set();
  const patterns = [];
  for (const item of list) {
    const pattern = normalizePath(item);
    if (!pattern || seen.has(pattern)) continue;
    seen.add(pattern);
    patterns.push(pattern);
  }
  return patterns;
}

function globRegExp(pattern) {
  let out = '^';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        i += 1;
        if (pattern[i + 1] === '/') {
          i += 1;
          out += '(?:[^/]+/)*';
        } else {
          out += '.*';
        }
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else {
      out += ch.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
    }
  }
  return new RegExp(`${out}$`);
}

function pathMatchesPattern(path, pattern) {
  if (!path || !pattern) return false;
  if (/[*?]/.test(pattern)) return globRegExp(pattern).test(path);
  if (path === pattern) return true;
  return pattern.endsWith('/') ? path.startsWith(pattern) : path.startsWith(`${pattern}/`);
}

function normalizeCheck(raw, index) {
  const source = isObject(raw) ? raw : {};
  const id = firstText(source.id, source.name, source.key, source.checkId, source.check_id,
    typeof raw === 'string' ? raw : null) ?? `check-${index}`;
  return {
    id,
    kind: CHECK_KINDS.has(source.kind) ? source.kind : 'fast',
    reversible: source.reversible === true,
    highRiskPaths: normalizePatternList(source.high_risk_paths ?? source.highRiskPaths),
    value: isObject(raw) ? { ...raw } : raw,
    raw: source,
  };
}

function medianValue(value) {
  const direct = finiteMs(value);
  if (direct !== null) return direct;
  if (!isObject(value)) return null;
  for (const key of MEDIAN_KEYS) {
    const found = finiteMs(value[key]);
    if (found !== null) return found;
  }
  return null;
}

function lookupMedian(telemetryStats, check, index) {
  if (telemetryStats === null || telemetryStats === undefined) return null;
  const raw = check.raw ?? {};
  const candidates = [...new Set([
    check.id,
    firstText(raw.id, raw.name, raw.key, raw.checkId, raw.check_id),
    String(index),
  ].filter(value => value !== null && value !== undefined).map(String))];
  const objectMaps = [telemetryStats, telemetryStats?.checks, telemetryStats?.medians,
    telemetryStats?.medianByCheck, telemetryStats?.medianMs, telemetryStats?.median_ms,
    telemetryStats?.perCheck, telemetryStats?.per_check];
  for (const map of objectMaps) {
    if (!isObject(map)) continue;
    for (const key of candidates) {
      if (!Object.hasOwn(map, key)) continue;
      const median = medianValue(map[key]);
      if (median !== null) return median;
    }
  }
  const arrays = [telemetryStats, telemetryStats?.checks, telemetryStats?.entries, telemetryStats?.perCheck]
    .filter(Array.isArray);
  for (const entries of arrays) {
    for (const entry of entries) {
      if (!isObject(entry)) continue;
      const key = firstText(entry.id, entry.name, entry.key, entry.checkId, entry.check_id);
      if (key === null || !candidates.includes(key)) continue;
      const median = medianValue(entry);
      if (median !== null) return median;
    }
  }
  return null;
}

export function isRollbackRecord(entry) {
  if (entry === true) return true;
  if (typeof entry === 'string') {
    const value = entry.trim().toLowerCase();
    return ROLLBACK_MARKERS.some(marker => value === marker || value.includes(`${marker}_`) ||
      value.includes(`${marker}-`) || value.includes(`${marker} `) || value.includes(marker));
  }
  if (!isObject(entry)) return false;
  if (entry.rollback === true || entry.rolledBack === true || entry.rolled_back === true) return true;
  const markers = [entry.outcome, entry.reason, entry.status, entry.state, entry.receipt?.kind]
    .filter(value => typeof value === 'string')
    .map(value => value.trim().toLowerCase());
  return markers.some(value => ROLLBACK_MARKERS.some(marker => value.includes(marker)));
}

function rollbackEntriesFrom(input) {
  if (Array.isArray(input)) return input;
  if (!isObject(input)) return null;
  for (const key of ['entries', 'runs', 'results', 'history']) {
    if (Array.isArray(input[key])) return input[key];
  }
  return null;
}

function explicitRollbackCounts(input) {
  if (!isObject(input)) return null;
  const totalRuns = firstNumber(input, ['totalRuns', 'total_runs', 'total', 'sampleSize', 'sample_size'], null);
  const rollbacks = firstNumber(input, ['rollbacks', 'rollbackCount', 'rollback_count'], null);
  if (!Number.isSafeInteger(totalRuns) || !Number.isSafeInteger(rollbacks) || totalRuns < 0 || rollbacks < 0) return null;
  return { totalRuns, rollbacks };
}

function explicitBreakerState(input) {
  if (!isObject(input)) return null;
  for (const key of ['breakerOpen', 'breaker_open', 'circuitBreakerOpen', 'circuit_breaker_open',
    'open', 'tripped', 'active']) {
    if (typeof input[key] === 'boolean') return input[key];
  }
  return null;
}

function inferBreakerOpen(entries, thresholds, initiallyOpen = false) {
  let open = initiallyOpen === true;
  const window = [];
  let rollbacks = 0;
  for (const entry of entries) {
    const rollback = isRollbackRecord(entry);
    window.push(rollback);
    if (rollback) rollbacks += 1;
    if (window.length > thresholds.rollingWindowRuns) {
      if (window.shift()) rollbacks -= 1;
    }
    if (window.length < thresholds.minSample) continue;
    const rate = rollbacks / window.length;
    if (open) {
      if (rate <= thresholds.breakerRecoverRate) open = false;
    } else if (rate > thresholds.breakerTripRate) {
      open = true;
    }
  }
  return open;
}

export function evaluateRollbackCircuitBreaker(recentRollbacks, thresholdsInput = {}) {
  const thresholds = normalizeAdaptiveThresholds(thresholdsInput);
  const entries = rollbackEntriesFrom(recentRollbacks);
  const initialOpen = explicitBreakerState(recentRollbacks) === true;
  let totalRuns;
  let rollbacks;
  let open;
  if (entries) {
    const windowed = entries.slice(-thresholds.rollingWindowRuns);
    totalRuns = windowed.length;
    rollbacks = windowed.filter(isRollbackRecord).length;
    open = inferBreakerOpen(entries, thresholds, initialOpen);
  } else {
    const counts = explicitRollbackCounts(recentRollbacks) ?? { totalRuns: 0, rollbacks: 0 };
    totalRuns = counts.totalRuns;
    rollbacks = Math.min(counts.rollbacks, counts.totalRuns);
    open = initialOpen;
  }
  const sampleSufficient = totalRuns >= thresholds.minSample;
  const rollbackRate = sampleSufficient && totalRuns > 0 ? rollbacks / totalRuns : null;
  if (sampleSufficient && rollbackRate !== null) {
    if (rollbackRate > thresholds.breakerTripRate) open = true;
    else if (rollbackRate <= thresholds.breakerRecoverRate) open = false;
  }
  return {
    totalRuns,
    rollbacks,
    rollbackRate,
    rollingWindowRuns: thresholds.rollingWindowRuns,
    minSample: thresholds.minSample,
    sampleSufficient,
    open,
    state: open ? 'open' : sampleSufficient ? 'closed' : 'insufficient_sample',
    tripped: rollbackRate !== null && rollbackRate > thresholds.breakerTripRate,
    recovered: rollbackRate !== null && rollbackRate <= thresholds.breakerRecoverRate,
  };
}

function highRiskMatches(diffPaths, patterns) {
  const matches = [];
  for (const rawPath of Array.isArray(diffPaths) ? diffPaths : []) {
    const path = normalizePath(rawPath);
    if (!path) continue;
    for (const pattern of patterns) {
      if (pathMatchesPattern(path, pattern)) matches.push({ path, pattern });
    }
  }
  return matches;
}

function syncDecisionReason(check, medianMs, thresholds) {
  if (check.kind === 'formal') return 'formal_override';
  if (check.reversible !== true) return 'irreversible_override';
  if (medianMs === null) return 'missing_telemetry';
  if (medianMs < thresholds.fastMaxMs) return 'fast_duration';
  if (medianMs < thresholds.asyncMinMs) return 'conservative_duration_band';
  return 'sync';
}

export function evaluateAdaptiveGate({
  checks = [],
  diffPaths = [],
  telemetryStats = null,
  recentRollbacks = null,
  thresholds: thresholdsInput = {},
  highRiskPaths = null,
  high_risk_paths: highRiskPathsSnake = null,
} = {}) {
  const thresholds = normalizeAdaptiveThresholds(thresholdsInput);
  const normalizedChecks = (Array.isArray(checks) ? checks : [])
    .map((raw, index) => normalizeCheck(raw, index));
  const patterns = normalizePatternList([
    ...normalizePatternList(highRiskPaths ?? highRiskPathsSnake),
    ...normalizePatternList(thresholdsInput?.highRiskPaths ?? thresholdsInput?.high_risk_paths),
    ...normalizedChecks.flatMap(check => check.highRiskPaths),
  ]);
  const riskMatches = highRiskMatches(diffPaths, patterns);
  const circuitBreaker = evaluateRollbackCircuitBreaker(recentRollbacks, thresholds);

  const decisions = normalizedChecks.map((check, index) => {
    const medianMs = lookupMedian(telemetryStats, check, index);
    const asyncEligible = check.kind !== 'formal' && check.reversible === true &&
      medianMs !== null && medianMs >= thresholds.asyncMinMs;
    return {
      id: check.id,
      check,
      medianMs,
      asyncEligible,
      disposition: asyncEligible ? 'async' : 'sync',
      reason: asyncEligible ? 'adaptive_duration' : syncDecisionReason(check, medianMs, thresholds),
    };
  });

  let mode = decisions.some(decision => decision.asyncEligible) ? 'optimistic_async' : 'strict_sync';
  let reason = mode === 'optimistic_async' ? 'adaptive_duration' : null;
  let forceSync = null;
  if (riskMatches.length) {
    forceSync = 'high_risk_path';
  } else if (circuitBreaker.open) {
    forceSync = 'rollback_circuit_breaker';
  }
  if (forceSync) {
    mode = 'strict_sync';
    reason = forceSync;
  }

  const syncFastChecks = [];
  const asyncHeavyChecks = [];
  for (const decision of decisions) {
    const check = isObject(decision.check.value) ? { ...decision.check.value } : decision.check.value;
    if (!forceSync && decision.asyncEligible) {
      asyncHeavyChecks.push(isObject(check) ? { ...check, autoRollbackOnFail: true } : check);
    } else {
      syncFastChecks.push(check);
    }
  }

  return {
    mode,
    reason,
    syncFastChecks,
    asyncHeavyChecks,
    decisions: decisions.map(decision => ({
      id: decision.id,
      disposition: forceSync ? 'sync' : decision.disposition,
      reason: forceSync ?? decision.reason,
      medianMs: decision.medianMs,
    })),
    highRiskPaths: patterns,
    highRiskMatches: riskMatches,
    circuitBreaker,
    thresholds,
  };
}

function attemptRepoId(attempt) {
  if (!isObject(attempt)) return 'unassigned';
  const labels = isObject(attempt.labels) ? attempt.labels : {};
  return firstText(attempt.repoId, attempt.repo_id, labels.repo_id, labels.repoId, labels.project) ?? 'unassigned';
}

export function buildAdaptiveGatesSummary({ attempts = [], thresholds: thresholdsInput = {} } = {}) {
  const thresholds = normalizeAdaptiveThresholds(thresholdsInput);
  const grouped = new Map();
  for (const attempt of Array.isArray(attempts) ? attempts : []) {
    if (!isObject(attempt) || attempt.open === true) continue;
    const repo = attemptRepoId(attempt);
    if (!grouped.has(repo)) grouped.set(repo, []);
    grouped.get(repo).push(attempt);
  }
  const repos = {};
  for (const repo of [...grouped.keys()].sort()) {
    const entries = grouped.get(repo);
    const observedRuns = entries.length;
    const observedRollbacks = entries.filter(isRollbackRecord).length;
    const circuit = evaluateRollbackCircuitBreaker({ entries }, thresholds);
    repos[repo] = {
      totalRuns: circuit.totalRuns,
      rollbacks: circuit.rollbacks,
      rollbackRate: circuit.rollbackRate,
      observedRuns,
      observedRollbacks,
      observedRollbackRate: observedRuns ? observedRollbacks / observedRuns : null,
      sampleSufficient: circuit.sampleSufficient,
      circuitBreakerOpen: circuit.open,
      circuitBreakerState: circuit.state,
    };
  }
  return {
    fastMaxMs: thresholds.fastMaxMs,
    asyncMinMs: thresholds.asyncMinMs,
    breakerTripRate: thresholds.breakerTripRate,
    breakerRecoverRate: thresholds.breakerRecoverRate,
    rollingWindowRuns: thresholds.rollingWindowRuns,
    minSample: thresholds.minSample,
    thresholds,
    repos,
  };
}
