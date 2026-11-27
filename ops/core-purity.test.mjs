import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { analyzeWiring } from './df-map.mjs';

const writeModule = (root, path, content) => {
  const absolute = join(root, ...path.split('/'));
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content, 'utf8');
};

test('analyzeWiring detects a board_pipeline to ops reverse leak on a synthetic fixture', t => {
  const root = mkdtempSync(join(tmpdir(), 'df-core-purity-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeModule(root, 'ops/df-entry.mjs', "import '../board_pipeline/worker.mjs';\n");
  writeModule(root, 'ops/local/check-workspace-space.mjs', 'export const checkBudget = true;\n');
  writeModule(root, 'board_pipeline/worker.mjs', "import { checkBudget } from '../ops/local/check-workspace-space.mjs';\nvoid checkBudget;\n");
  writeModule(root, 'board_pipeline/clean.mjs', 'export const clean = true;\n');

  const report = analyzeWiring(root);
  assert.deepEqual(report.reverseLeaks, ['board_pipeline/worker.mjs']);
  assert.deepEqual(report.reverseLeakEdges, [{
    path: 'board_pipeline/worker.mjs',
    target: 'ops/local/check-workspace-space.mjs',
    specifier: '../ops/local/check-workspace-space.mjs',
  }]);
});

test('real repository has no board_pipeline to ops reverse leaks', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const report = analyzeWiring(root);
  assert.deepEqual(report.reverseLeaks, []);
  assert.deepEqual(report.reverseLeakEdges, []);
});
