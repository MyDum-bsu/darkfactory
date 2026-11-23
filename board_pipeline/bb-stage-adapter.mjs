import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { open, realpath, lstat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { artifactVerdict } from './stage-verifier.mjs';
import { canonicalDigest } from './subject.mjs';
import { opencodeGoPolicyViolation, retiredProviderViolation } from './worker-selector.mjs';
import { syncDir } from './slot.mjs';

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
  { assertCurrent, assertReadOnly, readArtifact, record, recordWitness, execBb = invokeBb }) {
  if (!/^proj_[a-z0-9]+$/.test(project ?? '') || !BB_ID.test(parentThread ?? '') ||
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
    const [provider, model] = stageActor(request.model);
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
      if (typeof assertReadOnly !== 'function' || await assertReadOnly({ workspace, project, provider, model }) !== true) {
        throw new Error('stage_read_only_transport_not_enrolled');
      }
      if (deadline - Date.now() < 5000) throw new Error('stage_dispatch_deadline');
    };
    await checkTransport();
    const prompt = await durableIntent(journal, key, text);
    const argv = ['thread', 'spawn', '--project', project, '--environment', workspace, '--parent-thread', parentThread,
      '--parent-notifications', 'off', '--provider', provider, '--model', model, '--permission-mode', 'accept-edits',
      '--title', 'VS-5.2 stage', '--prompt-file', prompt, '--json'];
    if (request.model.reasoning !== null) argv.push('--reasoning-level', request.model.reasoning);
    await assertCurrent(request.binding);
    await checkTransport();
    const spawned = await run(argv, Math.min(35_000, deadline - Date.now()));
    if (!BB_ID.test(spawned?.id ?? '')) throw new Error('stage_spawn_unconfirmed');
    await record({ threadId: spawned.id, stage: request.stage, role: request.role, taskId: request.binding.task_id, model: request.model });
    try {
      const seconds = Math.min(maxSeconds, Math.floor((deadline - Date.now()) / 1000));
      if (seconds < 1) throw new Error('stage_dispatch_deadline');
      await run(['thread', 'wait', '--status', 'idle', '--timeout', `${seconds}s`, spawned.id, '--json'], (seconds + 5) * 1000);
    }
    catch (cause) {
      // Stop is cleanup of an already-launched, specifically identified child,
      // not progression of the attempt; it remains needed after gate loss.
      const current = await run(['thread', 'show', spawned.id, '--json']);
      if (current.thread?.parentThreadId === parentThread && current.thread?.projectId === project &&
          current.environment?.path === workspace && current.thread?.id === spawned.id) {
        await execBb(['thread', 'stop', spawned.id], { timeout: 12_000 });
      }
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
  };
}
