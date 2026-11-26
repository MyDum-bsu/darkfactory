import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildUiVisualL3Profile, evaluateSatisfactionReport, offlineDockerRunner, offlineVisualRunner } from './runtime.mjs';

const IMAGE = `sha256:${'a'.repeat(64)}`;
const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

async function temp(t, prefix) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function git(repo, ...args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

async function repoFixture(t) {
  const root = await temp(t, 'v24-runtime-');
  const repo = join(root, 'worktree');
  await mkdir(repo);
  git(repo, 'init', '-q', '-b', 'pilot');
  git(repo, 'config', 'user.email', 'test@local');
  git(repo, 'config', 'user.name', 'test');
  await writeFile(join(repo, 'page.txt'), 'synthetic\n');
  git(repo, 'add', 'page.txt');
  git(repo, 'commit', '-qm', 'candidate');
  return { root, repo, sha: git(repo, 'rev-parse', 'HEAD') };
}

test('buildUiVisualL3Profile emits synthetic MO Tracker recipe with two viewports and axe capture contract', () => {
  const profile = buildUiVisualL3Profile({ image: IMAGE, argv: ['node', 'visual-check.mjs'] });
  assert.equal(profile.id, 'mo-tracker-ui');
  assert.equal(profile.has_ui, true);
  assert.deepEqual(profile.viewports.map(v => `${v.width}x${v.height}`), ['1440x900', '1024x768']);
  assert.equal(profile.database.kind, 'synthetic');
  assert.equal(profile.database.pii, false);
  assert.equal(profile.database.containerPath, '/tmp/mo-tracker-synthetic/tracker.db');
  assert.equal(profile.visual.env.MO_TRACKER_DB, '/tmp/mo-tracker-synthetic/tracker.db');
  assert.equal(profile.visual.env.MO_TRACKER_DATA, '/tmp/mo-tracker-synthetic');
  for (const needle of ['1440x900', '1024x768', '--axe-core-dump', '/artifacts/axe-core.json',
    '--capture-dir', '/artifacts/captures', 'loading,empty,error,ready']) {
    assert.ok(profile.visual.argv.includes(needle), needle);
  }
  assert.equal(profile.a11y.tool, 'axe-core');
  assert.equal(profile.capturePolicy.maxFileBytes, 2 * 1024 * 1024);
  assert.equal(JSON.stringify(profile).includes('/' + 'home/'), false);
});

test('buildUiVisualL3Profile rejects live tracker DB, host paths and conflicting database inputs', () => {
  const base = { image: IMAGE, argv: ['node', 'visual-check.mjs'] };
  for (const bad of ['tracker/data/tracker.db', './tracker/data/tracker.db', '/tmp/copy/tracker/data/tracker.db',
    '../data/tracker.db', 'tracker/data/./tracker.db', '/tmp/../var/lib/real.db',
    '/tmp/../candidate/tracker/data/./tracker.db', 'file:tracker/data/tracker.db', '',
    '/' + 'home/operator/tracker.db', '/' + 'Users/operator/tracker.db', '/' + 'media/disk/tracker.db',
    '/tmp/production-tracker.db', '/tmp/pii-tracker.db']) {
    assert.throws(() => buildUiVisualL3Profile({ ...base, trackerDb: bad }),
      /mo_tracker_(live_db_forbidden|synthetic_db_invalid)/, bad);
  }
  assert.throws(() => buildUiVisualL3Profile({ ...base, argv: ['node', 'x', 'tracker/data/tracker.db'] }),
    /mo_tracker_visual_recipe_invalid/);
  assert.throws(() => buildUiVisualL3Profile({ ...base, argv: ['node', 'x', '--db=tracker/data/tracker.db'] }),
    /mo_tracker_visual_recipe_invalid/);
  assert.throws(() => buildUiVisualL3Profile({ ...base, argv: ['node', 'x', 'file:tracker/data/./tracker.db'] }),
    /mo_tracker_visual_recipe_invalid/);
  assert.throws(() => buildUiVisualL3Profile({ ...base, syntheticDataDir: '/tmp/../var/data' }),
    /mo_tracker_synthetic_data_invalid/);
  assert.throws(() => buildUiVisualL3Profile({ ...base, trackerDb: '/tmp/a.db', databasePath: '/tmp/b.db' }),
    /mo_tracker_synthetic_db_conflict/);
  assert.throws(() => buildUiVisualL3Profile({ image: 'node:latest', argv: ['node'] }), /operator check profile/);
});

test('offline docker runner applies resource limits and bounds the /tmp tmpfs', async t => {
  const { root, repo, sha } = await repoFixture(t);
  const journal = join(root, 'journal');
  await mkdir(journal);
  const calls = [];
  const execDocker = async (file, args) => {
    calls.push([file, [...args]]);
    if (args[0] === 'info') return { stdout: '["name=rootless"]', stderr: '' };
    if (args[0] === 'run') return { stdout: 'checks ok', stderr: '' };
    if (args[0] === 'rm') return { stdout: '', stderr: '' };
    throw new Error(`unexpected docker call ${args.join(' ')}`);
  };
  const result = await offlineDockerRunner(journal, { execDocker })(
    { task_id: '5029', worktree: repo, candidate_sha: sha },
    { check: { image: IMAGE, argv: ['true'], cwd: '.', timeoutMs: 1000 } });
  assert.equal(result.ok, true);
  const run = calls.find(([, args]) => args[0] === 'run')?.[1];
  assert.ok(run, 'docker run happened');
  for (const flag of ['--pids-limit=256', '--memory=2g', '--memory-swap=2g', '--cpus=2']) {
    assert.ok(run.includes(flag), `offline docker run missing ${flag}`);
  }
  assert.match(run.find(arg => arg.startsWith('--tmpfs=/tmp:')) ?? '', /size=256m/,
    'offline /tmp tmpfs is not bounded to 256m');
});

test('offline visual runner mounts validated holdouts read-only through injected Docker runner', async t => {
  const { root, repo, sha } = await repoFixture(t);
  const journal = join(root, 'journal');
  const holdouts = join(root, 'holdouts');
  await mkdir(journal);
  await mkdir(holdouts);
  await writeFile(join(holdouts, 'scenario.json'), '{"id":"s","assertions":{"unstyledControls":0}}');
  const artifactSource = join(root, 'artifact-source');
  await mkdir(join(artifactSource, 'captures'), { recursive: true });
  await writeFile(join(artifactSource, 'captures', 'mo-tracker-1440x900.png'), PNG_1X1);
  const artifactTar = execFileSync('tar', ['-C', artifactSource, '-cf', '-', '.'], { encoding: 'buffer' });
  const calls = [];
  const execDocker = async (file, args) => {
    calls.push([file, [...args]]);
    if (args[0] === 'info') return { stdout: '["name=rootless"]', stderr: '' };
    if (args[0] === 'run') return { stdout: 'container\n', stderr: '' };
    if (args[0] === 'exec' && args.includes('tar')) return { stdout: artifactTar, stderr: '' };
    if (args[0] === 'exec') return { stdout: 'visual ok', stderr: '' };
    if (args[0] === 'rm') return { stdout: '', stderr: '' };
    throw new Error(`unexpected docker call ${args.join(' ')}`);
  };
  const profile = buildUiVisualL3Profile({ image: IMAGE, argv: ['node', 'visual-check.mjs'], holdoutDir: holdouts });
  const result = await offlineVisualRunner(journal, { execDocker })({ task_id: '1674', worktree: repo, candidate_sha: sha },
    { visual: profile.visual });
  assert.equal(result.ok, true);
  assert.match(result.holdout_digest, /^[a-f0-9]{64}$/);
  assert.equal(result.holdout_files, 1);
  assert.equal(result.capture_count, 1);
  assert.equal((await readFile(join(result.capture_dir, 'mo-tracker-1440x900.png'))).equals(PNG_1X1), true);
  const run = calls.find(([, args]) => args[0] === 'run')?.[1];
  assert.ok(run, 'docker run happened');
  assert.ok(run.includes(`type=bind,src=${holdouts},dst=/holdouts,readonly`));
  const flat = run.join('\n');
  for (const flag of ['--pids-limit=256', '--memory=2g', '--memory-swap=2g', '--cpus=2']) {
    assert.ok(run.includes(flag), `visual docker run missing ${flag}`);
  }
  assert.match(run.find(arg => arg.startsWith('--tmpfs=/tmp:')) ?? '', /size=/,
    'visual /tmp tmpfs is not size-bounded');
  assert.ok(flat.includes('MO_TRACKER_DB=/tmp/mo-tracker-synthetic/tracker.db'));
  assert.equal(flat.includes('tracker/data/tracker.db'), false);

  const inside = join(repo, 'holdouts');
  await mkdir(inside);
  const before = calls.length;
  await assert.rejects(offlineVisualRunner(journal, { execDocker })({ task_id: '1674', worktree: repo, candidate_sha: sha },
    { visual: { ...profile.visual, holdoutDir: inside } }), /holdout_inside_worktree/);
  assert.equal(calls.length, before, 'docker is not called for an inside-worktree holdout');
});

test('offline visual runner rejects invalid capture bytes without leaving a partial capture directory', async t => {
  const { root, repo, sha } = await repoFixture(t);
  const journal = join(root, 'journal');
  await mkdir(journal);
  const artifactSource = join(root, 'bad-artifact-source');
  await mkdir(join(artifactSource, 'captures'), { recursive: true });
  await writeFile(join(artifactSource, 'captures', 'bad.png'), 'not a png');
  const artifactTar = execFileSync('tar', ['-C', artifactSource, '-cf', '-', '.'], { encoding: 'buffer' });
  const execDocker = async (file, args) => {
    if (args[0] === 'info') return { stdout: '["name=rootless"]', stderr: '' };
    if (args[0] === 'run') return { stdout: 'container\n', stderr: '' };
    if (args[0] === 'exec' && args.includes('tar')) return { stdout: artifactTar, stderr: '' };
    if (args[0] === 'exec') return { stdout: 'visual ok', stderr: '' };
    if (args[0] === 'rm') return { stdout: '', stderr: '' };
    throw new Error(`unexpected docker call ${args.join(' ')}`);
  };
  const profile = buildUiVisualL3Profile({ image: IMAGE, argv: ['node', 'visual-check.mjs'] });
  await assert.rejects(offlineVisualRunner(journal, { execDocker })({ task_id: '1674', worktree: repo, candidate_sha: sha },
    { visual: profile.visual }), /png_invalid/);
  const names = await readdir(journal);
  assert.equal(names.some(name => name.startsWith('visual-captures-')), false);
});

test('evaluateSatisfactionReport is deterministic for boundary PASS and blocking counters', () => {
  const pass = { viewports: ['1440x900', '1024x768'], consoleErrors: 0, a11yViolations: 0,
    unstyledControls: 0, uncollapsedLongLists: 0, missingStates: 0, holdoutFailures: 0,
    satisfactionScore: 85 };
  assert.deepEqual(evaluateSatisfactionReport(pass).defects, []);
  assert.equal(evaluateSatisfactionReport(pass).verdict, 'PASS');
  assert.equal(evaluateSatisfactionReport({ ...pass, satisfactionScore: 84 }).verdict, 'REWORK');
  assert.equal(evaluateSatisfactionReport({ ...pass, unstyledControls: 1 }).verdict, 'REWORK');
  assert.equal(evaluateSatisfactionReport({ ...pass, uncollapsedLongLists: 1 }).verdict, 'REWORK');
  assert.equal(evaluateSatisfactionReport({ ...pass, a11yCritical: 1 }).verdict, 'REWORK');
  const huge = evaluateSatisfactionReport({ ...pass, unstyledControls: 50000 });
  assert.equal(huge.verdict, 'REWORK');
  assert.equal(huge.metrics.unstyledControls, 50000);
  assert.equal(huge.defects.filter(defect => defect.category === 'unstyled-control').length, 64);
  const billion = evaluateSatisfactionReport({ ...pass, uncollapsedLongLists: 1e9 });
  assert.equal(billion.metrics.uncollapsedLongLists, 1e9);
  assert.equal(billion.defects.filter(defect => defect.category === 'uncollapsed-long-list').length, 64);
});

// --- P1: hardened inspect port, generalized node_modules mount allowlist ---

test('isAllowedCandidateNodeModulesTarget accepts normalized /candidate/(.../)?node_modules only', async () => {
  const { isAllowedCandidateNodeModulesTarget } = await import('./runtime.mjs');
  for (const good of ['/candidate/node_modules', '/candidate/tracker/web/node_modules',
    '/candidate/web/node_modules', '/candidate/a/b/c/node_modules',
    '/candidate/packages-lib/node_modules']) {
    assert.equal(isAllowedCandidateNodeModulesTarget(good), true, good);
  }
  for (const bad of ['/candidate', '/candidate/', '/etc/node_modules', '/node_modules',
    '/candidate/../node_modules', '/candidate//node_modules', '/candidate/./node_modules',
    '/candidate/x/../node_modules', '/candidate/x/node_modules/', '/candidate/x/node_modules/evil',
    '/candidate/x//node_modules', 'candidate/node_modules', '', null, undefined, 42,
    '/candidate/evil\x01/node_modules', '/candidate/evil\x7f/node_modules',
    '/candidate/evil\n/node_modules']) {
    assert.equal(isAllowedCandidateNodeModulesTarget(bad), false, String(bad));
  }
});

test('offline docker runner mounts node_modules at generalized allowlisted targets', async t => {
  const { root, repo, sha } = await repoFixture(t);
  const journal = join(root, 'journal');
  const deps = join(root, 'node_modules');
  await mkdir(journal);
  await mkdir(deps);
  for (const to of ['/candidate/node_modules', '/candidate/web/node_modules',
    '/candidate/tracker/web/node_modules']) {
    const calls = [];
    const execDocker = async (file, args) => {
      calls.push([file, [...args]]);
      if (args[0] === 'info') return { stdout: '["name=rootless"]', stderr: '' };
      if (args[0] === 'run') {
        // Точка монтирования создана в снимке реальным каталогом до docker run.
        const spec = args.find(arg => arg.startsWith('type=bind,src=') && arg.includes('dst=/candidate,'));
        const snap = spec.slice('type=bind,src='.length, spec.indexOf(',dst='));
        const rel = to.slice('/candidate/'.length);
        const target = join(snap, rel);
        const st = await import('node:fs/promises').then(fs => fs.lstat(target));
        assert.equal(st.isDirectory() && !st.isSymbolicLink(), true, `${to} не реальный каталог`);
        return { stdout: 'checks ok', stderr: '' };
      }
      if (args[0] === 'rm') return { stdout: '', stderr: '' };
      throw new Error(`unexpected docker call ${args.join(' ')}`);
    };
    const result = await offlineDockerRunner(journal, { execDocker })(
      { task_id: '5030', worktree: repo, candidate_sha: sha },
      { check: { image: IMAGE, argv: ['true'], cwd: '.', timeoutMs: 1000,
        mounts: [{ from: deps, to }] } });
    assert.equal(result.ok, true, to);
    const run = calls.find(([, args]) => args[0] === 'run')?.[1];
    assert.ok(run.includes(`type=bind,src=${deps},dst=${to},readonly`),
      `mount spec missing for ${to}`);
  }
});

test('offline docker runner rejects node_modules mounts outside the generalized allowlist', async t => {
  const { root, repo, sha } = await repoFixture(t);
  const journal = join(root, 'journal');
  const deps = join(root, 'node_modules');
  await mkdir(journal);
  await mkdir(deps);
  for (const to of ['/etc/node_modules', '/candidate/../node_modules',
    '/candidate/x//node_modules', '/candidate/node_modules/', '/candidate/x/evil\x01/node_modules']) {
    let ran = false;
    const execDocker = async (file, args) => {
      if (args[0] === 'info') return { stdout: '["name=rootless"]', stderr: '' };
      if (args[0] === 'run') ran = true;
      return { stdout: '', stderr: '' };
    };
    await assert.rejects(offlineDockerRunner(journal, { execDocker })(
      { task_id: '5031', worktree: repo, candidate_sha: sha },
      { check: { image: IMAGE, argv: ['true'], cwd: '.', timeoutMs: 1000,
        mounts: [{ from: deps, to }] } }),
      /outside the allowlist/, to);
    assert.equal(ran, false, `docker run happened for ${to}`);
  }
});

test('offline docker runner rejects node_modules mount target crossing a symlink', async t => {
  const root = await temp(t, 'v24-runtime-link-');
  const repo = join(root, 'worktree');
  await mkdir(repo);
  git(repo, 'init', '-q', '-b', 'pilot');
  git(repo, 'config', 'user.email', 'test@local');
  git(repo, 'config', 'user.name', 'test');
  await writeFile(join(repo, 'page.txt'), 'synthetic\n');
  // Симлинк-компонент в цепочке цели маунта: web указывает вовне дерева.
  await symlink('/etc', join(repo, 'web'));
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'candidate');
  const sha = git(repo, 'rev-parse', 'HEAD');
  const journal = join(root, 'journal');
  const deps = join(root, 'node_modules');
  await mkdir(journal);
  await mkdir(deps);
  let ran = false;
  const execDocker = async (file, args) => {
    if (args[0] === 'info') return { stdout: '["name=rootless"]', stderr: '' };
    if (args[0] === 'run') ran = true;
    return { stdout: '', stderr: '' };
  };
  await assert.rejects(offlineDockerRunner(journal, { execDocker })(
    { task_id: '5032', worktree: repo, candidate_sha: sha },
    { check: { image: IMAGE, argv: ['true'], cwd: '.', timeoutMs: 1000,
      mounts: [{ from: deps, to: '/candidate/web/node_modules' }] } }),
    /crosses a symlink/);
  assert.equal(ran, false, 'docker run happened for a symlink-crossed target');
});

test('worktreeInspector does not execute repo-local fsmonitor/hooks config of the worker', async t => {
  const { worktreeInspector } = await import('./runtime.mjs');
  const root = await temp(t, 'v24-inspect-');
  const repo = join(root, 'worktree');
  await mkdir(repo);
  git(repo, 'init', '-q', '-b', 'pilot');
  git(repo, 'config', 'user.email', 'test@local');
  git(repo, 'config', 'user.name', 'test');
  await writeFile(join(repo, 'page.txt'), 'base\n');
  git(repo, 'add', 'page.txt');
  git(repo, 'commit', '-qm', 'base');
  const base = git(repo, 'rev-parse', 'HEAD');
  await writeFile(join(repo, 'page.txt'), 'candidate\n');
  git(repo, 'add', 'page.txt');
  git(repo, 'commit', '-qm', 'candidate');
  const sha = git(repo, 'rev-parse', 'HEAD');
  // Воркер оставил в репо-конфиге fsmonitor-хук, пишущий маркер при запуске:
  // незащищённый git status исполняет его от имени контроллера.
  const marker = join(root, 'fsmon-pwned');
  const hook = join(root, 'fsmon-evil.sh');
  await writeFile(hook, `#!/bin/sh\necho x >> "${marker}"\nexit 1\n`, { mode: 0o755 });
  git(repo, 'config', 'core.fsmonitor', hook);
  // Контроль атаки: незащищённый status действительно исполняет хук.
  execFileSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8' });
  assert.ok(await realpath(marker).catch(() => null) !== null,
    'контроль: fsmonitor-хук не исполнился в незащищённом вызове');
  await rm(marker, { force: true });

  const inspect = worktreeInspector({ profiles: { pilot: {
    task: '9101', worker: 'thr_w', worktree: repo, base, branch: 'pilot',
  } } });
  const result = await inspect({ task_id: '9101', worker_thread_id: 'thr_w',
    check_profile: 'pilot', worktree: repo, base_sha: base, candidate_sha: sha });
  assert.equal(result.head, sha);
  assert.equal(result.clean, true);
  assert.equal(result.baseAncestor, true);
  assert.equal(await realpath(marker).catch(() => null), null,
    'fsmonitor-хук репо-конфига исполнился при инспекции');
});
