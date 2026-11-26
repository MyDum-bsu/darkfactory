import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  buildProjectContext,
  loadProjectProfile,
  pickDomainSkills,
} from './taste-profile.mjs';

const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(MODULE_DIR);

const PROFILE_YAML = `
repo_id: darkfactory-board
stack:
  - node
  - sqlite
l1_profile: strict
agents_md: AGENTS.md
taste:
  - предпочитай детерминизм во всём
  - fail-closed на границах доверия
domain_skills:
  backend:
    - sqlite-mastery
    - node-sqlite
  ui:
    - ui-ux-craft
  security:
    - threat-modeling
`;

const AGENTS_MD = `# Repo Rules
Одна очередь — Board. Scope Fence — жёсткая граница.
Вся кодовая работа — только через принятый контроллер фабрики.
`;

const GLOBAL_TASTE = `# Owner Taste
Владелец предпочитает компактные детерминированные решения.
Никаких скрытых сетевых вызовов из воркеров.
`;

async function fixture({ withProfile = true, withAgents = true, withTaste = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'taste-profile-'));
  const repoRoot = join(dir, 'repo');
  await mkdir(join(repoRoot, '.darkfactory'), { recursive: true });
  if (withProfile) {
    await writeFile(join(repoRoot, '.darkfactory', 'project-profile.yaml'), PROFILE_YAML);
  }
  if (withAgents) {
    await writeFile(join(repoRoot, 'AGENTS.md'), AGENTS_MD);
  }
  let globalTastePath = null;
  if (withTaste) {
    globalTastePath = join(dir, 'owner-taste.md');
    await writeFile(globalTastePath, GLOBAL_TASTE);
  }
  return { dir, repoRoot, globalTastePath };
}

test('loadProjectProfile: parses and normalizes valid yaml profile', async () => {
  const { dir, repoRoot } = await fixture();
  try {
    const profile = loadProjectProfile(repoRoot);
    assert.equal(profile.repoId, 'darkfactory-board');
    assert.deepEqual(profile.stack, ['node', 'sqlite']);
    assert.equal(profile.l1Profile, 'strict');
    assert.equal(profile.agentsMd, 'AGENTS.md');
    assert.deepEqual(profile.taste, ['предпочитай детерминизм во всём', 'fail-closed на границах доверия']);
    assert.deepEqual(profile.domainSkills.backend, ['sqlite-mastery', 'node-sqlite']);
    assert.ok(profile.path.endsWith(join('.darkfactory', 'project-profile.yaml')));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('loadProjectProfile: taste and stack accept single-string form', async () => {
  const { dir, repoRoot } = await fixture({ withProfile: false });
  try {
    await writeFile(join(repoRoot, '.darkfactory', 'project-profile.yaml'),
      'repo_id: solo\nstack: node\ntaste: один вкус\ndomain_skills:\n  docs: single-skill\n');
    const profile = loadProjectProfile(repoRoot);
    assert.deepEqual(profile.stack, ['node']);
    assert.deepEqual(profile.taste, ['один вкус']);
    assert.deepEqual(profile.domainSkills.docs, ['single-skill']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('loadProjectProfile: absent file returns null, invalid yaml fails closed', async () => {
  const { dir, repoRoot } = await fixture({ withProfile: false });
  try {
    assert.equal(loadProjectProfile(repoRoot), null);
    await writeFile(join(repoRoot, '.darkfactory', 'project-profile.yaml'), 'repo_id: [broken');
    assert.throws(() => loadProjectProfile(repoRoot), /taste_profile_yaml_invalid/);
    await writeFile(join(repoRoot, '.darkfactory', 'project-profile.yaml'), 'unknown_key: 1\n');
    assert.throws(() => loadProjectProfile(repoRoot), /taste_profile_invalid.*unknown key/);
    await writeFile(join(repoRoot, '.darkfactory', 'project-profile.yaml'), 'domain_skills:\n  frontend: [x]\n');
    assert.throws(() => loadProjectProfile(repoRoot), /unknown domain frontend/);
    await writeFile(join(repoRoot, '.darkfactory', 'project-profile.yaml'), 'agents_md: ../escape.md\n');
    assert.throws(() => loadProjectProfile(repoRoot), /taste_profile_path_traversal/);
    await writeFile(join(repoRoot, '.darkfactory', 'project-profile.yaml'), '- list\n- not mapping\n');
    assert.throws(() => loadProjectProfile(repoRoot), /taste_profile_invalid/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('loadProjectProfile: fail-closed on path traversal and escaping symlinks', async () => {
  const { dir, repoRoot } = await fixture({ withProfile: false });
  try {
    assert.throws(() => loadProjectProfile(repoRoot, { profileRelPath: '../outside.yaml' }),
      /taste_profile_path_traversal/);
    assert.throws(() => loadProjectProfile(repoRoot, { profileRelPath: '/etc/passwd' }),
      /taste_profile_path_traversal/);
    assert.throws(() => loadProjectProfile(repoRoot, { profileRelPath: 'a/../../b.yaml' }),
      /taste_profile_path_traversal/);

    // Symlink внутри repoRoot, указывающий наружу, — fail-closed.
    const outside = join(dir, 'evil.yaml');
    await writeFile(outside, 'repo_id: evil\n');
    await symlink(outside, join(repoRoot, '.darkfactory', 'project-profile.yaml'));
    assert.throws(() => loadProjectProfile(repoRoot), /taste_profile_path_traversal/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('pickDomainSkills: domain first then defaults, deterministic dedup', async () => {
  const { dir, repoRoot } = await fixture();
  try {
    const profile = loadProjectProfile(repoRoot);
    const backend = pickDomainSkills({ profile, domain: 'backend', defaultSkills: ['goal-rules', 'sqlite-mastery'] });
    assert.deepEqual(backend, ['sqlite-mastery', 'node-sqlite', 'goal-rules']);
    // Повторный вызов детерминирован.
    assert.deepEqual(pickDomainSkills({ profile, domain: 'backend', defaultSkills: ['goal-rules', 'sqlite-mastery'] }), backend);
    // Регистр и пробелы нормализуются.
    assert.deepEqual(pickDomainSkills({ profile, domain: ' Backend ' }), ['sqlite-mastery', 'node-sqlite']);
    // Неизвестный домен и отсутствующий профиль — только дефолтные скиллы.
    assert.deepEqual(pickDomainSkills({ profile, domain: 'ml', defaultSkills: ['a', 'a', 'b'] }), ['a', 'b']);
    assert.deepEqual(pickDomainSkills({ profile: null, domain: 'backend', defaultSkills: ['x'] }), ['x']);
    assert.deepEqual(pickDomainSkills({ profile, domain: null }), []);
    assert.throws(() => pickDomainSkills({ profile, domain: 'backend', defaultSkills: [42] }),
      /taste_profile_skills_invalid/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('buildProjectContext: 2-level merge with digest, layers and domain skills', async () => {
  const { dir, repoRoot, globalTastePath } = await fixture();
  try {
    const ctx = buildProjectContext({
      globalTastePath,
      repoRoot,
      domain: 'backend',
      defaultSkills: ['goal-rules'],
    });
    assert.ok(ctx.text.includes('## Owner Taste (global)'));
    assert.ok(ctx.text.includes('Владелец предпочитает компактные'));
    assert.ok(ctx.text.includes('## Repo Taste (project profile)'));
    assert.ok(ctx.text.includes('stack: node, sqlite'));
    assert.ok(ctx.text.includes('- предпочитай детерминизм во всём'));
    assert.ok(ctx.text.includes('## AGENTS.md (excerpt)'));
    assert.ok(ctx.text.includes('Scope Fence'));
    assert.ok(ctx.text.includes('## Domain Skills (backend)'));
    assert.ok(ctx.text.includes('- sqlite-mastery'));
    assert.deepEqual(ctx.skills, ['sqlite-mastery', 'node-sqlite', 'goal-rules']);
    assert.deepEqual(ctx.layers, { hasGlobalTaste: true, hasRepoProfile: true, hasAgentsMd: true });
    assert.equal(ctx.truncated, false);
    assert.equal(ctx.digest, sha256(ctx.text));
    assert.match(ctx.digest, /^[a-f0-9]{64}$/);
    assert.ok(ctx.text.length <= 4096);
    // Детерминизм: повторная сборка даёт тот же digest.
    const again = buildProjectContext({ globalTastePath, repoRoot, domain: 'backend', defaultSkills: ['goal-rules'] });
    assert.equal(again.digest, ctx.digest);
    assert.equal(again.text, ctx.text);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('buildProjectContext: maxChars truncation with consistent digest', async () => {
  const { dir, repoRoot, globalTastePath } = await fixture();
  try {
    const ctx = buildProjectContext({ globalTastePath, repoRoot, domain: 'backend', maxChars: 120 });
    assert.equal(ctx.truncated, true);
    assert.ok(ctx.text.length <= 120);
    assert.equal(ctx.digest, sha256(ctx.text));
    // Усечение детерминировано: тот же вход — тот же текст.
    const again = buildProjectContext({ globalTastePath, repoRoot, domain: 'backend', maxChars: 120 });
    assert.equal(again.text, ctx.text);
    assert.throws(() => buildProjectContext({ repoRoot, maxChars: 0 }), /taste_profile_maxchars_invalid/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('buildProjectContext: graceful behavior when optional files are absent', async () => {
  const { dir, repoRoot } = await fixture({ withProfile: false, withAgents: false, withTaste: false });
  try {
    const ctx = buildProjectContext({
      globalTastePath: join(dir, 'missing-taste.md'),
      repoRoot,
      domain: 'backend',
      defaultSkills: ['goal-rules'],
    });
    assert.deepEqual(ctx.layers, { hasGlobalTaste: false, hasRepoProfile: false, hasAgentsMd: false });
    // Остаются только дефолтные скиллы — без единой ошибки.
    assert.deepEqual(ctx.skills, ['goal-rules']);
    assert.ok(ctx.text.includes('- goal-rules'));
    assert.equal(ctx.digest, sha256(ctx.text));
    // Вообще без входов — пустой текст и sha256 пустой строки.
    const empty = buildProjectContext({ repoRoot });
    assert.equal(empty.text, '');
    assert.equal(empty.digest, sha256(''));
    assert.equal(empty.truncated, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('buildProjectContext: profile present but AGENTS.md missing or unconfigured', async () => {
  const { dir, repoRoot, globalTastePath } = await fixture({ withAgents: false });
  try {
    // agents_md настроен, но файл отсутствует — graceful fail-open.
    const missing = buildProjectContext({ globalTastePath, repoRoot, domain: 'ui' });
    assert.equal(missing.layers.hasAgentsMd, false);
    assert.equal(missing.layers.hasRepoProfile, true);
    assert.ok(!missing.text.includes('AGENTS.md'));
    assert.ok(missing.text.includes('- ui-ux-craft'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('buildProjectContext: long AGENTS.md excerpt is bounded', async () => {
  const { dir, repoRoot, globalTastePath } = await fixture({ withAgents: false });
  try {
    await writeFile(join(repoRoot, 'AGENTS.md'), `header\n${'x'.repeat(10000)}`);
    const ctx = buildProjectContext({ globalTastePath, repoRoot });
    assert.equal(ctx.layers.hasAgentsMd, true);
    // Excerpt ограничен 1500 символами плюс маркер усечения.
    const excerpt = ctx.text.split('## AGENTS.md (excerpt)\n')[1];
    assert.ok(excerpt.length <= 1501 + 2); // + переносы строк секции
    assert.ok(excerpt.includes('…'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('buildProjectContext: real darkfactory profile and owner-taste example are valid', () => {
  const profile = loadProjectProfile(REPO_ROOT);
  assert.equal(profile.repoId, 'darkfactory');
  assert.deepEqual(profile.stack, ['node22-esm']);
  assert.equal(profile.l1Profile, 'node');
  assert.equal(profile.agentsMd, 'AGENTS.md');
  assert.ok(profile.taste.length >= 3);
  assert.ok(Object.keys(profile.domainSkills).length >= 3);

  const globalTastePath = join(REPO_ROOT, 'docs', 'owner-taste.example.md');
  const ctx = buildProjectContext({
    globalTastePath,
    repoRoot: REPO_ROOT,
    domain: 'backend',
    defaultSkills: ['goal-rules'],
  });
  assert.equal(ctx.layers.hasGlobalTaste, true);
  assert.equal(ctx.layers.hasRepoProfile, true);
  assert.equal(ctx.layers.hasAgentsMd, true);
  assert.deepEqual(ctx.skills, ['goal-rules', 'test-first', 'property-testing']);
  assert.ok(ctx.text.includes('## Owner Taste (global)'));
  assert.ok(ctx.text.includes('Owner Taste — глобальный шаблон'));
  assert.ok(ctx.text.includes('## Repo Taste (project profile)'));
  assert.ok(ctx.text.includes('repo: darkfactory'));
  assert.ok(ctx.text.includes('stack: node22-esm'));
  assert.ok(ctx.text.includes('## Domain Skills (backend)'));
  assert.ok(ctx.text.includes('- property-testing'));
  assert.equal(ctx.digest, sha256(ctx.text));
  assert.match(ctx.digest, /^[a-f0-9]{64}$/);
  const again = buildProjectContext({
    globalTastePath,
    repoRoot: REPO_ROOT,
    domain: 'backend',
    defaultSkills: ['goal-rules'],
  });
  assert.equal(again.digest, ctx.digest);
  assert.equal(again.text, ctx.text);
});
