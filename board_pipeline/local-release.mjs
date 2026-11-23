import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { canonicalDigest } from './subject.mjs';
import { promoteKey, ReleaseDenied, sameVersion } from './release-contract.mjs';
import { ARTIFACT_LIMIT, makeReleaseRecord, openLocalTarget,
  readTargetRecord, writeExclusiveTargetRecord } from './release-target.mjs';
import { releaseReader } from './release-readback.mjs';
import { kernelLock, syncDir } from './slot.mjs';

const exec = promisify(execFile);
const SHA = /^[a-f0-9]{40}$/;
const SAFE_PATH = /^[A-Za-z0-9][A-Za-z0-9_.-]*(\/[A-Za-z0-9][A-Za-z0-9_.-]*)*$/;

export const promotingOperation = plan => canonicalDigest(plan);
export const rollbackOperation = plan => canonicalDigest({ action: 'rollback', promotion: promotingOperation(plan) });

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
  const reader = releaseReader(url);
  if (typeof artifact !== 'string' || !SAFE_PATH.test(artifact) || typeof smokePrefix !== 'string' ||
      !smokePrefix.trim() || smokePrefix.length > 128) throw new ReleaseDenied('release_policy_invalid');
  const site = await openLocalTarget(root, { target, repo });
  const target_digest = canonicalDigest({ root, marker: site.markerDigest, url });
  const smoke_digest = canonicalDigest({ type: 'static-text-prefix.v1', prefix: smokePrefix });

  async function readBack() {
    await site.assertTarget();
    return reader.readBack(site);
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
    const { bytes } = await reader.readArtifact(expected, site.instance);
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
