// Harness-agnostic L2-ревьюер (ReviewPort) и адаптер isolatedPiReviewRunner.
// Критик работает в rootless Docker на системно read-only снимке unpackExact:
// снимок /candidate смонтирован readonly, worktree воркера, state контроллера,
// Board и токены физически отсутствуют в пространстве и env контейнера.
// Кросс-семейственный инвариант family(critic) !== family(executor) — программный,
// проверяется до запуска контейнера и модели.

import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { unpackExact } from './runtime.mjs';

const exec = promisify(execFile);
const SHA = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const CHECKPOINT = /^[0-9a-f]{8,64}$/;

// Действующий закэшированный образ ревью-стенда ([VERIFY] на хосте).
export const REVIEW_IMAGE =
  'node@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9';

// В контейнер критика монтируются только каталоги кода ~/.pi/agent:
// sessions/, subagents/ и auth.json исключены — секрет едет копией в tmpfs.
const PROXY_ENV = ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy'];

// Дублирует правила pi-guard.cjs на стороне хоста: приватный прокси
// не должен даже попадать в окружение контейнера.
function privateProxyHost(hostname) {
  const h = String(hostname ?? '').toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1' || h === '::' ||
      h.startsWith('fe80') || h.startsWith('fc') || h.startsWith('fd')) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const [a, b] = m.slice(1).map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

const READ_ONLY_TOOLS = ['read', 'grep', 'find', 'ls'];

// Монтируются только каталоги кода; конфиги идут через /pi-cfg копией в tmpfs.
const PI_MOUNT_DIRS = ['bin', 'install', 'npm'];
const PI_CONFIG_FILES = ['settings.json', 'models.json', 'models-store.json'];
const GUARD_FILE = new URL('./pi-guard.cjs', import.meta.url).pathname;

export class ReviewDenied extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
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
// ВСЕХ toolsAdded по потоку и текст строго последнего хода.
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

// Внутренний вызов команды внутри rootless Docker read-only контура.
// Публичный раннер всегда работает с --network=none; сеть для модельного
// вызова включает только piSandbox (дополнительно режется pi-guard.cjs).
async function sandboxExec({ snapshot, argv, image = REVIEW_IMAGE,
  env = {}, mounts = [], timeoutMs = 120_000, workdir = '/candidate',
  modelNetwork = false }) {
  if (!isAbsolute(snapshot ?? '') || !Array.isArray(argv) || !argv.length) {
    throw new ReviewDenied('sandbox_request_invalid');
  }
  const security = JSON.parse((await exec('docker', ['info', '--format', '{{json .SecurityOptions}}'], {
    timeout: 12_000,
  })).stdout);
  if (!security.includes('name=rootless')) {
    throw new ReviewDenied('sandbox_requires_rootless_docker');
  }
  const name = `board-review-${randomUUID()}`;
  const args = ['run', '--rm', '--name', name, '--pull=never', '--read-only',
    '--cap-drop=ALL', '--security-opt=no-new-privileges', '--user=0:0'];
  if (modelNetwork) {
    args.push('--add-host', 'localhost:127.0.0.254');
  } else {
    args.push('--network=none');
  }
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
  try {
    const run = await exec('docker', args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
    stdout = run.stdout;
    stderr = run.stderr;
  } catch (error) {
    code = typeof error.code === 'number' ? error.code : null;
    stdout = error.stdout ?? '';
    stderr = error.stderr ?? '';
  } finally {
    try {
      await exec('docker', ['rm', '-f', name], { timeout: 15_000 });
    } catch { /* контейнер уже удалён --rm или не стартовал */ }
  }
  return { code, stdout, stderr };
}

// Публичный sandbox-раннер: сеть физически отключена всегда.
export function runInReadOnlySandbox(opts) {
  return sandboxExec({ ...opts, modelNetwork: false });
}

// Внутренний раннер ревьюера: единственный, кому нужен egress модели.
function piSandbox(opts) {
  return sandboxExec({ ...opts, modelNetwork: true });
}

// Адаптер ReviewPort: реальный Pi/Sol в read-only rootless Docker на снимке
// unpackExact(candidate_sha). Возвращает аттестованный ReviewReceipt.
export function isolatedPiReviewRunner({ journal, piRoot = join(homedir(), '.pi', 'agent'),
  prompt = '', image = REVIEW_IMAGE, timeoutMs = 480_000, sandbox = piSandbox }) {
  if (!isAbsolute(journal ?? '') || !isAbsolute(piRoot ?? '')) {
    throw new ReviewDenied('review_runner_misconfigured');
  }
  return async (binding, profile) => {
    const critic = profile?.review;
    if (critic === null || typeof critic !== 'object' ||
        !nonEmpty(critic.provider) || !nonEmpty(critic.model) || !nonEmpty(critic.reasoningLevel)) {
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
      const fullAuth = JSON.parse(await readFile(join(piRoot, 'auth.json'), 'utf8'));
      const credential = fullAuth?.[critic.provider];
      if (credential === undefined || credential === null) {
        throw new ReviewDenied('review_auth_missing');
      }
      await writeFile(join(cfgDir, 'auth.json'),
        JSON.stringify({ [critic.provider]: credential }));
      for (const file of PI_CONFIG_FILES) {
        const src = join(piRoot, file);
        if (await lstat(src).catch(() => null)) {
          await writeFile(join(cfgDir, file), await readFile(src));
        }
      }
      const mounts = [
        { src: cfgDir, dst: '/pi-cfg' },
        { src: GUARD_FILE, dst: '/pi-guard/pi-guard.cjs' },
      ];
      for (const component of PI_MOUNT_DIRS) {
        const src = join(piRoot, component);
        const info = await lstat(src).catch(() => null);
        if (info) mounts.push({ src, dst: `/pi-ro/${component}` });
      }
      // Egress-allowlist для pi-guard: только адрес прокси и публичные
      // endpoint'ы модели. Прокси на :44100 запрещён до запуска; NO_PROXY
      // в контейнер не передаётся.
      const allow = ['api.openai.com:443', 'chatgpt.com:443'];
      const env = { NODE_OPTIONS: '--require /tmp/pi-guard.cjs' };
      for (const key of PROXY_ENV) {
        const value = process.env[key];
        if (typeof value !== 'string' || !value) continue;
        let u;
        try {
          u = new URL(value);
        } catch {
          throw new ReviewDenied('review_proxy_invalid');
        }
        // Прокси на приватном/loopback адресе или порту Board запрещён до
        // запуска: такой endpoint дал бы контейнеру выход к локальным службам.
        if (u.port === '44100' || privateProxyHost(u.hostname)) {
          throw new ReviewDenied('review_proxy_blocked');
        }
        env[key] = value;
        allow.push(`${u.hostname.toLowerCase()}:${u.port || (u.protocol === 'https:' ? '443' : '80')}`);
      }
      env.PI_ALLOW_CONNECT = [...new Set(allow)].join(',');

      const subjectLine = binding.subject_digest
        ? `The required subject_digest for this candidate is "${binding.subject_digest}". ` +
          'Include "subject_digest":"<that value>" inside the verdict JSON.'
        : '';
      const instruction = [
        `Independent, read-only review for Board #${binding.task_id} at ${binding.candidate_sha}.`,
        'The candidate tree is mounted read-only at /candidate. Review the diff and the tree',
        'against the spec below. You have read-only tools only; do not attempt to write.',
        'Finish with exactly one verdict: a JSON code block {"verdict":"PASS"|"REWORK"|"ESCALATE",',
        '"summary":"...","findings":[{"file","line","input","expected","actual","freq","harm"}],',
        '"checked_invariants":["..."]}, or a final line REVIEW_OK or REVIEW_BLOCKED.',
        'A REWORK verdict is rejected unless "findings" contains at least one object',
        'with non-empty "file", "expected" and "actual" (or an explicit "excerpt" string).',
        subjectLine,
        '',
        prompt,
      ].join('\n');

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

      const run = await sandbox({ snapshot: source, argv: piArgv, image, env, mounts,
        timeoutMs });
      if (run.code !== 0) {
        throw new ReviewDenied(`review_runner_exit:${run.code ?? 'timeout'}`);
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
      const verdict = parseReviewVerdict(parsed.finalText);
      if (binding.subject_digest != null
          ? verdict.subject_digest !== binding.subject_digest
          : nonEmpty(verdict.subject_digest)) {
        // При заданном дайджесте вердикт обязан подтвердить именно его;
        // непрошенный subject_digest без binding — тоже отказ.
        throw new ReviewDenied('review_verdict_subject_mismatch');
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
        isolation: 'docker-ro-v1',
      };
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  };
}
