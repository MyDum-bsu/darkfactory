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
  parseOwnerTaste,
  parseProjectProfileBytes,
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

test('project skill declarations, expanded domains and intake mode share one strict schema', () => {
  const parse = text => parseProjectProfileBytes(Buffer.from(text));
  const profile = parse('intake_mode: managed_dispatcher\nrepo_skills: [audio-check, skills/prove/SKILL.md]\n' +
    'domain_skills: {dsp: [test-first], math: [property-testing], ops: [prod-recon]}');
  assert.equal(profile.intakeMode, 'managed_dispatcher');
  assert.deepEqual(profile.repoSkills, ['audio-check', 'prove']);
  for (const domain of ['dsp', 'math', 'ops']) assert.equal(pickDomainSkills({ profile, domain }).length, 1);
  assert.deepEqual(parse('{}').repoSkills, []);
  for (const yaml of ['intake_mode: null', 'intake_mode: owner', 'repo_skills: null', 'repo_skills: {}',
    'repo_skills: [../outside]', 'repo_skills: [skills/a/extra.md]']) {
    assert.throws(() => parse(yaml), { code: 'taste_profile_invalid' });
  }
});

test('only named owner sections become hard rules; soft preferences go to the sidecar', async () => {
  const { applySeverityGating, reviewTasteBlock } = await import('./review-policy.mjs');
  const tiers = parseOwnerTaste('# Owner Taste\r\nintro\r\n## Tier 1: Hard Taste Rules\r\n- Never hide errors.\r\n' +
    '### Details\nExplain failure.\n## Notes\nnot a rule\n## Soft Taste Preferences\n- Prefer concise names.');
  assert.deepEqual(tiers, { hard: '- Never hide errors.\n### Details\nExplain failure.', soft: '- Prefer concise names.' });
  const block = reviewTasteBlock(tiers);
  assert.match(block, /Hard Taste Rules[^]*P1[^]*REWORK[^]*Never hide errors/);
  assert.match(block, /Soft Taste Preferences[^]*nit[^]*sidecar[^]*Prefer concise names/);
  assert.deepEqual(parseOwnerTaste('legacy preferences'), { hard: '', soft: 'legacy preferences' });
  assert.equal(reviewTasteBlock(parseOwnerTaste('')), '');
  const softOnly = '```md\n## Hard Taste Rules\n```\nPrefer plain names.';
  assert.deepEqual(parseOwnerTaste(`## Soft Taste Preferences (Tier 2)\n${softOnly}`), { hard: '', soft: softOnly });
  const hard = { expected: tiers.hard, severity: 'P1' }, soft = { expected: tiers.soft, severity: 'nit' };
  const mixed = await applySeverityGating({ status: 'PASS', findings: [soft, hard] });
  assert.equal(mixed.status, 'REWORK');
  assert.deepEqual(mixed.findings, [hard]);
  assert.deepEqual(mixed.sidecar_findings, [soft]);
  assert.equal((await applySeverityGating({ status: 'REWORK', findings: [soft] })).status, 'PASS');
});

test('loadProjectProfile: parses and normalizes valid yaml profile', async () => {
  const { dir, repoRoot } = await fixture();
  try {
    const profile = loadProjectProfile(repoRoot);
    assert.equal(profile.repoId, 'darkfactory-board');
    assert.equal(profile.fieldMode, null);
    assert.equal(profile.defaultPlan, null);
    const fromBytes = parseProjectProfileBytes(Buffer.from(PROFILE_YAML));
    assert.deepEqual(fromBytes, { ...profile, path: '.darkfactory/project-profile.yaml' });
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

test('repository and snapshot bytes share normalized routing fields and strict UTF-8 decoding', async () => {
  const { dir, repoRoot } = await fixture({ withProfile: false });
  try {
    const bytes = Buffer.from('field_mode: " GreenField "\ndefault_plan: " API-Change "\n');
    const path = join(repoRoot, '.darkfactory', 'project-profile.yaml');
    await writeFile(path, bytes);
    const profile = loadProjectProfile(repoRoot);
    assert.equal(profile.fieldMode, 'greenfield');
    assert.equal(profile.defaultPlan, 'api-change');
    const profileRelPath = 'snapshot.yaml';
    assert.deepEqual(parseProjectProfileBytes(bytes, { profileRelPath }), { ...profile, path: profileRelPath });

    const invalid = Buffer.concat([Buffer.from('repo_id: repo'), Buffer.from([0xff])]);
    await writeFile(path, invalid);
    assert.throws(() => loadProjectProfile(repoRoot), { code: 'taste_profile_yaml_invalid' });
    assert.throws(() => parseProjectProfileBytes(invalid), { code: 'taste_profile_yaml_invalid' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('snapshot YAML uses the same fail-closed document, schema and byte bounds', () => {
  const parse = yaml => parseProjectProfileBytes(Buffer.from(yaml));
  for (const key of ['field_mode', 'default_plan']) {
    for (const value of ['typo', 'null', '""', 'false', '1', '[mvp]', '{}']) {
      assert.throws(() => parse(`${key}: ${value}`), { code: 'taste_profile_invalid' });
    }
  }
  for (const yaml of ['field_mode: [', 'field_mode: brownfield\nfield_mode: greenfield']) {
    assert.throws(() => parse(yaml), { code: 'taste_profile_yaml_invalid' });
  }
  assert.throws(() => parse('unknown: greenfield'), { code: 'taste_profile_invalid' });
  assert.throws(() => parse('agents_md: ../escape'), { code: 'taste_profile_path_traversal' });
  for (const bytes of [Buffer.alloc(0), Buffer.alloc(256 * 1024 + 1)]) {
    assert.throws(() => parseProjectProfileBytes(bytes), { code: 'taste_profile_file_invalid' });
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

test('loadProjectProfile: yaml scalar strings are trimmed', async () => {
  const { dir, repoRoot } = await fixture({ withProfile: false });
  try {
    await writeFile(join(repoRoot, '.darkfactory', 'project-profile.yaml'),
      'repo_id: "  spaced-repo  "\nl1_profile: "  strict  "\nagents_md: "  AGENTS.md  "\n');
    await writeFile(join(repoRoot, 'AGENTS.md'), AGENTS_MD);
    const profile = loadProjectProfile(repoRoot);
    assert.equal(profile.repoId, 'spaced-repo');
    assert.equal(profile.l1Profile, 'strict');
    assert.equal(profile.agentsMd, 'AGENTS.md');
    // trim()'нутый agents_md резолвится в реальный файл.
    const ctx = buildProjectContext({ repoRoot });
    assert.equal(ctx.layers.hasAgentsMd, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('readBounded: truncated UTF-8 multi-byte sequences never decode to replacement chars', async () => {
  const { dir, repoRoot } = await fixture({ withProfile: false, withTaste: false });
  try {
    // Файл, где кириллическая «а» (0xD0 0xB0) стоит строго на границе
    // бюджета чтения 256KiB: первый байт попадает в буфер, второй — нет.
    const budget = 256 * 1024;
    const padding = 'x'.repeat(budget - 1);
    const globalTastePath = join(dir, 'big-taste.md');
    await writeFile(globalTastePath, `${padding}а хвост за границей`);
    const ctx = buildProjectContext({ globalTastePath, repoRoot, maxChars: 1024 * 1024 });
    assert.equal(ctx.truncated, false);
    assert.ok(!ctx.text.includes('�'), 'no U+FFFD replacement characters');
    assert.ok(!ctx.text.includes('\0'), 'no NUL bytes from short reads');
    // Текст обрывается на последнем полном символе — padding без «а».
    assert.ok(ctx.text.endsWith('x'.repeat(64)));
    assert.ok(!ctx.text.includes('хвост'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('buildProjectContext: per-section budget caps keep small sections and cut at line boundaries', async () => {
  const { dir, repoRoot } = await fixture();
  try {
    // Гигантский owner-taste из различимых пронумерованных строк.
    const lines = [];
    for (let i = 0; i < 500; i += 1) lines.push(`taste-line-${String(i).padStart(4, '0')}`);
    const globalTastePath = join(dir, 'owner-taste.md');
    await writeFile(globalTastePath, `${lines.join('\n')}\n`);

    const ctx = buildProjectContext({
      globalTastePath, repoRoot, domain: 'backend', defaultSkills: ['goal-rules'], maxChars: 600,
    });
    assert.equal(ctx.truncated, true);
    assert.ok(ctx.text.length <= 600);
    // Явный маркер усечения вместо среза посередине текста.
    assert.ok(ctx.text.endsWith('…[truncated]'));
    // Маленькие секции не вытеснены гигантской первой секцией.
    assert.ok(ctx.text.includes('## Repo Taste (project profile)'));
    assert.ok(ctx.text.includes('## Domain Skills (backend)'));
    assert.ok(ctx.text.includes('- sqlite-mastery'));
    // Гигантская секция обрезана по границе строки: каждая показанная
    // taste-line присутствует целиком, частичных строк нет.
    const partial = ctx.text.split('\n').some(line =>
      line.startsWith('taste-line-') && !/^taste-line-\d{4}$/.test(line));
    assert.equal(partial, false);
    assert.ok(ctx.text.includes('taste-line-0000'));
    // Детерминизм усечения.
    const again = buildProjectContext({
      globalTastePath, repoRoot, domain: 'backend', defaultSkills: ['goal-rules'], maxChars: 600,
    });
    assert.equal(again.text, ctx.text);
    assert.equal(again.digest, ctx.digest);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('buildProjectContext: degenerate tiny maxChars degrades to empty bounded output', async () => {
  const { dir, repoRoot, globalTastePath } = await fixture();
  try {
    // Бюджет меньше самого маркера усечения: вывод пуст, но никогда не
    // превышает maxChars и не срезает текст посередине.
    const ctx = buildProjectContext({ globalTastePath, repoRoot, maxChars: 5 });
    assert.equal(ctx.truncated, true);
    assert.equal(ctx.text, '');
    assert.ok(ctx.text.length <= 5);
    assert.equal(ctx.digest, sha256(''));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
