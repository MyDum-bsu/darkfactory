import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, rename, rm, symlink, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { loadRoleRegistry } from './role-registry.mjs';
import { runPlaybook } from './playbook-router.mjs';
import { PLAYBOOK_TRIAD, stageObservation } from './playbook-test-fixture.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const attempt = { task_id: '101', attempt_id: 'attempt-01', epoch: 2, worktree: '/fixture/worktree',
  candidate_sha: 'a'.repeat(40), subject_digest: 'b'.repeat(64), triad: PLAYBOOK_TRIAD };
const proven = binding => ({ ...binding, held: true, clean: true, switchOpen: true, baseAncestor: true, triad: PLAYBOOK_TRIAD });

async function copyCatalog(t) {
  const tree = await mkdtemp(join(tmpdir(), 'df-factory-catalog-'));
  t.after(() => rm(tree, { recursive: true, force: true }));
  await cp(join(root, '.darkfactory'), join(tree, '.darkfactory'), { recursive: true });
  const yaml = join(tree, '.darkfactory', 'factory.yaml');
  return { tree, yaml, original: await readFile(yaml, 'utf8') };
}

test('operator registry pins all four graphs and the exact bytes of embedded skills', async t => {
  const { tree } = await copyCatalog(t);
  const prior = await loadRoleRegistry(tree);
  assert.deepEqual(Object.keys(prior.playbooks), ['ui', 'math-lean', 'dsp-audio', 'writer-course']);
  const skill = prior.roles['materials-reader'].skills[0];
  assert.equal(skill.id, 'materials-intake');
  assert.match(skill.text, /inventory/);
  const skillPath = join(tree, '.darkfactory/shared-skills/materials-intake.md');
  await writeFile(skillPath, 'An amended trusted stage skill.\n');
  const next = await loadRoleRegistry(tree);
  assert.notEqual(next.digest, prior.digest);
  assert.match(skill.text, /inventory/);
  assert.throws(() => { prior.playbooks.ui.stages.intake.next.pass = 'ready'; }, TypeError);

  const outside = join(tree, 'external.md');
  await rename(skillPath, outside);
  await symlink(outside, skillPath);
  await assert.rejects(loadRoleRegistry(tree), /factory_file_invalid/);
});

test('registry rejects loops, unenrolled capabilities, key injection and YAML aliases', async t => {
  const { tree, yaml, original } = await copyCatalog(t);
  for (const [text, code] of [
    [original.replace('pass: build, rework: hold', 'pass: intake, rework: hold'), /factory_cycle/],
    [original.replace('pass: build, rework: hold', 'pass: build, rework: build'), /factory_rework_writer/],
    [original.replace('pass: hold, rework: hold', 'pass: ready, rework: hold'), /factory_rework_handoff/],
    [original.replace('kind: analyst', 'kind: [analyst]'), /factory_role_invalid/],
    [original.replace('tools: [snapshot-read]', 'tools: [shell-exec]'), /factory_role_invalid/],
    [original.replace('tools: [snapshot-read]', 'tools: [snapshot-read, worktree-edit]'), /factory_role_invalid/],
    [original.replace('skills: [materials-intake]', 'skills: ["../outside"]'), /factory_role_invalid/],
    [original + '\ntrust: { skipReview: true }\n', /factory_manifest_invalid/],
    [original.replace('model: arbiter', 'model: &model arbiter').replace('model: executor', 'model: *model'), /factory_yaml_invalid/],
  ]) {
    assert.notEqual(text, original);
    await writeFile(yaml, text);
    await assert.rejects(loadRoleRegistry(tree), code);
  }
});

test('visual report selects corrective sparring but cannot turn REWORK into acceptance', async () => {
  const registry = await loadRoleRegistry(root);
  const pinned = { ...attempt, playbook: 'ui', registry_digest: registry.digest };
  const result = await runPlaybook({ registry, playbook: 'ui', attempt: pinned }, {
    assertKernel: proven,
    observeStage: req => req.stage === 'visual'
      ? stageObservation(req, { verdict: 'REWORK', changes: { consoleErrors: 1 } })
      : stageObservation(req),
  });
  assert.equal(result.status, 'hold');
  assert.deepEqual(result.history.map(x => [x.role, x.verdict]), [
    ['materials-reader', 'PASS'], ['ui-builder', 'PASS'], ['ux-visual-critic', 'REWORK'], ['sparring-critic', 'PASS'],
  ]);
});

test('mismatched pins, scope, model or switch prevent progression', async () => {
  const registry = await loadRoleRegistry(root);
  const pinned = { ...attempt, playbook: 'ui', registry_digest: registry.digest };
  const bound = { registry, playbook: 'ui', attempt: pinned };
  const reason = key => new RegExp(key);
  let observed = 0;
  const observeStage = req => { observed++; return stageObservation(req); };
  await assert.rejects(runPlaybook({ ...bound, playbook: 'math-lean' },
    { assertKernel: proven, observeStage }), reason('playbook_pin_mismatch'));
  await assert.rejects(runPlaybook({ ...bound, attempt: { ...pinned, registry_digest: 'f'.repeat(64) } },
    { assertKernel: proven, observeStage }), reason('playbook_pin_mismatch'));
  await assert.rejects(runPlaybook(bound, {
    assertKernel: b => ({ ...proven(b), epoch: b.epoch + 1 }), observeStage,
  }), reason('playbook_kernel_unconfirmed'));
  await assert.rejects(runPlaybook({ ...bound, attempt: { ...pinned,
    triad: { ...PLAYBOOK_TRIAD, critic: PLAYBOOK_TRIAD.worker } } },
  { assertKernel: proven, observeStage }), reason('review_same_family'));
  await assert.rejects(runPlaybook({ ...bound, attempt: { ...pinned, triad: { ...PLAYBOOK_TRIAD,
    critic: { ...PLAYBOOK_TRIAD.critic, reasoningLevel: 'high' } } } },
  { assertKernel: proven, observeStage }), reason('playbook_reasoning_not_enrolled'));
  assert.equal(observed, 0);

  for (const [replace, code] of [
    [receipt => ({ ...receipt, stage: 'other' }), 'playbook_receipt_unbound'],
    [receipt => ({ ...receipt, playbook: 'math-lean' }), 'playbook_receipt_unbound'],
    [receipt => ({ ...receipt, inputArtifactDigest: '1'.repeat(64) }), 'playbook_receipt_unbound'],
    [receipt => ({ ...receipt, binding: { ...receipt.binding, subject_digest: 'a'.repeat(64) } }), 'playbook_receipt_unbound'],
    [receipt => ({ ...receipt, artifactDigest: 'c'.repeat(64) }), 'playbook_artifact_unconfirmed'],
    [receipt => ({ ...receipt, verdict: 'REWORK' }), 'playbook_verdict_mismatch'],
    [receipt => {
      const artifact = Buffer.from(receipt.artifact.toString().replace('"unresolved":0', '"unresolved":1,"unresolved":0'));
      return { ...receipt, artifact, artifactDigest: createHash('sha256').update(artifact).digest('hex') };
    }, 'stage_artifact_invalid'],
    ...['1e-400', '0.000000000000000000001', '9007199254740993', '-0'].map(number => [receipt => {
      const artifact = Buffer.from(receipt.artifact.toString().replace('"unresolved":0', `"unresolved":${number}`));
      return { ...receipt, artifact, artifactDigest: createHash('sha256').update(artifact).digest('hex') };
    }, 'stage_artifact_invalid']),
  ]) {
    observed = 0;
    await assert.rejects(runPlaybook(bound, {
      assertKernel: proven, observeStage: req => replace(observeStage(req)),
    }), reason(code));
    assert.equal(observed, 1);
  }
  observed = 0;
  await assert.rejects(runPlaybook(bound, {
    assertKernel: b => ({ ...proven(b), switchOpen: observed === 0 }), observeStage,
  }), reason('playbook_kernel_unconfirmed'));
  assert.equal(observed, 1);
});

test('несовместимая с RO-транспортом триада отклоняется до первой стадии', async () => {
  const registry = await loadRoleRegistry(root);
  const pinned = { ...attempt, playbook: 'ui', registry_digest: registry.digest };
  let observed = 0;
  const observeStage = req => { observed++; return stageObservation(req); };
  // Devin в executor-слоте (ui-builder) — stage_model_denied на транспорте.
  await assert.rejects(runPlaybook({ registry, playbook: 'ui', attempt: { ...pinned,
    triad: { ...PLAYBOOK_TRIAD, worker: { provider: 'acp-devin', model: 'swe-2-high' } } } },
    { assertKernel: proven, observeStage }), /foreman_triad_transport_incompatible/);
  // Neon 'high' под Landlock (medium-only) — та же граница.
  await assert.rejects(runPlaybook({ registry, playbook: 'ui', attempt: { ...pinned,
    triad: { ...PLAYBOOK_TRIAD, arbiter: { provider: 'google', model: 'gemini-4-neon',
      reasoningLevel: 'high' } } } },
    { assertKernel: proven, observeStage }), /foreman_triad_transport_incompatible/);
  assert.equal(observed, 0, 'ни одна стадия не доходит до наблюдения');
});

test('v2 manifest: mode/kind mismatch, station symlink and skills_digest binding', async t => {
  const { tree, yaml, original } = await copyCatalog(t);
  // mode: write у analyst-станции и режим без обязательного поля — fail-closed.
  for (const [text, code] of [
    [original.replace('mode: read-only', 'mode: write'), /factory_role_invalid/],
    [original.replace('    mode: read-only\n', ''), /factory_role_invalid/],
    [original.replace('phaseBudgetMs: 120000', 'phaseBudgetMs: 0'), /factory_role_invalid/],
    [original.replace('version: 2', 'version: 1'), /factory_manifest_invalid/],
    [original.replace('skillPicker:', 'picker:'), /factory_manifest_invalid/],
    [original.replace('reasoning: medium', 'reasoning: ultra'), /factory_role_invalid/],
  ]) {
    assert.notEqual(text, original);
    await writeFile(yaml, text);
    await assert.rejects(loadRoleRegistry(tree), code);
    await writeFile(yaml, original);
  }
  // Симлинк на файл станции — fail-closed как и на общий скилл.
  const instructionsPath = join(tree, '.darkfactory/stations/materials-reader/instructions.md');
  const outside = join(tree, 'external.md');
  await rename(instructionsPath, outside);
  await symlink(outside, instructionsPath);
  await assert.rejects(loadRoleRegistry(tree), /factory_file_invalid/);
  await rename(outside, instructionsPath);
  // Станция writer без станции instructions — отсутствующий файл.
  const registry = await loadRoleRegistry(tree);
  assert.equal(registry.version, 2);
  assert.equal(registry.roles, registry.stations);
  assert.ok(Object.hasOwn(registry.sharedSkills, 'materials-intake'));
  assert.equal(registry.roles['materials-reader'].mode, 'read-only');
  assert.equal(registry.roles['ui-builder'].mode, 'write');
  // skills_digest в квитанции обязан совпасть с закреплённым запросом.
  const pinned = { ...attempt, playbook: 'ui', registry_digest: registry.digest };
  await assert.rejects(runPlaybook({ registry, playbook: 'ui', attempt: pinned }, {
    assertKernel: proven,
    observeStage: req => ({ ...stageObservation(req), skills_digest: 'f'.repeat(64) }),
  }), /playbook_receipt_unbound/);
  const ok = await runPlaybook({ registry, playbook: 'ui', attempt: pinned }, {
    assertKernel: proven,
    observeStage: req => ({ ...stageObservation(req), skills_digest: req.skills_digest }),
  });
  assert.equal(ok.status, 'ready_for_native_acceptance');
  assert.ok(ok.history.every(h => /^[a-f0-9]{64}$/.test(h.skills_digest)));
});
