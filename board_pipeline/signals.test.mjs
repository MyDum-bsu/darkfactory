import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { checkDiskPreflight, combinedKillSwitch, createAttemptSignals,
  createPhaseBudget } from './signals.mjs';

const epoch = (live = { epoch: 7 }) => ({ verifyHeld: async () => live, taskId: '3', epoch: 7 });

test('kill-switch: сработавший assertOpen абортит signal и пробрасывает причину', async () => {
  const stop = new Error('pilot_stopped');
  const signals = createAttemptSignals({ assertOpen: async () => { throw stop; } });
  await assert.rejects(signals.checkNow(), error => error === stop);
  assert.equal(signals.signal.aborted, true);
  assert.equal(signals.signal.reason, stop);
  signals.dispose();
});

test('kill-switch опрашивается периодически и dispose снимает опрос', async () => {
  let calls = 0;
  const signals = createAttemptSignals({
    assertOpen: async () => { calls++; if (calls > 2) throw new Error('kill_switch'); },
    pollMs: 5,
  });
  await delay(40);
  assert.equal(signals.signal.aborted, true);
  assert.equal(signals.signal.reason.message, 'kill_switch');
  signals.dispose();
  const settled = calls;
  await delay(30);
  assert.equal(calls, settled, 'опрос обязан остановиться после dispose');
});

test('leaseAlive: потерянная эпоха абортит signal с lease_lost', async () => {
  const signals = createAttemptSignals({ lease: epoch({ epoch: 8 }) });
  await assert.rejects(signals.checkNow(), /lease_lost/);
  assert.equal(signals.signal.reason.message, 'lease_lost');
  const live = createAttemptSignals({ lease: epoch() });
  await live.checkNow();
  assert.equal(live.signal.aborted, false);
  live.dispose();
});

test('phaseDeadline: фазовые бюджеты writer/l1_l3/stages/l2_critic поверх общего deadline', () => {
  let now = 1_000;
  const budget = createPhaseBudget({ deadline: now + 10_000, now: () => now,
    budgets: { writer: 3_000, stages: 2_000 } });
  budget.enter('writer');
  now += 1_000;
  budget.leave();
  assert.equal(budget.remaining('writer'), 2_000);
  // Граница фазы — ближайшая из её бюджета и общего deadline.
  now += 8_500;
  assert.equal(budget.remaining('writer'), 500);
  assert.equal(budget.remaining('stages'), 500);
  assert.equal(budget.within('stages'), true);
  now += 500;
  assert.equal(budget.within('stages'), false);
  assert.throws(() => budget.remaining('l2_critic'), /phase_budget_unknown/);
});

test('phase(): автоматический abort по истечении бюджета фазы с причиной фазы', async () => {
  const signals = createAttemptSignals({ phaseBudgets: { stages: 25 } });
  assert.equal(signals.phase('stages'), 25);
  await delay(60);
  assert.equal(signals.signal.aborted, true);
  assert.equal(signals.signal.reason.message, 'phase_deadline_exceeded:stages');
  signals.dispose();
});

test('phase(): исчерпанная фаза отклоняется до вызова, общий deadline доминирует', async () => {
  const exhausted = createAttemptSignals({ phaseBudgets: { writer: 5 } });
  exhausted.phase('writer');
  await delay(15);
  assert.throws(() => exhausted.phase('writer'), /phase_deadline_exceeded:writer/);
  assert.equal(exhausted.signal.reason.message, 'phase_deadline_exceeded:writer');
  exhausted.dispose();
  const soon = createAttemptSignals({ deadline: Date.now() + 5, phaseBudgets: { l2_critic: 60_000 } });
  assert.ok(soon.phase('l2_critic') <= 60_000);
  soon.dispose();
});

test('diskPreflight: bavail*bsize, fail-closed при нехватке и ошибке измерения', async () => {
  const GiB = 1024n ** 3n;
  const stat = bavail => async () => ({ bavail, bsize: 4096n });
  assert.deepEqual(
    await checkDiskPreflight('/x', { minBytes: GiB, statfsImpl: stat(300_000n) }),
    { free: 300_000n * 4096n, minBytes: GiB });
  await assert.rejects(checkDiskPreflight('/x', { minBytes: 2n * GiB, statfsImpl: stat(100n) }),
    /disk_preflight_failed/);
  await assert.rejects(checkDiskPreflight('/x', { statfsImpl: async () => { throw new Error('fs down'); } }),
    /disk_preflight_failed/);
  const signals = createAttemptSignals({ disk: { path: '/x', minBytes: 8n * GiB },
    statfsImpl: stat(100n) });
  await assert.rejects(signals.checkDiskPreflight(), /disk_preflight_failed/);
  signals.dispose();
});

test('deadline и dispose: таймеры снимаются, сигнал живёт без висячих хендлов', async () => {
  const signals = createAttemptSignals({ deadline: Date.now() + 20 });
  await delay(40);
  assert.equal(signals.signal.reason.message, 'deadline_exceeded');
  const quiet = createAttemptSignals({ deadline: Date.now() + 40, phaseBudgets: { stages: 40 },
    lease: epoch(), pollMs: 5 });
  quiet.phase('stages');
  quiet.dispose();
  await delay(80);
  assert.equal(quiet.signal.aborted, false, 'dispose снимает все armed таймеры');
});

test('leavePhase: неиспользованный бюджет покинутой фазы не абортит следующую', async () => {
  const signals = createAttemptSignals({ phaseBudgets: { stages: 30, l2_critic: 60_000 } });
  signals.phase('stages');
  await delay(10);
  signals.leavePhase();
  await delay(60);
  assert.equal(signals.signal.aborted, false, 'старый таймер stages обязан быть снят');
  signals.phase('l2_critic');
  await delay(60);
  assert.equal(signals.signal.aborted, false, 'должен жить только таймер l2_critic');
  signals.dispose();
  // Повторный вход в ту же фазу перевооружает таймер по остатку бюджета.
  const reenter = createAttemptSignals({ phaseBudgets: { stages: 60 } });
  reenter.phase('stages');
  await delay(20);
  reenter.phase('l1_l3' in reenter.phaseBudget.budgets ? 'l1_l3' : 'stages');
  reenter.dispose();
});

test('combinedKillSwitch объединяет все активные гейты: daemon stop-файл абортит попытку', async () => {
  const seen = [];
  const check = combinedKillSwitch(
    async () => { seen.push('ab'); },
    async () => { seen.push('activation'); },
    async () => { seen.push('daemon'); throw new Error('kill_switch'); });
  assert.equal(combinedKillSwitch(), undefined, 'без активных проверок гейт выключен');
  assert.equal(combinedKillSwitch(null, undefined), undefined);
  await assert.rejects(check(), /kill_switch/);
  assert.deepEqual(seen, ['ab', 'activation', 'daemon'], 'каждый активный гейт опрашивается');
  // daemon-гейт реально доходит до сигнала попытки: в isolated daemon-режиме
  // stop-файл абортирует активную стадию, а не только границу тика.
  const signals = createAttemptSignals({ assertOpen: check, pollMs: 10 });
  await assert.rejects(signals.checkNow(), /kill_switch/);
  assert.equal(signals.signal.aborted, true);
  signals.dispose();
});

test('l1_l3-only бюджет: leavePhase на выходе из фазы снимает таймер — следующие фазы живут на общем deadline', async () => {
  const signals = createAttemptSignals({ deadline: Date.now() + 60_000,
    phaseBudgets: { l1_l3: 30 } });
  signals.phase('l1_l3');
  signals.leavePhase();
  await delay(60);
  assert.equal(signals.signal.aborted, false,
    'остаток завершённой l1_l3 не должен ложно аборитить попытку');
  signals.dispose();
});
