import assert from 'node:assert/strict';
import test from 'node:test';
import {
  APPROVED_IMPLEMENTATION_MODELS,
  checkPortableHost,
  nodeVersionSupported,
  resolveRuntime,
  runDoctor,
  validateImplementationPreset,
} from './check-host.mjs';

test('doctor implementation preset accepts SWE-2.1 and legacy SWE-2 High, rejects unknown models', () => {
  assert.deepEqual([...APPROVED_IMPLEMENTATION_MODELS], [
    'swe-2-high',
    'swe-2-1-medium',
    'swe-2-1-high',
    'swe-2-1-xhigh',
    'swe-2-1-max',
  ]);
  for (const model of ['swe-2-1-medium', 'swe-2-high']) {
    assert.equal(validateImplementationPreset({ provider: 'acp-devin', model }), true);
  }
  assert.equal(validateImplementationPreset({ provider: 'acp-devin', model: 'swe-2-1-fake' }), false);
  assert.equal(validateImplementationPreset({ provider: 'google', model: 'swe-2-1-medium' }), false);
});

test('doctor runtime resolution uses CLI and env, defaulting to hc even when legacy routes exist', () => {
  const absent = () => false;
  const present = () => true;
  assert.equal(resolveRuntime({ argv: ['--runtime', 'subproc'], env: { DF_WORKER_RUNTIME: 'bb' }, exists: absent }), 'subproc');
  assert.equal(resolveRuntime({ argv: ['--runtime=bb'], env: {}, exists: absent }), 'bb');
  assert.equal(resolveRuntime({ argv: [], env: { DF_WORKER_RUNTIME: 'bb' }, exists: absent }), 'bb');
  assert.equal(resolveRuntime({ argv: [], env: { DF_WORKER_RUNTIME: 'bb' }, exists: present }), 'bb');
  assert.equal(resolveRuntime({ argv: [], env: { DF_WORKER_RUNTIME: 'hc' }, exists: present }), 'hc');
  // Legacy routes.json existence never implies bb: only an explicit
  // --runtime bb or DF_WORKER_RUNTIME=bb selects the legacy runtime.
  assert.equal(resolveRuntime({ argv: [], env: {}, exists: present }), 'hc');
  assert.equal(resolveRuntime({ argv: [], env: {}, exists: absent }), 'hc');
  assert.throws(() => resolveRuntime({ argv: ['--runtime'], env: {}, exists: absent }), /worker_runtime_kind_invalid/);
  assert.throws(() => resolveRuntime({ argv: ['--runtime', 'pty'], env: {}, exists: absent }), /worker_runtime_kind_invalid/);
  assert.throws(() => resolveRuntime({ argv: [], env: { DF_WORKER_RUNTIME: 'pty' }, exists: absent }), /worker_runtime_kind_invalid/);
});

test('portable doctor checks Node, Board channels and portable CLIs without legacy runtime files', () => {
  const calls = [];
  const exec = (command, args, options) => {
    calls.push({ command, args, options });
    if (command === '/opt/vb-bin/vb') return JSON.stringify({ channels: [] });
    return `${command} 1.0\n`;
  };
  const report = checkPortableHost({
    runtimeKind: 'hc', nodeVersion: '22.18.0',
    env: { DF_VB_BIN: '/opt/vb-bin/vb', BOARD_URL: 'http://board.example/api/board' },
    exec,
  });
  assert.deepEqual(report.commands, ['hc', 'devin', 'agy', 'pi']);
  assert.equal(report.board.vb, '/opt/vb-bin/vb');
  assert.deepEqual(calls.map(call => call.command), ['/opt/vb-bin/vb', 'hc', 'devin', 'agy', 'pi']);
  assert.deepEqual(calls[0].args, ['--url', 'http://127.0.0.1:44100/api/board', 'channels', 'list', '--json']);
  assert.equal('BOARD_URL' in calls[0].options.env, false);
  assert.equal(calls.some(call => String(call.command).includes('vercel-board')), false);
  assert.equal(nodeVersionSupported('22.17.99'), false);
  assert.equal(nodeVersionSupported('22.18.0'), true);
  assert.equal(nodeVersionSupported('23.0.0'), true);
});

test('portable doctor falls back to vb in PATH and fails closed when a worker CLI is unavailable', () => {
  const successfulCalls = [];
  const okExec = (command, args, options) => {
    successfulCalls.push({ command, args, options });
    return command === 'vb' ? JSON.stringify({ channels: [] }) : 'ok\n';
  };
  for (const runtimeKind of ['hc', 'subproc']) {
    const report = checkPortableHost({ runtimeKind, env: {}, exec: okExec, nodeVersion: '22.18.0' });
    assert.equal(report.runtime, runtimeKind);
  }
  assert.deepEqual(successfulCalls.map(call => call.command), [
    'vb', 'hc', 'devin', 'agy', 'pi',
    'vb', 'hc', 'devin', 'agy', 'pi',
  ]);
  const failingExec = command => {
    if (command === 'vb') return JSON.stringify({ channels: [] });
    if (command === 'agy') throw new Error('not installed');
    return 'ok\n';
  };
  assert.throws(() => checkPortableHost({ runtimeKind: 'subproc', env: {}, exec: failingExec, nodeVersion: '22.18.0' }),
    /agy CLI is required for subproc runtime/);
  assert.throws(() => checkPortableHost({ runtimeKind: 'hc', env: {}, exec: () => { throw new Error('no vb'); }, nodeVersion: '22.17.0' }),
    /Node 22\.18\+ is required/);
});

test('runDoctor dispatches legacy bb only on explicit flag or env selection', () => {
  const seen = [];
  const checkLegacy = options => {
    seen.push(['legacy', options]);
    return { runtime: 'bb' };
  };
  const checkPortable = options => {
    seen.push(['portable', options.runtimeKind]);
    return { runtime: options.runtimeKind };
  };
  assert.equal(runDoctor({ argv: ['--runtime', 'bb'], env: {}, exists: () => false, checkLegacy, checkPortable }).runtime, 'bb');
  assert.equal(runDoctor({ argv: [], env: { DF_WORKER_RUNTIME: 'bb' }, exists: () => true, checkLegacy, checkPortable }).runtime, 'bb');
  // Existing legacy routes.json does not select bb on its own: the modern
  // default is hc whether or not the legacy runtime files are present.
  assert.equal(runDoctor({ argv: [], env: {}, exists: () => true, checkLegacy, checkPortable }).runtime, 'hc');
  assert.equal(runDoctor({ argv: [], env: {}, exists: () => false, checkLegacy, checkPortable }).runtime, 'hc');
  assert.equal(runDoctor({ argv: [], env: { DF_WORKER_RUNTIME: 'subproc' }, exists: () => true, checkLegacy, checkPortable }).runtime, 'subproc');
  assert.deepEqual(seen.map(entry => entry[0]), ['legacy', 'legacy', 'portable', 'portable', 'portable']);
  assert.deepEqual(seen.filter(entry => entry[0] === 'portable').map(entry => entry[1]), ['hc', 'hc', 'subproc']);
});
