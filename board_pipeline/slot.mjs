import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { once } from 'node:events';

export async function syncDir(path) {
  const marker = await open(path, 'r');
  try { await marker.sync(); } finally { await marker.close(); }
}

export async function saveState(path, value) {
  const tmp = `${path}.new`;
  const fd = await open(tmp, 'w', 0o600);
  try { await fd.writeFile(JSON.stringify(value)); await fd.sync(); } finally { await fd.close(); }
  await rename(tmp, path);
  await syncDir(dirname(path));
}

async function kernelLock(path) {
  // The helper owns flock while this process holds its stdin open. SIGKILL closes the pipe too.
  const child = spawn('flock', ['--no-fork', '--nonblock', path, process.execPath, '-e',
    'process.stdout.write("held\\n");process.stdin.resume()'], { stdio: ['pipe', 'pipe', 'ignore'] });
  const stopped = once(child, 'exit');
  try {
    const marker = await Promise.race([
      once(child.stdout, 'data').then(([data]) => data.toString()),
      stopped.then(() => ''),
    ]);
    if (marker !== 'held\n') throw new Error('Worktree controller is already running');
  } catch (error) {
    child.stdin.end();
    throw error;
  }
  return async () => { child.stdin.end(); await stopped; };
}

// The durable reservation is independent of the process lock. A dead CLI does not free a writer.
export async function reserveWorktree(registry, tree, state, opts = {}) {
  await mkdir(registry, { mode: 0o700, recursive: true });
  const info = await lstat(registry);
  if (!info.isDirectory() || info.uid !== process.getuid() || info.mode & 0o077 || await realpath(registry) !== registry) {
    throw new Error('Worktree registry must be private');
  }
  const path = join(registry, createHash('sha256').update(await realpath(tree)).digest('hex'));
  const release = await kernelLock(`${path}.lock`);
  try {
    const identity = await lstat(state);
    const reservation = { state, device: identity.dev, inode: identity.ino };
    let old;
    try { old = JSON.parse(await readFile(`${path}.json`, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    // GUARD:SingleLiveWriter — бронь прежнего писателя держится до подтверждения
    // отсутствия живого писателя, а не до истечения аренды.
    if (!opts.allowTakeoverWithLiveWriter &&
        old && (old.state !== state || old.device !== identity.dev || old.inode !== identity.ino)) {
      throw new Error('Prior writer is still reserved; reconcile before reusing this worktree');
    }
    if (!old) await saveState(`${path}.json`, reservation);
    return release;
  } catch (error) {
    await release();
    throw error;
  }
}
