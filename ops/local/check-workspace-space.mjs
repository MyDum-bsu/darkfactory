import { statfs } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const GiB = 1024n ** 3n;
export const MIN_GIB = Object.freeze({ worktree: 8n, build: 8n, review: 3n });

export function checkBudget(stat, kind) {
  const min = MIN_GIB[kind];
  if (typeof min !== 'bigint') throw new Error('kind must be worktree, build or review');
  if (typeof stat?.bavail !== 'bigint' || typeof stat?.bsize !== 'bigint' || stat.bavail < 0 || stat.bsize <= 0) {
    throw new Error('available filesystem space could not be measured');
  }
  const available = stat.bavail * stat.bsize;
  return { kind, minGiB: Number(min), availableGiB: Number((available * 100n) / GiB) / 100, allowed: available >= min * GiB };
}

export async function requireWorkspaceSpace(path, kind) {
  const result = checkBudget(await statfs(path, { bigint:true }), kind);
  if (!result.allowed) throw new Error(`disk budget: ${result.availableGiB} GiB free; ${kind} requires ${result.minGiB} GiB`);
  return result;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const [kind, path, ...extra] = process.argv.slice(2);
    if (!path || extra.length) throw new Error('usage: check-workspace-space.mjs worktree|build|review EXISTING_PATH');
    console.log(JSON.stringify(await requireWorkspaceSpace(path, kind)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
