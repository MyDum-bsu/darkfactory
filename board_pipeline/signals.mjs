// Единый AbortSignal и бюджеты попытки: kill-switch (операторский стоп-файл
// через assertOpen), фазово-осведомлённый deadline (writer, l1_l3, stages,
// l2_critic), живая проверка lease (verifyHeld/epoch) и дисковый preflight
// (statfs, fail-closed). dispose() снимает все таймеры и слушатели —
// висящих setTimeout/setInterval после выхода попытки не остаётся.
// Только встроенные модули Node.

import { readdir, readFile, statfs } from 'node:fs/promises';

export const PHASES = Object.freeze(['writer', 'l1_l3', 'stages', 'l2_critic']);

export class AttemptSignalError extends Error {
  constructor(reason, options) {
    super(reason, options);
    this.reason = reason;
  }
}

const abortError = reason => new AttemptSignalError(reason);

// Фазовые бюджеты поверх общего deadline попытки. budgets: { writer, l1_l3,
// stages, l2_critic } в мс. enter()/leave() накапливают время фазы между
// повторными входами; remaining() учитывает и фазовый остаток, и общий
// deadline — меньший из двух определяет границу. Опциональный spent —
// уже измеренное время фаз (например, завершившийся writer до создания
// сигналов): бюджет учитывает его при проверке остатка.
export function createPhaseBudget({ deadline, budgets = {}, spent: initial = {}, now = () => Date.now() } = {}) {
  if (!Number.isSafeInteger(deadline)) throw new AttemptSignalError('phase_budget_invalid');
  for (const [phase, ms] of Object.entries(budgets)) {
    if (!PHASES.includes(phase) || !Number.isSafeInteger(ms) || ms < 1) {
      throw new AttemptSignalError('phase_budget_invalid');
    }
  }
  for (const [phase, ms] of Object.entries(initial)) {
    if (!PHASES.includes(phase) || !Number.isSafeInteger(ms) || ms < 0) {
      throw new AttemptSignalError('phase_budget_invalid');
    }
  }
  const spent = new Map(Object.entries(initial));
  let active = null;
  const elapsed = phase => (spent.get(phase) ?? 0) +
    (active?.phase === phase ? Math.max(0, now() - active.since) : 0);
  const remaining = phase => {
    const budget = budgets[phase];
    if (budget === undefined) throw new AttemptSignalError(`phase_budget_unknown:${phase}`);
    return Math.max(0, Math.min(budget - elapsed(phase), deadline - now()));
  };
  return Object.freeze({
    budgets: Object.freeze({ ...budgets }),
    remaining,
    // Абсолютная граница фазы: ближайшая из общего deadline и конца бюджета.
    deadline: phase => now() + remaining(phase),
    within: phase => remaining(phase) > 0,
    enter(phase) {
      if (budgets[phase] === undefined) throw new AttemptSignalError(`phase_budget_unknown:${phase}`);
      if (active) this.leave();
      active = { phase, since: now() };
    },
    leave() {
      if (!active) return;
      spent.set(active.phase, elapsed(active.phase));
      active = null;
    },
  });
}

// Объединение всех активных kill-switch проверок попытки в одну: ab-пилот,
// операторский activation-стоп и daemon --switch. Любой закрытый гейт рвёт
// опрос createAttemptSignals и абортит сигнал попытки — в isolated
// daemon-режиме перевод стоп-файла в 'stop' тоже инициирует cleanup
// активной стадии, а не только границу тика. Ни одной активной проверки —
// undefined (гейт выключен).
export function combinedKillSwitch(...checks) {
  const active = checks.filter(check => typeof check === 'function');
  if (!active.length) return undefined;
  return async () => { for (const check of active) await check(); };
}

// Дисковый preflight: свободное место = bavail * bsize (тот же расчёт, что
// ops/local/check-workspace-space.mjs). Нехватка или невозможность измерить —
// fail-closed отказ disk_preflight_failed до любого эффекта.
export async function checkDiskPreflight(path, { minBytes = 1n, statfsImpl = statfs } = {}) {
  let stat;
  try {
    stat = await statfsImpl(path, { bigint: true });
  } catch (cause) {
    throw new AttemptSignalError('disk_preflight_failed', { cause });
  }
  if (typeof stat?.bavail !== 'bigint' || typeof stat?.bsize !== 'bigint' ||
      stat.bavail < 0n || stat.bsize <= 0n) {
    throw new AttemptSignalError('disk_preflight_failed');
  }
  const free = stat.bavail * stat.bsize;
  if (free < minBytes) throw new AttemptSignalError('disk_preflight_failed');
  return { free, minBytes };
}

// Объединённый сигнал попытки. Любой сработавший гейт абортит signal с
// причиной-ошибкой (kill_switch | lease_lost | deadline_exceeded |
// phase_deadline_exceeded:<phase> | переданной ошибкой гейта).
// Опции:
//   deadline       — абсолютная метка времени попытки (мс epoch), опционально;
//   phaseBudgets   — { writer, l1_l3, stages, l2_critic } мс, опционально;
//   phaseSpent     — уже измеренное время фаз, опционально;
//   assertOpen     — операторский kill-switch/гейт, опционально;
//   lease          — { verifyHeld, taskId, epoch }, опционально;
//   disk           — { path, minBytes }, опционально;
//   pollMs         — период опроса kill-switch и lease (по умолчанию 5000);
//   now / statfsImpl / random — для инъекции (random — источник джиттера опроса,
//   по умолчанию Math.random).
export function createAttemptSignals({ deadline, phaseBudgets, phaseSpent, assertOpen, lease, disk,
  pollMs = 5000, now = () => Date.now(), statfsImpl = statfs, random = Math.random } = {}) {
  if (deadline !== undefined && !Number.isSafeInteger(deadline)) {
    throw new AttemptSignalError('attempt_signals_invalid');
  }
  if (lease !== undefined && (typeof lease.verifyHeld !== 'function' ||
      !Number.isSafeInteger(lease.epoch))) throw new AttemptSignalError('attempt_signals_invalid');
  if (!Number.isSafeInteger(pollMs) || pollMs < 1) throw new AttemptSignalError('attempt_signals_invalid');
  const controller = new AbortController();
  const { signal } = controller;
  const timers = new Set();
  const abort = reason => {
    if (!signal.aborted) controller.abort(reason instanceof Error ? reason : abortError(reason));
  };
  const arm = fn => {
    const timer = fn();
    timers.add(timer);
    return timer;
  };
  const budget = phaseBudgets === undefined ? null
    : createPhaseBudget({ deadline: deadline ?? Number.MAX_SAFE_INTEGER - 1,
      budgets: phaseBudgets, spent: phaseSpent ?? {}, now });

  if (deadline !== undefined) {
    arm(() => setTimeout(() => abort(abortError('deadline_exceeded')),
      Math.max(0, deadline - now())).unref?.());
  }
  // Lease-RPC коалесцируются: в полёте не более одного verifyHeld на попытку.
  // Пока предыдущий RPC не завершён, и опрос, и checkNow делят один shared
  // promise — на 8-10+ слотах нет шторма дублирующих продлений в Board.
  let leaseRpc = null;
  const verifyLease = () => {
    if (leaseRpc !== null) return leaseRpc;
    leaseRpc = Promise.resolve()
      .then(() => lease.verifyHeld(lease.taskId, lease.epoch))
      .finally(() => { leaseRpc = null; });
    return leaseRpc;
  };
  // Живой опрос kill-switch и lease: любая неуспешная проверка абортит
  // signal. Опрос fail-closed: ошибка чтения — тоже срабатывание.
  const poll = async () => {
    if (signal.aborted) return;
    if (assertOpen !== undefined) {
      try { await assertOpen(); }
      catch (cause) { return abort(cause instanceof Error ? cause : abortError('kill_switch')); }
    }
    if (lease !== undefined) {
      try {
        const live = await verifyLease();
        if (live?.epoch !== lease.epoch) throw abortError('lease_lost');
      } catch (cause) { return abort(cause instanceof Error ? cause : abortError('lease_lost')); }
    }
  };
  // Рекурсивный setTimeout вместо слепого setInterval: следующий опрос
  // планируется только ПОСЛЕ завершения предыдущего async-прохода, с малым
  // джиттером (до 10% pollMs) против синхронного шторма слотов. Медленный
  // Board больше не накапливает перекрывающиеся in-flight RPC.
  let disposed = false;
  if (assertOpen !== undefined || lease !== undefined) {
    const jitter = () => Math.floor(random() * Math.max(1, Math.floor(pollMs / 10)));
    const schedulePoll = () => {
      if (disposed || signal.aborted) return;
      const timer = setTimeout(() => {
        timers.delete(timer);
        poll().catch(error => abort(error)).then(schedulePoll);
      }, pollMs + jitter());
      timer.unref?.();
      timers.add(timer);
    };
    schedulePoll();
  }

  // Таймер текущей вооружённой фазы: неиспользованный бюджет покинутой фазы
  // не должен аборитить следующую. Перевход в другую фазу так же снимает
  // таймер предыдущей (phase() вооружает заново по остатку бюджета).
  let phaseTimer = null;
  const disarmPhase = () => {
    if (phaseTimer !== null) {
      clearTimeout(phaseTimer);
      timers.delete(phaseTimer);
      phaseTimer = null;
    }
  };
  const api = {
    signal,
    phaseBudget: budget,
    // Разовая проверка всех гейтов (без ожидания опроса): та же семантика
    // абортов, но синхронно выбрасывает причину вызывающему.
    async checkNow() {
      if (assertOpen !== undefined) {
        try { await assertOpen(); }
        catch (cause) {
          abort(cause instanceof Error ? cause : abortError('kill_switch'));
          throw signal.reason;
        }
      }
      if (lease !== undefined) {
        try {
          const live = await verifyLease();
          if (live?.epoch !== lease.epoch) throw abortError('lease_lost');
        } catch (cause) {
          abort(cause instanceof Error ? cause : abortError('lease_lost'));
          throw signal.reason;
        }
      }
      if (signal.aborted) throw signal.reason;
    },
    // Входит в фазу и вооружает abort по её границе (или общему deadline).
    // Возвращает оставшееся время фазы в мс.
    phase(name) {
      if (!budget) throw new AttemptSignalError('phase_budget_unknown');
      disarmPhase();
      budget.enter(name);
      const remaining = budget.remaining(name);
      if (remaining <= 0) {
        const reason = abortError(`phase_deadline_exceeded:${name}`);
        abort(reason);
        throw reason;
      }
      phaseTimer = arm(() => setTimeout(() => abort(abortError(`phase_deadline_exceeded:${name}`)),
        remaining).unref?.());
      return remaining;
    },
    leavePhase() { disarmPhase(); budget?.leave(); },
    checkDiskPreflight: () => checkDiskPreflight(disk?.path, { minBytes: disk?.minBytes ?? 1n, statfsImpl }),
    // Гарантированная очистка: все таймеры и опросы снимаются.
    dispose() {
      disposed = true;
      for (const timer of timers) { clearTimeout(timer); clearInterval(timer); }
      timers.clear();
      budget?.leave();
    },
  };
  return api;
}

// Остановка процессной группы по уникальному маркеру запуска (путь mkdtemp).
// Процесс ищется в /proc по cmdline и environ — так он находится и после
// execv, когда имя лаунчера уже отсутствует в argv. Из /proc/pid/stat берётся
// группа (поле после comm — comm может содержать пробелы, разбор после
// последней ')'), группа добивается SIGKILL; собственная группа исключена.
export async function killProcessGroupByMarker(marker) {
  const zap = target => {
    try { process.kill(target, 'SIGKILL'); } catch { /* уже завершён */ }
  };
  try {
    const ownStat = await readFile('/proc/self/stat', 'utf8');
    const ownPgrp = Number(ownStat.slice(ownStat.lastIndexOf(')') + 2).trim().split(' ')[2]);
    const needle = Buffer.from(marker);
    const groups = new Set();
    for (const pid of await readdir('/proc')) {
      if (!/^\d+$/.test(pid)) continue;
      let stat;
      try {
        const [cmdline, environ] = await Promise.all([
          readFile(`/proc/${pid}/cmdline`).catch(() => Buffer.alloc(0)),
          readFile(`/proc/${pid}/environ`).catch(() => Buffer.alloc(0)),
        ]);
        if (!cmdline.includes(needle) && !environ.includes(needle)) continue;
        stat = await readFile(`/proc/${pid}/stat`, 'utf8');
      } catch { continue; /* процесс ушёл между чтениями */ }
      const rest = stat.slice(stat.lastIndexOf(')') + 2).trim().split(' ');
      const pgrp = Number(rest[2]);
      if (Number.isSafeInteger(pgrp) && pgrp > 1 && pgrp !== ownPgrp) groups.add(pgrp);
      else zap(Number(pid));
    }
    for (const pgrp of groups) zap(-pgrp);
  } catch { /* best effort: таймаут раннера — запасная граница */ }
}
