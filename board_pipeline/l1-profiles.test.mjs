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
import { _internals } from './acceptance.mjs';
import { offlineDockerRunner, offlineProfileRunner, SANDBOX_ENV }
  from './runtime.mjs';
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
  for (const text of [dockerfile, requirements]) {
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
    // Авто-дефолт на карточку не пишется: записанная метка — контрактный
    // явный выбор и ложно конфликтовала бы с явным l1Profile политики.
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
