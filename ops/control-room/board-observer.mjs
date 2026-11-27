import { inspectWorktreesAndBranches } from '../../board_pipeline/branch-drift.mjs';
import { sanitizeTerminalText } from './origin-guard.mjs';

export const textValue = value => typeof value === 'string' && value.trim()
  ? sanitizeTerminalText(value.trim()) : null;
export const timeValue = value => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};
export const firstText = (...values) => values.map(textValue).find(value => value !== null) ?? null;

// Board 0.54.0 монтирует HTTP API под /api/board. База нормализуется,
// поэтому 'http://127.0.0.1:44100' и 'http://127.0.0.1:44100/api/board'
// указывают на один endpoint.
export const BOARD_API_PATH = '/api/board';

export function normalizeBoardBaseUrl(boardUrl) {
  if (typeof boardUrl !== 'string' || !boardUrl.trim()) {
    throw new TypeError('boardUrl is required');
  }
  const url = new URL(boardUrl.trim());
  const pathname = url.pathname.replace(/\/+$/, '');
  if (!pathname.endsWith(BOARD_API_PATH)) url.pathname = `${pathname}${BOARD_API_PATH}`;
  url.search = '';
  url.hash = '';
  return url.href.replace(/\/+$/, '');
}

function jsonObject(value) {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim().startsWith('{')) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// RO-опрос Board :44100 — только GET чтение очереди. Сбой чтения —
// явная ошибка (не тихий []): вызывающий видит причину, а не пустую
// очередь.
export async function loadBoardTasksFromApi(boardUrl, { fetchImpl, token = null,
  channel = 'darkfactory', timeoutMs = 5000 } = {}) {
  const observer = createBoardObserver({ boardUrl, token, channels: [channel],
    fetchImpl, timeoutMs });
  const result = await observer.fetchTasks();
  if (!result.ok) {
    throw Object.assign(
      new Error(`board read failed: ${result.error ?? result.code ?? 'unknown'}`),
      { code: result.code ?? 'board_fetch_failed', status: result.status ?? null });
  }
  return result.tasks;
}

// RO-наблюдатель Board 0.54.0: строго GET, профиль control-room-observer,
// capability <channel>=read. Board 0.54.0 не имеет GET /channels/<ch>:
// единственный источник — GET /tasks?channel=<ch>&limit=500 с реальным
// форматом { tasks: [{ message: { id, channel, text, labels, task,
// ... }, replies, last }] }; упрощённый вид { message: { state, ... } }
// тоже принимается (совместимость с тестовыми объектами).
// Сбои (401/403, 404, не-JSON, упавший fetch) не глотаются: fetchTasks()
// возвращает { ok: false, tasks, status, code, error }, что видно в
// снапшоте как boardStatus. Ответ {"version":"0.54.0","sync":[]} без
// задач — корректный пустой срез, а не сбой.
export function createBoardObserver({ boardUrl, token = null,
  channels = ['darkfactory'], fetchImpl, timeoutMs = 5000 } = {}) {
  const fetcher = fetchImpl ?? fetch;
  const channelList = (Array.isArray(channels) ? channels : [channels])
    .filter(c => typeof c === 'string' && c);
  if (!channelList.length) throw new Error('board observer requires a channel');
  const base = normalizeBoardBaseUrl(boardUrl);
  const headers = {
    accept: 'application/json',
    'x-board-profile': 'control-room-observer',
    'x-board-can': channelList.map(c => `${c}=read`).join(';'),
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };

  // Одна страница канала → либо { ok: true, status, body }, либо явный сбой.
  const readPage = async (channel, cursor = null) => {
    let res;
    const cursorQuery = cursor === null ? '' : `&after=${encodeURIComponent(String(cursor))}`;
    try {
      res = await fetcher(
        `${base}/tasks?channel=${encodeURIComponent(channel)}&limit=500${cursorQuery}`,
        { method: 'GET', headers, redirect: 'error',
          signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      return { ok: false, status: null, code: 'board_fetch_failed',
        error: `board fetch failed: ${error?.message ?? error}` };
    }
    const status = Number.isSafeInteger(res?.status) ? res.status : null;
    if (res?.ok !== true) {
      const code = status === 401 || status === 403 ? 'board_unauthorized'
        : status === 404 ? 'board_not_found' : 'board_http_error';
      return { ok: false, status, code,
        error: `GET /tasks → ${status ?? 'request failed'} (${code})` };
    }
    let body;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }
    if (body === undefined || body === null) {
      const type = typeof res.headers?.get === 'function'
        ? res.headers.get('content-type') : null;
      return { ok: false, status, code: 'board_not_json',
        error: `GET /tasks → не JSON (content-type: ${type ?? 'unknown'})` };
    }
    return { ok: true, status, body };
  };

  // Board отдаёт cursor следующей страницы; повтор/пустая страница — конец,
  // а жёсткий bound защищает наблюдателя от бесконечного потока.
  const readChannel = async channel => {
    const maxPages = 100;
    const seen = new Set();
    const tasks = [];
    let cursor = null;
    let status = 200;
    let firstBody = null;
    for (let page = 0; page < maxPages; page++) {
      const outcome = await readPage(channel, cursor);
      if (!outcome.ok) return outcome;
      status = outcome.status;
      firstBody ??= outcome.body;
      const body = outcome.body;
      const entries = Array.isArray(body?.tasks) ? body.tasks
        : Array.isArray(body) ? body : [];
      tasks.push(...entries);
      const next = body?.cursor ?? body?.next_cursor ?? body?.nextCursor ?? null;
      if ((next !== null && typeof next !== 'string' && typeof next !== 'number') ||
          next === null || next === '' || !entries.length || seen.has(String(next))) {
        return { ok: true, status, body: { ...(firstBody && typeof firstBody === 'object' ? firstBody : {}), tasks } };
      }
      seen.add(String(next));
      cursor = String(next);
    }
    return { ok: false, status, code: 'board_pagination_exceeded',
      error: `GET /tasks → cursor pagination exceeded ${maxPages} pages` };
  };

  const toTask = raw => {
    const message = raw?.message ?? raw;
    if (!message || typeof message !== 'object') return null;
    const task = message.task ?? (message.state ? message : null);
    if (!task || typeof task.state !== 'string') return null;
    const labels = message.labels ?? task.labels ?? {};
    const result = jsonObject(task.result) ?? {};
    const updatedAt = task.updatedAt ?? task.updated_at ?? message.updatedAt ??
      message.updated_at ?? (typeof raw?.last === 'string' ? raw.last : raw?.last?.ts ?? raw?.last?.updatedAt);
    const receiptSha = task.receiptSha ?? task.receipt_sha ?? result.sha ?? result.candidate_sha ??
      result.receiptSha ?? result.receipt_sha ?? labels.receipt_sha ?? labels.receiptSha;
    return {
      task_id: task.task_id ?? message.id ?? task.id,
      state: task.state,
      title: task.title ?? String(message.text ?? '').split('\n')[0] ?? '',
      labels,
      epoch: task.epoch ?? null,
      channel: message.channel ?? null,
      ...(task.priority !== undefined || labels.priority !== undefined
        ? { priority: task.priority ?? labels.priority } : {}),
      ...(updatedAt !== undefined ? { updatedAt } : {}),
      ...(receiptSha !== undefined ? { receiptSha } : {}),
      ...(task.blocked ? { blocked: task.blocked } : {}),
      ...(task.executor ? { executor: task.executor } : {}),
      ...(task.question ? { question: task.question } : {}),
      ...(task.reason ? { reason: task.reason } : {}),
    };
  };

  // Явный результат чтения: { ok, tasks, status, code, error }.
  const fetchTasks = async () => {
    const found = new Map();
    let failure = null;
    for (const channel of channelList) {
      const outcome = await readChannel(channel);
      if (!outcome.ok) {
        failure ??= { ...outcome, channel };
        continue;
      }
      const body = outcome.body;
      const entries = Array.isArray(body?.tasks) ? body.tasks
        : Array.isArray(body) ? body : [];
      for (const entry of entries) {
        const task = toTask(entry);
        if (task?.task_id != null) found.set(String(task.task_id), task);
      }
    }
    const tasks = [...found.values()];
    if (failure) {
      return { ok: false, tasks, status: failure.status, code: failure.code,
        error: `${failure.error} (channel ${failure.channel})` };
    }
    return { ok: true, tasks, status: 200, code: null, error: null };
  };

  // История вызовов: наблюдённые задачи (совместимость с провайдером).
  const observer = async () => (await fetchTasks()).tasks;
  observer.fetchTasks = fetchTasks;
  observer.boardUrl = base;
  observer.channels = [...channelList];
  return observer;
}

// Провайдер задач возвращает либо массив (упрощённый/тестовый вид), либо
// результат observer.fetchTasks(). Второй случай сохраняет явный статус:
// сбой Board виден в снапшоте (boardStatus.ok === false), а сервер
// остаётся read-only и продолжает отвечать 200.
export async function readBoardTasks(provider) {
  let result;
  try {
    result = await provider();
  } catch (error) {
    return { tasks: [], boardStatus: { ok: false, status: null,
      code: error?.code ?? 'board_fetch_failed',
      error: sanitizeTerminalText(String(error?.message ?? error ?? 'board fetch failed')) } };
  }
  if (Array.isArray(result)) {
    return { tasks: result, boardStatus: { ok: true, status: 200, code: null, error: null } };
  }
  if (result && Array.isArray(result.tasks)) {
    const success = result.ok !== false;
    return { tasks: result.tasks, boardStatus: {
      ok: success,
      status: Number.isSafeInteger(result.status) ? result.status : null,
      code: success ? null : (result.code ?? 'board_error'),
      error: success ? null
        : sanitizeTerminalText(String(result.error ?? result.code ?? 'board error')) } };
  }
  return { tasks: [], boardStatus: { ok: false, status: null,
    code: 'board_bad_provider', error: 'board provider returned no task list' } };
}

// TTL-кэшированный провайдер Branch Drift по списку репозиториев:
// агрегирует unmergedBranches/dirtyWorktrees/bbThreadWorktrees. Ошибка
// инспекции репо — fail-closed (driftDetected: true + repo error).
export function createBranchDriftProvider(repos, {
  ttlMs = 20_000, execGit, now = () => Date.now() } = {}) {
  let cached = null;
  let cachedAt = -Infinity;
  return async () => {
    if (cached && now() - cachedAt < ttlMs) return cached;
    const merged = { driftDetected: false, repos: [], unmergedBranches: [],
      dirtyWorktrees: [], bbThreadWorktrees: [] };
    for (const repoDir of repos) {
      try {
        const report = await inspectWorktreesAndBranches({ repoDir, execGit });
        merged.repos.push({ repoDir, ok: report.ok });
        for (const k of ['unmergedBranches', 'dirtyWorktrees', 'bbThreadWorktrees']) {
          merged[k].push(...report[k].map(e => ({ ...e, repoDir })));
        }
        if (report.driftDetected) merged.driftDetected = true;
      } catch (error) {
        // Недоступная проверка — не «чисто»: индикатор горит.
        merged.repos.push({ repoDir, ok: false,
          error: sanitizeTerminalText(error.message) });
        merged.driftDetected = true;
      }
    }
    cached = merged;
    cachedAt = now();
    return merged;
  };
}

const BOARD_EXPLORER_STATES = ['ready', 'claimed', 'waiting', 'blocked', 'completed'];

function canonicalBoardState(raw) {
  const state = String(raw ?? '').trim().toLowerCase();
  if (state === 'ready') return 'ready';
  if (state === 'claimed' || state === 'working') return 'claimed';
  if (state === 'blocked' || state === 'awaiting_answer' || state === 'hold') return 'blocked';
  if (state === 'completed' || state === 'done') return 'completed';
  return 'waiting';
}

export function taskRepoId(task) {
  const labels = task?.labels !== null && typeof task?.labels === 'object' ? task.labels : {};
  return firstText(task?.repoId, task?.repo_id, labels.repo_id, labels.repoId, labels.project);
}

function receiptShaOf(task) {
  const result = jsonObject(task?.result) ?? {};
  const labels = task?.labels !== null && typeof task?.labels === 'object' ? task.labels : {};
  return firstText(task?.receiptSha, task?.receipt_sha, result.sha, result.candidate_sha,
    result.receipt_sha, result.receiptSha, labels.receipt_sha, labels.receiptSha, labels.sha);
}

function ownerNeedDetails(task) {
  const blocked = jsonObject(task?.blocked) ?? {};
  const reasonPayload = jsonObject(blocked.reason);
  const questionPayload = jsonObject(task?.question) ?? {};
  const questionId = firstText(blocked.question_id, blocked.questionId,
    reasonPayload?.question_id, questionPayload.question_id);
  const question = firstText(blocked.question, questionPayload.prompt, questionPayload.question,
    reasonPayload?.prompt, reasonPayload?.question);
  const evidence = firstText(
    typeof blocked.reason === 'string' && !reasonPayload ? blocked.reason : null,
    reasonPayload?.evidence, questionPayload.evidence, task?.reason);
  return { question, evidence, questionId };
}

function normalizeBoardExplorerTask(task) {
  const labels = task?.labels !== null && typeof task?.labels === 'object' && !Array.isArray(task.labels)
    ? task.labels : {};
  return {
    id: String(task?.task_id ?? task?.id ?? ''),
    channel: firstText(task?.channel, labels.channel) ?? 'unassigned',
    state: canonicalBoardState(task?.state),
    priority: firstText(task?.priority, labels.priority),
    repoId: taskRepoId(task),
    title: firstText(task?.title) ?? '',
    labels,
    updatedAt: firstText(task?.updatedAt, task?.updated_at, task?.last, task?.lastActivityAt),
    receiptSha: receiptShaOf(task),
  };
}

export function buildBoardExplorer(tasks = []) {
  const grouped = new Map();
  for (const raw of Array.isArray(tasks) ? tasks : []) {
    const task = normalizeBoardExplorerTask(raw);
    if (!task.id) continue;
    if (!grouped.has(task.channel)) {
      grouped.set(task.channel, { name: task.channel,
        counts: Object.fromEntries(BOARD_EXPLORER_STATES.map(state => [state, 0])), tasks: [] });
    }
    const channel = grouped.get(task.channel);
    channel.counts[task.state] += 1;
    channel.tasks.push(task);
  }
  const channels = [...grouped.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const channel of channels) {
    channel.tasks.sort((a, b) => {
      const aTime = timeValue(a.updatedAt);
      const bTime = timeValue(b.updatedAt);
      if (aTime !== null && bTime !== null && aTime !== bTime) return bTime - aTime;
      return a.id.localeCompare(b.id, undefined, { numeric: true });
    });
  }
  return { channels };
}

export function buildBoardColumns(tasks, attempts) {
  const running = [];
  const queued = [];
  const needsOwner = [];
  const recentlyCompleted = [];
  for (const task of tasks) {
    const card = { task_id: task.task_id ?? task.id, state: task.state,
      title: sanitizeTerminalText(String(task.title ?? '')),
      labels: task.labels ?? {}, epoch: task.epoch ?? null };
    if (task.state === 'claimed' || task.state === 'working') {
      // Самая свежая попытка по task_id (по ts события).
      let key = null;
      for (const a of attempts.values()) {
        if (String(a.task_id) !== String(card.task_id)) continue;
        if (!key || String(a.ts ?? '') >= String(key.ts ?? '')) key = a;
      }
      running.push({ ...card, phase: key?.phase ?? null,
        model: key?.model ?? task.executor?.model ?? null,
        role: key?.role ?? null, round: key?.round ?? null,
        deadline_rem_ms: key?.deadline_rem_ms ?? null,
        tokens: key?.tokens ?? null, lastEvent: key?.reason ?? null });
    } else if (task.state === 'ready' || task.state === 'queued' || task.state === 'waiting') {
      queued.push(card);
    } else if (task.state === 'blocked' || task.state === 'awaiting_answer' || task.state === 'hold') {
      const need = ownerNeedDetails(task);
      needsOwner.push({ ...card,
        question: need.question,
        evidence: need.evidence,
        cli: need.questionId ? `question-gate answer ${need.questionId}` : null });
    } else if (task.state === 'completed' || task.state === 'done') {
      recentlyCompleted.push(card);
    }
  }
  return { running, queued, needsOwner, recentlyCompleted };
}
