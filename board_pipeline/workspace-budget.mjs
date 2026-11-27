import { statfs } from 'node:fs/promises';

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
