// Declarative config is compiled without filesystem access. The async contract
// check is deliberately separate: only the operator can validate host paths.
import { createHash } from 'node:crypto';
import { lstat, readdir, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, normalize, resolve } from 'node:path';
import { inside } from './fs-safe.mjs';
import { effectiveL1ProfileId, resolveL1Profile } from './l1-profiles.mjs';
import { assertPolicyModelMatrix } from './model-registry.mjs';
import { boardActivation, createPilotSwitch } from './pilot-gate.mjs';
import { isReviewSkillList, reviewPanelPolicy } from './review-policy.mjs';
import { isAllowedCandidateNodeModulesTarget } from './runtime.mjs';
import { assertTriadIndependent } from './worker-selector.mjs';
import { resolveWorkerRuntimeKind } from './run-transport.mjs';

function fail(code) { throw new Error(code); }
const record = v => v !== null && typeof v === 'object' &&
  [null, Object.prototype].includes(Object.getPrototypeOf(v));
const nonempty = v => typeof v === 'string' && v.trim() !== '';
const overlaps = (a, b) => inside(a, b) || inside(b, a);
const systemMounts = new Set(['/usr', '/etc/fonts', '/etc/texmf', '/var/lib/texmf', '/opt/google/chrome']);

// Preserve the established input/model tuple order; sort all other JSON keys.
// Arrays (notably the sequence of checks and selected skills) stay ordered.
const digestKeyOrder = new Map(['brief', 'reviewPrompt', 'reviewGate', 'route', 'profiles', 'provider', 'model', 'reasoningLevel']
  .map((key, rank) => [key, rank]));
function canonicalJson(value) {
  return JSON.stringify(value, (_, v) => !record(v) ? v : Object.fromEntries(Object.keys(v).sort((a, b) => {
    return (digestKeyOrder.get(a) ?? digestKeyOrder.size) - (digestKeyOrder.get(b) ?? digestKeyOrder.size) ||
      (a < b ? -1 : a > b ? 1 : 0);
  }).map(key => [key, v[key]])));
}
const digestBytes = bytes => createHash('sha256').update(bytes).digest('hex');
const ruleFields = entry => {
  if (!record(entry)) return entry;
  const { base, worktree, ...rules } = entry;
  return rules;
};

/** Card identity, not the controller's byte-exact WAL/input integrity pin. */
export function canonicalPolicyDigest({ policy, brief, reviewPrompt, reviewGate, routes, skills = [], reviewSetup }) {
  if (!record(policy) || (!record(routes) && !Array.isArray(routes))) fail('policy_inputs_invalid');
  const normalizeEntries = entries => Array.isArray(entries) ? entries.map(ruleFields)
    : record(entries) ? Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, ruleFields(v)])) : entries;
  const reviewRoutes = Array.isArray(routes) ? normalizeEntries(routes)
    : { ...routes, routes: normalizeEntries(routes.routes) };
  const inputs = [canonicalJson({ ...policy, route: ruleFields(policy.route) }), brief, reviewPrompt,
    reviewGate, canonicalJson(reviewRoutes), ...skills];
  // The critic (including skill order) can be partly selected by host
  // enrollment. Bind its resolved setup when it isn't already explicit in
  // the policy. The default arbiter is determined by that critic.
  const declared = policy.profiles?.[policy.route?.checkProfile]?.review ?? {};
  if (reviewSetup && Object.keys(reviewSetup.critic).some(k => !Object.hasOwn(declared, k))) {
    inputs.push(canonicalJson({ critic: reviewSetup.critic, arbiter: reviewSetup.arbiter }));
  }
  return digestBytes(JSON.stringify(inputs.map(digestBytes)));
}

// Selected skill order is significant to reviewText. Also pin bytes of the
// remaining operator bindings so changing an alternate profile's skill is drift.
export function policySkillPaths(policy, setup) {
  const files = policy.reviewSkillFiles ?? {};
  return [...setup.skillPaths, ...Object.keys(files).filter(k => !setup.skills.includes(k)).sort().map(k => files[k])];
}

export async function canonicalPolicyPath(path, kind, missing = 'path_missing') {
  if (typeof path !== 'string' || !isAbsolute(path)) fail('path_not_absolute');
  if (await realpath(path).catch(() => fail(missing)) !== path) fail('non_canonical_or_symlink_path');
  const stat = await lstat(path);
  if (stat.isSymbolicLink()) fail('non_canonical_or_symlink_path');
  if (kind === 'dir' && !stat.isDirectory()) fail('path_not_dir');
  if (kind === 'file' && !stat.isFile()) fail('path_not_file');
  return path;
}

function effectivePath(cfg, keys, flag, fallback, name) {
  let pinned;
  if (cfg === null || flag === null || flag === '') fail('path_not_absolute');
  if (typeof cfg === 'string') pinned = cfg;
  else if (cfg !== undefined) {
    if (!record(cfg)) fail('policy_invalid');
    for (const key of keys) {
      if (cfg[key] === '' || cfg[key] === null) fail('path_not_absolute');
      if (pinned === undefined) pinned = cfg[key];
    }
  }
  if (pinned === '') fail('path_not_absolute');
  if (flag !== undefined && pinned !== undefined && flag !== pinned) fail(`${name}_mismatch`);
  const resolved = flag ?? pinned ?? fallback;
  return resolved === undefined || resolved === '' ? null : resolved;
}

export const runtimeKind = cliRuntime => resolveWorkerRuntimeKind({ cliRuntime });

function selectedProfile(policy) {
  const name = policy.route?.checkProfile;
  if (!nonempty(name) || !record(policy.profiles) || !Object.hasOwn(policy.profiles, name) ||
      !record(policy.profiles[name]) || !nonempty(policy.profiles[name].branch)) fail('profile_required');
  const profile = policy.profiles[name];
  // Legacy policies may supply a single check (or an external profile), but
  // an explicit empty list with no other recipe is never an executable gate.
  if (profile.checks !== undefined && (!Array.isArray(profile.checks) ||
      (!profile.checks.length && profile.visual === undefined && profile.check === undefined))) fail('profile_required');
  return profile;
}

const recipes = p => [...(p?.checks ?? []), ...[p?.check, p?.visual].filter(v => v !== undefined)];

// An optional leaf (socket or switch) may not exist yet. Check the original
// spelling, parent and existing leaf, not merely the normalized destination.
async function optionalLeaf(path, trees) {
  if (typeof path !== 'string' || !isAbsolute(path)) fail('path_not_absolute');
  if (normalize(path) !== path || path.endsWith('/')) fail('non_canonical_or_symlink_path');
  const dir = await canonicalPolicyPath(dirname(path));
  if (trees.some(tree => overlaps(tree, dir))) fail('path_inside_worktree');
  const stat = await lstat(path).catch(e => e.code === 'ENOENT' ? null : fail('non_canonical_or_symlink_path'));
  if (stat?.isSymbolicLink()) fail('non_canonical_or_symlink_path');
  return { dir, stat };
}

async function assertPrivate(dir, reason) {
  const st = await lstat(dir);
  if (!st.isDirectory() || st.uid !== process.getuid() || (st.mode & 0o077) !== 0) fail(reason);
}

/** Check policy and optional launch inputs before any Git or controller effects.
 * Standalone callers need no CLI state. Additional worktree aliases can only
 * extend the exclusion boundary, never replace the policy's worktree.
 */
export async function validatePolicyContract(policy, {
  env = {}, worktreeAliases = [], cli = {}, policyFile, registry,
} = {}) {
  if (!record(policy?.bb)) fail('policy_bb_missing');
  if ((cli.provider !== undefined || cli.model !== undefined) &&
      (cli.provider !== policy.bb.provider || cli.model !== policy.bb.model)) fail('cli_spec_mismatch_policy_bb');
  assertPolicyModelMatrix({ policy, cli: cli.provider === undefined ? undefined : cli, registry });
  const runtime = resolveWorkerRuntimeKind({ cliRuntime: cli.runtime, policy, env });
  for (const p of Object.values(policy.profiles ?? {})) {
    if (!record(p) || (p.checks !== undefined && !Array.isArray(p.checks))) fail('profile_required');
    for (const source of [p, ...recipes(p)]) resolveL1Profile({ l1Profile: source?.l1Profile });
  }
  const profile = selectedProfile(policy);
  const l1 = { cliProfile: cli['l1-profile'], profileL1: profile.l1Profile, repoId: policy.route.repoId };
  const l1Profile = effectiveL1ProfileId(l1);
  if (!nonempty(policy.route.worktree)) fail('worktree_required');
  const worktree = await canonicalPolicyPath(policy.route.worktree, 'dir', 'worktree_missing');
  if (cli.worktree !== undefined &&
      await canonicalPolicyPath(cli.worktree, 'dir', 'worktree_missing') !== worktree) fail('worktree_mismatch');
  const trees = [worktree, ...worktreeAliases];
  if (trees.some(t => !nonempty(t) || !isAbsolute(t) || normalize(t) !== t)) fail('non_canonical_or_symlink_path');
  async function outside(path, kind, guardParent = false) {
    await canonicalPolicyPath(path, kind);
    if (trees.some(t => overlaps(t, path) || (guardParent && inside(dirname(path), t)))) fail('path_inside_worktree');
    return path;
  }

  const ledger = effectivePath(policy.decisionLedger, ['path'], cli['ledger-path'],
    env.DF_DECISION_LEDGER_PATH, 'decision_ledger');
  const memory = effectivePath(policy.projectMemory, ['storeDir', 'dir', 'path'], cli['memory-dir'],
    env.DF_PROJECT_MEMORY_DIR, 'project_memory');
  const files = [];
  if (policyFile !== undefined) files.push(await outside(policyFile, 'file'));
  for (const file of [policy.brief, policy.reviewPrompt, policy.reviewGate]) {
    if (file === undefined) fail('operator_files_required');
    files.push(await outside(file, 'file'));
  }
  for (const file of Object.values(policy.reviewSkillFiles ?? {})) files.push(await outside(file, 'file'));
  files.push(await outside(join(dirname(policy.reviewGate), 'routes.json'), 'file'));

  const mounts = [];
  for (const recipe of recipes(profile)) {
    effectiveL1ProfileId({ ...l1, cardL1: recipe?.l1Profile });
    for (const mount of recipe?.mounts ?? []) {
      const from = await canonicalPolicyPath(mount?.from, 'dir');
      const to = mount.to;
      if (!((to === '/deps' && basename(from) === 'site-packages') ||
          (systemMounts.has(to) && to === from) || (isAllowedCandidateNodeModulesTarget(to) &&
            !/[\u0080-\u009f]/.test(to) && basename(from) === 'node_modules'))) fail('mount_outside_allowlist');
      mounts.push(from);
    }
  }
  if (policy.abPilot !== undefined && policy.abPilot?.switch === undefined) fail('path_not_absolute');
  if (cli.daemon && cli.switch === undefined && policy.pilot?.killSwitch === undefined) fail('daemon_switch_required');
  const switches = [];
  for (const path of new Set([cli.switch, policy.pilot?.killSwitch, policy.abPilot?.switch])) {
    if (path === undefined) continue;
    const { dir, stat } = await optionalLeaf(path, trees);
    await assertPrivate(dir, 'switch_dir_not_private');
    if (stat && !stat.isFile()) fail('path_not_file');
    switches.push(dir);
  }
  if (cli['event-socket'] !== undefined) await optionalLeaf(cli['event-socket'], trees);
  if (ledger !== null) await outside(ledger, 'file', true);
  if (memory !== null) await outside(memory, 'dir', true);
  const receipts = policy.projectMemory?.trustedReceiptDir;
  if (receipts !== undefined) await outside(receipts, 'dir', true);
  const inbox = policy.questionGate?.inbox;
  if (inbox !== undefined) await outside(inbox, 'dir');
  const release = policy.release?.directory;
  if (release !== undefined) await outside(release, 'dir');
  const state = cli.state;
  if (state !== undefined) {
    await outside(state, 'dir');
    await assertPrivate(state, 'state_not_private');
  }
  if (policy.handoffDir === undefined) fail('handoff_required');
  const handoff = await outside(policy.handoffDir, 'dir');
  const separate = (path, others) => {
    if (others.some(p => p != null && overlaps(p, path))) fail('path_inside_worktree');
  };
  separate(handoff, [state, memory, receipts, inbox, release, ledger && dirname(ledger), ...files, ...switches]);
  for (const path of mounts) separate(path, [...trees, handoff]);
  if (state !== undefined) separate(state, [release, ...switches]);
  const catalog = policy.abPilot?.catalog;
  const workspace = policy.abPilot?.observerWorkspace;
  for (const path of [catalog, workspace]) {
    if (path === undefined) continue;
    await outside(path, 'dir');
    separate(path, [state, handoff]);
  }
  if (workspace !== undefined) {
    separate(workspace, [catalog]);
    if ((await readdir(workspace)).length) fail('path_not_empty');
  }
  const permitDirectory = dir => ![...trees, handoff, state].some(p => p && overlaps(p, dir));
  if (policy.abPilot !== undefined) await (await createPilotSwitch(policy.abPilot.switch, { permitDirectory }))();
  if (policy.scope === 'pilot' && policy.pilot?.enabled === true) {
    if (policy.pilot.killSwitch === undefined) fail('pilot_switch_invalid');
    const assertOpen = await createPilotSwitch(policy.pilot.killSwitch, { permitDirectory });
    if (!cli.daemon) await assertOpen();
  }
  return { worktree, l1Profile, state, ledger, memory, handoff, runtime };
}

const invalid = field => fail(`config_invalid:${field}`);
const identifier = v => nonempty(v) && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(v) &&
  !Object.hasOwn(Object.prototype, v) && v !== 'prototype';

// Supported YAML subset: two-space block mappings/sequences, plain/quoted
// scalars and JSON flow values. No tags, merge keys,
// anchors, implicit dates or interpolation. Reject unsupported syntax rather
// than silently giving it a different meaning. JSON documents also work.
function parseJson(text) {
  const value = JSON.parse(text); // check grammar before scanning for duplicate keys
  const maps = [];
  for (const token of text.matchAll(/"(?:\\.|[^"\\])*"\s*:?|[{}]/g)) {
    if (token[0] === '{') maps.push(new Set());
    else if (token[0] === '}') maps.pop();
    else if (token[0].endsWith(':')) {
      const key = JSON.parse(token[0].slice(0, -1));
      if (maps.at(-1).has(key)) invalid(`duplicate:${key}`);
      maps.at(-1).add(key);
    }
  }
  return value;
}

function uncomment(value) {
  let quote;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (quote) {
      if (ch === '\\' && quote === '"') i++;
      else if (quote === ch) quote = undefined;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '#' && (i === 0 || value[i - 1] === ' ')) return value.slice(0, i).trimEnd();
  }
  if (quote) invalid('yaml_quote');
  return value;
}

function parseConfig(text) {
  if (!nonempty(text)) invalid('document');
  const input = text.trimStart();
  if (input.startsWith('{')) return parseJson(input);
  const lines = [];
  const mapping = /^([\w.-]+):(?: +(.*)|$)/;
  for (const line of text.split(/\r?\n/)) {
    const body = uncomment(line).trimEnd();
    if (!body) continue;
    const indent = body.length - body.trimStart().length;
    if (indent % 2 || !body.startsWith(' '.repeat(indent))) invalid('yaml_indent');
    const token = body.slice(indent);
    // '- key: value' is a sequence item containing an indented mapping.
    if (token.startsWith('- ') && mapping.test(token.slice(2))) {
      lines.push({ indent, token: '-' }, { indent: indent + 2, token: token.slice(2) });
    } else lines.push({ indent, token });
  }
  let cursor = 0;
  function value(raw, indent) {
    if (!raw) return lines[cursor]?.indent > indent ? block(indent + 2) : null;
    if (/^[\[{"]/.test(raw) || /^(true|false|null|-?\d+(?:\.\d+)?)$/.test(raw)) return parseJson(raw);
    if (/^'(?:[^']|'')*'$/.test(raw)) return raw.slice(1, -1).replaceAll("''", "'");
    if (/^[\w./-]/.test(raw) && raw !== '-' && !/:\s/.test(raw)) return raw;
    invalid('yaml_scalar');
  }
  function block(indent) {
    if (indent > 128 || lines[cursor]?.indent !== indent) invalid('yaml_indent');
    const sequence = /^-(?: |$)/.test(lines[cursor].token);
    const result = sequence ? [] : Object.create(null);
    while (lines[cursor]?.indent === indent) {
      const { token } = lines[cursor++];
      if (sequence) {
        if (!/^-(?: |$)/.test(token)) invalid('yaml_sequence');
        result.push(value(token.slice(1).trimStart(), indent));
      } else {
        const match = mapping.exec(token);
        if (!match || !identifier(match[1])) invalid('yaml_mapping');
        if (Object.hasOwn(result, match[1])) invalid(`duplicate:${match[1]}`);
        result[match[1]] = value(match[2], indent);
      }
    }
    return result;
  }
  const root = block(0);
  if (cursor !== lines.length) invalid('yaml_indent');
  return root;
}

function fields(value, name, required, optional = []) {
  if (!record(value)) invalid(name);
  for (const key of Object.keys(value)) {
    if (![...required, ...optional].includes(key)) invalid(`${name}.${key}`);
  }
  for (const key of required) if (!Object.hasOwn(value, key)) invalid(`${name}.${key}`);
  return value;
}

function string(value, field) {
  if (!nonempty(value)) invalid(field);
  return value;
}

function recipe(value, profileL1) {
  fields(value, 'gates.check', ['image', 'argv', 'cwd', 'timeoutMs'], ['l1Profile']);
  if (typeof value.image !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value.image) ||
      !Array.isArray(value.argv) || !value.argv.length || !Array.from(value.argv).every(nonempty) || !nonempty(value.cwd) || isAbsolute(value.cwd) ||
      value.cwd.split('/').includes('..') || !Number.isSafeInteger(value.timeoutMs) || value.timeoutMs < 1) {
    invalid('gates.check');
  }
  effectiveL1ProfileId({ profileL1, cardL1: value.l1Profile });
  return { image: value.image, argv: [...value.argv], cwd: value.cwd, timeoutMs: value.timeoutMs,
    ...(value.l1Profile === undefined ? {} : { l1Profile: value.l1Profile }) };
}

// Operational sections below have closed schemas at every level. At the root,
// arbitrary annotations belong in metadata or x-display-*. Never guess that an
// unknown switch is safe to ignore based on its spelling or its value's type.
const displayAnnotation = key => /^(?:name|title|caption|metadata|display|notes|description|x-display-[\w-]+)$/.test(key);

// V1 describes one isolated, verified slot. There are deliberately no live
// Board, release, unsafe subprocess, or gate-skipping switches in this DSL.
// Models are named pairs; roles select names, not a second copy of each pair.
// self_heal binds optional trusted memory/decision inputs, not an authority
// to accept, retry indefinitely, or change the controller's retry policy.
export function compileDarkfactoryConfig({ yamlText, configObject, baseDir } = {}) {
  if ((yamlText === undefined) === (configObject === undefined)) invalid('one_input_required');
  const cfg = yamlText === undefined ? configObject : parseConfig(yamlText);
  if (!record(cfg)) invalid('document');
  if (baseDir !== undefined && (!nonempty(baseDir) || baseDir.includes('\0') ||
      !isAbsolute(baseDir) || resolve(baseDir) !== baseDir)) invalid('baseDir');
  const path = (value, field) => {
    string(value, field);
    if (value.includes('\0') || value.endsWith('/') || value.split('/').some(s => s === '..' || s === '.') || normalize(value) !== value) invalid(field);
    if (isAbsolute(value)) return value;
    if (!baseDir) invalid('baseDir');
    return resolve(baseDir, value);
  };
  const consumers = {
    project: ['bb.project', 'route.repoId', 'profiles'], topology: ['route', 'handoffDir'],
    board: ['boardUrl', 'owner', 'label'], runtime: [],
    models: ['bb', 'profiles', 'arbiter'], roles: ['bb', 'profiles', 'arbiter'],
    gates: ['brief', 'reviewPrompt', 'reviewGate', 'route.checkProfile', 'profiles'],
    self_heal: [], version: ['version', 'route.policyVersion'],
  };
  const consumedBy = Object.create(null);
  for (const key of Object.keys(cfg).sort()) {
    if (Object.hasOwn(consumers, key)) consumedBy[key] = [...consumers[key]];
    else {
      if (!displayAnnotation(key)) invalid(`unknown_directive:${key}`);
      consumedBy[key] = [];
    }
  }
  if (Object.hasOwn(cfg, 'version') && cfg.version !== 1) invalid('version');
  const project = fields(cfg.project, 'project', ['id', 'repoId', 'branch']);
  if (!/^proj_[a-z0-9]+$/.test(string(project.id, 'project.id'))) invalid('project.id');
  const topology = fields(cfg.topology, 'topology', ['worktree', 'base', 'handoffDir']);
  if (topology.base !== 'HEAD' && (typeof topology.base !== 'string' || !/^[0-9a-f]{40}$/.test(topology.base))) invalid('topology.base');
  const board = fields(cfg.board, 'board', ['url', 'owner', 'label']);
  fields(board.label, 'board.label', ['key', 'value']);
  const runtime = !Object.hasOwn(cfg, 'runtime') ? {} : fields(cfg.runtime, 'runtime', [], ['kind', 'waitMs']);
  if (runtime.kind !== undefined) consumedBy.runtime.push('workerRuntime');
  if (runtime.waitMs !== undefined) consumedBy.runtime.push('waitMs');
  const waitMs = runtime.waitMs === undefined ? 540000 : runtime.waitMs;
  if (!Number.isSafeInteger(waitMs) || waitMs < 1) invalid('runtime.waitMs');
  const roles = fields(cfg.roles, 'roles', ['worker', 'critic', 'arbiter']);
  if (!record(cfg.models)) invalid('models');
  const models = new Map();
  for (const [id, spec] of Object.entries(cfg.models)) {
    if (!identifier(id)) invalid('models.id');
    fields(spec, `models.${id}`, ['provider', 'model'], ['reasoningLevel']);
    if (!Object.values(roles).includes(id)) invalid(`models.unused:${id}`);
    models.set(id, { provider: string(spec.provider, 'provider'), model: string(spec.model, 'model'),
      ...(spec.reasoningLevel === undefined ? {} : { reasoningLevel: string(spec.reasoningLevel, 'reasoningLevel') }) });
  }
  function role(name) { return models.get(roles[name]) ?? invalid(`roles.${name}`); }
  const gates = fields(cfg.gates, 'gates', ['profile', 'checks', 'brief', 'reviewPrompt', 'reviewGate'],
    ['l1Profile', 'visual', 'reviewSkillFiles', 'reviewPanel']);
  if (!identifier(gates.profile) || !Array.isArray(gates.checks) || !gates.checks.length) invalid('gates.profile');
  resolveL1Profile({ l1Profile: gates.l1Profile });
  const compiledPolicy = {
    version: 1, scope: 'isolated', channel: 'pilot', boardUrl: string(board.url, 'board.url'),
    owner: string(board.owner, 'board.owner'), label: { key: string(board.label.key, 'label.key'), value: string(board.label.value, 'label.value') },
    workerRuntime: runtimeKind(runtime.kind), waitMs,
    handoffDir: path(topology.handoffDir, 'topology.handoffDir'),
    brief: path(gates.brief, 'gates.brief'), reviewPrompt: path(gates.reviewPrompt, 'gates.reviewPrompt'), reviewGate: path(gates.reviewGate, 'gates.reviewGate'),
    bb: { ...role('worker'), project: project.id }, arbiter: role('arbiter'),
    route: { worktree: path(topology.worktree, 'topology.worktree'), base: topology.base, repoId: string(project.repoId, 'project.repoId'),
      policyVersion: 1, checkProfile: gates.profile, finish: 'verified' },
    profiles: { [gates.profile]: { branch: string(project.branch, 'project.branch'), review: role('critic'),
      checks: Array.from(gates.checks, r => recipe(r, gates.l1Profile)),
      ...(gates.visual === undefined ? {} : { visual: recipe(gates.visual, gates.l1Profile) }),
      ...(gates.l1Profile === undefined ? {} : { l1Profile: gates.l1Profile }) } },
  };
  if (Object.hasOwn(gates, 'reviewPanel')) {
    const panel = fields(gates.reviewPanel, 'gates.reviewPanel', [], ['mode', 'size']);
    try { compiledPolicy.profiles[gates.profile].reviewPanel = reviewPanelPolicy(panel); }
    catch { invalid('gates.reviewPanel'); }
  }
  if (Object.hasOwn(gates, 'reviewSkillFiles')) {
    if (!record(gates.reviewSkillFiles) || !isReviewSkillList(Object.keys(gates.reviewSkillFiles))) invalid('gates.reviewSkillFiles');
    compiledPolicy.reviewSkillFiles = Object.fromEntries(Object.keys(gates.reviewSkillFiles).sort()
      .map(skill => [skill, path(gates.reviewSkillFiles[skill], `gates.reviewSkillFiles.${skill}`)]));
    consumedBy.gates.push('reviewSkillFiles');
  }
  if (Object.hasOwn(cfg, 'self_heal')) {
    const heal = fields(cfg.self_heal, 'self_heal', [], ['memoryDir', 'ledgerPath']);
    for (const [key, dest] of [['memoryDir', 'projectMemory'], ['ledgerPath', 'decisionLedger']]) {
      if (Object.hasOwn(heal, key)) {
        compiledPolicy[dest] = path(heal[key], `self_heal.${key}`);
        consumedBy.self_heal.push(dest);
      }
    }
  }
  boardActivation(compiledPolicy);
  assertPolicyModelMatrix({ policy: compiledPolicy });
  assertTriadIndependent({ executor: compiledPolicy.bb, critic: role('critic'), arbiter: compiledPolicy.arbiter });
  const displayOnlyKeys = Object.keys(consumedBy).filter(key => !consumedBy[key].length).sort();
  return { compiledPolicy, consumedBy, displayOnlyKeys };
}
