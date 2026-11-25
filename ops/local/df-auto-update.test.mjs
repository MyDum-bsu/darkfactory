import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAutoUpdate } from './df-auto-update.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'df-auto-update-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const repo = join(root, 'repo');
  const stateFile = join(root, 'state', 'auto-update.json');
  await mkdir(join(repo, 'ops/memory-index'), { recursive: true });
  await writeFile(join(repo, 'ops/memory-index/gitmark.py'), '# test gitmark\n');
  await mkdir(join(home, '.npm-global/lib/node_modules/bb-app'), { recursive: true });
  await writeFile(join(home, '.npm-global/lib/node_modules/bb-app/package.json'), '{"version":"1.0.0"}\n');
  await mkdir(join(home, '.npm-global/lib/node_modules/@mariozechner/pi-coding-agent'), { recursive: true });
  await writeFile(join(home, '.npm-global/lib/node_modules/@mariozechner/pi-coding-agent/package.json'), '{"version":"2.0.0"}\n');
  await mkdir(join(home, '.npm-global/bin'), { recursive: true });
  await writeFile(join(home, '.npm-global/bin/bb'), '#!/bin/sh\n');
  await mkdir(join(repo, '.gitmark'), { recursive: true });
  await writeFile(join(repo, '.gitmark/index.db'), '0');
  return { root, home, repo, stateFile, hubDocs: join(root, 'hub-docs') };
}

function isMutating([command, args]) {
  const line = [command, ...args].join(' ');
  return args[0] === 'update' ||
    line.includes('bb updates apply') ||
    line.includes('bb plugin update --all') ||
    args[0] === 'install' ||
    line.includes('git -C') && (args.includes('fetch') || args.includes('pull') || args.includes('reset')) ||
    line.includes('systemctl --user restart') ||
    line.includes('gitmark.py index');
}

function fakeHarness(env, overrides = {}) {
  const calls = [];
  let agyVersion = 'agy 1.0.0';
  let devinVersion = 'devin 1.0.0';
  let bbVersion = 'bb 1.0.0';
  let head = 'a'.repeat(40);
  const versions = { 'bb-app': '1.1.0', '@mariozechner/pi-coding-agent': '2.1.0' };
  const writePackage = async (pkg, version) => {
    const file = join(env.home, '.npm-global/lib/node_modules', ...pkg.split('/'), 'package.json');
    await writeFile(file, `${JSON.stringify({ version })}\n`);
  };
  const runner = async (command, args = []) => {
    calls.push([command, args]);
    const line = [command, ...args].join(' ');
    const ok = stdout => ({ code: 0, stdout, stderr: '' });
    if (command === 'ps') return ok('');
    if (args[0] === '--version' && command === 'agy') return ok(`${agyVersion}\n`);
    if (args[0] === '--version' && command === 'devin') return ok(`${devinVersion}\n`);
    if (args[0] === '--version' && command === 'bb') return ok(`${bbVersion}\n`);
    if (command === 'agy' && args[0] === 'update') {
      if (overrides.failAgy) return { code: 1, stdout: '', stderr: 'agy failed' };
      agyVersion = 'agy 1.1.0';
      return ok('updated\n');
    }
    if (command === 'devin' && args[0] === 'update') {
      devinVersion = 'devin 1.1.0';
      return ok('updated\n');
    }
    if (command === 'bb' && (line === 'bb updates apply' || line === 'bb plugin update --all --yes')) {
      bbVersion = 'bb 1.1.0';
      return ok('updated\n');
    }
    if (command === 'npm' && args[0] === 'view') return ok(`${versions[args[1]]}\n`);
    if (command === 'npm' && args[0] === 'install') {
      const pkg = args[2].replace(/@latest$/, '');
      await writePackage(pkg, versions[pkg]);
      return ok('installed\n');
    }
    if (command.endsWith('/bin/bb') && args[0] === '--version') return ok('bb-app smoke\n');
    if (command === 'systemctl') return ok('restarted\n');
    if (command === 'git') {
      const gitArgs = args.slice(2);
      const key = gitArgs.join(' ');
      if (key === 'rev-parse --is-inside-work-tree') return ok('true\n');
      if (key === 'status --porcelain') return ok(overrides.dirty ? ' M dirty-file\n' : '');
      if (key === 'rev-parse --abbrev-ref --symbolic-full-name @{u}') return ok('origin/main\n');
      if (key === 'rev-parse HEAD') return ok(`${head}\n`);
      if (key === 'fetch --prune' || key === 'pull --ff-only') {
        if (key === 'pull --ff-only') head = 'b'.repeat(40);
        return ok('');
      }
    }
    if (command === 'python3' && args[1] === 'index') {
      const db = join(args[2], '.gitmark/index.db');
      if (args[2] === env.repo) await writeFile(db, `indexed-${calls.length}`);
      return ok('indexed\n');
    }
    return { code: 127, stdout: '', stderr: `unexpected command: ${line}` };
  };
  return {
    calls,
    runner,
    homedir: env.home,
    processList: overrides.processList ?? '',
    commandExists: async command => ['agy', 'devin', 'bb', 'python3'].includes(command),
  };
}

function options(env, role, extra = {}) {
  return { role, repo: env.repo, stateFile: env.stateFile, hubDocs: env.hubDocs, ...extra };
}

for (const busyLine of [
  '123 /usr/local/bin/agy worker',
  '456 /opt/devin/devin run',
  '789 node /factory/board_pipeline/run-isolated.mjs --execute',
]) {
  test(`idle guard defers updates while active work exists: ${busyLine}`, async t => {
    const env = await fixture(t);
    const harness = fakeHarness(env, { processList: busyLine });
    const report = await runAutoUpdate(options(env, 'hub'), harness);
    assert.equal(report.status, 'deferred_busy');
    assert.equal(report.busy, true);
    assert.ok(report.components.some(component => component.name === 'agy' && component.status === 'deferred_busy'));
    assert.equal(report.components.filter(component => component.status === 'deferred_busy').length, 7);
    assert.equal(harness.calls.filter(isMutating).length, 0);
    const persisted = JSON.parse(await readFile(env.stateFile, 'utf8'));
    assert.equal(persisted.status, 'deferred_busy');
    assert.equal(persisted.ok, true);
  });
}


test('process scan failure is fail-closed and defers without mutations', async t => {
  const env = await fixture(t);
  const harness = fakeHarness(env);
  delete harness.processList;
  const originalRunner = harness.runner;
  harness.runner = async (command, args) => {
    if (command === 'ps') return { code: 1, stdout: '', stderr: 'ps unavailable' };
    return originalRunner(command, args);
  };
  const report = await runAutoUpdate(options(env, 'worker'), harness);
  assert.equal(report.status, 'deferred_busy');
  assert.deepEqual(report.busyProcesses, ['process_scan_unavailable']);
  assert.equal(harness.calls.filter(isMutating).length, 0);
});

for (const role of ['laptop', 'brain', 'hub', 'worker']) {
  test(`dry-run plans applicable components for role ${role} without mutations`, async t => {
    const env = await fixture(t);
    const harness = fakeHarness(env);
    const report = await runAutoUpdate(options(env, role, { dryRun: true }), harness);
    assert.equal(report.status, 'dry_run');
    assert.equal(report.ok, true);
    const byName = Object.fromEntries(report.components.map(component => [component.name, component]));
    for (const name of ['agy', 'devin', 'bb', 'pi', 'darkfactory', 'gitmark']) {
      assert.equal(byName[name].status, 'dry_run', `${role}/${name}`);
    }
    assert.equal(byName['bb-app'].status, ['laptop', 'hub'].includes(role) ? 'dry_run' : 'skipped_role');
    assert.equal(harness.calls.filter(isMutating).length, 0);
  });
}

test('dirty darkfactory repository is skipped safely and never reset', async t => {
  const env = await fixture(t);
  const harness = fakeHarness(env, { dirty: true });
  const report = await runAutoUpdate(options(env, 'worker'), harness);
  const git = report.components.find(component => component.name === 'darkfactory');
  assert.equal(git.status, 'skipped_dirty');
  assert.equal(git.before, 'a'.repeat(40));
  assert.equal(git.after, git.before);
  const gitCalls = harness.calls.filter(([command]) => command === 'git').map(([, args]) => args.join(' '));
  assert.ok(!gitCalls.some(line => line.includes('fetch') || line.includes('pull') || line.includes('reset')));
});

test('one tool failure does not stop remaining updates; atomic state report is valid', async t => {
  const env = await fixture(t);
  const harness = fakeHarness(env, { failAgy: true });
  const report = await runAutoUpdate(options(env, 'hub'), harness);
  const byName = Object.fromEntries(report.components.map(component => [component.name, component]));
  assert.equal(report.status, 'partial_failure');
  assert.equal(report.ok, false);
  assert.equal(byName.agy.status, 'failed');
  assert.match(byName.agy.error, /agy failed/);
  assert.equal(byName.devin.status, 'updated');
  assert.equal(byName.bb.status, 'updated');
  assert.equal(byName['bb-app'].status, 'updated');
  assert.equal(byName.pi.status, 'updated');
  assert.equal(byName.darkfactory.status, 'updated');
  assert.equal(byName.gitmark.status, 'updated');
  assert.ok(harness.calls.some(([command, args]) => command === 'systemctl' && args.includes('restart')));
  const persistedRaw = await readFile(env.stateFile, 'utf8');
  const persisted = JSON.parse(persistedRaw);
  assert.equal(persisted.status, 'partial_failure');
  assert.equal(persisted.components.length, report.components.length);
  assert.equal((await stat(env.stateFile)).mode & 0o777, 0o600);
});

test('forced run still does not restart bb-hub while agents are active', async t => {
  const env = await fixture(t);
  const harness = fakeHarness(env, { processList: '123 /usr/local/bin/agy worker' });
  const report = await runAutoUpdate(options(env, 'hub', { force: true }), harness);
  assert.equal(report.busy, true);
  assert.equal(report.components.find(component => component.name === 'bb-app').status, 'updated');
  assert.ok(!harness.calls.some(([command]) => command === 'systemctl'));
});

test('systemd templates contain required unit, service and timer fields', async () => {
  const service = await readFile(new URL('./df-auto-update.service.in', import.meta.url), 'utf8');
  const timer = await readFile(new URL('./df-auto-update.timer.in', import.meta.url), 'utf8');
  for (const required of ['[Unit]', '[Service]', 'Type=oneshot', 'Nice=', 'IOSchedulingClass=idle', 'ExecStart=']) {
    assert.ok(service.includes(required), required);
  }
  for (const required of ['[Unit]', '[Timer]', 'OnCalendar=*-*-* 04:30:00', 'RandomizedDelaySec=900', 'Persistent=true']) {
    assert.ok(timer.includes(required), required);
  }
});
