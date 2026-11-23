import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

const SHA = /^[a-f0-9]{40}$/;

async function localPath(path, field, directory = false) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error(`fixture.${field} must be an absolute path`);
  const resolved = await realpath(path);
  const info = await stat(resolved);
  if (directory ? !info.isDirectory() : !info.isFile()) {
    throw new Error(`fixture.${field} must name a local ${directory ? 'directory' : 'file'}`);
  }
  return resolved;
}

function isCommand(value) {
  return typeof value?.image === 'string' && !!value.image.trim() &&
    typeof value.cwd === 'string' && !isAbsolute(value.cwd) &&
    Array.isArray(value.argv) && !!value.argv[0] && value.argv.every(arg => typeof arg === 'string');
}

export async function loadVs1E2eFixture(path) {
  const cfg = JSON.parse(await readFile(await localPath(path, 'config'), 'utf8'));
  const { base, defect, final, finalTree, bbProject, checks, visual, allowTestDeletion } = cfg ?? {};
  if (![base, defect, final, finalTree].every(sha => typeof sha === 'string' && SHA.test(sha)) ||
      new Set([base, defect, final]).size !== 3) throw new Error('fixture must pin three distinct commit SHAs and a final tree SHA');
  if (typeof bbProject !== 'string' || !/^proj_[a-z0-9]+$/.test(bbProject)) throw new Error('fixture.bbProject is required');
  if (!Array.isArray(checks) || !checks.length || !checks.every(isCommand) || !isCommand(visual)) {
    throw new Error('fixture must supply local image, argv and relative cwd for each check and visual');
  }
  if (allowTestDeletion !== undefined && typeof allowTestDeletion !== 'boolean') {
    throw new Error('fixture.allowTestDeletion must be a boolean');
  }
  const repo = await localPath(cfg.repo, 'repo', true);
  const bundle = await localPath(cfg.bundle, 'bundle');
  const reviewPrompt = await readFile(await localPath(cfg.reviewPrompt, 'reviewPrompt'), 'utf8');
  if (!reviewPrompt.trim()) throw new Error('fixture.reviewPrompt is empty');
  return { repo, bundle, reviewPrompt, base, defect, final, finalTree,
    bbProject, checks, visual, allowTestDeletion: allowTestDeletion === true };
}
