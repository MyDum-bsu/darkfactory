#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { access, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { homedir as osHomedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const ROLES = new Set(['laptop', 'brain', 'hub', 'worker']);
const DEFAULT_STATE = '.local/state/darkfactory/auto-update.json';
const NPM_PREFIX = '.npm-global';
const BUSY_PATTERNS = Object.freeze([
  /(^|[/\s])agy(?:\s|$)/,
  /(^|[/\s])devin(?:\s|$)/,
  /pi-acp/,
  /run-isolated\.mjs(?:\s|$)/,
  /factory-run\.mjs(?:\s|$)/,
  /factory-benchmark\.mjs(?:\s|$)/,
  /board_pipeline\/daemon\.mjs(?:\s|$)/,
]);

function defaultHome(deps) {
  return deps.homedir ?? osHomedir();
}

function expandHome(path, home) {
  if (typeof path !== 'string' || !path) return path;
  if (path === '~') return home;
  return path.startsWith('~/') ? join(home, path.slice(2)) : path;
}

async function defaultPathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function defaultRunner(command, args = [], options = {}) {
  try {
    const result = await execFileAsync(command, args, {
      timeout: options.timeoutMs ?? 120_000,
      maxBuffer: options.maxBuffer ?? 8 * 1024 * 1024,
      encoding: 'utf8',
      env: options.env,
    });
    return { code: 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  } catch (error) {
    const code = Number.isInteger(error.code) ? error.code : 1;
    return { code, stdout: error.stdout ?? '', stderr: error.stderr ?? error.message };
  }
}

async function defaultCommandExists(command, env = process.env) {
  if (!command) return false;
  if (command.includes('/')) return defaultPathExists(command);
  for (const dir of String(env.PATH ?? '').split(':')) {
    if (dir && await defaultPathExists(join(dir, command))) return true;
  }
  return false;
}

function outputVersion(output) {
  const line = String(output ?? '').split('\n').map(x => x.trim()).find(Boolean);
  return line ? line.slice(0, 200) : null;
}

function commandLine(command, args) {
  return [command, ...args].join(' ');
}

function failure(command, args, result) {
  const detail = (result.stderr || result.stdout || `exit ${result.code}`).trim().slice(0, 500);
  return new Error(`${commandLine(command, args)} failed: ${detail}`);
}

async function mustRun(ctx, command, args, options) {
  const result = await ctx.runner(command, args, options);
  if (result.code !== 0) throw failure(command, args, result);
  return result;
}

function compareVersions(latest, current) {
  if (typeof latest !== 'string' || typeof current !== 'string') return false;
  const parse = value => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value.trim());
    return match ? match.slice(1, 4).map(Number) : null;
  };
  const a = parse(latest);
  const b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i += 1) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return false;
}

export function findBusyProcesses(processText) {
  return String(processText ?? '').split('\n')
    .map(line => line.trim())
    .filter(line => line && BUSY_PATTERNS.some(pattern => pattern.test(line)));
}

function baseComponent(name) {
  return { name, status: 'skipped_missing', before: null, after: null, durationMs: 0, error: null };
}

function finished(result, status, before, after, extra = {}) {
  return { ...result, status, before: before ?? null, after: after ?? null, ...extra };
}

async function toolVersion(ctx, command) {
  if (!await ctx.commandExists(command)) return null;
  const result = await ctx.runner(command, ['--version'], { timeoutMs: 15_000 });
  return result.code === 0 ? outputVersion(result.stdout) ?? outputVersion(result.stderr) : null;
}

async function simpleToolComponent(ctx, name, command) {
  const result = baseComponent(name);
  if (!await ctx.commandExists(command)) return result;
  const before = await toolVersion(ctx, command);
  const planned = [commandLine(command, ['update'])];
  if (ctx.dryRun) return finished(result, 'dry_run', before, before, { planned });
  await mustRun(ctx, command, ['update'], { timeoutMs: 10 * 60_000 });
  const after = await toolVersion(ctx, command);
  return finished(result, before && after && before !== after ? 'updated' : 'already_current', before, after);
}

async function bbComponent(ctx) {
  const result = baseComponent('bb');
  if (!await ctx.commandExists('bb')) return result;
  const before = await toolVersion(ctx, 'bb');
  const commands = [
    ['bb', ['updates', 'apply']],
    ['bb', ['plugin', 'update', '--all', '--yes']],
  ];
  const planned = commands.map(([command, args]) => commandLine(command, args));
  if (ctx.dryRun) return finished(result, 'dry_run', before, before, { planned });
  const errors = [];
  for (const [command, args] of commands) {
    const run = await ctx.runner(command, args, { timeoutMs: 10 * 60_000 });
    if (run.code !== 0) errors.push(failure(command, args, run).message);
  }
  const after = await toolVersion(ctx, 'bb');
  if (errors.length) {
    return finished(result, 'failed', before, after, { error: errors.join('; ') });
  }
  return finished(result, before && after && before !== after ? 'updated' : 'already_current', before, after);
}

async function readPackageVersion(ctx, file) {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    return typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
}

async function npmPackageComponent(ctx, spec) {
  const result = baseComponent(spec.name);
  if (!spec.roles.includes(ctx.role)) return finished(result, 'skipped_role', null, null);
  const prefix = join(ctx.home, NPM_PREFIX);
  const packageNames = Array.isArray(spec.packageName) ? spec.packageName : [spec.packageName];
  let packageName = null;
  let packageFile = null;
  for (const candidate of packageNames) {
    const file = join(prefix, 'lib', 'node_modules', ...candidate.split('/'), 'package.json');
    if (await ctx.pathExists(file)) {
      packageName = candidate;
      packageFile = file;
      break;
    }
  }
  if (packageName === null) return result;
  const before = await readPackageVersion(ctx, packageFile);
  const installArgs = ['install', '-g', `${packageName}@latest`, '--prefix', prefix];
  const planned = [
    commandLine('npm', ['view', packageName, 'version']),
    commandLine('npm', installArgs),
    ...(spec.restartService ? [commandLine('systemctl', ['--user', 'restart', spec.restartService])] : []),
  ];
  if (ctx.dryRun) return finished(result, 'dry_run', before, before, { planned });

  const latestRun = await mustRun(ctx, 'npm', ['view', packageName, 'version'], { timeoutMs: 60_000 });
  const latest = outputVersion(latestRun.stdout);
  if (!compareVersions(latest, before)) {
    return finished(result, 'already_current', before, before, { latest });
  }
  await mustRun(ctx, 'npm', installArgs, { timeoutMs: 10 * 60_000 });
  const after = await readPackageVersion(ctx, packageFile);

  if (spec.smokeCommand) {
    const binary = join(prefix, 'bin', spec.smokeCommand);
    if (await ctx.pathExists(binary)) {
      await mustRun(ctx, binary, ['--version'], { timeoutMs: 20_000 });
    } else {
      await mustRun(ctx, 'npm', ['ls', '-g', packageName, '--prefix', prefix], { timeoutMs: 30_000 });
    }
  }
  if (spec.restartService && ctx.role === 'hub' && before !== after && !ctx.activeBusy) {
    await mustRun(ctx, 'systemctl', ['--user', 'restart', spec.restartService], { timeoutMs: 30_000 });
  }
  return finished(result, before !== after ? 'updated' : 'already_current', before, after, { latest });
}

async function gitRepoComponent(ctx) {
  const result = baseComponent('darkfactory');
  const repo = ctx.repo;
  if (!repo || !await ctx.pathExists(repo)) return result;
  const git = args => ctx.runner('git', ['-C', repo, ...args], { timeoutMs: 60_000 });
  const inside = await git(['rev-parse', '--is-inside-work-tree']);
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') return result;
  const beforeRun = await git(['rev-parse', 'HEAD']);
  const before = beforeRun.code === 0 ? beforeRun.stdout.trim() : null;
  const status = await git(['status', '--porcelain']);
  if (status.code !== 0) throw failure('git', ['-C', repo, 'status', '--porcelain'], status);
  if (status.stdout.trim()) return finished(result, 'skipped_dirty', before, before);
  const upstream = await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  if (upstream.code !== 0 || !upstream.stdout.trim()) return finished(result, 'skipped_no_upstream', before, before);
  const planned = [
    commandLine('git', ['-C', repo, 'fetch', '--prune']),
    commandLine('git', ['-C', repo, 'pull', '--ff-only']),
  ];
  if (ctx.dryRun) return finished(result, 'dry_run', before, before, { planned, upstream: upstream.stdout.trim() });
  await mustRun(ctx, 'git', ['-C', repo, 'fetch', '--prune'], { timeoutMs: 10 * 60_000 });
  await mustRun(ctx, 'git', ['-C', repo, 'pull', '--ff-only'], { timeoutMs: 10 * 60_000 });
  const afterRun = await git(['rev-parse', 'HEAD']);
  const after = afterRun.code === 0 ? afterRun.stdout.trim() : before;
  return finished(result, before !== after ? 'updated' : 'already_current', before, after, { upstream: upstream.stdout.trim() });
}

async function indexState(ctx, root) {
  try {
    const meta = await stat(join(root, '.gitmark', 'index.db'));
    return `${meta.size}:${Math.trunc(meta.mtimeMs)}`;
  } catch {
    return null;
  }
}

async function gitmarkComponent(ctx) {
  const result = baseComponent('gitmark');
  const script = join(ctx.repo, 'ops/memory-index/gitmark.py');
  if (!ctx.repo || !await ctx.pathExists(script) || !await ctx.commandExists('python3')) return result;
  const roots = [ctx.repo];
  if (ctx.hubDocs && await ctx.pathExists(ctx.hubDocs)) roots.push(ctx.hubDocs);
  const before = await indexState(ctx, ctx.repo);
  const planned = roots.map(root => commandLine('python3', [script, 'index', root]));
  if (ctx.dryRun) return finished(result, 'dry_run', before, before, { planned });
  const errors = [];
  for (const root of roots) {
    const run = await ctx.runner('python3', [script, 'index', root], { timeoutMs: 10 * 60_000 });
    if (run.code !== 0) errors.push(failure('python3', [script, 'index', root], run).message);
  }
  const after = await indexState(ctx, ctx.repo);
  if (errors.length) return finished(result, 'failed', before, after, { error: errors.join('; ') });
  return finished(result, before !== after ? 'updated' : 'already_current', before, after);
}

function componentSpecs(ctx) {
  return [
    ['agy', () => simpleToolComponent(ctx, 'agy', 'agy')],
    ['devin', () => simpleToolComponent(ctx, 'devin', 'devin')],
    ['bb', () => bbComponent(ctx)],
    ['bb-app', () => npmPackageComponent(ctx, {
      name: 'bb-app', packageName: 'bb-app', roles: ['laptop', 'hub'],
      smokeCommand: 'bb', restartService: 'bb-hub.service',
    })],
    ['pi', () => npmPackageComponent(ctx, {
      name: 'pi', packageName: ['@mariozechner/pi-coding-agent', '@earendil-works/pi-coding-agent'], roles: ['laptop', 'brain', 'hub', 'worker'],
    })],
    ['darkfactory', () => gitRepoComponent(ctx)],
    ['gitmark', () => gitmarkComponent(ctx)],
  ];
}

async function plannedBusyComponents(ctx) {
  const components = [];
  const add = (name, applicable) => {
    if (applicable) components.push({ ...baseComponent(name), status: 'deferred_busy' });
  };
  add('agy', await ctx.commandExists('agy'));
  add('devin', await ctx.commandExists('devin'));
  add('bb', await ctx.commandExists('bb'));
  const prefix = join(ctx.home, NPM_PREFIX);
  add('bb-app', ['laptop', 'hub'].includes(ctx.role) &&
    await ctx.pathExists(join(prefix, 'lib', 'node_modules', 'bb-app', 'package.json')));
  add('pi', await ctx.pathExists(join(prefix, 'lib', 'node_modules', '@mariozechner', 'pi-coding-agent', 'package.json')) ||
    await ctx.pathExists(join(prefix, 'lib', 'node_modules', '@earendil-works', 'pi-coding-agent', 'package.json')));
  add('darkfactory', ctx.repo && await ctx.pathExists(ctx.repo));
  add('gitmark', ctx.repo && await ctx.pathExists(join(ctx.repo, 'ops/memory-index/gitmark.py')));
  return components;
}

export function normalizeOptions(options = {}, deps = {}) {
  const home = defaultHome(deps);
  const role = options.role;
  if (!ROLES.has(role)) throw new Error(`role must be one of: ${[...ROLES].join(', ')}`);
  const stateFile = expandHome(options.stateFile ?? join(home, DEFAULT_STATE), home);
  const repo = expandHome(options.repo ?? join(home, 'projects', 'darkfactory'), home);
  const hubDocs = options.hubDocs ? expandHome(options.hubDocs, home) : null;
  for (const [name, path] of [['state-file', stateFile], ['repo', repo], ['hub-docs', hubDocs]]) {
    if (path !== null && !isAbsolute(path)) throw new Error(`${name} must be an absolute path`);
  }
  return {
    role,
    dryRun: options.dryRun === true,
    force: options.force === true,
    json: options.json === true,
    stateFile,
    repo,
    hubDocs,
  };
}

async function writeStateAtomic(file, report) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = join(dirname(file), `.auto-update.${process.pid}.${Date.now()}.tmp`);
  await writeFile(tmp, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, file);
}

export async function runAutoUpdate(options = {}, deps = {}) {
  const normalized = normalizeOptions(options, deps);
  const home = defaultHome(deps);
  const ctx = {
    ...normalized,
    home,
    runner: deps.runner ?? defaultRunner,
    pathExists: deps.pathExists ?? defaultPathExists,
    commandExists: deps.commandExists ?? (command => defaultCommandExists(command, deps.env ?? process.env)),
    nowMs: deps.nowMs ?? (() => Date.now()),
  };
  let processText = '';
  let processScanFailed = false;
  if (deps.processList !== undefined) {
    try {
      processText = typeof deps.processList === 'function' ? await deps.processList() : deps.processList;
    } catch {
      processScanFailed = true;
    }
  } else {
    try {
      const processes = await ctx.runner('ps', ['-eo', 'args='], { timeoutMs: 10_000 });
      processScanFailed = processes.code !== 0;
      processText = processes.stdout ?? '';
    } catch {
      processScanFailed = true;
    }
  }
  const busyProcesses = findBusyProcesses(processText);
  if (processScanFailed) busyProcesses.unshift('process_scan_unavailable');
  ctx.activeBusy = busyProcesses.length > 0;

  const startedAt = new Date(ctx.nowMs()).toISOString();
  let components;
  let status;
  if (ctx.activeBusy && !ctx.force) {
    components = await plannedBusyComponents(ctx);
    status = 'deferred_busy';
  } else {
    components = [];
    for (const [name, spec] of componentSpecs(ctx)) {
      const started = ctx.nowMs();
      let component;
      try {
        component = await spec();
      } catch (error) {
        component = { ...baseComponent(name), status: 'failed', error: error.message };
      }
      component.durationMs = Math.max(0, ctx.nowMs() - started);
      if (component.error === undefined) component.error = null;
      components.push(component);
    }
    const failed = components.some(component => component.status === 'failed');
    status = ctx.dryRun ? 'dry_run' : failed ? 'partial_failure' : 'ok';
  }
  const ok = !components.some(component => component.status === 'failed');
  const report = {
    timestamp: startedAt,
    role: ctx.role,
    busy: ctx.activeBusy,
    busyProcesses: busyProcesses.slice(0, 20),
    dryRun: ctx.dryRun,
    forced: ctx.force,
    status,
    components,
    ok,
  };
  await writeStateAtomic(ctx.stateFile, report);
  return report;
}

export function parseCli(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      role: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
      'state-file': { type: 'string' },
      repo: { type: 'string' },
      'hub-docs': { type: 'string' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    strict: true,
  });
  if (values.help) return { help: true };
  return {
    role: values.role,
    dryRun: values['dry-run'],
    force: values.force,
    stateFile: values['state-file'],
    repo: values.repo,
    hubDocs: values['hub-docs'],
    json: values.json,
  };
}

function printHuman(report) {
  console.log(`darkfactory auto-update: ${report.status} role=${report.role} busy=${report.busy}`);
  for (const component of report.components) {
    const versions = component.before || component.after ? ` ${component.before ?? '-'} -> ${component.after ?? '-'}` : '';
    const error = component.error ? ` error=${component.error}` : '';
    console.log(`${component.name}: ${component.status}${versions}${error}`);
  }
  console.log(`state: report written atomically`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const options = parseCli(process.argv.slice(2));
    if (options.help) {
      console.log('usage: df-auto-update.mjs --role laptop|brain|hub|worker [--dry-run] [--force] [--state-file PATH] [--repo PATH] [--hub-docs PATH] [--json]');
    } else {
      const report = await runAutoUpdate(options);
      if (options.json) console.log(JSON.stringify(report, null, 2));
      else printHuman(report);
      if (!report.ok) process.exitCode = 1;
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}
