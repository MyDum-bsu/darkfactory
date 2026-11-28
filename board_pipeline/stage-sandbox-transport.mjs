/**
 * @deprecated Legacy V2 module (Foreman/Playbooks era). Superseded by the Wave 2.0
 * unified pipeline; retained for backward compatibility only — do not use in new code.
 * See docs/DEPRECATED.md.
 */
// Аттестованный read-only транспорт Stage-станций (VS-5.2): жёсткий
// контракт mode:'read-only' поверх двух доказуемых контуров:
//   landlock-ro-v1 — host Agy-транспорт (agy-transport.mjs + agy-landlock.py,
//     Linux Landlock ABI >= 4, NET_CONNECT allowlist где порт 44100 запрещён)
//     для google/gemini-4-neon и acp-antigravity-acp/gemini-4-neon;
//   docker-ro-v1 — rootless Docker (runInReadOnlySandbox + withModelProxy +
//     pi-guard.cjs, --network=none --read-only --cap-drop=ALL) для
//     openai/gpt-6.2-sol, pi/openai/gpt-6.2-sol и pi/opencode-go/deepseek-*.
// Fail-closed: неаттестованный транспорт отклоняется ДО любого дочернего
// процесса (stage_read_only_transport_not_enrolled); запрещённые модели —
// stage_model_denied; mode !== 'read-only' — stage_mode_not_read_only.
// До и после вызова сверяются snapshotDigest снимка и worktreeFingerprint:
// мутация снимка — snapshot_mutated, дрейф worktree — worktree_drift_during_review.
// Только встроенные модули Node и существующие модули board_pipeline/.

import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { promisify } from 'node:util';
import { isDeepStrictEqual } from 'node:util';
import { unpackExact } from './runtime.mjs';
import { STAGE_VERDICT_INSTRUCTION } from './stage-verifier.mjs';
import { withModelProxy } from './model-proxy.mjs';
import { assertToolsAllowed, parseReviewTranscript, ReviewDenied, REVIEW_IMAGE,
  runInReadOnlySandbox, runnerReviewSpec, snapshotDigest, worktreeFingerprint } from './review-runner.mjs';
import { hostAgyTransport } from './agy-transport.mjs';
import { killProcessGroupByMarker } from './signals.mjs';
import { opencodeGoPolicyViolation, retiredProviderViolation } from './worker-selector.mjs';
import agyStream from './agy-stream.cjs';

const exec = promisify(execFile);
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export class StageDenied extends ReviewDenied {}

const REASONING_RANK = Object.freeze({ off: 0, minimal: 1, low: 2, medium: 3, high: 4, xhigh: 5 });

// Маршрут модели к доказуемому read-only контуру. Запрещённые политикой
// идентификаторы и неизвестные спеки — stage_model_denied до любой пробы.
export function stageTransportKind(model) {
  if (retiredProviderViolation(model) || opencodeGoPolicyViolation(model)) {
    throw new StageDenied('stage_model_denied');
  }
  const provider = model?.provider;
  const name = model?.model;
  if ((provider === 'google' || provider === 'acp-antigravity-acp') && name === 'gemini-4-neon') {
    return 'landlock-ro-v1';
  }
  if ((provider === 'openai' && name === 'gpt-6.2-sol') ||
      (provider === 'pi' && /^(?:opencode-go\/deepseek-[a-z0-9.-]+|openai\/gpt-6\.2-sol)$/.test(name ?? ''))) {
    return 'docker-ro-v1';
  }
  throw new StageDenied('stage_model_denied');
}

// Linux Landlock ABI >= 4: тот же номер syscall, что в agy-landlock.py
// (CREATE=444, flags=LANDLOCK_CREATE_RULESET_VERSION=1). Ответ — версия ABI
// или отрицательный errno; всё < 4 — недопуск.
const LANDLOCK_ABI_PROBE =
  'import ctypes;libc=ctypes.CDLL(None,use_errno=True);print(libc.syscall(444,None,0,1))';

async function landlockAbiProbe() {
  try {
    const { stdout } = await exec('python3', ['-c', LANDLOCK_ABI_PROBE], { timeout: 10_000 });
    return Number(stdout.trim()) >= 4;
  } catch {
    return false;
  }
}

// Rootless Docker: SecurityOptions обязан содержать 'name=rootless'
// (та же проверка, что у runInReadOnlySandbox).
async function dockerRootlessProbe() {
  try {
    const { stdout } = await exec('docker', ['info', '--format', '{{json .SecurityOptions}}'],
      { timeout: 12_000 });
    return JSON.parse(stdout).includes('name=rootless');
  } catch {
    return false;
  }
}

// Проба контура БЕЗ запуска дочерних процессов модели: только capability
// хоста (ABI / rootless Docker). Возвращает { kind, enrolled }.
export async function probeStageSandboxCapability(kind,
  { probeLandlock = landlockAbiProbe, probeDocker = dockerRootlessProbe } = {}) {
  if (kind === 'landlock-ro-v1') return { kind, enrolled: await probeLandlock() === true };
  if (kind === 'docker-ro-v1') return { kind, enrolled: await probeDocker() === true };
  throw new StageDenied('stage_transport_unknown');
}

const PROXY_BOOTSTRAP = new URL('./model-proxy-client.cjs', import.meta.url).pathname;
const GUARD_FILE = new URL('./pi-guard.cjs', import.meta.url).pathname;
const PI_MOUNT_DIRS = ['bin', 'install', 'npm'];
const PI_CONFIG_FILES = ['settings.json', 'models.json', 'models-store.json'];

// Egress allowlist stage-моделей (те же endpoint'ы, что у L2-раннера).
const STAGE_EGRESS = new Map([
  ['openai', ['api.openai.com:443', 'chatgpt.com:443']],
  ['google', ['generativelanguage.googleapis.com:443']],
  ['opencode-go', ['opencode.ai:443']],
  ['deepseek', ['api.deepseek.com:443']],
]);

// signal пробрасывается в runInReadOnlySandbox: обработчик остановки
// именованного контейнера (docker rm -f <name> раннера) ставится только из
// переданного сигнала — внешний fallback по --filter volume не нужен.
// Раннер и proxy инъецируемы вторым аргументом для детерминированных тестов.
export function stageDockerSandbox({ allow, argv, env = {}, mounts = [], signal, ...options },
  { withProxy = withModelProxy, run = runInReadOnlySandbox } = {}) {
  const { NODE_OPTIONS, ...bootEnv } = env;
  if (NODE_OPTIONS) bootEnv.DF_CHILD_NODE_OPTIONS = NODE_OPTIONS;
  return withProxy({ allow, beforeConnect: options.beforeEffect },
    socket => run({ ...options, signal,
      argv: ['node', '/model-proxy/client.cjs', ...argv], env: bootEnv,
      mounts: [...mounts, { src: PROXY_BOOTSTRAP, dst: '/model-proxy/client.cjs' },
        { src: socket, dst: '/model-proxy/upstream.sock' }] }));
}

// auth только одного провайдера stage-модели — как у L2-раннера: refresh
// на хосте до контейнера, в песочницу едет копия и стирается pi-guard.
async function stagePiCredential(piRoot, provider, beforeEffect) {
  const load = async () => JSON.parse(await readFile(join(piRoot, 'auth.json'), 'utf8'))?.[provider];
  let auth = await load();
  if (auth == null) throw new StageDenied('stage_auth_missing');
  if (auth.type !== 'oauth') return auth;
  if (typeof auth.expires === 'number' && auth.expires <= Date.now() + 10 * 60 * 1000) {
    await beforeEffect?.();
    try {
      await exec(join(piRoot, 'bin', 'pi'), ['auth', 'print-bearer-token', '--provider', provider,
        '--min-expiry', '10m'], { timeout: 60_000, maxBuffer: 1024 * 1024 });
    } catch {
      throw new StageDenied('stage_auth_refresh_failed');
    }
    auth = await load();
  }
  if (auth?.type !== 'oauth' || typeof auth.access !== 'string' || !auth.access) {
    throw new StageDenied('stage_auth_missing');
  }
  return { type: 'oauth', access: auth.access, expires: auth.expires, refresh: 'sandbox-redacted',
    ...(typeof auth.accountId === 'string' && auth.accountId ? { accountId: auth.accountId } : {}) };
}

async function sandboxedPiConfig(file, src) {
  const body = await readFile(src);
  if (file !== 'settings.json') return body;
  const cfg = JSON.parse(body.toString('utf8'));
  delete cfg.httpProxy;
  return JSON.stringify(cfg);
}

// Вердикт stage: ровно одна строка "<challenge> PASS|REWORK|BLOCKED" из
// финального ответа модели. Чужой challenge — не доказательство.
function parseVerdictLine(line) {
  const source = line.trim();
  const core = body => {
    const match = /^([a-f0-9]{64}) (PASS|REWORK|BLOCKED)(\.?)$/.exec(body);
    return match === null ? null :
      { challenge: match[1], verdict: match[2], trailingDot: match[3] === '.' };
  };
  const plain = core(source);
  if (plain !== null) return plain;
  for (const mark of ['`', '**']) {
    if (!source.startsWith(mark)) continue;
    let body = null;
    let outerDot = false;
    if (source.endsWith(mark)) body = source.slice(mark.length, -mark.length);
    else if (source.endsWith(`${mark}.`)) {
      body = source.slice(mark.length, -(mark.length + 1));
      outerDot = true;
    }
    if (body === null) continue;
    const wrapped = core(body);
    if (wrapped !== null && !(wrapped.trailingDot && outerDot)) return wrapped;
  }
  return null;
}

export function stageVerdictLine(text, challenge) {
  // Ровно одна строка вердикта во всём ответе: две подходящие строки
  // (даже с одним challenge) — неоднозначность, отказ до аттестации.
  const lines = String(text ?? '').split('\n').map(parseVerdictLine).filter(Boolean);
  if (lines.length !== 1) throw new StageDenied('stage_verdict_unconfirmed');
  if (lines[0].challenge !== challenge) throw new StageDenied('stage_verdict_unconfirmed');
  return lines[0].verdict;
}

// Ожидание внутреннего вызова с учётом AbortSignal: при обрыве сначала
// вызывается onAbort (остановка активного дочернего процесса/контейнера),
// внутренний промис ДОЖИДАЕТСЯ (его finally — гарантированный cleanup),
// затем выбрасывается причина аборта. Осиротевших процессов не остаётся.
export function settleWithAbort(promise, signal, onAbort) {
  if (signal === undefined) return promise;
  const reason = () => signal.reason ?? new StageDenied('stage_aborted');
  // Остановка повторяется до завершения внутреннего промиса: в момент
  // отмены дочерний процесс может ещё не существовать (асинхронное окно
  // подготовки запуска) — одноразовое сканирование пропустило бы его, и
  // модель стартовала бы уже после отмены. Мемоизируется: каждая ветка
  // ниже дожидается той же остановки, а не запускает свою.
  let stopping = null;
  const stop = () => stopping ??= (async () => {
    let live = true;
    const loop = (async () => {
      while (live) {
        try { await onAbort?.(); } catch { /* best effort */ }
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    })();
    await Promise.resolve(promise).catch(() => {});
    live = false;
    await loop;
  })();
  if (signal.aborted) {
    return stop().then(() => { throw reason(); });
  }
  return new Promise((resolve, reject) => {
    const onSignal = () => stop().finally(() => reject(reason()));
    signal.addEventListener('abort', onSignal, { once: true });
    Promise.resolve(promise).then(
      value => {
        signal.removeEventListener('abort', onSignal);
        // Отказ после отмены — только по завершении остановки: иначе
        // параллельный cleanup (stopRun по id / rm по имени) переживал бы
        // возврат вызову, и вызывающий удалял бы временные файлы стадии
        // под ещё идущее удаление контейнера.
        if (signal.aborted) stop().finally(() => reject(reason()));
        else resolve(value);
      },
      cause => {
        signal.removeEventListener('abort', onSignal);
        if (signal.aborted) stop().finally(() => reject(cause));
        else reject(cause);
      });
  });
}

async function freshScratch(worktree) {
  const tempRoot = await realpath(tmpdir());
  const relation = relative(await realpath(worktree), tempRoot);
  if (!relation || (!isAbsolute(relation) && relation !== '..' && !relation.startsWith('../'))) {
    throw new StageDenied('stage_snapshot_inside_worktree');
  }
  return mkdtemp(join(tempRoot, 'df-stage-'));
}

// Создаёт аттестованный read-only транспорт Stage-станций. Все пробы и
// раннеры инъецируемы (probeLandlock, probeDocker, agyTransport,
// dockerSandbox, snapshotDigest, worktreeFingerprint, unpackExact) —
// детерминированные тесты без мокинга модулей, реальные реализации по умолчанию.
export function createStageSandboxTransport({
  worktree,
  journal,
  mode = 'read-only',
  timeoutMs = 300_000,
  deadlineMs,
  signal,
  piRoot = join(homedir(), '.pi', 'agent'),
  image = REVIEW_IMAGE,
  env = process.env,
  beforeEffect,
  probeLandlock = landlockAbiProbe,
  probeDocker = dockerRootlessProbe,
  agyTransport = hostAgyTransport,
  dockerSandbox = stageDockerSandbox,
  snapshotDigestImpl = snapshotDigest,
  worktreeFingerprintImpl = worktreeFingerprint,
  unpack = unpackExact,
  parseAgy = (stream, cwd) => agyStream.parseAgyStream(stream, cwd, { snapshotTools: true }),
  parsePi = parseReviewTranscript,
} = {}) {
  if (mode !== 'read-only') throw new StageDenied('stage_mode_not_read_only');
  if (!isAbsolute(worktree ?? '') || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 ||
      (deadlineMs !== undefined && !Number.isSafeInteger(deadlineMs))) {
    throw new StageDenied('stage_transport_config_invalid');
  }

  // beforeEffect — последняя граница перед запуском модели внутри обоих
  // транспортов (перед docker run и перед beforeConnect model-proxy):
  // отмена в асинхронном окне подготовки не допускает запуска модели.
  const launchGate = async () => {
    if (signal?.aborted) throw signal.reason ?? new StageDenied('stage_aborted');
    return beforeEffect?.();
  };

  const probes = { probeLandlock, probeDocker };
  const enrolled = async model =>
    (await probeStageSandboxCapability(stageTransportKind(model), probes)).enrolled;

  const effectiveTimeout = extra => {
    const limits = [timeoutMs, extra].filter(Number.isSafeInteger);
    if (deadlineMs !== undefined) limits.push(Math.max(0, deadlineMs - Date.now()));
    const ms = Math.min(...limits);
    if (ms < 1000) throw new StageDenied('stage_dispatch_deadline');
    return ms;
  };

  const driftCheck = async (verify, fpBefore) => {
    await verify();
    const fpAfter = await worktreeFingerprintImpl(worktree);
    if (!isDeepStrictEqual(fpAfter, fpBefore)) throw new StageDenied('worktree_drift_during_review');
  };

  const witness = ({ kind, verdict, challenge, artifactDigest, snapshotHash, fingerprint,
    transcript_sha256, checkpoint, actual }) => ({
    mode: 'read-only', transport: kind, snapshotDigest: snapshotHash, worktreeFingerprint: fingerprint,
    challenge, verdict, artifactDigest, transcript_sha256, checkpoint, actual,
  });

  const observeDocker = async ({ binding, model, prompt, challenge, artifactDigest, timeoutMs: callMs }) => {
    const spec = runnerReviewSpec(model);
    if (spec === null || typeof spec.model !== 'string' || !spec.model ||
        !STAGE_EGRESS.has(spec.provider)) throw new StageDenied('stage_model_denied');
    if (!SHA.test(binding?.candidate_sha ?? '')) throw new StageDenied('stage_requires_full_sha');
    // Закреплённый уровень reasoning стадии (router форме 'reasoning'):
    // незакреплённый — проверенный дефолт 'medium', закреплённый — аттестуется
    // фактическим reasoningLevel транскрипта (stage_reasoning_mismatch ниже).
    const effort = model.reasoning ?? 'medium';
    const scratch = await freshScratch(worktree);
    try {
      const source = join(scratch, 'candidate');
      await mkdir(source);
      await chmod(source, 0o755);
      await unpack(worktree, binding.candidate_sha, join(scratch, 'candidate.tar'), source);
      const before = await snapshotDigestImpl(source);
      const fpBefore = await worktreeFingerprintImpl(worktree);

      const cfgDir = join(scratch, 'pi-cfg');
      await mkdir(cfgDir, { mode: 0o700 });
      const credential = await stagePiCredential(piRoot, spec.provider, launchGate);
      await writeFile(join(cfgDir, 'auth.json'), JSON.stringify({ [spec.provider]: credential }),
        { mode: 0o600 });
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
        if (await lstat(src).catch(() => null)) mounts.push({ src, dst: `/pi-ro/${component}` });
      }
      const allow = STAGE_EGRESS.get(spec.provider);
      const env = { NODE_OPTIONS: '--require /tmp/pi-guard.cjs', PI_OFFLINE: '1',
        PI_ALLOW_CONNECT: allow.join(',') };
      const instruction = [
        'Isolated measurement stage. Read-only: no writes, network, shell commands, or editing tools.',
        'The candidate tree is mounted read-only at /candidate - read files directly.',
        prompt,
        '',
        `Challenge: ${challenge}`,
        STAGE_VERDICT_INSTRUCTION,
        `Exact PASS format: ${challenge} PASS`,
      ].join('\n');
      const argv = ['/bin/sh', '-c',
        'mkdir -p /tmp/.pi/agent /tmp/session; ' +
        'for f in bin install npm; do ' +
        '[ -e "/pi-ro/$f" ] && ln -s "/pi-ro/$f" "/tmp/.pi/agent/$f"; done; ' +
        'for f in auth.json settings.json models.json models-store.json; do ' +
        '[ -e "/pi-cfg/$f" ] && cp "/pi-cfg/$f" "/tmp/.pi/agent/$f"; done; ' +
        'cp /pi-guard/pi-guard.cjs /tmp/pi-guard.cjs; ' +
        'exec /pi-ro/bin/pi "$@"', 'pi',
        '--print', '--mode', 'json',
        '--provider', spec.provider, '--model', spec.model,
        '--thinking', effort,
        '--no-mcp', '--no-extensions', '--no-skills', '--no-context-files',
        '--no-approve', '--tools', 'read,grep,find,ls',
        '--session-dir', '/tmp/session', instruction];

      let run;
      try {
        // Отменённый до запуска вызов не запускает модель: причина аборта —
        // до любого дочернего процесса.
        if (signal?.aborted) throw signal.reason ?? new StageDenied('stage_aborted');
        // Остановка активного контейнера по сигналу: уникальный cfgDir
        // (mkdtemp) идентифицирует ровно этот запуск — rm -f завершает
        // docker run, cleanup выполняет finally самого раннера. Опрос
        // повторяется: сигнал может прийти в окне между docker info и
        // созданием контейнера, пока фильтру ещё нечего найти.
        const stopRun = async () => {
          for (let poll = 0; poll < 8; poll++) {
            try {
              const { stdout: ps } = await exec('docker',
                ['ps', '-aq', '--filter', `volume=${cfgDir}`], { timeout: 10_000 });
              const ids = ps.split('\n').map(line => line.trim()).filter(Boolean);
              if (ids.length) {
                for (const id of ids) {
                  await exec('docker', ['rm', '-f', id], { timeout: 15_000 }).catch(() => {});
                }
                return;
              }
            } catch { /* docker недоступен — timeoutMs раннера остаётся границей */ }
            await new Promise(resolve => setTimeout(resolve, 400));
          }
        };
        run = await settleWithAbort(dockerSandbox({ snapshot: source, argv, image, env, mounts,
          allow, timeoutMs: effectiveTimeout(callMs), beforeEffect: launchGate, signal }), signal, stopRun);
      } finally {
        await driftCheck(async () => {
          const after = await snapshotDigestImpl(source);
          if (after.digest !== before.digest || after.files !== before.files) {
            throw new StageDenied('snapshot_mutated');
          }
        }, fpBefore);
      }
      const transcript = String(run.stdout ?? '');
      const transcript_sha256 = sha256(transcript);
      const parsed = parsePi(transcript);
      for (const key of ['provider', 'model']) {
        if (parsed.actual[key] !== spec[key]) throw new StageDenied(`stage_${key}_mismatch`);
      }
      const effortRank = Object.hasOwn(REASONING_RANK, effort) ? REASONING_RANK[effort] : undefined;
      const actualRank = Object.hasOwn(REASONING_RANK, parsed.actual.reasoningLevel) ?
        REASONING_RANK[parsed.actual.reasoningLevel] : undefined;
      if (effortRank === undefined || actualRank === undefined || actualRank < effortRank) {
        throw new StageDenied('stage_reasoning_mismatch');
      }
      assertToolsAllowed(parsed.toolsAdded);
      const verdict = stageVerdictLine(parsed.finalText, challenge);
      if (run.code !== 0) throw new StageDenied(`stage_runner_exit:${run.code ?? 'timeout'}`);
      const name = `stage-${binding.task_id}-${binding.candidate_sha}-${randomUUID()}.ndjson`;
      if (journal !== undefined) {
        await writeFile(join(journal, name), transcript, { flag: 'wx', mode: 0o600 });
      }
      return { verdict, transcript_file: journal === undefined ? null : name,
        witness: witness({ kind: 'docker-ro-v1', verdict, challenge, artifactDigest,
          snapshotHash: before.digest, fingerprint: await worktreeFingerprintImpl(worktree),
          transcript_sha256, checkpoint: transcript_sha256.slice(0, 32), actual: parsed.actual }) };
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  };

  const observeLandlock = async ({ binding, model, prompt, challenge, artifactDigest, timeoutMs: callMs }) => {
    if (!SHA.test(binding?.candidate_sha ?? '')) throw new StageDenied('stage_requires_full_sha');
    // agy-stream исполняет жёстко '--effort medium' и аттестует фактический
    // reasoningLevel='medium'. Закреплённый спек с другим уровнем отклоняется
    // ДО запуска: транспорт не исполняет неподдерживаемый уровень молча.
    const effort = model.reasoning ?? 'medium';
    if (effort !== 'medium') throw new StageDenied('stage_reasoning_unsupported');
    const scratch = await freshScratch(worktree);
    try {
      const staged = join(scratch, 'staged');
      const view = join(scratch, 'review');
      const source = join(staged, 'candidate');
      await mkdir(source, { recursive: true });
      await unpack(worktree, binding.candidate_sha, join(scratch, 'candidate.tar'), source);
      await mkdir(view, { mode: 0o500 });
      const fingerprint = await snapshotDigestImpl(staged);
      const fpBefore = await worktreeFingerprintImpl(worktree);
      let published = false;
      const snapshot = {
        view,
        async publish() {
          if (published) throw new StageDenied('stage_snapshot_already_published');
          await chmod(view, 0o700);
          try {
            await rename(source, join(view, 'candidate'));
            published = true;
          } finally { await chmod(view, 0o500); }
        },
      };
      const instruction = [
        prompt,
        'Candidate files are available read-only under candidate/ - inspect them with read-only tools (read_file, grep_search, find_by_name, list_dir).',
        `Challenge: ${challenge}`,
        STAGE_VERDICT_INSTRUCTION,
        `Exact PASS format: ${challenge} PASS`,
      ].join('\n\n');
      let live;
      try {
        // Отменённый до запуска вызов не запускает модель.
        if (signal?.aborted) throw signal.reason ?? new StageDenied('stage_aborted');
        // Остановка активного agy-процесса по сигналу: уникальный scratch-путь
        // (mkdtemp) этого запуска ищется в /proc/*/cmdline и environ — так
        // процесс находится и после того, как launcher заменил себя через
        // execv (agy-landlock.py больше нет в argv). Группа процесса
        // добивается SIGKILL; cleanup выполняет сам транспорт.
        const stopRun = () => killProcessGroupByMarker(scratch);
        live = await settleWithAbort(agyTransport({ prompt: instruction, snapshot: view,
          publishSnapshot: snapshot.publish, timeoutMs: effectiveTimeout(callMs), env,
          beforeEffect: launchGate, signal }), signal, stopRun);
      } finally {
        await driftCheck(async () => {
          if (!isDeepStrictEqual(await snapshotDigestImpl(published ? view : staged), fingerprint)) {
            throw new StageDenied('snapshot_mutated');
          }
        }, fpBefore);
      }
      if (live.code !== 0) {
        const reason = String(live.stderr ?? '').split('\n')
          .find(line => /^(?:agy_[a-z_]+|review_tool_use_forbidden)$/.test(line));
        throw new StageDenied(reason ?? 'agy_transport_failed');
      }
      if (!published || live.cwd !== view) throw new StageDenied('agy_init_unattested');
      const observed = parseAgy(live.stdout, view);
      if (observed.actual?.reasoningLevel !== 'medium') throw new StageDenied('stage_reasoning_mismatch');
      const verdict = stageVerdictLine(observed.text, challenge);
      const transcript = JSON.stringify({ evidence: observed.evidence, actual: observed.actual,
        requestSha256: sha256(instruction), reads: observed.verifiedReads, stream: live.stdout });
      const transcript_sha256 = sha256(transcript);
      const name = `stage-agy-${binding.task_id}-${binding.candidate_sha}-${randomUUID()}.json`;
      if (journal !== undefined) {
        await writeFile(join(journal, name), transcript, { flag: 'wx', mode: 0o600 });
      }
      return { verdict, transcript_file: journal === undefined ? null : name,
        witness: witness({ kind: 'landlock-ro-v1', verdict, challenge, artifactDigest,
          snapshotHash: fingerprint.digest, fingerprint: await worktreeFingerprintImpl(worktree),
          transcript_sha256, checkpoint: transcript_sha256.slice(0, 32), actual: observed.actual }) };
    } finally {
      await chmod(join(scratch, 'review'), 0o700).catch(cause => { if (cause.code !== 'ENOENT') throw cause; });
      await rm(scratch, { recursive: true, force: true });
    }
  };

  return Object.freeze({
    mode: 'read-only',
    // Криптографически подтверждённый допуск: true только когда живая проба
    // контура (Landlock ABI>=4 или rootless Docker) подтвердила enrolment.
    assertReadOnly: model => enrolled(model),
    async observe({ binding, model, prompt, challenge, artifactDigest, mode: requestMode = 'read-only',
      timeoutMs: callMs }) {
      if (mode !== 'read-only' || requestMode !== 'read-only') {
        throw new StageDenied('stage_mode_not_read_only');
      }
      if (typeof prompt !== 'string' || !prompt.trim() || !DIGEST.test(challenge ?? '') ||
          !DIGEST.test(artifactDigest ?? '')) throw new StageDenied('stage_request_invalid');
      // Отменённый вызов не запускает модель: причина аборта — до проб и
      // любых дочерних процессов.
      if (signal?.aborted) throw signal.reason ?? new StageDenied('stage_aborted');
      const kind = stageTransportKind(model);
      if (!await probeStageSandboxCapability(kind, probes).then(r => r.enrolled)) {
        throw new StageDenied('stage_read_only_transport_not_enrolled');
      }
      const request = { binding, model, prompt, challenge, artifactDigest, timeoutMs: callMs };
      return await (kind === 'landlock-ro-v1' ? observeLandlock(request) : observeDocker(request));
    },
  });
}

// Отдельная точка наблюдения Stage поверх созданного транспорта.
export async function observeStageInSandbox(request, transport) {
  if (typeof transport?.observe !== 'function') throw new StageDenied('stage_transport_unknown');
  return await transport.observe(request);
}

// Подтверждённый read-only допуск конкретной модели: true только при
// успешной живой пробе контура. Любой отказ — false (fail-closed вызывающему).
export async function assertStageReadOnly(transport, model) {
  if (typeof transport?.assertReadOnly !== 'function') return false;
  try {
    return await transport.assertReadOnly(model) === true;
  } catch (cause) {
    if (cause instanceof StageDenied && cause.reason !== 'stage_model_denied') return false;
    throw cause;
  }
}
