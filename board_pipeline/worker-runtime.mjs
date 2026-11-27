import { execFile, spawn as nodeSpawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile as readFileDefault } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const execFileAsync = promisify(execFile);
const TAIL_LIMIT = 8192;
const MAX_TERMINAL_SUBPROC_SESSIONS = 32;
// Короткое подтверждение фактического выхода процесса после сигнала: SIGTERM
// даёт писателю шанс завершиться штатно, SIGKILL — uncatchable, его ожидание
// строго короче. stopped: true выписывается только по событию exit, не по
// факту отправки сигнала.
export const SUBPROC_STOP_TERM_GRACE_MS = 1500;
export const SUBPROC_STOP_KILL_GRACE_MS = 1000;

export const EXECUTOR_COMMANDS = Object.freeze({
  'acp-devin': 'devin',
  pi: 'pi',
  'acp-antigravity-acp': 'agy',
  agy: 'agy',
});

function fail(code) { throw new Error(code); }

function text(value, code) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) fail(code);
  return value;
}

function token(value, code) {
  if (typeof value !== 'string' || !/^[^\s\x00-\x1f\x7f]+$/.test(value)) fail(code);
  return value;
}

function absolutePath(value, code) {
  if (typeof value !== 'string' || !value || value.includes('\0') || !isAbsolute(value)) fail(code);
  return value;
}

export function normalizeExecutor(executor) {
  let source = executor;
  if (typeof source === 'string') {
    const slash = source.indexOf('/');
    source = slash < 0 ? { provider: source } : { provider: source.slice(0, slash), model: source.slice(slash + 1) };
  }
  if (source === null || typeof source !== 'object' || Array.isArray(source)) fail('executor_invalid');
  const provider = token(source.provider, 'executor_invalid');
  const command = EXECUTOR_COMMANDS[provider];
  if (command === undefined) fail('executor_unsupported');
  const model = token(source.model, 'executor_model_invalid');
  const effort = source.effort ?? source.reasoningLevel;
  return Object.freeze({ provider, command, model,
    ...(effort === undefined ? {} : { effort: token(effort, 'executor_effort_invalid') }) });
}

function validatePermissionMode(permissionMode) {
  if (permissionMode === undefined) return undefined;
  if (!['full', 'accept-edits'].includes(permissionMode)) fail('permission_mode_invalid');
  return permissionMode;
}

function permissionArguments(spec, permissionMode) {
  const mode = validatePermissionMode(permissionMode);
  if (mode === undefined) return [];
  if (spec.command === 'devin') {
    return ['--permission-mode', mode === 'full' ? 'dangerous' : 'accept-edits',
      '--respect-workspace-trust', 'false'];
  }
  if (spec.command === 'agy') {
    return mode === 'full' ? ['--dangerously-skip-permissions'] : ['--mode', 'accept-edits'];
  }
  return [];
}

function promptArguments(spec, { prompt, promptFile } = {}) {
  if (spec.command === 'devin' && promptFile !== undefined) {
    return ['--prompt-file', text(promptFile, 'prompt_file_invalid')];
  }
  return ['--', text(prompt, 'worker_prompt_invalid')];
}

function effortArguments(spec) {
  if (spec.command === 'pi' && spec.effort !== undefined) return ['--thinking', spec.effort];
  if (spec.command === 'agy' && spec.effort !== undefined) return ['--effort', spec.effort];
  return [];
}

export function buildExecutorCommand(executor, { prompt, promptFile, permissionMode,
  interactive = true, followUp = false } = {}) {
  const spec = normalizeExecutor(executor);
  const argv = ['--model', spec.model, ...effortArguments(spec),
    ...permissionArguments(spec, permissionMode)];
  if (interactive) {
    if (spec.command === 'agy') argv.push('--prompt-interactive');
  } else {
    if (followUp) argv.push('--continue');
    argv.push('--print');
  }
  argv.push(...promptArguments(spec, { prompt, promptFile }));
  return Object.freeze({ command: spec.command, argv: Object.freeze(argv), executor: spec });
}

export function buildResumeCommand(executor, { sessionId, prompt, promptFile, permissionMode,
  interactive = true } = {}) {
  const spec = normalizeExecutor(executor);
  const argv = ['--model', spec.model, ...effortArguments(spec),
    ...permissionArguments(spec, permissionMode)];
  if (spec.command === 'devin') {
    if (sessionId !== undefined) argv.push('-r', token(sessionId, 'session_id_invalid'));
  } else if (spec.command === 'pi') {
    argv.push('--continue');
  } else if (spec.command === 'agy') {
    if (sessionId === undefined) argv.push('--continue');
    else argv.push('--resume', token(sessionId, 'session_id_invalid'));
  }
  if (interactive) {
    if (spec.command === 'agy') argv.push('--prompt-interactive');
  } else {
    argv.push('--print');
  }
  argv.push(...promptArguments(spec, { prompt, promptFile }));
  return Object.freeze({ command: spec.command, argv: Object.freeze(argv), executor: spec });
}

export function buildFollowUpMessage({ taskId, attemptId, message }) {
  return 'Darkfactory structured follow-up turn.\n' +
    `task_id: ${token(taskId, 'task_id_invalid')}\n` +
    `attempt_id: ${token(attemptId, 'attempt_id_invalid')}\n\n` +
    `${text(message, 'feedback_message_invalid')}\n`;
}

function parseJson(result, code) {
  const stdout = typeof result === 'string' ? result : result?.stdout;
  try {
    return JSON.parse(String(stdout ?? '').trim());
  } catch {
    fail(code);
  }
}

function confirmedProbeRefusal(reason) {
  return { status: 'confirmed_refusal', activeBackgroundAgentCount: 0, reason };
}

function probeFailure(command, error) {
  const detail = `${error?.stderr ?? ''}\n${error?.message ?? ''}`.toLowerCase();
  if (error?.code === 'ENOENT' || error?.errno === 'ENOENT' || detail.includes('not found')) {
    return confirmedProbeRefusal(`${command}_not_found`);
  }
  if (typeof error?.code === 'number') return confirmedProbeRefusal(`${command}_probe_failed`);
  return { status: 'unknown_outcome', reason: `${command}_probe_unknown` };
}

function appendTail(session, chunk) {
  session.tail = `${session.tail}${chunk}`.slice(-TAIL_LIMIT);
}

export function isWorkerThreadId(value) {
  return typeof value === 'string' &&
    /^(?:thr_[a-z0-9]+|df-[a-z0-9_-]{1,12}-[a-f0-9]{10}|subproc-[a-f0-9]{12})$/.test(value);
}

export function deterministicRuntimeId(kind, taskId, attemptId) {
  const task = token(taskId, 'task_id_invalid');
  const attempt = token(attemptId, 'attempt_id_invalid');
  const hash = createHash('sha256').update(`${task}:${attempt}`).digest('hex');
  if (kind === 'hc') {
    const safe = task.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 12) || 'task';
    return `df-${safe}-${hash.slice(0, 10)}`.slice(0, 32);
  }
  if (kind === 'subproc') return `subproc-${hash.slice(0, 12)}`;
  fail('worker_runtime_kind_invalid');
}

function freshRuntimeId(kind) {
  const hex = randomUUID().replaceAll('-', '');
  if (kind === 'hc') return `df-r${hex.slice(0, 8)}-${hex.slice(8, 18)}`;
  if (kind === 'subproc') return `subproc-${hex.slice(0, 12)}`;
  fail('worker_runtime_kind_invalid');
}

// Секреты и привилегированные каналы контроллера никогда не наследуются
// дочерним процессом воркера (defense-in-depth): воркеру нужен лишь его
// собственный CLI/env, а не ssh-agent, токены Board или HMAC-ключ памяти.
const CONTROLLER_SENSITIVE_ENV = new Set([
  'SSH_AUTH_SOCK',
  'BOARD_TOKEN',
  'VB_TOKEN',
  'DF_PROJECT_MEMORY_HMAC_KEY',
  'DF_CONTROL_ROOM_WRITE_TOKEN',
]);

export function scrubbedWorkerChildEnv(env) {
  const clean = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    if (!CONTROLLER_SENSITIVE_ENV.has(key)) clean[key] = value;
  }
  return clean;
}

function terminalExitCode(terminal) {
  return Number.isSafeInteger(terminal?.exit_code) ? terminal.exit_code : undefined;
}

function hcState(terminal) {
  if (terminal?.state === 'finished' || terminal?.finished_ms !== null && terminal?.finished_ms !== undefined ||
      terminal?.exit_code !== null && terminal?.exit_code !== undefined || terminal?.reason === 'killed') {
    return 'exited';
  }
  const reported = typeof terminal?.status === 'string' ? terminal.status : terminal?.status?.state;
  if (['working', 'idle', 'done', 'blocked'].includes(reported)) return reported;
  if (reported === 'error') return 'blocked';
  return terminal?.state === 'live' ? 'working' : 'exited';
}

function validateSpawnInput(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) fail('worker_spawn_invalid');
  return Object.freeze({
    taskId: token(input.taskId, 'task_id_invalid'),
    attemptId: token(input.attemptId, 'attempt_id_invalid'),
    worktree: absolutePath(input.worktree, 'worktree_invalid'),
    promptFile: absolutePath(input.promptFile, 'prompt_file_invalid'),
    executor: input.executor,
    ...(input.spaceLabel === undefined ? {} : { spaceLabel: text(input.spaceLabel, 'space_label_invalid') }),
    ...(input.tabLabel === undefined ? {} : { tabLabel: text(input.tabLabel, 'tab_label_invalid') }),
    ...(input.runtimeId === undefined ? {} : { runtimeId: token(input.runtimeId, 'runtime_id_invalid') }),
    ...(input.permissionMode === undefined ? {} : { permissionMode: validatePermissionMode(input.permissionMode) }),
  });
}

function validateResumeInput(input) {
  const base = validateSpawnInput(input);
  return Object.freeze({ ...base,
    ...(input.sessionId === undefined ? {} : { sessionId: token(input.sessionId, 'session_id_invalid') }) });
}

function validateRuntimeId(runtimeId) {
  return text(runtimeId, 'runtime_id_invalid');
}

export function createWorkerRuntime({ kind, exec = execFileAsync, env = process.env,
  spawn: spawnProcess = nodeSpawn, readFile = readFileDefault } = {}) {
  if (!['hc', 'subproc'].includes(kind)) fail('worker_runtime_kind_invalid');
  if (typeof exec !== 'function') fail('worker_runtime_exec_invalid');
  if (typeof spawnProcess !== 'function') fail('worker_runtime_spawn_invalid');

  const sessions = new Map();

  const invoke = async (command, argv, options = {}) =>
    exec(command, argv, { env, timeout: 10_000, ...options });
  const hc = async (argv, options) => parseJson(await invoke('hc', argv, options), 'hc_output_invalid');

  async function probeOne(command) {
    try {
      await invoke(command, ['--version'], { timeout: 5_000 });
      return null;
    } catch (error) {
      return probeFailure(command, error);
    }
  }

  async function probeAvailability(spec) {
    let executor;
    try {
      executor = normalizeExecutor(spec);
    } catch (error) {
      return confirmedProbeRefusal(error.message);
    }
    if (kind === 'hc') {
      const transport = await probeOne('hc');
      if (transport) return transport;
    }
    return await probeOne(executor.command) ?? { status: 'available' };
  }

  async function promptFromFile(promptFile) {
    const data = await readFile(promptFile);
    return Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
  }

  async function runHc(input, built, { resumed = false } = {}) {
    const runtimeId = input.runtimeId ?? (resumed
      ? freshRuntimeId('hc') : deterministicRuntimeId('hc', input.taskId, input.attemptId));
    if (!/^[a-z0-9_-]{1,32}$/.test(runtimeId)) fail('runtime_id_invalid');
    const labels = [
      ['darkfactory.task', input.taskId],
      ['darkfactory.attempt', input.attemptId],
      ['darkfactory.executor', built.command],
      ...(resumed ? [['darkfactory.resumed', 'true']] : []),
      ...(input.spaceLabel === undefined ? [] : [['herdr.space', input.spaceLabel]]),
      ...(input.tabLabel === undefined ? [] : [['herdr.tab', input.tabLabel]]),
    ];
    const argv = ['run', '--bg', '--no-parent', '--no-notify', '--json', '--cwd', input.worktree,
      '--name', runtimeId];
    for (const [key, value] of labels) argv.push('--label', `${key}=${value}`);
    argv.push('--', built.command, ...built.argv);
    const launched = await hc(argv, { timeout: 30_000 });
    const terminalId = launched?.address;
    if (typeof terminalId !== 'string' || !terminalId) fail('hc_spawn_unattested');
    return Object.freeze({ runtimeId, transport: 'hc', terminalId,
      ...(Number.isSafeInteger(launched.pid) ? { pid: launched.pid } : {}) });
  }

  async function spawnHc(input, prompt) {
    const built = buildExecutorCommand(input.executor, { prompt, promptFile: input.promptFile,
      permissionMode: input.permissionMode, interactive: true });
    return runHc(input, built);
  }

  function pruneTerminalSessions(protectRuntimeId) {
    const terminal = [...sessions.entries()].filter(([, session]) => session.state !== 'working');
    let excess = terminal.length - MAX_TERMINAL_SUBPROC_SESSIONS;
    for (const [runtimeId] of terminal) {
      if (excess <= 0) break;
      if (runtimeId === protectRuntimeId) continue;
      sessions.delete(runtimeId);
      excess -= 1;
    }
  }

  function watchChild(session, child) {
    session.child = child;
    session.state = 'working';
    session.exitCode = undefined;
    session.signal = undefined;
    child.stdout?.on?.('data', chunk => appendTail(session, chunk));
    child.stderr?.on?.('data', chunk => appendTail(session, chunk));
    const finishTurn = () => {
      if (session.activeTurn !== true) return;
      session.activeTurn = false;
      session.turn += 1;
    };
    session.activeTurn = true;
    child.on?.('error', () => {
      if (session.state === 'working') {
        finishTurn();
        session.state = 'exited';
        pruneTerminalSessions(session.runtimeId);
      }
    });
    child.on?.('exit', (code, signal) => {
      finishTurn();
      session.state = code === 0 ? 'done' : 'exited';
      session.exitCode = Number.isSafeInteger(code) ? code : undefined;
      session.signal = signal ?? undefined;
      pruneTerminalSessions(session.runtimeId);
    });
  }

  function launchSubproc(session, built) {
    const child = spawnProcess(built.command, [...built.argv], {
      cwd: session.worktree, env: scrubbedWorkerChildEnv(env), stdio: ['ignore', 'pipe', 'pipe'],
    });
    watchChild(session, child);
    return child;
  }

  function startSubprocSession(input, built, runtimeId, { replaceTerminal = false } = {}) {
    const existing = sessions.get(runtimeId);
    if (existing && !(replaceTerminal && existing.state !== 'working')) fail('worker_runtime_exists');
    if (existing) sessions.delete(runtimeId);
    pruneTerminalSessions(runtimeId);
    const session = { ...input, runtimeId, turn: 0, tail: '', state: 'working', child: null };
    sessions.set(runtimeId, session);
    try {
      const child = launchSubproc(session, built);
      return Object.freeze({ runtimeId, transport: 'subproc',
        ...(Number.isSafeInteger(child.pid) ? { pid: child.pid } : {}) });
    } catch (error) {
      sessions.delete(runtimeId);
      throw error;
    }
  }

  async function spawnSubproc(input, prompt) {
    const built = buildExecutorCommand(input.executor, { prompt, promptFile: input.promptFile,
      permissionMode: input.permissionMode, interactive: false });
    const runtimeId = input.runtimeId ?? deterministicRuntimeId('subproc', input.taskId, input.attemptId);
    return startSubprocSession(input, built, runtimeId);
  }

  async function spawnWorker(rawInput) {
    const input = validateSpawnInput(rawInput);
    const prompt = text(await promptFromFile(input.promptFile), 'worker_prompt_invalid');
    return kind === 'hc' ? spawnHc(input, prompt) : spawnSubproc(input, prompt);
  }

  function hcProbeNotFound(error) {
    const detail = `${error?.stderr ?? ''}\n${error?.stdout ?? ''}\n${error?.message ?? ''}`;
    return detail.includes('"not_found"') || detail.includes('no terminal');
  }

  // Crash-resume под уже занятым именем: мёртвый терминал сначала убирается,
  // иначе hc run создаст дубликат имени и observe/send/kill по имени станут
  // неоднозначными. Живой терминал никогда не снимается — fail-closed, как
  // worker_busy у subproc; неподтверждённый сбой probe пробрасывается, а не
  // маскируется под чистое имя.
  async function removeCrashedHcTerminal(runtimeId) {
    let terminal;
    try {
      terminal = await hc(['get', '--json', '--', runtimeId]);
    } catch (error) {
      if (hcProbeNotFound(error)) return;
      throw error;
    }
    if (terminal?.error?.kind === 'not_found') return;
    if (hcState(terminal) !== 'exited') fail('worker_runtime_exists');
    try {
      await hc(['kill', '--json', '--', runtimeId], { timeout: 15_000 });
    } catch { /* kill уже завершённого терминала идемпотентен — best-effort */ }
    await hc(['rm', '--json', '--', runtimeId], { timeout: 15_000 });
  }

  async function resumeWorker(rawInput) {
    const input = validateResumeInput(rawInput);
    const prompt = text(await promptFromFile(input.promptFile), 'worker_prompt_invalid');
    const built = buildResumeCommand(input.executor, { sessionId: input.sessionId, prompt,
      promptFile: input.promptFile, permissionMode: input.permissionMode,
      interactive: kind === 'hc' });
    if (kind === 'hc') {
      if (input.runtimeId !== undefined) await removeCrashedHcTerminal(input.runtimeId);
      return runHc(input, built, { resumed: true });
    }
    const runtimeId = input.runtimeId ?? freshRuntimeId('subproc');
    return startSubprocSession(input, built, runtimeId, { replaceTerminal: true });
  }

  async function feedbackHc(runtimeId, message) {
    const sent = await hc(['send', '--json', '--', runtimeId, message], { timeout: 15_000 });
    return Object.freeze({ delivered: true,
      ...(sent.turn === undefined ? {} : { turn: sent.turn }),
      ...(sent.started === undefined ? {} : { started: sent.started }),
      ...(sent.status === undefined ? {} : { status: sent.status }) });
  }

  async function feedbackSubproc(runtimeId, message) {
    const session = sessions.get(runtimeId);
    if (!session) fail('worker_runtime_unknown');
    if (session.state === 'working') fail('worker_busy');
    const followUp = buildFollowUpMessage({ taskId: session.taskId, attemptId: session.attemptId, message });
    const built = buildExecutorCommand(session.executor, { prompt: followUp,
      permissionMode: session.permissionMode, interactive: false, followUp: true });
    const child = launchSubproc(session, built);
    return Object.freeze({ delivered: true, turn: session.turn,
      ...(Number.isSafeInteger(child.pid) ? { pid: child.pid } : {}) });
  }

  async function feedback({ runtimeId, message } = {}) {
    const id = validateRuntimeId(runtimeId);
    const body = text(message, 'feedback_message_invalid');
    return kind === 'hc' ? feedbackHc(id, body) : feedbackSubproc(id, body);
  }

  async function observeHc(runtimeId) {
    const terminal = await hc(['get', '--json', '--', runtimeId]);
    let read = null;
    try {
      read = await hc(['read', '--json', '--lines', '40', '--', runtimeId]);
    } catch {
      read = null;
    }
    const exitCode = terminalExitCode(terminal);
    const tail = typeof read?.text === 'string' ? read.text.slice(-TAIL_LIMIT) : undefined;
    return Object.freeze({ state: hcState(terminal),
      ...(Number.isSafeInteger(terminal?.turn) ? { turn: terminal.turn } : {}),
      ...(exitCode === undefined ? {} : { exitCode }),
      ...(tail === undefined || tail === '' ? {} : { tail }) });
  }

  async function observe({ runtimeId } = {}) {
    const id = validateRuntimeId(runtimeId);
    if (kind === 'hc') return observeHc(id);
    const session = sessions.get(id);
    if (!session) return Object.freeze({ state: 'exited' });
    if (session.state !== 'working') pruneTerminalSessions(id);
    return Object.freeze({ state: session.state,
      ...(session.turn > 0 ? { turn: session.turn } : {}),
      ...(session.exitCode === undefined ? {} : { exitCode: session.exitCode }),
      ...(session.tail === '' ? {} : { tail: session.tail.slice(-TAIL_LIMIT) }) });
  }

  async function stopHc(runtimeId) {
    const terminal = await hc(['kill', '--json', '--', runtimeId], { timeout: 15_000 });
    const exitCode = terminalExitCode(terminal);
    return Object.freeze({ stopped: true, state: 'exited',
      ...(exitCode === undefined ? {} : { exitCode }) });
  }

  // Подтверждение фактического выхода subproc-писателя: stopped: true
  // выписывается только когда процесс реально завершился (событие exit уже
  // наблюдено для терминальной сессии или дождались его после сигнала).
  // Неизвестная сессия — stopped: false БЕЗ состояния exited: таблица
  // sessions живёт в памяти процесса, после рестарта контроллера писатель
  // может быть жив — «exited» был бы недоказанным утверждением.
  async function waitSubprocExit(session, graceMs) {
    const deadline = Date.now() + graceMs;
    while (session.state === 'working' && Date.now() < deadline) {
      await delay(10);
    }
    return session.state !== 'working';
  }

  function stoppedSubproc(session) {
    return Object.freeze({ stopped: true, state: session.state,
      ...(session.exitCode === undefined ? {} : { exitCode: session.exitCode }),
      ...(session.signal === undefined ? {} : { signal: session.signal }) });
  }

  async function stopSubproc(session) {
    if (session.state !== 'working') {
      pruneTerminalSessions(session.runtimeId);
      return stoppedSubproc(session);
    }
    session.child?.kill?.('SIGTERM');
    if (!await waitSubprocExit(session, SUBPROC_STOP_TERM_GRACE_MS)) {
      session.child?.kill?.('SIGKILL');
      await waitSubprocExit(session, SUBPROC_STOP_KILL_GRACE_MS);
    }
    if (session.state !== 'working') return stoppedSubproc(session);
    return Object.freeze({ stopped: false, state: session.state });
  }

  async function stop({ runtimeId } = {}) {
    const id = validateRuntimeId(runtimeId);
    if (kind === 'hc') return stopHc(id);
    const session = sessions.get(id);
    if (!session) return Object.freeze({ stopped: false });
    return stopSubproc(session);
  }

  return Object.freeze({ kind, probeAvailability, spawn: spawnWorker, resume: resumeWorker,
    feedback, observe, stop });
}
