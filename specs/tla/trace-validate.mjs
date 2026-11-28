// Replay a complete events.ndjson (or a prefix starting at claim) from the
// verified route. Phase events expose launch *intents*, worker identities and
// checked SHAs, not actual process liveness, policy seals, worker turn seqs,
// hc addresses, ref CAS or scheduler locks. Check necessary observable safety
// conditions; never manufacture evidence for the unobservable guards.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requireGreen, runTlc } from './check.mjs';

const kinds = { claiming: 'phase', launching: 'phase', working: 'phase', checking: 'phase',
  returning: 'phase', blocking: 'phase', done: 'completed', uncertain: 'uncertain',
  hold: 'hold', lease_lost: 'lease_lost' };
const terminal = new Set(['done', 'hold', 'lease_lost', 'uncertain']);
const sha = v => typeof v === 'string' && /^[0-9a-f]{40}$/.test(v);
const text = v => typeof v === 'string' && v.length > 0;

function project(ndjson) {
  const attempts = new Map(), launches = new Map(), epochs = new Map(), rows = [];
  let lastSeq = 0, line = 0;
  for (const raw of ndjson.split('\n')) {
    line++;
    if (!raw.trim()) continue;
    const fail = why => { throw new Error(`events.ndjson:${line}: ${why}`); };
    let e;
    try { e = JSON.parse(raw); } catch { fail('invalid JSON'); }
    if (!e || !text(e.kind) || !Number.isSafeInteger(e.seq) || e.seq < 1) fail('invalid event');
    // A new event bus (e.g. the next controller invocation) starts again at 1.
    if (e.seq !== 1 && e.seq !== lastSeq + 1) fail('incomplete or reordered journal');
    lastSeq = e.seq;
    if (e.role !== 'controller' && e.kind !== 'rework') {
      if (Object.values(kinds).includes(e.kind)) fail('missing controller role');
      continue; // daemon, stage and other non-controller telemetry
    }
    if (!text(e.attempt_id)) fail('missing attempt_id');
    const a = attempts.get(e.attempt_id);
    if (e.kind === 'rework') {
      if (!a || a.phase !== 'working' || e.phase !== 'working' || e.epoch !== a.epoch ||
          e.task_id !== a.task || !a.feedback) fail('rework without feedback receipt');
      a.feedback = false;
      continue;
    }
    if (!Object.hasOwn(kinds, e.phase) || e.kind !== kinds[e.phase]) fail(`unsupported phase/kind: ${e.phase}/${e.kind}`);
    if (e.phase === 'claiming') {
      if (a || e.epoch !== undefined) fail('duplicate claim');
      attempts.set(e.attempt_id, { phase: 'claiming', task: e.task_id, writers: new Set(), seen: new Set() });
      continue;
    }
    if (!a || terminal.has(a.phase)) fail('missing claim or event after terminal');
    if (!text(e.task_id) || !Number.isSafeInteger(e.epoch) || e.epoch < 1 ||
        (a.task !== undefined && e.task_id !== a.task) || (a.epoch !== undefined && e.epoch !== a.epoch)) {
      fail('task/epoch mismatch');
    }
    a.task = e.task_id; a.epoch = e.epoch;
    const task = JSON.stringify([e.project, e.channel, a.task]);
    if (a.domain !== undefined && a.domain !== task) fail('project/channel mismatch');
    a.domain = task;
    epochs.set(task, Math.max(epochs.get(task) ?? 0, a.epoch));
    const key = JSON.stringify([task, a.epoch]);
    const thread = e.detail?.threadId;
    if (text(thread)) a.writers.add(thread);
    if (e.phase === 'launching') {
      launches.set(key, (launches.get(key) ?? 0) + 1);
      if (a.phase !== 'claiming' && launches.get(key) === 1) fail('launch without claim');
    } else if (e.phase === 'working') {
      if (!['launching', 'returning'].includes(a.phase) || !text(thread)) fail('working without worker receipt');
      a.feedback = a.phase === 'returning';
    } else if (e.phase === 'checking') {
      if (a.phase !== 'working' || !sha(e.detail?.sha) || !text(thread) || a.seen.has(e.detail.sha)) {
        fail('invalid or reused checking subject');
      }
      a.pending = e.detail.sha;
      a.seen.add(a.pending);
    } else if (e.phase === 'returning') {
      if (a.phase !== 'checking' || a.pending !== e.detail?.sha) fail('feedback subject mismatch');
      a.pending = undefined; // rejected: cannot be used for a later complete
    } else if (e.phase === 'done') {
      if (!sha(e.detail?.sha) || !text(thread)) fail('invalid completed subject');
    } else {
      a.pending = undefined;
    }
    a.phase = e.phase;
    rows.push({ line, epoch: a.epoch, currentEpoch: epochs.get(task), writers: a.writers.size,
      launches: launches.get(key) ?? 0, done: e.phase === 'done',
      candidate: e.phase === 'done' ? e.detail.sha : 'none', checked: a.pending ?? 'none' });
  }
  if (!rows.length) throw new Error('no bound controller phase events');
  return rows;
}

// A Node-only L1 can check the observable projection without installing Java.
// This is not TLC evidence. Keep the model as an independent oracle: whenever
// TLC is configured it evaluates the same rows, not the result of these tests.
function checkObserved(row) {
  const fail = name => { throw new Error(`events.ndjson:${row.line}: ${name}`); };
  if (row.writers > 1) fail('SingleLiveWriter');
  if (row.launches > 1) fail('NoDuplicateSpawn');
  if (!row.done) return;
  if (row.checked === 'none') fail('NoBlindRoundClose');
  if (row.epoch !== row.currentEpoch || row.candidate !== row.checked) fail('NoStaleCommit');
}

// Only the projector's fixed keys, checked integers, booleans and SHA/none
// strings enter TLA source; raw events are never interpolated.
function tlaRecord(row) {
  const literal = v => typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : JSON.stringify(v);
  return `[${Object.entries(row).map(([k, v]) => `${k} |-> ${literal(v)}`).join(', ')}]`;
}

export async function validateTrace(ndjson, { engine = process.env.TLA_TOOLS_JAR === undefined ? 'node' : 'tlc' } = {}) {
  const rows = project(ndjson);
  if (engine === 'node') {
    rows.forEach(checkObserved);
    return { engine, states: rows.length };
  }
  if (engine !== 'tlc') throw new Error(`unknown trace engine: ${engine}`);
  // A requested or configured TLC engine must succeed; never downgrade on error.
  const module = `---- MODULE TraceReplay ----
EXTENDS ControllerProtocol, Sequences
VARIABLE cursor
Rows == <<${rows.map(tlaRecord).join(',\n')}>>
Row == Rows[cursor]
Observed == INSTANCE ControllerProtocol WITH
    liveWriters <- 1..Row.writers, spawnCount <- [e \\in 1..MaxEpoch |-> Row.launches],
    boardState <- IF Row.done THEN "completed" ELSE "claimed",
    boardEpoch <- Row.currentEpoch, commitEpoch <- Row.epoch,
    candidateDigest <- Row.candidate, verifiedDigest <- Row.checked
TraceInit == Init /\\ cursor = 1
TraceNext == cursor < Len(Rows) /\\ cursor' = cursor + 1 /\\ UNCHANGED vars
TraceSingleLiveWriter == Observed!SingleLiveWriter
TraceNoDuplicateSpawn == Observed!NoDuplicateSpawn
TraceNoStaleCommit == Row.checked # "none" => Observed!NoStaleCommit
TraceNoBlindRoundClose == Observed!NoBlindRoundClose
====`;
  const dir = await mkdtemp(join(tmpdir(), 'trace-replay-'));
  try {
    const path = join(dir, 'TraceReplay.tla');
    await writeFile(path, module);
    const base = await readFile(new URL('ControllerProtocol.cfg', import.meta.url), 'utf8');
    const config = base.split('SPECIFICATION Spec')[0] + 'INIT TraceInit\nNEXT TraceNext\n' +
      ['SingleLiveWriter', 'NoDuplicateSpawn', 'NoStaleCommit', 'NoBlindRoundClose']
        .map(name => `INVARIANT Trace${name}\n`).join('');
    requireGreen(await runTlc(path, config));
    return { engine, states: rows.length };
  } finally { await rm(dir, { recursive: true, force: true }); }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const requireTlc = args[0] === '--tlc';
  if (args.length !== (requireTlc ? 2 : 1)) throw new Error('usage: node trace-validate.mjs [--tlc] <events.ndjson>');
  console.log(await validateTrace(await readFile(args.at(-1), 'utf8'), requireTlc ? { engine: 'tlc' } : {}));
}
