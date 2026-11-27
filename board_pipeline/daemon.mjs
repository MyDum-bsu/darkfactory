import { mkdir, open, rename, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { checkBudget } from './workspace-budget.mjs';
import { PilotDenied } from './pilot-gate.mjs';

export const DEFAULT_INTERVAL_MS = 3500;
export const MIN_INTERVAL_MS = 250;
// Терминальные фазы попытки — те же, что у контроллера.
export const TERMINAL_PHASES = new Set(['done', 'hold', 'uncertain', 'lease_lost']);

// Журнал демона: JSONL с ротацией по размеру. Хранится в приватном state-каталоге
// рядом с attempt.json; старые файлы сдвигаются name.N.jsonl и ограничены keep.
export class RotatingJournal {
  constructor({ directory, name = 'daemon', maxBytes = 4 * 1024 * 1024, keep = 5 } = {}) {
    if (typeof directory !== 'string' || !directory) throw new Error('journal directory is required');
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024 ||
        !Number.isSafeInteger(keep) || keep < 1 || keep > 64) {
      throw new Error('invalid journal limits');
    }
    this.directory = directory;
    this.path = join(directory, `${name}.jsonl`);
    this.maxBytes = maxBytes;
    this.keep = keep;
    this.name = name;
  }

  async append(event) {
    const line = `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    let rotated = false;
    const probe = await open(this.path, 'a+', 0o600);
    try {
      const st = await probe.stat();
      rotated = st.size > 0 && st.size + line.length > this.maxBytes;
    } finally { await probe.close(); }
    if (rotated) await this.rotate();
    const fd = await open(this.path, 'a', 0o600);
    try {
      await fd.write(line);
      await fd.sync();
    } finally { await fd.close(); }
  }

  async rotate() {
    for (let i = this.keep - 1; i >= 1; i--) {
      await rename(join(this.directory, `${this.name}.${i}.jsonl`),
        join(this.directory, `${this.name}.${i + 1}.jsonl`)).catch(error => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
    await rename(this.path, join(this.directory, `${this.name}.1.jsonl`)).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

// Фоновый цикл контроллера. Все внешние зависимости — инъекции:
//   tick        — один сериализованный ход контроллера (advanceWithProjection под геймом).
//   assertOpen  — kill-switch run/stop (createPilotSwitch): бросок = стоп.
//   diskPath/checkDisk — дисковый preflight >= 8 GiB до каждого тика; при нехватке
//                 тик без активной попытки не запускается и LLM не тратится.
//   signal      — AbortSignal для тестов и встраивания; SIGTERM/SIGINT ставятся сами.
//   onTick      — политика после тика: вернуть 'stop' для остановки демона.
//   hasActiveAttempt — опциональный колбэк: true = есть активная попытка в полёте.
//                 При отказе дискового preflight тик с активной попыткой ВСЕГДА
//                 выполняется (lease maintenance/reconciliation не должны молча
//                 пропускаться — иначе активный писатель теряет lease 1800s);
//                 тик получает { preflightFailed: true } и гейтует только НОВЫЕ
//                 аллокации. Без активной попытки тик пропускается, как раньше.
//   maxTickErrorBackoffMs — верхняя граница экспоненциального backoff после
//                 повторных tick_error (по умолчанию 60_000).
// Пустой тик не вызывает ничего, кроме журнала: ноль LLM на холостом ходу.
export async function runDaemon({ tick, intervalMs = DEFAULT_INTERVAL_MS, assertOpen,
  diskPath, checkDisk, journal, signal, installSignalHandlers = true, sleep = delay, onTick,
  eventBus, hasActiveAttempt, maxTickErrorBackoffMs = 60_000 }) {
  if (typeof tick !== 'function') throw new Error('tick is required');
  if (!Number.isSafeInteger(intervalMs) || intervalMs < MIN_INTERVAL_MS) {
    throw new Error(`interval must be an integer >= ${MIN_INTERVAL_MS} ms`);
  }
  if (!Number.isSafeInteger(maxTickErrorBackoffMs) || maxTickErrorBackoffMs < 1) {
    throw new Error('maxTickErrorBackoffMs must be a positive integer');
  }
  const disk = checkDisk ?? (diskPath ? async () => {
    const budget = checkBudget(await statfs(diskPath, { bigint: true }), 'worktree');
    if (!budget.allowed) {
      throw new Error(`disk budget: ${budget.availableGiB} GiB free; worktree requires ${budget.minGiB} GiB`);
    }
  } : null);
  const report = event => journal?.append(event).catch(() => {});
  // Fail-open события демона для Control Room (V2-3): bus необязателен и
  // никогда не влияет на цикл.
  const emit = (kind, detail) => eventBus?.emit({ kind, role: 'daemon', detail });
  // Активная попытка не должна терять lease из-за дискового preflight:
  // неопределённость колбэка трактуется в пользу сохранения lease.
  const probeActiveAttempt = async () => {
    if (!hasActiveAttempt) return false;
    try { return Boolean(await hasActiveAttempt()); }
    catch (error) {
      await report({ event: 'has_active_attempt_error', message: error.message });
      return true;
    }
  };
  // Стартовый preflight: демон с переполненным диском не запускается вообще —
  // если только не восстановил активную попытку из WAL: её lease maintenance
  // важнее, новые аллокации гейтуются флагом preflightFailed внутри тика.
  if (disk) {
    try { await disk(); } catch (error) {
      if (!await probeActiveAttempt()) throw error;
      await report({ event: 'disk_budget_degraded', message: error.message, startup: true });
      emit('daemon.disk_blocked', { message: error.message, startup: true });
    }
  }

  let stopping = Boolean(signal?.aborted);
  let wake = null;
  const requestStop = () => { stopping = true; wake?.(); };
  const installed = [];
  if (installSignalHandlers) {
    for (const sig of ['SIGTERM', 'SIGINT']) {
      process.once(sig, requestStop);
      installed.push(sig);
    }
  }
  signal?.addEventListener('abort', requestStop, { once: true });

  const wait = async ms => {
    if (stopping) return;
    if (sleep !== delay || wake) return sleep(ms);
    const ac = new AbortController();
    wake = () => ac.abort();
    try {
      await delay(ms, null, { signal: ac.signal });
    } catch (error) {
      if (!ac.signal.aborted) throw error;
    } finally { wake = null; }
  };

  let ticks = 0;
  let consecutiveErrors = 0;
  let stopped = 'signal';
  await report({ event: 'daemon_start', intervalMs });
  emit('daemon.started', { intervalMs });
  try {
    for (;;) {
      if (stopping) break;
      if (assertOpen) {
        try { await assertOpen(); } catch { stopped = 'kill_switch'; break; }
      }
      let preflightFailed = false;
      if (disk) {
        try { await disk(); } catch (error) {
          await report({ event: 'disk_budget_blocked', message: error.message });
          emit('daemon.disk_blocked', { message: error.message });
          // Отказ preflight гейтует только НОВЫЕ аллокации: активная попытка
          // продолжает lease maintenance/reconciliation, иначе писатель молча
          // теряет lease 1800s при переполненном диске.
          if (!await probeActiveAttempt()) {
            if (stopping) break;
            await wait(intervalMs);
            continue;
          }
          preflightFailed = true;
          await report({ event: 'disk_budget_degraded', message: error.message });
        }
      }
      let result;
      try {
        result = await tick({ preflightFailed });
      } catch (error) {
        if (error instanceof PilotDenied) { stopped = 'kill_switch'; break; }
        // Ошибка тика — не повод убивать фоновый сервис; журналируем и ждём
        // с ограниченным экспоненциальным backoff против шторма повторов.
        consecutiveErrors++;
        const backoffMs = Math.min(
          intervalMs * 2 ** Math.min(consecutiveErrors - 1, 10), maxTickErrorBackoffMs);
        const message = error?.message;
        const code = typeof error?.code === 'string' && /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(error.code)
          ? error.code
          : (typeof message === 'string' && message.match(/^[a-z][a-z0-9_]{2,}/)?.[0]) || 'tick_error';
        const detail = { code, message, consecutiveErrors, backoffMs };
        await report({ event: 'tick_error', ...detail });
        emit('daemon.tick_error', detail);
        if (stopping) break;
        await wait(backoffMs);
        continue;
      }
      consecutiveErrors = 0;
      ticks++;
      // Исключение в onTick — не причина падения демона: журналируем и
      // продолжаем цикл, как будто политика ничего не вернула.
      let action;
      try {
        action = await onTick?.(result);
      } catch (error) {
        await report({ event: 'ontick_error', message: error.message });
        emit('daemon.ontick_error', { message: error.message });
        action = undefined;
      }
      await report({ event: 'tick', ticks, phase: result?.phase,
        ...(result?.reason !== undefined ? { reason: result.reason } : {}) });
      emit('daemon.tick', { ticks, phase: result?.phase ?? null, reason: result?.reason ?? null });
      if (action === 'stop') { stopped = 'terminal'; break; }
      if (stopping) break;
      // Сигнал во время ожидания будит цикл сразу, активный тик не прерывается:
      // слот завершает тик и остаётся в согласованной фазе WAL.
      await wait(intervalMs);
    }
    if (stopped === 'kill_switch') emit('daemon.kill_switch', { ticks });
  } finally {
    for (const sig of installed) process.removeListener(sig, requestStop);
    signal?.removeEventListener('abort', requestStop);
    emit('daemon.stopped', { reason: stopped, ticks });
    await journal?.append({ event: 'daemon_stop', reason: stopped, ticks }).catch(() => {});
  }
  return { ticks, stopped };
}
