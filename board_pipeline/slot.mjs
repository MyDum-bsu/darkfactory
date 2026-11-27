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

export async function kernelLock(path) {
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
// opts.stateDir/opts.journalDir: when provided, the canonical state directories are
// exclusively locked too (keyed by realpath in the same registry). Two worktrees
// accidentally sharing one state directory cannot overwrite each other's attempt.json
// or kill each other's workers. When both options are omitted the behaviour is
// exactly the historical one (backward compatible).
export async function reserveWorktree(registry, tree, state, opts = {}) {
  await mkdir(registry, { mode: 0o700, recursive: true });
  const info = await lstat(registry);
  if (!info.isDirectory() || info.uid !== process.getuid() || info.mode & 0o077 || await realpath(registry) !== registry) {
    throw new Error('Worktree registry must be private');
  }
  const path = join(registry, createHash('sha256').update(await realpath(tree)).digest('hex'));
  const stateDirs = [];
  for (const dir of [opts.stateDir, opts.journalDir]) {
    if (dir === undefined) continue;
    if (typeof dir !== 'string' || !dir) throw new Error('State directory option must be an absolute path');
    const canonical = await realpath(dir);
    if (!stateDirs.includes(canonical)) stateDirs.push(canonical);
  }
  // Deterministic acquisition order: worktree lock first, then canonical state
  // directories in sorted order — concurrent reservations cannot interleave.
  stateDirs.sort();
  const release = await kernelLock(`${path}.lock`);
  const stateReleases = [];
  const releaseAll = async () => {
    for (const unlock of stateReleases.splice(0).reverse()) await unlock();
    await release();
  };
  try {
    for (const dir of stateDirs) {
      const key = createHash('sha256').update(dir).digest('hex');
      try {
        stateReleases.push(await kernelLock(join(registry, `state-${key}.lock`)));
      } catch (cause) {
        throw new Error(`State directory is already locked by another writer: ${dir}`, { cause });
      }
    }
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
    return releaseAll;
  } catch (error) {
    await releaseAll();
    throw error;
  }
}
