// Детерминированные тесты реестра L1-профилей и его fail-closed
// интеграции: реестр, Dockerfile/requirements доверенного образа,
// acceptance, runtime и операторские CLI (factory-enqueue/factory-run).
// Без внешних зависимостей и host-путей: временные каталоги — в tmpdir,
// в finally удаляются; docker и vb не вызываются.
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, writeFile }
  from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_L1_PROFILE, defaultL1ProfileForRepo, effectiveL1ProfileId,
  isValidL1Profile, L1_PROFILES, REPO_DEFAULT_L1_PROFILES, resolveL1Profile }
  from './l1-profiles.mjs';
import { accept, acceptHeld, _internals } from './acceptance.mjs';
import { offlineDockerRunner, offlineProfileRunner, offlineVisualRunner,
  SANDBOX_ENV } from './runtime.mjs';
import { buildEnqueuePlan } from '../ops/factory-enqueue.mjs';
import { buildRunPlan } from '../ops/factory-run.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const HEX = 'a'.repeat(64);
const SHA = 'b'.repeat(40);

async function tempdir() {
  return realpath(await mkdtemp(join(tmpdir(), 'l1-profiles-')));
}

test('реестр: дефолт node, python-node для optimization/autoresearcher', () => {
  assert.equal(DEFAULT_L1_PROFILE, 'node');
  assert.ok(Object.isFrozen(L1_PROFILES));
  assert.equal(L1_PROFILES.node.runtime, 'node22');
  assert.equal(L1_PROFILES['python-node'].runtime, 'python3.12+node22');
  assert.deepEqual(L1_PROFILES['python-node'].pythonPackages,
    ['pytest', 'ruff', 'pyyaml', 'sympy', 'numpy']);
  assert.equal(REPO_DEFAULT_L1_PROFILES.optimization, 'python-node');
  assert.equal(REPO_DEFAULT_L1_PROFILES.autoresearcher, 'python-node');
  assert.equal(defaultL1ProfileForRepo('optimization'), 'python-node');
  assert.equal(defaultL1ProfileForRepo('autoresearcher'), 'python-node');
  assert.equal(defaultL1ProfileForRepo('other'), 'node');
  assert.equal(defaultL1ProfileForRepo(undefined), 'node');
  // Прототипные ключи Object.prototype — не записи реестра: lookup только
  // через Object.hasOwn, иначе 'constructor'/'toString' дали бы объект,
  // а не 'node'.
  for (const protoKey of ['constructor', 'toString', '__proto__',
    'hasOwnProperty', 'valueOf']) {
    assert.equal(defaultL1ProfileForRepo(protoKey), 'node', protoKey);
    assert.equal(resolveL1Profile({ repoId: protoKey }).id, 'node', protoKey);
  }
  for (const nonString of [null, 0, {}, ['optimization'], ['node']]) {
    assert.equal(defaultL1ProfileForRepo(nonString), 'node', JSON.stringify(nonString));
  }
  assert.equal(resolveL1Profile({}).id, 'node');
  assert.equal(resolveL1Profile({ repoId: 'optimization' }).id, 'python-node');
  assert.equal(resolveL1Profile({ l1Profile: 'python-node' }).id, 'python-node');
});

test('реестр: дефолты активных репозиториев флота и прототипная безопасность', () => {
  // Каждый активный репозиторий флота закреплён в реестре дефолтов.
  assert.equal(REPO_DEFAULT_L1_PROFILES['music-restoration'], 'python-node');
  assert.equal(REPO_DEFAULT_L1_PROFILES['moml-course'], 'python-node');
  assert.equal(REPO_DEFAULT_L1_PROFILES.darkfactory, 'node');
  assert.equal(REPO_DEFAULT_L1_PROFILES['bsu-cabinet-skill'], 'node');
  assert.equal(defaultL1ProfileForRepo('music-restoration'), 'python-node');
  assert.equal(defaultL1ProfileForRepo('moml-course'), 'python-node');
  assert.equal(defaultL1ProfileForRepo('darkfactory'), 'node');
  assert.equal(defaultL1ProfileForRepo('bsu-cabinet-skill'), 'node');
  assert.equal(resolveL1Profile({ repoId: 'music-restoration' }).id, 'python-node');
  assert.equal(resolveL1Profile({ repoId: 'moml-course' }).id, 'python-node');
  assert.equal(resolveL1Profile({ repoId: 'darkfactory' }).id, 'node');
  assert.equal(resolveL1Profile({ repoId: 'bsu-cabinet-skill' }).id, 'node');
  assert.equal(effectiveL1ProfileId({ repoId: 'music-restoration' }), 'python-node');
  assert.equal(effectiveL1ProfileId({ repoId: 'darkfactory' }), 'node');
  // Каждое закреплённое значение — валидное имя профиля реестра.
  for (const [repoId, profile] of Object.entries(REPO_DEFAULT_L1_PROFILES)) {
    assert.equal(isValidL1Profile(profile), true, `${repoId}:${profile}`);
  }
  // Реестр дефолтов заморожен и нечитаем через прототип: ключи с дефисом
  // и ключи Object.prototype не дают ни записей, ни унаследованных значений.
  assert.ok(Object.isFrozen(REPO_DEFAULT_L1_PROFILES));
  for (const protoKey of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    assert.equal(Object.hasOwn(REPO_DEFAULT_L1_PROFILES, protoKey), false, protoKey);
    assert.equal(defaultL1ProfileForRepo(protoKey), 'node', protoKey);
  }
  // Точное совпадение ключа: вариации регистра/префикса — незарегистрированные
  // репозитории с дефолтом node.
  for (const miss of ['Music-Restoration', 'music', 'darkfactory2', 'moml', ' bsu-cabinet-skill']) {
    assert.equal(defaultL1ProfileForRepo(miss), 'node', miss);
  }
});

test('реестр: fail-closed на неизвестный, пустой, null и прототипный профиль', () => {
  for (const bad of ['bogus', '', null, 0, '__proto__', 'toString', 'constructor',
    'hasOwnProperty', {}, ['node'], 'NODE', 'python']) {
    assert.equal(isValidL1Profile(bad), false, JSON.stringify(bad));
    assert.throws(() => resolveL1Profile({ l1Profile: bad }),
      /^Error: unknown_l1_profile:/, JSON.stringify(bad));
  }
  for (const ok of ['node', 'python-node']) {
    assert.equal(isValidL1Profile(ok), true);
    assert.equal(resolveL1Profile({ l1Profile: ok }).id, ok);
  }
  // Object.hasOwn, не доступ через прототип: унаследованные ключи не
  // попадают в реестр.
  assert.equal(Object.hasOwn(L1_PROFILES, 'toString'), false);
});

test('доверенный образ: Dockerfile и requirements без host-путей', async () => {
  const dir = join(ROOT, 'ops', 'l1-profiles', 'python-node');
  const dockerfile = await readFile(join(dir, 'Dockerfile'), 'utf8');
  const requirements = await readFile(join(dir, 'requirements.txt'), 'utf8');
  const readme = await readFile(join(dir, 'README.md'), 'utf8');
  // Python 3.12 + Node 22 из pinned-баз, не-root, рабочий каталог кандидата.
  for (const needle of ['python:3.12-slim-bookworm',
    'node:22.23.2-bookworm-slim', 'USER 65534:65534', 'WORKDIR /candidate',
    'PYTHONDONTWRITEBYTECODE=1', 'RUFF_CACHE_DIR=/tmp/.ruff_cache',
    'PYTEST_ADDOPTS', '/opt/l1-venv', '--no-cache-dir']) {
    assert.ok(dockerfile.includes(needle), needle);
  }
  // Все закреплённые пакеты профиля присутствуют и запинены.
  for (const pkg of ['pytest', 'ruff', 'PyYAML', 'sympy', 'numpy']) {
    assert.match(requirements, new RegExp(`^${pkg}==`, 'm'), pkg);
  }
  // Ноль абсолютных host-путей в новых файлах профиля.
  for (const text of [dockerfile, requirements, readme]) {
    assert.doesNotMatch(text, /\/home\/|\/media\/|\/Users\//);
  }
});

test('acceptance: неизвестный l1Profile отклоняется fail-closed', () => {
  const review = { provider: 'openai', model: 'gpt-6.2-sol', reasoningLevel: 'medium' };
  const policy = l1 => ({ version: 1, profiles: { p: { review, l1Profile: l1 } } });
  for (const bad of ['bogus', '', null, '__proto__', 'toString']) {
    assert.throws(() => _internals.validatePolicy(policy(bad), 'p'),
      err => err?.reason === `unknown_l1_profile:${String(bad)}`, JSON.stringify(bad));
  }
  assert.equal(_internals.validatePolicy(policy('python-node'), 'p').l1Profile,
    'python-node');
  // Профиль без l1Profile — прежнее поведение, без ошибки.
  assert.equal(_internals.validatePolicy({ version: 1,
    profiles: { p: { review } } }, 'p').l1Profile, undefined);
});

test('acceptance: l1_profile попытки — реестр fail-closed, stray запрещён', () => {
  const contract = { repo_id: 'optimization', spec_digest: HEX,
    policy_digest: 'c'.repeat(64) };
  // Закреплённая метка карточки доезжает до приёмки как явный выбор.
  assert.doesNotThrow(() => _internals.validateContract(
    { ...contract, l1_profile: 'python-node' }));
  assert.doesNotThrow(() => _internals.validateContract(contract));
  // Заданное нестроковое или неизвестное значение — отказ, а не
  // «отсутствие метки»: неверный вход не подменяется дефолтом.
  for (const bad of ['bogus', '', null, 42, {}, ['node'], '__proto__', 'toString']) {
    assert.throws(() => _internals.validateContract(
      { ...contract, l1_profile: bad }),
      err => err?.reason === `unknown_l1_profile:${String(bad)}`,
      JSON.stringify(bad));
  }
  // Метка без остального контракта — неполный закреп, отклоняется.
  assert.throws(() => _internals.validateContract({ l1_profile: 'node' }),
    err => err?.reason === 'subject_contract_incomplete');
});

test('acceptance: l1Profile рецептов — fail-closed и мисматч с профилем', () => {
  const review = { provider: 'openai', model: 'gpt-6.2-sol', reasoningLevel: 'medium' };
  const policy = profile => ({ version: 1, profiles: { p: { review, ...profile } } });
  const recipe = { argv: ['npm', 'test'], cwd: '.', timeoutMs: 1000 };
  // Невалидный l1Profile в любом рецепте — отказ, даже при has_ui=false.
  for (const bad of ['bogus', null, '__proto__']) {
    assert.throws(() => _internals.validatePolicy(
      policy({ checks: [{ ...recipe, l1Profile: bad }] }), 'p'),
      err => err?.reason === `unknown_l1_profile:${String(bad)}`, JSON.stringify(bad));
    assert.throws(() => _internals.validatePolicy(
      policy({ check: { ...recipe, l1Profile: bad } }), 'p'),
      err => err?.reason === `unknown_l1_profile:${String(bad)}`, JSON.stringify(bad));
    assert.throws(() => _internals.validatePolicy(
      policy({ has_ui: false, visual: { ...recipe, l1Profile: bad } }), 'p'),
      err => err?.reason === `unknown_l1_profile:${String(bad)}`, JSON.stringify(bad));
  }
  // Явный рецепт против явного профиля — mismatch; совпадение и рецепт
  // без profile.l1Profile — допустимы.
  assert.throws(() => _internals.validatePolicy(
    policy({ l1Profile: 'node', checks: [{ ...recipe, l1Profile: 'python-node' }] }), 'p'),
    err => err?.reason === 'l1_profile_mismatch');
  assert.throws(() => _internals.validatePolicy(
    policy({ l1Profile: 'node', visual: { ...recipe, l1Profile: 'python-node' } }), 'p'),
    err => err?.reason === 'l1_profile_mismatch');
  assert.equal(_internals.validatePolicy(
    policy({ l1Profile: 'python-node',
      checks: [{ ...recipe, l1Profile: 'python-node' }] }), 'p').l1Profile, 'python-node');
  assert.doesNotThrow(() => _internals.validatePolicy(
    policy({ checks: [{ ...recipe, l1Profile: 'python-node' }] }), 'p'));
});

// Фикстуры прямого acceptHeld: та же форма, что в accept-held.test.mjs,
// но на минимальном in-memory board-порту без native SDK.
const HELD_CAND = 'c'.repeat(40);
const HELD_SPEC = 'd'.repeat(64);
const HELD_POL = 'e'.repeat(64);
const HELD_REVIEW = { provider: 'openai', model: 'gpt-6.2-sol', reasoningLevel: 'medium' };

function heldAttempt(over = {}) {
  return { attempt_id: 'att-1', task_id: '1', epoch: 1, bb_thread_id: 'thr_fixture',
    worktree: '/tmp/wt', base_sha: SHA, check_profile: 'pilot', finish: 'verified', ...over };
}
// Метка l1_profile допустима только при полном закреплённом контракте.
function heldContractAttempt(over = {}) {
  return heldAttempt({ repo_id: 'repo', spec_digest: HELD_SPEC,
    policy_digest: HELD_POL, fixtures_digest: null, ...over });
}
function heldSubmission(over = {}) {
  return { task_id: '1', epoch: 1, attempt_id: 'att-1', worker_thread_id: 'thr_fixture',
    candidate_sha: HELD_CAND, ...over };
}
function heldPolicy(profile) {
  return { version: '2', profiles: { pilot: {
    task: '1', worker: 'thr_fixture', worktree: '/tmp/wt', base: SHA,
    review: HELD_REVIEW, ...profile } } };
}
function heldPorts(labels = {}) {
  const calls = { inspect: 0, local: 0, tamper: 0, visual: 0, review: 0, board: 0 };
  const seen = { localProfile: null };
  const ports = {
    board: {
      lookup: async () => { calls.board++; return { state: 'claimed' }; },
      claim: async () => { calls.board++; throw new Error('unexpected_claim'); },
      verifyHeld: async () => { calls.board++; return { epoch: 1, until: Date.now() + 60000 }; },
      block: async () => { calls.board++; },
      complete: async () => { calls.board++; },
      project: async () => { calls.board++; },
      labels: async () => { calls.board++; return labels; },
    },
    inspect: async (binding) => {
      calls.inspect++;
      return { head: binding.candidate_sha, clean: true, baseAncestor: true,
        tree: 'f'.repeat(40) };
    },
    local: async (binding, profile) => {
      calls.local++;
      seen.localProfile = profile;
      return { sha: binding.candidate_sha, ok: true, evidence: 'checks.json', exit: 0 };
    },
    tamper: async (binding) => {
      calls.tamper++;
      return { ok: true, sha: binding.candidate_sha, base_sha: binding.base_sha,
        violations: [], digest: 't'.repeat(64) };
    },
    visual: async () => {
      calls.visual++;
      return { ok: true, status: 'pass' };
    },
    review: async (binding) => {
      calls.review++;
      return { task: binding.task_id, sha: binding.candidate_sha,
        actual: { ...HELD_REVIEW }, verdict: 'REVIEW_OK', checkpoint: 'feed80ab' };
    },
  };
  return { calls, seen, ports };
}

test('acceptHeld: l1_profile попытки сверяется с профилем и рецептами до портов', async () => {
  const journal = await tempdir();
  try {
    // Мисматч с явным profile.l1Profile — отказ до любого порта приёмки.
    for (const profile of [
      { l1Profile: 'node' },
      { checks: [{ argv: ['npm', 'test'], cwd: '.', timeoutMs: 1000, l1Profile: 'node' }] },
      { visual: { argv: ['shot'], cwd: '.', timeoutMs: 1000, l1Profile: 'node' } },
    ]) {
      const { calls, ports } = heldPorts();
      const res = await acceptHeld({
        attempt: heldContractAttempt({ l1_profile: 'python-node' }),
        submission: heldSubmission(),
        policy: heldPolicy(profile),
        journal,
        ports,
      });
      assert.equal(res.outcome, 'denied', JSON.stringify(profile));
      assert.equal(res.reason, 'l1_profile_mismatch', JSON.stringify(profile));
      assert.deepEqual(calls, { inspect: 0, local: 0, tamper: 0, visual: 0, review: 0, board: 0 });
    }
    // Политика без l1Profile: закреплённый выбор попытки пробрасывается
    // в порт local эффективным профилем.
    const { calls, seen, ports } = heldPorts({
      repo_id: 'repo', profile_id: 'pilot', finish: 'verified',
      spec_digest: HELD_SPEC, policy_digest: HELD_POL, l1_profile: 'python-node',
    });
    const res = await acceptHeld({
      attempt: heldContractAttempt({ l1_profile: 'python-node' }),
      submission: heldSubmission(),
      policy: heldPolicy({}),
      journal,
      ports,
    });
    assert.equal(res.outcome, 'verified');
    assert.equal(seen.localProfile.l1Profile, 'python-node');
    assert.equal(calls.local, 1);
    assert.equal(calls.review, 1);
    // Смена закреплённого l1_profile той же попытки не переиспользует
    // вердикт прежнего профиля: l1_profile входит в ключ контракта —
    // повтор обязан пройти проверки заново, а не вернуть repeated.
    const second = heldPorts({
      repo_id: 'repo', profile_id: 'pilot', finish: 'verified',
      spec_digest: HELD_SPEC, policy_digest: HELD_POL, l1_profile: 'node',
    });
    const rerun = await acceptHeld({
      attempt: heldContractAttempt({ l1_profile: 'node' }),
      submission: heldSubmission(),
      policy: heldPolicy({}),
      journal,
      ports: second.ports,
    });
    assert.equal(rerun.outcome, 'verified');
    assert.equal(rerun.repeated, undefined);
    assert.equal(second.seen.localProfile.l1Profile, 'node');
    assert.equal(second.calls.local, 1);
    assert.equal(second.calls.review, 1);
    // Тот же вход повторно — та же запись журнала: терминальный исход
    // возвращается repeated без новых проверок.
    const same = await acceptHeld({
      attempt: heldContractAttempt({ l1_profile: 'node' }),
      submission: heldSubmission(),
      policy: heldPolicy({}),
      journal,
      ports: second.ports,
    });
    assert.equal(same.outcome, 'verified');
    assert.equal(same.repeated, true);
    assert.equal(second.calls.local, 1);
    // Явный l1Profile профиля (выбор CLI, подставленный контроллером при
    // отсутствии метки попытки) — тоже часть ключа: повтор той же
    // попытки с другим выбором — новый запуск, а не verified от прежнего
    // профиля. Отдельный журнал: эффективный 'python-node' уже встречался
    // выше как метка попытки и по ключу тождествен ему.
    const journal2 = await tempdir();
    try {
      const first = heldPorts({
        repo_id: 'repo', profile_id: 'pilot', finish: 'verified',
        spec_digest: HELD_SPEC, policy_digest: HELD_POL,
      });
      const run1 = await acceptHeld({
        attempt: heldContractAttempt({}),
        submission: heldSubmission(),
        policy: heldPolicy({ l1Profile: 'node' }),
        journal: journal2,
        ports: first.ports,
      });
      assert.equal(run1.outcome, 'verified');
      assert.equal(first.seen.localProfile.l1Profile, 'node');
      const third = heldPorts({
        repo_id: 'repo', profile_id: 'pilot', finish: 'verified',
        spec_digest: HELD_SPEC, policy_digest: HELD_POL,
      });
      const cliRun = await acceptHeld({
        attempt: heldContractAttempt({}),
        submission: heldSubmission(),
        policy: heldPolicy({ l1Profile: 'python-node' }),
        journal: journal2,
        ports: third.ports,
      });
      assert.equal(cliRun.outcome, 'verified');
      assert.equal(cliRun.repeated, undefined);
      assert.equal(third.seen.localProfile.l1Profile, 'python-node');
      assert.equal(third.calls.local, 1);
    } finally {
      await rm(journal2, { recursive: true, force: true });
    }
  } finally {
    await rm(journal, { recursive: true, force: true });
  }
});

test('acceptHeld: незакреплённая попытка — L1 в ключе запуска, повтор без выбора совместим', async () => {
  const journal = await tempdir();
  try {
    // Попытка без spec_digest (фиксированный маршрут): ключ контракта
    // отсутствует, но явный l1Profile профиля — часть ключа запуска.
    const first = heldPorts();
    const run1 = await acceptHeld({
      attempt: heldAttempt({}),
      submission: heldSubmission(),
      policy: heldPolicy({ l1Profile: 'node' }),
      journal,
      ports: first.ports,
    });
    assert.equal(run1.outcome, 'verified');
    assert.equal(first.seen.localProfile.l1Profile, 'node');
    // Вердикт под node не подтверждает запуск под python-node: смена
    // явного выбора — новый запуск, а не repeated от прежнего исхода.
    const second = heldPorts();
    const run2 = await acceptHeld({
      attempt: heldAttempt({}),
      submission: heldSubmission(),
      policy: heldPolicy({ l1Profile: 'python-node' }),
      journal,
      ports: second.ports,
    });
    assert.equal(run2.outcome, 'verified');
    assert.equal(run2.repeated, undefined);
    assert.equal(second.seen.localProfile.l1Profile, 'python-node');
    assert.equal(second.calls.local, 1);
    // Тот же вход повторно — прежняя запись, исход repeated.
    const run3 = await acceptHeld({
      attempt: heldAttempt({}),
      submission: heldSubmission(),
      policy: heldPolicy({ l1Profile: 'python-node' }),
      journal,
      ports: second.ports,
    });
    assert.equal(run3.outcome, 'verified');
    assert.equal(run3.repeated, true);
    assert.equal(second.calls.local, 1);
    // Попытка без явного L1-выбора сохраняет прежний ключ: терминальный
    // исход базовой версии находится repeated, а не начинается заново.
    const journal3 = await tempdir();
    try {
      const noL1 = heldPorts();
      const base = await acceptHeld({
        attempt: heldAttempt({}),
        submission: heldSubmission(),
        policy: heldPolicy({}),
        journal: journal3,
        ports: noL1.ports,
      });
      assert.equal(base.outcome, 'verified');
      const again = await acceptHeld({
        attempt: heldAttempt({}),
        submission: heldSubmission(),
        policy: heldPolicy({}),
        journal: journal3,
        ports: noL1.ports,
      });
      assert.equal(again.outcome, 'verified');
      assert.equal(again.repeated, true);
      assert.equal(noL1.calls.local, 1);
    } finally {
      await rm(journal3, { recursive: true, force: true });
    }
  } finally {
    await rm(journal, { recursive: true, force: true });
  }
});

// Образ L1 аттестует себя OCI-меткой: раннер сверяет recipe.image с
// эффективным профилем до docker run (источник — docker/vb в тесте не
// вызываются, проверка идёт по коду и Dockerfile).
test('runtime: закреплённый образ обязан аттестовать эффективный L1-профиль', async () => {
  const source = await readFile(join(ROOT, 'board_pipeline', 'runtime.mjs'), 'utf8');
  const dockerfile = await readFile(
    join(ROOT, 'ops', 'l1-profiles', 'python-node', 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /LABEL df\.l1\.profile="python-node"/);
  assert.match(source, /image', 'inspect', recipe\.image/);
  assert.match(source, /imageL1Label\(recipe, execDocker\) !== l1\.id/);
  // Явный выбор — fail-closed аттестация; неявный l1Default проходит
  // мягкую сверку: метка совпадает — дефолт применяется, метки нет —
  // legacy-маршрут без заявления среды, метка иная — отказ.
  assert.equal(source.match(/resolveRunnerL1\(recipe, l1Profile \?\? l1Recipe, l1Default, dockerExec\)/g).length, 2);
  assert.match(source, /assertL1Image\(recipe, l1Explicit, execDocker\)/);
  assert.match(source, /tagged === l1Default\.id\) return l1Default;/);
  assert.match(source, /tagged !== undefined\) throw new Error\(`l1_image_mismatch:\$\{l1Default\.id\}`\)/);
});

// Реальная совместимость политики l1Default: при неявном дефолте
// 'python-node' образ без OCI-метки не отклоняется, при явном l1Profile —
// отклоняется с l1_image_mismatch до любого эффекта. docker подменён
// инъекцией execDocker — проверочный контейнер docker не содержит.
test('runtime: OCI-метка обязательна лишь при явном l1Profile, не из l1Default', async () => {
  const dir = await tempdir();
  try {
    const journal = join(dir, 'journal');
    await mkdir(journal);
    // worktree — не Git-репозиторий: после снятия аттестации следующий
    // отказ идёт из unpackExact и никогда не совпадает с l1_image_*.
    const handoff = { candidate_sha: SHA, worktree: dir, task_id: '1' };
    const recipe = { image: `sha256:${HEX}`, argv: ['pytest'], cwd: '.', timeoutMs: 1000 };
    // Отказ после снятия/прохождения аттестации обязан быть СЛЕДУЮЩИМ
    // этапом (git archive распаковки), не любой ошибкой — это доказывает
    // что legacy-маршрут реально доходит до исполнения, а не падает раньше.
    const pastImageCheck = error => /git|ENOENT|spawn|archive/i.test(String(error))
      && !/l1_image_/.test(String(error));
    const inspects = [];
    let labels = '{}';
    const execDocker = async (file, args) => {
      if (args[0] === 'info') return { stdout: '["name=rootless"]' };
      if (args[0] === 'image' && args[1] === 'inspect') {
        inspects.push(args);
        return { stdout: labels };
      }
      throw new Error(`unexpected docker call:${args.join(' ')}`);
    };
    const options = { execDocker };
    const checkRunner = offlineDockerRunner(journal, options);
    const profileRunner = offlineProfileRunner(journal, options);
    const visual = offlineVisualRunner(journal, options);
    const checkProfile = over => ({ check: recipe, checks: [recipe], ...over });
    // 1. l1Default + образ БЕЗ метки: default не применяется, рецепт идёт
    //    legacy-маршрутом дальше — отказ уже на этапе распаковки, inspect
    //    при этом вызывается (default должен ПОДТВЕРДИТЬСЯ образом).
    for (const runner of [checkRunner, profileRunner]) {
      await assert.rejects(() => runner(handoff, checkProfile({ l1Default: 'python-node' })),
        pastImageCheck);
    }
    await assert.rejects(() => visual(handoff,
      { l1Default: 'python-node', visual: recipe }), pastImageCheck);
    // 2. l1Default + метка другого профиля: образ аттестует не ту среду,
    //    что заявляет дефолт → fail-closed, а не тихий запуск в чужой среде.
    labels = '{"df.l1.profile":"node"}';
    await assert.rejects(() => checkRunner(handoff, checkProfile({ l1Default: 'python-node' })),
      /l1_image_mismatch:python-node/);
    // 3. l1Default + метка совпадает: default подтверждён образом и
    //    применяется — исполнение продолжается до следующего этапа.
    labels = '{"df.l1.profile":"python-node"}';
    for (const runner of [checkRunner, visual]) {
      await assert.rejects(() => runner(handoff,
        runner === visual ? { l1Default: 'python-node', visual: recipe }
          : checkProfile({ l1Default: 'python-node' })), pastImageCheck);
    }
    // 4. Явный l1Profile — контракт жёсткий: образ без метки отклоняется
    //    fail-closed на всех раннерах, образ с меткой проходит.
    labels = '{}';
    for (const runner of [checkRunner, profileRunner]) {
      await assert.rejects(() => runner(handoff, checkProfile({ l1Profile: 'python-node' })),
        /l1_image_mismatch:python-node/);
    }
    await assert.rejects(() => visual(handoff,
      { l1Profile: 'python-node', visual: recipe }), /l1_image_mismatch:python-node/);
    labels = '{"df.l1.profile":"python-node"}';
    await assert.rejects(() => visual(handoff,
      { l1Profile: 'python-node', visual: recipe }), pastImageCheck);
    // 5. Inspect LỖI (sự cố docker/timeout/JSON hỏng) — fail-closed
    //    l1_image_uninspectable cho cả l1Default: legacy-маршрут chỉ
    //    được phép sau inspect THÀNH CÔNG xác nhận thiếu nhãn.
    const execDockerDown = async (file, args) => {
      if (args[0] === 'info') return { stdout: '["name=rootless"]' };
      throw new Error('daemon gone');
    };
    await assert.rejects(() => offlineDockerRunner(journal,
      { execDocker: execDockerDown })(handoff, checkProfile({ l1Default: 'python-node' })),
      /l1_image_uninspectable/);
    await assert.rejects(() => offlineVisualRunner(journal,
      { execDocker: execDockerDown })(handoff,
      { l1Default: 'python-node', visual: recipe }), /l1_image_uninspectable/);
    // image inspect вызывался в каждом кейсе с dockerfile-профилем —
    // и явном, и неявном: проверка образа не ослаблена, а различает
    // подтверждённый дефолт и legacy-образ.
    assert.equal(inspects.length, 10);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('accept/acceptHeld: visual.l1Profile=bogus отклоняется при has_ui=false до портов', async () => {
  const journal = await tempdir();
  try {
    const profile = { has_ui: false,
      visual: { argv: ['shot'], cwd: '.', timeoutMs: 1000, l1Profile: 'bogus' } };
    const { calls, ports } = heldPorts();
    const handoff = { task_id: '1', worker_thread_id: 'thr_fixture', base_sha: SHA,
      candidate_sha: HELD_CAND, worktree: '/tmp/wt', check_profile: 'pilot' };
    const manual = await accept({ handoff, policy: heldPolicy(profile),
      journal, ports });
    assert.equal(manual.outcome, 'denied');
    assert.equal(manual.reason, 'unknown_l1_profile:bogus');
    const held = await acceptHeld({
      attempt: heldAttempt({ has_ui: false }),
      submission: heldSubmission(),
      policy: heldPolicy(profile),
      journal,
      ports,
    });
    assert.equal(held.outcome, 'denied');
    assert.equal(held.reason, 'unknown_l1_profile:bogus');
    assert.deepEqual(calls, { inspect: 0, local: 0, tamper: 0, visual: 0, review: 0, board: 0 });
  } finally {
    await rm(journal, { recursive: true, force: true });
  }
});

test('runtime: runner отклоняет неизвестный l1Profile до вызова docker', async () => {
  const journal = await tempdir();
  try {
    const handoff = { candidate_sha: SHA, worktree: journal, task_id: '1' };
    const recipe = { image: `sha256:${HEX}`, argv: ['pytest'], cwd: '.', timeoutMs: 1000 };
    for (const runner of [offlineDockerRunner(journal), offlineProfileRunner(journal)]) {
      await assert.rejects(() => runner(handoff,
        { l1Profile: 'bogus', check: recipe, checks: [recipe] }),
        /unknown_l1_profile:bogus/);
      await assert.rejects(() => runner(handoff,
        { check: { ...recipe, l1Profile: 'bogus' }, checks: [{ ...recipe, l1Profile: 'bogus' }] }),
        /unknown_l1_profile:bogus/);
      // Невалидные типы — тот же fail-closed отказ.
      await assert.rejects(() => runner(handoff,
        { l1Profile: '__proto__', check: recipe, checks: [recipe] }),
        /unknown_l1_profile:/);
      // Явный null — не «отсутствует»: ?? скрыл бы его за дефолтом
      // рецепта, раздельная проверка отклоняет до docker.
      await assert.rejects(() => runner(handoff,
        { l1Profile: null, check: recipe, checks: [recipe] }),
        /unknown_l1_profile:null/);
      // Невалидный рецепт не маскируется валидным профилем.
      await assert.rejects(() => runner(handoff,
        { l1Profile: 'node',
          check: { ...recipe, l1Profile: 'bogus' },
          checks: [{ ...recipe, l1Profile: 'bogus' }] }),
        /unknown_l1_profile:bogus/);
      // Оба явных и различных — fail-closed mismatch, а не приоритет.
      await assert.rejects(() => runner(handoff,
        { l1Profile: 'node',
          check: { ...recipe, l1Profile: 'python-node' },
          checks: [{ ...recipe, l1Profile: 'python-node' }] }),
        /l1_profile_mismatch/);
      // Неявный дефолт контроллера валидируется fail-closed, но не
      // считается явным выбором: mismatch с ним не возникает, а явный
      // l1Profile рецепта сохраняет прежнее поведение. Следующий рубеж
      // после валидации — проверка формата SHA кандидата.
      const badSha = { ...handoff, candidate_sha: 'x' };
      await assert.rejects(() => runner(badSha,
        { l1Default: 'bogus', check: recipe, checks: [recipe] }),
        /unknown_l1_profile:bogus/);
      await assert.rejects(() => runner(badSha,
        { l1Default: 'node',
          check: { ...recipe, l1Profile: 'python-node' },
          checks: [{ ...recipe, l1Profile: 'python-node' }] }),
        /full SHA/);
      await assert.rejects(() => runner(badSha,
        { l1Default: 'python-node', check: recipe, checks: [recipe] }),
        /full SHA/);
    }
    // Список рецептов валидируется до первого вызова docker: дефект
    // второго рецепта за валидным первым отклоняется сразу — иначе при
    // исполнении первый ушёл бы в docker и упал с ошибкой среды, а не
    // с диагнозом политики.
    const profRunner = offlineProfileRunner(journal);
    await assert.rejects(() => profRunner(handoff,
      { l1Profile: 'node',
        checks: [recipe, { ...recipe, l1Profile: 'python-node' }] }),
      /l1_profile_mismatch/);
    await assert.rejects(() => profRunner(handoff,
      { checks: [recipe, { ...recipe, l1Profile: 'bogus' }] }),
      /unknown_l1_profile:bogus/);
    await assert.rejects(() => profRunner(handoff,
      { checks: [recipe, { ...recipe, l1Profile: null }] }),
      /unknown_l1_profile:null/);
    // Тот же контракт у визуального гейта: недопустимое или
    // конфликтующее visual.l1Profile отклоняется до docker.
    const visual = offlineVisualRunner(journal);
    await assert.rejects(() => visual(handoff,
      { visual: { ...recipe, l1Profile: 'bogus' } }),
      /unknown_l1_profile:bogus/);
    await assert.rejects(() => visual(handoff,
      { l1Profile: 'node', visual: { ...recipe, l1Profile: 'python-node' } }),
      /l1_profile_mismatch/);
    // Совпадающий явный выбор не конфликтует: отказ — уже по формату
    // SHA кандидата, а не по L1.
    const badSha = { ...handoff, candidate_sha: 'x' };
    await assert.rejects(() => visual(badSha,
      { l1Profile: 'python-node', visual: { ...recipe, l1Profile: 'python-node' } }),
      /full SHA/);
    await assert.rejects(() => visual(badSha,
      { l1Default: 'bogus', visual: recipe }), /unknown_l1_profile:bogus/);
  } finally {
    await rm(journal, { recursive: true, force: true });
  }
});

test('runtime: SANDBOX_ENV допускает кэши ruff и pytest', () => {
  for (const key of ['RUFF_CACHE_DIR', 'PYTEST_ADDOPTS', 'PYTHONDONTWRITEBYTECODE']) {
    assert.ok(SANDBOX_ENV.has(key), key);
  }
  // Каждый ключ defaultEnv любого профиля обязан быть допустимым ключом
  // песочницы — иначе подмешивание отклонилось бы при проверке.
  for (const profile of Object.values(L1_PROFILES)) {
    for (const key of Object.keys(profile.defaultEnv)) {
      assert.ok(SANDBOX_ENV.has(key), `${profile.id}:${key}`);
    }
  }
});

const baseValues = () => ({
  'board-url': 'https://board.example', channel: 'ops', title: 'T',
  'repo-id': 'repo', profile: 'prof', finish: 'verified',
  'spec-digest': HEX, 'policy-digest': 'c'.repeat(64) });

test('enqueue: дефолт node, авто python-node, явный --l1-profile', async () => {
  const plain = await buildEnqueuePlan(baseValues());
  assert.equal(plain.meta.l1Profile, 'node');
  assert.equal(plain.labels.l1_profile, undefined);
  for (const repo of ['optimization', 'autoresearcher']) {
    const plan = await buildEnqueuePlan({ ...baseValues(), 'repo-id': repo });
    assert.equal(plan.meta.l1Profile, 'python-node');
    // Авто-дефолт на карточку не пишется: записанная метка стала бы
    // явным выбором контракта и ложно конфликтовала бы с явным
    // l1Profile рецепта политики приёмки — контроллер выводит дефолт
    // по repo_id сам.
    assert.equal(plan.labels.l1_profile, undefined);
  }
  const explicit = await buildEnqueuePlan({ ...baseValues(),
    'l1-profile': 'python-node' });
  assert.equal(explicit.meta.l1Profile, 'python-node');
  assert.equal(explicit.labels.l1_profile, 'python-node');
  // Явный выбор node на python-репозитории — допустим и фиксируется.
  const pinned = await buildEnqueuePlan({ ...baseValues(),
    'repo-id': 'optimization', 'l1-profile': 'node' });
  assert.equal(pinned.labels.l1_profile, 'node');
  // Произвольной меткой проверенный путь не переопределяется.
  await assert.rejects(() => buildEnqueuePlan({ ...baseValues(),
    label: ['l1_profile=spoofed'] }), /label_invalid/);
  for (const bad of ['bogus', '', '__proto__']) {
    await assert.rejects(() => buildEnqueuePlan({ ...baseValues(),
      'l1-profile': bad }), /unknown_l1_profile:/);
  }
});

test('enqueue: l1Profile политики валидируется и сверяется с CLI', async () => {
  const dir = await tempdir();
  try {
    const brief = join(dir, 'brief.md');
    const reviewPrompt = join(dir, 'review.md');
    const gate = join(dir, 'gate', 'board-review.mjs');
    await mkdir(join(dir, 'gate'));
    await writeFile(brief, 'b');
    await writeFile(reviewPrompt, 'r');
    await writeFile(gate, 'g');
    await writeFile(join(dir, 'gate', 'routes.json'), '{}');
    const policyFile = join(dir, 'policy.json');
    const write = l1 => writeFile(policyFile, JSON.stringify({
      brief, reviewPrompt, reviewGate: gate,
      route: { checkProfile: 'prof' },
      // Арбитр закреплён явно другим семейством: дефолт
      // operatorReviewSetup читает keyring из process.env и при
      // зачисленном OpenAI дал бы arbiter_family_not_independent ещё до
      // проверок L1 — фикстура обязана быть независима от окружения.
      arbiter: { provider: 'google', model: 'gemini-4-neon' },
      profiles: { prof: { l1Profile: l1,
        review: { provider: 'openai', model: 'gpt-6.2-sol',
          reasoningLevel: 'medium' } } },
    }));
    await write('python-node');
    const plan = await buildEnqueuePlan({ ...baseValues(),
      'policy-digest': undefined, policy: policyFile });
    assert.equal(plan.labels.l1_profile, 'python-node');
    assert.equal(plan.meta.l1Profile, 'python-node');
    const same = await buildEnqueuePlan({ ...baseValues(),
      'policy-digest': undefined, policy: policyFile, 'l1-profile': 'python-node' });
    assert.equal(same.labels.l1_profile, 'python-node');
    await assert.rejects(() => buildEnqueuePlan({ ...baseValues(),
      'policy-digest': undefined, policy: policyFile, 'l1-profile': 'node' }),
      /l1_profile_mismatch/);
    await write('bogus');
    await assert.rejects(() => buildEnqueuePlan({ ...baseValues(),
      'policy-digest': undefined, policy: policyFile }), /unknown_l1_profile:bogus/);
    await write(null);
    await assert.rejects(() => buildEnqueuePlan({ ...baseValues(),
      'policy-digest': undefined, policy: policyFile }), /unknown_l1_profile:null/);
    // Явный l1Profile рецепта выбранного профиля — контрактный источник
    // (как в buildRunPlan): конфликт с --l1-profile отклоняется до vb,
    // невалидное значение — fail-closed unknown_l1_profile.
    const recipePolicy = l1 => writeFile(policyFile, JSON.stringify({
      brief, reviewPrompt, reviewGate: gate,
      route: { checkProfile: 'prof' },
      arbiter: { provider: 'google', model: 'gemini-4-neon' },
      profiles: { prof: {
        review: { provider: 'openai', model: 'gpt-6.2-sol',
          reasoningLevel: 'medium' },
        checks: [{ l1Profile: l1, argv: ['npm', 'test'], cwd: '.',
          timeoutMs: 1000 }] } },
    }));
    await recipePolicy('python-node');
    await assert.rejects(() => buildEnqueuePlan({ ...baseValues(),
      'policy-digest': undefined, policy: policyFile, 'l1-profile': 'node' }),
      /l1_profile_mismatch/);
    // Совпадающий явный выбор проходит и фиксируется на карточке.
    const sameRecipe = await buildEnqueuePlan({ ...baseValues(),
      'policy-digest': undefined, policy: policyFile,
      'l1-profile': 'python-node' });
    assert.equal(sameRecipe.labels.l1_profile, 'python-node');
    await recipePolicy('bogus');
    await assert.rejects(() => buildEnqueuePlan({ ...baseValues(),
      'policy-digest': undefined, policy: policyFile }),
      /unknown_l1_profile:bogus/);
    // Одиночный check — тот же контрактный источник, что checks/visual:
    // конфликт и невалидное значение отклоняются до создания карточки.
    const singlePolicy = l1 => writeFile(policyFile, JSON.stringify({
      brief, reviewPrompt, reviewGate: gate,
      route: { checkProfile: 'prof' },
      arbiter: { provider: 'google', model: 'gemini-4-neon' },
      profiles: { prof: {
        review: { provider: 'openai', model: 'gpt-6.2-sol',
          reasoningLevel: 'medium' },
        check: { l1Profile: l1, argv: ['npm', 'test'], cwd: '.',
          timeoutMs: 1000 } } },
    }));
    await singlePolicy('python-node');
    await assert.rejects(() => buildEnqueuePlan({ ...baseValues(),
      'policy-digest': undefined, policy: policyFile, 'l1-profile': 'node' }),
      /l1_profile_mismatch/);
    await singlePolicy('bogus');
    await assert.rejects(() => buildEnqueuePlan({ ...baseValues(),
      'policy-digest': undefined, policy: policyFile }),
      /unknown_l1_profile:bogus/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Минимальный валидный набор операторских входов политики factory-run.
function runFixture(dir) {
  const ops = join(dir, 'ops');
  const wt = join(dir, 'wt');
  const state = join(dir, 'state');
  const inbox = join(dir, 'inbox');
  mkdirSync(ops);
  mkdirSync(wt);
  mkdirSync(state, { mode: 0o700 });
  mkdirSync(inbox);
  writeFileSync(join(ops, 'brief.md'), 'b');
  writeFileSync(join(ops, 'review.md'), 'r');
  writeFileSync(join(ops, 'gate.json'), '{}');
  writeFileSync(join(ops, 'routes.json'), '{}');
  const spec = profiles => ({
    handoffDir: inbox, brief: join(ops, 'brief.md'),
    reviewPrompt: join(ops, 'review.md'), reviewGate: join(ops, 'gate.json'),
    version: 1,
    bb: { provider: 'acp-devin', model: 'swe-2-high', project: 'proj_x' },
    route: { worktree: wt, checkProfile: 'default', finish: 'verified', repoId: 'r' },
    profiles: { default: { branch: 'b',
      review: { provider: 'google', model: 'gemini-4-neon' }, ...profiles } },
    arbiter: { provider: 'openai', model: 'gpt-6.2-sol' },
  });
  return { wt, state, write: async profiles => {
    const file = join(dir, `policy-${Math.random().toString(36).slice(2)}.json`);
    await writeFile(file, JSON.stringify(spec(profiles)));
    return file;
  } };
}

test('run: l1Profile — дефолт, авто-репозиторий, mismatch и fail-closed', async () => {
  const dir = await tempdir();
  try {
    const { state, write } = runFixture(dir);
    const values = (policy, extra = {}) => ({
      provider: 'acp-devin', model: 'swe-2-high', policy, state, ...extra });
    const fPlain = await write({});
    const fPinned = await write({ l1Profile: 'python-node' });
    const fBad = await write({ l1Profile: 'bogus' });
    const plain = await buildRunPlan(values(fPlain), { env: {} });
    assert.equal(plain.l1Profile, 'node');
    // Дефолт 'node' без явного выбора не пробрасывается: контроллер сам
    // резолвит дефолт репозитория.
    assert.equal(plain.argv.includes('--l1-profile'), false);
    // repoId репозитория с python-дефолтом выбирает python-node сам.
    const autoPolicy = JSON.parse(await readFile(fPlain, 'utf8'));
    autoPolicy.route.repoId = 'autoresearcher';
    const autoFile = join(dir, 'policy-auto.json');
    await writeFile(autoFile, JSON.stringify(autoPolicy));
    const auto = await buildRunPlan(values(autoFile), { env: {} });
    assert.equal(auto.l1Profile, 'python-node');
    // Резолвленный дефолт НЕ пробрасывается как --l1-profile: контроллер
    // считал бы его явным выбором, и явный l1Profile рецепта дал бы
    // l1_profile_mismatch, хотя прямой запуск контроллера его принимает.
    assert.equal(auto.argv.includes('--l1-profile'), false);
    // Закреплённый в политике профиль без CLI-флага — тоже неявный для
    // контроллера выбор: флаг не пробрасывается, политику читает сам
    // контроллер.
    const policyOnly = await buildRunPlan(values(fPinned), { env: {} });
    assert.equal(policyOnly.l1Profile, 'python-node');
    assert.equal(policyOnly.argv.includes('--l1-profile'), false);
    // Явный флаг и закреплённый профиль при совпадении — проходят,
    // и операторский выбор пробрасывается контроллеру.
    const pinned = await buildRunPlan(
      values(fPinned, { 'l1-profile': 'python-node' }), { env: {} });
    assert.equal(pinned.l1Profile, 'python-node');
    assert.deepEqual(pinned.argv.slice(pinned.argv.indexOf('--l1-profile')),
      ['--l1-profile', 'python-node']);
    // Явный --l1-profile node на дефолтной политике — тоже пробрасывается:
    // контроллер обязан применить именно явный выбор, а не свой дефолт.
    const explicit = await buildRunPlan(
      values(fPlain, { 'l1-profile': 'node' }), { env: {} });
    assert.equal(explicit.l1Profile, 'node');
    assert.deepEqual(explicit.argv.slice(explicit.argv.indexOf('--l1-profile')),
      ['--l1-profile', 'node']);
    await assert.rejects(() => buildRunPlan(
      values(fPinned, { 'l1-profile': 'node' }), { env: {} }),
      /l1_profile_mismatch/);
    // Неизвестный --l1-profile и неизвестный l1Profile у ЛЮБОГО профиля
    // политики — fail-closed до Git-конфига.
    await assert.rejects(() => buildRunPlan(
      values(fPlain, { 'l1-profile': 'bogus' }), { env: {} }),
      /unknown_l1_profile:bogus/);
    await assert.rejects(() => buildRunPlan(values(fBad), { env: {} }),
      /unknown_l1_profile:bogus/);
    // l1Profile в другом, невыбранном профиле — тот же запрет.
    const other = JSON.parse(await readFile(fPlain, 'utf8'));
    other.profiles.other = { branch: 'b2', l1Profile: 'bogus',
      review: { provider: 'google', model: 'gemini-4-neon' } };
    const otherFile = join(dir, 'policy-other.json');
    await writeFile(otherFile, JSON.stringify(other));
    await assert.rejects(() => buildRunPlan(values(otherFile), { env: {} }),
      /unknown_l1_profile:bogus/);
    // Явный l1Profile рецепта проверок — контрактный источник: конфликт
    // с --l1-profile отклоняется buildRunPlan (тот же отказ, что дал бы
    // dry-run), невалидное значение — fail-closed unknown_l1_profile.
    const recipePinned = JSON.parse(await readFile(fPlain, 'utf8'));
    recipePinned.profiles.default.checks = [{ l1Profile: 'python-node',
      argv: ['npm', 'test'], cwd: '.', timeoutMs: 1000 }];
    const recipeFile = join(dir, 'policy-recipe.json');
    await writeFile(recipeFile, JSON.stringify(recipePinned));
    await assert.rejects(() => buildRunPlan(
      values(recipeFile, { 'l1-profile': 'node' }), { env: {} }),
      /l1_profile_mismatch/);
    recipePinned.profiles.default.checks[0].l1Profile = 'bogus';
    const recipeBadFile = join(dir, 'policy-recipe-bad.json');
    await writeFile(recipeBadFile, JSON.stringify(recipePinned));
    await assert.rejects(() => buildRunPlan(values(recipeBadFile), { env: {} }),
      /unknown_l1_profile:bogus/);
    // Одиночный check выбранного профиля — тот же контрактный источник:
    // конфликт с --l1-profile и невалидное значение отклоняются до запуска.
    const singlePinned = JSON.parse(await readFile(fPlain, 'utf8'));
    singlePinned.profiles.default.check = { l1Profile: 'python-node',
      argv: ['npm', 'test'], cwd: '.', timeoutMs: 1000 };
    const singleFile = join(dir, 'policy-single.json');
    await writeFile(singleFile, JSON.stringify(singlePinned));
    await assert.rejects(() => buildRunPlan(
      values(singleFile, { 'l1-profile': 'node' }), { env: {} }),
      /l1_profile_mismatch/);
    singlePinned.profiles.default.check.l1Profile = 'bogus';
    const singleBadFile = join(dir, 'policy-single-bad.json');
    await writeFile(singleBadFile, JSON.stringify(singlePinned));
    await assert.rejects(() => buildRunPlan(values(singleBadFile), { env: {} }),
      /unknown_l1_profile:bogus/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('run-isolated: эффективный l1Profile — CLI, политика, дефолт repoId', () => {
  // Дефолт реестра и дефолт репозитория.
  assert.equal(effectiveL1ProfileId({}), 'node');
  assert.equal(effectiveL1ProfileId({ repoId: 'optimization' }), 'python-node');
  // Явный CLI сильнее закреплённого профиля? Нет: расхождение — отказ.
  assert.equal(effectiveL1ProfileId({ cliProfile: 'python-node' }), 'python-node');
  assert.equal(effectiveL1ProfileId({ profileL1: 'python-node' }), 'python-node');
  assert.equal(effectiveL1ProfileId(
    { cliProfile: 'python-node', profileL1: 'python-node' }), 'python-node');
  assert.throws(() => effectiveL1ProfileId(
    { cliProfile: 'node', profileL1: 'python-node' }), /l1_profile_mismatch/);
  // Закреплённая метка карточки — третий явный источник: принятый выбор
  // node на python-репозитории применяется, а не заменяется дефолтом.
  assert.equal(effectiveL1ProfileId({ cardL1: 'node', repoId: 'optimization' }), 'node');
  assert.equal(effectiveL1ProfileId(
    { cardL1: 'python-node', profileL1: 'python-node' }), 'python-node');
  for (const combo of [
    { cardL1: 'node', profileL1: 'python-node' },
    { cardL1: 'python-node', cliProfile: 'node' },
    { cardL1: 'node', cliProfile: 'python-node', profileL1: 'python-node' },
  ]) {
    assert.throws(() => effectiveL1ProfileId(combo),
      /l1_profile_mismatch/, JSON.stringify(combo));
  }
  for (const bad of ['bogus', '', null, '__proto__', 'toString', 'constructor']) {
    assert.throws(() => effectiveL1ProfileId({ cliProfile: bad }),
      /^Error: unknown_l1_profile:/, JSON.stringify(bad));
    assert.throws(() => effectiveL1ProfileId({ profileL1: bad }),
      /^Error: unknown_l1_profile:/, JSON.stringify(bad));
    assert.throws(() => effectiveL1ProfileId({ cardL1: bad }),
      /^Error: unknown_l1_profile:/, JSON.stringify(bad));
  }
});

// Обвязка контроллера: run-isolated.mjs принимает --l1-profile, резолвит
// его через effectiveL1ProfileId вместе с профилем политики и дефолтом
// repoId и подставляет эффективное значение в проверочный профиль
// приёмки. Импорт контроллера в тест невозможен: check-контейнер
// выполняет тесты без node_modules — проверка идёт по исходнику.
test('run-isolated: --l1-profile разобран, резолвлен и применён контроллером', async () => {
  const source = await readFile(join(ROOT, 'board_pipeline', 'run-isolated.mjs'), 'utf8');
  // CLI-опция зарегистрирована в parseArgs контроллера.
  assert.match(source, /'l1-profile':\s*\{\s*type:\s*'string'\s*\}/);
  // Эффективный профиль резолвится на попытку по подтверждённому
  // attempt.repo_id с откатом на route.repoId — queue-маршрут без
  // repoId получает дефолт repo_id захваченной карточки.
  assert.match(source, /effectiveL1ProfileId\(\{[\s\S]*?repoId:\s*attempt\.repo_id\s*\?\?\s*route\.repoId/);
  // Закреплённая метка карточки — явный источник попытки.
  assert.match(source, /cardL1:\s*attempt\.l1_profile/);
  // Явный выбор идёт в l1Profile (mismatch с рецептом), неявный дефолт —
  // в l1Default: явный l1Profile рецепта не конфликтует с дефолтом.
  assert.match(source, /l1Profile:\s*explicitL1/);
  assert.match(source, /l1Default:\s*attemptL1/);
});
