import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compareVersions, findBusyProcesses, runAutoUpdate } from './df-auto-update.mjs';

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

test('busy flip after npm install defers bb-hub restart at the final gate', async t => {
  const env = await fixture(t);
  let busy = false;
  const harness = fakeHarness(env, {
    processList: () => busy ? '123 /usr/local/bin/agy worker' : '',
  });
  const originalRunner = harness.runner;
  harness.runner = async (command, args = []) => {
    const result = await originalRunner(command, args);
    if (command === 'npm' && args[0] === 'install' && args[2] === 'bb-app@latest') busy = true;
    return result;
  };
  const report = await runAutoUpdate(options(env, 'hub'), harness);
  const bbApp = report.components.find(component => component.name === 'bb-app');
  assert.equal(bbApp.status, 'updated');
  assert.equal(bbApp.restart, 'deferred_busy');
  assert.match(bbApp.note, /active work detected after install/);
  assert.ok(!harness.calls.some(([command, args]) => command === 'systemctl' && args.includes('restart')));
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

test('compareVersions: basic ordering, equality and range boundaries', () => {
  assert.equal(compareVersions('1.1.0', '1.0.0'), true);
  assert.equal(compareVersions('1.0.0', '1.1.0'), false);
  assert.equal(compareVersions('1.0.0', '1.0.0'), false);
  assert.equal(compareVersions('10.0.0', '9.9.9'), true);
  assert.equal(compareVersions('0.0.1', '0.0.0'), true);
  // Numeric components compare exactly beyond the 2^53 integer precision limit.
  assert.equal(compareVersions('1.2.9007199254740993', '1.2.9007199254740992'), true);
  assert.equal(compareVersions('1.2.9007199254740992', '1.2.9007199254740993'), false);
});

test('compareVersions: release outranks its prerelease, never downgrades', () => {
  // An installed prerelease must update to the released version (boundary).
  assert.equal(compareVersions('1.2.3', '1.2.3-beta'), true);
  assert.equal(compareVersions('1.2.3-beta', '1.2.3'), false);
  assert.equal(compareVersions('1.2.3-beta', '1.2.3-beta'), false);
  assert.equal(compareVersions('1.2.3-beta.2', '1.2.3-beta.1'), true);
  assert.equal(compareVersions('1.2.3-beta.1', '1.2.3-beta.2'), false);
  assert.equal(compareVersions('1.2.3-beta.10', '1.2.3-beta.2'), true);
  assert.equal(compareVersions('1.2.3-beta.2', '1.2.3-beta.10'), false);
  // Numeric identifiers rank below alphanumeric ones; fewer fields rank lower.
  assert.equal(compareVersions('1.2.3-alpha', '1.2.3-1'), true);
  assert.equal(compareVersions('1.2.3-1', '1.2.3-alpha'), false);
  assert.equal(compareVersions('1.2.3-alpha.1', '1.2.3-alpha'), true);
  assert.equal(compareVersions('1.2.3-alpha', '1.2.3-alpha.1'), false);
  // Build metadata does not affect precedence.
  assert.equal(compareVersions('1.2.3+build', '1.2.3'), false);
  assert.equal(compareVersions('1.2.3', '1.2.3+build'), false);
  assert.equal(compareVersions('1.2.3+b.2', '1.2.3+b.1'), false);
});

test('compareVersions: empty, minimal and null/undefined input never updates', () => {
  for (const bad of ['', ' ', 'v1.2.3', '1.2', '1.2.3.4', 'latest', '1.2.x', '1.2.3-']) {
    assert.equal(compareVersions(bad, '1.0.0'), false, JSON.stringify(bad));
    assert.equal(compareVersions('1.0.0', bad), false, JSON.stringify(bad));
  }
  for (const bad of [null, undefined, 0, 1.5, {}, [], false]) {
    assert.equal(compareVersions(bad, '1.0.0'), false, String(bad));
    assert.equal(compareVersions('1.0.0', bad), false, String(bad));
  }
});

test('compareVersions: leading zeros in numeric identifiers are invalid semver', () => {
  // Strict SemVer 2.0.0 forbids leading zeros in numeric identifiers.
  // Accepting '01' as equal to '1' would make distinct strings numerically
  // equal and terminate the prerelease comparison before later fields,
  // breaking the total order — such input is rejected instead (no update).
  for (const bad of ['1.2.3-01.2', '1.2.3-01.1', '1.2.3-01', '01.2.3', '1.02.3', '1.2.03']) {
    assert.equal(compareVersions(bad, '1.2.3-1.1'), false, JSON.stringify(bad));
    assert.equal(compareVersions('1.2.3-1.1', bad), false, JSON.stringify(bad));
    assert.equal(compareVersions(bad, bad), false, JSON.stringify(bad));
  }
  // Single zero is a valid numeric identifier; field count still decides.
  assert.equal(compareVersions('1.2.3-0.1', '1.2.3-0'), true);
  assert.equal(compareVersions('1.2.3-0', '1.2.3-0.1'), false);
  // Alphanumeric identifiers may contain leading zeros; numeric ranks lower.
  assert.equal(compareVersions('1.2.3-01a', '1.2.3-1'), true);
  assert.equal(compareVersions('1.2.3-1', '1.2.3-01a'), false);
  // Build metadata may contain leading zeros and never affects precedence.
  assert.equal(compareVersions('1.2.3+001', '1.2.3'), false);
  assert.equal(compareVersions('1.2.3', '1.2.3+001'), false);
});

test('installed prerelease npm package updates to the released version', async t => {
  const env = await fixture(t);
  await writeFile(join(env.home, '.npm-global/lib/node_modules/bb-app/package.json'),
    '{"version":"1.1.0-beta"}\n');
  const harness = fakeHarness(env);
  const report = await runAutoUpdate(options(env, 'hub'), harness);
  const bbApp = report.components.find(component => component.name === 'bb-app');
  assert.equal(bbApp.status, 'updated');
  assert.equal(bbApp.before, '1.1.0-beta');
  assert.equal(bbApp.after, '1.1.0');
  assert.ok(harness.calls.some(([command, args]) =>
    command === 'npm' && args[0] === 'install' && args.includes('bb-app@latest')));
});

test('repeated invocation is idempotent: no reinstall when already current', async t => {
  const env = await fixture(t);
  const first = await runAutoUpdate(options(env, 'hub'), fakeHarness(env));
  assert.equal(first.components.find(component => component.name === 'bb-app').status, 'updated');
  assert.equal(first.components.find(component => component.name === 'pi').status, 'updated');

  const harness = fakeHarness(env);
  const second = await runAutoUpdate(options(env, 'hub'), harness);
  for (const name of ['bb-app', 'pi']) {
    assert.equal(second.components.find(component => component.name === name).status,
      'already_current', name);
  }
  assert.equal(harness.calls.filter(([command, args]) =>
    command === 'npm' && args[0] === 'install').length, 0);
  assert.equal(second.ok, true);
  const persisted = JSON.parse(await readFile(env.stateFile, 'utf8'));
  assert.equal(persisted.status, second.status);
});

test('concurrent invocations never share a tmp path and leave valid state', async t => {
  const env = await fixture(t);
  const [first, second] = await Promise.all([
    runAutoUpdate(options(env, 'hub'), fakeHarness(env)),
    runAutoUpdate(options(env, 'hub'), fakeHarness(env)),
  ]);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  const persisted = JSON.parse(await readFile(env.stateFile, 'utf8'));
  assert.equal(typeof persisted.timestamp, 'string');
  assert.equal(persisted.components.length, first.components.length);
  assert.equal((await stat(env.stateFile)).mode & 0o777, 0o600);
});

test('findBusyProcesses: hc CLI invocations match without false positives', () => {
  // Активная оркестрация --runtime hc: команда в начале строки, после
  // пробела и как basename абсолютного пути — busy.
  for (const line of [
    'hc run --runtime hc task',
    '123 hc run --runtime hc worker',
    '456 /usr/local/bin/hc send task-1',
    'hc',
    '/opt/hc/bin/hc',
  ]) {
    assert.deepEqual(findBusyProcesses(line), [line], JSON.stringify(line));
  }
  // Подстроки внутри других слов не блокируют обновление: 'which',
  // 'dhcpcd', 'hc' как часть аргумента без границы токена.
  for (const line of [
    'which node',
    '/usr/bin/which node',
    'dhcpcd -q',
    '/usr/sbin/dhcpcd eth0',
    'echo xhc',
    'hcwhatever run',
    '',
  ]) {
    assert.deepEqual(findBusyProcesses(line), [], JSON.stringify(line));
  }
  // Многострочный ps-снимок: busy-строки hc возвращаются, прочие нет.
  const snapshot = '1 which node\n2 /usr/local/bin/hc send t\n3 dhcpcd -q\n4 hc run x';
  assert.deepEqual(findBusyProcesses(snapshot),
    ['2 /usr/local/bin/hc send t', '4 hc run x']);
  // Пустой и nullish вход — пустой результат, без исключений.
  assert.deepEqual(findBusyProcesses(''), []);
  assert.deepEqual(findBusyProcesses(null), []);
  assert.deepEqual(findBusyProcesses(undefined), []);
});

test('idle guard defers updates while hc orchestration is active', async t => {
  const env = await fixture(t);
  const harness = fakeHarness(env, { processList: '999 /usr/local/bin/hc send task' });
  const report = await runAutoUpdate(options(env, 'hub'), harness);
  assert.equal(report.status, 'deferred_busy');
  assert.equal(report.busy, true);
  assert.equal(harness.calls.filter(isMutating).length, 0);
});

test('which/dhcpcd process lines do not defer updates', async t => {
  const env = await fixture(t);
  const harness = fakeHarness(env, { processList: '123 which node\n456 dhcpcd -q' });
  const report = await runAutoUpdate(options(env, 'hub'), harness);
  assert.equal(report.busy, false);
  assert.notEqual(report.status, 'deferred_busy');
  assert.ok(harness.calls.filter(isMutating).length > 0);
});
