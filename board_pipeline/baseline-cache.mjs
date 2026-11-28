import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync,
  realpathSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { inside } from './fs-safe.mjs';

export const BASELINE_SCHEMA = 'darkfactory.baseline.v1';
export const DEFAULT_BASELINE_TTL_MS = 24 * 60 * 60 * 1000;

const sortedUnique = values => [...new Set(values)].sort();
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const validSha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const validFailures = list => Array.isArray(list) && Array.from(list).every(nonempty);

// Pytest appends " - <reason>" but parameter IDs can contain that separator too.
function pytestName(summary) {
  let brackets = 0;
  for (let i = 0; i < summary.length; i++) {
    if (summary[i] === '[') brackets++;
    else if (summary[i] === ']' && brackets > 0) brackets--;
    else if (!brackets && summary.startsWith(' - ', i)) return summary.slice(0, i);
  }
  return summary;
}

export function extractFailedTests(output) {
  const names = [];
  for (const raw of stripVTControlCharacters(output ?? '').split('\n')) {
    const line = raw.trim();
    if (line === '✖ failing tests:') continue; // spec reporter summary header
    const node = /^(?:not ok\s+\d+\s+-\s+|✖\s+)(.+)$/.exec(line);
    const pytest = /^FAILED\s+(.+)$/.exec(line);
    const name = (node?.[1] ?? (pytest ? pytestName(pytest[1]) : ''))
      .replace(/\s*\(\d+(?:\.\d+)?\s*(?:ns|µs|ms|s)\)$/, '').trim();
    if (name) names.push(name);
  }
  return sortedUnique(names);
}

export function baselineCacheKey(input) {
  const { baseSha, l1Profile, commandsDigest } = input ?? {};
  if (!validSha(baseSha) || !nonempty(l1Profile) || !nonempty(commandsDigest)) {
    throw new Error('baseline_key_invalid');
  }
  return createHash('sha256').update(JSON.stringify([baseSha, l1Profile, commandsDigest])).digest('hex');
}

function entryPath(cacheDir, key, worktree) {
  if (typeof key !== 'string' || !/^[a-f0-9]{64}$/i.test(key)) throw new Error('baseline_key_invalid');
  if (!nonempty(cacheDir)) throw new Error('baseline_cache_dir_invalid');
  const dir = resolve(cacheDir);
  if (worktree !== null && (inside(resolve(worktree), dir) || inside(realpathSync(worktree), dir))) {
    throw new Error('baseline_cache_inside_worktree');
  }
  return join(dir, `${key}.json`);
}

// Walk from the root: recursive mkdir alone could follow an ancestor symlink
// and create directories in the worktree before the final directory is checked.
function checkDirectory(dir, create) {
  const parent = dirname(dir);
  if (parent !== dir) checkDirectory(parent, create);
  let stat = lstatSync(dir, { throwIfNoEntry: !create });
  if (!stat) {
    try { mkdirSync(dir, { mode: 0o700 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    stat = lstatSync(dir);
  }
  if (stat.isSymbolicLink()) throw new Error('baseline_cache_symlink');
  if (!stat.isDirectory()) throw new Error('baseline_cache_dir_invalid');
}

function checkEntry(path) {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat?.isSymbolicLink()) throw new Error('baseline_cache_symlink');
  if (stat && !stat.isFile()) throw new Error('baseline_cache_file_invalid');
}

function validRecord(record) {
  return validSha(record?.baseSha) && nonempty(record.l1Profile) && typeof record.ok === 'boolean' &&
    (record.exitCode === null || Number.isSafeInteger(record.exitCode)) && validFailures(record.failedTests) &&
    Number.isSafeInteger(record.recordedAt) && record.recordedAt >= 0;
}

export function writeBaselineCache(cacheDir, key, record, { worktree = null } = {}) {
  const path = entryPath(cacheDir, key, worktree);
  const { baseSha, l1Profile, ok, exitCode, failedTests, recordedAt = Date.now() } = record ?? {};
  const entry = { schema: BASELINE_SCHEMA, key, baseSha, l1Profile, ok, exitCode, failedTests, recordedAt };
  if (!validRecord(entry)) throw new Error('baseline_record_invalid');
  entry.failedTests = sortedUnique(failedTests);
  const dir = dirname(path);
  checkDirectory(dir, true);
  checkEntry(path);
  const tmp = join(dir, `${key}.${randomUUID()}.tmp`);
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    try { writeFileSync(fd, JSON.stringify(entry) + '\n'); }
    finally { closeSync(fd); }
    renameSync(tmp, path);
  } catch (error) {
    unlinkSync(tmp);
    throw error;
  }
}

export function readBaselineCache(cacheDir, key, { ttlMs = DEFAULT_BASELINE_TTL_MS, now = Date.now, worktree = null } = {}) {
  const path = entryPath(cacheDir, key, worktree);
  let raw;
  try {
    checkDirectory(dirname(path), false);
    checkEntry(path);
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (!fstatSync(fd).isFile()) throw new Error('baseline_cache_file_invalid');
      raw = readFileSync(fd, 'utf8');
    } finally { closeSync(fd); }
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  let entry;
  try { entry = JSON.parse(raw); } catch { return null; }
  if (entry?.schema !== BASELINE_SCHEMA || entry.key !== key || !validRecord(entry)) return null;
  const age = now() - entry.recordedAt;
  return Number.isFinite(ttlMs) && Number.isFinite(age) && age >= 0 && age <= ttlMs ? entry : null;
}

export function compareAgainstBaseline(baseline, candidate, { mode = 'ratchet' } = {}) {
  if (mode !== 'ratchet' && mode !== 'strict') throw new Error('baseline_mode_invalid');
  const before = new Set(validFailures(baseline?.failedTests) ? baseline.failedTests : []);
  const after = new Set(validFailures(candidate?.failedTests) ? candidate.failedTests : []);
  const fixedFailures = [...before].filter(name => !after.has(name)).sort();
  if (candidate?.ok === true) return { status: 'clean', ok: true, newFailures: [], preexistingFailures: [], fixedFailures };

  const newFailures = [...after].filter(name => !before.has(name)).sort();
  const preexistingFailures = [...after].filter(name => before.has(name)).sort();
  const ok = mode === 'ratchet' && baseline?.ok === false && candidate?.ok === false &&
    before.size > 0 && after.size > 0 && newFailures.length === 0;
  return { status: ok ? 'preexisting_red' : 'regressed', ok, newFailures, preexistingFailures, fixedFailures };
}
