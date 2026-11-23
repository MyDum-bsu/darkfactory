import { PilotDenied } from './pilot-gate.mjs';

const NEXT = new Map([
  ['claimed', 'submit_candidate'], ['L1', 'deterministic_checks'], ['L3', 'visual_checks'],
  ['L2', 'independent_review'], ['L2_REWORK', 'revise_candidate'], ['L2_PASS', 'seal_candidate'],
  ['completed', 'none'], ['blocked', 'operator_review'],
]);
const KEYS = ['factory.phase', 'factory.epoch', 'factory.next', 'factory.sha'];
const SHA = /^[a-f0-9]{40}$/;

export function pilotScopeMatches(message, scope) {
  const labels = message?.labels;
  return message?.channel === scope.channel && message.task?.owner === scope.owner &&
    labels?.repo_id === scope.repoId && labels.profile_id === scope.profileId &&
    labels.finish === scope.finish && labels[scope.label.key] === scope.label.value;
}

export function pilotProjection({ phase, epoch, sha }, root, scope) {
  if (!NEXT.has(phase) || !Number.isSafeInteger(epoch) || epoch < 1 ||
      (sha !== undefined && (typeof sha !== 'string' || !SHA.test(sha)))) {
    throw new PilotDenied('pilot_projection_invalid');
  }
  const expected = ['completed', 'blocked'].includes(phase) ? phase : 'claimed';
  if (!pilotScopeMatches(root, scope) || root.task.epoch !== epoch || root.task.state !== expected ||
      (expected === 'claimed' && !(Date.parse(root.task.claim?.until) > Date.now())) ||
      Number(root.labels['factory.epoch']) > epoch) throw new PilotDenied('pilot_projection_stale');
  const set = { 'factory.phase': phase, 'factory.epoch': String(epoch), 'factory.next': NEXT.get(phase),
    ...(sha === undefined ? {} : { 'factory.sha': sha }) };
  const unset = sha === undefined && Object.hasOwn(root.labels, 'factory.sha') ? ['factory.sha'] : [];
  if (unset.length === 0 && Object.entries(set).every(([key, value]) => root.labels[key] === value)) return null;
  const fence = [...new Set([...KEYS, scope.label.key, 'repo_id', 'profile_id', 'finish'])];
  // Board can compare labels, not task epochs, in this write. This is display
  // metadata only; it is never read by admission, lease or final acceptance.
  return { set, unset, if: Object.fromEntries(fence.map(key => [key, root.labels[key] ?? null])) };
}
