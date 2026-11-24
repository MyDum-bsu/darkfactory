import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  applySeverityGating,
  buildReviewInstruction,
  detectStalledReview,
  evaluateAutoApprove,
  findingSignatureSha,
  loadApprovalPolicy,
  normalizeSeverity,
  partitionFindingsBySeverity,
} from './review-policy.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const SHA = 'a'.repeat(40);
const f = (severity, extra = {}) => ({ file: 'a.js', line: 3, expected: 'e', actual: 'x', severity, ...extra });

test('severity: normalize and partition', () => {
  assert.equal(normalizeSeverity('P0'), 'P0');
  assert.equal(normalizeSeverity('nit'), 'nit');
  assert.equal(normalizeSeverity(undefined), 'P1'); // legacy — fail-closed blocking
  assert.equal(normalizeSeverity('weird'), 'P1');
  const { blocking, nonBlocking } = partitionFindingsBySeverity(
    [f('P0'), f('P1'), f('P2'), f('nit'), f(undefined)]);
  assert.equal(blocking.length, 3);
  assert.equal(nonBlocking.length, 2);
});

test('severity gating: P2/nit only can never give REVIEW_BLOCKED', async t => {
  const journal = await mkdtemp(join(tmpdir(), 'df-sidecar-'));
  t.after(() => rm(journal, { recursive: true, force: true }));
  const verdict = { status: 'REWORK', verdict: 'REVIEW_BLOCKED',
    findings: [f('P2'), f('nit')], excerpt: 'nits', summary: 's' };
  const gated = await applySeverityGating(verdict,
    { journal, taskId: '7', candidateSha: SHA, round: 1 });
  assert.equal(gated.status, 'PASS');
  assert.equal(gated.verdict, 'REVIEW_OK');
  assert.equal(gated.severity_gated, true);
  assert.deepEqual(gated.findings, []);
  assert.equal(gated.sidecar_findings.length, 2);
  // sidecar-файл записан append-only JSONL 0600
  const sidecar = join(journal, `review-sidecar-7-${SHA}.jsonl`);
  const lines = (await readFile(sidecar, 'utf8')).trim().split('\n');
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).findings.length, 2);
});

test('severity gating: P0/P1 блокируют; смешанный P1+nit блокирует по P1', async t => {
  const journal = await mkdtemp(join(tmpdir(), 'df-sidecar-'));
  t.after(() => rm(journal, { recursive: true, force: true }));
  const verdict = { status: 'REWORK', verdict: 'REVIEW_BLOCKED',
    findings: [f('P1'), f('nit')], excerpt: 'blocking', summary: 's' };
  const gated = await applySeverityGating(verdict,
    { journal, taskId: '8', candidateSha: SHA, round: 2 });
  assert.equal(gated.status, 'REWORK');
  assert.equal(gated.verdict, 'REVIEW_BLOCKED');
  assert.deepEqual(gated.findings.map(x => x.severity), ['P1']);
  assert.deepEqual(gated.sidecar_findings.map(x => x.severity), ['nit']);
  const lines = (await readFile(join(journal, `review-sidecar-8-${SHA}.jsonl`), 'utf8')).trim().split('\n');
  assert.equal(JSON.parse(lines[0]).round, 2);
  // P0-only — sidecar не нужен, исход неизменен.
  const p0 = await applySeverityGating({ status: 'REWORK', verdict: 'REVIEW_BLOCKED',
    findings: [f('P0')], excerpt: 'x' }, { journal, taskId: '9', candidateSha: SHA, round: 1 });
  assert.equal(p0.status, 'REWORK');
  assert.equal(p0.severity_gated, undefined);
});

test('diff-scoped round 2+ instruction', () => {
  const binding = { task_id: '3', candidate_sha: SHA, subject_digest: 'c'.repeat(64) };
  const r1 = buildReviewInstruction({ binding, diffLine: 'diff mounted', subjectLine: 'subj',
    prompt: 'SPEC', round: 1 });
  assert.match(r1, /read-only review/);
  assert.match(r1, /severity/);
  const r2 = buildReviewInstruction({ binding, diffLine: 'diff mounted', subjectLine: 'subj',
    prompt: 'SPEC', round: 2, priorBlockingFindings: [f('P1', { file: 'b.js', line: 9 })] });
  assert.match(r2, /re-review round 2/);
  assert.match(r2, /b\.js:9/);
  assert.match(r2, /no NEW P0\/P1/);
  assert.match(r2, /never issue REVIEW_BLOCKED for P2\/nit/);
  assert.doesNotMatch(r2, /Review against the spec below\./);
  // round 0/undefined → полный раунд-1 промпт
  assert.match(buildReviewInstruction({ binding, diffLine: 'd', subjectLine: '', prompt: '' }),
    /read-only review/);
});

test('stalled review: repeated signature on rounds 2 and 3 → early arbiter', () => {
  const findings = [f('P1'), f('P0', { file: 'z.js' })];
  const l2 = extra => ({ gate: 'l2', findings, ...extra });
  assert.equal(findingSignatureSha(findings), findingSignatureSha([...findings].reverse()));
  assert.notEqual(findingSignatureSha(findings), findingSignatureSha([f('P1')]));
  // Подряд на раунде 2
  let d = detectStalledReview({ roundsHistory: [l2(), l2()] });
  assert.equal(d.stalled, true);
  assert.equal(d.trigger, 'no_progress');
  assert.equal(d.kind, 'stalled_findings_signature');
  assert.equal(d.round, 2);
  // Не подряд: раунд 1 и 3, раунд 2 с другими находками
  d = detectStalledReview({ roundsHistory: [l2(), l2({ findings: [f('P1', { file: 'other.js' })] }), l2()] });
  assert.equal(d.stalled, true);
  assert.equal(d.round, 3);
  // Совпадение по явному signature-полю
  d = detectStalledReview({ roundsHistory: [
    { gate: 'l2', findings: [f('P1')], signature: 'sig-x' },
    { gate: 'l2', findings: [f('P1', { file: 'other.js' })], signature: 'sig-x' }] });
  assert.equal(d.stalled, true);
  // Другие находки — прогресс, арбитр не нужен
  d = detectStalledReview({ roundsHistory: [l2(), l2({ findings: [f('P1', { file: 'other.js' })] })] });
  assert.equal(d.stalled, false);
  // Раунд 4 — уже лимит, детектор стагнации не срабатывает
  d = detectStalledReview({ roundsHistory: [l2(), l2(), l2(), l2()] });
  assert.equal(d.stalled, false);
  assert.equal(d.round, 4);
  // Пустые findings — не стагнация по сигнатуре
  d = detectStalledReview({ roundsHistory: [
    { gate: 'l2', findings: [] }, { gate: 'l2', findings: [] }] });
  assert.equal(d.stalled, false);
});

test('auto-approve: allowlist, denials, tamper/L1 gates', async t => {
  const { policy, digest } = await loadApprovalPolicy(root);
  assert.match(digest, /^[a-f0-9]{64}$/);
  const base = { policy, digest, category: 'docs', changedFiles: ['docs/a/b.md'],
    changedLines: 10, l1Passed: true, tamperPassed: true };
  assert.deepEqual(evaluateAutoApprove(base),
    { approved: true, reason: 'policy_auto_approved', policyDigest: digest });
  // Порядок fail-closed проверок
  assert.equal(evaluateAutoApprove({ ...base, l1Passed: false }).reason, 'auto_approve_requires_green_l1');
  assert.equal(evaluateAutoApprove({ ...base, l1Passed: 'yes' }).reason, 'auto_approve_requires_green_l1');
  assert.equal(evaluateAutoApprove({ ...base, tamperPassed: false }).reason, 'auto_approve_requires_clean_tamper');
  assert.equal(evaluateAutoApprove({ ...base, policy: { autoApprove: { ...policy.autoApprove, enabled: false } } })
    .reason, 'auto_approve_disabled');
  assert.equal(evaluateAutoApprove({ ...base, category: 'feature' }).reason, 'auto_approve_category_denied');
  assert.equal(evaluateAutoApprove({ ...base, category: 'typo', changedFiles: ['README.md'] }).approved, true);
  assert.equal(evaluateAutoApprove({ ...base, category: 'deps', changedFiles: ['package-lock.json'] }).approved, true);
  assert.equal(evaluateAutoApprove({ ...base, changedFiles: [] }).reason, 'auto_approve_file_limit_exceeded');
  assert.equal(evaluateAutoApprove({ ...base, changedFiles: Array(11).fill('a.md') }).reason,
    'auto_approve_file_limit_exceeded');
  assert.equal(evaluateAutoApprove({ ...base, changedLines: 401 }).reason, 'auto_approve_line_limit_exceeded');
  assert.equal(evaluateAutoApprove({ ...base, changedLines: -1 }).reason, 'auto_approve_line_limit_exceeded');
  // Пути вне allowlist / в deny / traversal / абсолютные
  for (const file of ['board_pipeline/x.md', 'ops/run.sh', 'src/a.mjs', 'docs/../secret.md',
    '/etc/passwd.md', 'C:\\tmp\\a.md', 'binary.bin']) {
    const r = evaluateAutoApprove({ ...base, changedFiles: [file] });
    assert.equal(r.approved, false, file);
    assert.equal(r.reason, 'auto_approve_path_outside_allowlist', file);
  }
  // 'docs/**/*.md' не пропускает недокумент в docs
  assert.equal(evaluateAutoApprove({ ...base, changedFiles: ['docs/x.txt'] }).approved, false);
});

test('loadApprovalPolicy: symlink and tampering fail-closed', async t => {
  const tree = await mkdtemp(join(tmpdir(), 'df-policy-'));
  t.after(() => rm(tree, { recursive: true, force: true }));
  await cp(join(root, '.darkfactory'), join(tree, '.darkfactory'), { recursive: true });
  const file = join(tree, '.darkfactory', 'approval-policy.yaml');
  const original = await readFile(file, 'utf8');
  // Отключение L1/tamper через YAML — fail-closed.
  for (const text of [
    original.replace('requireGreenL1: true', 'requireGreenL1: false'),
    original.replace('requireCleanTamper: true', 'requireCleanTamper: false'),
    original.replace('enabled: true', 'enabled: [true'),
    original.replace('version: 1', 'version: 2'),
    original + '\nextra: 1\n',
  ]) {
    await writeFile(file, text);
    await assert.rejects(loadApprovalPolicy(tree), /approval_policy_invalid/);
  }
  await writeFile(file, original);
  const outside = join(tree, 'policy.yaml');
  await rename(file, outside);
  await symlink(outside, file);
  await assert.rejects(loadApprovalPolicy(tree), /approval_policy_invalid/);
});

test('severity gating: P2/nit-only ESCALATE нейтрализуется так же, как REWORK', async t => {
  const journal = await mkdtemp(join(tmpdir(), 'df-sidecar-'));
  t.after(() => rm(journal, { recursive: true, force: true }));
  const gated = await applySeverityGating({ status: 'ESCALATE', verdict: 'REVIEW_ESCALATE',
    findings: [f('P2'), f('nit')], summary: 's' },
    { journal, taskId: '12', candidateSha: SHA, round: 1 });
  assert.equal(gated.status, 'PASS');
  assert.equal(gated.verdict, 'REVIEW_OK');
  assert.deepEqual(gated.findings, []);
  assert.equal(gated.severity_gated, true);
  assert.equal(gated.sidecar_findings.length, 2);
  const lines = (await readFile(join(journal, `review-sidecar-12-${SHA}.jsonl`), 'utf8'))
    .trim().split('\n');
  assert.equal(JSON.parse(lines[0]).findings.length, 2);
  // ESCALATE с блокирующей находкой сохраняет исход.
  const blocking = await applySeverityGating({ status: 'ESCALATE', verdict: 'REVIEW_ESCALATE',
    findings: [f('P1'), f('nit')], summary: 's' },
    { journal, taskId: '13', candidateSha: SHA, round: 1 });
  assert.equal(blocking.status, 'ESCALATE');
  assert.equal(blocking.verdict, 'REVIEW_ESCALATE');
});
