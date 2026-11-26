import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { loadRoleRegistry } from './role-registry.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

test('role registry pins the V2-4 UI craft skill and ux-visual-critic station compatibly', async () => {
  const registry = await loadRoleRegistry(root);
  assert.equal(registry.version, 2);
  assert.equal(registry.playbooks.ui.stages.visual.role, 'ux-visual-critic');
  assert.equal(registry.roles['ux-visual-critic'].verifier, 'satisfaction-report');
  assert.equal(registry.roles['ux-visual-critic'].mode, 'read-only');
  assert.ok(registry.roles['ux-visual-critic'].tools.includes('satisfaction-check'));
  const uiSkills = registry.roles['ui-builder'].skills.map(skill => skill.id);
  assert.ok(uiSkills.includes('ui-ux-craft'));
  const craft = registry.roles['ui-builder'].skills.find(skill => skill.id === 'ui-ux-craft');
  assert.match(craft.text, /1440x900/);
  assert.match(craft.text, /1024x768/);
  assert.match(craft.text, /4\.5:1/);
  assert.match(craft.text, /loading/);
  assert.match(craft.text, /empty/);
  assert.match(craft.text, /error/);
  assert.match(craft.text, /ready/);
  const critic = registry.roles['ux-visual-critic'].instructions.text;
  assert.match(critic, /unstyledControls === 0/);
  assert.match(critic, /uncollapsedLongLists === 0/);
  assert.match(critic, /satisfactionScore >= 85/);
  assert.ok(Buffer.byteLength(craft.text) < 24 * 1024);
});

test('UI station documents contain no host paths', async () => {
  for (const path of [
    '.darkfactory/stations/ui-builder/skills/ui-ux-craft.md',
    '.darkfactory/stations/ux-visual-critic/instructions.md',
    '.darkfactory/stations/ux-visual-critic/skills/visual-rubric.md',
  ]) {
    const text = await readFile(new URL(`../${path}`, import.meta.url), 'utf8');
    assert.doesNotMatch(text, /\/home\/|\/Users\/|\/media\//, path);
  }
});
