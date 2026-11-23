import { createHash } from 'node:crypto';
import { appendFile, lstat, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { createPilotSwitch } from './pilot-gate.mjs';
import { loadRoleRegistry } from './role-registry.mjs';
import { createBbStageObserver } from './bb-stage-adapter.mjs';
import { runPlaybook } from './playbook-router.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const hex = /^[a-f0-9]{64}$/;
const isId = (re, value) => typeof value === 'string' && re.test(value);
const below = (base, path) => {
  const rel = relative(base, path);
  return !rel || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('../'));
};
const separate = (path, roots) => roots.every(root => !below(root, path) && !below(path, root));

export const CASES = Object.freeze({
  policy: Object.freeze({ files: Object.freeze(['board_pipeline/policy-key.mjs', 'board_pipeline/policy-key.test.mjs']),
    brief: 'Добавь board_pipeline/policy-key.mjs с named export isPolicyKey(value), возвращающим ровно boolean. Допустима только строка ASCII, первый символ a–z, затем до 23 символов a–z, 0–9, дефис. Пустая, нестроковая, содержащая пробел, перевод строки или Unicode — false. Добавь board_pipeline/policy-key.test.mjs на node:test с позитивными, отрицательными и граничными случаями. Не меняй ничего, кроме двух указанных файлов, зависимости не добавляй.' }),
  docs: Object.freeze({ files: Object.freeze(['board_pipeline/handoff-doc-check.mjs', 'docs/typed-handoff-quickstart.md']),
    brief: 'Добавь docs/typed-handoff-quickstart.md: ровно три раздела второго уровня «Поля», «Отказ», «Проверка». Опиши действующую сдачу через нативный claim: task_id, epoch, attempt_id, worker_thread_id, candidate_sha, чистый SHA, чужая/устаревшая сдача отклоняется. Дай один JSON-пример с этими пятью полями. Добавь board_pipeline/handoff-doc-check.mjs без зависимостей: node board_pipeline/handoff-doc-check.mjs [абсолютный файл] проверяет три раздела и единственный JSON-пример, выходит 0 на успехе и ненулевым с сообщением на ошибке. Без аргумента проверяется указанная документация относительно проекта. Не меняй другие файлы.' }),
});

export async function enrollAbPilot(config, { policy, tree, root, inbox, daemon, allowLive, parent }) {
  if (config === undefined) return null;
  if (!config || !Object.hasOwn(CASES, config.case) || !['linear', 'foreman'].includes(config.arm) ||
      !isId(/^thr_[a-z0-9]+$/, parent) || config.parent !== parent || daemon || allowLive ||
      policy.scope !== 'isolated' || policy.channel !== 'pilot' || policy.route.finish !== 'verified' ||
      policy.route.taskId !== undefined || policy.questionGate !== undefined || policy.release !== undefined ||
      policy.decisionLedger !== undefined || policy.projectMemory !== undefined ||
      !Number.isSafeInteger(policy.waitMs) || policy.waitMs < 5000 || policy.waitMs > 180000 ||
      !policy.label?.key || !isId(/^ab-[a-z0-9-]+$/, policy.label.value)) throw new Error('ab_pilot_scope_denied');
  const roots = [tree, root, inbox];
  const switchOpen = await createPilotSwitch(config.switch, { permitDirectory: dir => separate(dir, roots) });
  const deadline = Date.now() + policy.waitMs;
  const assertOpen = async () => {
    await switchOpen();
    if (Date.now() >= deadline) throw new Error('ab_pilot_dispatch_deadline');
  };
  await assertOpen();
  if (config.arm === 'linear') {
    if (Object.keys(config).length !== 4) throw new Error('ab_pilot_linear_config_invalid');
    return { arm: 'linear', case: config.case, parent, assertOpen };
  }
  if (!isId(hex, config.registryDigest) || !isAbsolute(config.catalog ?? '') ||
      !isAbsolute(config.observerWorkspace ?? '') || typeof config.playbook !== 'string' ||
      await realpath(config.catalog) !== config.catalog || await realpath(config.observerWorkspace) !== config.observerWorkspace ||
      !separate(config.catalog, roots) || !separate(config.observerWorkspace, roots.concat(config.catalog)) ||
      !(await lstat(config.observerWorkspace)).isDirectory() || (await readdir(config.observerWorkspace)).length !== 0) {
    throw new Error('ab_pilot_foreman_config_invalid');
  }
  const registry = await loadRoleRegistry(config.catalog);
  if (registry.digest !== config.registryDigest || !Object.hasOwn(registry.playbooks, config.playbook)) {
    throw new Error('ab_pilot_registry_unconfirmed');
  }
  const playbook = registry.playbooks[config.playbook];
  const writers = Object.values(playbook.stages).map(stage => registry.roles[stage.role]).filter(role => role.kind === 'writer');
  if (writers.length !== 1) throw new Error('ab_pilot_writer_not_enrolled');
  return { arm: 'foreman', case: config.case, parent, registry, writer: writers[0], deadline,
    playbook: config.playbook, workspace: config.observerWorkspace, assertOpen: async () => {
      await assertOpen();
      if ((await loadRoleRegistry(config.catalog)).digest !== config.registryDigest) throw new Error('ab_pilot_catalog_drift');
    } };
}

export async function inspectPilotDiff(ab, { git, base, candidate }) {
  const changes = (await git('diff', '--no-renames', '--name-status', '-z', base, candidate)).split('\0');
  if (changes.pop() !== '' || changes.length % 2 || changes.some((value, i) => i % 2 === 0 && value !== 'A')) {
    throw new Error('ab_pilot_diff_out_of_scope');
  }
  const files = changes.filter((_, i) => i % 2 === 1).sort();
  if (JSON.stringify(files) !== JSON.stringify([...CASES[ab.case].files].sort())) throw new Error('ab_pilot_diff_out_of_scope');
  const diff = await git('diff', '--no-ext-diff', '--no-textconv', base, candidate, '--', ...files);
  return { files, diffDigest: sha(diff) };
}

export function pilotArtifacts({ candidate, diff, localEvidence, brief, review }) {
  if (!diff || localEvidence?.ok !== true || localEvidence.sha !== candidate ||
      !Array.isArray(localEvidence.evidence) || !localEvidence.evidence.length ||
      localEvidence.evidence.some(item => item?.exit !== 0 || !isId(hex, item.sha256))) {
    throw new Error('ab_pilot_l1_unconfirmed');
  }
  const material = JSON.stringify({ brief: brief.toString('utf8'), rubric: review,
    changedPaths: diff.files, checks: localEvidence.evidence.map(({ sha256, exit }) => ({ sha256, exit })) });
  return request => {
    if (request.verifier !== 'change-set') throw new Error('ab_pilot_artifact_not_available');
    const artifact = Buffer.from(JSON.stringify({ type: 'change-set', diff: diff.diffDigest,
      changed: diff.files.length, failedChecks: localEvidence.evidence.filter(item => item.exit !== 0).length }));
    return { artifact, material };
  };
}

export async function runPilotForeman(ab, { attempt, handoff, project, journal, readArtifact, assertCurrent, inspect, readState }) {
  const pin = { playbook: ab.playbook, registry_digest: ab.registry.digest };
  const subject = { ...handoff, ...pin, attempt_id: attempt.attempt_id, epoch: attempt.epoch, triad: attempt.triad };
  const guard = async binding => {
    await assertCurrent();
    const state = await readState();
    if (state?.taskId !== binding.task_id || state.attemptId !== binding.attempt_id || state.epoch !== binding.epoch ||
        state.sha !== binding.candidate_sha || state.phase !== 'checking') throw new Error('ab_pilot_attempt_drift');
    const tree = await inspect(handoff);
    if (tree.head !== binding.candidate_sha || !tree.clean || !tree.baseAncestor) throw new Error('ab_pilot_snapshot_drift');
    await assertCurrent();
    return { ...handoff, ...pin, attempt_id: state.attemptId, epoch: state.epoch, triad: state.triad,
      held: true, switchOpen: true, clean: true, baseAncestor: true };
  };
  const remaining = Math.floor((ab.deadline - Date.now()) / 1000);
  if (remaining < 5) throw new Error('ab_pilot_dispatch_deadline');
  const observeStage = await createBbStageObserver({ project, workspace: ab.workspace, parentThread: ab.parent,
    journal, deadline: ab.deadline, maxSeconds: Math.min(remaining, 120) }, {
    // This installed, same-host BB launcher has no attested read-only seat.
    // A policy file or empty directory cannot mint the assertReadOnly capability.
    assertCurrent: guard, readArtifact,
    record: row => appendFile(join(journal, 'ab-stage-threads.jsonl'), `${JSON.stringify(row)}\n`, { mode: 0o600 }),
    recordWitness: row => appendFile(join(journal, 'ab-stage-receipts.jsonl'), `${JSON.stringify(row)}\n`, { mode: 0o600 }),
  });
  const result = await runPlaybook({ registry: ab.registry, playbook: ab.playbook, attempt: subject },
    { assertKernel: guard, observeStage });
  await appendFile(join(journal, 'ab-foreman.jsonl'), `${JSON.stringify({ candidate: handoff.candidate_sha,
    subject: handoff.subject_digest, ...result })}\n`, { mode: 0o600 });
  if (result.status !== 'ready_for_native_acceptance') throw new Error('ab_pilot_foreman_hold');
}
