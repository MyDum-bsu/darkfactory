#!/usr/bin/env node
// df-models — операторский CLI декларативного реестра моделей.
// Пишет только в выбранный config-dir атомарно (tmp + rename, 0600); без
// --config-dir используется $XDG_CONFIG_HOME/darkfactory или ~/.config/darkfactory.

import { access, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { parse, stringify } from 'yaml';
import {
  COST_TIERS,
  EXAMPLE_CATALOG_PATH,
  EXAMPLE_POLICY_PATH,
  MODEL_FAMILIES,
  MODEL_STATUSES,
  REGISTRY_ROLES,
  ROUTING_MODES,
  defaultConfigDir,
  effectiveStatus,
  loadModelRegistry,
  registrySnapshot,
  resolveTriad,
  untilMs,
} from '../board_pipeline/model-registry.mjs';

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const USAGE = `usage:
  node ops/df-models.mjs list [--json] [--config-dir DIR]
  node ops/df-models.mjs effective [--mode economy|balanced|sprint] [--json] [--config-dir DIR]
  node ops/df-models.mjs set <id> <status> [--until YYYY-MM-DD] [--config-dir DIR]
  node ops/df-models.mjs mode <economy|balanced|sprint> [--config-dir DIR]
  node ops/df-models.mjs add --id ID --provider P --model M --family F [--status active] [--cost subscription] [--until DATE] [--capabilities a,b] [--config-dir DIR]
  node ops/df-models.mjs check [--config-dir DIR]`;

const COMMAND_OPTIONS = {
  list: new Set(['json', 'config-dir']),
  effective: new Set(['json', 'config-dir', 'mode']),
  set: new Set(['until', 'config-dir']),
  mode: new Set(['config-dir']),
  add: new Set(['id', 'provider', 'model', 'family', 'status', 'cost', 'until',
    'capabilities', 'config-dir', 'quota-source', 'notes']),
  check: new Set(['config-dir']),
  help: new Set(),
  '--help': new Set(),
};

function parseCliArgs(args, command) {
  const positional = [];
  const options = {};
  const allowed = COMMAND_OPTIONS[command] ?? new Set();
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const key = arg.slice(2);
    if (!key) throw new Error('empty option');
    if (!allowed.has(key)) throw new Error(`unknown option --${key} for command ${command ?? 'help'}`);
    if (key === 'json') {
      options[key] = true;
      continue;
    }
    const value = args[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`option --${key} requires a value`);
    options[key] = value;
    i += 1;
  }
  return { positional, options };
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function stageConfigFile(path, content) {
  const full = resolve(path);
  const tmp = `${full}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(tmp, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  return tmp;
}

async function cleanupFiles(paths) {
  await Promise.all(paths.map(path => unlink(path).catch(() => {})));
}

async function ensureConfigFiles(configDir) {
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  const catalogPath = join(configDir, 'models-catalog.yaml');
  const policyPath = join(configDir, 'routing-policy.yaml');
  const [hasCatalog, hasPolicy] = await Promise.all([exists(catalogPath), exists(policyPath)]);
  if (hasCatalog !== hasPolicy) {
    throw new Error('model config incomplete: models-catalog.yaml and routing-policy.yaml must exist as a pair');
  }
  return { catalogPath, policyPath, exists: hasCatalog };
}

async function readMutableConfig(configDir) {
  const paths = await ensureConfigFiles(configDir);
  if (!paths.exists) {
    return { ...paths,
      catalog: parse(await readFile(EXAMPLE_CATALOG_PATH, 'utf8')),
      policy: parse(await readFile(EXAMPLE_POLICY_PATH, 'utf8')) };
  }
  await loadModelRegistry({ catalogPath: paths.catalogPath, policyPath: paths.policyPath, now: new Date() });
  return { ...paths,
    catalog: parse(await readFile(paths.catalogPath, 'utf8')),
    policy: parse(await readFile(paths.policyPath, 'utf8')) };
}

async function writeConfigMutation(configDir, mutate, primary) {
  const config = await readMutableConfig(configDir);
  mutate(config);
  const catalogText = `${stringify(config.catalog)}\n`;
  const policyText = `${stringify(config.policy)}\n`;
  const staged = [];
  try {
    staged.push(await stageConfigFile(config.catalogPath, catalogText));
    staged.push(await stageConfigFile(config.policyPath, policyText));
    await loadModelRegistry({ catalogPath: staged[0], policyPath: staged[1], now: new Date() });
  } catch (error) {
    await cleanupFiles(staged);
    throw error;
  }

  const [catalogTmp, policyTmp] = staged;
  if (!config.exists) {
    await rename(policyTmp, config.policyPath);
    await rename(catalogTmp, config.catalogPath);
  } else if (primary === 'catalog') {
    await rename(catalogTmp, config.catalogPath);
    await unlink(policyTmp).catch(() => {});
  } else {
    await rename(policyTmp, config.policyPath);
    await unlink(catalogTmp).catch(() => {});
  }
}

function configDirFrom(options) {
  return resolve(options['config-dir'] ?? defaultConfigDir());
}

async function loadForCli(options) {
  const configDir = configDirFrom(options);
  return loadModelRegistry({ configDir, now: new Date() });
}

function table(rows) {
  if (!rows.length) return '';
  const widths = rows[0].map((_, column) => Math.max(...rows.map(row => String(row[column]).length)));
  return rows.map(row => row.map((cell, column) => String(cell).padEnd(widths[column])).join('  ').trimEnd())
    .join('\n');
}

async function listModels(options) {
  const registry = await loadForCli(options);
  const now = new Date();
  const rows = registry.catalog.models.map(entry => ({
    id: entry.id,
    family: entry.family,
    status: entry.status,
    effectiveStatus: effectiveStatus(entry, now),
    until: entry.until ?? '-',
    cost_tier: entry.cost_tier,
    provider: entry.provider,
    model: entry.model,
    capabilities: entry.capabilities.join(','),
  }));
  if (options.json) {
    console.log(JSON.stringify({ models: rows }, null, 2));
    return 0;
  }
  console.log(table([
    ['ID', 'FAMILY', 'STATUS', 'EFFECTIVE', 'UNTIL', 'COST', 'PROVIDER/MODEL', 'CAPABILITIES'],
    ...rows.map(row => [row.id, row.family, row.status, row.effectiveStatus, row.until,
      row.cost_tier, `${row.provider}/${row.model}`, row.capabilities]),
  ]));
  return 0;
}

async function effectiveRouting(options) {
  const registry = await loadForCli(options);
  const mode = options.mode ?? registry.policy.mode;
  const snapshot = registrySnapshot(registry, { mode, now: new Date() });
  if (options.json) {
    console.log(JSON.stringify(snapshot, null, 2));
    return 0;
  }
  const names = { lead: 'Lead', coder_default: 'Coder default', coder_heavy: 'Coder heavy',
    reviewer: 'Reviewer', arbiter: 'Arbiter', ux_critic: 'UX Critic' };
  console.log(`Mode: ${snapshot.mode}`);
  for (const role of REGISTRY_ROLES) {
    const chain = snapshot.roles[role];
    if (!chain.length) {
      console.log(`${names[role]}: <none>`);
      continue;
    }
    console.log(`${names[role]}: ${chain[0].id} (${chain[0].family}, ${chain[0].status})`);
    if (chain.length > 1) console.log(`  fallback: ${chain.slice(1).map(entry => entry.id).join(' -> ')}`);
  }
  const triad = resolveTriad(registry, { mode, now: new Date() });
  console.log(`Triad families: coder=${triad.coder?.family ?? 'none'} reviewer=${triad.reviewer?.family ?? 'none'} arbiter=${triad.arbiter?.family ?? 'none'}`);
  return 0;
}

async function writeCatalog(configDir, mutate) {
  await writeConfigMutation(configDir, config => mutate(config.catalog), 'catalog');
}

async function writePolicy(configDir, mutate) {
  await writeConfigMutation(configDir, config => mutate(config.policy), 'policy');
}

async function setStatus(positional, options) {
  const [id, status] = positional;
  if (!id || !MODEL_STATUSES.includes(status)) throw new Error('set requires <id> and a valid status');
  if (options.until !== undefined && untilMs(options.until) === null) throw new Error('invalid --until date');
  const configDir = configDirFrom(options);
  let updated = null;
  await writeCatalog(configDir, catalog => {
    const entry = catalog.models.find(item => item.id === id);
    if (!entry) throw new Error(`unknown model id: ${id}`);
    entry.status = status;
    if (options.until !== undefined) entry.until = options.until;
    updated = entry;
  });
  console.log(JSON.stringify({ ok: true, id, status, until: updated.until ?? null }));
  return 0;
}

async function setMode(positional, options) {
  const [mode] = positional;
  if (!ROUTING_MODES.includes(mode)) throw new Error('mode must be economy, balanced or sprint');
  const configDir = configDirFrom(options);
  await writePolicy(configDir, policy => {
    policy.mode = mode;
  });
  console.log(JSON.stringify({ ok: true, mode }));
  return 0;
}

async function addModel(options) {
  const required = ['id', 'provider', 'model', 'family'];
  for (const key of required) {
    if (!options[key]) throw new Error(`add requires --${key}`);
  }
  if (!MODEL_ID.test(options.id)) throw new Error(`invalid model id: ${options.id}`);
  if (!options.provider.trim() || !options.model.trim()) throw new Error('provider and model must be non-empty');
  if (!MODEL_FAMILIES.includes(options.family)) throw new Error(`unknown family: ${options.family}`);
  if (options['quota-source'] !== undefined && !options['quota-source'].trim()) {
    throw new Error('quota source must be non-empty');
  }
  const status = options.status ?? 'active';
  const costTier = options.cost ?? 'subscription';
  if (!MODEL_STATUSES.includes(status)) throw new Error(`unknown status: ${status}`);
  if (!COST_TIERS.includes(costTier)) throw new Error(`unknown cost tier: ${costTier}`);
  if (options.until !== undefined && untilMs(options.until) === null) throw new Error('invalid --until date');
  const capabilities = options.capabilities
    ? options.capabilities.split(',').map(item => item.trim()).filter(Boolean)
    : ['code'];
  if (!capabilities.length || new Set(capabilities).size !== capabilities.length) {
    throw new Error('invalid --capabilities list');
  }
  const configDir = configDirFrom(options);
  await writeCatalog(configDir, catalog => {
    if (catalog.models.some(item => item.id === options.id)) throw new Error(`duplicate model id: ${options.id}`);
    catalog.models.push({
      id: options.id,
      provider: options.provider,
      model: options.model,
      family: options.family,
      status,
      cost_tier: costTier,
      ...(options.until !== undefined ? { until: options.until } : {}),
      capabilities,
      quota_source: options['quota-source'] ?? 'manual',
      notes: options.notes ?? 'Добавлено оператором через df-models.',
    });
  });
  console.log(JSON.stringify({ ok: true, id: options.id }));
  return 0;
}

async function checkConfig(options) {
  try {
    const registry = await loadForCli(options);
    const triad = resolveTriad(registry, { now: new Date() });
    const problems = [];
    if (!triad.coder) problems.push('no eligible coder_default model');
    if (!triad.reviewer) problems.push('no eligible reviewer model from a different family');
    if (triad.coder && triad.reviewer && triad.coder.family === triad.reviewer.family) {
      problems.push('coder/reviewer family invariant violated');
    }
    if (problems.length) {
      console.error(JSON.stringify({ ok: false, problems }));
      return 1;
    }
    console.log(JSON.stringify({ ok: true, coder: triad.coder.id, reviewer: triad.reviewer.id,
      coderFamily: triad.coder.family, reviewerFamily: triad.reviewer.family }));
    return 0;
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error.message }));
    return 1;
  }
}

export async function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  const { positional, options } = parseCliArgs(rest, command);
  switch (command) {
    case 'list': return await listModels(options);
    case 'effective': return await effectiveRouting(options);
    case 'set': return await setStatus(positional, options);
    case 'mode': return await setMode(positional, options);
    case 'add': return await addModel(options);
    case 'check': return await checkConfig(options);
    case undefined:
    case 'help':
    case '--help':
      console.log(USAGE);
      return command === undefined ? 1 : 0;
    default:
      throw new Error(`unknown command: ${command}`);
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const code = await main(process.argv.slice(2));
    process.exitCode = code;
  } catch (error) {
    console.error(`df-models: ${error.message}`);
    process.exitCode = 1;
  }
}
