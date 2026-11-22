import { execFile } from 'node:child_process';
import { request } from 'node:http';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { canonicalDigest } from './subject.mjs';
import { isVersion, promoteKey, ReleaseDenied, sameVersion } from './release-contract.mjs';
import { ARTIFACT_LIMIT, digestBytes, makeReleaseRecord, openLocalTarget,
  readTargetRecord, writeExclusiveTargetRecord } from './release-target.mjs';
import { kernelLock, syncDir } from './slot.mjs';

const exec = promisify(execFile);
const SHA = /^[a-f0-9]{40}$/;
const HEX = /^[a-f0-9]{64}$/;
const SAFE_PATH = /^[A-Za-z0-9][A-Za-z0-9_.-]*(\/[A-Za-z0-9][A-Za-z0-9_.-]*)*$/;

export const promotingOperation = plan => canonicalDigest(plan);
export const rollbackOperation = plan => canonicalDigest({ action: 'rollback', promotion: promotingOperation(plan) });

function endpoint(url) {
  if (typeof url !== 'string' || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(url)) {
    throw new ReleaseDenied('release_endpoint_invalid');
  }
  const port = Number(url.split(':').at(-1));
  if (port === 44100 || port > 65535) throw new ReleaseDenied('release_endpoint_invalid');
  return port;
}

async function get(port, path, limit) {
  try {
    const response = await new Promise((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port, path, method: 'GET', agent: false,
        signal: AbortSignal.timeout(5000) }, resolve);
      req.once('error', reject);
      req.end();
    });
    if (response.statusCode !== 200) {
      response.destroy();
      throw new ReleaseDenied('release_target_readback_failed');
    }
    const chunks = [];
    let bytes = 0;
    for await (const chunk of response) {
      bytes += chunk.length;
      if (bytes > limit) throw new ReleaseDenied('release_target_reply_too_large');
      chunks.push(chunk);
    }
    return { bytes: Buffer.concat(chunks), headers: response.headers };
  } catch (cause) {
    if (cause instanceof ReleaseDenied) throw cause;
    throw new ReleaseDenied('release_target_unreachable', { cause });
  }
}

async function trackedArtifact(worktree, sha, path, target) {
  if (typeof sha !== 'string' || !SHA.test(sha) || typeof path !== 'string' || !SAFE_PATH.test(path)) {
    throw new ReleaseDenied('release_artifact_invalid');
  }
  try {
    const { stdout: entry } = await exec('git', ['-C', worktree, 'ls-tree', sha, '--', path], { timeout: 5000 });
    const [meta, name] = entry.trimEnd().split('\t');
    if (name !== path || !/^100644 blob [a-f0-9]{40}$/.test(meta)) throw new ReleaseDenied('release_artifact_invalid');
    const { stdout: bytes } = await exec('git', ['-C', worktree, 'cat-file', 'blob', `${sha}:${path}`],
      { encoding: 'buffer', timeout: 10_000, maxBuffer: ARTIFACT_LIMIT });
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return makeReleaseRecord(target, sha, bytes);
  } catch (cause) {
    if (cause instanceof ReleaseDenied) throw cause;
    throw new ReleaseDenied('release_artifact_invalid', { cause });
  }
}

export async function localReleasePort({ root, target, repo, url, worktree, artifact, smokePrefix }) {
  const port = endpoint(url);
  if (typeof artifact !== 'string' || !SAFE_PATH.test(artifact) || typeof smokePrefix !== 'string' ||
      !smokePrefix.trim() || smokePrefix.length > 128) throw new ReleaseDenied('release_policy_invalid');
  const site = await openLocalTarget(root, { target, repo });
  const target_digest = canonicalDigest({ root, marker: site.markerDigest, url });
  const smoke_digest = canonicalDigest({ type: 'static-text-prefix.v1', prefix: smokePrefix });

  async function readBack() {
    await site.assertTarget();
    const reply = await get(port, '/version', 2048);
    let live;
    try { live = JSON.parse(reply.bytes.toString('utf8')); }
    catch (cause) { throw new ReleaseDenied('release_readback_invalid', { cause }); }
    if (!isVersion(live) || live.target !== target || live.instance !== site.instance ||
        (live.operation !== null && (typeof live.operation !== 'string' || !HEX.test(live.operation)))) {
      throw new ReleaseDenied('release_readback_invalid');
    }
    return { sha: live.sha, digest: live.digest, operation: live.operation };
  }

  function checkPlan(plan) {
    if (plan?.target !== target || plan.target_digest !== target_digest || plan.smoke_digest !== smoke_digest) {
      throw new ReleaseDenied('release_target_or_policy_changed');
    }
  }

  async function active() {
    const { record } = await site.active();
    const live = await readBack();
    if (!sameVersion(live, record) || live.operation !== record.operation) throw new ReleaseDenied('release_readback_inconsistent');
    return record;
  }

  async function smoke(expected) {
    const { bytes, headers } = await get(port, '/artifact', ARTIFACT_LIMIT);
    if (headers['x-release-instance'] !== site.instance || headers['x-release-sha'] !== expected.sha ||
        headers['x-release-digest'] !== expected.digest || headers['x-release-operation'] !== (expected.operation ?? '') ||
        digestBytes(bytes) !== expected.digest) throw new ReleaseDenied('release_smoke_version_changed');
    return { ok: bytes.toString('utf8').startsWith(smokePrefix), sha: expected.sha, digest: expected.digest };
  }

  async function locked(action) {
    await site.assertTarget();
    const release = await kernelLock(await site.lockPath());
    try { await site.assertTarget(); return await action(); }
    finally { await release(); }
  }
  const recordPath = plan => join(site.root, `promotion-${promoteKey(plan)}.json`);

  return {
    async prepare(sha) {
      const candidate = await trackedArtifact(worktree, sha, artifact, target);
      const prior = await active();
      if (candidate.digest === prior.digest) throw new ReleaseDenied('release_no_change');
      if (!(await smoke(prior)).ok) throw new ReleaseDenied('release_previous_smoke_red');
      return { target, target_digest, smoke_digest,
        candidate: { sha, digest: candidate.digest }, previous: { sha: prior.sha, digest: prior.digest } };
    },
    async readBack(plan) { checkPlan(plan); return readBack(); },
    async promote(plan, authorized) {
      checkPlan(plan);
      await locked(async () => {
        const prior = await active();
        const candidate = await trackedArtifact(worktree, plan.sha, artifact, target);
        if (!sameVersion(prior, plan.previous) || !sameVersion(candidate, plan)) {
          throw new ReleaseDenied('release_candidate_or_previous_changed');
        }
        await authorized();
        const operation = promotingOperation(plan);
        // O_EXCL makes an old key non-repeatable even after rollback. On an
        // incomplete intent the controller only reconciles by live operation.
        await writeExclusiveTargetRecord(recordPath(plan), { operation, previous: prior });
        await syncDir(site.root);
        await site.swap({ ...candidate, operation }, authorized);
      });
    },
    async rollback(plan, authorized) {
      checkPlan(plan);
      await locked(async () => {
        const current = await active();
        const backup = await readTargetRecord(recordPath(plan));
        if (!sameVersion(current, plan) || current.operation !== promotingOperation(plan) ||
            backup?.operation !== current.operation || !sameVersion(backup.previous, plan.previous)) {
          throw new ReleaseDenied('release_rollback_fence_mismatch');
        }
        await site.swap({ ...backup.previous, operation: rollbackOperation(plan) }, authorized);
      });
    },
    async verify(plan, expected, onGreen) {
      checkPlan(plan);
      return locked(async () => {
        const current = await active();
        if (!sameVersion(current, expected) || current.operation !== expected.operation) {
          throw new ReleaseDenied('release_version_changed');
        }
        const result = await smoke(current);
        if (result.ok && onGreen) await onGreen(result);
        return result;
      });
    },
  };
}
