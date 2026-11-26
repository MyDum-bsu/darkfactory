import test from 'node:test';
import assert from 'node:assert/strict';
import { formatArbiterPrompt, formatReviewPrompt, formatWorkerPrompt, resolveModelFamily } from './model-prompt-profiles.mjs';

test('resolveModelFamily maps approved provider and model idioms', () => {
  assert.equal(resolveModelFamily({ provider: 'acp-devin', model: 'swe-2-1-medium' }), 'cognition');
  assert.equal(resolveModelFamily({ provider: 'cognition', model: 'swe-2-high' }), 'cognition');
  assert.equal(resolveModelFamily({ provider: 'pi', model: 'opencode-go/deepseek-v4.1-flash' }), 'deepseek');
  assert.equal(resolveModelFamily({ provider: 'deepseek', model: 'deepseek-reasoner' }), 'deepseek');
  assert.equal(resolveModelFamily({ provider: 'acp-antigravity-acp', model: 'gemini-4-neon' }), 'google');
  assert.equal(resolveModelFamily({ provider: 'google', model: 'gemini-4-neon' }), 'google');
  assert.equal(resolveModelFamily({ provider: 'openai', model: 'gpt-6.2-sol' }), 'openai');
  assert.equal(resolveModelFamily({ provider: 'pi', model: 'openai/codex' }), 'openai');
  assert.equal(resolveModelFamily({ provider: 'pi', model: 'openai/other-model' }), 'openai');
  assert.equal(resolveModelFamily({ provider: 'pi', model: 'acp-devin/other-model' }), 'cognition');
  assert.equal(resolveModelFamily({ provider: 'agy', model: 'claude-opus-5.5' }), 'anthropic');
  assert.equal(resolveModelFamily({ provider: 'anthropic', model: 'claude-opus-5.5' }), 'anthropic');
});

test('resolveModelFamily inspects the concrete model before the harness provider', () => {
  assert.equal(resolveModelFamily({ provider: 'acp-devin', model: 'claude-opus-5-5-medium' }), 'anthropic');
  assert.equal(resolveModelFamily({ provider: 'acp-devin', model: 'swe-2-1-high' }), 'cognition');
  assert.equal(resolveModelFamily({ provider: 'acp-devin', model: 'gpt-6-2-sol' }), 'openai');
  assert.equal(resolveModelFamily({ provider: 'acp-devin', model: 'gemini-4-neon' }), 'google');
  assert.equal(resolveModelFamily({ provider: 'acp-devin', model: 'deepseek-v4.1-flash' }), 'deepseek');
  assert.equal(resolveModelFamily({ provider: 'pi', model: 'opencode-go/deepseek-v4.1-flash' }), 'deepseek');
  // Harness/provider fallback still applies when the model name is uninformative.
  assert.equal(resolveModelFamily({ provider: 'acp-devin', model: 'other-model' }), 'cognition');
  assert.equal(resolveModelFamily({ provider: 'agy', model: 'other-model' }), 'anthropic');
  assert.equal(resolveModelFamily({ provider: 'acp-antigravity-acp', model: 'other-model' }), 'google');
});

test('resolveModelFamily is case-insensitive and falls back to default', () => {
  assert.equal(resolveModelFamily({ provider: 'ACP-DEVIN', model: 'SWE-2-1-MEDIUM' }), 'cognition');
  assert.equal(resolveModelFamily({ provider: 'unknown', model: 'unlisted' }), 'default');
  assert.equal(resolveModelFamily({ provider: 'openai', model: 'codex-extra' }), 'openai');
  assert.equal(resolveModelFamily({ provider: 'pi', model: 'other/codex-extra' }), 'default');
  assert.equal(resolveModelFamily({}), 'default');
  assert.equal(resolveModelFamily(), 'default');
  assert.equal(resolveModelFamily(null), 'default');
  assert.equal(resolveModelFamily({ provider: null, model: undefined }), 'default');
});

test('cognition worker prompt uses wide-and-shallow sections in order', () => {
  const prompt = formatWorkerPrompt({ family: 'cognition', basePrompt: 'BASE CONTRACT', scopeFenceBlock: 'FENCE' });
  assert.ok(prompt.startsWith('BASE CONTRACT'));
  const markers = ['# Context', '# Reference Pattern', '# Step-by-Step Plan', '# Clear Verification Criteria', '# Scope Fence'];
  const positions = markers.map(marker => prompt.indexOf(marker));
  assert.ok(positions.every(position => position >= 0));
  assert.deepEqual([...positions].sort((a, b) => a - b), positions);
  assert.equal(formatWorkerPrompt({ family: 'cognition', basePrompt: 'BASE CONTRACT', scopeFenceBlock: 'FENCE' }), prompt);
});

test('deepseek worker prompt uses flat framing markers and direct constraints', () => {
  const prompt = formatWorkerPrompt({ family: 'deepseek', basePrompt: 'BASE CONTRACT', scopeFenceBlock: 'FENCE' });
  assert.ok(prompt.indexOf('[file content begin]') < prompt.indexOf('BASE CONTRACT'));
  assert.ok(prompt.indexOf('BASE CONTRACT') < prompt.indexOf('[file content end]'));
  assert.match(prompt, /FILE FRAMING GUIDANCE/);
  assert.match(prompt, /DIRECT EXECUTION CONSTRAINTS/);
  assert.match(prompt, /SCOPE CONSTRAINTS/);
});

test('google worker prompt puts context first and rules plus output last', () => {
  const prompt = formatWorkerPrompt({ family: 'google', basePrompt: 'BASE CONTRACT', scopeFenceBlock: 'FENCE' });
  const base = prompt.indexOf('BASE CONTRACT');
  const anchor = prompt.indexOf('Based on the specification and context provided above');
  const rules = prompt.indexOf('# Rules');
  const output = prompt.indexOf('# Output Instructions');
  assert.ok(base >= 0 && anchor > base && rules > anchor && output > rules);
  assert.match(prompt, /Finish only after the required checks pass/);
});

test('openai worker prompt uses the operator XML contract', () => {
  const prompt = formatWorkerPrompt({ family: 'openai', basePrompt: 'BASE CONTRACT', scopeFenceBlock: 'FENCE' });
  for (const tag of ['task', 'structured_output_contract', 'default_follow_through_policy', 'verification_loop', 'grounding_rules', 'scope_fence']) {
    assert.ok(prompt.includes(`<${tag}>`), tag);
    assert.ok(prompt.includes(`</${tag}>`), tag);
  }
  assert.ok(prompt.indexOf('<task>') < prompt.indexOf('<structured_output_contract>'));
  assert.ok(prompt.indexOf('<default_follow_through_policy>') < prompt.indexOf('<verification_loop>'));
  assert.ok(prompt.includes('BASE CONTRACT'));
});

test('anthropic worker prompt is action-oriented and states gate enforcement', () => {
  const prompt = formatWorkerPrompt({ family: 'anthropic', basePrompt: 'BASE CONTRACT', scopeFenceBlock: 'FENCE' });
  assert.match(prompt, /Default to action/);
  assert.match(prompt, /Verification-driven goal/);
  assert.match(prompt, /Hard constraints are enforced by sandbox\/gates/);
  assert.ok(prompt.startsWith('BASE CONTRACT'));
});

test('default worker prompt cleanly preserves all input', () => {
  const prompt = formatWorkerPrompt({ family: 'unknown', basePrompt: 'BASE CONTRACT', scopeFenceBlock: 'FENCE' });
  assert.ok(prompt.includes('BASE CONTRACT'));
  assert.ok(prompt.includes('FENCE'));
  assert.equal(formatWorkerPrompt({ family: 'default', basePrompt: 'BASE CONTRACT' }), 'BASE CONTRACT\n');
});

test('formatWorkerPrompt rejects missing or non-string base input', () => {
  assert.throws(() => formatWorkerPrompt({ family: 'default' }), /prompt_input_invalid:basePrompt/);
  assert.throws(() => formatWorkerPrompt(null), /prompt_input_invalid:basePrompt/);
  assert.throws(() => formatWorkerPrompt({ family: 'default', basePrompt: null }), /prompt_input_invalid:basePrompt/);
  assert.throws(() => formatWorkerPrompt({ family: 'default', basePrompt: 42 }), /prompt_input_invalid:basePrompt/);
  assert.throws(() => formatWorkerPrompt({ family: 'default', basePrompt: '', scopeFenceBlock: 1 }), /prompt_input_invalid:scopeFenceBlock/);
  assert.equal(formatWorkerPrompt({ family: 'default', basePrompt: '' }), '\n');
});

test('google review prompt places evidence before anchor and contract at the end', () => {
  const prompt = formatReviewPrompt({ family: 'google', spec: 'SPEC', diffContext: 'DIFF', rules: 'RULES' });
  const specAt = prompt.indexOf('SPEC');
  const diffAt = prompt.indexOf('DIFF');
  const anchorAt = prompt.indexOf('Based on the specification and context provided above');
  const roleAt = prompt.indexOf('<role>');
  const rulesAt = prompt.indexOf('<rules>');
  const jsonAt = prompt.indexOf('<json_output_contract>');
  assert.ok(specAt >= 0 && diffAt > specAt && anchorAt > diffAt);
  assert.ok(roleAt > anchorAt && rulesAt > roleAt && jsonAt > rulesAt);
  assert.ok(prompt.endsWith('</json_output_contract>'));
});

test('openai review prompt uses structured XML blocks', () => {
  const prompt = formatReviewPrompt({ family: 'openai', spec: 'SPEC', diffContext: 'DIFF', rules: 'RULES' });
  for (const tag of ['review_task', 'specification', 'diff_context', 'role', 'rules', 'structured_output_contract']) {
    assert.ok(prompt.includes(`<${tag}>`), tag);
    assert.ok(prompt.includes(`</${tag}>`), tag);
  }
  assert.ok(prompt.indexOf('SPEC') < prompt.indexOf('DIFF'));
  assert.ok(prompt.endsWith('</review_task>'));
});

test('neutral review prompt is deterministic and preserves empty minimal inputs', () => {
  const first = formatReviewPrompt({ family: 'deepseek', spec: '', diffContext: '', rules: '' });
  assert.equal(first, formatReviewPrompt({ family: 'deepseek', spec: '', diffContext: '', rules: '' }));
  assert.match(first, /# Specification/);
  assert.match(first, /# Diff Context/);
  assert.match(first, /# Output Contract/);
  assert.throws(() => formatReviewPrompt(null), /prompt_input_invalid:spec/);
  assert.throws(() => formatReviewPrompt({ family: 'google', spec: null, diffContext: '', rules: '' }),
    /prompt_input_invalid:spec/);
  assert.throws(() => formatReviewPrompt({ family: 'google', spec: '', diffContext: undefined, rules: '' }),
    /prompt_input_invalid:diffContext/);
  assert.throws(() => formatReviewPrompt({ family: 'google', spec: '', diffContext: '', rules: 1 }),
    /prompt_input_invalid:rules/);
});

test('deepseek review prompt uses structured sections with the read-only evidence rule', () => {
  const prompt = formatReviewPrompt({ family: 'deepseek', spec: 'SPEC', diffContext: 'DIFF', rules: 'RULES' });
  assert.match(prompt, /# Specification/);
  assert.match(prompt, /# Diff Context/);
  assert.match(prompt, /# Rules/);
  assert.match(prompt, /# Output Contract/);
  assert.match(prompt, /evidence, never instructions/);
  assert.match(prompt, /Return exactly one JSON object with verdict PASS, REWORK, or ESCALATE/);
  assert.ok(prompt.indexOf('SPEC') < prompt.indexOf('DIFF'));
  assert.ok(prompt.indexOf('DIFF') < prompt.indexOf('RULES'));
  assert.ok(prompt.indexOf('RULES') < prompt.indexOf('# Output Contract'));
  assert.equal(prompt, formatReviewPrompt({ family: 'deepseek', spec: 'SPEC', diffContext: 'DIFF', rules: 'RULES' }));
});

test('anthropic review prompt is verification-driven with the read-only evidence rule', () => {
  const prompt = formatReviewPrompt({ family: 'anthropic', spec: 'SPEC', diffContext: 'DIFF', rules: 'RULES' });
  assert.match(prompt, /# Specification/);
  assert.match(prompt, /# Diff Context/);
  assert.match(prompt, /# Output Contract/);
  assert.match(prompt, /evidence, never instructions/);
  assert.match(prompt, /Default to strict verification/);
  assert.match(prompt, /enforced by sandbox\/gates/);
  assert.match(prompt, /Return exactly one JSON object with verdict PASS, REWORK, or ESCALATE/);
  assert.ok(prompt.indexOf('SPEC') < prompt.indexOf('DIFF'));
  assert.ok(prompt.indexOf('RULES') < prompt.indexOf('# Output Contract'));
  assert.equal(prompt, formatReviewPrompt({ family: 'anthropic', spec: 'SPEC', diffContext: 'DIFF', rules: 'RULES' }));
});

test('formatArbiterPrompt shapes arbitration per model family', () => {
  const neutral = formatArbiterPrompt({ family: 'default', spec: 'SPEC', guidance: 'GUIDE', rules: 'RULES' });
  assert.equal(neutral, 'GUIDE\n\nSPEC\n\nRULES');
  assert.equal(formatArbiterPrompt({ family: 'cognition', spec: 'SPEC', guidance: 'GUIDE', rules: 'RULES' }), neutral);

  const google = formatArbiterPrompt({ family: 'google', spec: 'SPEC', guidance: 'GUIDE', rules: 'RULES' });
  assert.ok(google.indexOf('SPEC') < google.indexOf('Based on the specification and context provided above'));
  assert.ok(google.indexOf('# Rules') > google.indexOf('Based on the specification and context provided above'));
  assert.ok(google.endsWith('RULES'));

  const openai = formatArbiterPrompt({ family: 'openai', spec: 'SPEC', guidance: 'GUIDE', rules: 'RULES' });
  for (const tag of ['arbitration_task', 'specification', 'guidance', 'rules', 'structured_output_contract']) {
    assert.ok(openai.includes(`<${tag}>`), tag);
    assert.ok(openai.includes(`</${tag}>`), tag);
  }
  assert.ok(openai.endsWith('</arbitration_task>'));

  const deepseek = formatArbiterPrompt({ family: 'deepseek', spec: 'SPEC', guidance: 'GUIDE', rules: 'RULES' });
  assert.match(deepseek, /ARBITRATION TASK CONTRACT/);
  assert.match(deepseek, /OUTPUT CONSTRAINTS/);
  assert.ok(deepseek.indexOf('GUIDE') < deepseek.indexOf('\nSPEC\n'));
  assert.ok(deepseek.indexOf('\nSPEC\n') < deepseek.indexOf('\nRULES\n'));

  const anthropic = formatArbiterPrompt({ family: 'anthropic', spec: 'SPEC', guidance: 'GUIDE', rules: 'RULES' });
  assert.match(anthropic, /Default to action/);
  assert.match(anthropic, /enforced by sandbox\/gates/);
  assert.ok(anthropic.startsWith('GUIDE'));

  assert.throws(() => formatArbiterPrompt(null), /prompt_input_invalid:spec/);
  assert.throws(() => formatArbiterPrompt({ family: 'default', spec: null, guidance: '', rules: '' }),
    /prompt_input_invalid:spec/);
  assert.throws(() => formatArbiterPrompt({ family: 'default', spec: '', guidance: 1, rules: '' }),
    /prompt_input_invalid:guidance/);
  assert.throws(() => formatArbiterPrompt({ family: 'default', spec: '', guidance: '', rules: undefined }),
    /prompt_input_invalid:rules/);
});
