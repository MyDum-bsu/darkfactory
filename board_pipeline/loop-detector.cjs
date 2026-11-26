'use strict';

// Детектор зацикливания потока модели — MIT-порт паттерна
// loop-gate-skill (detector.go + trim.go) на Node stdlib.
//
// Rolling polynomial 64-bit hash (BigInt) по N-граммам слов: хвост
// из n последних слов сворачивается в один хэш; повторение одного и
// того же хэша >= minRepeat раз после прогрева armWords — зацикленный
// хвост. Два независимых канала: 'content' (видимый текст) и
// 'reasoning' (внутренние рассуждения модели), чтобы цикл в скрытом
// канале ловился так же.
//
// Режимы:
//   observe — метрика loopGuard фиксируется, стрим не прерывается;
//   abort   — вызывающий стрим прерывает (caller кидает 'loop_detected');
//   off     — полный обход, нулевая стоимость.
// 0 зависимостей, слова определяются границами пробелов.

const MASK64 = (1n << 64n) - 1n;
const FNV_OFFSET = 14695981039346656037n;
const FNV_PRIME = 1099511628211n;
const ROLLING_BASE = 1000003n;

const modPow = (base, exp, mod) => {
  let result = 1n;
  let b = base % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return result;
};

const hashWord = word => {
  let h = FNV_OFFSET;
  for (let i = 0; i < word.length; i++) {
    h ^= BigInt(word.charCodeAt(i));
    h = (h * FNV_PRIME) & MASK64;
  }
  return h;
};

// Инкрементальный детектор одного канала. Текст поступает кусками;
// незавершённое слово на границе чанка ждёт продолжения в tail.
function createChannel({ n, armWords, minRepeat }) {
  const removeFactor = modPow(ROLLING_BASE, BigInt(n - 1), 1n << 64n);
  const window = new Array(n);
  const seen = new Map();
  let hash = 0n;
  let filled = 0;
  let words = 0;
  let tail = '';
  let looped = false;
  let repeats = 0;
  let loopWord = 0;

  const feed = wordHash => {
    words++;
    if (filled === n) {
      const first = window[words % n];
      hash = (hash - (first * removeFactor & MASK64) + (1n << 64n)) & MASK64;
      hash = (hash * ROLLING_BASE + wordHash) & MASK64;
      window[words % n] = wordHash;
    } else {
      hash = (hash * ROLLING_BASE + wordHash) & MASK64;
      window[words % n] = wordHash;
      filled++;
    }
    if (filled < n) return;
    const count = (seen.get(hash) ?? 0) + 1;
    seen.set(hash, count);
    if (!looped && words >= armWords && count >= minRepeat) {
      looped = true;
      repeats = count;
      loopWord = words;
    }
  };

  return {
    push(text) {
      if (looped || typeof text !== 'string' || !text) return this.stats();
      tail += text;
      const parts = tail.split(/(\s+)/);
      tail = parts.length % 2 === 1 ? parts.pop() : '';
      for (const part of parts) {
        if (!part || /^\s+$/.test(part)) continue;
        feed(hashWord(part));
      }
      return this.stats();
    },
    flush() {
      if (tail) {
        feed(hashWord(tail));
        tail = '';
      }
      return this.stats();
    },
    stats() {
      return { looped, repeats, words, loopWord };
    },
  };
}

// createStreamLoopGuard({ mode, n, armWords, minRepeat, cutRatio })
//   push('content'|'reasoning', chunk) -> { looped, repeats, words }
//   Отдельные накопители по каналам; 'off' не создаёт состояния.
function createStreamLoopGuard({ mode = 'observe', n = 32, armWords = 3000,
  minRepeat = 5, cutRatio = 0.35 } = {}) {
  if (!['observe', 'abort', 'off'].includes(mode)) throw new Error('loop_guard_mode_invalid');
  const options = { n, armWords, minRepeat };
  const channels = new Map();
  const channelOf = name => {
    if (mode === 'off') return null;
    if (!channels.has(name)) channels.set(name, createChannel(options));
    return channels.get(name);
  };
  return Object.freeze({
    mode, n, armWords, minRepeat, cutRatio,
    push(channel, text) {
      if (channel !== 'content' && channel !== 'reasoning') {
        return { looped: false, repeats: 0, words: 0 };
      }
      return channelOf(channel)?.push(text) ?? { looped: false, repeats: 0, words: 0 };
    },
    stats(channel) {
      return channelOf(channel)?.stats() ?? { looped: false, repeats: 0, words: 0 };
    },
    finish() {
      for (const ch of channels.values()) ch.flush();
      return this.stats('content').looped || this.stats('reasoning').looped
        ? { looped: true, content: this.stats('content'), reasoning: this.stats('reasoning') }
        : { looped: false, content: this.stats('content'), reasoning: this.stats('reasoning') };
    },
  });
}

// trimLoop(text, options): обрезает зацикленный хвост — находит первую
// позицию, где n-грамма достигла minRepeat повторений, и отрезает текст
// на начало этой n-граммы. Возвращает { text, trimmed, repeatWord }.
// Без цикла возвращает исходный текст с trimmed: false.
function trimLoop(text, { n = 32, minRepeat = 5 } = {}) {
  if (typeof text !== 'string' || !text) return { text: text ?? '', trimmed: false };
  const entries = [];
  const re = /\S+/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    entries.push({ index: match.index, hash: hashWord(match[0]) });
  }
  if (entries.length < n) return { text, trimmed: false };
  const seen = new Map();
  const removeFactor = modPow(ROLLING_BASE, BigInt(n - 1), 1n << 64n);
  let hash = 0n;
  for (let i = 0; i < n; i++) hash = (hash * ROLLING_BASE + entries[i].hash) & MASK64;
  seen.set(hash, 1);
  for (let i = n; i < entries.length; i++) {
    hash = (hash - (entries[i - n].hash * removeFactor & MASK64) + (1n << 64n)) & MASK64;
    hash = (hash * ROLLING_BASE + entries[i].hash) & MASK64;
    const count = (seen.get(hash) ?? 0) + 1;
    seen.set(hash, count);
    if (count >= minRepeat) {
      // Повторяющееся окно начинается у слова i-n+1 — режем с его начала.
      return { text: text.slice(0, entries[i - n + 1].index), trimmed: true, repeatWord: i + 1 };
    }
  }
  return { text, trimmed: false };
}

module.exports = { createStreamLoopGuard, trimLoop, hashWord };
