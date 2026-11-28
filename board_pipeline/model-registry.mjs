// Декларативный реестр моделей и policy-безопасный роутинг ролей.
// Чистые функции резолва не читают внешнее состояние; загрузка YAML строго
// fail-closed, а кросс-семейные инварианты reviewer/arbiter механически
// применяются в resolveTriad независимо от содержимого пользовательского конфига.

import { lstat, readFile, realpath, access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';
import { opencodeGoPolicyViolation, retiredProviderViolation, workerFamily } from './worker-selector.mjs';
import { fusionModelMeta } from './review-runner.mjs';
import { isApprovedWorker } from './run-isolated.mjs';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(MODULE_DIR, '..');
const YAML_LIMIT = 256 * 1024;

export const EXAMPLE_CATALOG_PATH = join(REPO_ROOT, 'ops', 'local', 'models-catalog.example.yaml');
export const EXAMPLE_POLICY_PATH = join(REPO_ROOT, 'ops', 'local', 'routing-policy.example.yaml');

export const MODEL_FAMILIES = Object.freeze(['cognition', 'google', 'deepseek', 'openai', 'anthropic', 'glm']);
export const MODEL_STATUSES = Object.freeze(['promo_free', 'active', 'standby', 'quota_paused', 'disabled']);
export const COST_TIERS = Object.freeze(['free', 'subscription', 'paid_api']);
export const ROUTING_MODES = Object.freeze(['economy', 'balanced', 'sprint']);
export const REGISTRY_ROLES = Object.freeze([
  'lead', 'coder_default', 'coder_heavy', 'reviewer', 'arbiter', 'ux_critic']);
export const ELIGIBLE_STATUSES = Object.freeze(['promo_free', 'active', 'standby']);
// Провайдеры, исполняемые L2 read-only раннером критика/арбитра: точное
// зеркало ключей PROVIDER_EGRESS review-runner.mjs — провайдеры с
// egress-endpoint без coding-харнесса. Сырой 'anthropic' сюда не входит:
// у раннера нет egress anthropic, и такой спек отклоняется приёмкой
// route_critic_not_runnable — эмиссия его в routing.allowlist ломала всю
// политику роутинга. Harness 'pi' ключом не является: исполняемость
// pi-записи определяется вложением модели (см. isL2RunnableEntry).
// ACP-харнессы (acp-devin, acp-zcode-start, codex-acp, bb,
// acp-antigravity-acp) в позитивный список не входят — консервативный
// fail-safe фильтр моста.
export const L2_RUNNABLE_PROVIDERS = Object.freeze(
  ['openai', 'google', 'deepseek', 'glm', 'cognition', 'opencode-go']);
const L2_RUNNABLE_SET = new Set(L2_RUNNABLE_PROVIDERS);

const ROLE_SET = new Set(REGISTRY_ROLES);
const FAMILY_SET = new Set(MODEL_FAMILIES);
const STATUS_SET = new Set(MODEL_STATUSES);
const COST_SET = new Set(COST_TIERS);
const MODE_SET = new Set(ROUTING_MODES);
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const ISO_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

// Механический минимум, который нельзя убрать редактированием policy.
const HARD_REQUIRED_CAPABILITIES = Object.freeze({ ux_critic: Object.freeze(['vision']) });

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonEmptyString = value => typeof value === 'string' && value.trim().length > 0;
const uniqueStrings = value => Array.isArray(value) &&
  value.every(nonEmptyString) && new Set(value).size === value.length;

// The reason-returning API is also the legacy operator CLI contract.
export function forbiddenModelViolation(spec) {
  const ids = typeof spec === 'string' ? [spec] : [spec?.provider, spec?.model];
  return ids.some(id => typeof id === 'string' &&
    id.toLowerCase().split(/[/\\]/).includes('gpt-6.1-terra'))
    ? 'model_gpt_6_1_terra_disallowed' : null;
}

export function modelViolation(spec) {
  return forbiddenModelViolation(spec) ?? retiredProviderViolation(spec) ?? opencodeGoPolicyViolation(spec);
}

export const isForbiddenModel = spec => modelViolation(spec) !== null;

// By default use the pipeline's attested provider/model table. A pinned catalog
// restricts admission to its exact pairs; it cannot lift a hard prohibition.
export function isApprovedModel(spec, registry) {
  if (isForbiddenModel(spec)) return false;
  if (registry === undefined) return workerFamily(spec) !== null;
  const slash = typeof spec === 'string' ? spec.indexOf('/') : -1;
  const pair = slash < 0 ? spec : { provider: spec.slice(0, slash), model: spec.slice(slash + 1) };
  return isRecord(pair) && Array.isArray(registry?.catalog?.models) && registry.catalog.models.some(entry =>
    entry.provider === pair.provider && entry.model === pair.model &&
    ELIGIBLE_STATUSES.includes(effectiveStatus(entry, registry.loadedAt)));
}

function fusionMetaOf(spec) {
  const model = typeof spec === 'string' ? spec.slice(spec.indexOf('/') + 1) : spec?.model;
  return fusionModelMeta(model);
}

function sidekickSafeReader(spec) {
  return !fusionMetaOf(spec) && workerFamily(spec) !== 'cognition';
}

export function assertPolicyModelMatrix({ cli, policy, registry }) {
  function check(where, spec) {
    if (spec === undefined) return;
    const reason = modelViolation(spec);
    if (reason) throw new Error(`${reason}:${where}`);
    if (!isApprovedModel(spec, registry)) throw new Error(`model_not_approved:${where}`);
  }
  check('cli', cli);
  check('policy.bb', policy?.bb);
  // A known review model is not necessarily an enrolled startup worker.
  // Reuse the controller's admission predicate rather than copying its list.
  if (policy?.bb !== undefined && !isApprovedWorker(policy.bb)) throw new Error('model_not_approved:policy.bb');
  check('arbiter', policy?.arbiter);
  check('route.critic', policy?.route?.critic);
  check('route.arbiter', policy?.route?.arbiter);
  for (const [name, profile] of Object.entries(policy?.profiles ?? {})) {
    check(`profiles.${name}`, profile?.review);
  }
  const allowlist = policy?.routing?.allowlist;
  if (allowlist !== undefined && !isRecord(allowlist)) throw new Error('model_allowlist_invalid');
  for (const [role, entries] of Object.entries(allowlist ?? {})) {
    if (!['worker', 'critic', 'arbiter'].includes(role) || !Array.isArray(entries)) {
      throw new Error(`model_allowlist_invalid:${role}`);
    }
    for (const entry of entries) check(`routing.allowlist.${role}`, entry ?? null);
  }
  // Runtime allowlists are independent pools. Its scalar family check already
  // excludes the lead, but cannot express a conditional sidekick exclusion.
  const workers = [cli, policy?.bb, ...(allowlist?.worker ?? [])];
  if (workers.some(fusionMetaOf)) {
    const readers = [policy?.arbiter, policy?.route?.critic, policy?.route?.arbiter,
      ...Object.values(policy?.profiles ?? {}).map(p => p?.review), ...(allowlist?.critic ?? []), ...(allowlist?.arbiter ?? [])];
    if (readers.some(spec => !sidekickSafeReader(spec))) throw new Error('fusion_sidekick_family_collision');
  }
}

function exactKeys(value, required, optional = []) {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  return required.every(key => Object.hasOwn(value, key)) && keys.every(key => allowed.has(key));
}

function invalid(kind, detail) {
  return new Error(`${kind}: ${detail}`);
}

function parseYaml(bytes, path) {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const doc = parseDocument(text, { schema: 'core', uniqueKeys: true, merge: false });
    if (doc.errors.length || doc.warnings.length) throw new Error('yaml parser rejected document');
    return doc.toJS({ maxAliasCount: 0 });
  } catch (cause) {
    throw new Error(`model_registry_yaml_invalid: ${path}`, { cause });
  }
}

async function readYamlFile(path) {
  const full = resolve(path);
  let info;
  let canonical;
  try {
    info = await lstat(full);
    canonical = join(await realpath(dirname(full)), basename(full));
  } catch (cause) {
    throw new Error(`model_registry_file_missing: ${path}`, { cause });
  }
  if (!info.isFile() || info.size === 0 || info.size > YAML_LIMIT) {
    throw new Error(`model_registry_file_invalid: ${path}`);
  }
  return parseYaml(await readFile(canonical), path);
}

function validDateOnly(value) {
  const match = DATE_ONLY.exec(value);
  if (!match) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
}

function validIsoTimestamp(value) {
  const match = ISO_TIMESTAMP.exec(value);
  if (!match) return false;
  const [, year, month, day, hour, minute, second = '0', offset] = match;
  if (!validDateOnly(`${year}-${month}-${day}`) || Number(hour) > 23 ||
      Number(minute) > 59 || Number(second) > 59) return false;
  if (offset !== 'Z') {
    const [offsetHour, offsetMinute] = offset.split(':').map(Number);
    if (Math.abs(offsetHour) > 23 || offsetMinute > 59) return false;
  }
  return Number.isFinite(Date.parse(value));
}

export function untilMs(until) {
  if (until === undefined || until === null || until === '') return null;
  if (until instanceof Date) {
    const ms = until.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof until !== 'string') return null;
  const value = until.trim();
  if (DATE_ONLY.test(value)) {
    if (!validDateOnly(value)) return null;
    return Date.parse(`${value}T23:59:59.999Z`);
  }
  return validIsoTimestamp(value) ? Date.parse(value) : null;
}

function validateUntil(value) {
  return value === undefined || (typeof value === 'string' && untilMs(value) !== null);
}

function validateCatalog(raw) {
  if (!exactKeys(raw, ['version', 'models']) || raw.version !== 1 || !Array.isArray(raw.models) ||
      !raw.models.length || raw.models.length > 256) {
    throw invalid('model_catalog_invalid', 'expected version: 1 and a non-empty models array');
  }
  const seen = new Set();
  const models = raw.models.map((entry, index) => {
    const where = `models[${index}]`;
    if (!exactKeys(entry, ['id', 'provider', 'model', 'family', 'status', 'cost_tier',
        'capabilities', 'quota_source', 'notes'], ['until']) ||
        typeof entry.id !== 'string' || !ID.test(entry.id) || seen.has(entry.id) ||
        !nonEmptyString(entry.provider) || !nonEmptyString(entry.model) ||
        !FAMILY_SET.has(entry.family) || !STATUS_SET.has(entry.status) ||
        !COST_SET.has(entry.cost_tier) || !uniqueStrings(entry.capabilities) ||
        !nonEmptyString(entry.quota_source) || typeof entry.notes !== 'string' ||
        !validateUntil(entry.until)) {
      throw invalid('model_catalog_invalid', where);
    }
    if (/(?:^|[/\\])\s*fusion-/i.test(entry.model)) {
      const meta = fusionModelMeta(entry.model);
      if (!meta || !['acp-devin', 'devin'].includes(entry.provider) || entry.family !== meta.leadFamily ||
          !['subscription', 'paid_api'].includes(entry.cost_tier)) {
        throw invalid('model_catalog_invalid', `${where}: invalid Devin Fusion model, family or cost tier`);
      }
    }
    seen.add(entry.id);
    return Object.freeze({ ...entry, capabilities: Object.freeze([...entry.capabilities]) });
  });
  return Object.freeze({ version: 1, models: Object.freeze(models) });
}

function validateRoleMap(roles) {
  if (!isRecord(roles) || Object.keys(roles).length !== REGISTRY_ROLES.length ||
      !REGISTRY_ROLES.every(role => Object.hasOwn(roles, role))) {
    throw invalid('model_policy_invalid', 'roles must contain exactly the six registry roles');
  }
  for (const role of REGISTRY_ROLES) {
    const spec = roles[role];
    if (!exactKeys(spec, ['required_capabilities', 'must_differ_family_from']) ||
        !uniqueStrings(spec.required_capabilities) ||
        !Array.isArray(spec.must_differ_family_from) ||
        new Set(spec.must_differ_family_from).size !== spec.must_differ_family_from.length ||
        spec.must_differ_family_from.some(other => !['coder', 'reviewer'].includes(other))) {
      throw invalid('model_policy_invalid', `roles.${role}`);
    }
  }
  if (!roles.ux_critic.required_capabilities.includes('vision')) {
    throw invalid('model_policy_invalid', 'roles.ux_critic must require vision');
  }
  const expectedInvariants = {
    lead: [], coder_default: [], coder_heavy: [], ux_critic: [],
    reviewer: ['coder'], arbiter: ['coder', 'reviewer'],
  };
  for (const role of REGISTRY_ROLES) {
    const actual = roles[role].must_differ_family_from;
    const expected = expectedInvariants[role];
    if (actual.length !== expected.length || expected.some((value, index) => actual[index] !== value)) {
      throw invalid('model_policy_invalid', 'cross-family role invariants are mandatory');
    }
  }
}

function validatePolicy(raw, catalog) {
  if (!exactKeys(raw, ['version', 'mode', 'roles', 'modes']) || raw.version !== 1 ||
      !MODE_SET.has(raw.mode) || !isRecord(raw.modes)) {
    throw invalid('model_policy_invalid', 'top-level schema');
  }
  validateRoleMap(raw.roles);
  if (Object.keys(raw.modes).length !== ROUTING_MODES.length ||
      !ROUTING_MODES.every(mode => Object.hasOwn(raw.modes, mode))) {
    throw invalid('model_policy_invalid', 'modes must contain economy, balanced and sprint');
  }
  const modelIds = new Set(catalog.models.map(entry => entry.id));
  for (const mode of ROUTING_MODES) {
    const spec = raw.modes[mode];
    if (!exactKeys(spec, ['cost_tiers', 'status_priority', 'candidates']) ||
        !Array.isArray(spec.cost_tiers) || !spec.cost_tiers.length ||
        new Set(spec.cost_tiers).size !== spec.cost_tiers.length ||
        spec.cost_tiers.some(tier => !COST_SET.has(tier)) ||
        !Array.isArray(spec.status_priority) ||
        spec.status_priority.length !== ELIGIBLE_STATUSES.length ||
        new Set(spec.status_priority).size !== ELIGIBLE_STATUSES.length ||
        spec.status_priority.some(status => !ELIGIBLE_STATUSES.includes(status)) ||
        !isRecord(spec.candidates) ||
        Object.keys(spec.candidates).length !== REGISTRY_ROLES.length ||
        !REGISTRY_ROLES.every(role => Object.hasOwn(spec.candidates, role))) {
      throw invalid('model_policy_invalid', `modes.${mode}`);
    }
    for (const role of REGISTRY_ROLES) {
      const candidates = spec.candidates[role];
      if (!Array.isArray(candidates) || !candidates.length || candidates.length > 64 ||
          new Set(candidates).size !== candidates.length ||
          candidates.some(id => typeof id !== 'string' || !modelIds.has(id))) {
        throw invalid('model_policy_invalid', `modes.${mode}.candidates.${role}`);
      }
    }
  }
  return Object.freeze({
    version: 1,
    mode: raw.mode,
    roles: raw.roles,
    modes: raw.modes,
  });
}

export function defaultConfigDir() {
  const xdg = process.env.XDG_CONFIG_HOME;
  return join(xdg || join(homedir(), '.config'), 'darkfactory');
}

async function firstExisting(primary, fallback) {
  try {
    await access(primary);
    return primary;
  } catch {
    return fallback;
  }
}

export async function resolveRegistryPaths({ catalogPath, policyPath, configDir } = {}) {
  const dir = configDir ?? defaultConfigDir();
  const userCatalog = join(dir, 'models-catalog.yaml');
  const userPolicy = join(dir, 'routing-policy.yaml');

  // Без явных путей user-config рассматривается как пара: половинчатая
  // установка не смешивается молча с example, а fail-closed падает на missing file.
  if (!catalogPath && !policyPath) {
    const [hasCatalog, hasPolicy] = await Promise.all([
      access(userCatalog).then(() => true, () => false),
      access(userPolicy).then(() => true, () => false)]);
    if (hasCatalog || hasPolicy) return { catalogPath: userCatalog, policyPath: userPolicy };
    return { catalogPath: EXAMPLE_CATALOG_PATH, policyPath: EXAMPLE_POLICY_PATH };
  }

  return {
    catalogPath: catalogPath ?? await firstExisting(userCatalog, EXAMPLE_CATALOG_PATH),
    policyPath: policyPath ?? await firstExisting(userPolicy, EXAMPLE_POLICY_PATH),
  };
}

export async function loadModelRegistry({ catalogPath, policyPath, configDir, now = new Date() } = {}) {
  const paths = await resolveRegistryPaths({ catalogPath, policyPath, configDir });
  const catalog = validateCatalog(await readYamlFile(paths.catalogPath));
  const policy = validatePolicy(await readYamlFile(paths.policyPath), catalog);
  const modelById = new Map(catalog.models.map(entry => [entry.id, entry]));
  return Object.freeze({
    catalog,
    policy,
    modelById,
    catalogPath: paths.catalogPath,
    policyPath: paths.policyPath,
    loadedAt: new Date(timeMs(now)).toISOString(),
  });
}

function timeMs(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return Date.parse(value);
  return Date.now();
}

function quotaPctFor(entry, quota) {
  if (typeof quota === 'number') return quota;
  if (isRecord(quota) && typeof quota.quotaPct === 'number') return quota.quotaPct;
  return null;
}

export function effectiveStatus(entry, now = new Date(), quota = null) {
  const declared = entry.status;
  let status = declared;
  const expiry = untilMs(entry.until);
  const at = timeMs(now);
  if (expiry !== null && at > expiry) {
    if (declared === 'promo_free') status = 'standby';
    if (declared === 'quota_paused') status = 'active';
  }
  const quotaPct = quotaPctFor(entry, quota);
  if (declared !== 'disabled' && quotaPct !== null && quotaPct >= 95) return 'quota_paused';
  return status;
}

function quotaForEntry(quotas, entry) {
  if (!isRecord(quotas)) return null;
  const direct = quotas[entry.id];
  const key = `${entry.provider}/${entry.model}`;
  const value = direct ?? quotas[key];
  if (typeof value === 'number') return { quotaPct: value };
  if (isRecord(value) && typeof value.quotaPct === 'number') return value;
  return null;
}

function statusRank(status, priority) {
  const index = priority.indexOf(status);
  return index === -1 ? priority.length : index;
}

function publicEntry(entry, status, index, rank, quota) {
  return Object.freeze({
    id: entry.id,
    provider: entry.provider,
    model: entry.model,
    family: entry.family,
    status,
    declaredStatus: entry.status,
    cost_tier: entry.cost_tier,
    until: entry.until ?? null,
    capabilities: [...entry.capabilities],
    quota_source: entry.quota_source,
    quotaPct: quota?.quotaPct ?? null,
    reason: `eligible: status_priority=${rank}, candidate_order=${index}`,
  });
}

// Механический мост инвариантов worker-selector в реестр: запись каталога
// (или публичный элемент цепочки с теми же полями provider/model)
// исполняема L2 read-only раннером тогда и только тогда, когда её
// provider входит в строгий позитивный список L2_RUNNABLE_PROVIDERS —
// ключи PROVIDER_EGRESS review-runner.mjs. Сопоставление точное, без
// нормализации регистра: неканоническая форма ('Google') fail-closed
// неисполняема, как и нестроковый/отсутствующий provider или не-объект.
// Harness 'pi' сам egress не несёт: как в runnerReviewSpec, исполняемость
// определяет вложение 'provider/model' — первый сегмент модели в нижнем
// регистре обязан быть провайдером с egress ('pi/openai/gpt-6.2-sol'
// исполняем, 'pi/anthropic/claude-opus-5.5' и pi-запись без вложения —
// нет). Вырожденные вложения-харнессы без собственного egress
// консервативно отфильтровываются — fail-safe направление.
export function isL2RunnableEntry(entry) {
  if (!isRecord(entry) || typeof entry.provider !== 'string') return false;
  if (entry.provider === 'pi') {
    if (typeof entry.model !== 'string') return false;
    const slash = entry.model.indexOf('/');
    if (slash < 1) return false;
    return L2_RUNNABLE_SET.has(entry.model.slice(0, slash).toLowerCase());
  }
  return L2_RUNNABLE_SET.has(entry.provider);
}

// Закреплённая пара дефолтного контура (review-policy NEON_CRITIC /
// SOL_ARBITER): модель сопоставляется по финальному сегменту, чтобы обе
// формы записи — прямой провайдер ('google', 'gemini-4-neon') и вложение
// харнесса ('pi', 'openai/gpt-6.2-sol') — узнавались одинаково.
const finalModelSegment = model => typeof model === 'string'
  ? model.slice(model.lastIndexOf('/') + 1) : '';
const isNeonEntry = entry => entry?.family === 'google' &&
  finalModelSegment(entry?.model) === 'gemini-4-neon';
const isSolEntry = entry => entry?.family === 'openai' &&
  finalModelSegment(entry?.model) === 'gpt-6.2-sol';

// Ordinary catalog models carry one family; Fusion occupies two seats for
// independence purposes even though its public family is always the lead.
function entryFamilies(entry) {
  const meta = fusionModelMeta(entry.model);
  return meta ? [meta.leadFamily, meta.sidekickFamily] : [entry.family];
}

export function resolveRoleChain(registry, role, {
  mode,
  excludeFamilies = [],
  now = new Date(),
  quotas,
} = {}) {
  if (!ROLE_SET.has(role)) throw invalid('model_policy_invalid', `unknown role ${role}`);
  const activeMode = mode ?? registry.policy.mode;
  if (!MODE_SET.has(activeMode)) throw invalid('model_policy_invalid', `unknown mode ${activeMode}`);
  const modeSpec = registry.policy.modes[activeMode];
  if (!modeSpec) throw invalid('model_policy_invalid', `mode ${activeMode} is not configured`);
  const roleSpec = registry.policy.roles[role] ?? { required_capabilities: [] };
  const required = new Set([...(roleSpec.required_capabilities ?? []),
    ...(HARD_REQUIRED_CAPABILITIES[role] ?? [])]);
  if (!Array.isArray(excludeFamilies) ||
      excludeFamilies.some(family => !FAMILY_SET.has(String(family).toLowerCase()))) {
    throw invalid('model_policy_invalid', `invalid excludeFamilies for ${role}`);
  }
  const excluded = new Set(excludeFamilies.map(family => String(family).toLowerCase()));
  const allowedCost = new Set(modeSpec.cost_tiers);
  const candidates = modeSpec.candidates[role] ?? [];
  const eligible = [];

  candidates.forEach((id, index) => {
    const entry = registry.modelById.get(id);
    if (!entry || isForbiddenModel(entry)) return;
    const quota = quotaForEntry(quotas, entry);
    const status = effectiveStatus(entry, now, quota);
    if (status === 'disabled' || status === 'quota_paused') return;
    if (!allowedCost.has(entry.cost_tier)) return;
    if (entryFamilies(entry).some(family => excluded.has(family))) return;
    if ([...required].some(capability => !entry.capabilities.includes(capability))) return;
    eligible.push({ entry, status, index, quota });
  });

  return eligible
    .map(item => ({ ...item, rank: statusRank(item.status, modeSpec.status_priority) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(item => publicEntry(item.entry, item.status, item.index, item.rank, item.quota));
}

function selection(chain) {
  if (!chain.length) return null;
  const first = chain[0];
  return Object.freeze({
    ...first,
    alternatives: Object.freeze(chain.slice(1).map(entry => entry.id)),
    chain: Object.freeze(chain),
  });
}

export function resolveTriad(registry, { mode, now = new Date(), quotas, strictL2 = false } = {}) {
  const activeMode = mode ?? registry.policy.mode;
  const chainFor = (role, excludeFamilies = []) => {
    const chain = resolveRoleChain(registry, role, {
      mode: activeMode, now, quotas, excludeFamilies });
    // strictL2: reviewer и arbiter исполняются read-only L2 раннером —
    // кандидаты ACP-харнессов (acp-devin/claude-*, codex-acp, bb) в этом
    // sandbox не запускаются и отфильтровываются механически, как в
    // worker-selector. Дефолт false сохраняет прежний контракт резолва.
    return strictL2 && (role === 'reviewer' || role === 'arbiter')
      ? chain.filter(isL2RunnableEntry) : chain;
  };
  const coderChain = chainFor('coder_default');

  // Лексикографический backtracking по уже отсортированным предпочтениям:
  // сначала coder, затем reviewer. Полная тройка важнее частной, поэтому если
  // первый reviewer не оставляет arbiter третьего семейства, проверяется
  // следующий reviewer; если coder вообще не оставляет reviewer — следующий coder.
  let chosen = null;
  let partial = null;
  for (const coder of coderChain) {
    const reviewerChain = chainFor('reviewer', entryFamilies(coder));
    if (reviewerChain.length && !partial) partial = { coder, reviewerChain };
    for (const reviewer of reviewerChain) {
      const arbiterChain = chainFor('arbiter', [...entryFamilies(coder), ...entryFamilies(reviewer)]);
      if (arbiterChain.length) {
        chosen = { coder, reviewer, reviewerChain, arbiterChain };
        break;
      }
    }
    if (chosen) break;
  }

  if (!chosen) {
    if (partial) {
      const reviewer = partial.reviewerChain[0];
      chosen = { coder: partial.coder, reviewer, reviewerChain: partial.reviewerChain,
        arbiterChain: [] }; // Backtracking already exhausted every arbiter.
    } else if (coderChain.length) {
      const coder = coderChain[0];
      chosen = { coder, reviewer: null, reviewerChain: [],
        arbiterChain: chainFor('arbiter', entryFamilies(coder)) };
    } else {
      const reviewerChain = chainFor('reviewer');
      const reviewer = reviewerChain[0] ?? null;
      chosen = { coder: null, reviewer, reviewerChain,
        arbiterChain: chainFor('arbiter', reviewer ? entryFamilies(reviewer) : []) };
    }
  }

  const leadChain = chainFor('lead');
  const uxChain = chainFor('ux_critic');
  const coderCandidate = chosen.coder;
  const reviewerCandidate = chosen.reviewer;

  // Закреплённая пара дефолтного контура: при reviewer Neon арбитр Sol
  // идёт первым в цепочке арбитра, если он вообще допустим (прошёл
  // фильтры статуса, квоты, стоимости и кросс-семейных исключений), —
  // независимо от общего порядка кандидатов режима.
  if (strictL2 && reviewerCandidate && isNeonEntry(reviewerCandidate) &&
      chosen.arbiterChain.length > 1) {
    const solIndex = chosen.arbiterChain.findIndex(isSolEntry);
    if (solIndex > 0) {
      chosen.arbiterChain = [chosen.arbiterChain[solIndex],
        ...chosen.arbiterChain.filter((_, index) => index !== solIndex)];
    }
  }

  return Object.freeze({
    coder: coderCandidate ? selection([coderCandidate,
      ...coderChain.filter(entry => entry.id !== coderCandidate.id)]) : null,
    reviewer: reviewerCandidate ? selection([reviewerCandidate,
      ...chosen.reviewerChain.filter(entry => entry.id !== reviewerCandidate.id)]) : null,
    arbiter: selection(chosen.arbiterChain),
    lead: selection(leadChain),
    ux_critic: selection(uxChain),
  });
}

// Мост реестра в пайплайн: единый источник истины для routing.allowlist
// run-isolated.mjs/factory-run.mjs. worker — цепочка coder_default без
// L2-фильтра (воркер исполняется полным харнессом bb/hc, а не read-only
// раннером); critic/arbiter — цепочки reviewer/arbiter, механически
// отфильтрованные isL2RunnableEntry: ACP-харнессы в L2 не запускаются.
// Кросс-семейные исключения здесь не применяются: конкретную тройку
// выбирает рантайм-селектор из этого пула, а мост даёт допустимые пули
// ролей в канонической форме { provider, model }.
export function toPipelineAllowlist(registry, { mode, now = new Date(), quotas } = {}) {
  const activeMode = mode ?? registry.policy.mode;
  const chain = role => resolveRoleChain(registry, role, { mode: activeMode, now, quotas });
  const spec = entry => Object.freeze({ provider: entry.provider, model: entry.model });
  const workers = chain('coder_default');
  const withSidekick = workers.some(fusionMetaOf);
  const runnableReader = entry => isL2RunnableEntry(entry) && (!withSidekick || sidekickSafeReader(entry));
  return Object.freeze({
    worker: Object.freeze(workers.map(spec)),
    critic: Object.freeze(chain('reviewer').filter(runnableReader).map(spec)),
    arbiter: Object.freeze(chain('arbiter').filter(runnableReader).map(spec)),
  });
}

function compactChain(chain) {
  return chain.map(entry => ({
    id: entry.id,
    provider: entry.provider,
    model: entry.model,
    family: entry.family,
    status: entry.status,
    cost_tier: entry.cost_tier,
    reason: entry.reason,
  }));
}

function compactSelection(selected) {
  if (!selected) return null;
  return {
    id: selected.id,
    provider: selected.provider,
    model: selected.model,
    family: selected.family,
    status: selected.status,
    alternatives: [...selected.alternatives],
  };
}

export function registrySnapshot(registry, { mode, now = new Date(), quotas } = {}) {
  const activeMode = mode ?? registry.policy.mode;
  const triad = resolveTriad(registry, { mode: activeMode, now, quotas });
  const independent = role => resolveRoleChain(registry, role, { mode: activeMode, now, quotas });
  const contextual = {
    lead: independent('lead'),
    coder_default: triad.coder?.chain ?? [],
    coder_heavy: independent('coder_heavy'),
    reviewer: triad.reviewer?.chain ?? [],
    arbiter: triad.arbiter?.chain ?? [],
    ux_critic: independent('ux_critic'),
  };
  const roles = Object.fromEntries(REGISTRY_ROLES.map(role => [role, compactChain(contextual[role])]));
  return {
    mode: activeMode,
    generated_at: new Date(timeMs(now)).toISOString(),
    models: registry.catalog.models.map(entry => {
      const quota = quotaForEntry(quotas, entry);
      return {
        id: entry.id,
        provider: entry.provider,
        model: entry.model,
        family: entry.family,
        status: entry.status,
        effectiveStatus: effectiveStatus(entry, now, quota),
        cost_tier: entry.cost_tier,
        until: entry.until ?? null,
        capabilities: [...entry.capabilities],
        quota_source: entry.quota_source,
        quotaPct: quota?.quotaPct ?? null,
        notes: entry.notes,
      };
    }),
    roles,
    triad: Object.fromEntries(Object.entries(triad).map(([role, selected]) =>
      [role, compactSelection(selected)])),
  };
}
