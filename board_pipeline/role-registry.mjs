import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import { isStageVerifier } from './stage-verifier.mjs';
import { canonicalDigest } from './subject.mjs';

const ID = /^[a-z][a-z0-9-]{0,47}$/;
const TERMINALS = new Set(['ready', 'hold']);
const TOOLS = new Set(['snapshot-read', 'worktree-edit', 'unit-check', 'browser-observe',
  'counterexample-search', 'lean-check', 'literature-read', 'audio-measure', 'replay-check', 'blind-score', 'rubric-read',
  'test-first-check', 'guide-check', 'satisfaction-check']);
const MODELS = { writer: ['executor'], analyst: ['executor', 'arbiter'], verifier: ['critic', 'arbiter'] };
const EFFORTS = new Set(['inherit', 'low', 'medium', 'high', 'xhigh', 'max']);
const FILE_LIMIT = 24 * 1024;
const PICKER_LABELS = new Set(['domain', 'has_ui', 'requires_lean', 'requires_colab',
  'touches_migrations', 'pr_ci_red', 'test_first', 'playbook']);
const registries = new WeakSet();
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const id = value => typeof value === 'string' && ID.test(value);
const record = value => value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
const keys = (value, fields) => record(value) && Object.keys(value).length === fields.length &&
  fields.every(key => Object.hasOwn(value, key));
const list = (value, check) => Array.isArray(value) && value.length > 0 && value.length <= 16 &&
  new Set(value).size === value.length && value.every(check);

async function catalogFile(root, rel, limit = FILE_LIMIT) {
  const path = join(root, rel);
  const info = await lstat(path);
  if (!info.isFile() || info.size > limit || await realpath(path) !== path) throw new Error('factory_file_invalid');
  const bytes = await readFile(path);
  if (!bytes.length || bytes.length > limit) throw new Error('factory_file_invalid');
  return { path, bytes };
}

function parseManifest(bytes) {
  try {
    const yaml = parseDocument(new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      { schema: 'core', uniqueKeys: true, merge: false });
    if (yaml.errors.length || yaml.warnings.length) throw new Error('invalid YAML');
    return yaml.toJS({ maxAliasCount: 0 });
  } catch (cause) {
    throw new Error('factory_yaml_invalid', { cause });
  }
}

function named(value, compile) {
  if (!record(value) || !Object.keys(value).length || Object.keys(value).length > 32) {
    throw new Error('factory_named_map_invalid');
  }
  return Object.fromEntries(Object.entries(value).map(([name, entry]) => {
    if (!id(name)) throw new Error('factory_id_invalid');
    return [name, compile(entry)];
  }));
}

function compileRole(role) {
  if (!keys(role, ['kind', 'mode', 'model', 'reasoning', 'verifier', 'phaseBudgetMs', 'tools', 'skills']) ||
      typeof role.kind !== 'string' || !Object.hasOwn(MODELS, role.kind) || !MODELS[role.kind].includes(role.model) ||
      (role.mode !== 'read-only' && role.mode !== 'write') ||
      !EFFORTS.has(role.reasoning) || !isStageVerifier(role.verifier) ||
      !Number.isSafeInteger(role.phaseBudgetMs) || role.phaseBudgetMs < 1000 || role.phaseBudgetMs > 1800000 ||
      !list(role.tools, tool => TOOLS.has(tool)) || !list(role.skills, id) ||
      role.tools.includes('worktree-edit') !== (role.kind === 'writer') ||
      (role.mode === 'write') !== (role.kind === 'writer')) {
    throw new Error('factory_role_invalid');
  }
  return { ...role, tools: Object.freeze([...role.tools]), skills: [...role.skills] };
}

function compileSkillPicker(picker) {
  if (!keys(picker, ['defaults', 'rules']) || !list(picker.defaults, id) ||
      !Array.isArray(picker.rules) || picker.rules.length > 32) {
    throw new Error('factory_manifest_invalid');
  }
  const rules = picker.rules.map(rule => {
    if (!keys(rule, ['match', 'add']) || !record(rule.match) || !Object.keys(rule.match).length ||
        Object.keys(rule.match).length > 8 || !list(rule.add, id)) throw new Error('factory_manifest_invalid');
    const match = Object.fromEntries(Object.entries(rule.match).map(([key, value]) => {
      if (!PICKER_LABELS.has(key) || (typeof value !== 'boolean' && !id(value))) {
        throw new Error('factory_manifest_invalid');
      }
      return [key, value];
    }));
    return Object.freeze({ match: Object.freeze(match), add: Object.freeze([...rule.add]) });
  });
  return Object.freeze({ defaults: Object.freeze([...picker.defaults]), rules: Object.freeze(rules) });
}

function validateGraph(entry, stages) {
  const visiting = new Set();
  const visited = new Set();
  function visit(name) {
    if (TERMINALS.has(name)) return;
    if (!Object.hasOwn(stages, name)) throw new Error('factory_edge_invalid');
    if (visiting.has(name)) throw new Error('factory_cycle');
    if (visited.has(name)) return;
    visiting.add(name);
    visit(stages[name].next.pass);
    visit(stages[name].next.rework);
    visiting.delete(name);
    visited.add(name);
  }
  visit(entry);
  if (visited.size !== Object.keys(stages).length) throw new Error('factory_unreachable_stage');
  let green = entry;
  while (!TERMINALS.has(green)) green = stages[green].next.pass;
  if (green !== 'ready') throw new Error('factory_no_handoff');
}

function validateDiagnosticPaths(stages, roles) {
  const seen = new Set();
  function visit(name) {
    if (name === 'hold' || seen.has(name)) return;
    if (name === 'ready') throw new Error('factory_rework_handoff');
    seen.add(name);
    const stage = stages[name];
    if (roles[stage.role].kind === 'writer') throw new Error('factory_rework_writer');
    visit(stage.next.pass);
    visit(stage.next.rework);
  }
  for (const stage of Object.values(stages)) visit(stage.next.rework);
}

function compilePlaybook(graph, roles) {
  if (!keys(graph, ['entry', 'stages']) || !id(graph.entry) || TERMINALS.has(graph.entry) ||
      !Array.isArray(graph.stages) || graph.stages.length < 1 || graph.stages.length > 32) {
    throw new Error('factory_playbook_invalid');
  }
  const stages = Object.create(null);
  for (const stage of graph.stages) {
    if (!keys(stage, ['id', 'role', 'next']) || !id(stage.id) || TERMINALS.has(stage.id) ||
        Object.hasOwn(stages, stage.id) || !id(stage.role) || !Object.hasOwn(roles, stage.role) ||
        !keys(stage.next, ['pass', 'rework']) || !id(stage.next.pass) || !id(stage.next.rework) ||
        stage.next.rework === 'ready') throw new Error('factory_stage_invalid');
    stages[stage.id] = Object.freeze({ id: stage.id, role: stage.role, next: Object.freeze({ ...stage.next }) });
  }
  validateGraph(graph.entry, stages);
  validateDiagnosticPaths(stages, roles);
  return Object.freeze({ entry: graph.entry, stages: Object.freeze(stages) });
}

export function isRoleRegistry(value) { return registries.has(value); }

export async function loadRoleRegistry(trustedCheckout) {
  const root = join(await realpath(trustedCheckout), '.darkfactory');
  const source = (await catalogFile(root, 'factory.yaml', 64 * 1024)).bytes;
  const manifest = parseManifest(source);
  if (!keys(manifest, ['version', 'stations', 'playbooks', 'skillPicker']) || manifest.version !== 2) {
    throw new Error('factory_manifest_invalid');
  }
  const roles = named(manifest.stations, compileRole);
  const playbooks = Object.freeze(named(manifest.playbooks, graph => compilePlaybook(graph, roles)));
  const skillPicker = compileSkillPicker(manifest.skillPicker);

  // Все общие скиллы каталога пинятся в реестр: skill-picker работает
  // строго по замороженным байтам без чтения ФС в рантайме.
  const sharedDir = join(root, 'shared-skills');
  const sharedInfo = await lstat(sharedDir);
  if (!sharedInfo.isDirectory() || await realpath(sharedDir) !== sharedDir) {
    throw new Error('factory_file_invalid');
  }
  const sharedSkills = Object.create(null);
  const fileDigests = [];
  for (const entry of (await readdir(sharedDir)).sort()) {
    if (!entry.endsWith('.md')) continue;
    if (!ID.test(entry.slice(0, -3))) throw new Error('factory_file_invalid');
    const rel = `shared-skills/${entry}`;
    const { bytes } = await catalogFile(root, rel);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (!text.trim()) throw new Error('factory_skill_empty');
    const skillId = entry.slice(0, -3);
    sharedSkills[skillId] = Object.freeze({ id: skillId, scope: 'shared', path: rel, digest: sha256(bytes), text });
    fileDigests.push({ path: rel, digest: sharedSkills[skillId].digest });
  }
  Object.freeze(sharedSkills);

  // Пин каждой станции: instructions.md и разрешённые скиллы (station-local
  // → shared; отсутствие в обоих — fail-closed).
  for (const [name, role] of Object.entries(roles)) {
    const instructionsRel = `stations/${name}/instructions.md`;
    const instructions = await catalogFile(root, instructionsRel);
    const instructionsText = new TextDecoder('utf-8', { fatal: true }).decode(instructions.bytes);
    if (!instructionsText.trim()) throw new Error('factory_skill_empty');
    role.instructions = Object.freeze({ path: instructionsRel, digest: sha256(instructions.bytes), text: instructionsText });
    fileDigests.push({ path: instructionsRel, digest: role.instructions.digest });

    const pinned = [];
    for (const skillId of role.skills) {
      const stationRel = `stations/${name}/skills/${skillId}.md`;
      let entry;
      try {
        const { bytes } = await catalogFile(root, stationRel);
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        if (!text.trim()) throw new Error('factory_skill_empty');
        entry = Object.freeze({ id: skillId, scope: 'station', path: stationRel, digest: sha256(bytes), text });
      } catch (cause) {
        // Существующий, но битый station-файл (симлинк, переполнение, пустой)
        // — fail-closed; fallback на shared допустим только при отсутствии.
        if (cause?.code !== 'ENOENT') throw cause;
        if (!Object.hasOwn(sharedSkills, skillId)) throw new Error('factory_file_invalid');
        entry = sharedSkills[skillId];
      }
      pinned.push(entry);
      if (entry.scope === 'station') fileDigests.push({ path: stationRel, digest: entry.digest });
    }
    role.skills = Object.freeze(pinned);
    Object.freeze(role);
  }

  // Скиллы из skillPicker обязаны разрешаться в закреплённые sharedSkills.
  for (const ref of [...skillPicker.defaults, ...skillPicker.rules.flatMap(rule => rule.add)]) {
    if (!Object.hasOwn(sharedSkills, ref)) throw new Error('factory_file_invalid');
  }

  const digest = canonicalDigest({ manifest: sha256(source),
    files: fileDigests.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) });
  const stations = Object.freeze(roles);
  const registry = Object.freeze({ version: 2, digest, stations, roles: stations,
    playbooks, sharedSkills, skillPicker });
  registries.add(registry);
  return registry;
}
