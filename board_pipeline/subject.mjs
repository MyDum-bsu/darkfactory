// Канонический манифест приёмки (candidate-subject.v1) и его детерминированный digest.
// Git SHA доказывает байты tracked-дерева, но не соответствие спеке, профилю и данным;
// изменение любого поля манифеста даёт новый subject_digest и аннулирует прежние вердикты.

import { createHash } from 'node:crypto';

const SHA40 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const REPO_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;
const KINDS = new Set(['git_tree', 'artifact_bundle', 'hybrid']);
const ROLES = new Set(['primary', 'ui_screenshot', 'bundle']);
const FINISH = new Set(['verified', 'deployed']);

export class SubjectDenied extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

// Рекурсивно отсортированные ключи: одинаковые данные дают одинаковый байтовый JSON.
export function canonicalJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new SubjectDenied('subject_not_json');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    for (const key of keys) {
      if (value[key] === undefined) throw new SubjectDenied('subject_not_json');
    }
    return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  throw new SubjectDenied('subject_not_json');
}

export function canonicalDigest(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function checkKeys(record, expected, reason) {
  const keys = Object.keys(record).sort();
  if (keys.length !== expected.length || keys.some((key, i) => key !== expected[i])) {
    throw new SubjectDenied(reason);
  }
}

function checkHex(value, re, reason) {
  if (typeof value !== 'string' || !re.test(value)) throw new SubjectDenied(reason);
}

function checkNullableHex(value, re, reason) {
  if (value === null) return;
  checkHex(value, re, reason);
}

function checkNullableId(value, reason) {
  if (value === null) return;
  if (typeof value !== 'string' || !value) throw new SubjectDenied(reason);
}

// Строгая валидация канонического манифеста. git_tree/hybrid идентифицируют код полями source,
// artifact_bundle — перечнем артефактов; гибрид требует и то, и другое.
export function validateSubject(subject) {
  if (subject === null || typeof subject !== 'object' || Array.isArray(subject)) {
    throw new SubjectDenied('subject_not_object');
  }
  checkKeys(subject,
    ['artifacts', 'fixtures_digest', 'kind', 'policy_digest', 'release_target', 'schema', 'source', 'spec_digest'],
    'subject_unexpected_field');
  if (subject.schema !== 'candidate-subject.v1') throw new SubjectDenied('subject_schema_unknown');
  if (!KINDS.has(subject.kind)) throw new SubjectDenied('subject_kind_unknown');

  const source = subject.source;
  if (source === null || typeof source !== 'object' || Array.isArray(source)) {
    throw new SubjectDenied('subject_source_not_object');
  }
  checkKeys(source, ['base_sha', 'candidate_sha', 'merge_result_sha', 'repo_id', 'tree_sha'],
    'subject_source_unexpected_field');
  checkHex(source.repo_id, REPO_ID, 'subject_repo_id_invalid');
  const gitKind = subject.kind !== 'artifact_bundle';
  for (const field of ['base_sha', 'candidate_sha', 'tree_sha']) {
    if (gitKind) checkHex(source[field], SHA40, `subject_${field}_invalid`);
    else if (source[field] !== null) throw new SubjectDenied(`subject_${field}_invalid`);
  }
  checkNullableHex(source.merge_result_sha, SHA40, 'subject_merge_result_sha_invalid');

  const artifacts = subject.artifacts;
  if (!Array.isArray(artifacts)) throw new SubjectDenied('subject_artifacts_not_array');
  // git_tree обычно несёт пустой список, но может дополняться артефактами (например, L3);
  // identity artifact_bundle и hybrid строится на артефактах, поэтому список не пуст.
  if (subject.kind !== 'git_tree' && !artifacts.length) throw new SubjectDenied('subject_artifacts_empty');
  for (const artifact of artifacts) {
    if (artifact === null || typeof artifact !== 'object' || Array.isArray(artifact)) {
      throw new SubjectDenied('subject_artifact_not_object');
    }
    checkKeys(artifact, ['bytes', 'role', 'sha256'], 'subject_artifact_unexpected_field');
    if (!ROLES.has(artifact.role)) throw new SubjectDenied('subject_artifact_role_unknown');
    checkHex(artifact.sha256, SHA256, 'subject_artifact_sha256_invalid');
    if (!Number.isSafeInteger(artifact.bytes) || artifact.bytes < 0) {
      throw new SubjectDenied('subject_artifact_bytes_invalid');
    }
  }

  checkHex(subject.spec_digest, SHA256, 'subject_spec_digest_invalid');
  checkHex(subject.policy_digest, SHA256, 'subject_policy_digest_invalid');
  checkNullableHex(subject.fixtures_digest, SHA256, 'subject_fixtures_digest_invalid');

  const target = subject.release_target;
  if (target === null || typeof target !== 'object' || Array.isArray(target)) {
    throw new SubjectDenied('subject_release_target_not_object');
  }
  checkKeys(target, ['finish', 'previous_live_digest', 'release_channel', 'target_id'],
    'subject_release_target_unexpected_field');
  if (!FINISH.has(target.finish)) throw new SubjectDenied('subject_release_finish_invalid');
  for (const field of ['target_id', 'release_channel', 'previous_live_digest']) {
    checkNullableId(target[field], `subject_release_${field}_invalid`);
  }
  return subject;
}

// Сборка манифеста из доверенных, закреплённых контроллером значений.
export function buildSubject({
  kind, repoId, baseSha = null, candidateSha = null, treeSha = null, mergeResultSha = null,
  artifacts = [], specDigest, policyDigest, fixturesDigest = null,
  releaseTarget = { finish: 'verified' },
}) {
  const subject = {
    schema: 'candidate-subject.v1',
    kind,
    source: {
      repo_id: repoId,
      base_sha: baseSha,
      candidate_sha: candidateSha,
      tree_sha: treeSha,
      merge_result_sha: mergeResultSha,
    },
    artifacts: artifacts.map(artifact => ({ ...artifact })),
    spec_digest: specDigest,
    policy_digest: policyDigest,
    fixtures_digest: fixturesDigest,
    release_target: {
      finish: releaseTarget.finish,
      target_id: releaseTarget.targetId ?? null,
      release_channel: releaseTarget.releaseChannel ?? null,
      previous_live_digest: releaseTarget.previousLiveDigest ?? null,
    },
  };
  return validateSubject(subject);
}

// subject_digest = sha256(canonical_json(CandidateSubject)).
export function subjectDigest(subject) {
  return canonicalDigest(validateSubject(subject));
}
