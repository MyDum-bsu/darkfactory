import { isRoleRegistry } from './role-registry.mjs';
import { canonicalDigest } from './subject.mjs';
import { parseAllowedPaths } from './scope-fence.mjs';

// Детерминированный on-demand подбор скиллов стадии: станция получает свои
// закреплённые скиллы и правила skillPicker по меткам тикета — без чтения ФС
// и без загрузки скиллов чужих станций. Промпт станции обязан оставаться
// строго меньше бюджета (по умолчанию 24 KiB); превышение — fail-closed.

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function computeSkillsDigest(skills) {
  return canonicalDigest((skills ?? []).map(({ id, digest }) => ({ id, digest })));
}

export const WORKER_SKILL_BYTES = 16 * 1024;
const domainPatterns = {
  ui: /\b(?:ui|frontend|components|css|html|tsx|jsx|vue|svelte)\b/,
  security: /\b(?:auth|security|crypto|permissions)\b/,
  docs: /\b(?:docs|readme|md|rst)\b/,
  research: /\b(?:research|papers|experiments)\b/,
  ml: /\b(?:ml|models|training|ipynb)\b/,
  dsp: /\b(?:dsp|audio|signal|fft|wav)\b/,
  math: /\b(?:math|lean|proofs|theorems)\b/,
  ops: /\b(?:ops|infra|deploy|dockerfile|workflows|terraform)\b/,
  backend: /\b(?:backend|api|server|board-pipeline)\b/,
};
const sharedDefaults = { backend: ['test-first'], ui: ['three-pass-review'], security: ['three-pass-review'],
  docs: ['session-handoff'], research: ['prod-recon'], ml: ['property-testing'], dsp: ['property-testing'],
  math: ['property-testing'], ops: ['prod-recon'] };

function detectedDomains(paths) {
  const domains = new Set();
  for (const path of paths ?? []) {
    const tokens = path.toLowerCase().replaceAll('_', '-');
    const matched = Object.keys(domainPatterns).filter(domain => domainPatterns[domain].test(tokens));
    if (!matched.length && /\.(?:m?[jt]s|py|go|rs|java)$/.test(tokens)) matched.push('backend');
    for (const domain of matched) domains.add(domain);
  }
  return [...domains].sort();
}

// Project declarations may only select shared registry entries and enrolled
// repo/owner IDs. They never specify host paths. First layer wins on ID clash.
export async function resolveWorkerSkills({ registry, allowedPaths, profile = null, ownerSkills = {}, readRepoSkill }) {
  const domains = detectedDomains(typeof allowedPaths === 'string' ? parseAllowedPaths(allowedPaths) : allowedPaths);
  const repoIds = profile?.repoSkills ?? [];
  const seen = new Set(), blocks = [];
  let bytes = 0;
  function add(layer, id, text) {
    if (seen.has(id)) return;
    if (typeof text !== 'string' || !text.trim()) throw new Error(`worker_skill_empty:${id}`);
    const block = `Read-only ${layer} skill (${id}):\n${text}`;
    bytes += Buffer.byteLength(block) + (blocks.length ? 2 : 0);
    if (bytes > WORKER_SKILL_BYTES) throw new Error('worker_skill_budget_exceeded');
    blocks.push(block);
    seen.add(id);
  }
  for (const domain of domains.length ? domains : [null]) {
    for (const skill of pickSkills({ registry, labels: { domain } }).skills) add('shared', skill.id, skill.text);
    const selected = profile?.domainSkills?.[domain] ?? sharedDefaults[domain] ?? [];
    for (const id of selected) {
      if (Object.hasOwn(registry.sharedSkills, id)) add('shared', id, registry.sharedSkills[id].text);
      else if (!repoIds.includes(id) && !Object.hasOwn(ownerSkills, id)) throw new Error(`skill_picker_unknown_skill:${id}`);
    }
  }
  for (const id of repoIds) if (!seen.has(id)) add('repo', id, await readRepoSkill(id));
  for (const id of Object.keys(ownerSkills).sort()) add('owner', id, ownerSkills[id]);
  return blocks.join('\n\n');
}

function ruleMatches(match, labels) {
  return Object.entries(match).every(([key, expected]) => labels[key] === expected);
}

export function pickSkills({ registry, labels = {}, stationId = null, maxPromptBytes = 24 * 1024 } = {}) {
  if (!isRoleRegistry(registry) || !record(labels) ||
      (stationId !== null && !Object.hasOwn(registry.stations, stationId)) ||
      !Number.isSafeInteger(maxPromptBytes) || maxPromptBytes < 1) {
    throw new Error('skill_picker_registry_invalid');
  }
  const station = stationId === null ? null : registry.stations[stationId];
  const ordered = [];
  const seen = new Set();
  const push = entry => {
    if (entry === undefined) throw new Error('skill_picker_unknown_skill');
    if (!seen.has(entry.id)) { seen.add(entry.id); ordered.push(entry); }
  };
  // Скиллы станции — первыми в объявленном порядке манифеста, затем defaults
  // и правила skillPicker в порядке декларации: детерминизм без сортировки по
  // хешу, который зависел бы от содержимого.
  if (station !== null) for (const entry of station.skills) push(entry);
  for (const id of registry.skillPicker.defaults) push(registry.sharedSkills[id]);
  for (const rule of registry.skillPicker.rules) {
    if (ruleMatches(rule.match, labels)) for (const id of rule.add) push(registry.sharedSkills[id]);
  }
  const skills = Object.freeze([...ordered]);
  const totalBytes = (station === null ? 0 : Buffer.byteLength(station.instructions.text)) +
    ordered.reduce((sum, entry) => sum + Buffer.byteLength(entry.text), 0);
  if (totalBytes >= maxPromptBytes) throw new Error('station_prompt_budget_exceeded');
  return Object.freeze({ skills, skillIds: Object.freeze(ordered.map(entry => entry.id)),
    skills_digest: computeSkillsDigest(ordered), totalBytes, stationId });
}
