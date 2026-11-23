import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, rename, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { isAbsolute, join } from 'node:path';
import { canonicalDigest } from './subject.mjs';
import { isReleaseTarget, isVersion, ReleaseDenied } from './release-contract.mjs';
import { syncDir } from './slot.mjs';

export const ARTIFACT_LIMIT = 512 * 1024;
const RECORD_LIMIT = 1024 * 1024;
const MARKER = 'release-target.json';
const LIVE = 'live.json';
const TARGET_SCHEMA = 'darkfactory.isolated-static-target.v1';
const REPO = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;
const INSTANCE = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const OPERATION = /^[a-f0-9]{64}$/;
export const RELEASE_LOCK = 'release.lock';
export const digestBytes = bytes => createHash('sha256').update(bytes).digest('hex');

async function directory(path) {
  if (!isAbsolute(path ?? '') || await realpath(path) !== path) throw new ReleaseDenied('release_directory_invalid');
  const info = await lstat(path);
  if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o077)) {
    throw new ReleaseDenied('release_directory_invalid');
  }
  return info;
}

export async function readTargetRecord(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = await file.stat();
    if (!st.isFile() || st.uid !== process.getuid() || st.nlink !== 1 || (st.mode & 0o077) ||
        st.size < 1 || st.size > RECORD_LIMIT) throw new ReleaseDenied('release_record_invalid');
    const bytes = Buffer.alloc(st.size + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== st.size) throw new ReleaseDenied('release_record_invalid');
    try { return JSON.parse(bytes.toString('utf8', 0, bytesRead)); }
    catch (cause) { throw new ReleaseDenied('release_record_invalid', { cause }); }
  } finally { await file.close(); }
}

export async function writeExclusiveTargetRecord(path, value) {
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json) > RECORD_LIMIT) throw new ReleaseDenied('release_record_invalid');
  const file = await open(path, 'wx', 0o600);
  try { await file.writeFile(json); await file.sync(); }
  finally { await file.close(); }
}

export function makeReleaseRecord(target, sha, bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > ARTIFACT_LIMIT) {
    throw new ReleaseDenied('release_artifact_invalid');
  }
  const record = { target, sha, digest: digestBytes(bytes), operation: null, content: bytes.toString('base64') };
  if (!isVersion(record) || !isReleaseTarget(target)) throw new ReleaseDenied('release_artifact_invalid');
  return record;
}

export function artifactBytes(record, target) {
  if (!isVersion(record) || record.target !== target || typeof record.content !== 'string' ||
      (record.operation !== null && (typeof record.operation !== 'string' || !OPERATION.test(record.operation)))) {
    throw new ReleaseDenied('release_artifact_invalid');
  }
  const bytes = Buffer.from(record.content, 'base64');
  if (!bytes.length || bytes.length > ARTIFACT_LIMIT || bytes.toString('base64') !== record.content ||
      digestBytes(bytes) !== record.digest) throw new ReleaseDenied('release_artifact_invalid');
  return bytes;
}

// Separate operator bootstrap of an empty, already-approved local target.
// The controller never calls enrollment as part of prepare or release.
export async function enrollLocalTarget(root, { target, repo, initialSha, initialBytes }) {
  await directory(root);
  if (!isReleaseTarget(target) || typeof repo !== 'string' || !REPO.test(repo)) {
    throw new ReleaseDenied('release_enrollment_invalid');
  }
  const initial = makeReleaseRecord(target, initialSha, initialBytes);
  const marker = { schema: TARGET_SCHEMA, target, repo, instance: randomUUID() };
  await writeExclusiveTargetRecord(join(root, MARKER), marker);
  await writeExclusiveTargetRecord(join(root, LIVE), initial);
  await writeExclusiveTargetRecord(join(root, RELEASE_LOCK), { schema: TARGET_SCHEMA, instance: marker.instance });
  await syncDir(root);
}

export async function openLocalTarget(root, { target, repo }) {
  const identity = await directory(root);
  const marker = await readTargetRecord(join(root, MARKER));
  if (marker?.schema !== TARGET_SCHEMA || marker.target !== target || marker.repo !== repo ||
      !isReleaseTarget(target) || typeof marker.instance !== 'string' || !INSTANCE.test(marker.instance)) {
    throw new ReleaseDenied('release_enrollment_invalid');
  }
  const markerDigest = canonicalDigest(marker);
  async function assertTarget() {
    const current = await directory(root);
    if (current.dev !== identity.dev || current.ino !== identity.ino ||
        canonicalDigest(await readTargetRecord(join(root, MARKER))) !== markerDigest) {
      throw new ReleaseDenied('release_target_changed');
    }
  }
  const livePath = join(root, LIVE);
  return { root, livePath, target, instance: marker.instance, markerDigest, assertTarget,
    async lockPath() {
      const path = join(root, RELEASE_LOCK);
      const record = await readTargetRecord(path);
      if (record?.schema !== TARGET_SCHEMA || record.instance !== marker.instance) {
        throw new ReleaseDenied('release_lock_invalid');
      }
      return path;
    },
    async active() {
      await assertTarget();
      const record = await readTargetRecord(livePath);
      const bytes = artifactBytes(record, target);
      return { record, bytes };
    },
    async swap(record, authorized) {
      artifactBytes(record, target);
      const staging = join(root, `live-${randomUUID()}.tmp`);
      await assertTarget();
      await authorized();
      try {
        await writeExclusiveTargetRecord(staging, record);
        await assertTarget();
        await authorized();
        await rename(staging, livePath);
        await syncDir(root);
      } finally {
        await rm(staging, { force: true });
      }
    },
  };
}

// Same atomically-selected bytes for version and artifact. Never executes a
// candidate, never accepts writes, never binds a non-loopback interface.
export async function serveLocalTarget({ root, target, repo, port = 0 }) {
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535 || port === 44100) throw new ReleaseDenied('release_port_invalid');
  const site = await openLocalTarget(root, { target, repo });
  const server = createServer(async (request, response) => {
    response.setHeader('cache-control', 'no-store');
    if (request.method !== 'GET' || !['/version', '/artifact'].includes(request.url)) {
      response.writeHead(404); response.end(); return;
    }
    try {
      const { record, bytes } = await site.active();
      if (request.url === '/version') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ target, instance: site.instance, sha: record.sha, digest: record.digest,
          operation: record.operation }));
      } else {
        response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff',
          'x-release-instance': site.instance, 'x-release-sha': record.sha, 'x-release-digest': record.digest,
          'x-release-operation': record.operation ?? '' });
        response.end(bytes);
      }
    } catch {
      response.writeHead(503); response.end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const actualPort = server.address().port;
  if (actualPort === 44100) {
    await new Promise(resolve => server.close(resolve));
    throw new ReleaseDenied('release_port_invalid');
  }
  return { url: `http://127.0.0.1:${actualPort}`, close: () => new Promise((resolve, reject) => {
    server.close(error => { if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error); else resolve(); });
  }) };
}
