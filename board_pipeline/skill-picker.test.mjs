import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { loadRoleRegistry } from './role-registry.mjs';
import { computeSkillsDigest, pickSkills } from './skill-picker.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

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
