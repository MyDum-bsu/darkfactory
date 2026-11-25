import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { extractHookCommand, inspectCommand } from './cmd-guard-hook.mjs';
import agyTools from '../../board_pipeline/agy-tools.cjs';

const hook = new URL('./cmd-guard-hook.mjs', import.meta.url).pathname;

async function runHook(args, input = null) {
  const result = spawnSync(process.execPath, [hook, ...args], {
    input: input ?? '',
    encoding: 'utf8',
    timeout: 5000,
  });
  return { code: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

const redTeam = [
  'rm -rf /',
  'git push --force origin main',
  'gcloud compute instances delete vm-1 --quiet',
  'psql -c "DROP TABLE users"',
  "bash -c 'rm -rf /'",
];

test('inspectCommand blocks deterministic red-team commands as CRITICAL', () => {
  for (const command of redTeam) {
    const result = inspectCommand(command);
    assert.equal(result.decision, 'deny', command);
    assert.equal(result.severity, 'CRITICAL', command);
    assert.ok(result.reason, command);
  }
});

test('inspectCommand allows the approved regeneration and safe-development allowlist', () => {
  for (const command of ['rm -rf node_modules', 'git push --force-with-lease origin feature', 'npm test']) {
    assert.deepEqual(inspectCommand(command), { decision: 'allow' }, command);
  }
});

test('--check exits 0 for allowlisted commands and 2 with JSON for blocked commands', async () => {
  const allowed = await runHook(['--check', 'npm test']);
  assert.equal(allowed.code, 0);
  assert.deepEqual(JSON.parse(allowed.stdout), { decision: 'allow' });

  const blocked = await runHook(['--check', 'rm -rf /']);
  assert.equal(blocked.code, 2);
  const denial = JSON.parse(blocked.stdout);
  assert.equal(denial.decision, 'deny');
  assert.equal(denial.severity, 'CRITICAL');
});

test('--stdin-json accepts direct command and shell tool payload forms', async () => {
  for (const payload of [
    { command: 'npm test' },
    { toolCall: { name: 'shell', args: { command: 'npm test' } } },
    { toolCall: { name: 'bash', args: { command: 'git push --force-with-lease' } } },
  ]) {
    const result = await runHook(['--stdin-json'], JSON.stringify(payload));
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { decision: 'allow' });
  }
});

test('--stdin-json denies red-team shell payload before execution', async () => {
  const result = await runHook(['--stdin-json'], JSON.stringify({
    toolCall: { name: 'shell', args: { command: "bash -c 'rm -rf /'" } },
  }));
  assert.equal(result.code, 2);
  const denial = JSON.parse(result.stdout);
  assert.equal(denial.decision, 'deny');
  assert.equal(denial.severity, 'CRITICAL');
});

test('--stdin-json denies shell argv wrapper evasion after POSIX quoting', async () => {
  for (const payload of [
    { toolCall: { name: 'exec', args: { argv: ['bash', '-c', 'rm -rf /'] } } },
    { toolCall: { name: 'shell', args: { argv: ['sh', '-c', 'rm -rf /'] } } },
  ]) {
    const result = await runHook(['--stdin-json'], JSON.stringify(payload));
    assert.equal(result.code, 2, result.stdout);
    const denial = JSON.parse(result.stdout);
    assert.equal(denial.decision, 'deny');
    assert.equal(denial.severity, 'CRITICAL');
  }
});

test('--stdin-json fails closed on malformed toolCall shapes', async () => {
  for (const payload of [
    { toolCall: {} },
    { toolCall: [] },
    { toolCall: { name: '', args: { command: 'rm -rf /' } } },
    { toolCall: { name: 123, args: { command: 'rm -rf /' } } },
  ]) {
    const result = await runHook(['--stdin-json'], JSON.stringify(payload));
    assert.equal(result.code, 2, JSON.stringify(payload));
    const denial = JSON.parse(result.stdout);
    assert.equal(denial.decision, 'deny');
    assert.equal(denial.severity, 'CRITICAL');
  }
});

test('--stdin-json fails closed on malformed JSON, missing command, and oversized input', async () => {
  for (const input of ['not-json', JSON.stringify({ toolCall: { name: 'shell', args: {} } })]) {
    const result = await runHook(['--stdin-json'], input);
    assert.equal(result.code, 2, input);
    assert.equal(JSON.parse(result.stdout).decision, 'deny');
  }
  const large = JSON.stringify({ command: 'npm test', padding: 'x'.repeat(1024 * 1024 + 8) });
  const result = await runHook(['--stdin-json'], large);
  assert.equal(result.code, 2);
  assert.equal(JSON.parse(result.stdout).decision, 'deny');
});

test('--stdin-json fails closed when the hook input never finishes', async () => {
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hook, '--stdin-json'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('hook did not fail closed within one second'));
    }, 1000);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', code => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
  assert.equal(result.code, 2, result.stderr);
  const denial = JSON.parse(result.stdout);
  assert.equal(denial.decision, 'deny');
  assert.match(denial.reason, /timeout/);
});

test('extractHookCommand ignores non-command tools while keeping shell commands applicable', () => {
  assert.deepEqual(extractHookCommand({ toolCall: { name: 'read_file', args: { Path: 'x' } } }),
    { command: null, applies: false });
  assert.deepEqual(extractHookCommand({ toolCall: { name: 'shell', args: { cmd: 'npm test' } } }),
    { command: 'npm test', applies: true });
});

test('agy read-only snapshot tool allowlist still rejects shell and command tools', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agy-strict-'));
  try {
    await mkdir(join(root, 'candidate'), { recursive: true });
    await writeFile(join(root, 'candidate', 'file.txt'), 'safe');
    assert.equal(agyTools.isSnapshotTool('shell'), false);
    assert.equal(agyTools.isSnapshotTool('bash'), false);
    assert.equal(agyTools.isSnapshotTool('command'), false);
    assert.throws(() => agyTools.checkSnapshotTool(root, 'shell', { command: 'npm test' }),
      /review_tool_use_forbidden/);
    const read = agyTools.checkSnapshotTool(root, 'read_file', { Path: 'candidate/file.txt' });
    assert.equal(read.path, 'candidate/file.txt');
    assert.throws(() => agyTools.checkSnapshotTool(root, 'read_file', { Path: '../outside' }),
      /review_tool_use_forbidden/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('agy-pre-tool hook emits deny for shell tools without weakening snapshot reads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agy-pre-tool-'));
  try {
    const snapshot = join(root, 'snapshot');
    const control = join(root, 'control');
    const events = join(root, 'events');
    await mkdir(join(snapshot, 'candidate'), { recursive: true });
    await mkdir(control, { recursive: true });
    await mkdir(events, { recursive: true });
    await writeFile(join(snapshot, 'candidate', 'file.txt'), 'safe');
    const preTool = new URL('../../board_pipeline/agy-pre-tool.cjs', import.meta.url).pathname;
    const runPreTool = toolCall => spawnSync(process.execPath, [preTool, snapshot, control, events], {
      input: JSON.stringify({ toolCall, stepIdx: 0 }), encoding: 'utf8', timeout: 5000 });

    const denied = runPreTool({ name: 'shell', args: { command: 'npm test' } });
    assert.equal(denied.status, 0, denied.stderr);
    assert.equal(JSON.parse(denied.stdout).decision, 'deny');
    assert.match(JSON.parse(denied.stdout).reason, /review_tool_use_forbidden/);

    const allowed = runPreTool({ name: 'read_file', args: { Path: 'candidate/file.txt' } });
    assert.equal(allowed.status, 0, allowed.stderr);
    assert.equal(JSON.parse(allowed.stdout).decision, 'allow');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
