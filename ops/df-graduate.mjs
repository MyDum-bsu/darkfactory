// Promote a prototype by updating only its repository profile. No git, Board,
// package manager or test execution: all detection uses local filenames.
import { randomUUID } from 'node:crypto';
import { closeSync, lstatSync, mkdirSync, openSync, readdirSync, realpathSync, renameSync,
  unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { normalizeFieldMode, normalizeTaskPlan } from '../board_pipeline/field-mode.mjs';
import { DEFAULT_PROFILE_RELPATH, loadProjectProfile, parseProjectProfileBytes } from '../board_pipeline/taste-profile.mjs';

const usage = 'df-graduate <repoDir> [--to brownfield|bluefield|greyfield] [--plan bugfix|api-change|refactor] [--repo-id ID] [--dry-run] [--json]';
const skipDirs = new Set(['.git', '.darkfactory', 'node_modules', '.venv', 'venv', '__pycache__',
  '.pytest_cache', 'dist', 'build', 'coverage']);

function statIfPresent(path) {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat?.isSymbolicLink()) throw new Error(`symlink not allowed: ${path}`);
  return stat;
}

function regularFile(path) {
  const stat = statIfPresent(path);
  if (stat && !stat.isFile()) throw new Error(`expected regular file: ${path}`);
  return Boolean(stat);
}

function inspectRepo(root) {
  const [pyproject, requirements, node, agents] = ['pyproject.toml', 'requirements.txt', 'package.json', 'AGENTS.md']
    .map(name => regularFile(join(root, name)));
  let python = pyproject || requirements;
  let testCount = 0;
  const dirs = [''];
  while (dirs.length) {
    const dir = dirs.pop();
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      const { name } = entry;
      const path = join(dir, name);
      const pythonMarker = dir === 'tests' && /^test_.*\.py$/.test(name);
      if ((path === 'tests' || pythonMarker) && entry.isSymbolicLink()) throw new Error(`symlink not allowed: ${path}`);
      if (entry.isDirectory() && !skipDirs.has(name)) dirs.push(path);
      if (!entry.isFile()) continue; // never follow links into unrelated trees
      if (pythonMarker) python = true;
      if (/^(test_.*|.*_test)\.py$/.test(name) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(name) ||
          (/(^|\/)(tests?|__tests__)\//.test(path) && /\.[cm]?[jt]sx?$/.test(name))) testCount++;
    }
  }
  return { stack: python ? 'python-node' : node ? 'node' : null, agents, testCount };
}

function publish(root, target, bytes) {
  const dir = dirname(target);
  if (!statIfPresent(dir)) mkdirSync(dir);
  const tmp = join(dir, `.project-profile-${randomUUID()}.tmp`);
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    try { writeFileSync(fd, bytes); } finally { closeSync(fd); }
    // Validate the actual staged bytes with the production loader *before*
    // replacing anything, so a rejected upgrade leaves the old file intact.
    if (!loadProjectProfile(root, { profileRelPath: relative(root, tmp) })) throw new Error('missing staged profile');
    renameSync(tmp, target);
  } catch (error) {
    unlinkSync(tmp);
    throw error;
  }
}

export function graduate(repoDir, { to = 'brownfield', plan = 'bugfix', repoId, dryRun = false } = {}) {
  const fieldMode = normalizeFieldMode(to);
  const defaultPlan = normalizeTaskPlan(plan);
  if (!fieldMode || fieldMode === 'greenfield') throw new Error('--to requires a protected field mode');
  if (!defaultPlan || defaultPlan === 'mvp') throw new Error('--plan requires bugfix, api-change or refactor');
  if (!repoDir) throw new Error(usage);
  const root = resolve(repoDir);
  if (realpathSync.native(repoDir) !== root || !statIfPresent(root)?.isDirectory()) {
    throw new Error('repoDir must be a real directory (no symlinks)');
  }
  const target = join(root, DEFAULT_PROFILE_RELPATH);
  const dirStat = statIfPresent(dirname(target));
  if (dirStat && !dirStat.isDirectory()) throw new Error('expected .darkfactory directory');
  const prior = regularFile(target) ? loadProjectProfile(root) : null;
  const { stack, agents, testCount } = inspectRepo(root);
  const profile = {
    repo_id: repoId ?? prior?.repoId ?? basename(root),
    stack: prior?.stack.length ? prior.stack : stack ?? undefined,
    l1_profile: prior?.l1Profile ?? stack ?? undefined,
    agents_md: prior?.agentsMd ?? (agents ? 'AGENTS.md' : undefined),
    field_mode: fieldMode, default_plan: defaultPlan,
    taste: prior?.taste, domain_skills: prior?.domainSkills,
  };
  // JSON-quoted values are valid YAML flow values, even for multiline taste
  // strings and punctuation. No second YAML implementation or dependency.
  const yaml = Object.entries(profile).filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n') + '\n';
  const bytes = Buffer.from(yaml);
  parseProjectProfileBytes(bytes); // same schema on dry runs, without creating even a temp file
  if (!dryRun) publish(root, target, bytes);
  return { dryRun, path: target, stack, testCount, profile };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values, positionals } = parseArgs({ allowPositionals: true, options: {
      to: { type: 'string' }, plan: { type: 'string' }, 'repo-id': { type: 'string' },
      'dry-run': { type: 'boolean' }, json: { type: 'boolean' },
    } });
    if (positionals.length !== 1) throw new Error(usage);
    const result = graduate(positionals[0], { to: values.to, plan: values.plan,
      repoId: values['repo-id'], dryRun: values['dry-run'] });
    console.log(values.json ? JSON.stringify(result) : `${result.dryRun ? 'Would write' : 'Wrote'} ${result.path}\n` +
      `Field: ${result.profile.field_mode}; plan: ${result.profile.default_plan}; stack: ${result.stack ?? 'not detected'}; test files: ${result.testCount}`);
  } catch (error) {
    console.error(`df-graduate: ${error.message}`);
    process.exitCode = 2;
  }
}
