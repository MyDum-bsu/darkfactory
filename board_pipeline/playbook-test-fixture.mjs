import { createHash } from 'node:crypto';

const a = 'a'.repeat(64);
const b = 'b'.repeat(64);
const ARTIFACTS = {
  inventory: { inventory: a, items: 2, unresolved: 0 },
  'change-set': { diff: a, changed: 1, failedChecks: 0 },
  'visual-report': { capture: a, width: 1280, height: 720, consoleErrors: 0, a11yViolations: 0 },
  conjecture: { statement: a, assumptions: b, bounded: true },
  falsification: { trace: a, cases: 900, counterexamples: 0 },
  'lean-proof': { diagnostics: a, exitCode: 0, holes: 0 },
  'source-review': { sources: a, checked: 2, unsupported: 0 },
  experiment: { metrics: a, frames: 44100, violations: 0 },
  'frozen-pipeline': { recipe: a, artifact: b, replay: b },
  'blind-panel': { protocol: a, candidates: 2, votes: 4, anonymous: true },
  'course-outline': { outline: a, lessons: 3, uncoveredGoals: 0 },
  'technical-copy': { document: a, sections: 4, unsupportedClaims: 0 },
  'rubric-review': { rubric: a, criteria: 4, blockers: 0 },
};

export const PLAYBOOK_TRIAD = Object.freeze({
  worker: { provider: 'acp-devin', model: 'swe-2-high' },
  critic: { provider: 'openai', model: 'gpt-6.2-sol', reasoningLevel: 'medium' },
  arbiter: { provider: 'google', model: 'gemini-4-neon', reasoningLevel: 'high' },
});

export function stageObservation({ binding, registryDigest, playbook, stage, verifier, model, inputArtifactDigest },
  { verdict = 'PASS', changes } = {}) {
  const artifact = Buffer.from(JSON.stringify({ type: verifier, ...ARTIFACTS[verifier], ...changes }));
  return { binding, registryDigest, playbook, stage, verifier, model, inputArtifactDigest, verdict, artifact,
    artifactDigest: createHash('sha256').update(artifact).digest('hex') };
}
