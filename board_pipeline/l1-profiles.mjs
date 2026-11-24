// Реестр доверенных L1-профилей — единый источник правды для явного
// выбора среды локальных проверок. Неизвестное имя — fail-closed отказ
// (unknown_l1_profile:<значение>) до любого вызова docker/vb/контроллера.

const freeze = value => Object.freeze(value);

export const L1_PROFILES = freeze({
  node: freeze({
    id: 'node',
    runtime: 'node22',
    network: 'none',
    readOnlyCandidate: true,
    user: '65534:65534',
    tools: freeze(['node', 'npm']),
    defaultEnv: freeze({}),
  }),
  'python-node': freeze({
    id: 'python-node',
    runtime: 'python3.12+node22',
    dockerfile: 'ops/l1-profiles/python-node/Dockerfile',
    network: 'none',
    readOnlyCandidate: true,
    user: '65534:65534',
    tools: freeze(['python3', 'pytest', 'ruff', 'node', 'npm']),
    pythonPackages: freeze(['pytest', 'ruff', 'pyyaml', 'sympy', 'numpy']),
    defaultEnv: freeze({
      PYTHONDONTWRITEBYTECODE: '1',
      RUFF_CACHE_DIR: '/tmp/.ruff_cache',
      PYTEST_ADDOPTS: '-o cache_dir=/tmp/.pytest_cache',
    }),
  }),
});

export const DEFAULT_L1_PROFILE = 'node';

// Репозитории, которым дефолтно нужен Python-стек проверок.
export const REPO_DEFAULT_L1_PROFILES = freeze({
  optimization: 'python-node',
  autoresearcher: 'python-node',
});

export function defaultL1ProfileForRepo(repoId) {
  // Object.hasOwn, не доступ через прототип: repoId вида 'constructor',
  // 'toString', '__proto__' обязан дать дефолт, а не унаследованное
  // свойство Object.prototype.
  return typeof repoId === 'string' && Object.hasOwn(REPO_DEFAULT_L1_PROFILES, repoId)
    ? REPO_DEFAULT_L1_PROFILES[repoId]
    : DEFAULT_L1_PROFILE;
}

export function isValidL1Profile(name) {
  return typeof name === 'string' && Object.hasOwn(L1_PROFILES, name);
}

// Явный выбор — строго fail-closed: любое заданное значение, не
// являющееся именем профиля (null, '', нестрока, __proto__, toString),
// отклоняется. undefined — выбор по дефолту репозитория.
export function resolveL1Profile({ l1Profile, repoId } = {}) {
  if (l1Profile === undefined) return L1_PROFILES[defaultL1ProfileForRepo(repoId)];
  if (!isValidL1Profile(l1Profile)) {
    throw new Error(`unknown_l1_profile:${String(l1Profile)}`);
  }
  return L1_PROFILES[l1Profile];
}

// Эффективный L1-профиль попытки: явный --l1-profile > l1Profile
// выбранного профиля политики > дефолт repoId. Любое заданное
// неизвестное имя и два явных различных источника — fail-closed отказ
// до любой проверки и эффекта.
export function effectiveL1ProfileId({ cliProfile, profileL1, repoId } = {}) {
  if (profileL1 !== undefined && !isValidL1Profile(profileL1)) {
    throw new Error(`unknown_l1_profile:${String(profileL1)}`);
  }
  if (cliProfile !== undefined && !isValidL1Profile(cliProfile)) {
    throw new Error(`unknown_l1_profile:${String(cliProfile)}`);
  }
  if (cliProfile !== undefined && profileL1 !== undefined && cliProfile !== profileL1) {
    throw new Error('l1_profile_mismatch');
  }
  return resolveL1Profile({ l1Profile: cliProfile ?? profileL1, repoId }).id;
}
