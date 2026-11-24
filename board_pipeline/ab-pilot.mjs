import { createHash } from 'node:crypto';
import { appendFile, lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { createPilotSwitch } from './pilot-gate.mjs';
import { loadRoleRegistry } from './role-registry.mjs';
import { createBbStageObserver } from './bb-stage-adapter.mjs';
import { createStageSandboxTransport } from './stage-sandbox-transport.mjs';
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

export function guardAbBoard(ab, board) {
  if (!ab) return board;
  const writes = ['verifyHeld', 'claim', 'claimReady', 'complete', 'block', 'unblockQuestion', 'claimForQuestion'];
  const guarded = { ...board };
  for (const name of writes) {
    if (typeof board[name] !== 'function') continue;
    guarded[name] = async (...args) => {
      await ab.assertOpen();
      return board[name](...args);
    };
  }
  return guarded;
}

export function abEffectGuard(ab, { verifyHeld, assertPinned }, taskId, epoch) {
  return async () => {
    await ab.assertOpen();
    const live = await verifyHeld(taskId, epoch);
    if (live.epoch !== epoch) throw new Error('ab_pilot_lease_lost');
    await assertPinned();
  };
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

// Артефакты для foreman-пути (ab и общий): доверенное измерение под verifier
// стадии, а не единый change-set. Каждое поле артефакта — реально измеренная
// величина, а не заглушка:
//   digest-поля — sha256 измеренных входов (листинг, material, L1 evidence,
//     спеки);
//   счётчики полноты — реальные счётчики (файлы, проверки, закреплённые
//     skills роли, источники в материале);
//   счётчики дефектов — измеренные метки дефектов в доверенных входах
//     (непрошедшие L1-проверки, расхождение diff↔листинг, дырки .lean,
//     источники вне дерева, маркеры TODO/UNSUPPORTED/BLOCKER в material,
//     строки console/a11y-ошибок в журнале визуальной проверки).
// Верификаторы без доступного доверенного измерения — fail-closed отказ до
// запуска модели (visual-report требует реальной зелёной L3-квитанции).
const DEFECT_MARKERS = /TODO|FIXME|TBD|XXX|UNRESOLVED|UNCOVERED|UNSUPPORTED|BLOCKER/g;
export function foremanArtifacts({ candidate, diff, localEvidence, brief, review, git,
  visual = null, journal }) {
  const changeSet = pilotArtifacts({ candidate, diff, localEvidence, brief, review });
  const checks = localEvidence.evidence.map(({ sha256, exit }) => ({ sha256, exit }));
  const base = { brief: brief.toString('utf8'), rubric: review, changedPaths: diff.files, checks };
  const material = JSON.stringify(base);
  const failed = checks.filter(({ exit }) => exit !== 0).length;
  const checksSha = sha(JSON.stringify(localEvidence.evidence));
  const reviewSha = sha(JSON.stringify(review));
  const defectMarks = text => (String(text).match(DEFECT_MARKERS) ?? []).length;
  const encode = artifact => Buffer.from(JSON.stringify(artifact));
  let listing;
  const files = async () => listing ??= (await git('ls-tree', '-r', '--name-only', candidate))
    .split('\n').map(entry => entry.trim()).filter(Boolean).sort();

  const artifact = async request => {
    switch (request.verifier) {
      case 'inventory': {
        const tree = await files();
        return { artifact: encode({ type: 'inventory', inventory: sha(JSON.stringify(tree)),
          items: tree.length,
          unresolved: diff.files.filter(file => !tree.includes(file)).length }),
          material: JSON.stringify({ ...base, files: tree }) };
      }
      case 'conjecture':
        return encode({ type: 'conjecture', statement: sha(base.brief),
          assumptions: sha(material), bounded: Buffer.byteLength(material) <= 48 * 1024 });
      case 'falsification':
        return encode({ type: 'falsification', trace: checksSha,
          cases: checks.length, counterexamples: failed });
      case 'lean-proof': {
        // Дырки — реальный подсчёт маркеров незавершённого доказательства
        // в .lean-файлах самого кандидата; без .lean-файлов дырок нет.
        let holes = 0;
        for (const file of (await files()).filter(name => name.endsWith('.lean'))) {
          const body = await git('show', `${candidate}:${file}`);
          holes += (body.match(/\b(?:sorry|admit|admitted)\b/g) ?? []).length;
        }
        return encode({ type: 'lean-proof', diagnostics: checksSha,
          exitCode: failed === 0 ? 0 : 1, holes });
      }
      case 'source-review': {
        // Источники — пути из доказанного diff и пути-ссылки из брифа;
        // unsupported — ссылки на пути, отсутствующие в дереве кандидата.
        const cited = new Set(diff.files);
        for (const match of base.brief.matchAll(/[\w.-]+\/[\w./-]+\.[A-Za-z0-9]{1,8}/g)) cited.add(match[0]);
        const refs = [...cited].sort();
        const tree = await files();
        return encode({ type: 'source-review', sources: sha(JSON.stringify(refs)),
          checked: refs.length, unsupported: refs.filter(ref => !tree.includes(ref)).length });
      }
      case 'experiment':
        return encode({ type: 'experiment', metrics: checksSha,
          frames: checks.length, violations: failed });
      // Без реального повторного прогона пайплайна (artifact !== replay) и
      // без результатов независимой панели второго кандидата доверенного
      // измерения нет — стадия закрывается до запуска модели, а не PASS на
      // сфабрикованных значениях.
      case 'frozen-pipeline':
      case 'blind-panel':
        throw new Error('ab_pilot_artifact_not_available');
      case 'course-outline':
        return encode({ type: 'course-outline', outline: sha(material),
          lessons: request.skills?.length ?? 0, uncoveredGoals: defectMarks(material) });
      case 'technical-copy':
        return encode({ type: 'technical-copy', document: sha(material),
          sections: diff.files.length, unsupportedClaims: defectMarks(material) });
      case 'rubric-review':
        return encode({ type: 'rubric-review', rubric: reviewSha,
          criteria: material.split('\n').filter(line => line.trim()).length,
          blockers: defectMarks(material) });
      case 'visual-report': {
        // Только реальная зелёная L3-квитанция: capture — дайджест списка
        // sha256 артефактов, размеры — из заголовка первого PNG-захвата из
        // журнала, console/a11y — счётчики строк ошибок в логе проверки.
        if (visual?.ok !== true || !Array.isArray(visual.artifacts) || !visual.artifacts.length ||
            journal === undefined || !/^visual-artifact-[A-Za-z0-9_.-]+$/.test(visual.artifacts[0]?.name ?? '') ||
            !/^visual-[A-Za-z0-9_.-]+$/.test(visual.evidence?.file ?? '')) {
          throw new Error('ab_pilot_artifact_not_available');
        }
        const capture = await readFile(join(journal, visual.artifacts[0].name));
        if (capture.length < 24 || capture.readUInt32BE(0) !== 0x89504e47 ||
            capture.readUInt32BE(4) !== 0x0d0a1a0a) throw new Error('ab_pilot_artifact_not_available');
        const log = await readFile(join(journal, visual.evidence.file), 'utf8');
        return encode({ type: 'visual-report',
          capture: sha(JSON.stringify(visual.artifacts.map(({ sha256 }) => sha256).sort())),
          width: capture.readUInt32BE(16), height: capture.readUInt32BE(20),
          consoleErrors: (log.match(/console\.error|uncaught|pageerror/gi) ?? []).length,
          a11yViolations: (log.match(/a11y|axe[-\s]|accessibility violation/gi) ?? []).length });
      }
      default:
        throw new Error('ab_pilot_artifact_not_available');
    }
  };
  return async request => {
    if (request.verifier === 'change-set') return changeSet(request);
    const built = await artifact(request);
    return Buffer.isBuffer(built) ? { artifact: built, material } : built;
  };
}

// Доказательный diff base→candidate для общего (не ab) foreman-пути: без
// ограничения CASES-скопом, та же форма {files, diffDigest}, что inspectPilotDiff.
export async function foremanDiff({ git, base, candidate }) {
  const changes = (await git('diff', '--no-renames', '--name-status', '-z', base, candidate)).split('\0');
  if (changes.pop() !== '' || changes.length % 2) throw new Error('foreman_diff_unconfirmed');
  const files = changes.filter((_, i) => i % 2 === 1).sort();
  const diff = await git('diff', '--no-ext-diff', '--no-textconv', base, candidate, '--', ...files);
  return { files, diffDigest: sha(diff) };
}

export async function runPilotForeman(ab, { attempt, handoff, project, journal, readArtifact,
  assertCurrent, inspect, readState, observeStage, transport, signals }) {
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
  // VS-5.2: stage-станции идут через аттестованный read-only транспорт
  // (переданный либо созданный на worktree субъекта) — не host bb thread spawn.
  observeStage ??= await createBbStageObserver({ project, workspace: ab.workspace, parentThread: ab.parent,
    journal, deadline: ab.deadline, maxSeconds: Math.min(remaining, 120) }, {
    assertCurrent: guard, readArtifact,
    sandboxTransport: transport ?? createStageSandboxTransport({ worktree: handoff.worktree, journal,
      deadlineMs: ab.deadline, signal: signals?.signal }),
    phaseBudget: signals?.phaseBudget, signals,
    record: row => appendFile(join(journal, 'ab-stage-threads.jsonl'), `${JSON.stringify(row)}\n`, { mode: 0o600 }),
    recordWitness: row => appendFile(join(journal, 'ab-stage-receipts.jsonl'), `${JSON.stringify(row)}\n`, { mode: 0o600 }),
  });
  const result = await runPlaybook({ registry: ab.registry, playbook: ab.playbook, attempt: subject },
    { assertKernel: guard, observeStage });
  await appendFile(join(journal, 'ab-foreman.jsonl'), `${JSON.stringify({ candidate: handoff.candidate_sha,
    subject: handoff.subject_digest, ...result })}\n`, { mode: 0o600 });
  if (result.status !== 'ready_for_native_acceptance') throw new Error('ab_pilot_foreman_hold');
}
