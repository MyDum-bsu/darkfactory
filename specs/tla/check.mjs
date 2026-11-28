// TLC gate: a clean base and an exact, named safety counterexample per mutant.
import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const spec = join(here, 'ControllerProtocol.tla');
const walMutants = ['SingleLiveWriter', 'NoDuplicateSpawn', 'NoStaleCommit',
  'NoWatermarkRegression', 'NoBlindRoundClose'];
const productionMutants = { hc: 'HcReceiptAttested', scope: 'ScopeLocksDisjoint',
  review: 'MergeReviewed', owner: 'MergeAuthorized', cas: 'MergeHeadCurrent', smoke: 'RebaseSmokePassed' };

export async function runTlc(module, config) {
  const jar = process.env.TLA_TOOLS_JAR;
  if (!jar || !isAbsolute(jar) || !(await stat(jar).catch(() => null))?.isFile()) {
    throw new Error('TLA_TOOLS_JAR must name the absolute path of an installed tla2tools.jar');
  }
  const scratch = await mkdtemp(join(tmpdir(), 'tlc-'));
  try {
    await copyFile(spec, join(scratch, 'ControllerProtocol.tla'));
    if (module !== spec) await copyFile(module, join(scratch, basename(module)));
    await writeFile(join(scratch, 'Model.cfg'), config);
    const args = ['-XX:+UseParallelGC', '-XX:ActiveProcessorCount=2', '-Xmx512m', '-jar', jar,
      '-workers', '1', '-deadlock', '-metadir', join(scratch, 'states'), '-config', 'Model.cfg', basename(module)];
    try {
      const r = await exec('java', args, { cwd: scratch, timeout: 25_000, maxBuffer: 4 << 20 });
      return { code: 0, out: r.stdout + r.stderr };
    } catch (e) {
      if (typeof e.code !== 'number') throw e;
      return { code: e.code, out: e.stdout + e.stderr };
    }
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

export function requireGreen({ code, out }) {
  if (code !== 0 || !out.includes('No error has been found')) {
    throw new Error(`TLC exit ${code}: ${out.slice(0, 2500)}\n${out.slice(-2500)}`);
  }
}

async function main() {
  const start = performance.now();
  const base = await readFile(join(here, 'ControllerProtocol.cfg'), 'utf8');
  const safety = Object.values(productionMutants).map(i => `INVARIANT ${i}\n`).join('');
  requireGreen(await runTlc(spec, base + safety));
  console.log('base: OK');
  async function mutant(cfg, invariant) {
    const { code, out } = await runTlc(spec, cfg);
    const violations = [...out.matchAll(/Invariant (\w+) is violated\./g)].map(m => m[1]);
    if (code !== 12 || violations.length !== 1 || violations[0] !== invariant) {
      throw new Error(`expected exit 12 (${invariant}), got ${code}: ${out.slice(-2500)}`);
    }
    console.log(`mutant: OK (exit 12, ${invariant})`);
  }
  for (const [i, name] of walMutants.entries()) {
    await mutant(await readFile(join(here, `Mutant${i + 1}_${name}.cfg`), 'utf8'), name);
  }
  for (const [fault, name] of Object.entries(productionMutants)) {
    await mutant(`${base}${safety}CONSTANT ProductionFault = "${fault}"\n`, name);
  }
  const seconds = (performance.now() - start) / 1000;
  if (seconds > 30) throw new Error(`TLC budget exceeded: ${seconds.toFixed(1)}s > 30s`);
  console.log(`tla-check: 5/5 mutants caught (WAL), 6/6 production mutants caught, ${seconds.toFixed(1)}s`);
  // This is the existing integration entry point; do not leave trace tests orphaned.
  // conformance.test.mjs invokes this gate inside node:test. Inheriting its
  // child marker makes `node --test` silently skip the entire nested suite.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const test = await exec(process.execPath, ['--test', join(here, 'trace-validate.test.mjs')],
    { env, timeout: 30_000 }).catch(e => { throw new Error(`trace tests failed: ${e.stdout}\n${e.stderr}`); });
  process.stdout.write(test.stdout);
}

if (import.meta.main) await main();
