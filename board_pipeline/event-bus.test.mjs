import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createEventBus, createNoopEventBus, normalizeEvent } from './event-bus.mjs';

const dir = () => mkdtemp(join(tmpdir(), 'df-event-bus-'));

test('normalizeEvent keeps schema fields and drops unknown keys', () => {
  const event = normalizeEvent({
    task_id: '1672', attempt_id: 'a-b', epoch: 2, kind: 'phase',
    phase: 'working', role: 'writer', mode: 'write', model: 'swe-2-high',
    tokens: 1234, round: 2, reason: 'r', detail: { a: 1, b: ['x'], c: { d: 'deep' } },
    bogus: 'drop me', seq: 99, deadline_rem_ms: 5000,
  });
  assert.equal(event.task_id, '1672');
  assert.equal(event.epoch, 2);
  assert.equal(event.deadline_rem_ms, 5000);
  assert.equal(event.detail.c.d, 'deep');
  assert.equal(event.bogus, undefined);
  assert.equal(event.seq, 99);
});

test('normalizeEvent sanitizes detail depth and string size', () => {
  const event = normalizeEvent({ detail: { l1: { l2: { l3: 'cut' } }, s: 'x'.repeat(5000) } });
  assert.equal(event.detail.l1.l2, undefined);
  assert.equal(event.detail.s.length, 1024);
  const bad = normalizeEvent({ kind: 42, epoch: 'nope' });
  assert.equal(bad.kind, undefined);
  assert.equal(bad.epoch, undefined);
});

test('bus writes structured events to events.ndjson with seq and ts', async () => {
  const stateDir = await dir();
  const bus = createEventBus({ stateDir, socketPath: null, project: 'p1', channel: 'ch' });
  const e1 = bus.emit({ kind: 'phase', phase: 'claiming', task_id: '1' });
  const e2 = bus.emit({ kind: 'phase', phase: 'working', task_id: '1' });
  await bus.close();
  assert.equal(e1.seq, 1);
  assert.equal(e2.seq, 2);
  assert.ok(e1.ts);
  const lines = (await readFile(join(stateDir, 'events.ndjson'), 'utf8')).trim().split('\n');
  assert.equal(lines.length, 2);
  const parsed = lines.map(l => JSON.parse(l));
  assert.equal(parsed[0].phase, 'claiming');
  assert.equal(parsed[1].phase, 'working');
  assert.equal(parsed[0].project, 'p1');
  assert.equal(parsed[0].channel, 'ch');
  const st = await stat(join(stateDir, 'events.ndjson'));
  assert.equal(st.mode & 0o777, 0o600);
});

test('rotation keeps <= keep generations under maxBytes', async () => {
  const stateDir = await dir();
  const bus = createEventBus({ stateDir, socketPath: null, maxBytes: 300, keep: 2 });
  for (let i = 0; i < 30; i++) bus.emit({ kind: 'tick', detail: { n: i, pad: 'x'.repeat(50) } });
  await bus.close();
  const files = (await readdir(stateDir)).filter(f => f.startsWith('events'));
  assert.ok(files.includes('events.ndjson'));
  assert.ok(files.includes('events.1.ndjson'));
  assert.ok(files.includes('events.2.ndjson'));
  assert.ok(!files.includes('events.3.ndjson'));
});

test('missing socket is silent: emit never throws and journal still records', async () => {
  const stateDir = await dir();
  const bus = createEventBus({ stateDir, socketPath: join(stateDir, 'nope.sock') });
  for (let i = 0; i < 50; i++) {
    const e = bus.emit({ kind: 'tick', detail: { i } });
    assert.equal(e.seq, i + 1);
  }
  await delay(400); // connect attempt fails (ENOENT)
  bus.emit({ kind: 'tick' });
  await bus.close();
  const lines = (await readFile(join(stateDir, 'events.ndjson'), 'utf8')).trim().split('\n');
  assert.equal(lines.length, 51);
});

test('socket push reaches a live control-room listener', async () => {
  const stateDir = await dir();
  const socketPath = join(stateDir, 'cr.sock');
  const received = [];
  const server = createServer(conn => {
    let buf = '';
    conn.on('data', chunk => {
      buf += chunk;
      let end;
      while ((end = buf.indexOf('\n')) >= 0) {
        received.push(JSON.parse(buf.slice(0, end)));
        buf = buf.slice(end + 1);
      }
    });
  });
  await new Promise(resolve => server.listen(socketPath, resolve));
  try {
    const bus = createEventBus({ stateDir, socketPath, reconnectMs: 50 });
    bus.emit({ kind: 'phase', phase: 'working', task_id: '7' });
    const deadline = Date.now() + 1500;
    while (!received.length && Date.now() < deadline) await delay(15);
    await bus.close();
    assert.equal(received.length, 1);
    assert.equal(received[0].phase, 'working');
    assert.equal(received[0].task_id, '7');
    assert.ok(received[0].ts);
  } finally {
    server.close();
  }
});

test('queue overflow drops oldest without blocking emit', async () => {
  const stateDir = await dir();
  // No listener: socket connect fails, queue fills. Emit must stay sync-cheap.
  const bus = createEventBus({ stateDir, socketPath: join(stateDir, 'absent.sock'),
    queueLimit: 8, reconnectMs: 10 });
  const started = process.hrtime.bigint();
  for (let i = 0; i < 2000; i++) bus.emit({ kind: 'tick' });
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  await bus.close();
  assert.ok(elapsedMs < 2000, `emit loop too slow: ${elapsedMs}ms`);
  const lines = (await readFile(join(stateDir, 'events.ndjson'), 'utf8')).trim().split('\n');
  assert.equal(lines.length, 2000);
});

test('reconnect after listener comes up delivers queued events', async () => {
  const stateDir = await dir();
  const socketPath = join(stateDir, 'late.sock');
  const bus = createEventBus({ stateDir, socketPath, reconnectMs: 30, queueLimit: 32 });
  bus.emit({ kind: 'phase', phase: 'early' });
  await delay(60);
  const received = [];
  const server = createServer(conn => {
    let buf = '';
    conn.on('data', chunk => {
      buf += chunk;
      let end;
      while ((end = buf.indexOf('\n')) >= 0) {
        received.push(JSON.parse(buf.slice(0, end)));
        buf = buf.slice(end + 1);
      }
    });
  });
  await new Promise(resolve => server.listen(socketPath, resolve));
  try {
    bus.emit({ kind: 'phase', phase: 'late' });
    const deadline = Date.now() + 1500;
    while (!received.length && Date.now() < deadline) await delay(15);
    await bus.close();
    assert.ok(received.length >= 1);
    assert.equal(received.at(-1).phase, 'late');
  } finally {
    server.close();
  }
});

test('socketPath null disables push entirely', async () => {
  const stateDir = await dir();
  const bus = createEventBus({ stateDir, socketPath: null });
  bus.emit({ kind: 'tick' });
  await bus.close();
  assert.equal((await readFile(join(stateDir, 'events.ndjson'), 'utf8')).trim().length > 0, true);
});

test('noop bus is silent and safe', async () => {
  const bus = createNoopEventBus();
  assert.equal(bus.emit({ kind: 'x' }), null);
  await bus.close();
});

test('emit after close is a no-op', async () => {
  const stateDir = await dir();
  const bus = createEventBus({ stateDir, socketPath: null });
  await bus.close();
  assert.equal(bus.emit({ kind: 'tick' }), null);
});

test('corrupt preexisting journal does not break emit', async () => {
  const stateDir = await dir();
  await writeFile(join(stateDir, 'events.ndjson'), 'not json\n');
  const bus = createEventBus({ stateDir, socketPath: null });
  const e = bus.emit({ kind: 'tick' });
  await bus.close();
  assert.equal(e.seq, 1);
  const lines = (await readFile(join(stateDir, 'events.ndjson'), 'utf8')).trim().split('\n');
  assert.equal(lines.length, 2);
});
