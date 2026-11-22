// Прогон TLC по базовой модели и пяти парным мутантам.
// База: exit 0 и "No error has been found".
// Каждый мутант: строго exit 12 и точная строка "Invariant <Name> is violated."
// «Любая ошибка» мутантом не считается — только ожидаемый инвариант.

import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const SPEC = join(here, 'ControllerProtocol.tla');

const JAR_CANDIDATES = [
  process.env.TLA_TOOLS_JAR,
  '/home/mydum/.local/share/tlaplus/tla2tools.jar',
  '/home/mydum/.cache/bsu-tlc/v1.7.4/tla2tools.jar',
].filter(Boolean);
const JAR = JAR_CANDIDATES.find(p => existsSync(p));
if (!JAR) {
  console.error('tla-check: tla2tools.jar not found');
  process.exit(1);
}

const MUTANTS = [
  ['Mutant1_SingleLiveWriter.cfg', 'SingleLiveWriter'],
  ['Mutant2_NoDuplicateSpawn.cfg', 'NoDuplicateSpawn'],
  ['Mutant3_NoStaleCommit.cfg', 'NoStaleCommit'],
  ['Mutant4_NoWatermarkRegression.cfg', 'NoWatermarkRegression'],
  ['Mutant5_NoBlindRoundClose.cfg', 'NoBlindRoundClose'],
];

async function tlc(cfg) {
  const metadir = await mkdtemp(join(tmpdir(), 'tla-metadir-'));
  try {
    const run = await exec('java',
      ['-XX:+UseParallelGC', '-Xmx512m', '-jar', JAR, '-workers', '1', '-deadlock',
        '-metadir', metadir, '-config', join(here, cfg), SPEC],
      { timeout: 25_000, maxBuffer: 16 * 1024 * 1024 })
      .then(r => ({ code: 0, out: r.stdout + r.stderr }))
      .catch(e => ({ code: typeof e.code === 'number' ? e.code : -1, out: (e.stdout ?? '') + (e.stderr ?? '') }));
    return run;
  } finally {
    await rm(metadir, { recursive: true, force: true });
  }
}

const started = Date.now();
const failures = [];

const base = await tlc('ControllerProtocol.cfg');
if (base.code !== 0 || !base.out.includes('No error has been found')) {
  failures.push(`base: exit=${base.code}, expected 0 and "No error has been found"\n${base.out.slice(-2000)}`);
} else {
  const states = /(\d[\d,]*) distinct states/.exec(base.out)?.[1] ?? '?';
  console.log(`base: OK (${states} distinct states)`);
}

for (const [cfg, invariant] of MUTANTS) {
  const res = await tlc(cfg);
  const expected = `Invariant ${invariant} is violated.`;
  if (res.code === 12 && res.out.includes(expected)) {
    console.log(`${cfg}: OK (exit 12, ${invariant})`);
  } else {
    failures.push(`${cfg}: exit=${res.code}, expected 12 and "${expected}"\n${res.out.slice(-2000)}`);
  }
}

const elapsed = ((Date.now() - started) / 1000).toFixed(1);
if (failures.length) {
  console.error(`tla-check: FAILED in ${elapsed}s`);
  for (const f of failures) console.error(`---\n${f}`);
  process.exit(1);
}
if (Date.now() - started > 30_000) {
  console.error(`tla-check: budget exceeded (${elapsed}s > 30s)`);
  process.exit(1);
}
console.log(`tla-check: 1/1 base green, 5/5 mutants caught, ${elapsed}s`);
