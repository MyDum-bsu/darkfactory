import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function loadSdk(root = join(homedir(), '.local', 'share', 'vercel-board')) {
  const resolve = createRequire(join(root, 'package.json'));
  return {
    board: resolve('@vercel/board').board,
    local: resolve('@vercel/board/backend-local').local,
  };
}
