export const FIELD_MODES = Object.freeze(['greenfield', 'brownfield', 'bluefield', 'greyfield']);
export const DEFAULT_FIELD_MODE = 'brownfield';
export const TASK_PLANS = Object.freeze(['mvp', 'bugfix', 'api-change', 'refactor']);

function normalize(value, allowed, code) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') {
    const key = value.trim().toLowerCase();
    if (allowed.includes(key)) return key;
  }
  throw Object.assign(new Error(code), { code });
}

// Intake is operator project policy, not a per-card override of the field gates.
export const INTAKE_MODES = Object.freeze(['direct_lead', 'managed_dispatcher']);
export const DEFAULT_INTAKE_MODE = 'direct_lead';
export function resolveIntakeMode({ intake_mode = DEFAULT_INTAKE_MODE } = {}) {
  if (intake_mode === null) throw Object.assign(new Error('intake_mode_invalid'), { code: 'intake_mode_invalid' });
  return normalize(intake_mode, INTAKE_MODES, 'intake_mode_invalid');
}

export function normalizeFieldMode(value) {
  return normalize(value, FIELD_MODES, 'field_mode_invalid');
}

export function normalizeTaskPlan(value) {
  return normalize(value, TASK_PLANS, 'task_plan_invalid');
}

export function resolveFieldPolicy({ repoFieldMode = DEFAULT_FIELD_MODE, cardFieldMode = null,
  taskPlan = null } = {}) {
  const repoMode = normalizeFieldMode(repoFieldMode) ?? DEFAULT_FIELD_MODE;
  const cardMode = normalizeFieldMode(cardFieldMode);
  // Only the repository can grant access to the fast track, never a card or plan.
  if (repoMode !== 'greenfield' && cardMode === 'greenfield') {
    const code = 'field_mode_downgrade_denied';
    throw Object.assign(new Error(code), { code });
  }
  const fieldMode = cardMode ?? repoMode;
  const fastTrack = fieldMode === 'greenfield';
  return Object.freeze({
    fieldMode,
    taskPlan: normalizeTaskPlan(taskPlan) ?? (fastTrack ? 'mvp' : 'bugfix'),
    fastTrack,
    skipL2: fastTrack,
    scopeFenceMode: fastTrack ? 'warn' : 'strict',
    tamperMode: fastTrack ? 'secrets_only' : 'full',
    requireBaseline: !fastTrack,
    computeBlastRadius: !fastTrack,
    gradeCap: fastTrack ? 'CHECKED' : 'VERIFIED',
  });
}

const checklists = {
  mvp: '- Build the smallest usable end-to-end slice.\n- Smoke-test the main user path and record what remains out of scope.',
  bugfix: '- Capture the failure in a regression test.\n- Fix its cause and verify the test passes without changing unrelated behavior.',
  'api-change': '- Identify affected callers and compatibility requirements.\n- Update the API contract, callers, and contract tests together.',
  refactor: '- Pin existing behavior with characterization tests.\n- Change the structure without changing observable behavior, then rerun the tests.',
};

export function taskPlanPromptBlock(taskPlan, fieldMode = DEFAULT_FIELD_MODE) {
  const policy = resolveFieldPolicy({ repoFieldMode: fieldMode, taskPlan });
  return `Task plan: ${policy.taskPlan} (${policy.fieldMode})\n${checklists[policy.taskPlan]}`;
}
