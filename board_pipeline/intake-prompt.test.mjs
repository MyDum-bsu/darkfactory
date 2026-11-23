import { test } from 'node:test';
import assert from 'node:assert/strict';
import { arbiterIntakePrompt, workerIntakePrompt } from './intake-prompt.mjs';

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
