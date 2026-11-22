import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import {
  executorFamily, assertCrossFamily, parseReviewTranscript, parseReviewVerdict,
  hasValidFinding, runInReadOnlySandbox, snapshotDigest, ReviewDenied, REVIEW_IMAGE,
} from './review-runner.mjs';

const exec = promisify(execFile);

const CRITIC = { provider: 'openai', model: 'gpt-6.2-sol', reasoningLevel: 'medium' };

test('family: карта семейств исполнителей и критиков', () => {
  assert.equal(executorFamily('acp-devin'), 'cognition');
  assert.equal(executorFamily({ provider: 'acp-devin', model: 'swe-2-high' }), 'cognition');
  assert.equal(executorFamily('swe-2-medium'), 'cognition');
  assert.equal(executorFamily('acp-zcode-start'), 'glm');
  assert.equal(executorFamily('builtin:zai-start-plan\\GLM-5.3-Flash'), 'glm');
  assert.equal(executorFamily('opencode-go/deepseek-v4'), 'deepseek');
  assert.equal(executorFamily('deepseek-reasoner'), 'deepseek');
  assert.equal(executorFamily('openai/gpt-6.2-sol'), 'openai');
  assert.equal(executorFamily({ provider: 'openai', model: 'gpt-6.2-astra' }), 'openai');
  assert.equal(executorFamily('codex-exec'), 'openai');
  assert.equal(executorFamily('gemini-4-neon'), 'google');
  assert.equal(executorFamily('acp-antigravity-acp'), 'google');
  assert.equal(executorFamily('mystery-model'), null);
  assert.equal(executorFamily(null), null);
});

test('family: кросс-семейственный инвариант', () => {
  for (const executor of ['acp-devin', 'acp-zcode-start', 'opencode-go/deepseek-v4',
      'gemini-4-neon']) {
    assert.deepEqual(assertCrossFamily(executor, CRITIC).critic, 'openai');
  }
  assert.throws(
    () => assertCrossFamily({ provider: 'openai', model: 'gpt-6.2-astra' }, CRITIC),
    (e) => e instanceof ReviewDenied && e.reason === 'review_same_family');
  assert.throws(() => assertCrossFamily('mystery', CRITIC),
    (e) => e.reason === 'review_unknown_family');
  assert.throws(() => assertCrossFamily('acp-devin', { provider: 'x', model: 'y' }),
    (e) => e.reason === 'review_unknown_family');
});

const msg = (over = {}) => JSON.stringify({ type: 'message_end', message: {
  role: 'assistant', provider: 'openai', model: 'gpt-6.2-sol',
  thinkingLevel: 'medium', responseId: 'resp_abc123', stopReason: 'stop',
  content: [{ type: 'text', text: 'looks fine\nREVIEW_OK' }], ...over } });

test('transcript: аттестация actual и checkpoint-данных из NDJSON', () => {
  const parsed = parseReviewTranscript([
    JSON.stringify({ type: 'session_info', toolsAdded: ['read', 'grep', 'find', 'ls'] }),
    msg(), msg({ content: [{ type: 'text', text: 'final\nREVIEW_OK' }] }),
  ].join('\n'));
  assert.deepEqual(parsed.actual, { provider: 'openai', model: 'gpt-6.2-sol', reasoningLevel: 'medium' });
  assert.equal(parsed.responseId, 'resp_abc123');
  assert.match(parsed.finalText, /REVIEW_OK/);
  assert.deepEqual(parsed.toolsAdded, ['read', 'grep', 'find', 'ls']);
});

test('transcript: подмена модели в одном из ходов — отказ', () => {
  assert.throws(() => parseReviewTranscript([
    msg(), msg({ model: 'gpt-6.2-astra' }),
  ].join('\n')), (e) => e.reason === 'review_model_switch');
  assert.throws(() => parseReviewTranscript([
    msg(), msg({ provider: 'anthropic' }),
  ].join('\n')), (e) => e.reason === 'review_model_switch');
  assert.throws(() => parseReviewTranscript([
    msg(), msg({ thinkingLevel: 'high' }),
  ].join('\n')), (e) => e.reason === 'review_model_switch');
});

test('transcript: пустой и битый поток — отказ', () => {
  assert.throws(() => parseReviewTranscript(''), (e) => e.reason === 'review_transcript_empty');
  assert.throws(() => parseReviewTranscript('not json\n'), (e) => e.reason === 'review_transcript_corrupt');
});

test('verdict: канонический JSON-блок PASS', () => {
  const v = parseReviewVerdict('notes\n```json\n{"verdict":"PASS","summary":"ok",' +
    '"findings":[],"checked_invariants":["i1","i2"]}\n```\n');
  assert.equal(v.status, 'PASS');
  assert.equal(v.verdict, 'REVIEW_OK');
  assert.deepEqual(v.checked_invariants, ['i1', 'i2']);
});

test('verdict: REWORK с findings и маппинг REVIEW_BLOCKED', () => {
  const v = parseReviewVerdict('```json\n{"verdict":"REWORK","summary":"bad sum",' +
    '"findings":[{"file":"src/sum.js","line":3,"input":"sum(2,2)","expected":"4",' +
    '"actual":"5","freq":"always","harm":"wrong result"}],"checked_invariants":[]}\n```');
  assert.equal(v.status, 'REWORK');
  assert.equal(v.verdict, 'REVIEW_BLOCKED');
  assert.equal(v.findings.length, 1);
  assert.ok(hasValidFinding(v.findings));
  assert.match(v.excerpt, /src\/sum\.js/);
});

test('verdict: ESCALATE маппится в REVIEW_ESCALATE', () => {
  const v = parseReviewVerdict('{"verdict":"ESCALATE","summary":"spec conflict","findings":[]}');
  assert.equal(v.status, 'ESCALATE');
  assert.equal(v.verdict, 'REVIEW_ESCALATE');
});

test('verdict: legacy REVIEW_OK / REVIEW_BLOCKED строки', () => {
  assert.equal(parseReviewVerdict('all good\nREVIEW_OK\n').verdict, 'REVIEW_OK');
  const blocked = parseReviewVerdict('src/a.js: expected 4, actual 5\nREVIEW_BLOCKED\n');
  assert.equal(blocked.status, 'REWORK');
  assert.match(blocked.excerpt, /expected 4/);
});

test('verdict: двусмысленный или отсутствующий вердикт — отказ', () => {
  assert.throws(() => parseReviewVerdict('REVIEW_OK\nREVIEW_BLOCKED\n'),
    (e) => e.reason === 'review_verdict_missing');
  assert.throws(() => parseReviewVerdict('no verdict here'),
    (e) => e.reason === 'review_verdict_missing');
  assert.throws(() => parseReviewVerdict('{"verdict":"MAYBE"}'),
    (e) => e.reason === 'review_verdict_unknown');
});

test('finding: обязательные поля валидного замечания', () => {
  assert.ok(hasValidFinding([{ file: 'a.js', expected: 'x', actual: 'y' }]));
  assert.ok(!hasValidFinding([{ file: 'a.js', expected: '', actual: 'y' }]));
  assert.ok(!hasValidFinding([{ file: 'a.js' }]));
  assert.ok(!hasValidFinding([]));
  assert.ok(!hasValidFinding(null));
});

test('sandbox: реальный негативный тест системной read-only изоляции', async (t) => {
  let rootless = false;
  try {
    rootless = JSON.parse((await exec('docker', ['info', '--format',
      '{{json .SecurityOptions}}'], { timeout: 12_000 })).stdout).includes('name=rootless');
  } catch { /* docker недоступен */ }
  if (!rootless) return t.skip('rootless Docker unavailable');

  const scratch = await mkdtemp(join(tmpdir(), 'review-sandbox-test-'));
  try {
    const source = join(scratch, 'candidate');
    await mkdir(source, { mode: 0o755 });
    await writeFile(join(source, 'file.txt'), 'pinned\n');
    const before = await snapshotDigest(source);

    // Внутри того же hardened-контура, что и у критика: запись, chmod, удаление,
    // чтение env и host-путей — всё обязано физически отказать.
    const probe = [
      'echo x > /candidate/new.txt 2>/tmp/e1; echo "write:$?"; head -1 /tmp/e1',
      'chmod u+w /candidate/file.txt 2>/tmp/e2; echo "chmod:$?"; head -1 /tmp/e2',
      'rm /candidate/file.txt 2>/tmp/e3; echo "rm:$?"; head -1 /tmp/e3',
      'echo "BOARD_TOKEN=${BOARD_TOKEN:-unset}"; echo "BB=${BB_THREAD_ID:-unset}"',
      'ls /candidate >/dev/null && echo "candidate:present"',
      'ls /state 2>/dev/null || echo "state:absent"',
      'ls /home 2>/dev/null | head -3 || true',
    ].join('; ');
    const run = await runInReadOnlySandbox({
      snapshot: source,
      argv: ['/bin/sh', '-c', probe],
      env: {},
      timeoutMs: 60_000,
    });
    const out = run.stdout;
    assert.match(out, /write:[1-9]/, `запись в /candidate не отклонена:\n${out}${run.stderr}`);
    assert.match(run.stdout + run.stderr, /[Rr]ead.only|EROFS/);
    assert.match(out, /chmod:[1-9]/, `chmod в /candidate не отклонён:\n${out}`);
    assert.match(out, /rm:[1-9]/, `удаление в /candidate не отклонено:\n${out}`);
    assert.match(out, /BOARD_TOKEN=unset/);
    assert.match(out, /BB=unset/);
    assert.match(out, /candidate:present/);
    assert.match(out, /state:absent/);

    // Снимок обязан быть побайтово неизменен после враждебного прогона.
    const after = await snapshotDigest(source);
    assert.equal(after.digest, before.digest);
    assert.equal(after.files, before.files);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
