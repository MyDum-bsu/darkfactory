// Iva-Loop v0: one local observation pass, no controller/Board client. Without
// explicit destinations nothing is written. A cursor belongs to one observer.
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readFile, readdir, realpath, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const logs = ['daemon.jsonl', 'events.ndjson', 'telemetry.jsonl'];
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

export function normalizeErrorMessage(msg) {
  return String(msg ?? '')
    .replace(/\b\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:?\d\d)?\b/gi, '<time>')
    .replace(/\b[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}\b/gi, '<id>')
    .replace(/\b((?:attempt|task|request|thread|trace|run)[_-]?id)(\s*[:=#]\s*|\s+)([\w.-]+|<id>)/gi, '$1$2<id>')
    .replace(/\b(attempt|task|request|thread|trace|run)(\s*[:=#]\s*|[-_](?!id\b)|\s+(?=\d))([\w.-]+|<id>)/gi, '$1$2<id>')
    .replace(/\b(?:0x[\da-f]+|[\da-f]{7,64})\b/gi, '<hex>')
    .replace(/(\.[cm]?[jt]sx?|\.py|\.go|\.rs):\d+(?::\d+)?\b/gi, '$1:<line>')
    .replace(/\bline\s+\d+(?::\d+)?\b/gi, 'line <line>')
    .replace(/\s+/g, ' ').trim();
}

export function fingerprintObservation({ source, code, module, message }) {
  return createHash('sha256').update([source, code, module, normalizeErrorMessage(message)].join('|')).digest('hex');
}

// Specific causes precede wrappers (a board 503 is not a provider outage;
// a tick_error with a TypeError stack is not a bug if fetch timed out).
const outage = /\b(?:429|5\d\d|5xx|quota exhausted|rate limit\w*|timed? out|timeout|unavailable)\b/i;
const network = /\b(?:econnreset|econnrefused|etimedout|eai again|enotfound|network|fetch failed|socket hang up|bad gateway)\b/i;
const rules = [
  ['host_resource', s => /\b(disk (?:budget (?:blocked|degraded)|blocked)|enospc|ram low|oom(?: killed)?|out of memory)\b/i.test(s)],
  ['infra_preemption', s => /\b(?:spot preempt\w*|lease lost|(?:pane|worker turn finished) .*?(?:without|no|missing) (?:a |new )?handoff)\b/i.test(s)],
  ['agent_misbehavior', s => /\b(tamper gate failed|scope fence violation|loop abort\w*|loop detected)\b/i.test(s)],
  ['board_transient', s => /\bboard\b/i.test(s) && (outage.test(s) || network.test(s) || /\b(?:transient|408)\b/i.test(s))],
  ['provider_outage', s => outage.test(s)],
  ['factory_bug', (s, obs) => !network.test(s) && (/\bcontroller exception\b/i.test(s) ||
    (/\btick error\b/i.test(s) && (Boolean(obs.stack) || /\b(?:TypeError|ReferenceError)\b|\bat \S+ \(/.test(s))))],
];

export function classifyObservation(obs) {
  const text = [obs.source, obs.module, obs.code, obs.event, obs.phase, obs.reason, obs.status,
    normalizeErrorMessage(obs.message), normalizeErrorMessage(obs.stack)]
    .filter(v => v != null).join(' ').replace(/[_-]/g, ' ');
  return rules.find(([, matches]) => matches(text, obs))?.[0] ?? 'unknown';
}

const verifiedOutcomes = new Set(['done', 'verified']);
const blockedOutcomes = new Set(['blocked', 'hold', 'uncertain', 'lease_lost']);

function observation(row, log) {
  const detail = row.detail ?? {};
  const reason = row.reason ?? detail.reason;
  const code = row.code ?? detail.code ?? reason ?? row.event ?? row.kind ?? row.outcome ?? '';
  const obs = {
    source: row.source ?? log.split('.')[0], module: row.module ?? detail.module ?? row.role ?? '', code,
    message: row.message ?? detail.message ?? row.error?.message ?? (typeof row.error === 'string' ? row.error : reason) ?? '',
    reason, event: row.event ?? row.kind, phase: row.phase ?? detail.phase ?? row.outcome,
    stack: row.stack ?? detail.stack ?? row.error?.stack, status: row.status ?? detail.status ?? row.statusCode,
  };
  const classification = classifyObservation(obs);
  if (classification === 'unknown' && !row.error &&
      !blockedOutcomes.has(row.outcome ?? row.phase ?? detail.phase) &&
      !/error|fail|blocked|exception|abort/i.test([row.level, row.event, row.kind, code, obs.message].join(' '))) return null;
  return { ...obs, classification };
}

function collect(state, row, log, ref) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return;
  const attempt = row.attempt_id ?? row.attemptId ?? row.detail?.attempt_id;
  if (log === 'telemetry.jsonl' && row.kind === 'attempt_summary') {
    // Repeated or open-then-closed summaries describe one attempt, not two.
    const key = attempt ?? JSON.stringify(ref);
    const summary = { attempt_id: key, outcome: row.outcome, open: row.open === true, rounds: { rework: row.rounds?.rework ?? 0 } };
    if (!summary.open || state.telemetry[key]?.open !== false) state.telemetry[key] = summary;
    if (summary.open || verifiedOutcomes.has(summary.outcome)) return;
  }
  const obs = observation(row, log);
  if (!obs) return;
  const fp = fingerprintObservation(obs);
  const item = state.groups[fp] ??= {
    fp, source: obs.source, code: obs.code, module: obs.module, message: normalizeErrorMessage(obs.message), class: obs.classification,
    occurrences: 0, attempts: [], firstSeen: null, lastSeen: null, evidence: [],
  };
  item.occurrences++;
  if (attempt != null && !item.attempts.includes(attempt)) item.attempts.push(attempt);
  const time = new Date(row.ts ?? row.timestamp ?? row.ended_at ?? NaN);
  if (Number.isFinite(time.getTime())) {
    const iso = time.toISOString();
    if (!item.firstSeen || iso < item.firstSeen) item.firstSeen = iso;
    if (!item.lastSeen || iso > item.lastSeen) item.lastSeen = iso;
  }
  if (item.evidence.length < 20) item.evidence.push(ref);
}

// Writers use both daemon.1.jsonl / events.1.ndjson and telemetry.jsonl.1.
function generation(name, log) {
  if (name === log) return 0;
  const [stem, ext] = log.split('.');
  const m = name.match(/^(\w+)\.(\d+)\.(\w+)$/);
  if (m && m[1] === stem && m[3] === ext) return +m[2];
  if (name.startsWith(log + '.') && /^\d+$/.test(name.slice(log.length + 1))) return +name.slice(log.length + 1);
  return -1;
}

async function optional(action) {
  try { return await action(); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

async function readLines(handle, start, size, visit) {
  let offset = start;
  let pending = [];
  if (start < size) {
    for await (const chunk of handle.createReadStream({ start, end: size - 1, autoClose: false })) {
      let begin = 0;
      for (let nl; (nl = chunk.indexOf(10, begin)) !== -1; begin = nl + 1) {
        pending.push(chunk.subarray(begin, nl));
        const line = pending.length === 1 ? pending[0] : Buffer.concat(pending);
        let row;
        try { row = JSON.parse(line.toString('utf8')); } catch { /* skip a malformed complete line */ }
        if (row) visit(row, offset);
        offset += line.length + 1;
        pending = [];
      }
      if (begin < chunk.length) pending.push(chunk.subarray(begin));
    }
  }
  return offset; // leave an unterminated (possibly split UTF-8) line for the next pass
}

async function scanLog(dir, log, state) {
  const path = join(dir, log);
  const previous = state.files[path] ?? {};
  const pinned = new Map();
  const names = new Map();
  // Pin the active inode before discovering its predecessors: a concurrent
  // rename can then expose it twice, but cannot change what its fd reads.
  async function pin(name) {
    const handle = await optional(() => open(join(dir, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK));
    if (!handle) return;
    try {
      const stat = await handle.stat({ bigint: true });
      if (!stat.isFile()) throw new Error(`Not a regular log: ${name}`);
      const ino = String(stat.ino);
      names.set(name, ino);
      if (!pinned.has(ino)) {
        pinned.set(ino, { handle, name, size: Number(stat.size) });
        return;
      }
    } catch (error) { await handle.close(); throw error; }
    await handle.close();
  }
  try {
    await pin(log);
    const rotations = (await readdir(dir)).filter(n => generation(n, log) > 0)
      .sort((a, b) => generation(a, log) - generation(b, log));
    for (const name of rotations) await pin(name);
    // If the directory changed while opening the chain, don't checkpoint a
    // mixed set (it could omit a generation already visited on the last pass).
    const now = (await readdir(dir)).filter(n => generation(n, log) >= 0);
    const unchanged = now.length === names.size && (await Promise.all(now.map(async name => {
      const stat = await optional(() => lstat(join(dir, name), { bigint: true }));
      return stat && String(stat.ino) === names.get(name);
    }))).every(Boolean);
    if (!unchanged) throw new Error(`Rotation in progress: retry observing ${path}`);
    if (previous[log] && !pinned.has(previous[log].ino)) throw new Error(`Rotation gap: previous inode of ${path} is no longer retained`);
    const byInode = new Map(Object.entries(previous).map(([name, entry]) => [entry.ino, { ...entry, generation: generation(name, log) }]));
    const current = {};
    for (const [ino, { handle, name, size }] of [...pinned].reverse()) {
      // Rotation only moves an inode toward an older generation. A retired
      // inode number reused for the new active log is a fresh stream.
      const prior = byInode.get(ino);
      const start = prior && prior.generation <= generation(name, log) ? prior.offset : 0;
      if (!Number.isSafeInteger(start) || start < 0 || start > size) throw new Error(`Invalid offset or truncated log: ${path}`);
      const offset = await readLines(handle, start, size, (row, byte) => collect(state, row, log, { path, ino, offset: byte }));
      current[name] = { ino, offset };
    }
    state.files[path] = current;
  } finally { await Promise.all([...pinned.values()].map(({ handle }) => handle.close())); }
}

async function destination(path) {
  if (path == null) return null;
  const name = basename(path);
  if (logs.some(log => generation(name, log) >= 0)) throw new Error(`Refusing journal destination: ${path}`);
  const full = join(await realpath(dirname(resolve(path))), name);
  const stat = await optional(() => lstat(full));
  if (stat && (!stat.isFile() || stat.nlink !== 1)) throw new Error(`Unsafe destination: ${path}`);
  return full;
}

async function atomicWrite(path, content) {
  const temp = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temp, 'wx', 0o600);
  try {
    try { await handle.writeFile(content); } finally { await handle.close(); }
    await rename(temp, path);
  } finally { await optional(() => unlink(temp)); }
}

export async function scanStateDirs({ stateDirs, cursorPath, outPath }) {
  if (!stateDirs?.length) throw new Error('At least one state directory is required');
  const cursor = await destination(cursorPath);
  const out = await destination(outPath);
  if (cursor && cursor === out) throw new Error('Cursor and incident destinations must differ');
  const saved = cursor && await optional(() => readFile(cursor, 'utf8'));
  const state = saved == null ? { version: 1, files: {}, groups: {}, telemetry: {} } : JSON.parse(saved);
  if (state.version !== 1) throw new Error('Unsupported sentinel cursor version');
  state.telemetry = Object.assign(Object.create(null), state.telemetry);
  for (const dir of [...new Set(await Promise.all(stateDirs.map(d => realpath(d))))].sort()) {
    for (const log of logs) await scanLog(dir, log, state);
  }
  const incidents = Object.values(state.groups).map(({ attempts, ...item }) => ({ ...item, distinctAttempts: attempts.length }))
    .sort((a, b) => compare(a.fp, b.fp));
  // Publish a snapshot, not deltas. If interrupted between renames, replay
  // from the old checkpoint replaces the snapshot rather than appending twice.
  if (out) await atomicWrite(out, incidents.map(i => JSON.stringify(i) + '\n').join(''));
  if (cursor) await atomicWrite(cursor, JSON.stringify(state) + '\n');
  return { telemetry: Object.values(state.telemetry), incidents };
}

export function buildHealthDigest({ telemetry, incidents }) {
  let verified = 0, blocked = 0, firstPass = 0;
  const reworks = [];
  for (const row of telemetry) {
    if (row.open) continue;
    const rework = row.rounds?.rework ?? 0;
    if (verifiedOutcomes.has(row.outcome)) { verified++; if (rework === 0) firstPass++; }
    else if (blockedOutcomes.has(row.outcome)) blocked++;
    else continue;
    reworks.push(rework);
  }
  reworks.sort((a, b) => a - b);
  const n = reworks.length;
  const byClass = {};
  for (const item of incidents) byClass[item.class] = (byClass[item.class] ?? 0) + item.occurrences;
  const topFingerprints = incidents.filter(i => i.occurrences > 1)
    .sort((a, b) => b.occurrences - a.occurrences || compare(a.fp, b.fp)).slice(0, 5)
    .map(({ fp, occurrences }) => ({ fp, occurrences }));
  return { verified, blocked, firstPassRate: n ? firstPass / n : null,
    medianRework: n ? (reworks[(n - 1) >> 1] + reworks[n >> 1]) / 2 : null, byClass, topFingerprints };
}

export function formatHealthDigest(d) {
  return ['Factory State of Health', `Attempts: ${d.verified} verified, ${d.blocked} blocked`,
    `First-pass rate: ${d.firstPassRate == null ? 'n/a' : (100 * d.firstPassRate).toFixed(1) + '%'}`,
    `Median rework: ${d.medianRework ?? 'n/a'}`,
    'Incident occurrences: ' + (Object.keys(d.byClass).sort().map(k => `${k}=${d.byClass[k]}`).join(', ') || 'none'),
    'Top recurring fingerprints: ' + (d.topFingerprints.map(i => `${i.fp} (${i.occurrences})`).join(', ') || 'none')].join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values: v } = parseArgs({ options: { observe: { type: 'boolean' }, 'state-dir': { type: 'string', multiple: true },
      cursor: { type: 'string' }, out: { type: 'string' }, digest: { type: 'boolean' }, json: { type: 'boolean' } } });
    if (!v.observe || !v['state-dir']?.length) throw new Error('Usage: --observe --state-dir <dir> [--cursor <file>] [--out <file>] [--digest] [--json]');
    const result = await scanStateDirs({ stateDirs: v['state-dir'], cursorPath: v.cursor, outPath: v.out });
    if (v.digest) {
      const digest = buildHealthDigest(result);
      console.log(v.json ? JSON.stringify(digest) : formatHealthDigest(digest));
    } else if (v.json) console.log(JSON.stringify(result));
    else for (const incident of result.incidents) console.log(JSON.stringify(incident));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
