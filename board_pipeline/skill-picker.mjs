import { isRoleRegistry } from './role-registry.mjs';
import { canonicalDigest } from './subject.mjs';

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
