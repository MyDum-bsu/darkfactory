import assert from 'node:assert/strict';
import test from 'node:test';
import { createStreamLoopGuard, trimLoop } from './loop-detector.mjs';

const loopText = (phrase, times) => Array.from({ length: times }, () => phrase).join(' ');

test('guard config validation', () => {
  assert.throws(() => createStreamLoopGuard({ mode: 'bogus' }), /loop_guard_mode_invalid/);
});

test('detects a repeated 32-word cycle after arming', () => {
  const guard = createStreamLoopGuard({ mode: 'observe', n: 4, armWords: 20, minRepeat: 4 });
  const phrase = 'alpha beta gamma delta';
  // Прогрев до armWords уникальными словами, затем повтор фразы.
  let status = guard.push('content', Array.from({ length: 20 }, (_, i) => `w${i}`).join(' '));
  assert.equal(status.looped, false);
  status = guard.push('content', loopText(phrase, 8));
  assert.equal(status.looped, true);
  assert.ok(status.repeats >= 4);
});

test('no detection before armWords even on repetition', () => {
  const guard = createStreamLoopGuard({ mode: 'observe', n: 4, armWords: 3000, minRepeat: 3 });
  const status = guard.push('content', loopText('same words keep going', 40));
  assert.equal(status.looped, false);
});

test('streaming chunks split mid-word still detects', () => {
  const guard = createStreamLoopGuard({ mode: 'observe', n: 4, armWords: 8, minRepeat: 4 });
  const text = `seed words here to arm the gate properly ` + loopText('loop one two three', 10);
  let last;
  for (let i = 0; i < text.length; i += 7) {
    last = guard.push('content', text.slice(i, i + 7));
  }
  assert.equal(last.looped, true);
});

test('reasoning channel is independent of content', () => {
  const guard = createStreamLoopGuard({ mode: 'observe', n: 4, armWords: 8, minRepeat: 4 });
  guard.push('reasoning', loopText('think think think think', 12));
  assert.equal(guard.stats('reasoning').looped, true);
  assert.equal(guard.stats('content').looped, false);
  guard.push('content', loopText('think think think think', 12));
  assert.equal(guard.stats('content').looped, true);
});

test('off mode does zero work', () => {
  const guard = createStreamLoopGuard({ mode: 'off', n: 2, armWords: 1, minRepeat: 2 });
  const status = guard.push('content', loopText('x y', 100));
  assert.equal(status.looped, false);
  assert.equal(status.words, 0);
});

test('no false positive on long valid JSON review output', () => {
  const guard = createStreamLoopGuard({ mode: 'observe', n: 8, armWords: 50, minRepeat: 5 });
  // Длинный JSON с повторяющейся структурой, но уникальными значениями:
  // ключи одинаковые, слова в окне никогда не повторяют 8-грамму 5 раз.
  const chunks = Array.from({ length: 400 }, (_, i) =>
    `{"file":"src/module${i}.mjs","line":${i},"severity":"P${i % 3}","note":"finding ${i}"},`);
  const status = guard.push('content', chunks.join(' '));
  assert.equal(status.looped, false);
  const fin = guard.finish();
  assert.equal(fin.looped, false);
});

test('trimLoop cuts the repeated tail at the n-gram start', () => {
  const head = 'the worker wrote a patch and stopped. ';
  const tail = loopText('a b c d', 10); // 4-словная фраза, цикл
  const result = trimLoop(head + tail, { n: 4, minRepeat: 3 });
  assert.equal(result.trimmed, true);
  assert.ok(result.text.startsWith('the worker'));
  assert.ok(result.text.length < head.length + tail.length);
  // Хвост не содержит полного повторяющегося цикла.
  assert.ok(!result.text.includes('a b c d a b c d a b c d a b c d a b c d a b c d a b c d'));
});

test('trimLoop leaves non-looping text untouched', () => {
  const text = Array.from({ length: 200 }, (_, i) => `token${i}`).join(' ');
  const result = trimLoop(text, { n: 8, minRepeat: 3 });
  assert.equal(result.trimmed, false);
  assert.equal(result.text, text);
});

test('trimLoop handles short and empty input', () => {
  assert.deepEqual(trimLoop('', { n: 4 }), { text: '', trimmed: false });
  assert.equal(trimLoop('one two three', { n: 4 }).trimmed, false);
  assert.equal(trimLoop(null).trimmed, false);
});

test('detection latency is bounded on a long synthetic loop', () => {
  const guard = createStreamLoopGuard({ mode: 'observe', n: 32, armWords: 64, minRepeat: 5 });
  const phrase = Array.from({ length: 32 }, (_, i) => `cycle${i}`).join(' ');
  const text = loopText(phrase, 200);
  const started = process.hrtime.bigint();
  let last;
  for (let i = 0; i < text.length; i += 4096) {
    last = guard.push('content', text.slice(i, i + 4096));
    if (last.looped) break;
  }
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.equal(last.looped, true);
  assert.ok(elapsedMs < 500, `detection too slow: ${elapsedMs}ms`);
});
