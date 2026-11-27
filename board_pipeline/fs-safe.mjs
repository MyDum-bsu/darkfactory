import { constants } from 'node:fs';
import { lstat, open, realpath, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

const pathString = value => typeof value === 'string' && value.length > 0 && !value.includes('\0');

// Lexical containment (including equality). Callers checking filesystem
// boundaries must resolve symlinks according to their own path policy first.
export function inside(root, targetPath) {
  if (!pathString(root) || !pathString(targetPath) ||
      root.split(sep).includes('..') || targetPath.split(sep).includes('..')) return false;
  const rel = relative(root, targetPath);
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`);
}

// Match a single component. Only the most recent '*' can need extending:
// no recursive search or regexp backtracking, even for interleaved stars.
function matchComponent(pattern, component) {
  let p = 0, c = 0, star = -1, end = 0;
  while (c < component.length) {
    if (pattern[p] === '*') {
      star = p++;
      end = c;
    } else if (pattern[p] === '?' || pattern[p] === component[c]) {
      p++; c++;
    } else if (star !== -1) {
      p = star + 1;
      c = ++end;
    } else {
      return false;
    }
  }
  while (pattern[p] === '*') p++;
  return p === pattern.length;
}

// Match complete, canonical repo-relative paths. '*' and '?' stay within a
// component; a whole '**' component consumes zero or more components.
export function globMatch(pattern, relPath) {
  if (!pathString(pattern) || !pathString(relPath)) return false;
  const parts = relPath.split('/');
  const tokens = pattern.split('/');
  const invalid = part => !part || part === '.' || part === '..';
  if (parts.some(invalid) || tokens.some(invalid)) return false;

  // matched[n]: the pattern so far matches the first n components. Update
  // forward for ** (can consume another), backwards for a single component.
  const matched = new Uint8Array(parts.length + 1);
  matched[0] = 1;
  for (const token of tokens) {
    if (token === '**') {
      for (let i = 1; i <= parts.length; i++) matched[i] |= matched[i - 1];
    } else {
      for (let i = parts.length; i > 0; i--) {
        matched[i] = matched[i - 1] && matchComponent(token, parts[i - 1]);
      }
      matched[0] = 0;
    }
  }
  return Boolean(matched[parts.length]);
}

const keep = reason => ({ reaped: false, reason });
const sameFile = (a, b) => b.isFile() && a.dev === b.dev && a.ino === b.ino;

function ownerAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

// For lockfiles in a trusted, stable directory. Pin the inode across both
// reads; O_NOFOLLOW covers replacement after lstat, O_NONBLOCK a swapped FIFO.
// A pathname unlink is not an atomic compare-and-delete: check identity last.
export async function reapStaleLock(lockPath, options) {
  const { staleMs, nowMs = Date.now() } = options ?? {};
  if (!pathString(lockPath) || lockPath.endsWith(sep) || lockPath.split(sep).includes('..') ||
      !Number.isFinite(staleMs) || staleMs < 0 || !Number.isFinite(nowMs)) return keep('invalid');
  let handle;
  try {
    const parent = resolve(dirname(lockPath));
    if (await realpath(parent) !== parent) return keep('symlink');
    const before = await lstat(lockPath);
    if (before.isSymbolicLink()) return keep('symlink');
    if (!before.isFile()) return keep('not_file');
    handle = await open(lockPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (!sameFile(before, await handle.stat())) return keep('changed');
    const raw = await handle.readFile();
    let meta;
    try { meta = JSON.parse(raw); } catch { /* partial/legacy lock: use mtime */ }
    const created = typeof meta?.createdAt === 'string' ? Date.parse(meta.createdAt) : NaN;
    if (nowMs - (Number.isFinite(created) ? created : before.mtimeMs) <= staleMs) return keep('fresh');
    if (ownerAlive(meta?.pid)) return keep('live_owner');

    const again = Buffer.alloc(raw.length);
    const { bytesRead } = await handle.read(again, 0, again.length, 0);
    const after = await lstat(lockPath);
    if (!sameFile(before, after) || after.size !== raw.length || after.ctimeMs !== before.ctimeMs ||
        bytesRead !== raw.length || !again.equals(raw)) return keep('changed');
    await unlink(lockPath);
    return { reaped: true, reason: 'stale' };
  } catch (error) {
    return keep(error.code === 'ENOENT' ? 'missing' : 'io_error');
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}
