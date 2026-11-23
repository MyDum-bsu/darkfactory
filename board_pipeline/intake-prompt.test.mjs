import { test } from 'node:test';
import assert from 'node:assert/strict';
import { arbiterIntakePrompt, decisionsPromptBlock, workerIntakePrompt } from './intake-prompt.mjs';

const spec = 'Принятые решения: CSV для ручной выгрузки, потому что оператор сверяет таблицу (D-01).';
const handoff = { task_id: '492', epoch: 1, attempt_id: 'attempt', worker_thread_id: '<BB_THREAD_ID>',
  candidate_sha: '<Git SHA>' };
const worker = { brief: spec, tree: '/worktree', handoffPath: '/outside/submission.json', handoff };

test('P1.1 worker receives approved decision and the check before the question format', () => {
  const prompt = workerIntakePrompt({ ...worker, productQuestions: true });
  assert.ok(prompt.startsWith(spec));
  assert.ok(prompt.includes(JSON.stringify(handoff)));
  const check = prompt.indexOf('Перед продуктовым вопросом');
  const ask = prompt.indexOf('question: {"prompt":');
  assert.ok(check > 0 && ask > check);
  assert.match(prompt, /без повторного вопроса/);
  assert.match(prompt, /не ищи приватную базу/);
  assert.match(prompt, /не даёт допуска.*выпуску/);
});

test('worker without P1.1 gets the approved decision but not a question handoff', () => {
  const prompt = workerIntakePrompt({ ...worker, productQuestions: false });
  assert.ok(prompt.startsWith(spec));
  assert.ok(prompt.includes('/outside/submission.json'));
  assert.ok(prompt.includes(JSON.stringify(handoff)));
  assert.doesNotMatch(prompt, /question:|Перед продуктовым вопросом/);
});

test('arbitration reads the approved spec before escalating only an unresolved fork', () => {
  const prompt = arbiterIntakePrompt(spec, 'Operator rules.');
  const check = prompt.indexOf('Перед продуктовым вопросом');
  const escalate = prompt.indexOf('escalate_owner');
  assert.ok(prompt.indexOf(spec) > 0 && prompt.indexOf(spec) < check);
  assert.ok(check > 0 && escalate > check);
  assert.match(prompt, /Operator rules\./);
  assert.match(prompt, /не ищи приватную базу/);
  assert.match(prompt, /не даёт допуска.*выпуску/);
});

const slice = { text: '- [global] CSV для выгрузки (dec-1)',
  digest: 'a'.repeat(64), ids: ['dec-1'], truncated: false, total: 1 };

test('P1.1 worker gets the pinned read-only ledger slice before the question rules', () => {
  const prompt = workerIntakePrompt({ ...worker, productQuestions: true, decisions: slice });
  const block = prompt.indexOf('Принятые решения владельца (read-only');
  const check = prompt.indexOf('Перед продуктовым вопросом');
  assert.ok(block > 0 && check > block);
  assert.match(prompt, /digest a{64}/);
  assert.match(prompt, /- \[global\] CSV для выгрузки \(dec-1\)/);
});

test('worker without a configured ledger gets no decisions block', () => {
  const prompt = workerIntakePrompt({ ...worker, productQuestions: false });
  assert.doesNotMatch(prompt, /read-only, срез digest/);
});

test('arbiter receives the same pinned slice alongside manual extra rules', () => {
  const prompt = arbiterIntakePrompt(spec, 'Operator rules.', slice);
  assert.match(prompt, /Принятые решения владельца \(read-only, срез digest a{64}\)/);
  assert.match(prompt, /Operator rules\./);
  // Старый ручной owner-decisions текст в extra сохраняется без изменений.
  assert.ok(prompt.indexOf('Operator rules.') < prompt.indexOf('Принятые решения владельца'));
});

test('decisionsPromptBlock is fail-closed on an unpinned slice', () => {
  assert.throws(() => decisionsPromptBlock({ text: 'x', digest: 'short' }), /decision_ledger_slice_invalid/);
  assert.throws(() => decisionsPromptBlock(null), /decision_ledger_slice_invalid/);
  const empty = decisionsPromptBlock({ ...slice, text: '', ids: [] });
  assert.match(empty, /нет активных решений/);
});

test('a truncated slice with zero shown decisions fails closed, never reads as empty', () => {
  assert.throws(() => decisionsPromptBlock({ ...slice, text: '', ids: [], truncated: true, total: 3 }),
    /decision_ledger_slice_truncated/);
});

test('a partially truncated slice keeps its entries and flags the cut', () => {
  const block = decisionsPromptBlock({ ...slice, truncated: true, total: 5 });
  assert.match(block, /- \[global\] CSV для выгрузки \(dec-1\)/);
  assert.match(block, /срез усечён: показано 1 из 5/);
  assert.doesNotMatch(block, /нет активных решений/);
});
