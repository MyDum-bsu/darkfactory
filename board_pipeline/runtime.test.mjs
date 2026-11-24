import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildUiVisualL3Profile, evaluateSatisfactionReport, offlineVisualRunner } from './runtime.mjs';

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
