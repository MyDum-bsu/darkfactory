import { mkdir, open, rename, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { checkBudget } from '../ops/local/check-workspace-space.mjs';
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
//                 тик не запускается и LLM не тратится.
//   signal      — AbortSignal для тестов и встраивания; SIGTERM/SIGINT ставятся сами.
//   onTick      — политика после тика: вернуть 'stop' для остановки демона.
// Пустой тик не вызывает ничего, кроме журнала: ноль LLM на холостом ходу.
export async function runDaemon({ tick, intervalMs = DEFAULT_INTERVAL_MS, assertOpen,
  diskPath, checkDisk, journal, signal, installSignalHandlers = true, sleep = delay, onTick }) {
  if (typeof tick !== 'function') throw new Error('tick is required');
  if (!Number.isSafeInteger(intervalMs) || intervalMs < MIN_INTERVAL_MS) {
    throw new Error(`interval must be an integer >= ${MIN_INTERVAL_MS} ms`);
  }
  const disk = checkDisk ?? (diskPath ? async () => {
    const budget = checkBudget(await statfs(diskPath, { bigint: true }), 'worktree');
    if (!budget.allowed) {
      throw new Error(`disk budget: ${budget.availableGiB} GiB free; worktree requires ${budget.minGiB} GiB`);
    }
  } : null);
  // Стартовый preflight: демон с переполненным диском не запускается вообще.
  if (disk) await disk();

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

  const report = event => journal?.append(event).catch(() => {});
  let ticks = 0;
  let stopped = 'signal';
  await report({ event: 'daemon_start', intervalMs });
  try {
    for (;;) {
      if (stopping) break;
      if (assertOpen) {
        try { await assertOpen(); } catch { stopped = 'kill_switch'; break; }
      }
      if (disk) {
        try { await disk(); } catch (error) {
          await report({ event: 'disk_budget_blocked', message: error.message });
          if (stopping) break;
          await wait(intervalMs);
          continue;
        }
      }
      let result;
      try {
        result = await tick();
      } catch (error) {
        if (error instanceof PilotDenied) { stopped = 'kill_switch'; break; }
        // Ошибка тика — не повод убивать фоновый сервис; журналируем и ждём.
        await report({ event: 'tick_error', message: error.message });
        if (stopping) break;
        await wait(intervalMs);
        continue;
      }
      ticks++;
      const action = await onTick?.(result);
      await report({ event: 'tick', ticks, phase: result?.phase,
        ...(result?.reason !== undefined ? { reason: result.reason } : {}) });
      if (action === 'stop') { stopped = 'terminal'; break; }
      if (stopping) break;
      // Сигнал во время ожидания будит цикл сразу, активный тик не прерывается:
      // слот завершает тик и остаётся в согласованной фазе WAL.
      await wait(intervalMs);
    }
  } finally {
    for (const sig of installed) process.removeListener(sig, requestStop);
    signal?.removeEventListener('abort', requestStop);
    await journal?.append({ event: 'daemon_stop', reason: stopped, ticks }).catch(() => {});
  }
  return { ticks, stopped };
}
