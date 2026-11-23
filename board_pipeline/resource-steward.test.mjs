import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile, utimes } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { once } from 'node:events';
import { join } from 'node:path';
import {
  availableGiB, classifyTmpEntry, defaultCacheRoots, defaultJournalPath, DOCKER_ACTIONS,
  escalateViaCommand, evaluateDisk, evaluateRam, measureMount, openJournal, parseArgv,
  parseBbThreadList, parseMemInfo, pruneCacheRoot, pruneExpiredTmp, raiseAlarm, runSteward,
  selectIdleThreads,
} from './resource-steward.mjs';

const GiB = 1024n ** 3n;
const bytesGiB = n => n * GiB;
const DAY_MS = 86_400_000;

const sandbox = async label => mkdtemp(join(tmpdir(), `rsteward-${label}-`));
// mtime в прошлом/будущем без ожидания реального времени
const age = async (path, days) => {
  const ts = new Date(Date.now() - days * DAY_MS);
  await utimes(path, ts, ts);
};
const silent = () => Object.assign(async () => {}, { close: async () => {} });

const thread = (id, over = {}) => ({
  id, status: 'idle', pinnedAt: null, queuedWork: 'none', hasPendingInteraction: false,
  activity: { activeBackgroundAgentCount: 0, activeBackgroundCommandCount: 0, activePlanModeCount: 0, activeWorkflowCount: 0 },
  ...over,
});

// --- Пороги 5 / 2 GiB и 1.5 GiB ---------------------------------------------

test('disk thresholds: exactly 5 GiB is ok, below is tier1, below 2 is alarm', () => {
  assert.equal(evaluateDisk(bytesGiB(5n)), 'ok');
  assert.equal(evaluateDisk(bytesGiB(5n) - 1n), 'tier1');
  assert.equal(evaluateDisk(bytesGiB(2n)), 'tier1'); // ровно 2 — ещё не тревога
  assert.equal(evaluateDisk(bytesGiB(2n) - 1n), 'alarm');
  assert.equal(evaluateDisk(0n), 'alarm');
});

test('ram threshold: exactly 1.5 GiB is fine, a byte less is low', () => {
  assert.equal(evaluateRam(1_610_612_736n), false);
  assert.equal(evaluateRam(1_610_612_735n), true);
  assert.equal(evaluateRam(0n), true);
});

test('threshold checks fail closed on unusable data', () => {
  assert.throws(() => evaluateDisk(5), /bigint/);
  assert.throws(() => evaluateDisk(-1n), /bigint/);
  assert.throws(() => evaluateRam('1000'), /bigint/);
});

test('availableGiB reports two-decimal GiB from bigint bytes', () => {
  assert.equal(availableGiB(bytesGiB(4n) + GiB / 2n), 4.5);
  assert.equal(availableGiB(1_610_612_736n), 1.5);
});

test('parseMemInfo reads MemAvailable in kB; missing field is an error, not zero', () => {
  const meminfo = 'MemTotal:       16384000 kB\nMemFree:         1000000 kB\nMemAvailable:    1572864 kB\n';
  assert.equal(parseMemInfo(meminfo), 1572864n * 1024n);
  assert.throws(() => parseMemInfo('MemTotal: 100 kB\n'), /MemAvailable/);
  assert.throws(() => parseMemInfo('MemAvailable: many kB\n'), /unreadable/);
});

// --- Классификация /tmp/df-* -------------------------------------------------

const dirStat = mtime => ({ isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false, mtimeMs: mtime });
const fileStat = mtime => ({ isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false, mtimeMs: mtime });
const now = 1_000_000_000_000;

test('tmp allowlist: only expired df-* entries are deletable', () => {
  const cutoff = now - 7 * DAY_MS;
  assert.deepEqual(classifyTmpEntry('df-build-123', fileStat(cutoff - 1), { cutoffMs: cutoff }),
    { action: 'delete', kind: 'file' });
  assert.deepEqual(classifyTmpEntry('df-build-123', dirStat(cutoff - 1), { cutoffMs: cutoff }),
    { action: 'delete', kind: 'dir' });
  assert.equal(classifyTmpEntry('df-fresh', fileStat(cutoff), { cutoffMs: cutoff }).action, 'keep'); // ровно на пороге — жив
  assert.equal(classifyTmpEntry('other-session', fileStat(cutoff - 100), { cutoffMs: cutoff }).action, 'keep');
  assert.equal(classifyTmpEntry('dfx', fileStat(cutoff - 100), { cutoffMs: cutoff }).action, 'keep');
  // pytest-of-* — тоже allowlist, но только каталоги (живой инцидент с /tmp)
  assert.deepEqual(classifyTmpEntry('pytest-of-mydum', dirStat(cutoff - 1), { cutoffMs: cutoff }),
    { action: 'delete', kind: 'dir' });
  assert.equal(classifyTmpEntry('pytest-of-mydum', dirStat(cutoff), { cutoffMs: cutoff }).action, 'keep');
  assert.equal(classifyTmpEntry('pytest-of-mydum', fileStat(cutoff - 1), { cutoffMs: cutoff }).action, 'keep');
  assert.equal(classifyTmpEntry('pytest-of-mydum', fileStat(cutoff - 1), { cutoffMs: cutoff }).reason, 'allowlist_dir_only');
});

test('tmp refuse: symlinks, special files and unsafe names are never deleted', () => {
  const cutoff = now - 7 * DAY_MS;
  const symlinkStat = { isFile: () => false, isDirectory: () => false, isSymbolicLink: () => true, mtimeMs: 0 };
  assert.equal(classifyTmpEntry('df-link', symlinkStat, { cutoffMs: cutoff }).reason, 'symlink');
  assert.equal(classifyTmpEntry('pytest-of-link', symlinkStat, { cutoffMs: cutoff }).reason, 'symlink');
  const fifoStat = { isFile: () => false, isDirectory: () => false, isSymbolicLink: () => false, mtimeMs: 0 };
  assert.equal(classifyTmpEntry('df-fifo', fifoStat, { cutoffMs: cutoff }).reason, 'special_file');
  assert.equal(classifyTmpEntry('..', fileStat(0), { cutoffMs: cutoff }).reason, 'unsafe_name');
  assert.equal(classifyTmpEntry('a/b', fileStat(0), { cutoffMs: cutoff }).reason, 'unsafe_name');
});

test('pruneExpiredTmp deletes only expired df-* and pytest-of-*, keeps everything else (real fs)', async () => {
  const root = await sandbox('tmp');
  try {
    await mkdir(join(root, 'df-old-dir'), { recursive: true });
    await writeFile(join(root, 'df-old-dir', 'inside.txt'), 'x');
    await writeFile(join(root, 'df-old-file'), 'x');
    await writeFile(join(root, 'df-fresh-file'), 'x');
    await writeFile(join(root, 'worktree-data'), 'precious');
    await mkdir(join(root, 'pytest-of-tester', 'pytest-3'), { recursive: true });
    await writeFile(join(root, 'pytest-of-tester', 'pytest-3', 'oldrun'), 'x');
    await mkdir(join(root, 'pytest-of-fresh'), { recursive: true });
    for (const [name, days] of [['df-old-dir', 30], ['df-old-file', 30], ['df-fresh-file', 1], ['worktree-data', 365],
      ['pytest-of-tester', 30], ['pytest-of-fresh', 1]]) {
      await age(join(root, name), days);
    }
    const events = [];
    const result = await pruneExpiredTmp({
      tmpRoot: root, cutoffMs: Date.now() - 7 * DAY_MS,
      journal: async e => events.push(e), fsImpl: await import('node:fs/promises'),
    });
    assert.equal(result.deleted, 3);
    assert.equal(result.refused, 0);
    assert.deepEqual(await readdir(root).then(n => n.sort()), ['df-fresh-file', 'pytest-of-fresh', 'worktree-data']);
    assert.ok(events.some(e => e.event === 'tmp_delete' && e.path === join(root, 'pytest-of-tester')));
    assert.ok(events.some(e => e.event === 'tmp_delete' && e.path === join(root, 'df-old-dir')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('pruneExpiredTmp refuses a df-* symlink and leaves the target alive (real fs)', async () => {
  const root = await sandbox('link');
  const target = join(root, 'precious-target');
  try {
    await writeFile(target, 'real data');
    const link = join(root, 'df-old-link');
    await symlink(target, link);
    await age(link, 30);
    const result = await pruneExpiredTmp({
      tmpRoot: root, cutoffMs: Date.now() - 7 * DAY_MS, journal: silent(),
      fsImpl: await import('node:fs/promises'),
    });
    assert.equal(result.refused, 1);
    assert.equal(result.deleted, 0);
    assert.equal(await readFile(target, 'utf8'), 'real data');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// --- Кэши pip/npm/uv ----------------------------------------------------------

test('pruneCacheRoot deletes old files and emptied old dirs, keeps fresh content (real fs)', async () => {
  const root = await sandbox('cache');
  try {
    await mkdir(join(root, 'old-empty'), { recursive: true });
    await mkdir(join(root, 'mixed', 'deep'), { recursive: true });
    await writeFile(join(root, 'old-blob'), 'x');
    await writeFile(join(root, 'fresh-blob'), 'x');
    await writeFile(join(root, 'mixed', 'old-file'), 'x');
    await writeFile(join(root, 'mixed', 'deep', 'fresh-file'), 'x');
    for (const [p, days] of [['old-empty', 30], ['old-blob', 30], ['fresh-blob', 1], ['mixed', 30],
      ['mixed/old-file', 30], ['mixed/deep', 30], ['mixed/deep/fresh-file', 1]]) {
      await age(join(root, p), days);
    }
    const result = await pruneCacheRoot({
      root, cutoffMs: Date.now() - 7 * DAY_MS, journal: silent(),
      fsImpl: await import('node:fs/promises'),
    });
    assert.equal(result.deletedFiles, 2); // old-blob + mixed/old-file
    assert.equal(result.removedDirs, 1);  // только опустевший old-empty
    assert.deepEqual(await readdir(root).then(n => n.sort()), ['fresh-blob', 'mixed']);
    assert.deepEqual(await readdir(join(root, 'mixed')).then(n => n.sort()), ['deep']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('pruneCacheRoot never follows or deletes symlinks (real fs)', async () => {
  const root = await sandbox('cachelink');
  try {
    await writeFile(join(root, 'old-file'), 'x');
    await age(join(root, 'old-file'), 30);
    await symlink(join(root, 'precious-target'), join(root, 'old-symlink')); // висячая ссылка
    const result = await pruneCacheRoot({
      root, cutoffMs: Date.now() - 7 * DAY_MS, journal: silent(),
      fsImpl: await import('node:fs/promises'),
    });
    assert.equal(result.refused, 1);
    assert.equal(result.deletedFiles, 1); // только обычный старый файл
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('pruneCacheRoot respects the entry cap and reports truncation', async () => {
  const root = await sandbox('cap');
  try {
    for (const name of ['a', 'b', 'c']) {
      await writeFile(join(root, name), 'x');
      await age(join(root, name), 30);
    }
    const result = await pruneCacheRoot({
      root, cutoffMs: Date.now() - 7 * DAY_MS, journal: silent(),
      fsImpl: await import('node:fs/promises'), maxEntries: 2,
    });
    assert.equal(result.truncated, true);
    assert.equal(result.deletedFiles, 2);
    assert.equal((await readdir(root)).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('pruneCacheRoot skips a missing cache root instead of failing the tick', async () => {
  const root = await sandbox('missing');
  const events = [];
  try {
    const result = await pruneCacheRoot({
      root: join(root, 'nope'), cutoffMs: Date.now(), journal: async e => events.push(e),
      fsImpl: await import('node:fs/promises'),
    });
    assert.equal(result.errors, 1);
    assert.ok(events.some(e => e.event === 'cache_skip'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// --- BB idle-треды -------------------------------------------------------------

test('only unambiguous idle threads are stoppable', () => {
  const { stoppable, skipped } = selectIdleThreads([
    thread('thr_aaa001'),                                   // чистый idle → stop
    thread('thr_aaa002', { status: 'active' }),             // активный → skip
    thread('thr_aaa003', { status: 'error' }),              // error → skip
    thread('thr_aaa004', { pinnedAt: 123 }),                // закреплён → skip
    thread('thr_aaa005', { queuedWork: 'turn' }),           // очередь → skip
    thread('thr_aaa006', { hasPendingInteraction: true }),  // интеракция → skip
    thread('thr_aaa007', { activity: { activeBackgroundAgentCount: 1 } }), // фон → skip
    thread('thr_aaa008'),                                   // config-pinned → skip
    thread('thr_aaa009'),                                   // свой тред → skip
    { id: 'not-a-thread' },                                 // мусорная запись → игнор
    null,
  ], { pinnedThreads: ['thr_aaa008'], selfThreadId: 'thr_aaa009' });
  assert.deepEqual(stoppable.map(t => t.id), ['thr_aaa001']);
  const reasons = Object.fromEntries(skipped.map(s => [s.id, s.reason]));
  assert.equal(reasons.thr_aaa002, 'status:active');
  assert.equal(reasons.thr_aaa003, 'status:error');
  assert.equal(reasons.thr_aaa004, 'pinned');
  assert.equal(reasons.thr_aaa005, 'queued_work');
  assert.equal(reasons.thr_aaa006, 'pending_interaction');
  assert.equal(reasons.thr_aaa007, 'background_activity');
  assert.equal(reasons.thr_aaa008, 'pinned_by_config');
  assert.equal(reasons.thr_aaa009, 'self');
});

test('parseBbThreadList accepts array, {threads} and fails on {ok:false}', () => {
  assert.deepEqual(parseBbThreadList('[{"id":"thr_a"}]'), [{ id: 'thr_a' }]);
  assert.deepEqual(parseBbThreadList('{"threads":[{"id":"thr_b"}]}'), [{ id: 'thr_b' }]);
  assert.throws(() => parseBbThreadList('{"ok":false,"error":{"code":"x","message":"boom"}}'), /boom/);
  assert.throws(() => parseBbThreadList('not json'), SyntaxError);
});

// --- Журнал JSONL 0600 ----------------------------------------------------------

test('journal is JSONL with 0600 file in a 0700 dir, appended across opens', async () => {
  const dir = await sandbox('journal');
  const path = join(dir, 'nested', 'journal.jsonl');
  try {
    const first = await openJournal(path);
    await first({ event: 'tick_start', dryRun: false });
    await first.close();
    const second = await openJournal(path);
    await second({ event: 'tick_end', stopped: 0 });
    await second.close();
    const dirMode = (await stat(join(dir, 'nested'))).mode & 0o777;
    const fileMode = (await stat(path)).mode & 0o777;
    assert.equal(dirMode, 0o700);
    assert.equal(fileMode, 0o600);
    const lines = (await readFile(path, 'utf8')).trim().split('\n');
    assert.equal(lines.length, 2);
    for (const line of lines) {
      const entry = JSON.parse(line);
      assert.ok(entry.ts && entry.event);
    }
    assert.equal(JSON.parse(lines[1]).event, 'tick_end');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('journal chmod restores 0600 on a pre-existing wider-open file', async () => {
  const dir = await sandbox('chmod');
  const path = join(dir, 'journal.jsonl');
  try {
    await writeFile(path, '', { mode: 0o644 });
    const journal = await openJournal(path);
    await journal({ event: 'x' });
    await journal.close();
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- Тревога и эскалация ---------------------------------------------------------

test('alarm triggers exactly one escalation with the owner question', async () => {
  const events = [];
  const journal = async e => events.push(e);
  const escalations = [];
  const result = await raiseAlarm({
    mount: '/', availableBytes: bytesGiB(1n), journalPath: '/state/journal.jsonl',
    escalate: async payload => { escalations.push(payload); return { code: 0 }; },
    journal,
  });
  assert.equal(result.escalated, true);
  assert.equal(escalations.length, 1);
  assert.equal(escalations[0].reason, 'disk_alarm');
  assert.equal(escalations[0].mount, '/');
  assert.equal(escalations[0].availableGiB, 1);
  assert.equal(escalations[0].afterTier1, true);
  assert.match(escalations[0].question, /расследование LLM-агента Steward/);
  assert.ok(events.some(e => e.event === 'alarm'));
  assert.ok(events.some(e => e.event === 'escalation' && e.code === 0));
});

test('alarm without a configured hook is journaled honestly, escalation skipped', async () => {
  const events = [];
  const result = await raiseAlarm({
    mount: '/media/mydum/Data', availableBytes: bytesGiB(1n), journal: async e => events.push(e),
  });
  assert.equal(result.raised, true);
  assert.equal(result.escalated, false);
  assert.ok(events.some(e => e.event === 'escalation_skipped' && e.reason === 'no_hook_configured'));
});

test('escalation hook failure does not crash the alarm', async () => {
  const events = [];
  const result = await raiseAlarm({
    mount: '/', availableBytes: bytesGiB(1n), escalate: async () => { throw new Error('hook down'); },
    journal: async e => events.push(e),
  });
  assert.equal(result.escalated, true);
  assert.ok(events.some(e => e.event === 'escalation' && /hook down/.test(e.detail)));
});

// --- Интеграция тика --------------------------------------------------------------

// Контракт runSteward: statfsImpl(mount) → bigint свободных байт.
const mountStat = bytes => async () => bytes;
const realFs = () => import('node:fs/promises');

test('quiet tick: above 5 GiB and enough RAM — zero actions, zero LLM calls', async () => {
  const root = await sandbox('quiet');
  const journalPath = join(root, 'state', 'journal.jsonl');
  try {
    await mkdir(join(root, 'tmp', 'df-old'), { recursive: true });
    await age(join(root, 'tmp', 'df-old'), 30);
    const dockerCalls = [];
    const bbCalls = [];
    const escalations = [];
    const summary = await runSteward({
      mounts: ['/data'], statfsImpl: mountStat(bytesGiB(6n)), memInfoImpl: async () => bytesGiB(4n),
      tmpRoot: join(root, 'tmp'), journalPath,
      execDocker: async args => { dockerCalls.push(args); return { code: 0, stdout: '', stderr: '' }; },
      execBb: async args => { bbCalls.push(args); return { code: 0, stdout: '[]', stderr: '' }; },
      escalate: async payload => { escalations.push(payload); return { code: 0 }; },
      now: 1_700_000_000_000,
    });
    assert.equal(summary.tier1, null);
    assert.equal(summary.alarm.raised, false);
    assert.equal(summary.ram.low, false);
    assert.equal(dockerCalls.length, 0);
    assert.equal(bbCalls.length, 0);
    assert.equal(escalations.length, 0); // 0 LLM на штатном ходе
    assert.ok(await readdir(join(root, 'tmp')).then(n => n.includes('df-old')));
    const events = (await readFile(journalPath, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(events.map(e => e.event), ['tick_start', 'measurement', 'ram_measurement', 'tick_end']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('tier1 tick: docker prune, expired tmp and caches cleaned; no alarm above 2 GiB', async () => {
  const root = await sandbox('tier1');
  const journalPath = join(root, 'state', 'journal.jsonl');
  try {
    await mkdir(join(root, 'tmp', 'df-old'), { recursive: true });
    await writeFile(join(root, 'tmp', 'df-old', 'x'), 'x');
    await writeFile(join(root, 'tmp', 'df-new'), 'x');
    await mkdir(join(root, 'cachepip'), { recursive: true });
    await writeFile(join(root, 'cachepip', 'old-blob'), 'x');
    for (const [rel, ageDays] of [['tmp/df-old', 30], ['tmp/df-old/x', 30], ['tmp/df-new', 1], ['cachepip/old-blob', 30]]) {
      await age(join(root, rel), ageDays);
    }
    const statfsImpl = async () => bytesGiB(4n); // до уборки < 5 GiB
    const dockerCalls = [];
    const summary = await runSteward({
      mounts: ['/data'], statfsImpl, memInfoImpl: async () => bytesGiB(8n),
      tmpRoot: join(root, 'tmp'),
      cacheRoots: [{ kind: 'pip', path: join(root, 'cachepip') }],
      journalPath,
      execDocker: async args => { dockerCalls.push(args); return { code: 0, stdout: 'Total reclaimed space: 1GB', stderr: '' }; },
      execBb: async () => ({ code: 0, stdout: '[]', stderr: '' }),
    });
    assert.deepEqual(dockerCalls, [['builder', 'prune', '-f'], ['image', 'prune', '-f']]);
    assert.equal(summary.tier1.tmp.deleted, 1);
    assert.equal(summary.tier1.caches[0].deletedFiles, 1);
    assert.deepEqual(await readdir(join(root, 'tmp')).then(n => n.sort()), ['df-new']);
    assert.equal((await readdir(join(root, 'cachepip'))).length, 0);
    assert.equal(summary.alarm.raised, false);
    // после уборки места стало больше, но ниже 5 — пост-измерение в журнале
    const events = (await readFile(journalPath, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(events.some(e => e.event === 'measurement_post' && e.level === 'tier1'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('alarm: below 2 GiB after tier1 → exactly one escalation, even with two alarm mounts', async () => {
  const root = await sandbox('alarm');
  const journalPath = join(root, 'state', 'journal.jsonl');
  try {
    let measurement = 0;
    const statfsImpl = async () => {
      measurement++;
      // первые два вызова — до Тира 1 (tier1), далее — после уборки (alarm)
      return measurement <= 2 ? bytesGiB(4n) : bytesGiB(1n);
    };
    const escalations = [];
    const summary = await runSteward({
      mounts: ['/', '/data'], statfsImpl, memInfoImpl: async () => bytesGiB(8n),
      tmpRoot: join(root, 'tmp'), cacheRoots: [],
      journalPath,
      execDocker: async () => ({ code: 0, stdout: '', stderr: '' }),
      execBb: async () => ({ code: 0, stdout: '[]', stderr: '' }),
      escalate: async payload => { escalations.push(payload); return { code: 0 }; },
    });
    assert.equal(summary.alarm.raised, true);
    assert.equal(summary.alarm.escalated, true);
    assert.equal(escalations.length, 1); // одна эскалация на тик
    assert.equal(escalations[0].reason, 'disk_alarm');
    assert.ok(escalations[0].availableGiB < 2);
    const events = (await readFile(journalPath, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(events.some(e => e.event === 'alarm'));
    assert.ok(events.some(e => e.event === 'escalation'));
    assert.equal(events[events.length - 1].event, 'tick_end');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('alarm still fires honestly when no escalation hook is configured', async () => {
  const root = await sandbox('nohook');
  try {
    const summary = await runSteward({
      mounts: ['/data'], statfsImpl: mountStat(bytesGiB(1n)), memInfoImpl: async () => bytesGiB(8n),
      tmpRoot: join(root, 'tmp'), cacheRoots: [], journalPath: join(root, 'j.jsonl'),
      execDocker: async () => ({ code: 0, stdout: '', stderr: '' }),
    });
    assert.equal(summary.alarm.raised, true);
    assert.equal(summary.alarm.escalated, false);
    const events = (await readFile(join(root, 'j.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(events.some(e => e.event === 'escalation_skipped'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('RAM below 1.5 GiB: stops only clean idle threads, protects active/pinned/self', async () => {
  const root = await sandbox('ram');
  try {
    const threads = [
      thread('thr_idle01'), thread('thr_idle02'),
      thread('thr_busy01', { status: 'active' }),
      thread('thr_pin01', { pinnedAt: 42 }),
      thread('thr_self1'),
    ];
    const bbCalls = [];
    const summary = await runSteward({
      mounts: ['/data'], statfsImpl: mountStat(bytesGiB(9n)),
      memInfoImpl: async () => bytesGiB(1n),
      tmpRoot: join(root, 'tmp'), cacheRoots: [], journalPath: join(root, 'j.jsonl'),
      execDocker: async () => ({ code: 0, stdout: '', stderr: '' }),
      execBb: async args => { bbCalls.push(args); return { code: 0, stdout: JSON.stringify(threads), stderr: '' }; },
      selfThreadId: 'thr_self1',
    });
    assert.equal(summary.ram.low, true);
    assert.equal(summary.ram.stopped, 2);
    assert.deepEqual(bbCalls, [['thread', 'list', '--json'], ['thread', 'stop', 'thr_idle01'], ['thread', 'stop', 'thr_idle02']]);
    const events = (await readFile(join(root, 'j.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    const stops = events.filter(e => e.event === 'ram_stop');
    assert.equal(stops.length, 2);
    assert.ok(summary.ram.skipped.some(s => s.id === 'thr_busy01' && s.reason === 'status:active'));
    assert.ok(summary.ram.skipped.some(s => s.id === 'thr_pin01' && s.reason === 'pinned'));
    assert.ok(summary.ram.skipped.some(s => s.id === 'thr_self1' && s.reason === 'self'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('bb thread stop with non-zero exit code is an error, not a counted stop', async () => {
  const root = await sandbox('ramcode');
  try {
    const summary = await runSteward({
      mounts: ['/data'], statfsImpl: mountStat(bytesGiB(9n)),
      memInfoImpl: async () => bytesGiB(1n),
      tmpRoot: join(root, 'tmp'), cacheRoots: [], journalPath: join(root, 'j.jsonl'),
      execDocker: async () => ({ code: 0, stdout: '', stderr: '' }),
      execBb: async args => {
        if (args[1] === 'stop') return { code: 3, stdout: '', stderr: `cannot stop ${args[2]}` };
        return { code: 0, stdout: JSON.stringify([thread('thr_idle01'), thread('thr_idle02')]), stderr: '' };
      },
    });
    assert.equal(summary.ram.stopped, 0);
    assert.equal(summary.ram.errors, 2);
    assert.ok(summary.errors.some(e => /stop thr_idle01: cannot stop thr_idle01/.test(e)));
    const events = (await readFile(join(root, 'j.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(events.some(e => e.event === 'ram_stop_error' && e.threadId === 'thr_idle01' && e.code === 3));
    assert.ok(!events.some(e => e.event === 'ram_stop'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('RAM stop failure is journaled and the tick continues with other threads', async () => {
  const root = await sandbox('ramerr');
  try {
    const bbCalls = [];
    const summary = await runSteward({
      mounts: ['/data'], statfsImpl: mountStat(bytesGiB(9n)),
      memInfoImpl: async () => bytesGiB(1n),
      tmpRoot: join(root, 'tmp'), cacheRoots: [], journalPath: join(root, 'j.jsonl'),
      execDocker: async () => ({ code: 0, stdout: '', stderr: '' }),
      execBb: async args => {
        bbCalls.push(args);
        if (args[0] === 'thread' && args[1] === 'stop' && args[2] === 'thr_idle01') throw new Error('bb gone');
        return { code: 0, stdout: JSON.stringify([thread('thr_idle01'), thread('thr_idle02')]), stderr: '' };
      },
    });
    assert.equal(summary.ram.stopped, 1);
    assert.equal(summary.ram.errors, 1);
    assert.ok(summary.errors.some(e => /stop thr_idle01/.test(e)));
    const events = (await readFile(join(root, 'j.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(events.some(e => e.event === 'ram_stop_error' && e.threadId === 'thr_idle01'));
    assert.ok(events.some(e => e.event === 'ram_stop' && e.threadId === 'thr_idle02'));
    assert.deepEqual(bbCalls.filter(a => a[1] === 'stop').map(a => a[2]), ['thr_idle01', 'thr_idle02']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// --- Dry-run ----------------------------------------------------------------------

test('dry-run: plan without any effect — nothing deleted, no docker, no stops, no escalation, no journal', async () => {
  const root = await sandbox('dry');
  const journalPath = join(root, 'state', 'journal.jsonl');
  try {
    await mkdir(join(root, 'tmp', 'df-old'), { recursive: true });
    await writeFile(join(root, 'tmp', 'df-old', 'x'), 'x');
    await mkdir(join(root, 'cache'), { recursive: true });
    await writeFile(join(root, 'cache', 'old-blob'), 'x');
    for (const [rel, ageDays] of [['tmp/df-old', 30], ['tmp/df-old/x', 30], ['cache/old-blob', 30]]) {
      await age(join(root, rel), ageDays);
    }
    const dockerCalls = [];
    const bbCalls = [];
    const escalations = [];
    const summary = await runSteward({
      dryRun: true,
      mounts: ['/data'], statfsImpl: mountStat(bytesGiB(1n)), memInfoImpl: async () => bytesGiB(1n),
      tmpRoot: join(root, 'tmp'), cacheRoots: [{ kind: 'pip', path: join(root, 'cache') }], journalPath,
      execDocker: async args => { dockerCalls.push(args); return { code: 0, stdout: '', stderr: '' }; },
      execBb: async args => { bbCalls.push(args); return { code: 0, stdout: '[]', stderr: '' }; },
      escalate: async payload => { escalations.push(payload); return { code: 0 }; },
    });
    assert.equal(summary.dryRun, true);
    assert.equal(summary.alarm.raised, true);
    assert.equal(summary.alarm.escalated, false);
    assert.equal(summary.alarm.plannedEscalation, true);
    assert.equal(escalations.length, 0); // хук LLM не вызывается в dry-run
    assert.deepEqual(dockerCalls, []);   // docker prune не выполняется
    assert.deepEqual(bbCalls, [['thread', 'list', '--json']]); // list — read-only, stop нет
    assert.equal(summary.ram.plannedStops.length, 0);
    assert.equal(summary.tier1.tmp.deleted, 1);
    assert.equal(summary.tier1.caches[0].deletedFiles, 1);
    // ни один байт на диске не изменился
    assert.deepEqual(await readdir(join(root, 'tmp', 'df-old')), ['x']);
    assert.deepEqual(await readdir(join(root, 'cache')), ['old-blob']);
    await assert.rejects(stat(journalPath), { code: 'ENOENT' }); // журнал не создавался
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('dry-run lists planned thread stops without stopping anything', async () => {
  const root = await sandbox('dryram');
  try {
    const bbCalls = [];
    const summary = await runSteward({
      dryRun: true,
      mounts: ['/data'], statfsImpl: mountStat(bytesGiB(9n)),
      memInfoImpl: async () => bytesGiB(1n),
      tmpRoot: join(root, 'tmp'), cacheRoots: [], journalPath: join(root, 'j.jsonl'),
      execDocker: async () => ({ code: 0, stdout: '', stderr: '' }),
      execBb: async args => { bbCalls.push(args); return { code: 0, stdout: JSON.stringify([thread('thr_idle01'), thread('thr_busy01', { status: 'active' })]), stderr: '' }; },
    });
    assert.deepEqual(summary.ram.plannedStops, ['thr_idle01']);
    assert.deepEqual(bbCalls.filter(a => a[1] === 'stop'), []); // stop в dry-run не выполняется
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// --- Отказы и границы входа ---------------------------------------------------------

test('real run fails closed without a journal path; relative journal path is rejected', async () => {
  await assert.rejects(runSteward({ mounts: ['/data'], journalPath: undefined }), /journalPath is required/);
  await assert.rejects(runSteward({ mounts: ['/data'], journalPath: 'relative.jsonl' }), /absolute/);
  await assert.rejects(runSteward({ mounts: [], journalPath: '/tmp/j.jsonl' }), /at least one mount/);
  await assert.rejects(runSteward({ mounts: ['/data'], tmpDays: 0, journalPath: '/tmp/j.jsonl' }), /within \(0, 365\]/);
  await assert.rejects(runSteward({ mounts: ['/data'], cacheRoots: [{ kind: 'x', path: 'rel' }], journalPath: '/tmp/j.jsonl' }), /absolute/);
  await assert.rejects(runSteward({ mounts: ['/data'], tmpRoot: 'rel', journalPath: '/tmp/j.jsonl' }), /tmpRoot/);
});

test('measurement failure on one mount does not zero it out or stop the tick', async () => {
  const root = await sandbox('badmount');
  try {
    const summary = await runSteward({
      mounts: ['/', '/data'],
      statfsImpl: async mount => {
        if (mount === '/') throw new Error('statfs unavailable');
        return bytesGiB(3n);
      },
      memInfoImpl: async () => bytesGiB(8n),
      tmpRoot: join(root, 'tmp'), cacheRoots: [], journalPath: join(root, 'j.jsonl'),
      execDocker: async () => ({ code: 0, stdout: '', stderr: '' }),
    });
    assert.equal(summary.mounts[0].error, 'statfs unavailable');
    assert.equal(summary.mounts[1].level, 'tier1');
    assert.ok(summary.errors.some(e => /measure \/: statfs/.test(e)), 'measure error recorded');
    // tier1 всё равно отработал по живому монту
    assert.ok(summary.tier1);
    const events = (await readFile(join(root, 'j.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(events.some(e => e.event === 'measurement_error' && e.mount === '/'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('docker failure is journaled and tier1 continues with tmp and caches', async () => {
  const root = await sandbox('dockerfail');
  try {
    await mkdir(join(root, 'tmp'), { recursive: true });
    await writeFile(join(root, 'tmp', 'df-old'), 'x');
    await age(join(root, 'tmp', 'df-old'), 30);
    const summary = await runSteward({
      mounts: ['/data'], statfsImpl: mountStat(bytesGiB(4n)), memInfoImpl: async () => bytesGiB(8n),
      tmpRoot: join(root, 'tmp'), cacheRoots: [], journalPath: join(root, 'j.jsonl'),
      execDocker: async () => { throw new Error('docker not installed'); },
    });
    assert.equal(summary.tier1.docker[0].error, 'docker not installed');
    assert.equal(summary.tier1.tmp.deleted, 1);
    const events = (await readFile(join(root, 'j.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(events.some(e => e.event === 'docker_error'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('docker disabled leaves the plan empty of prune calls', async () => {
  const root = await sandbox('nodocker');
  try {
    const summary = await runSteward({
      mounts: ['/data'], statfsImpl: mountStat(bytesGiB(4n)), memInfoImpl: async () => bytesGiB(8n),
      tmpRoot: join(root, 'tmp'), cacheRoots: [], journalPath: join(root, 'j.jsonl'),
      dockerEnabled: false,
      execDocker: async () => { throw new Error('must not be called'); },
    });
    assert.deepEqual(summary.tier1.docker, ['disabled']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('RAM measurement failure is an error, not an automatic thread stop', async () => {
  const root = await sandbox('rambad');
  try {
    const bbCalls = [];
    const summary = await runSteward({
      mounts: ['/data'], statfsImpl: mountStat(bytesGiB(9n)),
      memInfoImpl: async () => { throw new Error('no meminfo'); },
      tmpRoot: join(root, 'tmp'), cacheRoots: [], journalPath: join(root, 'j.jsonl'),
      execDocker: async () => ({ code: 0, stdout: '', stderr: '' }),
      execBb: async args => { bbCalls.push(args); return { code: 0, stdout: '[]', stderr: '' }; },
    });
    assert.equal(summary.ram.low, false);
    assert.equal(summary.ram.errors, 1);
    assert.equal(bbCalls.length, 0);
    assert.ok(summary.errors.some(e => /ram: no meminfo/.test(e)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// --- Прочее ---------------------------------------------------------------------

test('docker actions are exactly the two allowlisted prune commands', () => {
  assert.deepEqual(DOCKER_ACTIONS.map(a => a.args), [['builder', 'prune', '-f'], ['image', 'prune', '-f']]);
});

test('default cache roots pin pip, uv and npm _cacache; never homedir itself', () => {
  const env = { XDG_CACHE_HOME: '/xdg-cache' };
  const roots = defaultCacheRoots(env);
  assert.deepEqual(roots.map(r => r.kind), ['pip', 'uv', 'npm']);
  assert.deepEqual(roots.map(r => r.path),
    ['/xdg-cache/pip', '/xdg-cache/uv', join(homedir(), '.npm', '_cacache')]);
  assert.ok(roots.every(r => !['/home', homedir()].includes(r.path)));
});

test('parseArgv: flags, mounts and unknown flag rejection', () => {
  const flags = parseArgv(['--dry-run', '--journal', '/tmp/j.jsonl', '--mount', '/x', '--tmp-days', '3',
    '--cache-days', '14', '--no-docker', '--bb', '/usr/bin/bb', '--escalate-cmd', '/bin/hook']);
  assert.equal(flags.dryRun, true);
  assert.equal(flags.journalPath, '/tmp/j.jsonl');
  assert.deepEqual(flags.mounts, ['/x']);
  assert.equal(flags.tmpDays, 3);
  assert.equal(flags.cacheDays, 14);
  assert.equal(flags.dockerEnabled, false);
  assert.equal(flags.bbPath, '/usr/bin/bb');
  assert.equal(flags.escalateCmd, '/bin/hook');
  assert.throws(() => parseArgv(['--bogus']), /unknown flag/);
  assert.throws(() => parseArgv(['--journal']), /missing value/);
  assert.equal(Number.isNaN(parseArgv(['--tmp-days', 'abc']).tmpDays), true); // отбракует runSteward
});

test('escalation hook drains stderr (no pipe stall) and reports it in detail', async () => {
  const dir = await sandbox('hook');
  const hookPath = join(dir, 'hook.sh');
  try {
    // 200 KB в stderr — больше буфера pipe: без дренирования хук завис бы.
    await writeFile(hookPath, '#!/bin/sh\nyes hook-diag | head -c 200000 >&2\nexit 7\n', { mode: 0o700 });
    const outcome = await escalateViaCommand(hookPath, 15_000)({ reason: 'test' });
    assert.equal(outcome.code, 7);
    assert.ok(outcome.detail.includes('hook-diag'));
    assert.ok(outcome.detail.length <= 500); // диагностика обрезана до хвоста
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('CLI without --journal writes the journal under XDG_STATE_HOME (real spawn)', async t => {
  // Тихий CLI-тик без эффектов: монт с запасом места (> 5 GiB), docker выключен,
  // bb подменён на /bin/false, журнал — в песочнице XDG_STATE_HOME.
  let free = 0n;
  try { free = await measureMount('/media/mydum/Data'); } catch { /* нет монта */ }
  if (free < bytesGiB(6n)) return t.skip('нет здорового монта для тихого CLI-тика');
  const work = await mkdtemp(join('/media/mydum/Data', 'rsteward-cli-'));
  const stateDir = join(work, 'state');
  try {
    const child = spawn(process.execPath, [
      join(import.meta.dirname, 'resource-steward.mjs'),
      '--no-docker', '--mount', work, '--bb', '/bin/false',
    ], { env: { ...process.env, XDG_STATE_HOME: stateDir }, stdio: 'ignore' });
    const [code] = await once(child, 'close');
    assert.equal(code, 0);
    const journalFile = join(stateDir, 'resource-steward', 'journal.jsonl');
    // Права 0600 проверены в тестах журнала на tmpdir; на FUSE-монте
    // /media/mydum/Data chmod — no-op (файлы видны как 0755), здесь не проверяем.
    const events = (await readFile(journalFile, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(events[events.length - 1].event, 'tick_end');
    assert.ok(events.every(e => e.event !== 'tier1_start')); // /tmp не тронут
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test('default journal path lives outside the repository under XDG state', () => {
  const path = defaultJournalPath();
  assert.ok(path.endsWith('resource-steward/journal.jsonl'));
  assert.ok(!path.startsWith(process.cwd()));
});
