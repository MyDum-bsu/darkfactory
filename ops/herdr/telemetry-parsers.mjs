// Versioned telemetry parsers for the Herdr desktop monitor (WAVE2-6).
//
// Pure ESM, zero external deps (node:path only, for lexical cwd
// normalization). Every parser is deterministic: the caller injects `nowMs`,
// no wall-clock reads, no I/O, no randomness. Unknown/malformed input fails
// closed with a TypeError instead of fabricating quota state.
//
// Supported upstream shapes:
//   Antigravity quota:
//     modern  { groups: [{ buckets: [{ window: "5h"|"weekly",
//               remainingFraction, resetTime? }] }] }
//     legacy  { modelQuotaGroups: [{ quotaWindows: [...] }] }
//   OpenCode quota:
//     modern  { usage: { rolling|weekly|monthly: { percent, resetsAt? } } }
//     legacy  { rollingUsage|weeklyUsage|monthlyUsage:
//               { usagePercent, resetInSec? } }
//
// Output contract (both providers):
//   windows: [{ label, usedPct, remPct, resetIn }]
//   - usedPct + remPct === 100 (integer percentages)
//   - resetIn is milliseconds until reset (>= 0), or null when the upstream
//     payload carries no reset time. Parsers NEVER invent a reset time.

import { posix } from 'node:path';

const WINDOW_LABELS = new Map([
  ['5h', '5h'],
  ['rolling', 'Rolling'],
  ['weekly', 'Weekly'],
  ['monthly', 'Monthly'],
]);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clamp01(fraction) {
  if (typeof fraction !== 'number' || !Number.isFinite(fraction)) {
    throw new TypeError('quota_fraction_invalid');
  }
  return Math.min(1, Math.max(0, fraction));
}

function windowLabel(windowKey) {
  if (WINDOW_LABELS.has(windowKey)) return WINDOW_LABELS.get(windowKey);
  const raw = String(windowKey);
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

// Accepts ISO-8601 strings or epoch-milliseconds numbers. Anything else is
// treated as absent (null) rather than guessed: a wrong reset time is worse
// than none.
function parseResetTimeMs(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

// Milliseconds until reset, clamped at zero for already-expired timestamps.
// Returns null when the source field is absent — never fabricated.
function resetInMs(resetMs, nowMs) {
  if (resetMs === null) return null;
  return Math.max(0, resetMs - nowMs);
}

function firstDefined(object, keys) {
  for (const key of keys) {
    if (object[key] !== undefined && object[key] !== null) return object[key];
  }
  return undefined;
}

// --- Antigravity -------------------------------------------------------------

// One bucket/window entry, tolerant across the modern (`groups[].buckets[]`)
// and legacy (`modelQuotaGroups[].quotaWindows[]`) shapes. Field aliases are
// deliberate: the upstream payload drifted before, and the monitor must keep
// rendering instead of dropping quota state silently.
function parseAgyBucket(bucket, groupLabel, nowMs) {
  if (!isPlainObject(bucket)) throw new TypeError('agy_bucket_invalid');
  const windowKey = firstDefined(bucket, ['window', 'type', 'kind']);
  if (typeof windowKey !== 'string' || !windowKey) {
    throw new TypeError('agy_window_kind_missing');
  }
  const remaining = firstDefined(bucket, ['remainingFraction', 'remaining', 'fractionRemaining']);
  let remainingFraction;
  if (remaining !== undefined) {
    remainingFraction = clamp01(remaining);
  } else {
    const used = firstDefined(bucket, ['usedFraction', 'used']);
    if (used === undefined) throw new TypeError('agy_fraction_missing');
    remainingFraction = clamp01(1 - clamp01(used));
  }
  const resetMs = parseResetTimeMs(firstDefined(bucket, ['resetTime', 'resetsAt', 'resetAt']));
  const remPct = Math.round(remainingFraction * 100);
  const base = windowLabel(windowKey);
  return {
    label: groupLabel ? `${groupLabel} ${base}` : base,
    usedPct: 100 - remPct,
    remPct,
    resetIn: resetInMs(resetMs, nowMs),
  };
}

function agyGroupLabel(group) {
  const label = firstDefined(group, ['label', 'name', 'id', 'model']);
  if (typeof label === 'string' && label.trim()) return label.trim();
  return null;
}

export function parseAgyQuotaResponse(json, nowMs) {
  if (!isPlainObject(json)) throw new TypeError('agy_response_invalid');
  if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) {
    throw new TypeError('now_ms_invalid');
  }
  const groups = Array.isArray(json.groups) ? json.groups
    : Array.isArray(json.modelQuotaGroups) ? json.modelQuotaGroups
      : null;
  if (groups === null) throw new TypeError('agy_response_shape_unknown');
  const windows = [];
  for (const group of groups) {
    if (!isPlainObject(group)) throw new TypeError('agy_group_invalid');
    const buckets = Array.isArray(group.buckets) ? group.buckets
      : Array.isArray(group.quotaWindows) ? group.quotaWindows
        : [];
    const label = agyGroupLabel(group);
    for (const bucket of buckets) {
      windows.push(parseAgyBucket(bucket, label, nowMs));
    }
  }
  return {
    id: 'antigravity',
    label: 'Antigravity (Ultra)',
    status: 'ok',
    windows,
  };
}

// --- OpenCode ----------------------------------------------------------------

const OPENCODE_WINDOWS = ['rolling', 'weekly', 'monthly'];

function parseOpenCodeWindow(windowKey, entry, nowMs) {
  if (!isPlainObject(entry)) throw new TypeError('opencode_window_invalid');
  const percent = firstDefined(entry, ['percent', 'usagePercent']);
  if (percent === undefined) throw new TypeError('opencode_percent_missing');
  if (typeof percent !== 'number' || !Number.isFinite(percent)) {
    throw new TypeError('opencode_percent_invalid');
  }
  const usedPct = Math.round(Math.min(100, Math.max(0, percent)));
  // Modern shape: absolute `resetsAt` timestamp. Legacy shape: relative
  // `resetInSec` duration. Both resolve to milliseconds-until-reset; neither
  // is invented when absent.
  let resetIn = null;
  const resetMs = parseResetTimeMs(firstDefined(entry, ['resetsAt', 'resetTime', 'resetAt']));
  if (resetMs !== null) {
    resetIn = resetInMs(resetMs, nowMs);
  } else {
    const resetInSec = firstDefined(entry, ['resetInSec', 'resetsInSec']);
    if (typeof resetInSec === 'number' && Number.isFinite(resetInSec)) {
      resetIn = Math.max(0, Math.round(resetInSec * 1000));
    }
  }
  return {
    label: windowLabel(windowKey),
    usedPct,
    remPct: 100 - usedPct,
    resetIn,
  };
}

export function parseOpenCodeQuotaResponse(json, nowMs) {
  if (!isPlainObject(json)) throw new TypeError('opencode_response_invalid');
  if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) {
    throw new TypeError('now_ms_invalid');
  }
  const legacyKey = key => `${key}Usage`;
  const windows = [];
  let recognized = false;
  for (const windowKey of OPENCODE_WINDOWS) {
    const modern = isPlainObject(json.usage) ? json.usage[windowKey] : undefined;
    const legacy = json[legacyKey(windowKey)];
    const entry = modern ?? legacy;
    if (entry === undefined || entry === null) continue;
    recognized = true;
    windows.push(parseOpenCodeWindow(windowKey, entry, nowMs));
  }
  if (!recognized) throw new TypeError('opencode_response_shape_unknown');
  return {
    id: 'opencode',
    label: 'OpenCode Go',
    status: 'ok',
    plan: 'Go',
    windows,
  };
}

// --- Slot/session mapping ----------------------------------------------------

// Lexical normalization only — the parser must stay pure, so symlinks are
// not resolved. Duplicate slashes collapse, trailing slashes are stripped
// (except the filesystem root), and "." / ".." segments are resolved
// lexically so that equivalent worktree spellings match.
export function normalizeCwd(cwd) {
  if (typeof cwd !== 'string' || !cwd.trim()) return '';
  let normalized = posix.normalize(cwd.trim());
  while (normalized.length > 1 && normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

function slotKey(slot) {
  const key = slot.slot ?? slot.id ?? null;
  return key === null ? null : String(key);
}

// Context-window saturation percentage. Prefers a precomputed `ctxPct`;
// otherwise derives it from raw token counters when both used and limit are
// known. Returns null when the session carries neither — never fabricated.
function ctxPctOf(session) {
  if (typeof session.ctxPct === 'number' && Number.isFinite(session.ctxPct)) {
    return Math.round(session.ctxPct);
  }
  const used = firstDefined(session, ['contextUsed', 'contextTokens', 'usedTokens']);
  const limit = firstDefined(session, ['contextLimit', 'contextMax', 'maxTokens']);
  if (typeof used === 'number' && typeof limit === 'number' &&
      Number.isFinite(used) && Number.isFinite(limit) && limit > 0) {
    return Math.round(Math.min(100, Math.max(0, (used / limit) * 100)));
  }
  return null;
}

// Tokens-per-second throughput, rounded to one decimal. Prefers precomputed
// rates; derives from token count over elapsed seconds when available.
function tokPerSecOf(session) {
  const direct = firstDefined(session, ['tokPerSec', 'tokensPerSecond']);
  if (typeof direct === 'number' && Number.isFinite(direct)) {
    return Math.round(direct * 10) / 10;
  }
  const tokens = firstDefined(session, ['tokens', 'outputTokens']);
  const elapsed = firstDefined(session, ['elapsedSec', 'elapsedSeconds']);
  if (typeof tokens === 'number' && typeof elapsed === 'number' &&
      Number.isFinite(tokens) && Number.isFinite(elapsed) && elapsed > 0) {
    return Math.round((tokens / elapsed) * 10) / 10;
  }
  return null;
}

// Matches live hc sessions to factory slots (S1..S4) by normalized worktree
// path. Returns enriched sessions (each carrying the owning slot's identity)
// plus one compact entry per slot with live utilization signals.
export function mapSlotsToSessions({ slots = [], sessions = [] } = {}) {
  if (!Array.isArray(slots) || !Array.isArray(sessions)) {
    throw new TypeError('slots_sessions_invalid');
  }
  const slotsByCwd = new Map();
  for (const slot of slots) {
    if (!isPlainObject(slot)) throw new TypeError('slot_invalid');
    const normalized = normalizeCwd(slot.cwd ?? slot.path ?? '');
    if (normalized && !slotsByCwd.has(normalized)) slotsByCwd.set(normalized, slot);
  }

  const enrichedSessions = sessions.map(session => {
    if (!isPlainObject(session)) throw new TypeError('session_invalid');
    const owner = slotsByCwd.get(normalizeCwd(session.cwd ?? '')) ?? null;
    return {
      ...session,
      slot: owner === null ? null : slotKey(owner),
      taskId: owner?.taskId ?? null,
      phase: owner?.phase ?? null,
      threadId: session.threadId ?? session.thread_id ?? session.id ?? null,
    };
  });

  const liveBySlot = new Map();
  for (const session of enrichedSessions) {
    if (session.slot !== null && !liveBySlot.has(session.slot)) {
      liveBySlot.set(session.slot, session);
    }
  }

  const compactSlots = slots.map(slot => {
    const key = slotKey(slot);
    const live = key === null ? null : liveBySlot.get(key) ?? null;
    return {
      slot: key,
      taskId: slot.taskId ?? null,
      phase: slot.phase ?? null,
      threadId: live?.threadId ?? null,
      ctxPct: live === null ? null : ctxPctOf(live),
      tokPerSec: live === null ? null : tokPerSecOf(live),
    };
  });

  return { sessions: enrichedSessions, slots: compactSlots };
}
