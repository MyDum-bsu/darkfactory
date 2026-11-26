// VS-3 Resource Steward — детерминированный сторож диска и RAM. 0 токенов LLM
// на штатном ходе: модель просыпается ТОЛЬКО через хук эскалации, когда после
// уборки Тира 1 свободное место всё ещё ниже критического порога. Тир 1 трогает
// только 100% воспроизводимый мусор из фиксированного allowlist — Docker build
// cache и висячие образы, просроченные /tmp/df-* и каталоги /tmp/pytest-of-*,
// содержимое кэшей pip/npm/uv старше N дней. Worktree, .bb, проекты и
// пользовательские файлы недостижимы
// для удаления по построению: путь вне allowlist не классифицируется как
// удаляемый и остаётся только в отчёте. RAM < 1.5 GiB MemAvailable → стоп
// idle-тредов BB; активные, закреплённые, с очередью или фоновой работой и
// собственный тред не останавливаются никогда.
//
// Журнал — JSONL, каталог 0700, файл 0600 (по умолчанию вне репозитория,
// ~/.local/state/resource-steward/journal.jsonl). --dry-run не производит ни
// одного эффекта: ни удаления, ни docker prune, ни остановки тредов, ни вызова
// хука эскалации, ни записи в журнал — только план и read-only измерения.

import { execFile } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open, readdir, readFile, realpath, rm, rmdir, statfs } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const GiB = 1024n ** 3n;
const DAY_MS = 86_400_000;

export const DISK_TIER1_GIB = 8n; // < 8 GiB → уборка Тира 1, на уровне дискового floor демона
export const DISK_ALARM_GIB = 2n; // < 2 GiB после Тира 1 → тревога + эскалация
export const RAM_MIN_GIB = 1.5;   // < 1.5 GiB MemAvailable → стоп idle-тредов
// Точная граница 1.5 GiB в байтах — сравнение в bigint, без float.
export const RAM_MIN_BYTES = 1_610_612_736n;

export const DEFAULT_MOUNTS = Object.freeze(['/']);
// Allowlist прямых детей /tmp: df-* (любые записи) и pytest-of-* (только
// каталоги — pytest копит прогоны в /tmp/pytest-of-<user>/pytest-<N>).
export const TMP_ALLOW_RULES = Object.freeze([
  { pattern: /^df-/, dirOnly: false },
  { pattern: /^pytest-of-/, dirOnly: true },
  { pattern: /^board-(check|review|visual|arbiter)-/, dirOnly: true },
  { pattern: /^neon-review-/, dirOnly: true },
]);

// Кэши pip/npm/uv: фиксированные корни, привязка к XDG_CACHE_HOME для тестов
// и нестандартных установок. npm — только _cacache, самый строгий вариант.
export function defaultCacheRoots(env = process.env) {
  const cacheHome = env.XDG_CACHE_HOME || join(homedir(), '.cache');
  return Object.freeze([
    { kind: 'pip', path: join(cacheHome, 'pip') },
    { kind: 'uv', path: join(cacheHome, 'uv') },
    { kind: 'npm', path: join(homedir(), '.npm', '_cacache') },
  ]);
}

export const defaultJournalPath = () =>
  join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'resource-steward', 'journal.jsonl');

// --- Пороги ---------------------------------------------------------------

// Строгие неравенства карточки: ровно на пороге — ещё «ок»/«Тир 1», тревога
// строго ниже 2 GiB. Границы проверяются в байтах (bigint).
export function evaluateDisk(availableBytes) {
  if (typeof availableBytes !== 'bigint' || availableBytes < 0n) {
    throw new Error('available bytes must be a non-negative bigint');
  }
  if (availableBytes < DISK_ALARM_GIB * GiB) return 'alarm';
  if (availableBytes < DISK_TIER1_GIB * GiB) return 'tier1';
  return 'ok';
}

export function evaluateRam(availableBytes) {
  if (typeof availableBytes !== 'bigint' || availableBytes < 0n) {
    throw new Error('available bytes must be a non-negative bigint');
  }
  return availableBytes < RAM_MIN_BYTES;
}

export const availableGiB = bytes => Number((bytes * 10_000n) / GiB) / 10_000;

// --- Измерения ------------------------------------------------------------

export async function measureMount(path, statfsImpl = statfs) {
  const st = await statfsImpl(path, { bigint: true });
  if (typeof st?.bavail !== 'bigint' || typeof st?.bsize !== 'bigint' || st.bavail < 0n || st.bsize <= 0n) {
    throw new Error(`filesystem space could not be measured: ${path}`);
  }
  return st.bavail * st.bsize;
}

// /proc/meminfo: MemAvailable в kB. Отсутствие поля — честная ошибка, не ноль.
export function parseMemInfo(text) {
  const line = String(text).split('\n').find(l => /^MemAvailable:\s/.test(l));
  if (!line) throw new Error('MemAvailable not found in meminfo');
  const kb = Number(line.replace(/^MemAvailable:\s*/, '').split(/\s+/)[0]);
  if (!Number.isSafeInteger(kb) || kb < 0) throw new Error('MemAvailable value unreadable');
  return BigInt(kb) * 1024n;
}

export const readMemAvailable = async () => parseMemInfo(await readFile('/proc/meminfo', 'utf8'));

// --- Тир 1: классификация и уборка -----------------------------------------

// /tmp — единственное место вне кэшей, где сторож удаляет: только прямые дети
// tmpRoot, только по allowlist-маскам df-* / pytest-of-*, только просроченные
// по mtime. Символические ссылки и специальные файлы не удаляются никогда.
export function classifyTmpEntry(name, stat, { cutoffMs }) {
  if (typeof name !== 'string' || !name || name === '.' || name === '..' || name.includes('/') || name.includes('\0')) {
    return { action: 'refuse', reason: 'unsafe_name' };
  }
  const rule = TMP_ALLOW_RULES.find(r => r.pattern.test(name));
  if (!rule) return { action: 'keep', reason: 'outside_allowlist' };
  if (stat.isSymbolicLink()) return { action: 'refuse', reason: 'symlink' };
  if (!stat.isFile() && !stat.isDirectory()) return { action: 'refuse', reason: 'special_file' };
  if (rule.dirOnly && !stat.isDirectory()) return { action: 'keep', reason: 'allowlist_dir_only' };
  if (stat.mtimeMs >= cutoffMs) return { action: 'keep', reason: 'not_expired' };
  return { action: 'delete', kind: stat.isDirectory() ? 'dir' : 'file' };
}

export async function pruneExpiredTmp({ tmpRoot, cutoffMs, journal, dryRun, fsImpl }) {
  const fs = fsImpl ?? { readdir, lstat, rm };
  const result = { deleted: 0, kept: 0, refused: 0, errors: 0 };
  let names;
  try {
    names = await fs.readdir(tmpRoot);
  } catch (error) {
    await journal({ event: 'tmp_error', tmpRoot, error: error.message });
    result.errors++;
    return result;
  }
  for (const name of names) {
    const path = join(tmpRoot, name);
    let stat;
    try {
      stat = await fs.lstat(path);
    } catch {
      continue; // запись исчезла во время обхода — не наш случай
    }
    const verdict = classifyTmpEntry(name, stat, { cutoffMs });
    if (verdict.action === 'delete') {
      if (dryRun) {
        result.deleted++;
        continue;
      }
      try {
        await fs.rm(path, { recursive: verdict.kind === 'dir', force: false });
        await journal({ event: 'tmp_delete', path, kind: verdict.kind });
        result.deleted++;
      } catch (error) {
        await journal({ event: 'tmp_delete_error', path, error: error.message });
        result.errors++;
      }
    } else if (verdict.action === 'refuse') {
      await journal({ event: 'tmp_refuse', path, reason: verdict.reason });
      result.refused++;
    } else {
      result.kept++;
    }
  }
  return result;
}

// Содержимое кэшей pip/npm/uv: пофайловая уборка по возрасту (файл старше N
// дней → удалить), затем опустевшие старые каталоги. Границы: только реальные
// каталоги из allowlist, symlinks и специальные файлы не удаляются, глубина
// и число записей ограничены, чтобы тик таймера не зависал.
export async function pruneCacheRoot({ root, cutoffMs, journal, dryRun, fsImpl, maxEntries = 50_000, maxDepth = 16 }) {
  const fs = fsImpl ?? { readdir, lstat, rm, rmdir, realpath };
  const result = { root, deletedFiles: 0, removedDirs: 0, refused: 0, truncated: false, errors: 0 };
  let rootStat;
  try {
    rootStat = await fs.lstat(root);
  } catch (error) {
    await journal({ event: 'cache_skip', root, error: error.message });
    result.errors++;
    return result;
  }
  if (rootStat.isSymbolicLink()) {
    await journal({ event: 'cache_skip', root, reason: 'symlink' });
    result.refused++;
    return result;
  }
  let base;
  try {
    base = await fs.realpath(root);
  } catch (error) {
    await journal({ event: 'cache_skip', root, error: error.message });
    result.errors++;
    return result;
  }
  let visited = 0;
  const walk = async (dir, depth) => {
    let names;
    try {
      names = await fs.readdir(dir);
    } catch (error) {
      await journal({ event: 'cache_error', dir, error: error.message });
      result.errors++;
      return;
    }
    for (const name of names) {
      if (++visited > maxEntries) {
        result.truncated = true;
        return;
      }
      if (depth > maxDepth) {
        result.truncated = true;
        return;
      }
      const path = join(dir, name);
      let stat;
      try {
        stat = await fs.lstat(path);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
        await journal({ event: 'cache_refuse', path, reason: stat.isSymbolicLink() ? 'symlink' : 'special_file' });
        result.refused++;
        continue;
      }
      if (stat.isDirectory()) {
        await walk(path, depth + 1);
        // Опустевший каталог старше порога — тоже мусор; непустой оставляем.
        // rmdir, а не rm: каталог уже проверен на пустоту, рекурсия не нужна.
        try {
          const rest = await fs.readdir(path);
          if (rest.length === 0 && stat.mtimeMs < cutoffMs) {
            if (!dryRun) await fs.rmdir(path);
            result.removedDirs++;
          }
        } catch {
          // исчез или занят — не наш случай
        }
      } else if (stat.mtimeMs < cutoffMs) {
        if (dryRun) {
          result.deletedFiles++;
          continue;
        }
        try {
          await fs.rm(path, { force: false });
          result.deletedFiles++;
        } catch (error) {
          await journal({ event: 'cache_error', path, error: error.message });
          result.errors++;
        }
      }
    }
  };
  await walk(base, 0);
  await journal({ event: 'cache_prune', ...result });
  return result;
}

// Docker: только два канонических recreate-безопасных действия — build cache
// и висячие образы. Ни -a, ни volumes, ни контейнеров. Ошибка докера
// журналируется, тик продолжается: сторож не падает из-за мусорщика.
export const DOCKER_ACTIONS = Object.freeze([
  { args: Object.freeze(['builder', 'prune', '-f']), kind: 'build_cache' },
  { args: Object.freeze(['image', 'prune', '-f']), kind: 'dangling_images' },
]);

export async function dockerPrune({ execDocker, journal, dryRun }) {
  const results = [];
  for (const action of DOCKER_ACTIONS) {
    if (dryRun) {
      results.push({ ...action, dryRun: true });
      continue;
    }
    try {
      const outcome = await execDocker(action.args);
      await journal({
        event: 'docker', kind: action.kind, args: action.args,
        code: outcome.code, stderr: String(outcome.stderr ?? '').slice(-400),
      });
      results.push({ kind: action.kind, args: action.args, code: outcome.code });
    } catch (error) {
      await journal({ event: 'docker_error', kind: action.kind, error: error.message });
      results.push({ kind: action.kind, args: action.args, error: error.message });
    }
  }
  return results;
}

// --- BB: только однозначно пустующие треды ----------------------------------

const WORKER_SESSION_ID = /^(?:thr_[a-z0-9]+|df-[a-z0-9_-]{1,12}-[a-f0-9]{10}|subproc-[a-f0-9]{12})$/;
const BACKGROUND_KEYS = ['activeBackgroundAgentCount', 'activeBackgroundCommandCount', 'activePlanModeCount', 'activeWorkflowCount'];
const hasBackgroundWork = activity =>
  !!activity && BACKGROUND_KEYS.some(key => Number(activity[key]) > 0);

// Остановить можно ТОЛЬКО тред со статусом 'idle' без закрепления, очереди,
// интеракции и фоновой активности. Незнакомый статус, свой тред и любая
// двусмысленность — skip, не stop. Активные и закреплённые защищены.
export function selectIdleThreads(threads, { pinnedThreads = [], selfThreadId } = {}) {
  const pinned = new Set(pinnedThreads);
  const stoppable = [];
  const skipped = [];
  for (const thread of Array.isArray(threads) ? threads : []) {
    const id = thread?.id;
    if (!WORKER_SESSION_ID.test(id ?? '')) continue;
    if (id === selfThreadId) { skipped.push({ id, reason: 'self' }); continue; }
    if (pinned.has(id)) { skipped.push({ id, reason: 'pinned_by_config' }); continue; }
    if (thread.status !== 'idle') { skipped.push({ id, reason: `status:${thread.status ?? 'unknown'}` }); continue; }
    if (thread.pinnedAt) { skipped.push({ id, reason: 'pinned' }); continue; }
    if (thread.queuedWork && thread.queuedWork !== 'none') { skipped.push({ id, reason: 'queued_work' }); continue; }
    if (thread.hasPendingInteraction === true) { skipped.push({ id, reason: 'pending_interaction' }); continue; }
    if (hasBackgroundWork(thread.activity)) { skipped.push({ id, reason: 'background_activity' }); continue; }
    stoppable.push({ id });
  }
  return { stoppable, skipped };
}

// bb thread list --json: массив или {threads:[...]}; {ok:false} — ошибка CLI.
export function parseBbThreadList(stdout) {
  const parsed = JSON.parse(stdout);
  if (parsed && parsed.ok === false) throw new Error(parsed?.error?.message ?? 'bb thread list failed');
  return Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.threads) ? parsed.threads : []);
}

// hc ls --json: ListResult с terminals или массив совместимости. Имя терминала —
// детерминированный runtime id воркера; address остаётся уникальной целью kill.
export function parseHcTerminalList(stdout) {
  const parsed = JSON.parse(stdout);
  if (parsed && parsed.ok === false) throw new Error(parsed?.error?.message ?? 'hc ls failed');
  return Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.terminals) ? parsed.terminals : []);
}

const hcTerminalStatus = terminal => {
  if (terminal?.state !== 'live') return terminal?.state ?? 'unknown';
  const status = typeof terminal?.status === 'string' ? terminal.status : terminal?.status?.state;
  return typeof status === 'string' && status ? status : 'running';
};

export function selectIdleHcTerminals(terminals, { pinnedThreads = [], selfThreadId } = {}) {
  const rows = Array.isArray(terminals) ? terminals : [];
  const normalized = rows.map(terminal => ({
    ...terminal,
    id: terminal?.name,
    status: hcTerminalStatus(terminal),
  }));
  const selected = selectIdleThreads(normalized, { pinnedThreads, selfThreadId });
  const byName = new Map(rows.filter(t => typeof t?.name === 'string').map(t => [t.name, t]));
  return {
    stoppable: selected.stoppable.map(({ id }) => {
      const source = byName.get(id);
      return { id, ...(typeof source?.address === 'string' && source.address ? { address: source.address } : {}) };
    }),
    skipped: selected.skipped,
  };
}

// --- Журнал -----------------------------------------------------------------

// Журнал: JSONL, каталог 0700, файл 0600, каждая строка — валидный JSON с ts.
// fsync после записи: журнал — доказательство действий, не телеметрия.
// Возвращает вызываемую функцию записи с методом close.
export async function openJournal(path, fsImpl) {
  const fs = fsImpl ?? { mkdir, open };
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND | (fsConstants.O_NOFOLLOW ?? 0);
  const fd = await fs.open(path, flags, 0o600);
  try {
    await fd.chmod(0o600); // существующий файл мог быть создан с другими правами
  } catch (error) {
    try { await fd.close(); } catch {}
    throw error;
  }
  const write = async entry => {
    await fd.write(`${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
    await fd.sync();
  };
  return Object.assign(write, { close: async () => fd.close() });
}

const noopJournal = Object.assign(async () => {}, { close: async () => {} });

// --- Тревога и эскалация -----------------------------------------------------

const ALARM_QUESTION = mount =>
  `Свободное место на «${mount}» после уборки Тира 1 ниже ${DISK_ALARM_GIB} GiB. ` +
  'Запустить read-only расследование LLM-агента Steward для выявления нетипичного потребителя?';

// Тревога: одна эскалация за тик, по худшему монту. Payload уходит JSON'ом на
// stdin хука; сам сторож не содержит ни токенов, ни вызовов моделей. Dry-run
// и штатный ход хук не вызывают — это единственная точка пробуждения LLM.
export async function raiseAlarm({ mount, availableBytes, journalPath, escalate, journal, dryRun }) {
  const payload = {
    reason: 'disk_alarm',
    mount,
    thresholdGiB: Number(DISK_ALARM_GIB),
    availableGiB: availableGiB(availableBytes),
    afterTier1: true,
    journalPath: journalPath ?? null,
    question: ALARM_QUESTION(mount),
  };
  if (dryRun) return { raised: true, escalated: false, plannedEscalation: true, payload };
  await journal({ event: 'alarm', ...payload });
  if (typeof escalate !== 'function') {
    await journal({ event: 'escalation_skipped', reason: 'no_hook_configured' });
    return { raised: true, escalated: false };
  }
  let outcome;
  try {
    outcome = await escalate(payload);
  } catch (error) {
    outcome = { error: error.message };
  }
  await journal({
    event: 'escalation',
    code: outcome?.code ?? null,
    detail: String(outcome?.detail ?? outcome?.error ?? '').slice(0, 400),
  });
  return { raised: true, escalated: true, outcome };
}

// --- Тик --------------------------------------------------------------------

const validDays = days => Number.isFinite(days) && days > 0 && days <= 365;

export async function runSteward(options) {
  const {
    mounts = DEFAULT_MOUNTS,
    tmpRoot = '/tmp',
    cacheRoots = defaultCacheRoots(),
    tmpDays = 7,
    cacheDays = 7,
    journalPath,
    journalFactory = openJournal,
    dockerEnabled = true,
    execDocker,
    execBb,
    execHc,
    runtime = 'auto',
    pinnedThreads = [],
    selfThreadId = process.env.BB_THREAD_ID,
    escalate,
    dryRun = false,
    now = Date.now(),
    fsImpl,
    statfsImpl = measureMount,
    memInfoImpl = readMemAvailable,
  } = options;

  if (!['auto', 'bb', 'hc'].includes(runtime)) throw new Error('worker_runtime_kind_invalid');
  if (!Array.isArray(mounts) || mounts.length === 0) throw new Error('at least one mount is required');
  if (!isAbsolute(tmpRoot)) throw new Error('tmpRoot must be an absolute path');
  if (!validDays(tmpDays) || !validDays(cacheDays)) throw new Error('tmpDays/cacheDays must be within (0, 365]');
  for (const cache of cacheRoots) {
    if (typeof cache?.path !== 'string' || !isAbsolute(cache.path)) throw new Error('cacheRoots paths must be absolute');
  }
  if (!dryRun) {
    if (!journalPath) throw new Error('journalPath is required for a real run');
    if (!isAbsolute(journalPath)) throw new Error('journalPath must be an absolute path');
  }

  const journal = dryRun ? noopJournal : await journalFactory(journalPath);
  const errors = [];
  const summary = {
    dryRun,
    startedAt: new Date(now).toISOString(),
    mounts: [],
    tier1: null,
    postTier1: [],
    alarm: { raised: false, escalated: false },
    ram: { low: false, stopped: 0, skipped: [], errors: 0 },
    errors,
  };
  try {
    await journal({ event: 'tick_start', dryRun, mounts, tmpDays, cacheDays, tmpRoot });

    // 1. Измерение. Ошибка одного монта — ошибка тика, а не ноль байт.
    const measured = [];
    for (const mount of mounts) {
      try {
        const bytes = await statfsImpl(mount);
        const level = evaluateDisk(bytes);
        measured.push({ mount, bytes, level });
        summary.mounts.push({ mount, availableGiB: availableGiB(bytes), level });
        await journal({ event: 'measurement', mount, availableGiB: availableGiB(bytes), level });
      } catch (error) {
        errors.push(`measure ${mount}: ${error.message}`);
        summary.mounts.push({ mount, error: error.message });
        await journal({ event: 'measurement_error', mount, error: error.message });
      }
    }

    // 2. Тир 1 — только если где-то ниже 8 GiB. На пустом месте — ни одного
    //    действия и ни одного вызова LLM.
    const needsTier1 = measured.some(m => m.level === 'tier1' || m.level === 'alarm');
    if (needsTier1) {
      await journal({ event: 'tier1_start' });
      const tier1 = {
        triggeredBy: measured.filter(m => m.level !== 'ok').map(m => m.mount),
        docker: [],
        tmp: null,
        caches: [],
      };
      // Docker prune — эффект: в dry-run только план, реальный вызов без dry-run.
      if (dryRun || !dockerEnabled) {
        tier1.docker = dockerEnabled ? DOCKER_ACTIONS.map(action => ({ ...action, dryRun: true })) : ['disabled'];
      } else if (typeof execDocker === 'function') {
        tier1.docker = await dockerPrune({ execDocker, journal, dryRun });
      } else {
        tier1.docker = ['no_executor'];
      }
      tier1.tmp = await pruneExpiredTmp({ tmpRoot, cutoffMs: now - tmpDays * DAY_MS, journal, dryRun, fsImpl });
      for (const cache of cacheRoots) {
        tier1.caches.push(await pruneCacheRoot({ root: cache.path, cutoffMs: now - cacheDays * DAY_MS, journal, dryRun, fsImpl }));
      }
      await journal({
        event: 'tier1_done',
        tmp: tier1.tmp,
        caches: tier1.caches.map(({ root, ...counts }) => ({ root, ...counts })),
        docker: tier1.docker,
      });
      summary.tier1 = tier1;

      // 3. Повторное измерение. Тревога — < 2 GiB после Тира 1, ровно одна
      //    эскалация за тик по худшему монту.
      let worst = null;
      for (const { mount } of measured) {
        try {
          const bytes = await statfsImpl(mount);
          const level = evaluateDisk(bytes);
          summary.postTier1.push({ mount, availableGiB: availableGiB(bytes), level });
          await journal({ event: 'measurement_post', mount, availableGiB: availableGiB(bytes), level });
          if (level === 'alarm' && (!worst || bytes < worst.bytes)) worst = { mount, bytes };
        } catch (error) {
          errors.push(`remeasure ${mount}: ${error.message}`);
          await journal({ event: 'measurement_error', mount, phase: 'post_tier1', error: error.message });
        }
      }
      if (worst) {
        summary.alarm = await raiseAlarm({ mount: worst.mount, availableBytes: worst.bytes, journalPath, escalate, journal, dryRun });
      }
    }

    // 4. RAM: < 1.5 GiB → стоп idle-тредов BB. Список тредов — read-only
    //    измерение даже в dry-run; сам stop — эффект и в dry-run не выполняется.
    try {
      const ramBytes = await memInfoImpl();
      summary.ram.availableGiB = availableGiB(ramBytes);
      await journal({ event: 'ram_measurement', availableGiB: availableGiB(ramBytes) });
      if (evaluateRam(ramBytes)) {
        summary.ram.low = true;
        await journal({ event: 'ram_low', thresholdGiB: RAM_MIN_GIB });
        const inspectBb = async () => {
          const listed = await execBb(['thread', 'list', '--json']);
          // runCommand не бросает исключений: ненулевой код — честная ошибка, а не пустой список.
          if (listed.code !== 0) {
            throw new Error(`bb thread list: ${String(listed.stderr ?? '').slice(-200) || `exit code ${listed.code}`}`);
          }
          const threads = parseBbThreadList(listed.stdout);
          const { stoppable, skipped } = selectIdleThreads(threads, { pinnedThreads, selfThreadId });
          return { kind: 'bb', stoppable, skipped, stop: entry => execBb(['thread', 'stop', entry.id]) };
        };
        const inspectHc = async () => {
          const listed = await execHc(['ls', '--json']);
          if (listed.code !== 0) {
            throw new Error(`hc ls: ${String(listed.stderr ?? '').slice(-200) || `exit code ${listed.code}`}`);
          }
          const terminals = parseHcTerminalList(listed.stdout);
          const { stoppable, skipped } = selectIdleHcTerminals(terminals, { pinnedThreads, selfThreadId });
          return {
            kind: 'hc', stoppable, skipped,
            stop: entry => execHc(['kill', '--json', '--', entry.address ?? entry.id]),
          };
        };

        let shedding = null;
        let hcFailure = null;
        if (runtime !== 'bb' && typeof execHc === 'function') {
          try {
            shedding = await inspectHc();
          } catch (error) {
            hcFailure = error;
            if (runtime === 'hc') throw error;
            await journal({ event: 'ram_runtime_fallback', from: 'hc', to: 'bb', error: error.message });
          }
        }
        if (!shedding && runtime !== 'hc' && typeof execBb === 'function') {
          shedding = await inspectBb();
        }

        if (shedding) {
          summary.ram.runtime = shedding.kind;
          summary.ram.skipped = shedding.skipped;
          await journal({
            event: 'ram_plan', runtime: shedding.kind,
            stopCount: shedding.stoppable.length, skippedCount: shedding.skipped.length,
          });
          if (dryRun) {
            summary.ram.plannedStops = shedding.stoppable.map(s => s.id);
          } else {
            for (const entry of shedding.stoppable) {
              const { id } = entry;
              let outcome;
              try {
                outcome = await shedding.stop(entry);
              } catch (error) {
                outcome = { code: -1, stderr: error.message };
              }
              // Ненулевой код возврата stop — не засчитанный стоп: ошибка, тик продолжается.
              if (outcome.code !== 0) {
                const reason = String(outcome.stderr ?? '').slice(-200) || `exit code ${outcome.code}`;
                await journal({ event: 'ram_stop_error', runtime: shedding.kind, threadId: id, code: outcome.code, error: reason });
                summary.ram.errors++;
                errors.push(`stop ${id}: ${reason}`);
                continue;
              }
              await journal({ event: 'ram_stop', runtime: shedding.kind, threadId: id, code: outcome.code });
              summary.ram.stopped++;
            }
          }
        } else {
          if (hcFailure) throw hcFailure;
          summary.ram.skipped.push({ reason: runtime === 'hc' ? 'no_hc_executor' : 'no_bb_executor' });
        }
      }
    } catch (error) {
      summary.ram.errors++;
      errors.push(`ram: ${error.message}`);
      await journal({ event: 'ram_error', error: error.message });
    }

    await journal({ event: 'tick_end', errors: errors.length, alarm: summary.alarm, stopped: summary.ram.stopped });
    return summary;
  } finally {
    if (!dryRun) await journal.close();
  }
}

// --- CLI --------------------------------------------------------------------

const USAGE = `usage: node resource-steward.mjs [--dry-run] [--journal <path>] [--mount <path>]...
       [--tmp-days <n>] [--cache-days <n>] [--escalate-cmd <executable>]
       [--no-docker] [--runtime auto|bb|hc] [--bb <path>] [--hc <path>]`;

const nextValue = (argv, index, flag) => {
  const value = argv[index];
  if (value === undefined || value.startsWith('--')) throw new Error(`missing value for ${flag}\n${USAGE}`);
  return value;
};

export function parseArgv(argv) {
  const flags = { mounts: [], tmpDays: 7, cacheDays: 7, dockerEnabled: true, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--dry-run': flags.dryRun = true; break;
      case '--journal': flags.journalPath = nextValue(argv, ++i, '--journal'); break;
      case '--mount': flags.mounts.push(nextValue(argv, ++i, '--mount')); break;
      case '--tmp-days': flags.tmpDays = Number(nextValue(argv, ++i, '--tmp-days')); break;
      case '--cache-days': flags.cacheDays = Number(nextValue(argv, ++i, '--cache-days')); break;
      case '--escalate-cmd': flags.escalateCmd = nextValue(argv, ++i, '--escalate-cmd'); break;
      case '--no-docker': flags.dockerEnabled = false; break;
      case '--runtime': {
        flags.runtime = nextValue(argv, ++i, '--runtime');
        if (!['auto', 'bb', 'hc'].includes(flags.runtime)) throw new Error(`worker_runtime_kind_invalid\n${USAGE}`);
        break;
      }
      case '--bb': flags.bbPath = nextValue(argv, ++i, '--bb'); break;
      case '--hc': flags.hcPath = nextValue(argv, ++i, '--hc'); break;
      default: throw new Error(`unknown flag ${argv[i]}\n${USAGE}`);
    }
  }
  return flags;
}

// Единственный допустимый профиль внешней команды: без shell, с таймаутом,
// нормализованный исход {code, stdout, stderr} вместо исключения.
export const runCommand = (cmd, timeoutMs) => async args => {
  try {
    const { stdout, stderr } = await promisify(execFile)(cmd, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return {
      code: typeof error.code === 'number' ? error.code : -1,
      stdout: String(error.stdout ?? ''),
      stderr: String(error.stderr ?? error.message),
    };
  }
};

// Хук эскалации: payload JSON на stdin указанного исполняемого файла, без
// shell, с таймаутом. stderr дренируется всегда — буфер pipe не забивается,
// хвост диагностики попадает в detail. Команда решает сама, как разбудить
// LLM-агента Steward.
export const escalateViaCommand = (executable, timeoutMs = 120_000, args = []) => async payload => {
  const child = spawn(executable, args, { stdio: ['pipe', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { if (stderr.length < 4096) stderr += chunk; });
  child.stdin.on('error', () => {});
  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
  try {
    try {
      child.stdin.end(JSON.stringify(payload, null, 2));
    } catch (error) {
      if (!['EPIPE', 'ERR_STREAM_DESTROYED'].includes(error?.code)) throw error;
    }
    const [code, signal] = await Promise.race([
      once(child, 'close'),
      once(child, 'error').then(([error]) => { throw error; }),
    ]);
    return { code, detail: [signal ? `signal ${signal}` : '', stderr.slice(-400)].filter(Boolean).join('; ') };
  } finally {
    clearTimeout(timer);
  }
};

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const flags = parseArgv(process.argv.slice(2));
    const summary = await runSteward({
      dryRun: flags.dryRun,
      journalPath: flags.journalPath ?? defaultJournalPath(),
      mounts: flags.mounts.length ? flags.mounts : DEFAULT_MOUNTS,
      tmpDays: flags.tmpDays,
      cacheDays: flags.cacheDays,
      dockerEnabled: flags.dockerEnabled,
      execDocker: runCommand('docker', 120_000),
      execBb: runCommand(flags.bbPath ?? 'bb', 30_000),
      execHc: runCommand(flags.hcPath ?? 'hc', 30_000),
      runtime: flags.runtime ?? 'auto',
      escalate: flags.escalateCmd ? escalateViaCommand(flags.escalateCmd) : undefined,
    });
    console.log(JSON.stringify(summary));
    if (summary.alarm.raised) process.exitCode = 2; // тревога видима оператору, тик при этом штатный
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
