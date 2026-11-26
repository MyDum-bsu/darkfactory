import { parseDocument, visit } from 'yaml';

const HEX = /^[a-f0-9]{64}$/;
const COUNT_LITERAL = /^(?:0|[1-9][0-9]{0,15})$/;
const MAX_COUNT = BigInt(Number.MAX_SAFE_INTEGER);
const count = value => Number.isSafeInteger(value) && value >= 0;
const positive = value => count(value) && value > 0;
const digest = value => typeof value === 'string' && HEX.test(value);
const sha40 = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);

export const STAGE_VERDICT_INSTRUCTION =
  'Output ONLY the single plain-text line containing exactly two space-separated tokens: ' +
  'the exact 64-character lowercase hexadecimal value from the Challenge: line above, one space, ' +
  'then PASS, REWORK, or BLOCKED. Use no markdown backticks, no bold, no punctuation, no labels, ' +
  'no quotes, no angle brackets, no prefixes, and no other text; do not include the word challenge.';

// These are contracts for observations made by trusted adapters, not commands
// or a substitute for L1/L2/L3. For example, a Lean adapter must run the check.
const CHECKS = Object.freeze({
  inventory: [{ inventory: digest, items: positive, unresolved: count }, a => a.unresolved === 0],
  'change-set': [{ diff: digest, changed: positive, failedChecks: count }, a => a.failedChecks === 0],
  'visual-report': [{ capture: digest, width: positive, height: positive, consoleErrors: count,
    a11yViolations: count }, a => a.consoleErrors === 0 && a.a11yViolations === 0],
  conjecture: [{ statement: digest, assumptions: digest, bounded: b => typeof b === 'boolean' }, a => a.bounded],
  falsification: [{ trace: digest, cases: positive, counterexamples: count }, a => a.counterexamples === 0],
  'lean-proof': [{ diagnostics: digest, exitCode: count, holes: count }, a => a.exitCode === 0 && a.holes === 0],
  'source-review': [{ sources: digest, checked: positive, unsupported: count }, a => a.unsupported === 0],
  experiment: [{ metrics: digest, frames: positive, violations: count }, a => a.violations === 0],
  'frozen-pipeline': [{ recipe: digest, artifact: digest, replay: digest }, a => a.artifact === a.replay],
  'blind-panel': [{ protocol: digest, candidates: positive, votes: positive, anonymous: b => typeof b === 'boolean' },
    a => a.candidates >= 2 && a.anonymous],
  'course-outline': [{ outline: digest, lessons: positive, uncoveredGoals: count }, a => a.uncoveredGoals === 0],
  'technical-copy': [{ document: digest, sections: positive, unsupportedClaims: count }, a => a.unsupportedClaims === 0],
  'rubric-review': [{ rubric: digest, criteria: positive, blockers: count }, a => a.blockers === 0],
  'test-first': [{ redSha: sha40, testDiff: digest, redExitCode: count, failureReasonDigest: digest,
    touchesProdCode: b => typeof b === 'boolean',
    candidateExitCode: v => v === null || count(v) },
    a => a.redExitCode !== 0 && a.redExitCode < 125 && a.touchesProdCode === false &&
      a.candidateExitCode === 0],
  'semantic-fidelity': [{ specDigest: digest, goalsFrozen: b => typeof b === 'boolean',
    vacuousRisk: count, unprovenAssumptions: count, controlsPassed: positive },
    a => a.goalsFrozen === true && a.vacuousRisk === 0 && a.unprovenAssumptions === 0],
  'satisfaction-report': [{ capture: digest, viewports: positive, consoleErrors: count,
    a11yViolations: count, unstyledControls: count, uncollapsedLongLists: count, missingStates: count,
    holdoutFailures: count, satisfactionScore: count },
    a => a.viewports >= 2 && a.consoleErrors === 0 && a.a11yViolations === 0 && a.unstyledControls === 0 &&
      a.uncollapsedLongLists === 0 && a.missingStates === 0 && a.holdoutFailures === 0 &&
      a.satisfactionScore >= 85 && a.satisfactionScore <= 100],
  'guide-pack': [{ guideDigest: digest, packDigest: digest, guidesChecked: positive,
    missingSections: count, brokenLinks: count },
    a => a.missingSections === 0 && a.brokenLinks === 0],
});

export const isStageVerifier = value => typeof value === 'string' && Object.hasOwn(CHECKS, value);

export function artifactVerdict(verifier, bytes) {
  if (!isStageVerifier(verifier) || !Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 8192) {
    throw new Error('stage_artifact_invalid');
  }
  let artifact;
  try {
    const json = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    // Validate duplicate keys and original numeric lexemes before consuming
    // the JSON values: IEEE-754 would round a tiny nonzero counter to zero.
    const doc = parseDocument(json, { schema: 'json', uniqueKeys: true, merge: false });
    if (doc.errors.length || doc.warnings.length) throw new Error('ambiguous JSON');
    visit(doc, { Scalar(_key, node) {
      if (typeof node.value === 'number' &&
          (!COUNT_LITERAL.test(node.source ?? '') || BigInt(node.source) > MAX_COUNT)) {
        throw new Error('noncanonical counter');
      }
    } });
    artifact = JSON.parse(json);
  } catch (cause) { throw new Error('stage_artifact_invalid', { cause }); }
  const [fields, passes] = CHECKS[verifier];
  if (!artifact || artifact.type !== verifier || Object.keys(artifact).length !== Object.keys(fields).length + 1 ||
      !Object.entries(fields).every(([key, check]) => Object.hasOwn(artifact, key) && check(artifact[key]))) {
    throw new Error('stage_artifact_invalid');
  }
  return passes(artifact) ? 'PASS' : 'REWORK';
}
