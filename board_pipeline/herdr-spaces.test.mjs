import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createWorkerRuntime } from './worker-runtime.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'df-herdr-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, 'tracker'), other = join(root, 'darkfactory');
  await mkdir(dir); await mkdir(other);
  const docsPath = join(root, 'docs.json');
  const spaces = [{ id: 'sp-df', name: 'Darkfactory', folder: other },
    { id: 'sp-mo', name: 'MO Tracker', folder: dir }];
  const save = rows => writeFile(docsPath, JSON.stringify({ 'herdr-app': { value: { spaces: rows } } }));
  await save(spaces);
  return { root, docsPath, spaces, save, project: { repo_id: 'optimization', repo_dir: dir, herdr_space_name: 'MO Tracker' } };
}

test('hc rejects a foreign policy space before spawn or resume cleanup; rechecks docs on every launch', async t => {
  const { root, docsPath, spaces, save, project } = await fixture(t);
  const git = (...args) => execFileSync('git', ['-C', project.repo_dir, ...args], { stdio: 'pipe' });
  git('init', '-q'); git('-c', 'user.name=Fixture', '-c', 'user.email=t@example.org', 'commit', '-qm', 'base', '--allow-empty');
  const worktree = join(root, 'slot'); git('worktree', 'add', '--detach', worktree);
  const calls = [];
  const runtime = createWorkerRuntime({ kind: 'hc', project, docsPath, readFile: async () => 'prompt',
    exec: async (_, argv) => { calls.push(argv); return { stdout: '{"address":"t1"}' }; } });
  const input = { worktree, taskId: '1', attemptId: 'a', promptFile: '/prompt', executor: 'pi/test', runtimeId: 'worker' };
  for (const method of ['spawn', 'resume']) {
    await assert.rejects(runtime[method]({ ...input, spaceLabel: 'sp-df' }), /herdr_space_mismatch/);
  }
  await assert.rejects(runtime.spawn({ ...input, worktree: spaces[0].folder }), /herdr_space_mismatch/);
  assert.equal(calls.length, 0);
  await runtime.spawn({ ...input, spaceLabel: project.repo_id });
  assert.ok(calls[0].includes('herdr.space=sp-mo'));
  const legacy = createWorkerRuntime({ kind: 'hc', docsPath, readFile: async () => 'prompt', exec: assert.fail });
  await assert.rejects(legacy.spawn({ ...input, spaceLabel: 'sp-df' }), /herdr_space_mismatch/);
  await assert.rejects(legacy.spawn(input), /herdr_space_mismatch/);
  const resumedCalls = [];
  const resumer = createWorkerRuntime({ kind: 'hc', project, docsPath, readFile: async () => 'prompt',
    exec: async (_, argv) => { resumedCalls.push(argv[0]); await save(spaces.slice(0, 1));
      return { stdout: '{"error":{"kind":"not_found"}}' }; } });
  await assert.rejects(resumer.resume(input), /herdr_space_not_found/);
  assert.deepEqual(resumedCalls, ['get']);
  await assert.rejects(runtime.spawn(input), /herdr_space_not_found/);
  assert.equal(calls.length, 1);
});

test('resolve exact folder + name, reject missing, conflicting and ambiguous ownership', async t => {
  const { resolveHerdrSpace } = await import('./herdr-spaces.mjs');
  const { project, docsPath, root, spaces, save } = await fixture(t);
  const resolve = overrides => resolveHerdrSpace({ ...project, ...overrides }, { docsPath });
  const alias = join(root, 'alias'); await symlink(project.repo_dir, alias);
  assert.equal(await resolve({ repo_dir: alias }), 'sp-mo');
  for (const overrides of [{ herdr_space_name: 'mo tracker' }, { herdrSpaceId: 'sp-df' },
    { repo_dir: spaces[0].folder }, { repo_dir: spaces[0].folder, herdr_space_name: 'Darkfactory' }]) {
    await assert.rejects(resolve(overrides), /herdr_space_mismatch/);
  }
  for (const duplicate of [{ ...spaces[1], id: 'sp-copy' }, { ...spaces[0], id: 'sp-mo' }]) {
    await save([...spaces, duplicate]); await assert.rejects(resolve(), /herdr_space_mismatch/);
  }
  await save([]); await assert.rejects(resolve(), /herdr_space_not_found/);
  await writeFile(docsPath, '{'); await assert.rejects(resolve(), /herdr_space_not_found/);
  await rm(docsPath); await assert.rejects(resolve(), /herdr_space_not_found/);
});
