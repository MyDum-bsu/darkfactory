import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFile, link, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeErrorMessage, fingerprintObservation, classifyObservation, scanStateDirs,
  detectStaleBoardTasks, buildHealthDigest, formatHealthDigest } from './df-sentinel.mjs';

const line = row => JSON.stringify(row) + '\n';
const cli = fileURLToPath(new URL('./df-sentinel.mjs', import.meta.url));
const outage = (attempt_id, ts) => ({ event: 'tick_error', message: 'API 503 — déconnecté', attempt_id, ts });
const summary = (attempt_id, outcome, rework, open = false) => ({ kind: 'attempt_summary', attempt_id, outcome, rounds: { rework }, open });
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'sentinel-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, 'state');
  await mkdir(dir);
  return { root, dir, opts: { stateDirs: [dir], cursorPath: join(root, 'cursor.json'), outPath: join(root, 'incidents.ndjson') } };
}

test('fingerprint is exactly SHA-256 of stable source|code|module|normalized message', () => {
  const a = '2026-02-12T21:01:14.003Z  request_id=xyz-111 task 123 at a.mjs:10:41 deadbeef 22ef7133-df1f-4502-9948-0dae519bb225 HTTP 503';
  const b = '2025-09-02T02:05:04+00:00 request_id=abc-010 task 987 at a.mjs:3:22 abacafe0 04ce5131-516d-4e2e-98cb-0b47b0cf4309 HTTP 503';
  const obs = { source: 'events', code: 'err', module: 'net', message: a };
  const fp = fingerprintObservation(obs);
  assert.equal(fp, createHash('sha256').update(`events|err|net|${normalizeErrorMessage(a)}`).digest('hex'));
  assert.equal(fp, fingerprintObservation({ ...obs, message: b }));
  for (const change of [{ source: 'daemon' }, { code: 'other' }, { module: 'fs' }, { message: b.replace('503', '401') }]) {
    assert.notEqual(fp, fingerprintObservation({ ...obs, ...change }));
  }
});

test('queue findings reflect the current snapshot, with a strict age boundary and optional digest check', async t => {
  const nowMs = Date.parse('2026-11-25T00:00:00Z');
  const cutoff = nowMs - 72 * 3600_000;
  const tasks = [{ message: { id: 'a', task: { state: 'blocked' }, createdAt: new Date(cutoff - 1).toISOString() } },
    { id: 'b', state: 'blocked', updated_at: cutoff }, { id: 'c', state: 'ready' },
    { id: 'd', state: 'ready', labels: { policy_digest: 'old' } }, { id: 'e', state: 'ready', labels: { policy_digest: 'active' } },
    { id: 'f', state: 'done' }, { id: 'g', state: 'blocked', updated_at: 'invalid' }];
  const options = { nowMs, activePolicyDigests: ['active'] };
  const findings = detectStaleBoardTasks(tasks, options);
  assert.deepEqual(findings.map(f => [f.task_id, f.code]), [['a', 'stale_blocked'], ['c', 'policy_digest_drift_ready'], ['d', 'policy_digest_drift_ready']]);
  assert.deepEqual(detectStaleBoardTasks(tasks, { nowMs }), [findings[0]]);
  assert.deepEqual(detectStaleBoardTasks(tasks, { nowMs, blockedMaxAgeHours: 73 }), []);
  const { root, dir, opts } = await fixture(t);
  const snapshot = join(root, 'tasks.json');
  await writeFile(snapshot, JSON.stringify({ tasks: tasks.filter(t => t.state === 'ready') }));
  const report = JSON.parse(execFileSync(process.execPath, [cli, '--observe', '--state-dir', dir, '--board-tasks', snapshot,
    '--active-policy-digest', 'active', '--json']));
  assert.deepEqual(report.incidents.map(i => i.evidence[0].task_id), ['c', 'd']);
  const { incidents } = await scanStateDirs({ ...opts, boardTasks: tasks, ...options });
  assert.deepEqual(incidents.map(i => i.code).sort(), findings.map(f => f.code).sort());
  assert.deepEqual((await scanStateDirs({ ...opts, boardTasks: [], ...options })).incidents, []);
});

const cases = {
  provider_outage: ['HTTP 429', 'api_503', '5xx', 'quota_exhausted', 'rate limited', 'timeout', 'service unavailable'],
  board_transient: ['board HTTP 502', 'Board ECONNRESET', 'board request timed out', 'board fetch failed'],
  host_resource: ['disk_budget_blocked', 'ENOSPC', 'ram_low', 'OOM', 'out of memory'],
  infra_preemption: ['Spot preemption', 'lease_lost', 'terminated pane without handoff', 'worker_turn_finished_without_handoff'],
  agent_misbehavior: ['tamper_gate_failed', 'scope_fence_violation', 'loop abort', 'loop_detected'],
};
for (const [expected, examples] of Object.entries(cases)) {
  test(`${expected} takes precedence over tick_error and a stack`, () => {
    for (const message of examples) {
      assert.equal(classifyObservation({ code: 'tick_error', message, stack: 'TypeError: wrapper\n    at controller (tick.mjs:503:4)' }), expected, message);
    }
  });
}
test('factory_bug requires evidence; unknown is not an accusation', () => {
  for (const obs of [{ code: 'tick_error', stack: 'at tick' }, { code: 'tick_error', message: 'ReferenceError: missing x' },
    { code: 'tick_error', message: 'TypeError at tick.mjs:500:4' }, { code: 'controller_exception' }]) {
    assert.equal(classifyObservation(obs), 'factory_bug');
  }
  for (const obs of [{ code: 'tick_error' }, { code: 'unrecognized_error' }, { source: 'board', status: 403 },
    { code: 'tick_error', message: 'TypeError: fetch failed' }]) assert.equal(classifyObservation(obs), 'unknown');
  assert.equal(classifyObservation({ module: 'board', status: 503 }), 'board_transient');
});

for (const [active, rotated] of [['daemon.jsonl', 'daemon.1.jsonl'], ['events.ndjson', 'events.1.ndjson'],
  ['telemetry.jsonl', 'telemetry.jsonl.1']]) {
  test(`${active}: resume old inode at byte boundary, then consume new inode once`, async t => {
    const { dir, opts } = await fixture(t);
    const path = join(dir, active);
    const first = line(outage('a', '2026-01-03T00:00:00Z'));
    const second = Buffer.from(line(outage('b', '2026-01-02T00:00:00Z')));
    const split = second.indexOf('é') + 1;
    await writeFile(path, Buffer.concat([Buffer.from(first), second.subarray(0, split)]));
    const oldIno = String((await stat(path, { bigint: true })).ino);
    assert.equal((await scanStateDirs(opts)).incidents[0].occurrences, 1);
    const saved = JSON.parse(await readFile(opts.cursorPath));
    assert.deepEqual(saved.files[path][active], { ino: oldIno, offset: Buffer.byteLength(first) });
    await appendFile(path, second.subarray(split));
    await rename(path, join(dir, rotated));
    await writeFile(path, line(outage('a', '2026-01-01T00:00:00Z')));
    const result = await scanStateDirs(opts);
    assert.equal(result.incidents.length, 1);
    const [item] = result.incidents;
    assert.equal(item.occurrences, 3);
    assert.equal(item.distinctAttempts, 2);
    assert.equal(item.firstSeen, '2026-01-01T00:00:00.000Z');
    assert.equal(item.lastSeen, '2026-01-03T00:00:00.000Z');
    assert.deepEqual(item.evidence.map(r => [r.ino, r.offset]), [[oldIno, 0], [oldIno, Buffer.byteLength(first)], [String((await stat(path)).ino), 0]]);
    assert.deepEqual(await scanStateDirs(opts), result);
    assert.deepEqual(JSON.parse(await readFile(opts.outPath)), item);
  });
}

test('aggregates across dirs and checkpoints, caps evidence not counts, ignores normal/malformed lines', async t => {
  const { dir, root, opts } = await fixture(t);
  const second = join(root, 'another');
  await mkdir(second);
  opts.stateDirs.push(second, dir);
  for (const [i, d] of [second, dir].entries()) {
    const rows = Array.from({ length: 12 }, (_, j) => ({ kind: 'daemon.ontick_error', attempt_id: `id-${i}-${j}`,
      detail: { code: 'network_error', module: 'board', message: `ECONNRESET request_id=r-${i}-${j}` } }));
    await writeFile(join(d, 'events.ndjson'), line({ kind: 'daemon.started' }) + 'not json\nnull\n' + rows.map(line).join(''));
  }
  await scanStateDirs(opts);
  await appendFile(join(dir, 'events.ndjson'), line({ kind: 'custom_error', message: 'something unusual' }));
  const { incidents } = await scanStateDirs(opts);
  assert.deepEqual(incidents.map(i => i.class).sort(), ['board_transient', 'unknown']);
  const net = incidents.find(i => i.class === 'board_transient');
  assert.equal(net.occurrences, 24);
  assert.equal(net.distinctAttempts, 24);
  assert.equal(net.evidence.length, 20);
  assert.deepEqual((await readFile(opts.outPath, 'utf8')).trim().split('\n').map(JSON.parse), incidents);
});

test('retired inode reused as active is fresh; replay after interrupted publication is idempotent', async t => {
  const { dir, opts } = await fixture(t);
  const path = join(dir, 'daemon.jsonl');
  const old = join(dir, 'daemon.1.jsonl');
  await writeFile(old, line(outage('retired')));
  await writeFile(path, line(outage('initial')));
  await scanStateDirs(opts);
  const checkpoint = await readFile(opts.cursorPath);
  await appendFile(path, line(outage('tail')));
  // Simulate inode recycling deterministically, without relying on allocation order.
  const recycled = join(dir, 'recycled');
  await rename(old, recycled);
  await rename(path, old);
  await rename(recycled, path);
  await writeFile(path, line(outage('new')));
  const expected = await scanStateDirs(opts);
  assert.equal(expected.incidents[0].occurrences, 4);
  const snapshot = await readFile(opts.outPath);
  await writeFile(opts.cursorPath, checkpoint);
  assert.deepEqual(await scanStateDirs(opts), expected);
  assert.deepEqual(await readFile(opts.outPath), snapshot);
});

test('rotation beyond retention fails explicitly without advancing checkpoint or report', async t => {
  const { dir, opts } = await fixture(t);
  const path = join(dir, 'daemon.jsonl');
  await writeFile(path, line(outage('a')));
  await scanStateDirs(opts);
  const before = await Promise.all([opts.cursorPath, opts.outPath].map(p => readFile(p)));
  await rename(path, join(dir, 'discarded'));
  await writeFile(path, line(outage('b')));
  await assert.rejects(scanStateDirs(opts), /rotation gap/i);
  assert.deepEqual(await Promise.all([opts.cursorPath, opts.outPath].map(p => readFile(p))), before);
});

test('optional writers cannot target a journal, a file alias, or one another', async t => {
  const { dir, root, opts } = await fixture(t);
  const path = join(dir, 'daemon.jsonl');
  const text = line(outage('a'));
  await writeFile(path, text);
  await symlink(path, join(root, 'alias'));
  await link(path, join(root, 'hard'));
  for (const target of [path, join(dir, 'events.1.ndjson'), join(dir, 'telemetry.jsonl.1'), join(root, 'alias'), join(root, 'hard')]) {
    for (const field of ['cursorPath', 'outPath']) await assert.rejects(scanStateDirs({ ...opts, [field]: target }), /destination/i);
  }
  await assert.rejects(scanStateDirs({ ...opts, cursorPath: opts.outPath }), /must differ/);
  assert.equal(await readFile(path, 'utf8'), text);
  assert.deepEqual(await readdir(dir), ['daemon.jsonl']);
});

test('digest counts closed attempts, includes failures in first-pass denominator and orders recurring fingerprints', () => {
  const telemetry = [summary('1', 'verified', 0), summary('2', 'done', 3), summary('3', 'hold', 1), summary('4', 'blocked', 2), summary('5', 'hold', 0, true)];
  const incidents = [['b', 2], ['a', 2], ['c', 1]].map(([fp, occurrences]) => ({ fp, occurrences, class: 'host_resource' }));
  const digest = buildHealthDigest({ telemetry, incidents });
  assert.deepEqual(digest, { verified: 2, blocked: 2, firstPassRate: 0.25, medianRework: 1.5, byClass: { host_resource: 5 },
    topFingerprints: [{ fp: 'a', occurrences: 2 }, { fp: 'b', occurrences: 2 }] });
  assert.equal(formatHealthDigest(digest), 'Factory State of Health\nAttempts: 2 verified, 2 blocked\nFirst-pass rate: 25.0%\nMedian rework: 1.5\nIncident occurrences: host_resource=5\nTop recurring fingerprints: a (2), b (2)');
  assert.match(formatHealthDigest(buildHealthDigest({ telemetry: [], incidents: [] })), /First-pass rate: n\/a/);
});

test('CLI --observe --digest --json reads multiple state dirs without side effects', async t => {
  const { root, dir } = await fixture(t);
  const telemetry = [summary('same', 'working', 0, true), summary('same', 'done', 0), summary('same', 'done', 0),
    { ...summary('other', 'hold', 1), reason: 'lease_lost' }].map(line).join('');
  await writeFile(join(dir, 'telemetry.jsonl'), telemetry);
  await writeFile(join(root, 'daemon.jsonl'), line({ event: 'daemon_start' }));
  const args = [cli, '--observe', '--state-dir', root, '--state-dir', dir, '--digest'];
  const digest = JSON.parse(execFileSync(process.execPath, [...args, '--json']));
  assert.deepEqual(digest, { verified: 1, blocked: 1, firstPassRate: 0.5, medianRework: 0.5, byClass: { infra_preemption: 1 }, topFingerprints: [] });
  assert.equal(execFileSync(process.execPath, args, { encoding: 'utf8' }).trimEnd(), formatHealthDigest(digest));
  assert.deepEqual((await readdir(root)).sort(), ['daemon.jsonl', 'state']);
  assert.deepEqual(await readdir(dir), ['telemetry.jsonl']);
  assert.equal(await readFile(join(dir, 'telemetry.jsonl'), 'utf8'), telemetry);
});
