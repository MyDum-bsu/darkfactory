// ESM-обёртка над loop-detector.cjs: детектор нужен и в CJS-контуре
// (agy-stream.cjs — стрим Neon), и в ESM (review-runner.mjs). Единая
// реализация живёт в .cjs, здесь — только реэкспорт.
import detector from './loop-detector.cjs';

export const { createStreamLoopGuard, trimLoop, hashWord } = detector;
export default detector;
