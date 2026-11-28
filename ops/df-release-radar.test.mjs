import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { runReleaseRadar } from './df-release-radar.mjs';

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'release-radar-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const dir = join(home, '.local/share/vercel-board/node_modules/@vercel/board');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'package.json'), '{"version":"0.54.0"}');
  return home;
}

test('Board feature digest uses version-pinned published documentation, not candidate code', async t => {
  const home = await fixture(t);
  const calls = [];
  const runner = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === 'npm' && args.join(' ') === 'view @vercel/board version') return { code: 0, stdout: '0.57.0' };
    if (cmd === 'npm' && args[0] === 'diff' && args.includes('--diff=@vercel/board@0.54.0') &&
      args.includes('--diff=@vercel/board@0.57.0')) return { code: 0, stdout: '+++ b/docs/04-reference/01-cli.md\n@@ -1,1 +1,2 @@\n-vb old-claim\n+vb claim-ready --json\n+vb tasks batch\n' };
    return { code: 127, stdout: '' };
  };
  const report = await runReleaseRadar({ dryRun: true }, { home, runner });
  const board = report.components.find(x => x.name === '@vercel/board');
  assert.equal(board.jump, 'minor');
  assert.match(board.recommendation, /review/i);
  assert.match(board.recommendation, /claim-ready/);
  assert.deepEqual(board.features.removed, ['vb old-claim']);
  assert.ok(!calls.some(a => a.includes('install') || a.includes('update') || a.includes('exec')));
});

test('local candidate help snapshot compares capabilities; invalid latest is unknown', async t => {
  const home = await fixture(t);
  await writeFile(join(home, 'hc.json'), JSON.stringify({ version: '2.0.0', help: 'run\nwatch --json\n' }));
  const runner = async (cmd, args) => {
    if (cmd === 'hc') return { code: 0, stdout: args[0] === '--version' ? 'hc 1.9.0' : 'run\n' };
    if (cmd === 'npm') return { code: 0, stdout: '1.02.3' };
    return { code: 127, stdout: '' };
  };
  const report = await runReleaseRadar({ candidateDir: home }, { home, runner });
  const hc = report.components.find(x => x.name === 'herdr-core');
  assert.equal(hc.jump, 'major');
  assert.deepEqual(hc.features.added, ['watch --json']);
  assert.equal(report.components.find(x => x.name === '@vercel/board').status, 'unknown');
});

test('SemVer boundaries suppress feature probes unless the major or minor increases', async t => {
  const home = await fixture(t);
  for (const [latest, status, jump] of [
    ['0.54.0+build', 'current'], ['0.54.0-rc.2', 'ahead'], ['0.54.1', 'update_available', 'patch'], ['', 'unknown'],
  ]) {
    const npm = [];
    const runner = async (cmd, args) => {
      if (cmd !== 'npm') return { code: 127 };
      npm.push(args);
      return { code: 0, stdout: latest };
    };
    const board = (await runReleaseRadar({}, { home, runner })).components[0];
    assert.equal(board.status, status);
    assert.equal(board.jump, jump);
    assert.deepEqual(npm, [['view', '@vercel/board', 'version']]);
  }
});

test('changelog highlights are actionable; a failed documentation probe is not a failed version probe', async t => {
  const home = await fixture(t);
  for (const code of [0, 1]) {
    const runner = async (cmd, args) => {
      if (cmd !== 'npm') return { code: 127 };
      if (args[0] === 'view') return { code: 0, stdout: '1.0.0' };
      return { code, stdout: '+++ b/CHANGELOG.md\n+# 1.0.0\n+- Inspect tasks with --summary\n' };
    };
    const board = (await runReleaseRadar({}, { home, runner })).components[0];
    assert.equal(board.jump, 'major');
    assert.equal(board.status, 'update_available');
    if (code === 0) assert.match(board.recommendation, /Inspect tasks with --summary/);
    else assert.match(board.recommendation, /no capability evidence/);
  }
});

test('hc reads the official manifest and hex reports an exact catalog id only', async t => {
  const home = await fixture(t);
  const runner = async (cmd, args) => {
    if (cmd === 'hc' && args.join(' ') === '--version') return { code: 0, stdout: 'hc 0.1.9' };
    if (cmd === 'curl' && args.at(-1) === 'https://releases.herdr.dev/core/latest.json') return { code: 0, stdout: '{"version":"0.1.10"}' };
    if (cmd === 'hex' && args.join(' ') === 'models list') return { code: 0, stdout: '["gigaam_v4_preview"]' };
    return { code: 127 };
  };
  const { components } = await runReleaseRadar({ role: 'laptop' }, { home, runner });
  assert.equal(components.find(x => x.name === 'herdr-core').jump, 'patch');
  assert.equal(components.find(x => x.name === 'hex').available, false);
});

test('CLI JSON is directly consumable with an empty offline inventory', async t => {
  const home = await mkdtemp(join(tmpdir(), 'radar-cli-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const cli = fileURLToPath(new URL('./df-release-radar.mjs', import.meta.url));
  const report = JSON.parse(execFileSync(process.execPath, [cli, '--dry-run', '--json'], { env: { HOME: home, PATH: '' } }));
  assert.equal(report.schema, 'df-release-radar.v1');
  assert.equal(report.dryRun, true);
  assert.ok(report.components.every(c => c.status === 'not_installed'));
});
