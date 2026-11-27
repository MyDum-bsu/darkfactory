import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { analyzeWiring, formatArchitectureMarkdown } from './df-map.mjs';

function writeModule(root, path, content) {
  const absolute = join(root, ...path.split('/'));
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content, 'utf8');
}

function tempRepo(t) {
  const root = mkdtempSync(join(tmpdir(), 'df-map-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('analyzeWiring walks relative imports and re-exports while excluding tests and fixtures', t => {
  const root = tempRepo(t);
  writeModule(root, 'ops/factory-run.mjs', `import {
  core,
} from '../board_pipeline/core.mjs';
export { helper } from './helper.mjs';
// import fakeComment from './fake.mjs';
const example = "import fakeString from './fake2.mjs'";
void core;
void example;
`);
  writeModule(root, 'ops/df-tool.mjs', 'export const standalone = true;\n');
  writeModule(root, 'ops/helper.mjs', 'export const helper = 1;\n');
  writeModule(root, 'ops/fake.mjs', 'export const fake = 1;\n');
  writeModule(root, 'ops/fake2.mjs', 'export const fake2 = 1;\n');
  writeModule(root, 'ops/orphan.mjs', 'export const orphan = 1;\n');
  writeModule(root, 'ops/not-production.test.mjs', 'export const testOnly = 1;\n');
  writeModule(root, 'board_pipeline/core.mjs', "export * from './re-export.mjs';\nexport const core = 1;\n");
  writeModule(root, 'board_pipeline/re-export.mjs', "export { leaf } from './leaf.mjs';\n");
  writeModule(root, 'board_pipeline/leaf.mjs', 'export const leaf = 1;\n');
  writeModule(root, 'board_pipeline/orphan.mjs', "import { helper } from '../ops/helper.mjs';\nexport const orphan = helper;\n");
  writeModule(root, 'board_pipeline/sample-fixture.mjs', 'export const fixture = 1;\n');

  const report = analyzeWiring(root);
  assert.deepEqual(report.wired, [
    'board_pipeline/core.mjs',
    'board_pipeline/leaf.mjs',
    'board_pipeline/re-export.mjs',
    'ops/df-tool.mjs',
    'ops/factory-run.mjs',
    'ops/helper.mjs',
  ]);
  assert.deepEqual(report.unwired, [
    'board_pipeline/orphan.mjs',
    'ops/fake.mjs',
    'ops/fake2.mjs',
    'ops/orphan.mjs',
  ]);
  assert.deepEqual(report.reverseLeaks, ['board_pipeline/orphan.mjs']);
  assert.deepEqual(report.reverseLeakEdges, [{
    path: 'board_pipeline/orphan.mjs',
    target: 'ops/helper.mjs',
    specifier: '../ops/helper.mjs',
  }]);
  assert.equal(report.productionFiles.includes('ops/not-production.test.mjs'), false);
  assert.equal(report.productionFiles.includes('board_pipeline/sample-fixture.mjs'), false);
  assert.deepEqual(report.edges.find(edge => edge.from === 'ops/factory-run.mjs' && edge.to === 'ops/helper.mjs'), {
    from: 'ops/factory-run.mjs',
    to: 'ops/helper.mjs',
    specifier: './helper.mjs',
  });
});

test('analyzeWiring resolves extensionless relative imports and reports exact large-file LOC', t => {
  const root = tempRepo(t);
  writeModule(root, 'ops/factory-run.mjs', "import { core } from '../board_pipeline/core';\nvoid core;\n");
  writeModule(root, 'board_pipeline/core.mjs', 'export const core = 1;\n');
  writeModule(root, 'ops/large.mjs', '// exact line\n'.repeat(701));
  writeModule(root, 'ops/large.test.mjs', '// test line\n'.repeat(900));

  const report = analyzeWiring(root);
  assert.equal(report.wired.includes('board_pipeline/core.mjs'), true);
  assert.deepEqual(report.largeFiles, [{ path: 'ops/large.mjs', lines: 701 }]);
});

test('analyzeWiring is deterministic on the real repository and formatArchitectureMarkdown is stable', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const report = analyzeWiring(root);
  for (const entrypoint of [
    'board_pipeline/run-isolated.mjs',
    'ops/factory-run.mjs',
    'ops/control-room/aggregator.mjs',
    'ops/df-map.mjs',
  ]) {
    assert.equal(report.entrypoints.includes(entrypoint), true, entrypoint);
    assert.equal(report.wired.includes(entrypoint), true, entrypoint);
  }
  assert.equal(report.wired.includes('board_pipeline/controller.mjs'), true);
  assert.equal(report.wired.includes('board_pipeline/worker-runtime.mjs'), true);
  assert.equal(report.wired.includes('ops/local/check-workspace-space.mjs'), true);
  assert.equal(report.wired.some(path => path.includes('.test.')), false);
  assert.equal(report.wired.some(path => path.endsWith('-fixture.mjs')), false);
  assert.deepEqual(report.wired, [...report.wired].sort());
  assert.deepEqual(report.unwired, [...report.unwired].sort());
  assert.ok(report.largeFiles.some(file => file.path === 'board_pipeline/run-isolated.mjs' && file.lines > 700));

  const markdown = formatArchitectureMarkdown(report);
  assert.equal(markdown, formatArchitectureMarkdown(report));
  assert.match(markdown, /```mermaid\nflowchart LR/);
  assert.match(markdown, /## Wiring inventory/);
  assert.match(markdown, /### Reverse leaks/);
  assert.match(markdown, /`board_pipeline\/run-isolated\.mjs`/);
});
