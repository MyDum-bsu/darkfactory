import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const source = fileURLToPath(new URL('./local/', import.meta.url));
const runtime = join(homedir(), '.local', 'share', 'vercel-board');
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex');
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

const main = () => {
  try {
    const [major, minor] = process.versions.node.split('.').map(Number);
    verify(major > 22 || (major === 22 && minor >= 18), 'Node 22.18+ is required');
    const expected = readJson(join(source, 'package-lock.json')).packages['node_modules/@vercel/board'].version;
    const installed = readJson(join(runtime, 'node_modules/@vercel/board/package.json')).version;
    verify(installed === expected, `Expected Board SDK ${expected}, found ${installed}`);
    console.log(`OK Board SDK ${installed}`);

    for (const path of ['board-review.mjs', 'check-workspace-space.mjs', 'guarded-worktree-spawn.sh',
      'pick-personal-worker.mjs', 'open-board.sh', 'electron-app/main.cjs', 'electron-app/assets/vercel-board.svg']) {
      verify(sha(join(source, path)) === sha(join(runtime, path)), `Runtime differs: ${path}`);
    }
    console.log('OK operational sources match the installed copies');

    const routes = readJson(join(runtime, 'routes.json'));
    const profiles = routes.workerPresets;
    verify(routes.execution === 'manual-bb' && routes.automaticGitHubActions === false, 'Unexpected active execution policy');
    verify(validateImplementationPreset(profiles.implementation), 'Unexpected SWE-2 preset');
    verify(profiles.zcodeStart.provider === 'acp-zcode-start' && profiles.zcodeStart.model.endsWith('GLM-5.3-Flash') &&
      profiles.zcodeStart.reasoningLevel === 'max', 'Unexpected ZCode Start preset');
    verify(profiles.reviewer.provider === 'pi' && profiles.reviewer.model === 'openai/gpt-6.2-sol' &&
      profiles.reviewer.reasoningLevel === 'medium', 'Unexpected review preset');
    console.log(`OK manual-bb; implementation acp-devin/${profiles.implementation.model}; ZCode Start GLM-5.3 Flash/max; review Pi/Sol 6.2/medium`);

    const env = { ...process.env, XDG_CONFIG_HOME: join(runtime, 'config') };
    const boardUrl = process.env.BOARD_TOKEN ?
      process.env.BOARD_URL || 'http://127.0.0.1:44100/api/board' :
      'http://127.0.0.1:44100/api/board';
    if (!process.env.BOARD_TOKEN) {
      delete env.BOARD_TOKEN;
      delete env.BOARD_URL;
    }
    const board = execFileSync(join(runtime, 'node_modules/.bin/vb'), [
      '--url', boardUrl, 'channels', 'list', '--json',
    ], { env, encoding: 'utf8', timeout: 9000, stdio: ['ignore', 'pipe', 'pipe'] });
    verify(Array.isArray(JSON.parse(board).channels), 'Expected channels from the existing local Board');
    execFileSync('bb', ['thread', 'spawn', '--help'], { timeout: 6000, stdio: 'ignore' });
    console.log('OK existing Board is reachable; BB CLI available (no agent started)');
  } catch (error) {
    console.error(`doctor: ${error.message.split('\n')[0]}`);
    process.exitCode = 1;
  }
};

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main();
}
