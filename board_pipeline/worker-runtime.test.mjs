import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { buildExecutorCommand, buildFollowUpMessage, buildResumeCommand, createWorkerRuntime,
  deterministicRuntimeId, isWorkerThreadId, scrubbedWorkerChildEnv } from './worker-runtime.mjs';

const SPAWN = {
  taskId: '3840', attemptId: 'attempt-1', worktree: '/tmp/worktree', promptFile: '/tmp/prompt.md',
  executor: { provider: 'acp-devin', model: 'swe-2-1-medium' },
  spaceLabel: 'Factory', tabLabel: 'Task 3840',
};

function hcMock(respond) {
  const calls = [];
  const exec = async (command, argv, options) => {
    calls.push({ command, argv, options });
    return respond(command, argv, options);
  };
  return { calls, exec };
}

function childProcess(pid) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = pid;
  child.kill = signal => { child.killed = signal; return true; };
  return child;
}

test('executor command builders map devin, pi and agy to safe argv arrays', () => {
  const prompt = 'fix it; $(rm -rf /) && stay literal\nsecond line';
  const devin = buildExecutorCommand({ provider: 'acp-devin', model: 'swe-2-1-medium' }, { prompt });
  assert.equal(devin.command, 'devin');
  assert.deepEqual(devin.argv, ['--model', 'swe-2-1-medium', '--', prompt]);
  const pi = buildExecutorCommand({ provider: 'pi', model: 'opencode-go/deepseek-v4.1-flash', reasoningLevel: 'medium' },
    { prompt, interactive: false, followUp: true });
  assert.equal(pi.command, 'pi');
  assert.deepEqual(pi.argv, ['--model', 'opencode-go/deepseek-v4.1-flash', '--thinking', 'medium',
    '--continue', '--print', '--', prompt]);
  const agy = buildExecutorCommand({ provider: 'acp-antigravity-acp', model: 'gemini-4-neon', effort: 'high' }, { prompt });
  assert.equal(agy.command, 'agy');
  assert.deepEqual(agy.argv, ['--model', 'gemini-4-neon', '--effort', 'high', '--prompt-interactive', '--', prompt]);
  const devinFile = buildExecutorCommand({ provider: 'acp-devin', model: 'swe-2-1-medium' },
    { prompt, promptFile: '/tmp/prompt.md', permissionMode: 'full' });
  assert.deepEqual(devinFile.argv, ['--model', 'swe-2-1-medium', '--permission-mode', 'dangerous',
    '--respect-workspace-trust', 'false', '--prompt-file', '/tmp/prompt.md']);
  const devinEdits = buildExecutorCommand({ provider: 'acp-devin', model: 'swe-2-1-medium' },
    { prompt, permissionMode: 'accept-edits' });
  assert.deepEqual(devinEdits.argv, ['--model', 'swe-2-1-medium', '--permission-mode', 'accept-edits',
    '--respect-workspace-trust', 'false', '--', prompt]);
  const agyFull = buildExecutorCommand({ provider: 'agy', model: 'gemini-4-neon' },
    { prompt, permissionMode: 'full' });
  assert.deepEqual(agyFull.argv, ['--model', 'gemini-4-neon', '--dangerously-skip-permissions',
    '--prompt-interactive', '--', prompt]);
  // pi 1.6+ спрашивает "Trust project folder?" в интерактиве; --approve снимает
  // блокирующий промпт для автономного воркера, как --respect-workspace-trust false у devin.
  const piFull = buildExecutorCommand({ provider: 'pi', model: 'opencode-go/deepseek-v4.1-flash' },
    { prompt, permissionMode: 'full' });
  assert.deepEqual(piFull.argv, ['--model', 'opencode-go/deepseek-v4.1-flash', '--approve',
    '--', prompt]);
  const piEdits = buildExecutorCommand({ provider: 'pi', model: 'opencode-go/deepseek-v4.1-flash' },
    { prompt, permissionMode: 'accept-edits', interactive: false });
  assert.deepEqual(piEdits.argv, ['--model', 'opencode-go/deepseek-v4.1-flash', '--approve',
    '--print', '--', prompt]);
  assert.equal(pi.argv.includes('--approve'), false);
  assert.throws(() => buildExecutorCommand({ provider: 'pi', model: 'x' },
    { prompt, permissionMode: 'smart' }), /permission_mode_invalid/);
  assert.throws(() => buildExecutorCommand({ provider: 'acp-devin', model: 'swe-2-1-medium' },
    { prompt, permissionMode: 'smart' }), /permission_mode_invalid/);
  for (const built of [devin, pi, agy]) {
    assert.equal(built.argv.includes('sh'), false);
    assert.equal(built.argv.includes('bash'), false);
    assert.equal(built.argv.filter(arg => arg === prompt).length, 1);
  }
  assert.throws(() => buildExecutorCommand({ provider: 'bogus', model: 'x' }, { prompt }), /executor_unsupported/);
  assert.throws(() => buildExecutorCommand({ provider: 'pi', model: 'x' }, { prompt: '' }), /worker_prompt_invalid/);
  assert.throws(() => buildExecutorCommand({ provider: 'pi' }, { prompt }), /executor_model_invalid/);
});

test('resume command builders preserve executor flags and session continuation contracts', () => {
  const devin = buildResumeCommand({ provider: 'acp-devin', model: 'swe-2-1-medium' },
    { sessionId: 'ses-1', prompt: 'continue WIP', promptFile: '/tmp/follow-up.md', permissionMode: 'full' });
  assert.deepEqual(devin.argv, ['--model', 'swe-2-1-medium', '--permission-mode', 'dangerous',
    '--respect-workspace-trust', 'false', '-r', 'ses-1', '--prompt-file', '/tmp/follow-up.md']);
  const freshDevin = buildResumeCommand({ provider: 'acp-devin', model: 'swe-2-1-medium' },
    { prompt: 'continue WIP' });
  assert.deepEqual(freshDevin.argv, ['--model', 'swe-2-1-medium', '--', 'continue WIP']);
  const pi = buildResumeCommand({ provider: 'pi', model: 'opencode-go/deepseek-v4.1-flash', effort: 'medium' },
    { prompt: 'continue WIP', interactive: false });
  assert.deepEqual(pi.argv, ['--model', 'opencode-go/deepseek-v4.1-flash', '--thinking', 'medium',
    '--continue', '--print', '--', 'continue WIP']);
  const piApproved = buildResumeCommand({ provider: 'pi', model: 'opencode-go/deepseek-v4.1-flash' },
    { prompt: 'continue WIP', permissionMode: 'full', interactive: false });
  assert.deepEqual(piApproved.argv, ['--model', 'opencode-go/deepseek-v4.1-flash', '--approve',
    '--continue', '--print', '--', 'continue WIP']);
  const agy = buildResumeCommand({ provider: 'acp-antigravity-acp', model: 'gemini-4-neon', effort: 'high' },
    { sessionId: 'conv-1', prompt: 'continue WIP', permissionMode: 'full', interactive: false });
  assert.deepEqual(agy.argv, ['--model', 'gemini-4-neon', '--effort', 'high',
    '--dangerously-skip-permissions', '--resume', 'conv-1', '--print', '--', 'continue WIP']);
  const agyLatest = buildResumeCommand({ provider: 'agy', model: 'gemini-4-neon' }, { prompt: 'continue WIP' });
  assert.deepEqual(agyLatest.argv, ['--model', 'gemini-4-neon', '--continue', '--prompt-interactive',
    '--', 'continue WIP']);
});

test('hc spawn uses run --bg --keep, labels, and a shell-free argv tail', async () => {
  const prompt = 'worker prompt with spaces; $(not_shell) `literal`';
  const { calls, exec } = hcMock(async () => ({ stdout: JSON.stringify({ address: 't7', pid: 123 }) }));
  const runtime = createWorkerRuntime({ kind: 'hc', exec, env: { MARKER: '1' }, readFile: async () => prompt });
  const spawned = await runtime.spawn({ ...SPAWN, permissionMode: 'full' });
  assert.deepEqual(spawned, { runtimeId: 'df-3840-d0d63638ee', transport: 'hc', terminalId: 't7', pid: 123 });
  assert.equal(calls.length, 1);
  const { command, argv, options } = calls[0];
  assert.equal(command, 'hc');
  assert.deepEqual(argv.slice(0, 7), ['run', '--bg', '--no-parent', '--no-notify', '--json', '--cwd', '/tmp/worktree']);
  assert.deepEqual(argv.slice(7, 9), ['--name', 'df-3840-d0d63638ee']);
  assert.equal(argv.includes('--keep'), false);
  assert.equal(options.env.MARKER, '1');
  const labels = argv.filter((arg, i) => argv[i - 1] === '--label');
  assert.ok(labels.includes('darkfactory.task=3840'));
  assert.ok(labels.includes('darkfactory.attempt=attempt-1'));
  assert.ok(labels.includes('darkfactory.executor=devin'));
  assert.ok(labels.includes('herdr.space=Factory'));
  assert.ok(labels.includes('herdr.tab=Task 3840'));
  const separator = argv.indexOf('--');
  assert.deepEqual(argv.slice(separator + 1),
    ['devin', '--model', 'swe-2-1-medium', '--permission-mode', 'dangerous',
      '--respect-workspace-trust', 'false', '--prompt-file', '/tmp/prompt.md']);
  assert.equal(argv.includes(prompt), false);
  assert.equal(argv.includes('sh'), false);
  assert.equal(argv.includes('bash'), false);
});

test('hc spawn requires a top-level attested terminal address', async () => {
  const { exec } = hcMock(async () => ({ stdout: JSON.stringify({ terminal: { address: 'nested-t7' } }) }));
  const runtime = createWorkerRuntime({ kind: 'hc', exec, readFile: async () => 'prompt' });
  await assert.rejects(() => runtime.spawn(SPAWN), /hc_spawn_unattested/);
});

test('hc feedback, observe and stop map CLI results to the runtime contract', async () => {
  const { calls, exec } = hcMock(async (command, argv) => {
    if (argv[0] === 'send') return { stdout: JSON.stringify({ turn: 3, started: true, status: 'idle' }) };
    if (argv[0] === 'get') return { stdout: JSON.stringify({ state: 'live', turn: 3, status: { state: 'blocked' } }) };
    if (argv[0] === 'read') return { stdout: JSON.stringify({ text: 'line 1\nline 2\n' }) };
    if (argv[0] === 'kill') return { stdout: JSON.stringify({ state: 'finished', exit_code: 0, reason: 'killed' }) };
    throw new Error(`unexpected ${argv[0]}`);
  });
  const runtime = createWorkerRuntime({ kind: 'hc', exec });
  assert.deepEqual(await runtime.feedback({ runtimeId: 't7', message: 'fix the red test' }),
    { delivered: true, turn: 3, started: true, status: 'idle' });
  assert.deepEqual(await runtime.observe({ runtimeId: 't7' }), { state: 'blocked', turn: 3, tail: 'line 1\nline 2\n' });
  assert.deepEqual(await runtime.stop({ runtimeId: 't7' }), { stopped: true, state: 'exited', exitCode: 0 });
  assert.deepEqual(calls[0].argv, ['send', '--json', '--', 't7', 'fix the red test']);
  assert.deepEqual(calls[1].argv, ['get', '--json', '--', 't7']);
  assert.deepEqual(calls[2].argv, ['read', '--json', '--lines', '40', '--', 't7']);
  assert.deepEqual(calls[3].argv, ['kill', '--json', '--', 't7']);
});

test('hc observe treats a finished terminal as exited even when its exit code is non-zero', async () => {
  const { exec } = hcMock(async (command, argv) => argv[0] === 'get'
    ? { stdout: JSON.stringify({ state: 'finished', exit_code: 2, reason: 'exited' }) }
    : { stdout: JSON.stringify({ text: 'failure tail' }) });
  const runtime = createWorkerRuntime({ kind: 'hc', exec });
  assert.deepEqual(await runtime.observe({ runtimeId: 't9' }),
    { state: 'exited', exitCode: 2, tail: 'failure tail' });
});

test('hc observe keeps a valid hc get result when hc read fails transiently', async () => {
  const { calls, exec } = hcMock(async (command, argv) => {
    if (argv[0] === 'get') return { stdout: JSON.stringify({ state: 'finished', exit_code: 137, turn: 2 }) };
    if (argv[0] === 'read') throw new Error('transient read failure');
    throw new Error(`unexpected ${argv[0]}`);
  });
  const runtime = createWorkerRuntime({ kind: 'hc', exec });
  assert.deepEqual(await runtime.observe({ runtimeId: 't10' }), { state: 'exited', turn: 2, exitCode: 137 });
  assert.deepEqual(calls.map(call => call.argv[0]), ['get', 'read']);
});

test('probeAvailability probes hc plus the executor and classifies missing tools', async () => {
  const missing = Object.assign(new Error('spawn hc ENOENT'), { code: 'ENOENT' });
  const { calls, exec } = hcMock(async command => {
    if (command === 'hc') throw missing;
    return { stdout: 'devin 1' };
  });
  const runtime = createWorkerRuntime({ kind: 'hc', exec });
  assert.deepEqual(await runtime.probeAvailability({ provider: 'acp-devin', model: 'swe-2-1-medium' }),
    { status: 'confirmed_refusal', activeBackgroundAgentCount: 0, reason: 'hc_not_found' });
  assert.deepEqual(calls.map(call => [call.command, call.argv]), [['hc', ['--version']]]);
  assert.deepEqual(await runtime.probeAvailability({ provider: 'bogus', model: 'x' }),
    { status: 'confirmed_refusal', activeBackgroundAgentCount: 0, reason: 'executor_unsupported' });

  const nonzero = Object.assign(new Error('devin --version exited 1'), { code: 1 });
  const failingExec = async command => {
    if (command === 'hc') return { stdout: 'hc 1' };
    throw nonzero;
  };
  const failingRuntime = createWorkerRuntime({ kind: 'hc', exec: failingExec });
  assert.deepEqual(await failingRuntime.probeAvailability({ provider: 'acp-devin', model: 'swe-2-1-medium' }),
    { status: 'confirmed_refusal', activeBackgroundAgentCount: 0, reason: 'devin_probe_failed' });

  const ambiguousRuntime = createWorkerRuntime({ kind: 'subproc', exec: async () => {
    throw Object.assign(new Error('probe timed out'), { code: 'ETIMEDOUT' });
  } });
  assert.deepEqual(await ambiguousRuntime.probeAvailability({ provider: 'pi', model: 'openai/gpt-6.2-sol' }),
    { status: 'unknown_outcome', reason: 'pi_probe_unknown' });
});

test('subproc spawn runs a print-mode turn directly and observes its deterministic tail', async () => {
  const children = [];
  const launches = [];
  const spawn = (command, argv, options) => {
    const child = childProcess(4321 + children.length);
    children.push(child);
    launches.push({ command, argv, options });
    return child;
  };
  const runtime = createWorkerRuntime({ kind: 'subproc', exec: async () => ({ stdout: 'unused' }),
    env: { SUBPROC_TEST: '1' }, spawn, readFile: async () => 'initial prompt' });
  const spawned = await runtime.spawn({ ...SPAWN,
    executor: { provider: 'pi', model: 'openai/gpt-6.2-sol', reasoningLevel: 'medium' } });
  assert.deepEqual(spawned, { runtimeId: 'subproc-d0d63638ee89', transport: 'subproc', pid: 4321 });
  assert.equal(launches[0].command, 'pi');
  assert.deepEqual(launches[0].argv, ['--model', 'openai/gpt-6.2-sol', '--thinking', 'medium',
    '--print', '--', 'initial prompt']);
  assert.equal(launches[0].options.cwd, '/tmp/worktree');
  assert.equal(launches[0].options.env.SUBPROC_TEST, '1');
  assert.deepEqual(await runtime.observe({ runtimeId: spawned.runtimeId }), { state: 'working' });
  children[0].stdout.emit('data', 'worker output');
  children[0].emit('exit', 0, null);
  assert.deepEqual(await runtime.observe({ runtimeId: spawned.runtimeId }),
    { state: 'done', turn: 1, exitCode: 0, tail: 'worker output' });
  assert.deepEqual(await runtime.observe({ runtimeId: 'missing' }), { state: 'exited' });
});

test('subproc devin spawn uses prompt files and permission flags instead of argv prompts', async () => {
  const launches = [];
  const spawn = (command, argv, options) => {
    launches.push({ command, argv, options });
    return childProcess(4700);
  };
  const runtime = createWorkerRuntime({ kind: 'subproc', exec: async () => ({ stdout: '' }),
    spawn, readFile: async () => 'large worker prompt' });
  await runtime.spawn({ ...SPAWN, permissionMode: 'accept-edits' });
  assert.equal(launches[0].command, 'devin');
  assert.deepEqual(launches[0].argv, ['--model', 'swe-2-1-medium', '--permission-mode', 'accept-edits',
    '--respect-workspace-trust', 'false', '--print', '--prompt-file', '/tmp/prompt.md']);
  assert.equal(launches[0].argv.includes('large worker prompt'), false);
});

test('runtime.resume launches an hc continuation with resume labels and a fresh runtime id', async () => {
  const { calls, exec } = hcMock(async () => ({ stdout: JSON.stringify({ address: 't-resume', pid: 3210 }) }));
  const runtime = createWorkerRuntime({ kind: 'hc', exec, readFile: async () => 'resume the WIP' });
  const resumed = await runtime.resume({ ...SPAWN, sessionId: 'ses-9', permissionMode: 'full' });
  assert.equal(resumed.transport, 'hc');
  assert.equal(resumed.terminalId, 't-resume');
  assert.notEqual(resumed.runtimeId, deterministicRuntimeId('hc', SPAWN.taskId, SPAWN.attemptId));
  assert.equal(isWorkerThreadId(resumed.runtimeId), true);
  const argv = calls[0].argv;
  assert.deepEqual(argv.slice(0, 7), ['run', '--bg', '--no-parent', '--no-notify', '--json', '--cwd', '/tmp/worktree']);
  assert.equal(argv.includes('--keep'), false);
  const labels = argv.filter((arg, i) => argv[i - 1] === '--label');
  assert.ok(labels.includes('darkfactory.resumed=true'));
  const separator = argv.indexOf('--');
  assert.deepEqual(argv.slice(separator + 1), ['devin', '--model', 'swe-2-1-medium',
    '--permission-mode', 'dangerous', '--respect-workspace-trust', 'false', '-r', 'ses-9',
    '--prompt-file', '/tmp/prompt.md']);
  const specifiedId = 'df-specified-abcdef1234';
  const specified = await runtime.resume({ ...SPAWN, runtimeId: specifiedId, sessionId: 'ses-9' });
  assert.equal(specified.runtimeId, specifiedId);
  // Возобновление под занятым именем сначала зондирует и убирает мёртвый
  // терминал (get/kill/rm), затем перезапускает — run остаётся тем же именем.
  const runCalls = calls.filter(call => call.argv[0] === 'run');
  assert.equal(runCalls.length, 2);
  assert.deepEqual(runCalls[1].argv.slice(7, 9), ['--name', specifiedId]);
});

test('subproc resume continues in the worktree after a crashed terminal turn', async () => {
  const children = [];
  const launches = [];
  const spawn = (command, argv, options) => {
    const child = childProcess(5200 + children.length);
    children.push(child);
    launches.push({ command, argv, options });
    return child;
  };
  const runtime = createWorkerRuntime({ kind: 'subproc', exec: async () => ({ stdout: '' }),
    spawn, readFile: async () => 'continue after crash' });
  const executor = { provider: 'pi', model: 'opencode-go/deepseek-v4.1-flash', reasoningLevel: 'medium' };
  const spawned = await runtime.spawn({ ...SPAWN, executor });
  children[0].emit('exit', 9, null);
  assert.deepEqual(await runtime.observe({ runtimeId: spawned.runtimeId }),
    { state: 'exited', turn: 1, exitCode: 9 });
  const resumed = await runtime.resume({ ...SPAWN, executor, runtimeId: spawned.runtimeId });
  assert.equal(resumed.runtimeId, spawned.runtimeId);
  assert.equal(launches.length, 2);
  assert.equal(launches[1].options.cwd, '/tmp/worktree');
  assert.deepEqual(launches[1].argv, ['--model', 'opencode-go/deepseek-v4.1-flash', '--thinking', 'medium',
    '--continue', '--print', '--', 'continue after crash']);
});

test('subproc terminal session eviction is bounded without losing the latest exit', async () => {
  const children = [];
  const spawn = () => {
    const child = childProcess(7000 + children.length);
    children.push(child);
    return child;
  };
  const runtime = createWorkerRuntime({ kind: 'subproc', exec: async () => ({ stdout: '' }),
    spawn, readFile: async () => 'prompt' });
  const executor = { provider: 'pi', model: 'opencode-go/deepseek-v4.1-flash' };
  const runtimeIds = [];
  for (let i = 0; i < 33; i += 1) {
    const runtimeId = `subproc-${String(i).padStart(12, '0')}`;
    runtimeIds.push(runtimeId);
    await runtime.spawn({ ...SPAWN, executor, runtimeId });
  }
  for (const child of children) child.emit('exit', 1, null);
  assert.deepEqual(await runtime.observe({ runtimeId: runtimeIds[0] }), { state: 'exited' });
  assert.deepEqual(await runtime.observe({ runtimeId: runtimeIds.at(-1) }),
    { state: 'exited', turn: 1, exitCode: 1 });
});

test('subproc feedback starts a structured continuation turn and stop signals an active child', async () => {
  const children = [];
  const launches = [];
  const spawn = (command, argv) => {
    const child = childProcess(5000 + children.length);
    children.push(child);
    launches.push({ command, argv });
    return child;
  };
  const runtime = createWorkerRuntime({ kind: 'subproc', exec: async () => ({ stdout: '' }),
    spawn, readFile: async () => 'initial' });
  const spawned = await runtime.spawn({ ...SPAWN,
    executor: { provider: 'acp-antigravity-acp', model: 'gemini-4-neon', reasoningLevel: 'medium' } });
  children[0].emit('exit', 0, null);
  const sent = await runtime.feedback({ runtimeId: spawned.runtimeId, message: 'address L2 finding' });
  assert.deepEqual(sent, { delivered: true, turn: 1, pid: 5001 });
  assert.equal(launches[1].command, 'agy');
  assert.deepEqual(launches[1].argv.slice(0, 6), ['--model', 'gemini-4-neon', '--effort', 'medium', '--continue', '--print']);
  const followUp = launches[1].argv.at(-1);
  assert.equal(followUp, buildFollowUpMessage({ taskId: '3840', attemptId: 'attempt-1', message: 'address L2 finding' }));
  assert.match(followUp, /task_id: 3840/);
  assert.match(followUp, /address L2 finding/);
  // stop дожидается фактического выхода: SIGTERM отправлен, exit подтверждён —
  // только тогда stopped: true. Состояние 'working' из отправки сигнала —
  // недоказанная остановка и так не отчитывается никогда.
  children[1].kill = signal => {
    children[1].killed = signal;
    setTimeout(() => children[1].emit('exit', null, 'SIGTERM'), 2);
  };
  assert.deepEqual(await runtime.stop({ runtimeId: spawned.runtimeId }),
    { stopped: true, state: 'exited', signal: 'SIGTERM' });
  assert.equal(children[1].killed, 'SIGTERM');
  // Повторный stop терминальной сессии идемпотентно подтверждает выход:
  // событие exit уже наблюдено в этом процессе.
  assert.deepEqual(await runtime.stop({ runtimeId: spawned.runtimeId }),
    { stopped: true, state: 'exited', signal: 'SIGTERM' });
});

// Astra P1-4: subproc stop подтверждает фактический выход процесса — ожидание
// после SIGTERM, fallback SIGKILL, stopped: false без подтверждения и для
// неизвестных сессий (post-restart amnesia не выдаётся за exited).
test('subproc stop falls back to SIGKILL when SIGTERM is ignored', async () => {
  const children = [];
  const spawn = () => {
    const child = childProcess(6100 + children.length);
    children.push(child);
    return child;
  };
  const runtime = createWorkerRuntime({ kind: 'subproc', exec: async () => ({ stdout: '' }),
    spawn, readFile: async () => 'prompt' });
  const spawned = await runtime.spawn({ ...SPAWN,
    executor: { provider: 'pi', model: 'opencode-go/deepseek-v4.1-flash' } });
  const child = children[0];
  const signals = [];
  child.kill = signal => {
    signals.push(signal);
    if (signal === 'SIGKILL') setTimeout(() => child.emit('exit', null, 'SIGKILL'), 2);
  };
  const outcome = await runtime.stop({ runtimeId: spawned.runtimeId });
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL'], 'SIGKILL только после игнорированного SIGTERM');
  assert.deepEqual(outcome, { stopped: true, state: 'exited', signal: 'SIGKILL' });
});

test('subproc stop reports stopped false when the child never exits', async t => {
  const children = [];
  const spawn = () => {
    const child = childProcess(6200 + children.length);
    children.push(child);
    return child;
  };
  const runtime = createWorkerRuntime({ kind: 'subproc', exec: async () => ({ stdout: '' }),
    spawn, readFile: async () => 'prompt' });
  const spawned = await runtime.spawn({ ...SPAWN,
    executor: { provider: 'pi', model: 'opencode-go/deepseek-v4.1-flash' } });
  const signals = [];
  children[0].kill = signal => { signals.push(signal); };
  const outcome = await runtime.stop({ runtimeId: spawned.runtimeId });
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(outcome.stopped, false, 'неподтверждённый выход — stopped: false, а не отправка сигнала');
  assert.equal(outcome.state, 'working');
});

test('subproc stop of an unknown session is stopped false without an exited claim', async () => {
  const runtime = createWorkerRuntime({ kind: 'subproc', exec: async () => ({ stdout: '' }),
    spawn: () => childProcess(1), readFile: async () => 'prompt' });
  const outcome = await runtime.stop({ runtimeId: 'subproc-000000000000' });
  assert.deepEqual(outcome, { stopped: false });
  assert.equal(Object.hasOwn(outcome, 'state'), false,
    'неизвестная сессия не декларирует exited: писатель может жить после рестарта контроллера');
  // Повторный вызов детерминирован и не бросает.
  assert.deepEqual(await runtime.stop({ runtimeId: 'subproc-000000000000' }), { stopped: false });
});

test('subproc stop of an already terminal session confirms the observed exit', async () => {
  const children = [];
  const spawn = () => {
    const child = childProcess(6300 + children.length);
    children.push(child);
    return child;
  };
  const runtime = createWorkerRuntime({ kind: 'subproc', exec: async () => ({ stdout: '' }),
    spawn, readFile: async () => 'prompt' });
  const spawned = await runtime.spawn({ ...SPAWN,
    executor: { provider: 'pi', model: 'opencode-go/deepseek-v4.1-flash' } });
  children[0].emit('exit', 0, null);
  assert.deepEqual(await runtime.stop({ runtimeId: spawned.runtimeId }),
    { stopped: true, state: 'done', exitCode: 0 });
  assert.equal(children[0].killed, undefined, 'сигнал завершённому процессу не отправляется');
});

test('subproc probe does not require hc and invalid input fails before a process starts', async () => {
  const probes = [];
  let launches = 0;
  const runtime = createWorkerRuntime({ kind: 'subproc',
    exec: async command => { probes.push(command); return { stdout: '1.0' }; },
    spawn: () => { launches++; return childProcess(1); },
    readFile: async () => '' });
  assert.deepEqual(await runtime.probeAvailability({ provider: 'pi', model: 'openai/gpt-6.2-sol' }),
    { status: 'available' });
  assert.deepEqual(probes, ['pi']);
  await assert.rejects(() => runtime.spawn(SPAWN), /worker_prompt_invalid/);
  assert.equal(launches, 0);
  assert.throws(() => createWorkerRuntime({ kind: 'pty' }), /worker_runtime_kind_invalid/);
});

test('hc option separator protects positional ids and markdown rework text', async () => {
  const rework = '- Fix line 10\n- Add test';
  const { calls, exec } = hcMock(async (command, argv) => {
    if (argv[0] === 'send') return { stdout: JSON.stringify({ started: true }) };
    if (argv[0] === 'get') return { stdout: JSON.stringify({ state: 'live', status: { state: 'working' } }) };
    if (argv[0] === 'read') return { stdout: JSON.stringify({ text: '' }) };
    if (argv[0] === 'kill') return { stdout: JSON.stringify({ state: 'finished' }) };
    throw new Error(`unexpected ${argv[0]}`);
  });
  const runtime = createWorkerRuntime({ kind: 'hc', exec });
  await runtime.feedback({ runtimeId: 'df-task-0123456789', message: rework });
  await runtime.observe({ runtimeId: 'df-task-0123456789' });
  await runtime.stop({ runtimeId: 'df-task-0123456789' });
  assert.deepEqual(calls[0].argv, ['send', '--json', '--', 'df-task-0123456789', rework]);
  assert.deepEqual(calls[1].argv, ['get', '--json', '--', 'df-task-0123456789']);
  assert.deepEqual(calls[2].argv, ['read', '--json', '--lines', '40', '--', 'df-task-0123456789']);
  assert.deepEqual(calls[3].argv, ['kill', '--json', '--', 'df-task-0123456789']);
});

test('deterministic runtime ids round-trip through hc --name and subproc sessions', async () => {
  assert.equal(deterministicRuntimeId('hc', '3840', 'attempt-1'), 'df-3840-d0d63638ee');
  assert.equal(deterministicRuntimeId('subproc', '3840', 'attempt-1'), 'subproc-d0d63638ee89');
  assert.equal(deterministicRuntimeId('hc', 'Task/4049!', 'attempt-2'),
    deterministicRuntimeId('hc', 'Task/4049!', 'attempt-2'));
  assert.throws(() => deterministicRuntimeId('bb', '3840', 'attempt-1'), /worker_runtime_kind_invalid/);

  const hcId = 'df-explicit-0123456789';
  const { calls, exec } = hcMock(async () => ({ stdout: JSON.stringify({ address: 'terminal-address' }) }));
  const hcRuntime = createWorkerRuntime({ kind: 'hc', exec, readFile: async () => 'prompt' });
  await assert.rejects(() => hcRuntime.spawn({ ...SPAWN, runtimeId: 'Bad Name' }), /runtime_id_invalid/);
  const hcSpawned = await hcRuntime.spawn({ ...SPAWN, runtimeId: hcId });
  assert.equal(hcSpawned.runtimeId, hcId);
  assert.equal(hcSpawned.terminalId, 'terminal-address');
  assert.deepEqual(calls[0].argv.slice(7, 9), ['--name', hcId]);

  const children = [];
  const subRuntime = createWorkerRuntime({ kind: 'subproc', exec: async () => ({ stdout: '' }),
    spawn: () => { const child = childProcess(6100 + children.length); children.push(child); return child; },
    readFile: async () => 'prompt' });
  const subId = deterministicRuntimeId('subproc', '3840', 'attempt-1');
  const subSpawned = await subRuntime.spawn({ ...SPAWN, runtimeId: subId,
    executor: { provider: 'pi', model: 'opencode-go/deepseek-v4.1-flash' } });
  assert.equal(subSpawned.runtimeId, subId);
  assert.deepEqual(await subRuntime.observe({ runtimeId: subId }), { state: 'working' });
});

// --- P0/P1 cross-review regressions: hc crash-resume collision, env scrubbing ---

test('hc resume under an existing runtimeId removes the dead terminal before re-running', async () => {
  const { calls, exec } = hcMock(async (command, argv) => {
    if (argv[0] === 'get') return { stdout: JSON.stringify({ state: 'finished', exit_code: 9, reason: 'exited' }) };
    if (argv[0] === 'kill') return { stdout: JSON.stringify({ state: 'finished', exit_code: 9 }) };
    if (argv[0] === 'rm') return { stdout: JSON.stringify({ removed: 't-dead' }) };
    if (argv[0] === 'run') return { stdout: JSON.stringify({ address: 't-new', pid: 42 }) };
    throw new Error(`unexpected ${argv[0]}`);
  });
  const runtime = createWorkerRuntime({ kind: 'hc', exec, readFile: async () => 'resume prompt' });
  const runtimeId = 'df-3840-d0d63638ee';
  const resumed = await runtime.resume({ ...SPAWN, runtimeId, sessionId: 'ses-7' });
  assert.equal(resumed.runtimeId, runtimeId);
  assert.equal(resumed.terminalId, 't-new');
  // Строгий порядок: зонд, идемпотентный kill, обязательный rm, затем run.
  assert.deepEqual(calls.map(call => call.argv[0]), ['get', 'kill', 'rm', 'run']);
  assert.deepEqual(calls[0].argv, ['get', '--json', '--', runtimeId]);
  assert.deepEqual(calls[1].argv, ['kill', '--json', '--', runtimeId]);
  assert.deepEqual(calls[2].argv, ['rm', '--json', '--', runtimeId]);
  assert.deepEqual(calls[3].argv.slice(7, 9), ['--name', runtimeId]);
  // sessionId проваливается в devin -r внутри терминала.
  const separator = calls[3].argv.indexOf('--');
  assert.deepEqual(calls[3].argv.slice(separator + 1), ['devin', '--model', 'swe-2-1-medium',
    '-r', 'ses-7', '--prompt-file', '/tmp/prompt.md']);
});

test('hc resume never clobbers a live terminal under the same name', async () => {
  for (const liveTerminal of [
    { state: 'live', status: { state: 'working' } },
    { state: 'live', status: { state: 'idle' } },
    { state: 'live', status: { state: 'done' } },
  ]) {
    const { calls, exec } = hcMock(async (command, argv) => {
      if (argv[0] === 'get') return { stdout: JSON.stringify(liveTerminal) };
      if (argv[0] === 'run') return { stdout: JSON.stringify({ address: 't-x' }) };
      if (argv[0] === 'kill') return { stdout: JSON.stringify({ state: 'finished' }) };
      throw new Error(`unexpected ${argv[0]}`);
    });
    const runtime = createWorkerRuntime({ kind: 'hc', exec, readFile: async () => 'prompt' });
    await assert.rejects(() => runtime.resume({ ...SPAWN, runtimeId: 'df-live-0123456789' }),
      /worker_runtime_exists/);
    assert.equal(calls.some(call => call.argv[0] === 'run'), false, 'run must never start');
    assert.equal(calls.some(call => call.argv[0] === 'kill'), false, 'a live worker is never killed');
  }
});

test('hc resume proceeds without removal when no terminal exists under the runtime id', async () => {
  const { calls, exec } = hcMock(async (command, argv) => {
    if (argv[0] === 'get') {
      throw Object.assign(new Error('hc get exited 3'), {
        code: 3, stderr: '{"error":{"kind":"not_found","message":"no terminal \\"df-gone\\""}}' });
    }
    if (argv[0] === 'run') return { stdout: JSON.stringify({ address: 't-fresh' }) };
    throw new Error(`unexpected ${argv[0]}`);
  });
  const runtime = createWorkerRuntime({ kind: 'hc', exec, readFile: async () => 'prompt' });
  const resumed = await runtime.resume({ ...SPAWN, runtimeId: 'df-gone-0123456789' });
  assert.equal(resumed.terminalId, 't-fresh');
  assert.deepEqual(calls.map(call => call.argv[0]), ['get', 'run']);
});

test('hc resume fails closed on an unconfirmed terminal probe instead of duplicating the name', async () => {
  const { calls, exec } = hcMock(async (command, argv) => {
    if (argv[0] === 'get') throw Object.assign(new Error('hc server unavailable'), { code: 'ETIMEDOUT' });
    if (argv[0] === 'run') return { stdout: JSON.stringify({ address: 't-dup' }) };
    throw new Error(`unexpected ${argv[0]}`);
  });
  const runtime = createWorkerRuntime({ kind: 'hc', exec, readFile: async () => 'prompt' });
  await assert.rejects(() => runtime.resume({ ...SPAWN, runtimeId: 'df-probe-0123456789' }),
    /hc server unavailable/);
  assert.deepEqual(calls.map(call => call.argv[0]), ['get']);
});

test('hc resume tolerates a kill failure on a finished terminal but requires the removal', async () => {
  const tolerate = hcMock(async (command, argv) => {
    if (argv[0] === 'get') return { stdout: JSON.stringify({ state: 'finished', exit_code: 1 }) };
    if (argv[0] === 'kill') throw new Error('kill unsupported');
    if (argv[0] === 'rm') return { stdout: JSON.stringify({ removed: 't-dead' }) };
    if (argv[0] === 'run') return { stdout: JSON.stringify({ address: 't-new' }) };
    throw new Error(`unexpected ${argv[0]}`);
  });
  const runtime = createWorkerRuntime({ kind: 'hc', exec: tolerate.exec, readFile: async () => 'prompt' });
  const resumed = await runtime.resume({ ...SPAWN, runtimeId: 'df-dead-0123456789' });
  assert.equal(resumed.terminalId, 't-new');

  const rmFails = hcMock(async (command, argv) => {
    if (argv[0] === 'get') return { stdout: JSON.stringify({ state: 'finished', exit_code: 1 }) };
    if (argv[0] === 'kill') return { stdout: JSON.stringify({ state: 'finished' }) };
    if (argv[0] === 'rm') throw new Error('rm refused');
    if (argv[0] === 'run') return { stdout: JSON.stringify({ address: 't-dup' }) };
    throw new Error(`unexpected ${argv[0]}`);
  });
  const strict = createWorkerRuntime({ kind: 'hc', exec: rmFails.exec, readFile: async () => 'prompt' });
  await assert.rejects(() => strict.resume({ ...SPAWN, runtimeId: 'df-dead-0123456789' }), /rm refused/);
  assert.equal(rmFails.calls.some(call => call.argv[0] === 'run'), false);
});

test('hc resume without a runtimeId mints a fresh id and never probes the dead-terminal path', async () => {
  const { calls, exec } = hcMock(async () => ({ stdout: JSON.stringify({ address: 't-resume' }) }));
  const runtime = createWorkerRuntime({ kind: 'hc', exec, readFile: async () => 'prompt' });
  await runtime.resume({ ...SPAWN });
  assert.deepEqual(calls.map(call => call.argv[0]), ['run']);
});

test('subproc child env scrubs sensitive controller variables as defense-in-depth', async () => {
  const launches = [];
  const spawn = (command, argv, options) => {
    launches.push({ command, argv, options });
    return childProcess(8800);
  };
  const env = {
    PATH: '/usr/bin', HOME: '/home/op', EDITOR: 'vi',
    SSH_AUTH_SOCK: '/run/agent.sock', BOARD_TOKEN: 'secret-board', VB_TOKEN: 'secret-vb',
    DF_PROJECT_MEMORY_HMAC_KEY: 'secret-hmac', DF_CONTROL_ROOM_WRITE_TOKEN: 'secret-cr',
  };
  const runtime = createWorkerRuntime({ kind: 'subproc', exec: async () => ({ stdout: '' }),
    env, spawn, readFile: async () => 'prompt' });
  await runtime.spawn({ ...SPAWN, executor: { provider: 'pi', model: 'opencode-go/deepseek-v4.1-flash' } });
  const childEnv = launches[0].options.env;
  assert.equal(childEnv.PATH, '/usr/bin');
  assert.equal(childEnv.HOME, '/home/op');
  assert.equal(childEnv.EDITOR, 'vi');
  for (const key of ['SSH_AUTH_SOCK', 'BOARD_TOKEN', 'VB_TOKEN',
    'DF_PROJECT_MEMORY_HMAC_KEY', 'DF_CONTROL_ROOM_WRITE_TOKEN']) {
    assert.equal(Object.hasOwn(childEnv, key), false, key);
  }
});

test('subproc feedback continuation env is scrubbed on every launch', async () => {
  const launches = [];
  const children = [];
  const spawn = (command, argv, options) => {
    const child = childProcess(9100 + children.length);
    children.push(child);
    launches.push({ command, argv, options });
    return child;
  };
  const runtime = createWorkerRuntime({ kind: 'subproc', exec: async () => ({ stdout: '' }),
    env: { PATH: '/usr/bin', BOARD_TOKEN: 'secret', SSH_AUTH_SOCK: '/sock' },
    spawn, readFile: async () => 'initial' });
  const spawned = await runtime.spawn({ ...SPAWN,
    executor: { provider: 'pi', model: 'opencode-go/deepseek-v4.1-flash' } });
  children[0].emit('exit', 0, null);
  await runtime.feedback({ runtimeId: spawned.runtimeId, message: 'rework' });
  assert.equal(launches.length, 2);
  for (const launch of launches) {
    assert.equal(launch.options.env.PATH, '/usr/bin');
    assert.equal(Object.hasOwn(launch.options.env, 'BOARD_TOKEN'), false);
    assert.equal(Object.hasOwn(launch.options.env, 'SSH_AUTH_SOCK'), false);
  }
});

test('scrubbedWorkerChildEnv is total on empty and minimal input and deterministic on repetition', () => {
  assert.deepEqual(scrubbedWorkerChildEnv({}), {});
  assert.deepEqual(scrubbedWorkerChildEnv(null), {});
  assert.deepEqual(scrubbedWorkerChildEnv(undefined), {});
  const input = { A: '1', BOARD_TOKEN: 'x', VB_TOKEN: 'y', DF_PROJECT_MEMORY_HMAC_KEY: 'z',
    DF_CONTROL_ROOM_WRITE_TOKEN: 'w', SSH_AUTH_SOCK: 's' };
  const first = scrubbedWorkerChildEnv(input);
  assert.deepEqual(first, { A: '1' });
  assert.deepEqual(scrubbedWorkerChildEnv(input), first);
  assert.equal(Object.hasOwn(input, 'BOARD_TOKEN'), true, 'input object is never mutated');
  // Одноимённые lowercase/похожие ключи не затрагиваются — точное совпадение.
  const near = { board_token: 'keep', BOARD_TOKEN2: 'keep', DF_PROJECT_MEMORY_HMAC_KEY_FILE: 'keep' };
  assert.deepEqual(scrubbedWorkerChildEnv(near), near);
});
