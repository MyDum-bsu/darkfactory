import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { isRoleRegistry } from './role-registry.mjs';
import { artifactVerdict } from './stage-verifier.mjs';
import { assertTriadIndependent, retiredProviderViolation } from './worker-selector.mjs';

const SUBJECT = ['task_id', 'attempt_id', 'epoch', 'worktree', 'candidate_sha', 'subject_digest', 'playbook', 'registry_digest'];
const SLOTS = ['executor', 'critic', 'arbiter'];
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const matches = (re, value) => typeof value === 'string' && re.test(value);
const same = (expected, received, fields) => received !== null && typeof received === 'object' &&
  fields.every(key => Object.hasOwn(received, key) && received[key] === expected[key]);

function boundSubject(attempt) {
  if (!matches(/^[1-9][0-9]{0,14}$/, attempt?.task_id) || !matches(/^[a-z0-9-]{1,128}$/, attempt.attempt_id) ||
      !Number.isSafeInteger(attempt.epoch) || attempt.epoch < 1 || typeof attempt.worktree !== 'string' ||
      !isAbsolute(attempt.worktree) || !matches(SHA, attempt.candidate_sha) || !matches(DIGEST, attempt.subject_digest) ||
      typeof attempt.playbook !== 'string' || !matches(DIGEST, attempt.registry_digest)) {
    throw new Error('playbook_subject_invalid');
  }
  return Object.freeze(Object.fromEntries(SUBJECT.map(key => [key, attempt[key]])));
}

const slotSpec = (triad, slot) => triad?.[slot === 'executor' ? 'worker' : slot];
const reasoningOf = spec => spec?.reasoningLevel ?? spec?.effort ?? null;

function enrolledModels(selected) {
  const entries = SLOTS.map(slot => {
    const spec = slotSpec(selected, slot);
    const reasoning = reasoningOf(spec);
    if (typeof spec?.provider !== 'string' || !spec.provider || typeof spec.model !== 'string' || !spec.model ||
        (reasoning !== null && !EFFORTS.has(reasoning)) || retiredProviderViolation(spec)) {
      throw new Error('playbook_model_not_enrolled');
    }
    return [slot, Object.freeze({ provider: spec.provider, model: spec.model, reasoning })];
  });
  const models = Object.fromEntries(entries);
  assertTriadIndependent(models);
  return models;
}

async function guard(assertKernel, binding, models) {
  const proof = await assertKernel(binding);
  if (!same(binding, proof, SUBJECT) || proof.held !== true || proof.switchOpen !== true ||
      proof.clean !== true || proof.baseAncestor !== true || !SLOTS.every(slot => {
        const actual = slotSpec(proof.triad, slot);
        return same(models[slot], actual, ['provider', 'model']) && reasoningOf(actual) === models[slot].reasoning;
      })) throw new Error('playbook_kernel_unconfirmed');
}

function inspectReceipt(request, receipt) {
  const { binding, model, verifier } = request;
  if (!same(request, receipt, ['registryDigest', 'playbook', 'stage', 'verifier', 'inputArtifactDigest']) ||
      !same(binding, receipt.binding, SUBJECT) || !same(model, receipt.model, ['provider', 'model', 'reasoning']) ||
      !['PASS', 'REWORK', 'BLOCKED'].includes(receipt.verdict)) throw new Error('playbook_receipt_unbound');
  if (receipt.verdict === 'BLOCKED') return { verdict: 'BLOCKED', digest: null };
  if (!Buffer.isBuffer(receipt.artifact) || !receipt.artifact.length || receipt.artifact.length > 8192 ||
      !matches(DIGEST, receipt.artifactDigest)) throw new Error('playbook_artifact_unconfirmed');
  const bytes = Buffer.from(receipt.artifact);
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== receipt.artifactDigest) throw new Error('playbook_artifact_unconfirmed');
  const verdict = artifactVerdict(verifier, bytes);
  if (verdict !== receipt.verdict) throw new Error('playbook_verdict_mismatch');
  return { verdict, digest };
}

// Beta: the caller owns the existing Trust Kernel and read-only observation
// ports. The outcome is workflow evidence; only native acceptance may settle.
export async function runPlaybook({ registry, playbook, attempt }, { assertKernel, observeStage }) {
  if (!isRoleRegistry(registry) || typeof playbook !== 'string' || !Object.hasOwn(registry.playbooks, playbook) ||
      typeof assertKernel !== 'function' || typeof observeStage !== 'function') throw new Error('playbook_not_enrolled');
  const binding = boundSubject(attempt);
  if (binding.registry_digest !== registry.digest || binding.playbook !== playbook) throw new Error('playbook_pin_mismatch');
  const models = enrolledModels(attempt.triad);
  const graph = registry.playbooks[playbook];
  const plan = Object.fromEntries(Object.values(graph.stages).map(stage => {
    const role = registry.roles[stage.role];
    const model = models[role.model];
    if (role.reasoning !== 'inherit' && role.reasoning !== model.reasoning) throw new Error('playbook_reasoning_not_enrolled');
    return [stage.id, Object.freeze({ binding, registryDigest: registry.digest, playbook, stage: stage.id,
      role: stage.role, verifier: role.verifier, model, skills: role.skills, toolRequirements: role.tools })];
  }));
  let next = graph.entry;
  let green = true;
  const history = [];
  while (next !== 'ready' && next !== 'hold') {
    await guard(assertKernel, binding, models);
    const request = Object.freeze({ ...plan[next], inputArtifactDigest: history.at(-1)?.digest ?? null });
    const observation = inspectReceipt(request, await observeStage(request));
    await guard(assertKernel, binding, models);
    history.push({ stage: next, role: request.role, ...observation });
    if (observation.verdict === 'BLOCKED') return { status: 'hold', history };
    const pass = observation.verdict === 'PASS';
    green &&= pass;
    next = graph.stages[next].next[pass ? 'pass' : 'rework'];
  }
  return { status: green && next === 'ready' ? 'ready_for_native_acceptance' : 'hold', history };
}
