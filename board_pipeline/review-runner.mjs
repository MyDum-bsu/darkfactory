// Harness-agnostic L2-ревьюер (ReviewPort) и адаптер isolatedPiReviewRunner.
// Критик работает в rootless Docker на системно read-only снимке unpackExact:
// снимок /candidate смонтирован readonly, worktree воркера, state контроллера,
// Board и токены физически отсутствуют в пространстве и env контейнера.
// Кросс-семейственный инвариант family(critic) !== family(executor) — программный,
// проверяется до запуска контейнера и модели.

import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { unpackExact } from './runtime.mjs';
import { withModelProxy } from './model-proxy.mjs';
import { applySeverityGating, buildReviewInstruction } from './review-policy.mjs';
import { sumUsages } from './telemetry.mjs';

const exec = promisify(execFile);
const SHA = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const CHECKPOINT = /^[0-9a-f]{8,64}$/;

// Действующий закэшированный образ ревью-стенда ([VERIFY] на хосте).
export const REVIEW_IMAGE =
  'node@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9';

// В контейнер критика монтируются только каталоги кода ~/.pi/agent:
// sessions/, subagents/ и auth.json исключены — секрет едет копией в tmpfs.
const PROXY_BOOTSTRAP = new URL('./model-proxy-client.cjs', import.meta.url).pathname;

const READ_ONLY_TOOLS = ['read', 'grep', 'find', 'ls'];

// Причины разбора, означающие действительно оборванный поток — только они
// открывают transient-классификацию ненулевого выхода раннера.
const TRUNCATED_TRANSCRIPT = new Set([
  'review_transcript_empty', 'review_transcript_corrupt', 'review_incomplete_turn',
]);

// Незавершённый поток может быть уже дисквалифицирующим, а не оборванным:
// явный error/auto_retry_end со сбросом либо assistant-сообщение с
// провайдером/моделью/effort, противоречащими закреплённому критику. Такой
// ответ — hold, а не transient: повтор не должен стирать зафиксированный
// отказ или mismatch. Возвращает причину отказа либо null.
function transcriptDisqualifying(ndjson, critic) {
  const tools = new Set();
  let finishedResponse = false;
  const noteTools = (list) => {
    if (Array.isArray(list)) {
      for (const t of list) tools.add(typeof t === 'string' ? t : t?.name);
    }
  };
  for (const line of String(ndjson).split('\n')) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue; // битая строка — сама по себе признак обрыва
    }
    // Нарушение политики инструментов зафиксировано потоком — hold, не
    // transient: пропуск session_info/message с запрещённым toolsAdded
    // позволил бы второму вызову стереть зафиксированное нарушение.
    noteTools(event?.toolsAdded);
    noteTools(event?.message?.toolsAdded);
    if (event?.type === 'session_info') noteTools(event.data?.toolsAdded);
    if (Array.isArray(event?.messages)) {
      for (const m of event.messages) noteTools(m?.toolsAdded);
    }
    if (event?.type === 'error' ||
        (event?.type === 'auto_retry_end' && event.success === false)) {
      return 'review_runner_reported_error';
    }
    if (event?.type !== 'message_end') continue;
    const message = event.message ?? event.data?.message;
    if (message?.role !== 'assistant') continue;
    // Отказ провайдера может быть записан в самом assistant-сообщении
    // (stopReason 'error' / errorMessage) без верхнеуровневого error-события —
    // зафиксированный отказ — hold, не transient.
    if (message.stopReason === 'error' || nonEmpty(message.errorMessage)) {
      return 'review_runner_reported_error';
    }
    const responseModel = message.responseModel ?? message.actualModel ??
      message.usage?.responseModel ?? message.metadata?.responseModel;
    const effort = message.providerThinkingLevel ?? message.reasoningEffort ??
      message.usage?.providerThinkingLevel ?? message.metadata?.reasoningEffort;
    if ((message.provider !== undefined && message.provider !== critic.provider) ||
        (message.model !== undefined && message.model !== critic.model) ||
        (responseModel !== undefined && responseModel !== critic.model) ||
        (message.thinkingLevel !== undefined && message.thinkingLevel !== critic.reasoningLevel) ||
        (effort !== undefined && effort !== critic.reasoningLevel)) {
      return 'review_model_mismatch';
    }
    // Уже изданный вердикт без agent_settled — не обрыв, а зафиксированный
    // исход: второй вызов не должен стирать записанный REWORK/ESCALATE/PASS.
    // Дисквалифицирует и ЛЮБОЙ объект с ключом verdict (даже malformed —
    // {"verdict":42}), и маркер legacy-вердикта в тексте хода.
    const parts = Array.isArray(message.content) ? message.content : [];
    const text = parts.filter(p => p?.type === 'text').map(p => p.text).join('\n');
    // Вердиктоподобный фрагмент обязателен даже когда сам JSON битый:
    // {"verdict":"REWORK",} не парсится, но исход уже издан — hold.
    if (/"verdict"\s*:/.test(text)) return 'review_verdict_emitted';
    try {
      parseReviewVerdict(text);
      return 'review_verdict_emitted';
    } catch (verdictError) {
      if (!(verdictError instanceof ReviewDenied) ||
          verdictError.reason !== 'review_verdict_missing') {
        return 'review_verdict_emitted';
      }
    }
    // Штатно закрывшийся assistant-ответ — завершённый исход хода: даже
    // без agent_settled и с недоказуемым вердиктом (например, битый
    // {verdict: ...}) это hold, а не обрыв потока. rawStopReason
    // 'completed' и 'stop' — нормальные завершения OpenAI-совместимого
    // адаптера; отсутствие поля — тоже закрытый ответ.
    if (message.stopReason === 'stop' &&
        (message.rawStopReason === undefined ||
          ['completed', 'stop'].includes(message.rawStopReason))) {
      finishedResponse = true;
    }
  }
  for (const tool of tools) {
    if (!READ_ONLY_TOOLS.includes(tool)) return `review_forbidden_tool:${tool}`;
  }
  // Завершённый ответ без доказуемого вердикта — невалидный исход, а не
  // обрыв: пропажа settlement/недоказуемое намерение не открывает повтор —
  // второй вызов не должен заменять завершённый ответ читателя.
  if (finishedResponse) return 'review_verdict_missing';
  return null;
}

// Монтируются только каталоги кода; конфиги идут через /pi-cfg копией в tmpfs.
const PI_MOUNT_DIRS = ['bin', 'install', 'npm'];
const PI_CONFIG_FILES = ['settings.json', 'models.json', 'models-store.json'];
// Host proxy URLs (including any credentials) stay in the host broker.
async function sandboxedPiConfig(file, src) {
  const body = await readFile(src);
  if (file !== 'settings.json') return body;
  const cfg = JSON.parse(body.toString('utf8'));
  delete cfg.httpProxy;
  return JSON.stringify(cfg);
}
const GUARD_FILE = new URL('./pi-guard.cjs', import.meta.url).pathname;

export class ReviewDenied extends Error {
  constructor(reason, options) {
    super(reason, options);
    this.reason = reason;
  }
}

// Доказанный transient-сбой read-only раннера L2: хостовый таймаут exec или
// подтверждённый SIGTERM контейнера (код 143). Единственный класс ошибок, по
// которому контроллер делает один повтор того же закреплённого критика и
// субъекта. Отказ, битый вердикт, mismatch модели и обычный REWORK сюда не
// попадают — это не ReviewRunnerTimeout и повтора не даёт.
export class ReviewRunnerTimeout extends ReviewDenied {
  constructor(reason, options) {
    super(reason, options);
    this.transient = true;
  }
}

// Строгая таблица разрешённых идентификаторов: provider и model должны быть
// известны и принадлежать одному семейству. Никакого поиска по подстроке.
const PROVIDER_FAMILY = new Map([
  ['acp-devin', 'cognition'],
  ['acp-zcode-start', 'glm'],
  ['opencode-go', 'deepseek'],
  ['openai', 'openai'],
  ['google', 'google'],
  ['acp-antigravity-acp', 'google'],
  ['agy', 'anthropic'],
  // pi-провайдеры из runner-формы спеков (PROVIDER_EGRESS) — семейство
  // совпадает с именем провайдера, аттестуются напрямую.
  ['deepseek', 'deepseek'],
  ['glm', 'glm'],
  ['cognition', 'cognition'],
]);
// Провайдеры-харнессы: сами семейства не несут, семейство берётся из модели.
const HARNESS_PROVIDERS = new Set(['pi']);
const MODEL_FAMILY = new Map([
  ['swe-2-high', 'cognition'],
  ['swe-2-medium', 'cognition'],
  ['swe-2-low', 'cognition'],
  ['glm-5.3-flash', 'glm'],
  ['builtin:zai-start-plan\\glm-5.3-flash', 'glm'],
  ['deepseek-v4.1-flash', 'deepseek'],
  ['deepseek-v4', 'deepseek'],
  ['deepseek-reasoner', 'deepseek'],
  ['gpt-6.2-sol', 'openai'],
  ['gpt-6.2-astra', 'openai'],
  ['gpt-6.1-sol', 'openai'],
  ['gpt-6.1-terra', 'openai'],
  ['gpt-5.6-sol', 'openai'],
  ['codex', 'openai'],
  ['gemini-4-neon', 'google'],
  ['claude-opus-5.5', 'anthropic'],
]);

// Семейство по идентификатору исполнителя/критика. Строка вида 'acp-devin'
// или 'openai/gpt-6.2-sol', либо объект { provider, model }. Пара
// provider+model обязана состоять в одном семействе; противоречивая пара
// и неизвестный id дают null → отказ review_unknown_family.
export function executorFamily(spec) {
  if (spec === null || spec === undefined) return null;
  let provider;
  let model;
  if (typeof spec === 'string') {
    const i = spec.indexOf('/');
    if (i >= 0) {
      provider = spec.slice(0, i);
      model = spec.slice(i + 1);
    } else {
      provider = spec;
    }
  } else if (typeof spec === 'object' && !Array.isArray(spec)) {
    provider = spec.provider;
    model = spec.model;
  } else {
    return null;
  }
  const pf = typeof provider === 'string' && provider !== ''
    ? PROVIDER_FAMILY.get(provider.toLowerCase()) : undefined;
  const mf = typeof model === 'string' && model !== ''
    ? MODEL_FAMILY.get(model.toLowerCase()) : undefined;
  // Харнессы-запускатели (pi): семейство определяет вложенная модель вида
  // 'provider/model' — та же строгая таблица применяется рекурсивно.
  if (pf === undefined && typeof provider === 'string' &&
      HARNESS_PROVIDERS.has(provider.toLowerCase()) &&
      typeof model === 'string' && model.includes('/')) {
    return executorFamily(model);
  }
  // Оба поля обязательны и обязаны указывать на одно семейство.
  return pf !== undefined && pf === mf ? pf : null;
}

// Жёсткий инвариант до любого эффекта: оба семейства известны и различны.
export function assertCrossFamily(executor, critic) {
  const ef = executorFamily(executor);
  const cf = executorFamily(critic);
  if (ef === null || cf === null) throw new ReviewDenied('review_unknown_family');
  if (ef === cf) throw new ReviewDenied('review_same_family');
  return { executor: ef, critic: cf };
}

const nonEmpty = (v) => typeof v === 'string' && v.trim().length > 0;

// Нормализованный finding: место, вход, ожидание, факт, частота, вред.
function validFinding(f) {
  return f !== null && typeof f === 'object' && !Array.isArray(f) &&
    nonEmpty(f.file) && nonEmpty(f.expected) && nonEmpty(f.actual);
}

export function hasValidFinding(findings) {
  return Array.isArray(findings) && findings.some(validFinding);
}

// Парсинг NDJSON-потока `pi --print --mode json`.
// Возвращает actual { provider, model, reasoningLevel } ассистентских
// message_end (все обязаны совпадать, включая responseModel/actualModel и
// providerThinkingLevel/reasoningEffort, когда те присутствуют), объединение
// ВСЕХ toolsAdded по потоку, суммарный usage ассистентских message_end
// (null, если провайдер токены не отдал) и текст строго последнего хода.
export function parseReviewTranscript(ndjson) {
  const events = [];
  for (const line of String(ndjson).split('\n')) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      throw new ReviewDenied('review_transcript_corrupt');
    }
  }
  const tools = new Set();
  const noteTools = (list) => {
    if (Array.isArray(list)) {
      for (const t of list) tools.add(typeof t === 'string' ? t : t?.name);
    }
  };
  const seen = [];
  const usages = [];
  let hasError = false;
  let seenSettled = false;
  let aborted = null;
  for (const event of events) {
    noteTools(event?.toolsAdded);
    noteTools(event?.message?.toolsAdded);
    if (event?.type === 'session_info') noteTools(event.data?.toolsAdded);
    if (Array.isArray(event?.messages)) {
      for (const msg of event.messages) noteTools(msg?.toolsAdded);
    }
    if (event?.type === 'error' || event?.type === 'auto_retry_end' && event.success === false) {
      hasError = true;
    }
    if (event?.type === 'agent_settled') {
      seenSettled = true;
      // Строгое сравнение с false ниже: отсутствующее/null aborted не проходит.
      aborted = event.aborted;
    }
    if (event?.type !== 'message_end') continue;
    const message = event.message ?? event.data?.message;
    if (message?.role !== 'assistant') continue;
    // VS-3: usage хода — числовые поля суммируются позже (sumUsages);
    // отсутствующий/нечисловой usage хода не ломает разбор.
    if (message.usage !== null && typeof message.usage === 'object' &&
        !Array.isArray(message.usage)) {
      usages.push(message.usage);
    }
    const parts = Array.isArray(message.content) ? message.content : [];
    const text = parts.filter(p => p?.type === 'text').map(p => p.text).join('\n');
    seen.push({
      provider: message.provider,
      model: message.model,
      reasoningLevel: message.thinkingLevel,
      responseModel: message.responseModel ?? message.actualModel ??
        message.usage?.responseModel ?? message.metadata?.responseModel,
      effort: message.providerThinkingLevel ?? message.reasoningEffort ??
        message.usage?.providerThinkingLevel ?? message.metadata?.reasoningEffort,
      stopReason: message.stopReason,
      rawStopReason: message.rawStopReason,
      responseId: message.responseId,
      text,
    });
  }
  if (seen.length === 0) throw new ReviewDenied('review_transcript_empty');
  const actual = seen[0];
  for (const msg of seen) {
    if (msg.provider !== actual.provider || msg.model !== actual.model ||
        (msg.responseModel !== undefined && msg.responseModel !== actual.model) ||
        (actual.responseModel !== undefined && msg.responseModel !== undefined &&
          msg.responseModel !== actual.responseModel)) {
      throw new ReviewDenied('review_model_mismatch');
    }
    if (msg.reasoningLevel !== actual.reasoningLevel ||
        (msg.effort !== undefined && msg.effort !== actual.reasoningLevel)) {
      throw new ReviewDenied('review_effort_mismatch');
    }
  }
  // Только последний ход определяет вердикт: оборванный/пустой финал — отказ,
  // текст из более ранних ходов не засчитывается.
  const last = seen.at(-1);
  const toolsAdded = tools.size ? [...tools] : null;
  if (hasError || !seenSettled || aborted !== false || last.stopReason !== 'stop' ||
      (last.rawStopReason !== undefined && last.rawStopReason !== 'completed') ||
      !last.text.trim()) {
    throw new ReviewDenied('review_incomplete_turn');
  }
  return {
    actual: { provider: actual.provider, model: actual.model,
      reasoningLevel: actual.reasoningLevel },
    seen, toolsAdded, finalText: last.text, responseId: last.responseId, events,
    usage: sumUsages(usages),
  };
}

// Сканер сбалансированных JSON-объектов: извлекает верхнеуровневые {...}
// из свободного текста (включая fenced-блоки), игнорируя скобки внутри строк.
function extractJsonObjects(body) {
  const objects = [];
  const s = String(body);
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0 && start >= 0) objects.push(s.slice(start, i + 1));
      if (depth < 0) depth = 0;
    }
  }
  return objects;
}

// Извлечение вердикта критика: ровно один JSON-объект с полем verdict либо
// legacy-маркер строго в первой/последней непустой строке.
// Возвращает { status: PASS|REWORK|ESCALATE, verdict, summary, findings,
// checked_invariants, excerpt, subject_digest }.
export function parseReviewVerdict(text) {
  const body = String(text ?? '');
  const verdictObjects = [];
  for (const chunk of extractJsonObjects(body)) {
    let parsed;
    try {
      parsed = JSON.parse(chunk);
    } catch {
      continue;
    }
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) &&
        typeof parsed.verdict === 'string') {
      verdictObjects.push(parsed);
    }
  }
  const markerLines = body.split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l === 'REVIEW_OK' || l === 'REVIEW_BLOCKED');
  if (verdictObjects.length > 1 ||
      (verdictObjects.length === 0 && new Set(markerLines).size > 1)) {
    throw new ReviewDenied('review_ambiguous_verdict');
  }
  if (verdictObjects.length === 1) {
    // Текстовый маркер, противоречащий JSON-вердикту, делает ответ
    // неоднозначным: PASS + REVIEW_BLOCKED или REWORK/ESCALATE + REVIEW_OK.
    const isPass = ['PASS', 'REVIEW_OK'].includes(verdictObjects[0].verdict);
    const contradicts = isPass ? markerLines.includes('REVIEW_BLOCKED')
      : markerLines.includes('REVIEW_OK');
    if (contradicts) throw new ReviewDenied('review_ambiguous_verdict');
    return canonicalVerdict(verdictObjects[0]);
  }
  // Legacy-формат: маркер принимается только в первой или последней непустой
  // строке — упоминание в середине ответа вердиктом не является.
  const nonEmpty = body.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const edge = [nonEmpty[0], nonEmpty.at(-1)]
    .filter(l => l === 'REVIEW_OK' || l === 'REVIEW_BLOCKED');
  if (edge.length === 1 || (edge.length === 2 && edge[0] === edge[1])) {
    const verdict = edge[0];
    const status = verdict === 'REVIEW_OK' ? 'PASS' : 'REWORK';
    const excerpt = status === 'REWORK'
      ? nonEmpty.filter(l => l !== verdict)
        .join('\n').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').trim().slice(0, 1400)
      : undefined;
    if (status === 'REWORK' && !excerpt) {
      throw new ReviewDenied('review_objection_missing');
    }
    return { status, verdict, summary: '', findings: [], checked_invariants: [],
      excerpt, subject_digest: undefined };
  }
  throw new ReviewDenied('review_verdict_missing');
}

const STATUS_MAP = {
  PASS: { status: 'PASS', verdict: 'REVIEW_OK' },
  REVIEW_OK: { status: 'PASS', verdict: 'REVIEW_OK' },
  REWORK: { status: 'REWORK', verdict: 'REVIEW_BLOCKED' },
  REVIEW_BLOCKED: { status: 'REWORK', verdict: 'REVIEW_BLOCKED' },
  ESCALATE: { status: 'ESCALATE', verdict: 'REVIEW_ESCALATE' },
};

function canonicalVerdict(parsed) {
  const mapped = STATUS_MAP[parsed.verdict];
  if (!mapped) throw new ReviewDenied('review_verdict_unknown');
  const findings = Array.isArray(parsed.findings)
    ? parsed.findings.filter(f => f !== null && typeof f === 'object' && !Array.isArray(f))
    : [];
  const summary = typeof parsed.summary === 'string' ? parsed.summary : '';
  // REWORK никогда не берёт возражение из summary: только явный excerpt
  // или валидный finding с file/expected/actual.
  const excerpt = mapped.status !== 'PASS'
    ? (nonEmpty(parsed.excerpt) ? parsed.excerpt.trim().slice(0, 1400)
      : findings.filter(validFinding).map(f =>
          `${f.file}${f.line ? `:${f.line}` : ''}: expected ${f.expected}, actual ${f.actual}`)
          .join('\n').slice(0, 1400) || undefined)
    : undefined;
  if (mapped.status === 'REWORK' && !excerpt) {
    throw new ReviewDenied('review_objection_missing');
  }
  return {
    ...mapped,
    summary,
    findings,
    checked_invariants: Array.isArray(parsed.checked_invariants)
      ? parsed.checked_invariants.filter(nonEmpty) : [],
    excerpt,
    subject_digest: typeof parsed.subject_digest === 'string' ? parsed.subject_digest : undefined,
  };
}

async function git(worktree, ...args) {
  return (await exec('git', ['-C', worktree, ...args], { timeout: 20_000 })).stdout.trimEnd();
}

// Побайтовый дайджест снимка: sha256 над упорядоченными (path, mode, sha1 байтов).
// Независим от Git: перепроверяет фактические байты распакованного дерева.
export async function snapshotDigest(source) {
  const entries = [];
  const walk = async (dir, prefix) => {
    const { opendir } = await import('node:fs/promises');
    for await (const entry of await opendir(dir)) {
      const full = join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const info = await lstat(full);
      if (info.isDirectory()) await walk(full, rel);
      else if (info.isSymbolicLink()) {
        const { readlink } = await import('node:fs/promises');
        const target = await readlink(full);
        entries.push({ rel, mode: '120000',
          sha1: createHash('sha1').update(target).digest('hex') });
      } else if (info.isFile()) {
        const data = await readFile(full);
        entries.push({ rel, mode: (info.mode & 0o111) ? '100755' : '100644',
          sha1: createHash('sha1').update(data).digest('hex') });
      } else {
        throw new ReviewDenied('snapshot_unsupported_entry');
      }
    }
  };
  await walk(source, '');
  entries.sort((a, b) => a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0);
  const hash = createHash('sha256');
  for (const e of entries) hash.update(`${e.mode} ${e.sha1} ${e.rel}\0`);
  return { digest: hash.digest('hex'), files: entries.length };
}

async function verifySnapshotUnchanged(source, before) {
  const after = await snapshotDigest(source);
  if (after.digest !== before.digest || after.files !== before.files) {
    throw new ReviewDenied('snapshot_mutated');
  }
}

async function gitRaw(worktree, ...args) {
  return (await exec('git', ['-C', worktree, ...args],
    { timeout: 20_000, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 })).stdout;
}

// Полный отпечаток рабочего дерева: HEAD, дерево HEAD, статус, байтовый diff
// и SHA-256 содержимого всех изменённых/untracked файлов — правка уже
// модифицированного файла во время L2 обязана менять fingerprint.
export async function worktreeFingerprint(worktree) {
  const head = await git(worktree, 'rev-parse', 'HEAD');
  const tree = await git(worktree, 'rev-parse', 'HEAD^{tree}');
  const status = await gitRaw(worktree, 'status', '--porcelain=v1', '-z', '--untracked-files=all');
  const diff = await gitRaw(worktree, 'diff', '--no-ext-diff', '--no-textconv', '--no-color', 'HEAD');
  const paths = status.toString('utf8').split('\0').filter(Boolean).map(e => e.slice(3)).sort();
  const filesHash = createHash('sha256');
  for (const rel of paths) {
    filesHash.update(rel + '\0');
    const full = join(worktree, rel);
    try {
      const st = await lstat(full);
      if (st.isSymbolicLink()) {
        // Симлинк (в т.ч. битый): хэшируем цель ссылки, а не содержимое.
        filesHash.update('symlink:' + await readlink(full));
        continue;
      }
    } catch { /* файл пропал между status и lstat */ }
    let bytes = null;
    try {
      bytes = await readFile(full);
    } catch { /* файл удалён или недоступен — сам факт фиксируем */ }
    filesHash.update(bytes ?? '<absent>');
  }
  return {
    head, tree,
    status: createHash('sha256').update(status).digest('hex'),
    diff: createHash('sha256').update(diff).digest('hex'),
    files: filesHash.digest('hex'),
  };
}

function sameFingerprint(a, b) {
  return a.head === b.head && a.tree === b.tree && a.status === b.status &&
    a.diff === b.diff && a.files === b.files;
}

// Объединённые toolsAdded должны быть подмножеством read-only набора.
export function assertToolsAllowed(toolsAdded) {
  for (const tool of toolsAdded ?? []) {
    if (!READ_ONLY_TOOLS.includes(tool)) {
      throw new ReviewDenied(`review_forbidden_tool:${tool}`);
    }
  }
}

// Both snapshot tools and model clients have an isolated network namespace.
export async function runInReadOnlySandbox({ snapshot, argv, image = REVIEW_IMAGE,
  env = {}, mounts = [], timeoutMs = 120_000, workdir = '/candidate', beforeEffect, signal }) {
  if (!isAbsolute(snapshot ?? '') || !Array.isArray(argv) || !argv.length) {
    throw new ReviewDenied('sandbox_request_invalid');
  }
  if (signal?.aborted) throw signal.reason ?? new ReviewDenied('stage_aborted');
  const security = JSON.parse((await exec('docker', ['info', '--format', '{{json .SecurityOptions}}'], {
    timeout: 12_000,
  })).stdout);
  if (!security.includes('name=rootless')) {
    throw new ReviewDenied('sandbox_requires_rootless_docker');
  }
  const name = `board-review-${randomUUID()}`;
  const args = ['run', '--rm', '--name', name, '--pull=never', '--read-only', '--network=none',
    '--cap-drop=ALL', '--security-opt=no-new-privileges', '--user=0:0'];
  args.push('--tmpfs=/tmp:rw,nosuid,nodev,size=64m', '-e', 'HOME=/tmp',
    '--mount', `type=bind,src=${snapshot},dst=/candidate,readonly`);
  for (const { src, dst } of mounts) {
    if (!isAbsolute(src ?? '') || !isAbsolute(dst ?? '')) {
      throw new ReviewDenied('sandbox_mount_invalid');
    }
    args.push('--mount', `type=bind,src=${src},dst=${dst},readonly`);
  }
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== 'string' || /[=]/.test(key)) {
      throw new ReviewDenied('sandbox_env_invalid');
    }
    args.push('-e', `${key}=${value}`);
  }
  args.push('--workdir', workdir, image, ...argv);
  let code = 0;
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  // Отмена добивает именованный контейнер этого запуска: опрос повторяется,
  // чтобы накрыть окно между docker info и созданием контейнера. Финальный
  // rm -f в finally самого раннера остаётся второй гарантией.
  let stopping = null;
  const onAbort = () => {
    stopping ??= (async () => {
      for (let poll = 0; poll < 8; poll++) {
        try {
          await exec('docker', ['rm', '-f', name], { timeout: 15_000 });
          return;
        } catch { /* контейнера ещё нет — повтор */ }
        await new Promise(resolve => setTimeout(resolve, 300));
      }
    })();
  };
  await beforeEffect?.();
  if (signal?.aborted) throw signal.reason ?? new ReviewDenied('stage_aborted');
  signal?.addEventListener?.('abort', onAbort, { once: true });
  try {
    const run = await exec('docker', args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
    stdout = run.stdout;
    stderr = run.stderr;
  } catch (error) {
    // Доказательство хостового таймаута: execFile добил дочерний процесс по
    // истечении timeout (killed + SIGTERM). Нечисловой код без этого
    // признака — обычный сбой exec (spawn/ENOENT), не доказанный таймаут.
    ({ code, timedOut } = classifySandboxExit(error));
    stdout = error.stdout ?? '';
    stderr = error.stderr ?? '';
  } finally {
    signal?.removeEventListener?.('abort', onAbort);
    // Сначала дождаться уже начатого удаления обработчиком отмены: повторный
    // rm -f во время активного удаления получил бы «removal ... is already
    // in progress» и отказ вернулся бы до завершения cleanup.
    await stopping;
    // Параллельный stopRun мог начать удаление этого же контейнера по id
    // раньше rm по имени: «removal already in progress» значит удаление ещё
    // идёт — дожидаемся его завершения, отказ только после реального cleanup.
    for (let poll = 0; ; poll++) {
      try {
        await exec('docker', ['rm', '-f', name], { timeout: 15_000 });
        break;
      } catch (failure) {
        const detail = String(failure.stderr);
        if (detail.includes('No such container')) break;
        if (!detail.includes('already in progress') || poll >= 12) {
          throw new ReviewDenied('sandbox_cleanup_failed', { cause: failure });
        }
        await new Promise(resolve => setTimeout(resolve, 300));
      }
    }
  }
  if (signal?.aborted) throw signal.reason ?? new ReviewDenied('stage_aborted');
  return { code, stdout, stderr, timedOut };
}

// Хостовое доказательство завершения child_process.execFile: числовой код —
// выход процесса; timedOut — только когда хост добил процесс по timeout
// (killed + SIGTERM). SIGKILL/SIGINT и spawn-ошибки таймаутом не являются.
export function classifySandboxExit(error) {
  return {
    code: typeof error?.code === 'number' ? error.code : null,
    // Доказательство deadline хоста — killed: execFile сам послал
    // kill-сигнал (наш killSignal — SIGTERM) по таймауту. Дочерний процесс
    // мог погибнуть им (signal = 'SIGTERM') либо обработать и выйти числом
    // (signal = null, code = 1 и т.п.) — оба случая доказанный таймаут.
    // Любой другой сигнал — не хостовый deadline (SIGKILL/SIGINT и т.п.).
    timedOut: error?.killed === true &&
      (error?.signal === 'SIGTERM' || error?.signal == null),
  };
}

// Классификация ненулевого выхода read-only раннера: только числовой код 143
// (SIGTERM процесса контейнера) или доказанный хостовый таймаут exec дают
// transient ReviewRunnerTimeout. Произвольный null, строка «143» в stderr,
// SIGKILL (137), отказ запуска и прочие коды — обычный ReviewDenied.
export function reviewRunnerExitFailure(run) {
  const reason = `review_runner_exit:${run?.code ?? 'timeout'}`;
  // Код 137 — SIGKILL и нетранзиентен даже при timedOut-флаге: дочерний
  // процесс вышел 137-м, обработав deadline-сигнал, — числовой выход
  // доминирует над host-доказательством.
  if (run?.code === 143 || (run?.timedOut === true && run?.code !== 137)) {
    return new ReviewRunnerTimeout(reason);
  }
  return new ReviewDenied(reason);
}

// Перед единственным повтором L2: тот же зачисленный worktree на той же
// ветке — чистый HEAD на candidate_sha, прежний base-предок, а при заданном
// binding.branch именно эта ветка (detached HEAD и подмена ветки на тот же
// коммит отклоняются). Невозможность проверить — отказ, повторного вызова нет.
export async function assertRetrySubjectUnchanged(binding) {
  if (!isAbsolute(binding?.worktree ?? '') || !SHA.test(binding?.candidate_sha ?? '')) {
    throw new ReviewDenied('review_retry_subject_unverified');
  }
  // Путь обязан оставаться каноническим recorded-at-enrollment: подмена его
  // симлинком на другой чистый checkout — не тот субъект, повтор запрещён.
  const canonical = await realpath(binding.worktree).catch(() => null);
  const toplevel = await git(binding.worktree, 'rev-parse', '--show-toplevel');
  const head = await git(binding.worktree, 'rev-parse', 'HEAD');
  const branch = await git(binding.worktree, 'branch', '--show-current');
  const status = await git(binding.worktree, 'status', '--porcelain=v1', '--untracked-files=all');
  if (canonical !== binding.worktree || toplevel !== binding.worktree ||
      head !== binding.candidate_sha || status !== '' || branch === '' ||
      (nonEmpty(binding.branch) && branch !== binding.branch)) {
    throw new ReviewDenied('review_retry_subject_changed');
  }
  if (SHA.test(binding.base_sha ?? '')) {
    await git(binding.worktree, 'merge-base', '--is-ancestor',
      binding.base_sha, binding.candidate_sha);
  }
}

// Контроллерские гейты перед единственным повтором: доказательство ТЕКУЩЕГО
// lease/эпохи свежим verifyHeld (native renew + допуск 'claimed'), повторный
// допуск карточки (владелец/метка) и сверка живых контрактных меток с
// закреплёнными при спавне, guardTask там, где сконфигурирован, daemon и
// pilot kill-switch, закреплённые входы оператора, передэффектные гейты.
// Ничего не берётся из кэшированного флага — каждая проверка живая.
export function l2ReviewRetryGuard({ port, taskId, epoch, owner, label, contract,
  required, assertPinned, beforeEffect, assertOpen, daemonOpen }) {
  return async () => {
    const live = await port.verifyHeld(taskId, epoch);
    if (live?.epoch !== epoch) throw new Error('Lease lost');
    if (owner && label && await port.matches?.(taskId, { owner, label, state: 'claimed' }) === false) {
      throw new Error('Task no longer authorized');
    }
    if (contract || required?.length) {
      const live = await port.labels?.(taskId);
      if (!live) throw new Error('contract_labels_unavailable');
      if (contract) {
        for (const key of ['repo_id', 'spec_digest', 'policy_digest',
            'profile_id', 'finish', 'fixtures_digest', 'l1_profile']) {
          if ((live[key] ?? null) !== (contract[key] ?? null)) {
            throw new Error(`contract_drift:${key}`);
          }
        }
        if ((live.has_ui === 'true') !== (contract.has_ui === true)) {
          throw new Error('contract_drift:has_ui');
        }
      }
      // Дополнительные required-метки маршрута — тот же допуск, что у
      // claimReady на первичном захвате: метка, снятая во время первой
      // попытки, делает карточку непригодной для повтора.
      // Тот же допуск, что у claimReady/admits: метка обязана быть
      // НЕПУСТОЙ строкой — снятая и опустошённая метки одинаково закрывают
      // карточку для повтора.
      for (const key of required ?? []) {
        if (typeof live[key] !== 'string' || !live[key]) {
          throw new Error(`required_label_missing:${key}`);
        }
      }
    }
    await port.guardTask?.(taskId, epoch);
    await daemonOpen?.();
    if (assertOpen) await assertOpen(); else await assertPinned?.();
    await beforeEffect?.();
  };
}

// Пре-эффектная граница запуска ТОЛЬКО для повтора: сначала живые гейты и
// асинхронная сверка субъекта, затем закреплённые входы/переключатели и
// доказательство lease — а дешёвое чтение daemon-стоп-файла идёт
// ПОСЛЕДНИМ: закрытие switch в любом из асинхронных окон (контракт,
// субъект, пины, renewal) отменяет запуск, а не только его более ранняя
// проверка. Порядок фиксирован здесь, чтобы регрессионный тест мог
// прогнать сам продукционный хук, а не его копию.
export function l2LaunchBoundary({ retryGuard, verifySubject, assertOpen,
  assertPinned, checkLease, daemonOpen }) {
  return async () => {
    await retryGuard?.();
    await verifySubject?.();
    if (assertOpen) await assertOpen(); else await assertPinned?.();
    await checkLease?.();
    await daemonOpen?.();
  };
}

// Пара read-only читателей L2 одного закреплённого критика: первый запуск
// идёт прежним beforeEffect — тем же хуком, что до DF-OPS-1, без новых
// daemon-чтений, ожидания renewal и повторных гейтов в пре-эффекте. Второй
// экземпляр того же раннера и pinned-модели получает retry-only хук
// границы запуска — retry-проверки существуют только у него.
// Оба раннера конструируются ЛЕНИВО, при первом вызове: проверки
// review-порта (renewal, пины, пре-эффект) остаются впереди и
// конструирования читателя, а не только его запуска.
export function l2CriticRunners({ makeRunner, options, beforeEffect, retryBeforeEffect }) {
  const lazy = hook => {
    let runner;
    return (binding, profile) =>
      (runner ??= makeRunner({ ...options, beforeEffect: hook }))(binding, profile);
  };
  return { review: lazy(beforeEffect), retry: lazy(retryBeforeEffect) };
}

// Доказательство lease на границе запуска — только свежий нативный
// verifyHeld с точной эпохой: кэшированный флаг renewal-цикла и await
// pending-промиса не доказывают текущее удержание карточки.
export function l2FreshLeaseCheck({ port, taskId, epoch }) {
  return async () => {
    const live = await port.verifyHeld(taskId, epoch);
    if (live?.epoch !== epoch) throw new Error('Lease lost');
  };
}

// Один повторный вызов L2-критика внутри review-порта — только по
// ReviewRunnerTimeout, без сна и скрытых циклов. Повтор идёт с теми же
// binding/profile: тот же критик, модель/effort и subject_digest
// гарантированы идентичностью аргументов. beforeRetry — контроллерские
// гейты (lease/epoch, допуск карточки, kill-switch, закреплённые входы);
// любой неуспех гейта отменяет повтор, ошибка уходит в обычный hold.
// Второй сбой пробрасывается наружу без третьей попытки.
export async function l2ReviewWithTransientRetry({ review, retry = review, binding, profile,
  beforeRetry, verifySubject = assertRetrySubjectUnchanged, log }) {
  try {
    return await review(binding, profile);
  } catch (error) {
    if (!(error instanceof ReviewRunnerTimeout)) throw error;
    // Сначала неизменность субъекта (fs/git), затем живые контроллерские
    // гейты непосредственно перед dispatch: дрейф во время subject-check
    // не должен пропустить второй вызов под устаревшей авторизацией.
    await verifySubject(binding);
    await beforeRetry?.();
    // Дрейф за время живых гейтов: субъект сверяется повторно непосредственно
    // перед dispatch — смена HEAD/чистоты во время ожидания lease/daemon
    // проверок не должна пропустить экспорт другого коммита второму читателю.
    await verifySubject(binding);
    log?.({ kind: 'l2_review_retry', task: binding?.task_id ?? null,
      sha: binding?.candidate_sha ?? null, reason: error.reason });
    // Второй вызов может идти отдельным экземпляром того же раннера с
    // retry-only пре-эффектом — первый запуск retry-гейтов не несёт.
    return await retry(binding, profile);
  }
}

function runModelInReadOnlySandbox({ allow, argv, env = {}, mounts = [], ...options }) {
  const { NODE_OPTIONS, ...bootEnv } = env;
  if (NODE_OPTIONS) bootEnv.DF_CHILD_NODE_OPTIONS = NODE_OPTIONS;
  return withModelProxy({ allow, beforeConnect: options.beforeEffect }, socket => runInReadOnlySandbox({ ...options,
    argv: ['node', '/model-proxy/client.cjs', ...argv], env: bootEnv,
    mounts: [...mounts, { src: PROXY_BOOTSTRAP, dst: '/model-proxy/client.cjs' },
      { src: socket, dst: '/model-proxy/upstream.sock' }] }));
}

function piSandbox(opts) {
  return runModelInReadOnlySandbox(opts);
}

async function sandboxPiCredential(piRoot, provider, kind, beforeEffect) {
  const load = async () => JSON.parse(await readFile(join(piRoot, 'auth.json'), 'utf8'))?.[provider];
  let auth = await load();
  if (auth == null) throw new ReviewDenied(`${kind}_auth_missing`);
  if (auth.type !== 'oauth') return auth;
  // Refresh is a host-side operation: a rotated refresh token must survive
  // the sandbox, and the long-lived credential must never be copied into it.
  if (typeof auth.expires === 'number' && auth.expires <= Date.now() + 10 * 60 * 1000) {
    await beforeEffect?.();
    try {
      await exec(join(piRoot, 'bin', 'pi'), ['auth', 'print-bearer-token', '--provider', provider,
        '--min-expiry', '10m'], { timeout: 60_000, maxBuffer: 1024 * 1024 });
    } catch {
      // A child-process error can include the bearer in stdout; don't forward it.
      throw new ReviewDenied(`${kind}_auth_refresh_failed`);
    }
    auth = await load();
  }
  if (auth?.type !== 'oauth' || !nonEmpty(auth.access)) throw new ReviewDenied(`${kind}_auth_missing`);
  return { type: 'oauth', access: auth.access, expires: auth.expires, refresh: 'sandbox-redacted',
    ...(nonEmpty(auth.accountId) ? { accountId: auth.accountId } : {}) };
}

// Legacy Pi/Sol ReviewPort on the hardened snapshot; VS-2 uses the Neon adapter.
export function isolatedPiReviewRunner({ journal, piRoot = join(homedir(), '.pi', 'agent'),
  prompt = '', image = REVIEW_IMAGE, timeoutMs = 480_000, sandbox = piSandbox, beforeEffect, signal }) {
  if (!isAbsolute(journal ?? '') || !isAbsolute(piRoot ?? '')) {
    throw new ReviewDenied('review_runner_misconfigured');
  }
  return async (binding, profile) => {
    // Спек критика нормализуется к провайдеру, реально исполняемому этим
    // раннером ('pi/openai/…' → 'openai' и т.д.); без egress — отказ до
    // контейнера, а не model_proxy_allowlist_invalid внутри песочницы.
    const critic = runnerReviewSpec(profile?.review);
    if (critic === null || !nonEmpty(critic.model) || !nonEmpty(critic.reasoningLevel)) {
      throw new ReviewDenied('review_profile_not_approved');
    }
    // Кросс-семейственный инвариант до запуска контейнера и модели.
    assertCrossFamily(binding.executor ?? profile.executor, critic);
    if (!SHA.test(binding.candidate_sha ?? '')) {
      throw new ReviewDenied('review_requires_full_sha');
    }

    const scratch = await mkdtemp(join(tmpdir(), 'board-review-'));
    const name = `review-${binding.task_id}-${binding.candidate_sha}-${randomUUID()}.ndjson`;
    try {
      const archive = join(scratch, 'candidate.tar');
      const source = join(scratch, 'candidate');
      await mkdir(source);
      await chmod(source, 0o755);
      // unpackExact из runtime.mjs: git archive + побайтовая сверка каждого blob.
      await unpackExact(binding.worktree, binding.candidate_sha, archive, source);

      // Точный diff base→candidate: снимок read-only без .git, поэтому
      // ревьюеру монтируется готовый patch — иначе он реконструирует историю
      // умозрительно и выдумывает находки.
      const diffFile = join(scratch, 'candidate.diff');
      try {
        const { stdout: patch } = await exec('git',
          ['-C', binding.worktree, 'diff', `${binding.base_sha}..${binding.candidate_sha}`],
          { timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
        if (patch.trim()) await writeFile(diffFile, patch, { mode: 0o600 });
      } catch { /* без diff ревью всё равно идёт по снимку */ }

      // Контрольные значения ДО запуска: дерево, байты снимка и worktree.
      const treeSha = await git(binding.worktree, 'rev-parse', `${binding.candidate_sha}^{tree}`);
      const before = await snapshotDigest(source);
      const fpBefore = await worktreeFingerprint(binding.worktree);

      // Монтирования критика: только каталоги кода ~/.pi/agent — ни sessions/,
      // ни auth.json на диске контейнера. Конфиги собираются в /pi-cfg и
      // копируются в tmpfs /tmp/.pi/agent: auth.json содержит ТОЛЬКО запись
      // одного провайдера критика и уничтожается pi-guard после первого чтения.
      const cfgDir = join(scratch, 'pi-cfg');
      await mkdir(cfgDir, { mode: 0o700 });
      const credential = await sandboxPiCredential(piRoot, critic.provider, 'review', beforeEffect);
      await writeFile(join(cfgDir, 'auth.json'),
        JSON.stringify({ [critic.provider]: credential }), { mode: 0o600 });
      for (const file of PI_CONFIG_FILES) {
        const src = join(piRoot, file);
        if (await lstat(src).catch(() => null)) {
          await writeFile(join(cfgDir, file), await sandboxedPiConfig(file, src));
        }
      }
      const mounts = [
        { src: cfgDir, dst: '/pi-cfg' },
        { src: GUARD_FILE, dst: '/pi-guard/pi-guard.cjs' },
      ];
      if (await lstat(diffFile).catch(() => null)) {
        mounts.push({ src: diffFile, dst: '/review/diff.patch' });
      }
      for (const component of PI_MOUNT_DIRS) {
        const src = join(piRoot, component);
        const info = await lstat(src).catch(() => null);
        if (info) mounts.push({ src, dst: `/pi-ro/${component}` });
      }
      const allow = PROVIDER_EGRESS.get(critic.provider) ?? [];
      const env = { NODE_OPTIONS: '--require /tmp/pi-guard.cjs', PI_OFFLINE: '1',
        PI_ALLOW_CONNECT: allow.join(',') };

      const hasDiff = mounts.some((m) => m.dst === '/review/diff.patch');
      const diffLine = hasDiff
        ? 'and the exact diff base→candidate is mounted read-only at /review/diff.patch'
        : 'and the base→candidate diff is not available (review the tree as a whole)';
      const subjectLine = binding.subject_digest
        ? `The required subject_digest for this candidate is "${binding.subject_digest}". ` +
          'Echo that exact string as "subject_digest" inside the verdict JSON — ' +
          'copy it verbatim, do NOT compute or invent a digest yourself.'
        : '';
      const instruction = buildReviewInstruction({ binding, diffLine, subjectLine,
        prompt, round: binding.review_round ?? 1,
        priorBlockingFindings: binding.prior_findings ?? [] });

      // Каталоги pi — симлинки на read-only монтирования кода; конфиги
      // копируются в tmpfs (pi кладёт <name>.lock рядом), guard — в /tmp.
      const piArgv = ['/bin/sh', '-c',
        'mkdir -p /tmp/.pi/agent /tmp/session; ' +
        'for f in bin install npm; do ' +
        '[ -e "/pi-ro/$f" ] && ln -s "/pi-ro/$f" "/tmp/.pi/agent/$f"; done; ' +
        'for f in auth.json settings.json models.json models-store.json; do ' +
        '[ -e "/pi-cfg/$f" ] && cp "/pi-cfg/$f" "/tmp/.pi/agent/$f"; done; ' +
        'cp /pi-guard/pi-guard.cjs /tmp/pi-guard.cjs; ' +
        'exec /pi-ro/bin/pi "$@"', 'pi',
        '--print', '--mode', 'json',
        '--provider', critic.provider, '--model', critic.model,
        '--thinking', critic.reasoningLevel,
        '--no-mcp', '--no-extensions', '--no-skills', '--no-context-files',
        '--no-approve', '--tools', READ_ONLY_TOOLS.join(','),
        '--session-dir', '/tmp/session', instruction];

      const run = await sandbox({ snapshot: source, argv: piArgv, image, env, mounts, allow, timeoutMs,
        beforeEffect, signal });
      const dirtyExit = run.code !== 0;
      if (dirtyExit) {
        // Сырой вывод — только в приватный журнал (0600), не в причину Board.
        try {
          await writeFile(join(journal, `${name}.stderr`),
            String(run.stderr || run.stdout || ''), { flag: 'wx', mode: 0o600 });
        } catch { /* журнал недоступен — не маскируем исходную ошибку */ }
        // Завершённый транскрипт при ненулевом выходе — не «чистый» transient:
        // ответ проходит обычную валидацию (модель, tools, verdict, REWORK),
        // чтобы повтор не стёр содержательный исход. Структурные и
        // аттестационные отказы парсера (mismatch модели/effort) сохраняются
        // как есть — повтор по ним запрещён; transient-классификация только
        // для действительно оборванного потока: даже незавершённый поток с
        // явным error-событием или чужой закреплённой моделью — отказ, не retry.
        try {
          parseReviewTranscript(run.stdout);
        } catch (error) {
          if (error instanceof ReviewDenied && !TRUNCATED_TRANSCRIPT.has(error.reason)) {
            throw error;
          }
          // Скан дисквалификации идёт по сырому потоку при ЛЮБОЙ усечённой
          // причине: поток из одного error-события парсится как empty,
          // битая строка — как corrupt; оба случая могут уже содержать
          // зафиксированный отказ или чужую закреплённую модель.
          const disqualified = transcriptDisqualifying(run.stdout, critic);
          if (disqualified) throw new ReviewDenied(disqualified);
          const exitError = reviewRunnerExitFailure(run);
          if (exitError instanceof ReviewRunnerTimeout) {
            // Прежде чем выход станет повторяемым — снимок первого читателя
            // обязан быть нетронут: нарушение read-only границы — hold,
            // не transient, иначе повтор сотрёт следы инцидента.
            await verifySnapshotUnchanged(source, before);
          }
          throw exitError;
        }
      }

      // Приватный сырой транскрипт: контроллер владеет каталогом журнала.
      const transcript = run.stdout;
      const transcript_sha256 = createHash('sha256').update(transcript).digest('hex');
      await writeFile(join(journal, name), transcript, { flag: 'wx', mode: 0o600 });

      const parsed = parseReviewTranscript(transcript);
      for (const key of ['provider', 'model', 'reasoningLevel']) {
        if (parsed.actual[key] !== critic[key]) {
          throw new ReviewDenied(`review_${key}_mismatch`);
        }
      }
      assertToolsAllowed(parsed.toolsAdded);
      const verdict = await applySeverityGating(parseReviewVerdict(parsed.finalText),
        { journal, taskId: binding.task_id, candidateSha: binding.candidate_sha,
          round: binding.review_round ?? 1 });
      if (binding.subject_digest != null
          ? verdict.subject_digest !== binding.subject_digest
          : nonEmpty(verdict.subject_digest)) {
        // При заданном дайджесте вердикт обязан подтвердить именно его;
        // непрошенный subject_digest без binding — тоже отказ.
        throw new ReviewDenied('review_verdict_subject_mismatch');
      }

      // Ненулевой выход не даёт квитанции вообще: завершённый поток прошёл
      // обычную валидацию выше (mismatch-модели — уже hold со своей причиной),
      // но любой вердикт по грязному выходу, включая REWORK/ESCALATE при
      // transient-коде, — обычный hold, как до добавления повтора.
      if (dirtyExit) {
        throw new ReviewDenied(`review_runner_exit:${run.code ?? 'timeout'}`);
      }

      // После завершения: снимок и worktree обязаны быть побайтово неизменны.
      await verifySnapshotUnchanged(source, before);
      const fpAfter = await worktreeFingerprint(binding.worktree);
      if (!sameFingerprint(fpBefore, fpAfter) ||
          await git(binding.worktree, 'rev-parse', `${binding.candidate_sha}^{tree}`) !== treeSha) {
        throw new ReviewDenied('worktree_drift_during_review');
      }

      const checkpoint = CHECKPOINT.test(parsed.responseId ?? '')
        ? parsed.responseId
        : transcript_sha256.slice(0, 32);

      return {
        task: binding.task_id,
        sha: binding.candidate_sha,
        tree_sha: treeSha,
        subject_digest: binding.subject_digest ? verdict.subject_digest : null,
        verdict: verdict.verdict,
        status: verdict.status,
        summary: verdict.summary,
        findings: verdict.findings,
        sidecar_findings: verdict.sidecar_findings ?? [],
        severity_gated: verdict.severity_gated === true,
        checked_invariants: verdict.checked_invariants,
        excerpt: verdict.excerpt,
        checkpoint,
        transcript_sha256,
        transcript_file: name,
        actual: {
          provider: parsed.actual.provider,
          model: parsed.actual.model,
          reasoningLevel: parsed.actual.reasoningLevel,
        },
        // VS-3: суммарный usage ходов pi; провайдер не отдал — явный null.
        usage: parsed.usage ?? null,
        isolation: 'docker-ro-v1',
      };
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  };
}

// Публичные egress-endpoint'ы провайдеров моделей для allowlist pi-guard.
// Ключ — реальный pi-провайдер из auth.json (pi --list-models): 'opencode-go'
// обслуживает DeepSeek через свой штатный endpoint, провайдер не
// переименовывается — иначе телеметрия и auth.json теряют сопоставление.
const PROVIDER_EGRESS = new Map([
  ['openai', ['api.openai.com:443', 'chatgpt.com:443']],
  ['google', ['generativelanguage.googleapis.com:443']],
  ['deepseek', ['api.deepseek.com:443']],
  ['glm', ['open.bigmodel.cn:443']],
  ['cognition', ['api.cognition.ai:443']],
  ['opencode-go', ['opencode.ai:443']],
]);

// Спек критика/арбитра в форме, реально исполняемой L2-раннером, либо
// null, когда у раннера нет для него разрешённых адресов:
// — харнесс 'pi' берёт pi-провайдера вложения 'pi/inner/model' как есть,
//   когда у вложения есть собственный egress ('pi/opencode-go/deepseek-…'
//   → 'opencode-go', 'pi/openai/…' → 'openai'); провайдер НЕ подменяется —
//   канонический ключ сопоставления телеметрии и allowlist сохраняется;
// — 'acp-antigravity-acp' → 'google' (Neon/agy-транспорт);
// — прямые pi-провайдеры из PROVIDER_EGRESS — как есть.
// 'acp-devin' и прочие → null: адреса для них не выдумываются.
export function runnerReviewSpec(spec) {
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) return null;
  let { provider, model } = spec;
  if (provider === 'acp-antigravity-acp') {
    provider = 'google';
  } else if (provider === 'pi' && typeof model === 'string' && model.includes('/')) {
    const i = model.indexOf('/');
    const inner = model.slice(0, i).toLowerCase();
    // Вложение с собственным egress — как есть (auth.json ключ и
    // телеметрия совпадают с исходным pi-провайдером); без egress —
    // семейство вложения, если у семейства есть endpoint.
    provider = PROVIDER_EGRESS.has(inner)
      ? inner : (PROVIDER_FAMILY.get(inner) ?? inner);
    model = model.slice(i + 1);
  }
  if (typeof provider !== 'string' || !PROVIDER_EGRESS.has(provider)) return null;
  return { ...spec, provider, model };
}

// Провайдер исполняем L2-раннером (критик L2 или pi-арбитр) тогда и только
// тогда, когда спек нормализуется к провайдеру с egress-allowlist.
export function l2RunnableSpec(spec) {
  return runnerReviewSpec(spec) !== null;
}

// Закреплённый критик L2 к виду, по которому выбирается раннер: спек
// нормализуется runnerReviewSpec, а у критика google-семейства наследуется
// reasoningLevel (явный > defaultReasoningLevel из профиля > 'medium') ДО
// решения Neon vs Pi — Neon без reasoningLevel не должен уходить в
// Pi-раннер, иначе acceptHeld отклонит квитанцию (#1263 r6).
// null — спек неисполняем (нет egress).
export function l2CriticSpec(spec, { defaultReasoningLevel = 'medium' } = {}) {
  const critic = runnerReviewSpec(spec);
  if (critic === null) return null;
  if (executorFamily(critic) === 'google') {
    return { reasoningLevel: defaultReasoningLevel, ...critic };
  }
  return critic;
}

function parseArbiterDecision(text) {
  const body = String(text ?? '').trim();
  const json = /^```(?:json)?\s+([\s\S]*?)```$/i.exec(body)?.[1] ?? body;
  try {
    const decision = JSON.parse(json);
    if (decision !== null && typeof decision === 'object' && !Array.isArray(decision)) return decision;
  } catch (cause) {
    throw new ReviewDenied('arbiter_response_invalid', { cause });
  }
  throw new ReviewDenied('arbiter_response_invalid');
}

// Изолированный раннер арбитра третьего независимого семейства. Тот же
// rootless Docker read-only контур, что у критика, но без снимка кандидата:
// арбитр судит по сериализованному спору (trigger + evidence + спека), а не
// по дереву — дерево и worktree в контейнер не монтируются вообще.
export function isolatedArbiterRunner({ journal, piRoot = join(homedir(), '.pi', 'agent'),
  prompt = '', image = REVIEW_IMAGE, timeoutMs = 480_000, sandbox = piSandbox, beforeEffect }) {
  if (!isAbsolute(piRoot ?? '')) {
    throw new ReviewDenied('arbiter_runner_misconfigured');
  }
  return async (req) => {
    // Та же нормализация, что и у критика: pi-арбитр исполняется только
    // на провайдере с egress-allowlist.
    const arbiter = runnerReviewSpec(req?.arbiter);
    const effort = arbiter?.reasoningLevel ?? 'high';
    if (arbiter === null || !nonEmpty(arbiter.model)) {
      throw new ReviewDenied('arbiter_profile_not_approved');
    }
    const scratch = await mkdtemp(join(tmpdir(), 'board-arbiter-'));
    try {
      // auth только одного провайдера арбитра — как у критика, копией в tmpfs.
      const cfgDir = join(scratch, 'pi-cfg');
      await mkdir(cfgDir, { mode: 0o700 });
      const credential = await sandboxPiCredential(piRoot, arbiter.provider, 'arbiter', beforeEffect);
      await writeFile(join(cfgDir, 'auth.json'),
        JSON.stringify({ [arbiter.provider]: credential }), { mode: 0o600 });
      for (const file of PI_CONFIG_FILES) {
        const src = join(piRoot, file);
        if (await lstat(src).catch(() => null)) {
          await writeFile(join(cfgDir, file), await sandboxedPiConfig(file, src));
        }
      }
      const mounts = [
        { src: cfgDir, dst: '/pi-cfg' },
        { src: GUARD_FILE, dst: '/pi-guard/pi-guard.cjs' },
      ];
      for (const component of PI_MOUNT_DIRS) {
        const src = join(piRoot, component);
        if (await lstat(src).catch(() => null)) {
          mounts.push({ src, dst: `/pi-ro/${component}` });
        }
      }
      const allow = PROVIDER_EGRESS.get(arbiter.provider) ?? [];
      const env = { NODE_OPTIONS: '--require /tmp/pi-guard.cjs', PI_OFFLINE: '1',
        PI_ALLOW_CONNECT: allow.join(',') };

      const instruction = [
        `Independent arbitration for Board #${req.task_id} attempt ${req.attempt_id}.`,
        'You are the arbiter of the third independent family. Judge the dispute below',
        'against the spec. You have read-only tools only; do not attempt to write.',
        `The required subject_digest is "${req.subject_digest ?? ''}". Repeat it verbatim`,
        'inside the decision JSON.',
        'Finish with exactly one JSON code block:',
        '{"decision":"directed_rework"|"accept_with_notes"|"escalate_owner",',
        '"subject_digest":"<the required digest>",',
        '"directive":"..."} or {"decision":"accept_with_notes","subject_digest":"...",',
        '"notes":"..."} or {"decision":"escalate_owner","subject_digest":"...",',
        '"question":"..."}.',
        'You may never waive deterministic gates, DoD, or accept harm 10 findings.',
        '',
        `Trigger: ${JSON.stringify(req.trigger ?? null)}`,
        `Evidence: ${JSON.stringify(req.evidence ?? null).slice(0, 8000)}`,
        '',
        prompt,
      ].join('\n');

      const piArgv = ['/bin/sh', '-c',
        'mkdir -p /tmp/.pi/agent /tmp/session; ' +
        'for f in bin install npm; do ' +
        '[ -e "/pi-ro/$f" ] && ln -s "/pi-ro/$f" "/tmp/.pi/agent/$f"; done; ' +
        'for f in auth.json settings.json models.json models-store.json; do ' +
        '[ -e "/pi-cfg/$f" ] && cp "/pi-cfg/$f" "/tmp/.pi/agent/$f"; done; ' +
        'cp /pi-guard/pi-guard.cjs /tmp/pi-guard.cjs; ' +
        'exec /pi-ro/bin/pi "$@"', 'pi',
        '--print', '--mode', 'json',
        '--provider', arbiter.provider, '--model', arbiter.model,
        '--thinking', effort,
        '--no-mcp', '--no-extensions', '--no-skills', '--no-context-files',
        '--no-approve', '--tools', READ_ONLY_TOOLS.join(','),
        '--session-dir', '/tmp/session', instruction];

      const snapshot = join(scratch, 'empty');
      await mkdir(snapshot);
      const run = await sandbox({ snapshot, argv: piArgv, image, env, mounts, allow, timeoutMs, beforeEffect });
      if (run.code !== 0) {
        throw new ReviewDenied(`arbiter_runner_exit:${run.code ?? 'timeout'}`);
      }
      const transcript = run.stdout;
      if (typeof journal === 'string' && isAbsolute(journal)) {
        const name = `arbiter-${req.task_id}-${req.attempt_id}-${randomUUID()}.ndjson`;
        await writeFile(join(journal, name), transcript, { flag: 'wx', mode: 0o600 });
      }
      const parsed = parseReviewTranscript(transcript);
      for (const key of ['provider', 'model']) {
        if (parsed.actual[key] !== arbiter[key]) {
          throw new ReviewDenied(`arbiter_${key}_mismatch`);
        }
      }
      if (parsed.actual.reasoningLevel !== effort) throw new ReviewDenied('arbiter_effort_mismatch');
      assertToolsAllowed(parsed.toolsAdded);
      const decision = parseArbiterDecision(parsed.finalText);
      if (!SHA256.test(req.subject_digest ?? '') || decision.subject_digest !== req.subject_digest) {
        throw new ReviewDenied('arbiter_subject_mismatch');
      }
      // VS-3: решение арбитра с суммарным usage его ходов (null при отсутствии).
      return { ...decision, usage: parsed.usage ?? null };
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  };
}
