import { execFile } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';

const git = promisify(execFile);
export const DEFAULT_DOCS_PATH = join(homedir(), '.local/state/herdr-core/default/docs.json');
const text = v => typeof v === 'string' && v.trim().length > 0 && !/[\x00-\x1f]/.test(v);
function deny(code = 'herdr_space_mismatch') { throw Object.assign(new Error(code), { code }); }
const canonical = path => text(path) && isAbsolute(path) ? realpath(path).catch(() => null) : null;

// A linked slot need not be below the enrolled repo (and often isn't). Check
// its Git identity, not a string prefix or the current working directory.
export async function worktreeRepoDir(worktree) {
  if (!await canonical(worktree)) deny();
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
  const run = async args => (await git('git', ['-C', worktree, ...args], { env, timeout: 5000 }).catch(() => deny())).stdout;
  const top = await run(['rev-parse', '--show-toplevel']);
  if (top !== `${worktree}\n`) deny();
  // rev-parse alone also accepts an unregistered checkout whose .git file
  // points at somebody else's gitdir. Require a real worktree-list entry.
  const list = await run(['worktree', 'list', '--porcelain', '-z']);
  const roots = list.split('\0\0').map(row => row.split('\0')[0]).filter(line => line.startsWith('worktree '))
    .map(line => line.slice('worktree '.length));
  if (!roots.includes(worktree) || !roots[0]) deny();
  return await canonical(roots[0]) ?? deny();
}

export async function resolveHerdrSpace(project, { docsPath = DEFAULT_DOCS_PATH } = {}) {
  const { repo_id, repo_dir, herdr_space_name, herdrSpaceId } = project ?? {};
  const dir = await canonical(repo_dir);
  if (!dir || !text(repo_id) || (herdr_space_name !== undefined && !text(herdr_space_name))) deny();
  let spaces;
  try { spaces = JSON.parse(await readFile(docsPath, 'utf8'))['herdr-app'].value.spaces; } catch { /* missing registry */ }
  if (!Array.isArray(spaces)) deny('herdr_space_not_found');
  const folders = await Promise.all(spaces.map(space => canonical(space?.folder)));
  const matches = spaces.filter((_, i) => folders[i] === dir);
  if (!matches.length) {
    if (spaces.some(s => s && ((herdr_space_name !== undefined && s.name === herdr_space_name) ||
      (herdrSpaceId !== undefined && s.id === herdrSpaceId)))) deny();
    deny('herdr_space_not_found');
  }
  const [space] = matches;
  if (matches.length !== 1 || !text(space.id) || !text(space.name) ||
      (space.repo_id !== undefined && space.repo_id !== repo_id) ||
      (herdr_space_name === undefined && (space.repo_id ?? basename(dir)) !== repo_id) ||
      spaces.filter(s => s?.id === space.id).length !== 1 ||
      (herdr_space_name !== undefined && (space.name !== herdr_space_name ||
        spaces.filter(s => s?.name === herdr_space_name).length !== 1)) ||
      (herdrSpaceId !== undefined && space.id !== herdrSpaceId) ||
      (space.name.toLowerCase() === 'darkfactory' && repo_id.toLowerCase() !== 'darkfactory')) deny();
  return space.id;
}

// The controller passes route.herdrSpaceId or (on older policies) route.repoId
// as spaceLabel. Neither is authority to override the folder-derived owner.
export async function workerSpace(input, { project, docsPath } = {}) {
  const dir = await worktreeRepoDir(input.worktree);
  if (project !== undefined && (await canonical(project?.repo_dir) !== dir ||
      (project.worktree !== undefined && project.worktree !== input.worktree))) deny();
  if (project === undefined && !text(input.spaceLabel)) deny();
  const owner = project ?? { repo_id: basename(dir), repo_dir: dir };
  const id = await resolveHerdrSpace(owner, { docsPath });
  if (input.spaceLabel !== undefined && input.spaceLabel !== owner.repo_id && input.spaceLabel !== id) deny();
  return id;
}
