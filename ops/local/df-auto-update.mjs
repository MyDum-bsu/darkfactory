#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir as osHomedir, tmpdir } from 'node:os';
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
  /(^|[/\s])pi(?:\s|$)/,
  /pi-acp/,
  /run-isolated\.mjs(?:\s|$)/,
  /factory-run\.mjs(?:\s|$)/,
  /factory-benchmark\.mjs(?:\s|$)/,
  /board_pipeline\/daemon\.mjs(?:\s|$)/,
  // hc — CLI herdr-core: активная оркестрация воркеров --runtime hc. Токен
  // сопоставляется целиком (границы start/слеш/пробел + пробел/конец), иначе
  // подстроки в 'which'/'dhcpcd' ложно блокировали бы обновление.
  /(^|[/\s])(?:hc|herdr-core|herdr-app|vb)(?:\s|$)/,
  /(?:^|\/)@vercel\/board\/dist\/cli(?:-embedded)?\.mjs(?:\s|$)/,
]);
const CONTROLLER_DAEMON_PATTERN = /(?:run-isolated|factory-run)\.mjs(?:\s|$)/;
const DAEMON_FLAG_PATTERN = /(?:^|\s)--daemon(?:\s|$)/;

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

export async function defaultRunner(command, args = [], options = {}) {
  try {
    const result = await execFileAsync(command, args, {
      timeout: options.timeoutMs ?? 120_000,
      maxBuffer: options.maxBuffer ?? 8 * 1024 * 1024,
      encoding: 'utf8',
      env: options.env,
      cwd: options.cwd,
    });
    return { code: 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  } catch (error) {
    const code = error.code === 'ENOENT' ? 127 : Number.isInteger(error.code) ? error.code : 1;
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

// Strict SemVer 2.0.0 x.y.z with optional prerelease/build: the suffix is
// not silently stripped, because a prerelease changes precedence
// (1.2.3-beta is lower than the 1.2.3 release) while build metadata does
// not. Numeric identifiers with leading zeros ('01') are rejected exactly
// as the spec demands — accepting them would make distinct strings
// numerically equal and break the comparator's total order. An invalid
// string is not a version: compareVersions answers false (no update —
// the conservative direction without mutations).
const CORE_PART = '(0|[1-9]\\d*)';
const PRERELEASE_PART = '(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)';
const SEMVER = new RegExp(
  `^${CORE_PART}\\.${CORE_PART}\\.${CORE_PART}` +
  `(?:-(${PRERELEASE_PART}(?:\\.${PRERELEASE_PART})*))?` +
  '(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$');
const NUMERIC_IDENTIFIER = /^\d+$/;

export function parseSemver(value) {
  if (typeof value !== 'string') return null;
  const match = SEMVER.exec(value.trim());
  if (!match) return null;
  return {
    core: match.slice(1, 4),
    prerelease: match[4] === undefined ? null : match[4].split('.'),
  };
}

// Numeric identifiers compare without Number precision loss: leading
// zeros do not change the value, then by length and lexicographically.
function compareNumericIdentifiers(a, b) {
  const na = a.replace(/^0+(?=\d)/, '');
  const nb = b.replace(/^0+(?=\d)/, '');
  if (na.length !== nb.length) return na.length < nb.length ? -1 : 1;
  if (na !== nb) return na < nb ? -1 : 1;
  return 0;
}

// Semver prerelease precedence: a numeric identifier is lower than an
// alphanumeric one; with an equal prefix fewer fields rank lower.
function comparePrerelease(a, b) {
  const common = Math.min(a.length, b.length);
  for (let i = 0; i < common; i += 1) {
    if (a[i] === b[i]) continue;
    const aNumeric = NUMERIC_IDENTIFIER.test(a[i]);
    const bNumeric = NUMERIC_IDENTIFIER.test(b[i]);
    if (aNumeric && bNumeric) return compareNumericIdentifiers(a[i], b[i]);
    if (aNumeric) return -1;
    if (bNumeric) return 1;
    return a[i] < b[i] ? -1 : 1;
  }
  if (a.length === b.length) return 0;
  return a.length < b.length ? -1 : 1;
}

// true only when latest is strictly newer than current: equality or any
// unparsable input is false and the update never starts.
export function compareVersions(latest, current) {
  const a = parseSemver(latest);
  const b = parseSemver(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i += 1) {
    const order = compareNumericIdentifiers(a.core[i], b.core[i]);
    if (order !== 0) return order > 0;
  }
  // With equal x.y.z a release outranks every prerelease of it: an
  // installed 1.2.3-beta must update to the released 1.2.3, not stick.
  if (a.prerelease === null) return b.prerelease !== null;
  if (b.prerelease === null) return false;
  return comparePrerelease(a.prerelease, b.prerelease) > 0;
}

export function findBusyProcesses(processText) {
  return String(processText ?? '').split('\n')
    .map(line => line.trim())
    .filter(line => line && BUSY_PATTERNS.some(pattern => pattern.test(line)));
}

export function isControllerDaemonLine(line) {
  const text = String(line ?? '');
  return CONTROLLER_DAEMON_PATTERN.test(text) && DAEMON_FLAG_PATTERN.test(text);
}

export function controllerDaemonStateDir(line) {
  if (!isControllerDaemonLine(line)) return null;
  const match = /(?:^|\s)--state(?:=([^\s]+)|\s+([^\s]+))/.exec(String(line));
  return match?.[1] ?? match?.[2] ?? null;
}

export function attemptRecordBusy(record) {
  if (record === null || record === undefined) return false;
  return record?.phase !== 'idle';
}

export async function controllerDaemonBusy(line, deps = {}) {
  const stateDir = controllerDaemonStateDir(line);
  if (!stateDir || !isAbsolute(stateDir)) return true;
  const readAttempt = deps.readAttemptFile ?? deps.readFile ?? readFile;
  let raw;
  try {
    raw = await readAttempt(join(stateDir, 'attempt.json'), 'utf8');
  } catch (error) {
    return error?.code !== 'ENOENT';
  }
  try {
    return attemptRecordBusy(JSON.parse(raw));
  } catch {
    return true;
  }
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

async function strictlyBusy(ctx) {
  if (ctx.activeBusy) return true; // --force never overrides the managed-runtime fence
  try { return (await ctx.checkManagedBusy()) !== false; } catch { return true; }
}

async function simpleToolComponent(ctx, name, command, guarded = false) {
  const result = baseComponent(name);
  if (!await ctx.commandExists(command)) return result;
  if (guarded && ctx.activeBusy) return finished(result, 'deferred_busy', null, null);
  const before = await toolVersion(ctx, command);
  if (guarded && !before) throw new Error(`${command} --version failed before update`);
  const planned = [commandLine(command, ['update'])];
  if (guarded && await strictlyBusy(ctx)) return finished(result, 'deferred_busy', before, before);
  if (ctx.dryRun) return finished(result, 'dry_run', before, before, { planned });
  await mustRun(ctx, command, ['update'], { timeoutMs: 10 * 60_000 });
  const after = await toolVersion(ctx, command);
  if (guarded && !after) return finished(result, 'failed', before, null, { error: `${command} --version failed after update` });
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

export async function managedNpmInstall(home, name, command, exists = defaultPathExists) {
  const prefixes = [[join(home, NPM_PREFIX), true]];
  if (name === '@vercel/board') prefixes.unshift([join(home, '.local/share/vercel-board'), false]);
  for (const [prefix, global] of prefixes) {
    const modules = join(prefix, global ? 'lib/node_modules' : 'node_modules');
    const file = join(modules, name, 'package.json');
    const bin = global ? join(prefix, 'bin', command) : join(modules, '.bin', command);
    if (await exists(file)) return { prefix, global, file, bin };
  }
  return null;
}

// Conformance posts messages and changes grants. Never inherit the operator's
// Board URL, credentials, working directory or home, even for local checks.
async function withScratchBoard(vb, check, spawnBoard) {
  const dir = await mkdtemp(join(tmpdir(), 'df-vb-smoke-'));
  const env = { PATH: process.env.PATH, HOME: dir };
  let child, closed, timer;
  try {
    child = spawnBoard(vb, ['serve', '--port', '0', '--dir', dir, '--no-open', '--no-inspect'],
      { env, cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] });
    closed = new Promise(resolve => child.once('close', resolve));
    const url = await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('scratch Board startup timed out')), 20_000);
      child.once('error', reject);
      child.once('exit', () => reject(new Error('scratch Board exited before startup')));
      let banner = '';
      child.stdout.on('data', chunk => {
        banner = (banner + chunk).slice(-8192);
        const match = /serving a local board at (http:\/\/127\.0\.0\.1:([1-9]\d{0,4})\/api\/board)/.exec(banner);
        if (match && Number(match[2]) <= 65535 && match[2] !== '44100') resolve(match[1]);
      });
    });
    await check(url, { env, cwd: dir });
  } finally {
    clearTimeout(timer);
    child?.kill('SIGKILL');
    await closed;
    await rm(dir, { recursive: true, force: true });
  }
}

async function managedPackageComponent(ctx, name, command) {
  const result = baseComponent(name);
  const layout = await managedNpmInstall(ctx.home, name, command, ctx.pathExists);
  if (!layout) return name === 'herdr-app' ? simpleToolComponent(ctx, name, command, true) : result;
  const { file, prefix, global, bin } = layout;
  const before = await readPackageVersion(ctx, file);
  if (await strictlyBusy(ctx)) return finished(result, 'deferred_busy', before, before);
  const view = await mustRun(ctx, 'npm', ['view', name, 'version'], { timeoutMs: 60_000 });
  const latest = view.stdout.trim(), from = parseSemver(before), to = parseSemver(latest);
  if (!from || !to) throw new Error(`invalid installed or registry ${name} version`);
  if (!compareVersions(latest, before)) return finished(result, 'already_current', before, before, { latest });
  // A 0.x minor can break the protocol just as a stable major can.
  if (from.core[0] !== to.core[0] || (from.core[0] === '0' && from.core[1] !== to.core[1]) || to.prerelease) {
    return finished(result, 'review_required', before, before, { latest });
  }
  const args = ['install', ...(global ? ['-g'] : ['--save-exact']), `${name}@${latest}`, '--prefix', prefix];
  if (ctx.dryRun) return finished(result, 'dry_run', before, before,
    { latest, planned: [commandLine('npm', args), `${bin} --version`, ...(command === 'vb' ? [`${bin} conformance --url <scratch>`] : [])] });
  if (await strictlyBusy(ctx)) return finished(result, 'deferred_busy', before, before, { latest });
  await mustRun(ctx, 'npm', args, { timeoutMs: 10 * 60_000 });
  const after = await readPackageVersion(ctx, file);
  try {
    if (after !== latest) throw new Error(`${name} install did not produce the pinned version`);
    const version = await mustRun(ctx, bin, ['--version'], { timeoutMs: 20_000 });
    if (!version.stdout.trim().split(/\s+/).includes(latest)) throw new Error(`${command} --version did not report ${latest}`);
    if (command === 'vb') await withScratchBoard(bin, (url, isolation) => mustRun(ctx, bin, ['conformance', '--url', url],
      { ...isolation, timeoutMs: 120_000 }), ctx.spawnBoard);
  } catch (error) {
    return finished(result, 'failed', before, after, { latest, error: error.message });
  }
  return finished(result, 'updated', before, after, { latest });
}

export async function probeHex(runner) {
  const args = ['models', 'list'];
  const run = await runner('hex', args, { timeoutMs: 15_000 });
  if (run.code !== 0) throw failure('hex', args, run);
  return { model: 'gigaam_v4', available: /(?:^|[^\w.-])gigaam_v4(?=$|[^\w.-])/.test(run.stdout) };
}

async function hexComponent(ctx) {
  const result = baseComponent('hex');
  if (ctx.role !== 'laptop') return finished(result, 'skipped_role', null, null);
  if (!await ctx.commandExists('hex')) return result;
  return finished(result, 'checked', null, null, await probeHex(ctx.runner));
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
  const viewArgs = ['view', packageName, 'version'];
  const latestRun = await mustRun(ctx, 'npm', viewArgs, { timeoutMs: 60_000 });
  const latest = latestRun.stdout.trim();
  if (!compareVersions(latest, before)) {
    if (ctx.dryRun) return finished(result, 'dry_run', before, before, { planned: [commandLine('npm', viewArgs)] });
    return finished(result, 'already_current', before, before, { latest });
  }
  const installArgs = ['install', '-g', `${packageName}@${latest}`, '--prefix', prefix];
  const restartServices = spec.restartServices ?? (spec.restartService ? [spec.restartService] : []);
  if (ctx.dryRun) {
    const planned = [commandLine('npm', viewArgs), commandLine('npm', installArgs)];
    if (restartServices.length) planned.push(commandLine('systemctl', ['--user', 'restart', ...restartServices]));
    return finished(result, 'dry_run', before, before, { planned });
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
  const extra = { latest };
  if (restartServices.length && ctx.role === 'hub' && before !== after) {
    let busyNow = ctx.activeBusy;
    if (typeof ctx.checkActiveBusy === 'function') {
      try {
        busyNow = Boolean(await ctx.checkActiveBusy() ?? ctx.activeBusy);
      } catch {
        busyNow = true;
      }
    }
    if (busyNow) {
      extra.restart = 'deferred_busy';
      extra.note = 'restart deferred: active work detected after install';
    } else {
      await mustRun(ctx, 'systemctl', ['--user', 'restart', ...restartServices], { timeoutMs: 30_000 });
    }
  }
  return finished(result, before !== after ? 'updated' : 'already_current', before, after, extra);
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
      smokeCommand: 'bb', restartServices: ['darkfactory-daemon*.service', 'control-room.service'],
    })],
    ['pi', () => npmPackageComponent(ctx, {
      name: 'pi', packageName: ['@mariozechner/pi-coding-agent', '@earendil-works/pi-coding-agent'], roles: ['laptop', 'brain', 'hub', 'worker'],
    })],
    ['@vercel/board', () => managedPackageComponent(ctx, '@vercel/board', 'vb')],
    ['herdr-core', () => simpleToolComponent(ctx, 'herdr-core', 'hc', true)],
    ['herdr-app', () => managedPackageComponent(ctx, 'herdr-app', 'herdr-app')],
    ['hex', () => hexComponent(ctx)],
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
  add('@vercel/board', await managedNpmInstall(ctx.home, '@vercel/board', 'vb', ctx.pathExists));
  add('herdr-core', await ctx.commandExists('hc'));
  add('herdr-app', await ctx.commandExists('herdr-app') || await managedNpmInstall(ctx.home, 'herdr-app', 'herdr-app', ctx.pathExists));
  add('hex', ctx.role === 'laptop' && await ctx.commandExists('hex'));
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

// Counter in the temporary file name: a repeated or concurrent run in the
// same process and millisecond never shares one tmp path — otherwise
// concurrent writeFile calls could interleave content before rename.
let tmpFileCounter = 0;

async function writeStateAtomic(file, report) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  tmpFileCounter = (tmpFileCounter + 1) % Number.MAX_SAFE_INTEGER;
  const tmp = join(dirname(file),
    `.auto-update.${process.pid}.${Date.now()}.${tmpFileCounter}.tmp`);
  await writeFile(tmp, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, file);
}

async function scanBusyProcesses(ctx, deps, strict = false) {
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
      const processes = await ctx.runner('ps', ['-eww', '-o', 'args='], { timeoutMs: 10_000 });
      processScanFailed = processes.code !== 0;
      processText = processes.stdout ?? '';
    } catch {
      processScanFailed = true;
    }
  }
  const busyProcesses = [];
  if (typeof processText !== 'string' || (deps.processList === undefined && !processText.trim())) processScanFailed = true;
  for (const line of findBusyProcesses(processText)) {
    if (!strict && isControllerDaemonLine(line)) {
      if (await controllerDaemonBusy(line, deps)) busyProcesses.push(line);
    } else {
      busyProcesses.push(line);
    }
  }
  if (processScanFailed) busyProcesses.unshift('process_scan_unavailable');
  return busyProcesses;
}

export async function runAutoUpdate(options = {}, deps = {}) {
  const normalized = normalizeOptions(options, deps);
  const home = defaultHome(deps);
  const ctx = {
    ...normalized,
    home,
    runner: deps.runner ?? defaultRunner,
    spawnBoard: deps.spawnBoard ?? spawn,
    pathExists: deps.pathExists ?? defaultPathExists,
    commandExists: deps.commandExists ?? (command => defaultCommandExists(command, deps.env ?? process.env)),
    nowMs: deps.nowMs ?? (() => Date.now()),
  };
  ctx.checkManagedBusy = deps.checkActiveBusy ?? (async () => (await scanBusyProcesses(ctx, deps, true)).length > 0);
  ctx.checkActiveBusy = deps.checkActiveBusy ?? (async () => (await scanBusyProcesses(ctx, deps)).length > 0);
  const busyProcesses = await scanBusyProcesses(ctx, deps);
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
    const detail = component.model ? ` ${component.model}=${component.available ? 'available' : 'absent'}` :
      component.status === 'review_required' ? ` candidate=${component.latest}` : '';
    const error = component.error ? ` error=${component.error}` : '';
    console.log(`${component.name}: ${component.status}${versions}${detail}${error}`);
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
