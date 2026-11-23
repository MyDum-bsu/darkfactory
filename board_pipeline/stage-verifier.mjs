const HEX = /^[a-f0-9]{64}$/;
const count = value => Number.isSafeInteger(value) && value >= 0;
const positive = value => count(value) && value > 0;
const digest = value => typeof value === 'string' && HEX.test(value);

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
});

export const isStageVerifier = value => typeof value === 'string' && Object.hasOwn(CHECKS, value);

export function artifactVerdict(verifier, bytes) {
  if (!isStageVerifier(verifier) || !Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 8192) {
    throw new Error('stage_artifact_invalid');
  }
  let artifact;
  try { artifact = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch (cause) { throw new Error('stage_artifact_invalid', { cause }); }
  const [fields, passes] = CHECKS[verifier];
  if (!artifact || artifact.type !== verifier || Object.keys(artifact).length !== Object.keys(fields).length + 1 ||
      !Object.entries(fields).every(([key, check]) => Object.hasOwn(artifact, key) && check(artifact[key]))) {
    throw new Error('stage_artifact_invalid');
  }
  return passes(artifact) ? 'PASS' : 'REWORK';
}
