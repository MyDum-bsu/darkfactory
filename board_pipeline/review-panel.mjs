// L2 panel policy belongs to the operator profile, never to card labels or
// model output. Every seat uses the existing isolated, transcript-attested port.
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzeBlastRadius, CORE_SENSITIVE_PATHS } from './blast-radius.mjs';
import { unpackExact } from './runtime.mjs';
import { isolatedNeonReviewRunner } from './neon-review.mjs';
import { applySeverityGating, deferReviewSidecar, isNeonReview, NEON_CRITIC, NEON_ISOLATION,
  normalizeSeverity, OPUS_ARBITER, partitionFindingsBySeverity, reviewPanelPolicy, SOL_ARBITER } from './review-policy.mjs';
import { executorFamily, hasValidFinding, isolatedArbiterRunner, isolatedPiReviewRunner, l2CriticSpec,
  ReviewDenied, reviewDiffStats } from './review-runner.mjs';
import { canonicalJson } from './subject.mjs';
import { sumUsages } from './telemetry.mjs';
import { assertTriadIndependent, hasDodViolation, maxHarmOf, resolveArbitration } from './worker-selector.mjs';

const sha = /^[a-f0-9]{40}$/;
const digest = /^[a-f0-9]{64}$/;
const deny = reason => { throw new ReviewDenied(reason); };
const panelCore = new Set(['board_pipeline/run-isolated.mjs', 'board_pipeline/daemon.mjs',
  'board_pipeline/config-compiler.mjs', 'board_pipeline/review-policy.mjs', 'board_pipeline/review-panel.mjs']);
function sensitivePath(path) {
  if (CORE_SENSITIVE_PATHS.has(path) || panelCore.has(path)) return true;
  const words = path.replace(/([a-z\d])([A-Z])/g, '$1-$2').replace(/([A-Z])([A-Z][a-z])/g, '$1-$2');
  return /(?:^|[/_.-])(?:controller|security|oauth2?|auth(?:entication|orization|n|z)?|rls|dsp)(?:[/_.-]|$)/i.test(words);
}
const extraSeats = [OPUS_ARBITER, SOL_ARBITER,
  { provider: 'opencode-go', model: 'deepseek-v4.1-flash', reasoningLevel: 'high' }];

function needsPanel(risk) {
  const report = risk?.blastRadius;
  if (!Number.isSafeInteger(risk?.changedLines) || risk.changedLines < 0 ||
      !['low', 'medium', 'high'].includes(report?.riskLevel) || !Array.isArray(report.changedPaths)) {
    deny('review_panel_risk_missing');
  }
  return risk.changedLines > 300 || risk.binary || report.truncated || report.riskLevel === 'high' ||
    report.changedPaths.some(sensitivePath);
}

// size is the width when expanded. Primary and arbiter pins are never rerouted
// to fit a width; an unsatisfiable policy is a denial, not a smaller panel.
export function planReviewPanel({ executor, primary = NEON_CRITIC, arbiter = SOL_ARBITER, policy = {}, risk }) {
  const { mode, size } = reviewPanelPolicy(policy);
  if (!executor || !arbiter) deny('review_panel_triad_missing');
  const seats = [l2CriticSpec(primary)];
  const families = assertTriadIndependent({ executor, critic: seats[0], arbiter }, { reportSidekick: true });
  if (mode === 'single' || (mode === 'dynamic' && !needsPanel(risk))) return seats;
  const used = new Set(Object.values(families));
  for (const critic of extraSeats) {
    if (used.has(executorFamily(critic))) continue;
    const family = assertTriadIndependent({ executor, critic, arbiter }).critic;
    used.add(family);
    seats.push({ ...critic });
    if (seats.length === size) return seats;
  }
  deny('review_panel_insufficient_families');
}

// Fixed 1-based five-line buckets (1..5, 6..10, ...), not transitive
// proximity clusters. Unlocated findings only coalesce when identical.
export function deduplicateFindings(findings) {
  const best = new Map();
  const order = ['P0', 'P1', 'P2', 'nit'];
  for (const f of findings) {
    const text = canonicalJson(f);
    const line = typeof f.line === 'string' && /^\d+$/.test(f.line) ? Number(f.line) : f.line;
    const file = typeof f.file === 'string' && f.file.replace(/^\/candidate\//, '').replace(/^(?:\.\/)+/, '');
    const key = file && Number.isSafeInteger(line) && line > 0
      ? JSON.stringify([file, Math.floor((line - 1) / 5)]) : text;
    // Keep evidenced objections ahead of vague reports of the same severity.
    const rank = order.indexOf(normalizeSeverity(f.severity)) * 2 + Number(!hasValidFinding([f]));
    const prev = best.get(key);
    const winner = !prev || rank < prev.rank || (rank === prev.rank && text < prev.text) ? { f, rank, text } : prev;
    best.set(key, { ...winner, harm: Math.max(prev?.harm ?? 0, maxHarmOf([f])), dod: prev?.dod || hasDodViolation([f]) });
  }
  return [...best.keys()].sort().map(k => {
    const { f, harm, dod } = best.get(k);
    // A stronger location match must not erase an owner-only harm/DoD gate
    // from the evidence forwarded to a later rework round.
    if (harm <= maxHarmOf([f]) && (!dod || hasDodViolation([f]))) return f;
    return { ...f, harm, ...(dod && { dod_violation: true }) };
  });
}

const verdicts = { PASS: 'REVIEW_OK', REWORK: 'REVIEW_BLOCKED', ESCALATE: 'REVIEW_ESCALATE' };
function checkReceipt(receipt, binding, seat) {
  if (receipt?.sha !== binding.candidate_sha || receipt.task !== binding.task_id ||
      receipt.subject_digest !== binding.subject_digest || !sha.test(receipt.tree_sha)) deny('review_panel_subject_mismatch');
  if (['model', 'provider', 'reasoningLevel'].some(k => receipt.actual?.[k] !== seat[k])) deny('review_model_mismatch');
  if (receipt.isolation !== (isNeonReview(seat) ? NEON_ISOLATION : 'docker-ro-v1') ||
      !digest.test(receipt.transcript_sha256) || !/^[a-f0-9]{8,64}$/.test(receipt.checkpoint ?? '') ||
      !/^[A-Za-z0-9_.-]{1,200}$/.test(receipt.transcript_file ?? '') || !Object.hasOwn(verdicts, receipt.status) ||
      receipt.verdict !== verdicts[receipt.status] || !Array.isArray(receipt.findings)) deny('review_panel_receipt_invalid');
}

async function measureRisk(binding) {
  const { changedLines, changedPaths, binary } = await reviewDiffStats(binding);
  // Analyze imports at the reviewed revision, not an untracked file, newer
  // checkout or symlink in the live worker directory.
  const scratch = await mkdtemp(join(tmpdir(), 'board-panel-risk-'));
  try {
    const repoRoot = join(scratch, 'tree');
    await mkdir(repoRoot);
    await unpackExact(binding.worktree, binding.candidate_sha, join(scratch, 'tree.tar'), repoRoot);
    return { changedLines, binary, blastRadius: analyzeBlastRadius({ repoRoot, changedPaths }) };
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

export function isolatedReviewPanelRunner({ makePrimary, makePi = isolatedPiReviewRunner,
  makeArbiter = isolatedArbiterRunner, ...options } = {}) {
  return async (input, profile = {}) => {
    const binding = Object.freeze({ ...input });
    if (!sha.test(binding.candidate_sha) || !sha.test(binding.base_sha)) deny('review_requires_full_sha');
    if (!digest.test(binding.subject_digest)) deny('review_subject_missing');
    const executor = binding.executor ?? profile.executor;
    const arbiter = profile.arbiter === undefined ? SOL_ARBITER : profile.arbiter;
    const policy = reviewPanelPolicy(profile.reviewPanel);
    options.signal?.throwIfAborted();
    const risk = policy.mode === 'dynamic' ? await measureRisk(binding) : undefined;
    const seats = planReviewPanel({ policy, risk, primary: profile.review, executor, arbiter });
    const stop = new AbortController();
    const signal = options.signal ? AbortSignal.any([stop.signal, options.signal]) : stop.signal;
    signal.throwIfAborted();
    const results = await Promise.allSettled(seats.map(async (seat, i) => {
      const make = (i === 0 && makePrimary) || (isNeonReview(seat) ? isolatedNeonReviewRunner : makePi);
      const beforeEffect = async () => {
        signal.throwIfAborted();
        await options.beforeEffect?.();
        signal.throwIfAborted();
      };
      const receipt = await deferReviewSidecar(() => make({ ...options, signal, beforeEffect })(binding, { ...profile, review: seat }));
      checkReceipt(receipt, binding, seat);
      const gated = await applySeverityGating(receipt);
      if (gated.findings.some(f => f.severity === 'P0' && hasValidFinding([f]))) {
        // The decision is final. Stop every unfinished model call (including
        // the primary) immediately and drain sandbox teardown before handoff.
        stop.abort(new ReviewDenied('review_panel_p0'));
      }
      return gated;
    }));
    options.signal?.throwIfAborted();
    const reviews = results.filter(r => r.status === 'fulfilled').map(r => r.value);
    const all = reviews.flatMap(r => r.findings);
    const { blocking, nonBlocking } = partitionFindingsBySeverity(all);
    const p0 = blocking.some(f => f.severity === 'P0');
    const failed = results.find(r => r.status === 'rejected');
    if (failed && !stop.signal.aborted) {
      // Never retry a whole panel and erase an already emitted objection.
      if (seats.length === 1) throw failed.reason;
      throw new ReviewDenied(`review_panel_incomplete:${failed.reason?.message}`, { cause: failed.reason });
    }
    // Normally this is the pinned primary. If a secondary proved P0 first,
    // retain its genuine receipt rather than attributing it to an aborted seat.
    const anchor = results[0].status === 'fulfilled' ? results[0].value : reviews.find(r =>
      r.findings.some(f => f.severity === 'P0' && hasValidFinding([f])));
    if (reviews.some(r => r.tree_sha !== anchor.tree_sha)) deny('review_panel_subject_mismatch');
    const soft = deduplicateFindings([...nonBlocking, ...reviews.flatMap(r => r.sidecar_findings ?? [])]);
    await applySeverityGating({ status: 'PASS', findings: soft }, { journal: options.journal,
      taskId: binding.task_id, candidateSha: binding.candidate_sha, round: binding.review_round ?? 1 });
    const findings = deduplicateFindings(blocking);
    const objections = reviews.filter(r => r.status === 'REWORK');
    let status = p0 ? 'REWORK' : reviews.some(r => r.status === 'ESCALATE') ? 'ESCALATE'
      : objections.length ? 'REWORK' : 'PASS';
    let arbitration;
    if (!p0 && status === 'REWORK' && reviews.some(r => r.status === 'PASS') &&
        objections.every(r => hasValidFinding(r.findings.filter(f => normalizeSeverity(f.severity) === 'P1')))) {
      const evidence = { sha: binding.candidate_sha, votes: reviews.map(r => ({
        actual: r.actual, status: r.status, summary: r.summary, findings: r.findings,
        transcript_sha256: r.transcript_sha256 })), findings };
      arbitration = await resolveArbitration({ attempt: { ...binding, executor }, critic: seats[0], arbiter,
        subjectDigest: binding.subject_digest, maxHarm: maxHarmOf(blocking), dodViolation: hasDodViolation(blocking),
        trigger: { kind: 'panel_p1_conflict', trigger: 'panel_disagreement', evidence },
        arbitrate: makeArbiter(options) });
      options.signal?.throwIfAborted();
      status = arbitration.decision === 'accept_with_notes' ? 'PASS'
        : arbitration.decision === 'directed_rework' ? 'REWORK' : 'ESCALATE';
    }
    return { ...anchor, status, verdict: verdicts[status], findings: status === 'PASS' ? [] : findings,
      summary: arbitration?.notes ?? arbitration?.directive ?? arbitration?.question ?? arbitration?.reason ??
        reviews.find(r => r.status === status)?.summary ?? anchor.summary,
      excerpt: status === 'PASS' ? undefined : arbitration?.directive ?? objections.find(r => r.excerpt)?.excerpt,
      severity_gated: reviews.some(r => r.severity_gated), sidecar_findings: soft,
      usage: sumUsages(reviews.map(r => r.usage)),
      panel: { mode: policy.mode, seats, reviews, ...(arbitration && { arbitration }) } };
  };
}
