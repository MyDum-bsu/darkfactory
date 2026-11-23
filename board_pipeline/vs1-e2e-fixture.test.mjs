import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadVs1E2eFixture } from './vs1-e2e-fixture.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'vs1-fixture-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'config.json');
  const cfg = { repo: join(root, 'repo'), bundle: join(root, 'objects.bundle'),
    reviewPrompt: join(root, 'review.md'), base: 'a'.repeat(40), defect: 'b'.repeat(40),
    final: 'c'.repeat(40), finalTree: 'd'.repeat(40), bbProject: 'proj_fixture',
    checks: [{ image: 'local-checks', argv: ['node', '--test'], cwd: '.' }],
    visual: { image: 'local-checks', argv: ['node', 'render.js'], cwd: '.' } };
  await mkdir(cfg.repo);
  await writeFile(cfg.bundle, 'synthetic file');
  await writeFile(cfg.reviewPrompt, 'Read-only synthetic invariant');
  const load = async overrides => {
    await writeFile(file, JSON.stringify({ ...cfg, ...overrides }));
    return loadVs1E2eFixture(file);
  };
  return { cfg, load };
}

test('VS-1 fixture resolves explicit local inputs and defaults to no test deletion', async t => {
  const { cfg, load } = await fixture(t);
  const loaded = await load();
  assert.equal(loaded.repo, await realpath(cfg.repo));
  assert.equal(loaded.bundle, await realpath(cfg.bundle));
  assert.equal(loaded.reviewPrompt, 'Read-only synthetic invariant');
  assert.equal(loaded.finalTree, cfg.finalTree);
  assert.equal(loaded.allowTestDeletion, false);
});

test('VS-1 fixture refuses omitted paths, unpinned commits and empty checks', async t => {
  const { cfg, load } = await fixture(t);
  await assert.rejects(load({ bundle: 'relative.bundle' }), /fixture\.bundle/);
  await assert.rejects(load({ final: cfg.base }), /three distinct commit SHAs/);
  await assert.rejects(load({ bbProject: undefined }), /fixture\.bbProject/);
  await assert.rejects(load({ checks: [] }), /each check and visual/);
  await writeFile(cfg.reviewPrompt, '');
  await assert.rejects(load(), /fixture\.reviewPrompt is empty/);
});
