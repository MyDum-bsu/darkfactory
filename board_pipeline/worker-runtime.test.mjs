import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { buildExecutorCommand, buildFollowUpMessage, createWorkerRuntime } from './worker-runtime.mjs';

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
  for (const built of [devin, pi, agy]) {
    assert.equal(built.argv.includes('sh'), false);
    assert.equal(built.argv.includes('bash'), false);
    assert.equal(built.argv.filter(arg => arg === prompt).length, 1);
  }
  assert.throws(() => buildExecutorCommand({ provider: 'bogus', model: 'x' }, { prompt }), /executor_unsupported/);
  assert.throws(() => buildExecutorCommand({ provider: 'pi', model: 'x' }, { prompt: '' }), /worker_prompt_invalid/);
  assert.throws(() => buildExecutorCommand({ provider: 'pi' }, { prompt }), /executor_model_invalid/);
});

test('hc spawn uses run --bg --keep, labels, and a shell-free argv tail', async () => {
  const prompt = 'worker prompt with spaces; $(not_shell) `literal`';
  const { calls, exec } = hcMock(async () => ({ stdout: JSON.stringify({ address: 't7', pid: 123 }) }));
  const runtime = createWorkerRuntime({ kind: 'hc', exec, env: { MARKER: '1' }, readFile: async () => prompt });
  const spawned = await runtime.spawn(SPAWN);
  assert.deepEqual(spawned, { runtimeId: 't7', transport: 'hc', terminalId: 't7', pid: 123 });
  assert.equal(calls.length, 1);
  const { command, argv, options } = calls[0];
  assert.equal(command, 'hc');
  assert.deepEqual(argv.slice(0, 6), ['run', '--bg', '--keep', '--json', '--cwd', '/tmp/worktree']);
  assert.equal(options.env.MARKER, '1');
  const labels = argv.filter((arg, i) => argv[i - 1] === '--label');
  assert.ok(labels.includes('darkfactory.task=3840'));
  assert.ok(labels.includes('darkfactory.attempt=attempt-1'));
  assert.ok(labels.includes('darkfactory.executor=devin'));
  assert.ok(labels.includes('herdr.space=Factory'));
  assert.ok(labels.includes('herdr.tab=Task 3840'));
  const separator = argv.indexOf('--');
  assert.deepEqual(argv.slice(separator + 1),
    ['devin', '--model', 'swe-2-1-medium', '--', prompt]);
  assert.equal(argv.includes('sh'), false);
  assert.equal(argv.includes('bash'), false);
});

test('hc feedback, observe and stop map CLI results to the runtime contract', async () => {
  const { calls, exec } = hcMock(async (command, argv) => {
    if (argv[0] === 'send') return { stdout: JSON.stringify({ turn: 3, started: true, status: 'idle' }) };
    if (argv[0] === 'get') return { stdout: JSON.stringify({ state: 'live', status: { state: 'blocked' } }) };
    if (argv[0] === 'read') return { stdout: JSON.stringify({ text: 'line 1\nline 2\n' }) };
    if (argv[0] === 'kill') return { stdout: JSON.stringify({ state: 'finished', exit_code: 0, reason: 'killed' }) };
    throw new Error(`unexpected ${argv[0]}`);
  });
  const runtime = createWorkerRuntime({ kind: 'hc', exec });
  assert.deepEqual(await runtime.feedback({ runtimeId: 't7', message: 'fix the red test' }),
    { delivered: true, turn: 3, started: true, status: 'idle' });
  assert.deepEqual(await runtime.observe({ runtimeId: 't7' }), { state: 'blocked', tail: 'line 1\nline 2\n' });
  assert.deepEqual(await runtime.stop({ runtimeId: 't7' }), { stopped: true, state: 'exited', exitCode: 0 });
  assert.deepEqual(calls[0].argv, ['send', '--json', 't7', 'fix the red test']);
  assert.deepEqual(calls[1].argv, ['get', '--json', 't7']);
  assert.deepEqual(calls[2].argv, ['read', '--json', '--lines', '40', 't7']);
  assert.deepEqual(calls[3].argv, ['kill', '--json', 't7']);
});

test('hc observe treats a finished terminal as exited even when its exit code is non-zero', async () => {
  const { exec } = hcMock(async (command, argv) => argv[0] === 'get'
    ? { stdout: JSON.stringify({ state: 'finished', exit_code: 2, reason: 'exited' }) }
    : { stdout: JSON.stringify({ text: 'failure tail' }) });
  const runtime = createWorkerRuntime({ kind: 'hc', exec });
  assert.deepEqual(await runtime.observe({ runtimeId: 't9' }),
    { state: 'exited', exitCode: 2, tail: 'failure tail' });
});

test('probeAvailability probes hc plus the executor and classifies missing tools', async () => {
  const missing = Object.assign(new Error('spawn hc ENOENT'), { code: 'ENOENT' });
  const { calls, exec } = hcMock(async command => {
    if (command === 'hc') throw missing;
    return { stdout: 'devin 1' };
  });
  const runtime = createWorkerRuntime({ kind: 'hc', exec });
  assert.deepEqual(await runtime.probeAvailability({ provider: 'acp-devin', model: 'swe-2-1-medium' }),
    { status: 'unavailable', reason: 'hc_not_found' });
  assert.deepEqual(calls.map(call => [call.command, call.argv]), [['hc', ['--version']]]);
  assert.deepEqual(await runtime.probeAvailability({ provider: 'bogus', model: 'x' }),
    { status: 'unavailable', reason: 'executor_unsupported' });
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
  assert.deepEqual(spawned, { runtimeId: 'subproc-1', transport: 'subproc', pid: 4321 });
  assert.equal(launches[0].command, 'pi');
  assert.deepEqual(launches[0].argv, ['--model', 'openai/gpt-6.2-sol', '--thinking', 'medium',
    '--print', '--', 'initial prompt']);
  assert.equal(launches[0].options.cwd, '/tmp/worktree');
  assert.equal(launches[0].options.env.SUBPROC_TEST, '1');
  assert.deepEqual(await runtime.observe({ runtimeId: spawned.runtimeId }), { state: 'working' });
  children[0].stdout.emit('data', 'worker output');
  children[0].emit('exit', 0, null);
  assert.deepEqual(await runtime.observe({ runtimeId: spawned.runtimeId }),
    { state: 'done', exitCode: 0, tail: 'worker output' });
  assert.deepEqual(await runtime.observe({ runtimeId: 'missing' }), { state: 'exited' });
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
  assert.deepEqual(await runtime.stop({ runtimeId: spawned.runtimeId }),
    { stopped: true, state: 'working', signal: 'SIGTERM' });
  assert.equal(children[1].killed, 'SIGTERM');
  children[1].emit('exit', 143, 'SIGTERM');
  assert.deepEqual(await runtime.stop({ runtimeId: spawned.runtimeId }),
    { stopped: false, state: 'exited', exitCode: 143 });
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
