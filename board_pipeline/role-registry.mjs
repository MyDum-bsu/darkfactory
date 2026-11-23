import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import { isStageVerifier } from './stage-verifier.mjs';
import { canonicalDigest } from './subject.mjs';

const ID = /^[a-z][a-z0-9-]{0,47}$/;
const TERMINALS = new Set(['ready', 'hold']);
const TOOLS = new Set(['snapshot-read', 'worktree-edit', 'unit-check', 'browser-observe',
  'counterexample-search', 'lean-check', 'literature-read', 'audio-measure', 'replay-check', 'blind-score', 'rubric-read']);
const MODELS = { writer: ['executor'], analyst: ['executor', 'arbiter'], verifier: ['critic', 'arbiter'] };
const EFFORTS = new Set(['inherit', 'low', 'medium', 'high', 'xhigh', 'max']);
const registries = new WeakSet();
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const id = value => typeof value === 'string' && ID.test(value);
const record = value => value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
const keys = (value, fields) => record(value) && Object.keys(value).length === fields.length &&
  fields.every(key => Object.hasOwn(value, key));
const list = (value, check) => Array.isArray(value) && value.length > 0 && value.length <= 16 &&
  new Set(value).size === value.length && value.every(check);

async function catalogFile(root, name, limit) {
  const path = join(root, name);
  const info = await lstat(path);
  if (!info.isFile() || info.size > limit || await realpath(path) !== path) throw new Error('factory_file_invalid');
  const bytes = await readFile(path);
  if (!bytes.length || bytes.length > limit) throw new Error('factory_file_invalid');
  return bytes;
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
  if (!keys(role, ['kind', 'model', 'reasoning', 'verifier', 'tools', 'skills']) ||
      !Object.hasOwn(MODELS, role.kind) || !MODELS[role.kind].includes(role.model) ||
      !EFFORTS.has(role.reasoning) || !isStageVerifier(role.verifier) || !list(role.tools, tool => TOOLS.has(tool)) ||
      !list(role.skills, id) || role.tools.includes('worktree-edit') !== (role.kind === 'writer')) {
    throw new Error('factory_role_invalid');
  }
  return { ...role, tools: Object.freeze([...role.tools]), skills: role.skills };
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
  return Object.freeze({ entry: graph.entry, stages: Object.freeze(stages) });
}

export function isRoleRegistry(value) { return registries.has(value); }

export async function loadRoleRegistry(trustedCheckout) {
  const root = join(await realpath(trustedCheckout), '.darkfactory');
  const source = await catalogFile(root, 'factory.yaml', 64 * 1024);
  const manifest = parseManifest(source);
  if (!keys(manifest, ['version', 'roles', 'playbooks']) || manifest.version !== 1) {
    throw new Error('factory_manifest_invalid');
  }
  const roles = named(manifest.roles, compileRole);
  const playbooks = Object.freeze(named(manifest.playbooks, graph => compilePlaybook(graph, roles)));
  const skills = new Map();
  for (const role of Object.values(roles)) {
    const pinned = [];
    for (const name of role.skills) {
      if (!skills.has(name)) {
        const bytes = await catalogFile(root, `stage-skills/${name}.md`, 8192);
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        if (!text.trim()) throw new Error('factory_skill_empty');
        skills.set(name, Object.freeze({ id: name, digest: sha256(bytes), text }));
      }
      pinned.push(skills.get(name));
    }
    role.skills = Object.freeze(pinned);
    Object.freeze(role);
  }
  const digest = canonicalDigest({ manifest: sha256(source), skills: [...skills.values()].map(({ id, digest }) => ({ id, digest })) });
  const registry = Object.freeze({ digest, roles: Object.freeze(roles), playbooks });
  registries.add(registry);
  return registry;
}
