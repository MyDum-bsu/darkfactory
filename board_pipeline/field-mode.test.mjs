import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_FIELD_MODE, FIELD_MODES, TASK_PLANS, normalizeFieldMode, normalizeTaskPlan,
  resolveFieldPolicy, taskPlanPromptBlock } from './field-mode.mjs';

test('closed vocabularies normalize strings; only nullish inputs mean absent', () => {
  assert.deepEqual(FIELD_MODES, ['greenfield', 'brownfield', 'bluefield', 'greyfield']);
  assert.deepEqual(TASK_PLANS, ['mvp', 'bugfix', 'api-change', 'refactor']);
  for (const [keys, normalize, code] of [
    [FIELD_MODES, normalizeFieldMode, 'field_mode_invalid'],
    [TASK_PLANS, normalizeTaskPlan, 'task_plan_invalid'],
  ]) {
    assert.ok(Object.isFrozen(keys));
    for (const key of keys) assert.equal(normalize(` ${key.toUpperCase()} `), key);
    assert.equal(normalize(undefined), null);
    assert.equal(normalize(null), null);
    for (const invalid of ['', '   ', 'unknown', 0, false, {}, [keys[0]]]) {
      assert.throws(() => normalize(invalid), { code });
    }
  }
});

const strict = { fastTrack: false, skipL2: false, scopeFenceMode: 'strict', tamperMode: 'full',
  requireBaseline: true, computeBlastRadius: true, gradeCap: 'VERIFIED' };
const fast = { fastTrack: true, skipL2: true, scopeFenceMode: 'warn', tamperMode: 'secrets_only',
  requireBaseline: false, computeBlastRadius: false, gradeCap: 'CHECKED' };

test('only the effective field mode controls protections, independently of the task plan', () => {
  assert.equal(DEFAULT_FIELD_MODE, 'brownfield');
  assert.deepEqual(resolveFieldPolicy(), { fieldMode: 'brownfield', taskPlan: 'bugfix', ...strict });
  assert.deepEqual(resolveFieldPolicy({ repoFieldMode: null }), resolveFieldPolicy());
  for (const fieldMode of FIELD_MODES) {
    const green = fieldMode === 'greenfield';
    for (const plan of [null, ...TASK_PLANS]) {
      const policy = resolveFieldPolicy({ repoFieldMode: ` ${fieldMode.toUpperCase()} `,
        taskPlan: plan?.toUpperCase() });
      assert.ok(Object.isFrozen(policy));
      assert.deepEqual(policy, { fieldMode, taskPlan: plan ?? (green ? 'mvp' : 'bugfix'),
        ...(green ? fast : strict) });
    }
  }
});

test('a card may select a protected mode, but cannot grant greenfield privileges', () => {
  for (const repoFieldMode of [undefined, null, 'brownfield', 'bluefield', 'greyfield']) {
    assert.throws(() => resolveFieldPolicy({ repoFieldMode, cardFieldMode: ' GREENFIELD ' }),
      { code: 'field_mode_downgrade_denied' });
  }
  assert.deepEqual(resolveFieldPolicy({ repoFieldMode: 'greenfield', cardFieldMode: ' BrownField ' }),
    resolveFieldPolicy());
  assert.deepEqual(resolveFieldPolicy({ repoFieldMode: 'greenfield', cardFieldMode: 'greenfield' }),
    resolveFieldPolicy({ repoFieldMode: 'greenfield' }));
});

test('invalid inputs are not masked by overrides or defaults', () => {
  assert.throws(() => resolveFieldPolicy({ repoFieldMode: '', cardFieldMode: 'brownfield' }),
    { code: 'field_mode_invalid' });
  assert.throws(() => resolveFieldPolicy({ repoFieldMode: 'greenfield', cardFieldMode: false }),
    { code: 'field_mode_invalid' });
  assert.throws(() => resolveFieldPolicy({ taskPlan: 'typo' }), { code: 'task_plan_invalid' });
});

test('each plan prompts for its own verification steps and uses the policy default when absent', () => {
  for (const [plan, evidence] of Object.entries({ mvp: /smoke-test/i, bugfix: /regression test/i,
    'api-change': /compatibility/i, refactor: /observable behavior/i })) {
    const block = taskPlanPromptBlock(plan);
    assert.match(block, evidence);
    assert.match(block, /^[\x20-\x7e\n]+$/);
    assert.equal(taskPlanPromptBlock(` ${plan.toUpperCase()} `), block);
  }
  assert.equal(taskPlanPromptBlock(null, 'greenfield'), taskPlanPromptBlock('mvp', 'greenfield'));
  assert.equal(taskPlanPromptBlock(), taskPlanPromptBlock('bugfix', 'brownfield'));
  assert.throws(() => taskPlanPromptBlock('anything'), { code: 'task_plan_invalid' });
  assert.throws(() => taskPlanPromptBlock('mvp', 'anything'), { code: 'field_mode_invalid' });
});
