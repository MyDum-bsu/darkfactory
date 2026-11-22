// Юнит-тесты bb-reconcile на реальном формате JSON `bb thread list/show/log`:
// элемент списка может нести environmentPath, иначе путь — в show.environment.path;
// событие хода — client/turn/requested с e.data.input[{type:'text',text}].
// spawn засчитывает ТОЛЬКО стартовое событие (seq 1, source spawn); feedback —
// только tell-события, журнал читается --after-seq или --all (никакого --limit 200
// с начала треда).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reconcileFeedbackFromBb, reconcileSpawnFromBb } from './bb-reconcile.mjs';

const TREE = '/repo/worktree';
const ATTEMPT = 'att-42';
const HANDOFF = '/repo/inbox/att-42/submission.json';

const turnEvent = (text, seq = 1, source = 'spawn') => ({
  type: 'client/turn/requested', seq, threadId: 'thr_abc1',
  data: { direction: 'outbound', source,
    input: [{ type: 'text', text }] },
});
const otherEvent = { type: 'turn/completed', seq: 2, data: { status: 'completed' } };

const spawnText = `Бриф.\n\nРабочий путь: ${TREE}. Запиши JSON атомарно в ${HANDOFF} и заверши ход. ` +
  `Сохрани типы полей: {"task_id":"t1","epoch":1,"attempt_id":"${ATTEMPT}"}`;

// Поддельный execBb: отвечает на bb thread list/show/log по аргументам.
function fakeBb({ list = [], shows = {}, logs = {} }) {
  const calls = [];
  return { calls,
    execBb: async (args) => {
      calls.push(args);
      if (args[1] === 'list') return { stdout: JSON.stringify(list) };
      if (args[1] === 'show') return { stdout: JSON.stringify(shows[args[2]] ?? {}) };
      if (args[1] === 'log') return { stdout: JSON.stringify(logs[args[2]] ?? []) };
      throw new Error(`unexpected bb call: ${args.join(' ')}`);
    } };
}

test('reconcileSpawn: list item без environmentPath — путь берётся из show.environment.path', async () => {
  const { execBb, calls } = fakeBb({
    list: [{ id: 'thr_abc1' }, { id: 'thr_xyz9' }],
    shows: {
      thr_abc1: { environment: { path: TREE }, thread: { id: 'thr_abc1' } },
      thr_xyz9: { environment: { path: '/elsewhere' }, thread: { id: 'thr_xyz9' } },
    },
    logs: { thr_abc1: [turnEvent(spawnText), otherEvent] },
  });
  const res = await reconcileSpawnFromBb({ execBb, project: 'proj_x1', tree: TREE,
    attemptId: ATTEMPT, handoffFile: HANDOFF });
  assert.deepEqual(res, { status: 'matched', threadId: 'thr_abc1' });
  assert.ok(calls.some(a => a[1] === 'show' && a[2] === 'thr_abc1'));
  assert.ok(calls.some(a => a[1] === 'log' && a[2] === 'thr_abc1'));
  assert.ok(!calls.some(a => a[1] === 'log' && a[2] === 'thr_xyz9'));
  assert.ok(calls[0].includes('--project') && calls[0].includes('proj_x1'));
});

test('reconcileSpawn: environmentPath на элементе списка — show не нужен', async () => {
  const { execBb, calls } = fakeBb({
    list: [{ id: 'thr_abc1', environmentPath: TREE }],
    logs: { thr_abc1: [turnEvent(spawnText)] },
  });
  const res = await reconcileSpawnFromBb({ execBb, tree: TREE,
    attemptId: ATTEMPT, handoffFile: HANDOFF });
  assert.deepEqual(res, { status: 'matched', threadId: 'thr_abc1' });
  assert.ok(!calls.some(a => a[1] === 'show'));
});

test('reconcileSpawn: {threads:[...]} обёртка и empty/ambiguous', async () => {
  const empty = fakeBb({ list: { threads: [] } });
  assert.deepEqual(await reconcileSpawnFromBb({ execBb: empty.execBb, tree: TREE,
    attemptId: ATTEMPT, handoffFile: HANDOFF }), { status: 'empty' });

  const two = fakeBb({
    list: { threads: [{ id: 'thr_a1', environmentPath: TREE }, { id: 'thr_b2', environmentPath: TREE }] },
    logs: { thr_a1: [turnEvent(spawnText)], thr_b2: [turnEvent(spawnText)] },
  });
  assert.deepEqual(await reconcileSpawnFromBb({ execBb: two.execBb, tree: TREE,
    attemptId: ATTEMPT, handoffFile: HANDOFF }), { status: 'ambiguous' });
});

test('reconcileSpawn: поздняя цитата маркеров (seq 5, source tell) — не запуск', async () => {
  const { execBb } = fakeBb({
    list: [{ id: 'thr_abc1', environmentPath: TREE }],
    logs: { thr_abc1: [turnEvent('старое задание'), turnEvent(spawnText, 5, 'tell')] },
  });
  assert.deepEqual(await reconcileSpawnFromBb({ execBb, tree: TREE,
    attemptId: ATTEMPT, handoffFile: HANDOFF }), { status: 'empty' });
});

test('reconcileSpawn: чужой маркер attemptId не засчитывается', async () => {
  const { execBb } = fakeBb({
    list: [{ id: 'thr_abc1', environmentPath: TREE }],
    logs: { thr_abc1: [turnEvent('attempt_id: att-9, handoff /repo/inbox/att-9/submission.json')] },
  });
  assert.deepEqual(await reconcileSpawnFromBb({ execBb, tree: TREE,
    attemptId: ATTEMPT, handoffFile: HANDOFF }), { status: 'empty' });
});

test('reconcileFeedback: точный заголовок в tell input text — delivered/empty/ambiguous', async () => {
  const header = fid => `Замечание фабрики ${fid}. SHA deadbeef. Причина: x.`;
  const delivered = fakeBb({ logs: { thr_abc1: [otherEvent, turnEvent(header('f1'), 9, 'tell')] } });
  assert.deepEqual(await reconcileFeedbackFromBb({ execBb: delivered.execBb,
    threadId: 'thr_abc1', feedbackId: 'f1' }), { status: 'delivered' });

  const empty = fakeBb({ logs: { thr_abc1: [turnEvent('другой текст без маркера', 9, 'tell')] } });
  assert.deepEqual(await reconcileFeedbackFromBb({ execBb: empty.execBb,
    threadId: 'thr_abc1', feedbackId: 'f1' }), { status: 'empty' });

  const dup = fakeBb({ logs: { thr_abc1: [turnEvent(header('f1'), 9, 'tell'), turnEvent(header('f1'), 11, 'tell')] } });
  assert.deepEqual(await reconcileFeedbackFromBb({ execBb: dup.execBb,
    threadId: 'thr_abc1', feedbackId: 'f1' }), { status: 'ambiguous' });

  // Невалидная цель — честный ambiguous, без вызова bb.
  const bad = fakeBb({});
  assert.deepEqual(await reconcileFeedbackFromBb({ execBb: bad.execBb,
    threadId: 'not-a-thread', feedbackId: 'f1' }), { status: 'ambiguous' });
  assert.equal(bad.calls.length, 0);
});

test('reconcileFeedback: без afterSeq читает --all (feedback с seq > 200 не теряется)', async () => {
  const header = fid => `Замечание фабрики ${fid}. SHA deadbeef.`;
  // 250 событий журнала, feedback на seq 210 — за пределами первых 200.
  const log = [...Array(240).keys()].map(i => otherEvent);
  log.push(turnEvent(header('f1'), 210, 'tell'));
  const { execBb, calls } = fakeBb({ logs: { thr_abc1: log } });
  const res = await reconcileFeedbackFromBb({ execBb, threadId: 'thr_abc1', feedbackId: 'f1' });
  assert.equal(res.status, 'delivered');
  assert.ok(calls[0].includes('--all'), 'полный журнал без --limit 200');
  assert.ok(!calls[0].includes('--limit'));
});

test('reconcileFeedback: afterSeq → --after-seq; source spawn не засчитывается', async () => {
  const header = fid => `Замечание фабрики ${fid}.`;
  const log = [turnEvent('старт', 1, 'spawn'), turnEvent(header('f1'), 30, 'tell'),
    turnEvent(header('f1'), 31, 'spawn')]; // spawn-событие с тем же текстом — не tell
  const { execBb, calls } = fakeBb({ logs: { thr_abc1: log } });
  const res = await reconcileFeedbackFromBb({ execBb, threadId: 'thr_abc1',
    feedbackId: 'f1', afterSeq: 25 });
  assert.equal(res.status, 'delivered');
  assert.ok(calls[0].includes('--after-seq') && calls[0].includes('25'));
  assert.ok(calls[0].includes('--all'), '--after-seq без --all ограничен 100 событиями');
  assert.ok(!calls[0].includes('--limit'));
});
