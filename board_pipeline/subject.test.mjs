import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { buildSubject, canonicalDigest, canonicalJson, subjectDigest, validateSubject } from './subject.mjs';

const BASE = '0'.repeat(40);
const CAND = 'a'.repeat(40);
const TREE = 'b'.repeat(40);
const SPEC = 'c'.repeat(64);
const POLICY = 'd'.repeat(64);
const FIXTURES = 'e'.repeat(64);

function subject(over = {}) {
  return buildSubject({
    kind: 'git_tree',
    repoId: 'darkfactory-vs1-fixture',
    baseSha: BASE,
    candidateSha: CAND,
    treeSha: TREE,
    specDigest: SPEC,
    policyDigest: POLICY,
    fixturesDigest: null,
    releaseTarget: { finish: 'verified' },
    ...over,
  });
}

function bundleSubject(over = {}) {
  return subject({
    kind: 'artifact_bundle',
    baseSha: null,
    candidateSha: null,
    treeSha: null,
    artifacts: [{ role: 'primary', sha256: 'f'.repeat(64), bytes: 12 }],
    ...over,
  });
}

test('canonical JSON sorts keys recursively and arrays keep their order', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: 2, c: [3, 1] } }), '{"a":{"c":[3,1],"d":2},"b":1}');
  assert.equal(canonicalJson([]), '[]');
  assert.equal(canonicalJson(null), 'null');
  assert.throws(() => canonicalJson({ a: undefined }), /subject_not_json/);
  assert.throws(() => canonicalJson(NaN), /subject_not_json/);
  assert.throws(() => canonicalJson(() => 1), /subject_not_json/);
});

test('subject_digest does not depend on key insertion order', () => {
  const first = subject();
  const second = validateSubject({
    release_target: { finish: 'verified', target_id: null, release_channel: null, previous_live_digest: null },
    fixtures_digest: null,
    policy_digest: POLICY,
    spec_digest: SPEC,
    artifacts: [],
    source: { repo_id: 'darkfactory-vs1-fixture', base_sha: BASE, candidate_sha: CAND, tree_sha: TREE,
      merge_result_sha: null },
    kind: 'git_tree',
    schema: 'candidate-subject.v1',
  });
  assert.equal(subjectDigest(first), subjectDigest(second));
  const expected = createHash('sha256')
    .update(canonicalJson(JSON.parse(JSON.stringify(first)))).digest('hex');
  assert.equal(subjectDigest(first), expected);
  assert.equal(canonicalDigest(first), subjectDigest(first));
});

test('changing any manifest field invalidates the digest', () => {
  const base = subjectDigest(subject());
  const mutations = [
    s => { s.spec_digest = '1'.repeat(64); },
    s => { s.policy_digest = '2'.repeat(64); },
    s => { s.fixtures_digest = FIXTURES; },
    s => { s.source.tree_sha = '3'.repeat(40); },
    s => { s.source.base_sha = '4'.repeat(40); },
    s => { s.source.candidate_sha = '5'.repeat(40); },
    s => { s.source.repo_id = 'other-repo'; },
    s => { s.source.merge_result_sha = '6'.repeat(40); },
    s => { s.artifacts.push({ role: 'ui_screenshot', sha256: '7'.repeat(64), bytes: 1 }); },
    s => { s.release_target.finish = 'deployed'; },
    s => { s.release_target.target_id = 'staging'; },
    s => { s.release_target.release_channel = 'beta'; },
    s => { s.release_target.previous_live_digest = '8'.repeat(64); },
    s => { s.kind = 'hybrid'; s.artifacts.push({ role: 'bundle', sha256: '9'.repeat(64), bytes: 0 }); },
  ];
  for (const mutate of mutations) {
    const changed = subject();
    mutate(changed);
    assert.notEqual(subjectDigest(changed), base, `digest must change: ${JSON.stringify(changed)}`);
  }
});

test('validation accepts the documented kinds and rejects malformed manifests', () => {
  assert.equal(validateSubject(subject()).schema, 'candidate-subject.v1');
  assert.equal(validateSubject(bundleSubject()).kind, 'artifact_bundle');
  const rejects = [
    [s => { s.schema = 'candidate-subject.v2'; }, /subject_schema_unknown/],
    [s => { s.kind = 'tarball'; }, /subject_kind_unknown/],
    [s => { s.extra = 1; }, /subject_unexpected_field/],
    [s => { s.source.repo_id = '-bad'; }, /subject_repo_id_invalid/],
    [s => { s.source.base_sha = 'zz'; }, /subject_base_sha_invalid/],
    [s => { s.source.candidate_sha = null; }, /subject_candidate_sha_invalid/],
    [s => { s.source.tree_sha = CAND.slice(1); }, /subject_tree_sha_invalid/],
    [s => { s.source.merge_result_sha = 'nope'; }, /subject_merge_result_sha_invalid/],
    [s => { s.spec_digest = POLICY.slice(1); }, /subject_spec_digest_invalid/],
    [s => { s.policy_digest = null; }, /subject_policy_digest_invalid/],
    [s => { s.fixtures_digest = 'qq'; }, /subject_fixtures_digest_invalid/],
    [s => { s.artifacts = null; }, /subject_artifacts_not_array/],
    [s => { s.artifacts = [{ role: 'primary', sha256: 'zz', bytes: 0 }]; }, /subject_artifact_sha256_invalid/],
    [s => { s.release_target.finish = 'shipped'; }, /subject_release_finish_invalid/],
    [s => { s.release_target.extra = 1; }, /subject_release_target_unexpected_field/],
    [s => { s.release_target.target_id = ''; }, /subject_release_target_id_invalid/],
  ];
  for (const [mutate, expected] of rejects) {
    const changed = subject();
    mutate(changed);
    assert.throws(() => validateSubject(changed), expected);
  }
  assert.throws(() => validateSubject(null), /subject_not_object/);
  assert.throws(() => validateSubject([]), /subject_not_object/);
});

test('artifact_bundle requires artifacts and forbids git source shas', () => {
  assert.throws(() => bundleSubject({ artifacts: [] }), /subject_artifacts_empty/);
  assert.throws(() => bundleSubject({ baseSha: BASE }), /subject_base_sha_invalid/);
  assert.throws(() => bundleSubject({ artifacts: [{ role: 'poster', sha256: 'f'.repeat(64), bytes: 0 }] }),
    /subject_artifact_role_unknown/);
  assert.throws(() => bundleSubject({ artifacts: [{ role: 'primary', sha256: 'f'.repeat(64), bytes: -1 }] }),
    /subject_artifact_bytes_invalid/);
});

test('buildSubject defaults nullable fields and validates the result', () => {
  const minimal = buildSubject({ kind: 'git_tree', repoId: 'repo', baseSha: BASE, candidateSha: CAND,
    treeSha: TREE, specDigest: SPEC, policyDigest: POLICY });
  assert.deepEqual(minimal.artifacts, []);
  assert.equal(minimal.fixtures_digest, null);
  assert.deepEqual(minimal.release_target, { finish: 'verified', target_id: null, release_channel: null,
    previous_live_digest: null });
  assert.match(subjectDigest(minimal), /^[0-9a-f]{64}$/);
  assert.throws(() => buildSubject({ kind: 'git_tree', repoId: 'repo', candidateSha: CAND, treeSha: TREE,
    specDigest: SPEC, policyDigest: POLICY }), /subject_base_sha_invalid/);
});

test('canonical JSON и валидация не доверяют пользовательским map/iterators', () => {
  // Подменённый map не влияет на обход: канонизация читает реальные элементы.
  const hostile = [1, 2, 3];
  hostile.map = () => [9, 9, 9];
  assert.equal(canonicalJson(hostile), '[1,2,3]');
  assert.equal(canonicalDigest(hostile), canonicalDigest([1, 2, 3]));

  // Подменённый iterator не уводит валидацию с реального списка артефактов.
  const artifacts = [{ role: 'primary', sha256: 'f'.repeat(64), bytes: 7 }];
  const fake = { role: 'poster', sha256: '0', bytes: -1 };
  Object.defineProperty(artifacts, Symbol.iterator, { value: function* () { yield fake; } });
  const withHostile = validateSubject(subject({ artifacts }));
  assert.deepEqual(withHostile.artifacts, [{ role: 'primary', sha256: 'f'.repeat(64), bytes: 7 }]);
  assert.equal(subjectDigest(withHostile),
    subjectDigest(subject({ artifacts: [{ role: 'primary', sha256: 'f'.repeat(64), bytes: 7 }] })));
});

test('sparse-массивы отклоняются канонизацией и валидацией артефактов', () => {
  assert.throws(() => canonicalJson(Array(1)), /subject_sparse_array/);
  assert.throws(() => canonicalJson([1, , 3]), /subject_sparse_array/);
  assert.throws(() => validateSubject(subject({ artifacts: Array(1) })), /subject_sparse_array/);
  assert.throws(() => validateSubject(subject({ artifacts: [null, null] })), /subject_artifact_not_object/);
});

test('артефакты-не-массивы отклоняются как ошибка типа', () => {
  assert.throws(() => buildSubject({ kind: 'git_tree', repoId: 'repo', baseSha: BASE, candidateSha: CAND,
    treeSha: TREE, specDigest: SPEC, policyDigest: POLICY, artifacts: {} }), /subject_artifacts_not_array/);
  assert.throws(() => buildSubject({ kind: 'artifact_bundle', repoId: 'repo',
    specDigest: SPEC, policyDigest: POLICY, artifacts: 'primary' }), /subject_artifacts_not_array/);
  assert.throws(() => validateSubject(subject({ artifacts: {} })), /subject_artifacts_not_array/);
});
