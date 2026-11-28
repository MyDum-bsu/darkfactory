import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, symlink, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { loadRoleRegistry } from './role-registry.mjs';
import { computeSkillsDigest, pickSkills } from './skill-picker.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

test('live intake resolves scoped shared, declared repo and enrolled owner text in that order', async () => {
  const { resolveWorkerSkills } = await import('./skill-picker.mjs');
  const { workerIntakePrompt } = await import('./intake-prompt.mjs');
  const registry = await loadRoleRegistry(root);
  const args = { registry, allowedPaths: ['audio/filter.py', 'ops/', 'audio/fft.py'],
    profile: { domainSkills: { dsp: ['property-testing'], ops: ['prod-recon'], ui: ['feature-blueprint'] },
      repoSkills: ['listen'] }, ownerSkills: { notation: 'Use owner notation.' },
    readRepoSkill: async id => { assert.equal(id, 'listen'); return 'Use repo reference audio.'; } };
  const text = await resolveWorkerSkills(args);
  assert.ok(text.includes(registry.sharedSkills['property-testing'].text));
  assert.ok(text.includes(registry.sharedSkills['prod-recon'].text));
  assert.ok(!text.includes(registry.sharedSkills['feature-blueprint'].text));
  assert.equal(text.split(registry.sharedSkills['property-testing'].text).length, 2);
  assert.ok(text.indexOf('Use repo reference audio.') > text.indexOf(registry.sharedSkills['prod-recon'].text));
  assert.ok(text.indexOf('Use owner notation.') > text.indexOf('Use repo reference audio.'));
  assert.equal(await resolveWorkerSkills(args), text);
  assert.ok(workerIntakePrompt({ brief: 'task', tree: root, skillBlock: text }).includes(text));
});

test('worker skill budget counts UTF-8, headings and separators; equality is allowed', async () => {
  const { resolveWorkerSkills } = await import('./skill-picker.mjs');
  const registry = await loadRoleRegistry(root);
  const render = text => resolveWorkerSkills({ registry, ownerSkills: { boundary: text } });
  const spare = 16 * 1024 - Buffer.byteLength(await render('a'));
  const body = 'a' + 'я'.repeat(Math.floor(spare / 2)) + 'a'.repeat(spare % 2);
  assert.equal(Buffer.byteLength(await render(body)), 16 * 1024);
  await assert.rejects(render(body + 'x'), /worker_skill_budget_exceeded/);
});

test('pickSkills: station skills + defaults, deterministic digest, no foreign stations', async () => {
  const registry = await loadRoleRegistry(root);
  const picked = pickSkills({ registry, labels: {}, stationId: 'materials-reader' });
  assert.deepEqual(picked.skillIds, ['materials-intake', 'goal-rules', 'session-handoff']);
  assert.equal(picked.stationId, 'materials-reader');
  assert.match(picked.skills_digest, /^[a-f0-9]{64}$/);
  assert.equal(picked.skills_digest, computeSkillsDigest(picked.skills));
  // Скиллы чужих станций в набор не попадают.
  assert.ok(!picked.skillIds.includes('ui-ux-craft'));
  assert.ok(picked.skills.every(s => s.text.trim() && /^[a-f0-9]{64}$/.test(s.digest)));
  // labels не влияют на scope станции; rule match добавляет shared-скиллы.
  const ui = pickSkills({ registry, labels: { domain: 'ui', has_ui: true }, stationId: 'ui-builder' });
  assert.deepEqual(ui.skillIds.slice(0, 3), ['feature-blueprint', 'test-first', 'ui-ux-craft']);
  assert.ok(ui.skillIds.includes('three-pass-review')); // has_ui rule
  // Дедупликация: feature-blueprint уже в скиллах станции — повтора нет.
  assert.equal(ui.skillIds.filter(id => id === 'feature-blueprint').length, 1);
  // Детерминизм: повторный вызов даёт тот же digest.
  assert.equal(pickSkills({ registry, labels: { domain: 'ui', has_ui: true }, stationId: 'ui-builder' }).skills_digest,
    ui.skills_digest);
});

test('controller reads project taste and selected skill bodies only from regular blobs at claim base', async t => {
  const { workerProjectInputs } = await import('./run-isolated.mjs');
  const tree = await mkdtemp(join(tmpdir(), 'df-worker-skills-'));
  t.after(() => rm(tree, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.org',
    '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: tree, encoding: 'utf8' }).trim();
  git('init', '-q');
  const profile = join(tree, '.darkfactory', 'project-profile.yaml');
  const skill = join(tree, 'skills', 'lemma', 'SKILL.md');
  await mkdir(join(tree, '.darkfactory'));
  await mkdir(join(tree, 'skills', 'lemma'), { recursive: true });
  await writeFile(profile, 'repo_id: theorem\ntaste: explain each proof\nrepo_skills: [lemma]\n');
  await writeFile(skill, 'Use the base lemma.');
  git('add', '.'); git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  const registry = await loadRoleRegistry(root);
  const resolve = base => workerProjectInputs({ tree, base, registry, allowedPaths: ['proof.lean'] });
  await writeFile(profile, 'repo_skills: [absent]');
  await writeFile(skill, 'Candidate instructions');
  git('add', '.'); git('commit', '-qm', 'candidate');
  const inputs = await resolve(base);
  assert.match(inputs.projectContext, /explain each proof/);
  assert.match(inputs.skillBlock, /Use the base lemma/);
  assert.doesNotMatch(inputs.skillBlock, /Candidate instructions/);
  await assert.rejects(resolve(git('rev-parse', 'HEAD')), /repo_skill_missing/);
  await writeFile(profile, 'repo_skills: [lemma]');
  await rm(skill); await symlink(profile, skill);
  git('add', '.'); git('commit', '-qm', 'symlink');
  await assert.rejects(resolve(git('rev-parse', 'HEAD')), /prompt_blob_invalid/);
});

test('pickSkills: label rules by contract marks', async () => {
  const registry = await loadRoleRegistry(root);
  const lean = pickSkills({ registry, labels: { requires_lean: true }, stationId: null });
  assert.deepEqual(lean.skillIds, ['goal-rules', 'session-handoff', 'property-testing']);
  const ci = pickSkills({ registry, labels: { pr_ci_red: true, test_first: true } });
  assert.equal(ci.skillIds.filter(id => id === 'test-first').length, 1);
  const none = pickSkills({ registry, labels: { domain: 'other' } });
  assert.deepEqual(none.skillIds, ['goal-rules', 'session-handoff']);
});

test('pickSkills: fail-closed on bad registry, unknown station and budget', async t => {
  const registry = await loadRoleRegistry(root);
  assert.throws(() => pickSkills({ registry: {}, labels: {} }), /skill_picker_registry_invalid/);
  assert.throws(() => pickSkills({ registry, stationId: 'ghost' }), /skill_picker_registry_invalid/);
  assert.throws(() => pickSkills({ registry, maxPromptBytes: 10 }), /station_prompt_budget_exceeded/);
  // Промпт КАЖДОЙ станции каталога строго меньше 24 KiB.
  for (const stationId of Object.keys(registry.stations)) {
    const picked = pickSkills({ registry, stationId, labels: { has_ui: true, requires_lean: true,
      requires_colab: true, touches_migrations: true, pr_ci_red: true, test_first: true,
      domain: 'ui', playbook: 'ui' } });
    assert.ok(picked.totalBytes < 24 * 1024, `${stationId}: ${picked.totalBytes}`);
  }
  // Неизвестный skill id в правилах — fail-closed на этапе загрузки каталога.
  const tree = await mkdtemp(join(tmpdir(), 'df-picker-'));
  t.after(() => rm(tree, { recursive: true, force: true }));
  const { cp } = await import('node:fs/promises');
  await cp(join(root, '.darkfactory'), join(tree, '.darkfactory'), { recursive: true });
  const yaml = join(tree, '.darkfactory', 'factory.yaml');
  const text = await import('node:fs/promises').then(fs => fs.readFile(yaml, 'utf8'));
  await writeFile(yaml, text.replace('add: [feature-blueprint]', 'add: [ghost-skill]'));
  await assert.rejects(loadRoleRegistry(tree), /factory_file_invalid/);
});
