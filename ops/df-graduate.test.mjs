import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PROFILE_RELPATH, loadProjectProfile } from '../board_pipeline/taste-profile.mjs';
import { graduate } from './df-graduate.mjs';

const cli = fileURLToPath(new URL('./df-graduate.mjs', import.meta.url));
const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
function fixture(t, files = {}) {
  const root = mkdtempSync(fileURLToPath(new URL('../.df-graduate-test-', import.meta.url)));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

test('upgrades a greenfield profile in place without losing owner preferences', t => {
  const root = fixture(t, { 'package.json': '{}', 'AGENTS.md': '# Rules', [DEFAULT_PROFILE_RELPATH]: `
repo_id: prototype
field_mode: greenfield
default_plan: mvp
stack: [node22-esm, ui]
l1_profile: node
taste:
  - "Keep # comments: yes"
  - |-
    Line one
    Line two
domain_skills:
  ui: [layout, contrast]
  security: test-first
` });
  const before = loadProjectProfile(root);
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /brownfield.*bugfix/);
  assert.deepEqual(loadProjectProfile(root), { ...before, fieldMode: 'brownfield', defaultPlan: 'bugfix', agentsMd: 'AGENTS.md' });
  assert.deepEqual(readdirSync(join(root, '.darkfactory')), ['project-profile.yaml']);
});

for (const marker of ['requirements.txt', 'pyproject.toml', 'tests/test_model.py']) {
  test(`fresh Python scaffold: ${marker} takes precedence over package.json`, t => {
    const root = fixture(t, { 'package.json': '{}', [marker]: '', 'AGENTS.md': '', 'ui.spec.tsx': '',
      'node_modules/vendor/vendor.test.js': '', '.venv/tests/test_deps.py': '' });
    const result = graduate(root);
    assert.equal(result.testCount, marker.endsWith('.py') ? 2 : 1);
    const profile = loadProjectProfile(root);
    assert.deepEqual(profile.stack, ['python-node']);
    assert.equal(profile.l1Profile, 'python-node');
    assert.equal(profile.agentsMd, 'AGENTS.md');
  });
}

test('fresh Node scaffold accepts protected mode, plan and repo id overrides', t => {
  const root = fixture(t, { 'package.json': '{}', 'test/smoke.mjs': '', 'src/api.test.ts': '' });
  const result = run(root, '--to', 'bluefield', '--plan', 'api-change', '--repo-id', 'sample', '--json');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).testCount, 2);
  const profile = loadProjectProfile(root);
  assert.deepEqual(profile.stack, ['node']);
  assert.equal(profile.l1Profile, 'node');
  assert.equal(profile.agentsMd, null);
  assert.equal(profile.repoId, 'sample');
  assert.equal(profile.fieldMode, 'bluefield');
  assert.equal(profile.defaultPlan, 'api-change');
});

test('dry run previews a fresh or existing profile without creating or updating files', t => {
  const root = fixture(t, { 'package.json': '{}' });
  const preview = run(root, '--dry-run', '--to', 'greyfield', '--plan', 'refactor', '--json');
  assert.equal(preview.status, 0, preview.stderr);
  assert.equal(JSON.parse(preview.stdout).dryRun, true);
  assert.equal(JSON.parse(preview.stdout).profile.field_mode, 'greyfield');
  assert.deepEqual(readdirSync(root), ['package.json']);
  const existing = fixture(t, { [DEFAULT_PROFILE_RELPATH]: 'field_mode: greenfield\n' });
  graduate(existing, { dryRun: true });
  assert.deepEqual(readdirSync(join(existing, '.darkfactory')), ['project-profile.yaml']);
  assert.equal(readFileSync(join(existing, DEFAULT_PROFILE_RELPATH), 'utf8'), 'field_mode: greenfield\n');
});

test('refuses unprotected modes, mvp and invalid arguments before writing', t => {
  const root = fixture(t);
  for (const args of [['--to', 'greenfield'], ['--to', 'unknown'], ['--plan', 'mvp'], ['--plan', 'unknown'], ['--repo-id', '']]) {
    const result = run(root, ...args);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /df-graduate:/);
    assert.deepEqual(readdirSync(root), []);
  }
});

test('malformed existing profiles and invalid proposed changes leave original bytes intact', t => {
  for (const yaml of ['taste: [', 'field_mode: greenfield\n']) {
    const root = fixture(t, { [DEFAULT_PROFILE_RELPATH]: yaml });
    assert.throws(() => graduate(root, { repoId: 'x'.repeat(129) }), /taste_profile_/);
    assert.equal(readFileSync(join(root, DEFAULT_PROFILE_RELPATH), 'utf8'), yaml);
    assert.deepEqual(readdirSync(join(root, '.darkfactory')), ['project-profile.yaml']);
  }
});

test('rejects non-directory roots, symlinked inputs, and symlinked profile destinations', t => {
  const root = fixture(t, { file: '', 'repo/package.json': '{}' });
  assert.throws(() => graduate(join(root, 'file')), /directory/);
  symlinkSync('repo', join(root, 'alias'));
  assert.throws(() => graduate(join(root, 'alias')), /symlink/);
  symlinkSync('file', join(root, 'AGENTS.md'));
  assert.throws(() => graduate(root), /symlink/);
  const repo = join(root, 'repo');
  symlinkSync('..', join(repo, '.darkfactory'));
  assert.throws(() => graduate(repo), /symlink/);
  rmSync(join(repo, '.darkfactory'));
  mkdirSync(join(repo, '.darkfactory'));
  symlinkSync('../../file', join(repo, DEFAULT_PROFILE_RELPATH));
  assert.throws(() => graduate(repo), /symlink/);
  assert.equal(readFileSync(join(root, 'file'), 'utf8'), '');
});
