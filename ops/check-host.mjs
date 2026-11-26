import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const source = fileURLToPath(new URL('./local/', import.meta.url));
const runtime = join(homedir(), '.local', 'share', 'vercel-board');
const verify = (predicate, message) => { if (!predicate) throw new Error(message); };

export const APPROVED_IMPLEMENTATION_MODELS = new Set([
  'swe-2-high',
  'swe-2-1-medium',
  'swe-2-1-high',
  'swe-2-1-xhigh',
  'swe-2-1-max',
]);

export const validateImplementationPreset = preset =>
  preset?.provider === 'acp-devin' && APPROVED_IMPLEMENTATION_MODELS.has(preset?.model);

export const WORKER_RUNTIMES = Object.freeze(['bb', 'hc', 'subproc']);
export const PORTABLE_COMMANDS = Object.freeze(['hc', 'devin', 'agy', 'pi']);

const parseRuntimeArgv = argv => {
  let selected;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--runtime') {
      if (i + 1 >= argv.length) throw new Error('worker_runtime_kind_invalid');
      selected = argv[++i];
    } else if (arg.startsWith('--runtime=')) {
      selected = arg.slice('--runtime='.length);
    } else {
      throw new Error(`unknown flag ${arg}`);
    }
  }
  return selected;
};

export function resolveRuntime({ argv = [], env = process.env, runtimeRoot = runtime, exists = existsSync } = {}) {
  const selected = parseRuntimeArgv(argv) ?? env.DF_WORKER_RUNTIME ?? 'hc';
  if (!WORKER_RUNTIMES.includes(selected)) throw new Error('worker_runtime_kind_invalid');
  return selected;
}

export const nodeVersionSupported = version => {
  const [major, minor] = String(version).split('.').map(Number);
  return major > 22 || (major === 22 && minor >= 18);
};

export const verifyNodeVersion = (version = process.versions.node) =>
  verify(nodeVersionSupported(version), 'Node 22.18+ is required');

const boardInvocation = env => {
  const childEnv = { ...env };
  const boardUrl = env.BOARD_TOKEN ? env.BOARD_URL || 'http://127.0.0.1:44100/api/board'
    : 'http://127.0.0.1:44100/api/board';
  if (!env.BOARD_TOKEN) {
    delete childEnv.BOARD_TOKEN;
    delete childEnv.BOARD_URL;
  }
  return { boardUrl, childEnv };
};

export function checkBoardChannels({ env = process.env, exec = execFileSync } = {}) {
  const vb = typeof env.DF_VB_BIN === 'string' && env.DF_VB_BIN ? env.DF_VB_BIN : 'vb';
  const { boardUrl, childEnv } = boardInvocation(env);
  const board = exec(vb, [
    '--url', boardUrl, 'channels', 'list', '--json',
  ], { env: childEnv, encoding: 'utf8', timeout: 9000, stdio: ['ignore', 'pipe', 'pipe'] });
  verify(Array.isArray(JSON.parse(String(board)).channels), 'Expected channels from the existing local Board');
  return { vb, boardUrl };
}

export function checkPortableCommands({ runtimeKind, exec = execFileSync } = {}) {
  for (const command of PORTABLE_COMMANDS) {
    try {
      exec(command, ['--version'], { timeout: 6000, stdio: 'ignore' });
    } catch (error) {
      throw new Error(`${command} CLI is required for ${runtimeKind} runtime`, { cause: error });
    }
  }
  return [...PORTABLE_COMMANDS];
}

export function checkPortableHost({ runtimeKind, env = process.env, exec = execFileSync,
  nodeVersion = process.versions.node } = {}) {
  if (!WORKER_RUNTIMES.includes(runtimeKind) || runtimeKind === 'bb') throw new Error('worker_runtime_kind_invalid');
  verifyNodeVersion(nodeVersion);
  const board = checkBoardChannels({ env, exec });
  const commands = checkPortableCommands({ runtimeKind, exec });
  return { runtime: runtimeKind, board, commands };
}

export function checkLegacyHost({ env = process.env, exec = execFileSync,
  nodeVersion = process.versions.node, sourceRoot = source, runtimeRoot = runtime,
  readFile = readFileSync } = {}) {
  verifyNodeVersion(nodeVersion);
  const readJson = path => JSON.parse(readFile(path, 'utf8'));
  const sha = path => createHash('sha256').update(readFile(path)).digest('hex');
  const expected = readJson(join(sourceRoot, 'package-lock.json')).packages['node_modules/@vercel/board'].version;
  const installed = readJson(join(runtimeRoot, 'node_modules/@vercel/board/package.json')).version;
  verify(installed === expected, `Expected Board SDK ${expected}, found ${installed}`);

  for (const path of ['board-review.mjs', 'check-workspace-space.mjs', 'guarded-worktree-spawn.sh',
    'pick-personal-worker.mjs', 'open-board.sh', 'electron-app/main.cjs', 'electron-app/assets/vercel-board.svg']) {
    verify(sha(join(sourceRoot, path)) === sha(join(runtimeRoot, path)), `Runtime differs: ${path}`);
  }

  const routes = readJson(join(runtimeRoot, 'routes.json'));
  const profiles = routes.workerPresets;
  verify(routes.execution === 'manual-bb' && routes.automaticGitHubActions === false, 'Unexpected active execution policy');
  verify(validateImplementationPreset(profiles.implementation), 'Unexpected SWE-2 preset');
  verify(profiles.zcodeStart.provider === 'acp-zcode-start' && profiles.zcodeStart.model.endsWith('GLM-5.3-Flash') &&
    profiles.zcodeStart.reasoningLevel === 'max', 'Unexpected ZCode Start preset');
  verify(profiles.reviewer.provider === 'pi' && profiles.reviewer.model === 'openai/gpt-6.2-sol' &&
    profiles.reviewer.reasoningLevel === 'medium', 'Unexpected review preset');

  const childEnv = { ...env, XDG_CONFIG_HOME: join(runtimeRoot, 'config') };
  const { boardUrl } = boardInvocation(env);
  if (!env.BOARD_TOKEN) {
    delete childEnv.BOARD_TOKEN;
    delete childEnv.BOARD_URL;
  }
  const board = exec(join(runtimeRoot, 'node_modules/.bin/vb'), [
    '--url', boardUrl, 'channels', 'list', '--json',
  ], { env: childEnv, encoding: 'utf8', timeout: 9000, stdio: ['ignore', 'pipe', 'pipe'] });
  verify(Array.isArray(JSON.parse(String(board)).channels), 'Expected channels from the existing local Board');
  exec('bb', ['thread', 'spawn', '--help'], { timeout: 6000, stdio: 'ignore' });
  return { runtime: 'bb', boardSdk: installed, implementationModel: profiles.implementation.model };
}

export function runDoctor({ argv = [], env = process.env, exec = execFileSync, exists = existsSync,
  readFile = readFileSync, nodeVersion = process.versions.node, sourceRoot = source, runtimeRoot = runtime,
  checkLegacy = checkLegacyHost, checkPortable = checkPortableHost } = {}) {
  const runtimeKind = resolveRuntime({ argv, env, runtimeRoot, exists });
  const common = { env, exec, nodeVersion };
  return runtimeKind === 'bb'
    ? checkLegacy({ ...common, sourceRoot, runtimeRoot, readFile })
    : checkPortable({ ...common, runtimeKind });
}

const main = () => {
  try {
    const report = runDoctor({ argv: process.argv.slice(2) });
    if (report.runtime === 'bb') {
      console.log(`OK Board SDK ${report.boardSdk}`);
      console.log('OK operational sources match the installed copies');
      console.log(`OK manual-bb; implementation acp-devin/${report.implementationModel}; ZCode Start GLM-5.3 Flash/max; review Pi/Sol 6.2/medium`);
      console.log('OK existing Board is reachable; BB CLI available (no agent started)');
    } else {
      console.log(`OK runtime ${report.runtime}; Board /channels reachable; hc/devin/agy/pi CLIs available (no agent started)`);
    }
  } catch (error) {
    console.error(`doctor: ${error.message.split('\n')[0]}`);
    process.exitCode = 1;
  }
};

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main();
}
