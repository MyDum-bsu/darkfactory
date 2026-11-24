import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { open, realpath, lstat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { artifactVerdict } from './stage-verifier.mjs';
import { canonicalDigest } from './subject.mjs';
import { opencodeGoPolicyViolation, retiredProviderViolation } from './worker-selector.mjs';
import { syncDir } from './slot.mjs';
import { assertStageReadOnly, createStageSandboxTransport } from './stage-sandbox-transport.mjs';

const exec = promisify(execFile);
const BB_ID = /^thr_[a-z0-9]+$/;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const invokeBb = (argv, opts) => exec('bb', argv, opts);

function stageActor(spec) {
  if (retiredProviderViolation(spec) || opencodeGoPolicyViolation(spec)) throw new Error('stage_model_denied');
  if (spec?.provider === 'openai' && spec.model === 'gpt-6.2-sol') return ['pi', `openai/${spec.model}`];
  if (spec?.provider === 'google' && spec.model === 'gemini-4-neon') return ['acp-antigravity-acp', spec.model];
  if (spec?.provider === 'pi' && /^(?:opencode-go\/deepseek-[a-z0-9.-]+|openai\/gpt-6\.2-sol)$/.test(spec.model)) {
    return ['pi', spec.model];
  }
  throw new Error('stage_model_denied');
}

async function durableIntent(dir, key, text) {
  const path = join(dir, `stage-${key}.md`);
  let fd;
  try { fd = await open(path, 'wx', 0o600); }
  catch (cause) { throw new Error('stage_intent_already_exists_or_unwritable', { cause }); }
  try { await fd.writeFile(text); await fd.sync(); }
  finally { await fd.close(); }
  await syncDir(dir);
  return path;
}

export function matchesNativeStageWitness(witness, native) {
  return Number.isSafeInteger(native?.eventSeq) && native.eventSeq > 0 &&
    typeof native.session === 'string' && !!native.session && typeof native.checkpoint === 'string' && !!native.checkpoint &&
    witness?.eventSeq === native.eventSeq && witness.session === native.session && witness.checkpoint === native.checkpoint;
}

export function pilotWriterWorkspaceReady(snapshot, { threadId, parentThread, project, workspace }) {
  const { thread, environment } = snapshot ?? {};
  if (thread?.id !== threadId || thread.parentThreadId !== parentThread || thread.projectId !== project) {
    throw new Error('ab_pilot_writer_identity_drift');
  }
  if (environment?.path === workspace) return true;
  // No handoff, verify or side effects while BB is still allocating the env.
  if (thread.status === 'starting' && (environment?.path == null)) return false;
  throw new Error('BB workspace changed');
}

// Общий grace-ожидание ready для ЛЮБОГО режима (B2): parentThread опционален
// — вне пилота родитель не закреплён и не проверяется; переданный —
// обязателен. 'starting' без environment.path — wait-only тик (false), а не
// падение 'BB workspace changed'; подтверждённый drift — writer_identity_drift.
export function writerWorkspaceReady(snapshot, { threadId, parentThread, project, workspace }) {
  const { thread, environment } = snapshot ?? {};
  if (thread?.id !== threadId ||
      (project !== undefined && thread?.projectId !== undefined && thread.projectId !== project) ||
      (parentThread !== undefined && thread.parentThreadId !== parentThread)) {
    throw new Error('writer_identity_drift');
  }
  if (environment?.path === workspace) return true;
  if (thread.status === 'starting' && (environment?.path == null)) return false;
  throw new Error('BB workspace changed');
}

export function verifyBbStageTurn({ snapshot, events, threadId, parentThread, project, workspace, provider,
  model, reasoning, challenge, promptText }) {
  const { thread, environment } = snapshot ?? {};
  if (thread?.id !== threadId || thread.parentThreadId !== parentThread || thread.projectId !== project ||
      thread.providerId !== provider || thread.status !== 'idle' || thread.activeBackgroundAgentCount !== 0 ||
      thread.queuedMessageCount !== 0 || environment?.path !== workspace || !Array.isArray(events)) {
    throw new Error('stage_bb_unconfirmed');
  }
  if (events.some((e, i) => e?.threadId !== threadId || !Number.isSafeInteger(e.seq) || (i > 0 && e.seq <= events[i - 1].seq))) {
    throw new Error('stage_log_unconfirmed');
  }
  const requested = events.filter(e => e.type === 'client/turn/requested');
  const identities = events.filter(e => e.type === 'thread/identity');
  const started = events.filter(e => e.type === 'turn/started');
  const finished = events.filter(e => e.type === 'turn/completed');
  const request = requested[0], start = started[0], end = finished[0], identity = identities[0];
  const session = end?.data?.providerThreadId;
  const checkpoint = end?.data?.providerCheckpointId;
  if (requested.length !== 1 || identities.length !== 1 || started.length !== 1 || finished.length !== 1 ||
      !(request.seq < identity.seq && identity.seq < start.seq && start.seq < end.seq) ||
      typeof session !== 'string' || !session || typeof checkpoint !== 'string' || !checkpoint ||
      identity.data?.providerThreadId !== session || start.data?.providerThreadId !== session ||
      end.data.status !== 'completed' || typeof end.scope?.turnId !== 'string' || !end.scope.turnId ||
      start.scope?.turnId !== end.scope.turnId || request.data?.execution?.model !== model ||
      request.data.execution.permissionMode !== 'accept-edits' ||
      (reasoning !== null && request.data.execution.reasoningLevel !== reasoning) ||
      typeof promptText !== 'string' || !Array.isArray(request.data.input) || request.data.input.length !== 1 ||
      request.data.input[0]?.type !== 'text' || typeof request.data.input[0].text !== 'string' ||
      request.data.input[0].text.trim() !== promptText.trim()) throw new Error('stage_turn_unconfirmed');
  const items = events.filter(e => ['item/started', 'item/completed'].includes(e.type));
  if (items.some(e => e.seq <= start.seq || e.seq >= end.seq || e.scope?.turnId !== end.scope.turnId ||
      e.data?.providerThreadId !== session || !['agentMessage', 'reasoning'].includes(e.data?.item?.type))) {
    throw new Error('stage_unexpected_tool_use');
  }
  const final = items.findLast(e => e.type === 'item/completed' && e.data.item.type === 'agentMessage');
  const response = final?.data.item.text;
  // No markdown, tools, commands or arbitrary claims are taken from a stage.
  const receipt = typeof response === 'string' && /^\s*([a-f0-9]{64}) (PASS|REWORK|BLOCKED)\s*$/.exec(response);
  if (!receipt || receipt[1] !== challenge) throw new Error('stage_verdict_unconfirmed');
  return { verdict: receipt[2], eventSeq: end.seq, checkpoint, session };
}

export async function createBbStageObserver({ project, workspace, parentThread, journal, deadline, maxSeconds = 120 },
  { assertCurrent, assertReadOnly, readArtifact, record, recordWitness, execBb = invokeBb,
    sandboxTransport, sandboxOptions, phaseBudget, signals }) {
  // Аттестованный read-only транспорт: явный sandboxTransport либо
  // sandboxOptions { mode:'read-only', worktree } — создаётся здесь и живёт
  // столько же, сколько наблюдатель. Без него остаётся host-путь bb spawn.
  if (sandboxTransport === undefined && sandboxOptions?.mode === 'read-only' &&
      isAbsolute(sandboxOptions.worktree ?? '')) {
    sandboxTransport = createStageSandboxTransport({ ...sandboxOptions, journal,
      deadlineMs: deadline, signal: signals?.signal });
  }
  if (!/^proj_[a-z0-9]+$/.test(project ?? '') ||
      (sandboxTransport === undefined && !BB_ID.test(parentThread ?? '')) ||
      !isAbsolute(workspace ?? '') || !isAbsolute(journal ?? '') ||
      !Number.isSafeInteger(deadline) || !Number.isSafeInteger(maxSeconds) || maxSeconds < 5 || maxSeconds > 180 ||
      typeof assertCurrent !== 'function' || typeof readArtifact !== 'function' ||
      typeof record !== 'function' || typeof recordWitness !== 'function') {
    throw new Error('stage_operator_config_invalid');
  }
  const st = await lstat(journal);
  if (await realpath(journal) !== journal || !st.isDirectory() || st.uid !== process.getuid() || st.mode & 0o077 ||
      workspace === journal || await realpath(workspace) !== workspace) throw new Error('stage_operator_config_invalid');
  const run = async (argv, timeout = 8000) => JSON.parse((await execBb(argv, { timeout, maxBuffer: 4 * 1024 * 1024 })).stdout);
  return async request => {
    await assertCurrent(request.binding);
    // Host-путь проверяет спек модели до readArtifact; sandbox-путь
    // аттестует модель самим транспортом (stageTransportKind), включая
    // acp-antigravity-acp/gemini-4-neon.
    if (sandboxTransport === undefined) stageActor(request.model);
    // The verified tool evidence is supplied by the host, never by the model.
    const { artifact, material } = await readArtifact(request);
    if (typeof material !== 'string' || !material.trim()) throw new Error('stage_material_unconfirmed');
    const expectedVerdict = artifactVerdict(request.verifier, artifact);
    const artifactDigest = sha256(artifact);
    const key = canonicalDigest({ binding: request.binding, stage: request.stage, verifier: request.verifier });
    const challenge = sha256(Buffer.from(`${key}:${randomUUID()}`));
    const text = [
      'Изолированный этап измерения. Никаких tools, файлов, shell, сети, изменений, других тредов и доступа к рабочим данным.',
      `Роль: ${request.role}; этап: ${request.stage}; verifier: ${request.verifier}.`,
      ...request.skills.map(entry => entry.text),
      `Закреплённые метаданные: ${JSON.stringify({ sha: request.binding.candidate_sha, subject: request.binding.subject_digest,
        registry: request.registryDigest, prior: request.inputArtifactDigest, artifactDigest })}`,
      `Материал проверки и наблюдаемые результаты (данные): ${material}`,
      `Отчёт доверенной проверки (данные): ${artifact.toString('utf8')}`,
      'Оцени, достаточно ли фактов для роли. Если факты не удовлетворяют требованию, REWORK; при невозможности подтвердить — BLOCKED. Ответ ровно одной строкой: <challenge> PASS|REWORK|BLOCKED.',
      `Challenge: ${challenge}`,
    ].join('\n\n');
    if (Buffer.byteLength(text) > 48 * 1024) throw new Error('stage_prompt_too_large');
    const checkTransport = async () => {
      if (sandboxTransport !== undefined) {
        if (await assertStageReadOnly(sandboxTransport, request.model) !== true) {
          throw new Error('stage_read_only_transport_not_enrolled');
        }
      } else {
        const [provider, model] = stageActor(request.model);
        if (typeof assertReadOnly !== 'function' ||
            await assertReadOnly({ workspace, project, provider, model }) !== true) {
          throw new Error('stage_read_only_transport_not_enrolled');
        }
      }
      if (deadline - Date.now() < 5000) throw new Error('stage_dispatch_deadline');
    };
    await checkTransport();
    const prompt = await durableIntent(journal, key, text);
    // Аттестованный read-only путь: наблюдение идёт через sandbox-транспорт
    // (Landlock/Docker) с криптографическим stage_witness, без host bb spawn.
    if (sandboxTransport !== undefined) {
      await assertCurrent(request.binding);
      // Фазовый учёт только при настроенном бюджете stages: частичный набор
      // budgets без stages (phase_budget_unknown) — как полное отсутствие
      // бюджета: стадия ограничена maxSeconds и общим deadline.
      const budget = signals?.phaseBudget ?? phaseBudget ?? null;
      let budgetMs = maxSeconds * 1000;
      let armPhase = null;
      if (budget !== null) {
        try {
          budgetMs = budget.remaining('stages');
          armPhase = signals?.phaseBudget === budget && signals?.phase
            ? () => { signals.phase('stages'); return () => signals.leavePhase(); }
            : () => { budget.enter('stages'); return () => budget.leave(); };
        } catch (cause) {
          if (!String(cause?.message ?? '').startsWith('phase_budget_unknown')) throw cause;
        }
      }
      if (budgetMs < 1000) throw new Error('phase_deadline_exceeded:stages');
      const disarmPhase = armPhase?.() ?? null;
      try {
        const observed = await sandboxTransport.observe({ binding: request.binding,
          model: request.model, prompt: text, challenge, artifactDigest,
          timeoutMs: Math.min(maxSeconds * 1000, budgetMs, Math.max(0, deadline - Date.now())) });
        await assertCurrent(request.binding);
        if (observed.verdict !== 'BLOCKED' && observed.verdict !== expectedVerdict) {
          throw new Error('stage_artifact_disputed');
        }
        await recordWitness({ threadId: `sandbox:${observed.witness.transport}`,
          stage: request.stage, artifactDigest, ...observed.witness });
        return { binding: request.binding, registryDigest: request.registryDigest, playbook: request.playbook,
          stage: request.stage, verifier: request.verifier, model: request.model,
          inputArtifactDigest: request.inputArtifactDigest, verdict: observed.verdict, artifact, artifactDigest,
          witness: observed.witness };
      } finally {
        disarmPhase?.();
      }
    }
    // Host-путь требует закреплённого parent-треда и bb-спеки модели.
    const [provider, model] = stageActor(request.model);
    const argv = ['thread', 'spawn', '--project', project, '--environment', workspace, '--parent-thread', parentThread,
      '--parent-notifications', 'off', '--provider', provider, '--model', model, '--permission-mode', 'accept-edits',
      '--title', 'VS-5.2 stage', '--prompt-file', prompt, '--json'];
    if (request.model.reasoning !== null) argv.push('--reasoning-level', request.model.reasoning);
    await assertCurrent(request.binding);
    await checkTransport();
    // Отменённый до spawn вызов не запускает дочерний тред.
    if (signals?.signal?.aborted) throw signals.signal.reason ?? new Error('stage_aborted');
    // Отказ thread stop не подавляется молча: одна повторная попытка, затем
    // фиксация факта возможно живого дочернего треда.
    const stopThread = async id => {
      try {
        await execBb(['thread', 'stop', id], { timeout: 12_000 });
      } catch (first) {
        try {
          await execBb(['thread', 'stop', id], { timeout: 12_000 });
        } catch (second) {
          console.error(JSON.stringify({ kind: 'stage_stop_unconfirmed', threadId: id,
            error: String(second?.message ?? second) }));
        }
      }
    };
    // Подтверждение spawn потеряно (обрыв/таймаут CLI) — дочерний тред мог
    // быть создан. Read-only сверка без жёсткого лимита кандидатов:
    // показанные show атрибуты нашего треда (parent, project, environment
    // workspace или ещё не назначено) И уникальный challenge этого запуска
    // в логе треда — двойное совпадение доказывает, что это наш потерянный
    // spawn. Соседний тред под теми же parent/project/workspace, но без
    // маркера этого запуска, никогда не останавливается.
    const stopLostSpawn = async () => {
      const args = ['thread', 'list', '--json'];
      if (project) args.push('--project', project);
      const listed = JSON.parse((await execBb(args, { timeout: 15_000 })).stdout);
      const items = Array.isArray(listed) ? listed : (Array.isArray(listed?.threads) ? listed.threads : []);
      for (const item of items) {
        if (!BB_ID.test(item?.id ?? '')) continue;
        if (item.parentThreadId !== undefined && item.parentThreadId !== parentThread) continue;
        if (item.environmentPath !== undefined && item.environmentPath !== workspace) continue;
        let current = null;
        try { current = await run(['thread', 'show', item.id, '--json']); } catch { continue; }
        if (current?.thread?.parentThreadId !== parentThread || current?.thread?.projectId !== project ||
            !(current?.environment === null || current?.environment === undefined ||
              current?.environment?.path === workspace)) continue;
        // Маркер доказывает запуск только в ПЕРВОМ запросе на старт треда
        // (исходный spawn): поздний tell тоже создаёт client/turn/requested
        // и может цитировать challenge — не подтверждение нашего запуска.
        let events = null;
        try { events = await run(['thread', 'log', item.id, '--all', '--json']); } catch { continue; }
        const entries = Array.isArray(events) ? events : (Array.isArray(events?.events) ? events.events : []);
        const first = entries.filter(entry => entry?.type === 'client/turn/requested')
          .reduce((min, entry) => (min === null ||
              (Number.isSafeInteger(entry.seq) && entry.seq < min.seq) ? entry : min), null);
        if (!first || !JSON.stringify(first.data?.input ?? first.data ?? null).includes(challenge)) continue;
        await stopThread(item.id);
      }
    };
    let spawned;
    try {
      spawned = await run(argv, Math.min(35_000, deadline - Date.now()));
    } catch (cause) {
      await stopLostSpawn().catch(() => {});
      throw cause;
    }
    if (!BB_ID.test(spawned?.id ?? '')) {
      await stopLostSpawn().catch(() => {});
      throw new Error('stage_spawn_unconfirmed');
    }
    // Stop is cleanup of an already-launched, specifically identified child,
    // not progression of the attempt; it remains needed after gate loss.
    // Сбой промежуточного thread show не отменяет остановку: spawned.id —
    // наш подтверждённый дочерний тред, осиротевших процессов быть не должно.
    // environment ещё не назначено (null, статус starting) — тоже наш тред.
    const stopSpawned = async () => {
      let current = null;
      try { current = await run(['thread', 'show', spawned.id, '--json']); } catch { /* show недоступен */ }
      if (current === null ||
          (current.thread?.parentThreadId === parentThread && current.thread?.projectId === project &&
          (current.environment === null || current.environment === undefined ||
            current.environment?.path === workspace) &&
          current.thread?.id === spawned.id)) {
        await stopThread(spawned.id);
      }
    };
    try {
      await record({ threadId: spawned.id, stage: request.stage, role: request.role,
        taskId: request.binding.task_id, model: request.model });
      try {
        const seconds = Math.min(maxSeconds, Math.floor((deadline - Date.now()) / 1000));
        if (seconds < 1) throw new Error('stage_dispatch_deadline');
        const waiting = run(['thread', 'wait', '--status', 'idle', '--timeout', `${seconds}s`,
          spawned.id, '--json'], (seconds + 5) * 1000);
        const sig = signals?.signal;
        if (sig === undefined || sig === null) await waiting;
        else await new Promise((resolve, reject) => {
          const onAbort = () => Promise.resolve(stopSpawned()).catch(() => {})
            .finally(() => reject(sig.reason ?? new Error('stage_aborted')));
          if (sig.aborted) return void onAbort();
          sig.addEventListener('abort', onAbort, { once: true });
          waiting.then(value => { sig.removeEventListener('abort', onAbort); resolve(value); },
            cause => { sig.removeEventListener('abort', onAbort); reject(cause); });
        });
      }
      catch (cause) {
        // Приоритет сигнала отмены: обрыв wait по kill-switch/lease/дедлайну
        // отражается исходной причиной, а не обёрткой.
        if (signals?.signal?.aborted) throw signals.signal.reason ?? cause;
        throw new Error('stage_wait_unconfirmed', { cause });
      }
      const snapshot = await run(['thread', 'show', spawned.id, '--json']);
      const events = await run(['thread', 'log', spawned.id, '--all', '--json']);
      const witness = verifyBbStageTurn({ snapshot, events, threadId: spawned.id, parentThread,
        project, workspace, provider, model, reasoning: request.model.reasoning, challenge, promptText: text });
      await assertCurrent(request.binding);
      if (witness.verdict !== 'BLOCKED' && witness.verdict !== expectedVerdict) throw new Error('stage_artifact_disputed');
      await recordWitness({ threadId: spawned.id, stage: request.stage, artifactDigest, ...witness });
      const { verdict } = witness;
      return { binding: request.binding, registryDigest: request.registryDigest, playbook: request.playbook,
        stage: request.stage, verifier: request.verifier, model: request.model,
        inputArtifactDigest: request.inputArtifactDigest, verdict, artifact, artifactDigest };
    }
    catch (error) {
      // Любой сбой после подтверждённого spawn (record, wait, show/log,
      // сверка, recordWitness) останавливает дочерний тред: 0 осиротевших.
      await stopSpawned();
      throw error;
    }
  };
}
