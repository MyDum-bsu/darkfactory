import { pathToFileURL } from 'node:url';
import { requireWorkspaceSpace } from '../../board_pipeline/workspace-budget.mjs';

export { checkBudget, MIN_GIB, requireWorkspaceSpace } from '../../board_pipeline/workspace-budget.mjs';

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
