// Harness-agnostic L2-ревьюер (ReviewPort) и адаптер isolatedPiReviewRunner.
// Критик работает в rootless Docker на системно read-only снимке unpackExact:
// снимок /candidate смонтирован readonly, worktree воркера, state контроллера,
// Board и токены физически отсутствуют в пространстве и env контейнера.
// Кросс-семейственный инвариант family(critic) !== family(executor) — программный,
// проверяется до запуска контейнера и модели.

import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

// Только эти компоненты ~/.pi/agent монтируются в контейнер критика:
// sessions/ и subagents/ исключены — у ревьюера нет чужих сессий.
const PI_COMPONENTS = ['bin', 'install', 'npm', 'auth.json', 'settings.json',
  'models.json', 'models-store.json'];

const PROXY_ENV = ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY',
  'https_proxy', 'http_proxy', 'no_proxy'];

const READ_ONLY_TOOLS = ['read', 'grep', 'find', 'ls'];

export class ReviewDenied extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

// Семейство по идентификатору harness/провайдера/модели. Строка вида
// 'acp-devin', 'openai/gpt-6.2-sol' или объект { provider, model }.
export function executorFamily(spec) {
  if (spec === null || spec === undefined) return null;
  const id = (typeof spec === 'string' ? spec
    : [spec.provider, spec.model].filter(Boolean).join('/')).toLowerCase();
  if (!id) return null;
  if (/acp-devin|swe-2/.test(id)) return 'cognition';
  if (/acp-zcode-start|glm/.test(id)) return 'glm';
  if (/deepseek|opencode-go/.test(id)) return 'deepseek';
  if (/openai|gpt-|codex/.test(id)) return 'openai';
  if (/gemini|acp-antigravity-acp|google/.test(id)) return 'google';
  return null;
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
// Возвращает actual { provider, model, reasoningLevel } каждого ассистентского
// message_end (все обязаны совпадать), toolsAdded и текст финального сообщения.
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
  let toolsAdded = null;
  const noteTools = (list) => {
    if (Array.isArray(list)) {
      toolsAdded = list.map(t => typeof t === 'string' ? t : t?.name);
    }
  };
  const seen = [];
  let finalText = '';
  let responseId = null;
  for (const event of events) {
    noteTools(event?.toolsAdded);
    if (event?.type === 'session_info') noteTools(event.data?.toolsAdded);
    if (event?.type === 'agent_end') noteTools(event.messages?.[0]?.toolsAdded);
    if (event?.type !== 'message_end') continue;
    const message = event.message ?? event.data?.message;
    if (message?.role !== 'assistant') continue;
    seen.push({
      provider: message.provider,
      model: message.model,
      reasoningLevel: message.thinkingLevel,
    });
    responseId = message.responseId ?? responseId;
    const parts = Array.isArray(message.content) ? message.content : [];
    const text = parts.filter(p => p?.type === 'text').map(p => p.text).join('\n');
    if (text.trim()) finalText = text;
  }
  if (seen.length === 0) throw new ReviewDenied('review_transcript_empty');
  const actual = seen[0];
  for (const msg of seen) {
    if (msg.provider !== actual.provider || msg.model !== actual.model ||
        msg.reasoningLevel !== actual.reasoningLevel) {
      throw new ReviewDenied('review_model_switch');
    }
  }
  return { actual, seen, toolsAdded, finalText, responseId, events };
}

// Извлечение вердикта критика: канонический JSON-блок или legacy-строки
// REVIEW_OK / REVIEW_BLOCKED. Возвращает каноническую форму:
// { status: PASS|REWORK|ESCALATE, verdict, summary, findings, checked_invariants, excerpt }.
export function parseReviewVerdict(text) {
  const body = String(text ?? '');
  // Сначала структурированный вердикт: последний JSON-объект с полем verdict.
  const candidates = [];
  const fenced = /```(?:json)?\s*\n([\s\S]*?)```/g;
  let m;
  while ((m = fenced.exec(body)) !== null) candidates.push(m[1]);
  candidates.push(body.slice(Math.max(0, body.lastIndexOf('{'))));
  for (const chunk of candidates.reverse()) {
    let parsed;
    try {
      parsed = JSON.parse(chunk.trim());
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) ||
        typeof parsed.verdict !== 'string') continue;
    return canonicalVerdict(parsed);
  }
  // Legacy-формат: ровно одна строка вердикта в конце ответа.
  const lines = body.split(/\r?\n/);
  const verdicts = lines.map(l => l.trim()).filter(l => ['REVIEW_OK', 'REVIEW_BLOCKED'].includes(l));
  if (verdicts.length === 1) {
    const status = verdicts[0] === 'REVIEW_OK' ? 'PASS' : 'REWORK';
    const excerpt = status === 'REWORK'
      ? lines.filter(l => !['REVIEW_OK', 'REVIEW_BLOCKED'].includes(l.trim()))
        .join('\n').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').trim().slice(0, 1400)
      : undefined;
    return { status, verdict: verdicts[0], summary: '', findings: [],
      checked_invariants: [], excerpt };
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
  const findings = Array.isArray(parsed.findings) ? parsed.findings : [];
  const summary = typeof parsed.summary === 'string' ? parsed.summary : '';
  const excerpt = nonEmpty(parsed.excerpt) ? parsed.excerpt.trim().slice(0, 1400)
    : hasValidFinding(findings)
      ? findings.filter(validFinding).map(f =>
          `${f.file}${f.line ? `:${f.line}` : ''}: expected ${f.expected}, actual ${f.actual}`)
          .join('\n').slice(0, 1400)
      : nonEmpty(summary) ? summary.trim().slice(0, 1400)
      : '';
  return {
    ...mapped,
    summary,
    findings: findings.filter(f => f !== null && typeof f === 'object' && !Array.isArray(f)),
    checked_invariants: Array.isArray(parsed.checked_invariants)
      ? parsed.checked_invariants.filter(nonEmpty) : [],
    excerpt: mapped.status === 'PASS' ? undefined : (excerpt || undefined),
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

// Универсальный вызов команды внутри rootless Docker read-only контура:
// точная архитектура, подтверждённая живым [VERIFY] на хосте.
// argv — команда внутри контейнера; env — allowlist env; mounts — дополнительные
// read-only bind-монтирования поверх обязательного снимка /candidate.
export async function runInReadOnlySandbox({ snapshot, argv, image = REVIEW_IMAGE,
  env = {}, mounts = [], timeoutMs = 120_000, workdir = '/candidate' }) {
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
    '--cap-drop=ALL', '--security-opt=no-new-privileges', '--user=0:0',
    '--tmpfs=/tmp:rw,nosuid,nodev,size=64m', '-e', 'HOME=/tmp',
    '--mount', `type=bind,src=${snapshot},dst=/candidate,readonly`];
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

// Адаптер ReviewPort: реальный Pi/Sol в read-only rootless Docker на снимке
// unpackExact(candidate_sha). Возвращает аттестованный ReviewReceipt.
export function isolatedPiReviewRunner({ journal, piRoot = join(homedir(), '.pi', 'agent'),
  prompt = '', image = REVIEW_IMAGE, timeoutMs = 480_000, sandbox = runInReadOnlySandbox }) {
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
      const headBefore = await git(binding.worktree, 'rev-parse', 'HEAD');
      const dirtyBefore = await git(binding.worktree, 'status', '--porcelain=v1', '--untracked-files=all');

      // Монтирования критика: только необходимые компоненты ~/.pi/agent,
      // без sessions/ и subagents/. Worktree, state/, Board — отсутствуют.
      const mounts = [];
      for (const component of PI_COMPONENTS) {
        const src = join(piRoot, component);
        const info = await lstat(src).catch(() => null);
        if (info) mounts.push({ src, dst: `/pi-ro/${component}` });
      }
      const env = {};
      for (const key of PROXY_ENV) {
        if (typeof process.env[key] === 'string' && process.env[key]) {
          env[key] = process.env[key];
        }
      }

      const instruction = [
        `Independent, read-only review for Board #${binding.task_id} at ${binding.candidate_sha}.`,
        'The candidate tree is mounted read-only at /candidate. Review the diff and the tree',
        'against the spec below. You have read-only tools only; do not attempt to write.',
        'Finish with exactly one verdict: a JSON code block {"verdict":"PASS"|"REWORK"|"ESCALATE",',
        '"summary":"...","findings":[{"file","line","input","expected","actual","freq","harm"}],',
        '"checked_invariants":["..."]}, or a final line REVIEW_OK or REVIEW_BLOCKED.',
        'REWORK requires at least one concrete finding (file, expected, actual).',
        '',
        prompt,
      ].join('\n');

      // Каталоги pi — симлинки на read-only монтирования; конфиги копируются
      // в tmpfs, потому что pi кладёт <name>.lock рядом с auth.json/settings.json.
      const piArgv = ['/bin/sh', '-c',
        'mkdir -p /tmp/.pi/agent; ' +
        'for f in bin install npm; do ' +
        '[ -e "/pi-ro/$f" ] && ln -s "/pi-ro/$f" "/tmp/.pi/agent/$f"; done; ' +
        'for f in auth.json settings.json models.json models-store.json; do ' +
        '[ -e "/pi-ro/$f" ] && cp "/pi-ro/$f" "/tmp/.pi/agent/$f"; done; ' +
        'exec /pi-ro/bin/pi "$@"', 'pi',
        '--print', '--mode', 'json',
        '--provider', critic.provider, '--model', critic.model,
        '--thinking', critic.reasoningLevel,
        '--no-mcp', '--no-extensions', '--no-skills', '--no-context-files',
        '--no-approve', '--tools', READ_ONLY_TOOLS.join(','),
        '--session-dir', '/tmp/session', instruction];

      const run = await sandbox({ snapshot: source, argv: piArgv, image, env, mounts, timeoutMs });
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
      if (parsed.toolsAdded !== null &&
          !parsed.toolsAdded.every(t => READ_ONLY_TOOLS.includes(t))) {
        throw new ReviewDenied('review_tools_violation');
      }
      const verdict = parseReviewVerdict(parsed.finalText);
      if (verdict.status === 'REWORK' && !hasValidFinding(verdict.findings) &&
          !nonEmpty(verdict.excerpt)) {
        throw new ReviewDenied('review_objection_missing');
      }

      // После завершения: снимок и worktree обязаны быть побайтово неизменны.
      await verifySnapshotUnchanged(source, before);
      if (await git(binding.worktree, 'rev-parse', 'HEAD') !== headBefore ||
          await git(binding.worktree, 'status', '--porcelain=v1', '--untracked-files=all') !== dirtyBefore ||
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
        subject_digest: binding.subject_digest ?? undefined,
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
