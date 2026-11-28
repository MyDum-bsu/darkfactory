import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { analyzeBlastRadius, CORE_SENSITIVE_PATHS, extractImports, formatBlastRadiusSummary } from './blast-radius.mjs';

function fixture(t, entries) {
  const repoRoot = mkdtempSync(join(tmpdir(), 'blast-radius-'));
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  for (const [path, source] of Object.entries(entries)) {
    const absolute = join(repoRoot, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, source);
  }
  return { repoRoot, analyze: (changedPaths, maxFiles) => analyzeBlastRadius({ repoRoot, changedPaths, maxFiles }) };
}

test('extracts only static relative JS module specifiers, in source order', () => {
  const source = `// import './comment';
    const url = 'https://example.invalid'; /* require('./also-comment') */
    import type { Thing } from './types';
    import './run'; import a, { b as c } /* comment */ from '../api';
    export * as b from './all'; export { thing } from './run';
    const x = require( /* gap */ './cjs.js' );
    const text = "import './example'"; const template = \`require('./other')\`;
    import('dynamic'); import('./dynamic'); require('./prefix' + id); obj.require('./method');
    import 'node:fs'; require('package'); import '/absolute';`;
  for (const ext of ['mjs', 'js', 'cjs', 'ts', 'jsx', 'tsx']) {
    assert.deepEqual(extractImports(source, `src/foo.${ext}`), ['./types', './run', '../api', './all', './cjs.js']);
  }
  assert.deepEqual(extractImports(source, 'not-code.txt'), []);
});

test('extracts Python modules without aliases, comments or docstring examples', () => {
  assert.deepEqual(extractImports(`"""Sample:\nimport fictional\n"""
    import a.b as ab, c  # import nope
    from a.b import value; from .foo import bar
    from ..pkg import (mod,\n other as alias)\n    # from .ignored import x`, 'a.py'),
  ['a.b', 'c', '.foo', '..pkg']);
});

test('JS cycles and mixed ESM/CJS/TS: two reverse hops, normalized roots, sorted unique results', t => {
  const { analyze } = fixture(t, {
    'src/core.ts': "import './ui';", // back edge to first-hop importer
    'src/ui/index.js': "export * from '../core';",
    'src/bridge.cjs': "module.exports = require('./core');",
    'src/ui.test.tsx': "import './ui'; import './bridge';",
    'spec/smoke.jsx': "import '../src/bridge';",
    'tests/third.js': "import '../spec/smoke.jsx';",
    'unrelated.spec.mjs': "// import './src/core';",
  });
  const report = analyze([' src\\core.ts ', 'src/./core.ts', '', 'tests/own.txt']);
  assert.deepEqual(report, {
    changedPaths: ['src/core.ts', 'tests/own.txt'], directImporters: ['src/bridge.cjs', 'src/ui/index.js'],
    transitiveDependents: ['spec/smoke.jsx', 'src/bridge.cjs', 'src/ui.test.tsx', 'src/ui/index.js'],
    affectedTests: ['spec/smoke.jsx', 'src/ui.test.tsx', 'tests/own.txt'], riskLevel: 'medium', truncated: false,
  });
  assert.ok(Object.isFrozen(report));
  assert.deepEqual(analyze(['src/core.ts', 'src/bridge.cjs']).directImporters,
    ['spec/smoke.jsx', 'src/ui.test.tsx', 'src/ui/index.js']);
});

test('JS extension and directory fallback choose one target in the specified order', t => {
  const { analyze } = fixture(t, {
    'main.js': "import './lib'; import './dir/'; require('./cjs');",
    'lib.mjs': '', 'lib.js': '', 'lib/index.js': '', 'cjs.cjs': '',
    'dir/index.mjs': '', 'dir/index.js': '',
  });
  for (const path of ['lib.mjs', 'dir/index.mjs', 'cjs.cjs']) {
    assert.deepEqual(analyze([path]).directImporters, ['main.js']);
  }
  assert.deepEqual(analyze(['lib.js', 'lib/index.js', 'dir/index.js']).directImporters, []);
});

test('resolves Python absolute and relative modules, package initializers, and from-imported submodules', t => {
  const { analyze } = fixture(t, {
    'pkg/lib/__init__.py': '', 'pkg/lib/mod.py': '',
    'pkg/abs.py': 'import pkg.lib.mod as mod', 'pkg/test_abs.py': 'from .abs import main',
    'pkg/sub/use.py': 'from ..lib import mod', 'pkg/sub/use_test.py': 'from . import use',
    'pkg/sub/attr.py': 'from pkg.lib import symbol',
  });
  const report = analyze(['pkg/lib/mod.py']);
  assert.deepEqual(report.directImporters, ['pkg/abs.py', 'pkg/sub/use.py']);
  assert.deepEqual(report.affectedTests, ['pkg/sub/use_test.py', 'pkg/test_abs.py']);
  assert.deepEqual(analyze(['pkg/lib/__init__.py']).directImporters, ['pkg/sub/attr.py', 'pkg/sub/use.py']);
});

test('empty changes and sensitive-path risk do not require importers', t => {
  const { analyze } = fixture(t, {});
  assert.deepEqual(analyze(), { changedPaths: [], directImporters: [], transitiveDependents: [],
    affectedTests: [], riskLevel: 'low', truncated: false });
  assert.equal(CORE_SENSITIVE_PATHS.size, 8);
  assert.ok(Object.isFrozen(CORE_SENSITIVE_PATHS));
  for (const path of CORE_SENSITIVE_PATHS) assert.equal(analyze([path]).riskLevel, 'high');
  const many = Array.from({ length: 11 }, (_, i) => `${i}.js`);
  assert.equal(analyze(many.slice(1)).riskLevel, 'low');
  assert.equal(analyze(many).riskLevel, 'high');
});

test('risk thresholds count distinct dependents at either hop', t => {
  for (const [first, second, expected] of [[1, 1, 'low'], [2, 0, 'medium'], [1, 2, 'medium'], [1, 6, 'medium'], [1, 7, 'high']]) {
    const files = { 'lib.mjs': '' };
    for (let i = 0; i < first; i++) files[`a${i}.js`] = "require('./lib');";
    for (let i = 0; i < second; i++) files[`b${i}.js`] = "require('./a0');";
    assert.equal(fixture(t, files).analyze(['lib.mjs']).riskLevel, expected);
  }
});

test('walk skips symlinks and build/cache directories; cap picks a deterministic prefix', t => {
  const files = { 'z.js': "import './a';", 'b.js': "import './a';", 'a.js': '' };
  for (const dir of ['.git', 'node_modules', '__pycache__', '.venv', 'dist', 'build', 'out', '.pytest_cache', '.mypy_cache', '.ruff_cache']) {
    files[`${dir}/caller.js`] = "import '../a';";
  }
  const { repoRoot, analyze } = fixture(t, files);
  symlinkSync('z.js', join(repoRoot, '0-link.js'));
  symlinkSync('.', join(repoRoot, '0-cycle'));
  assert.deepEqual(analyze(['a.js']).directImporters, ['b.js', 'z.js']);
  const limited = analyze(['a.js'], 2);
  assert.deepEqual(limited.directImporters, ['b.js']);
  assert.equal(limited.truncated, true);
  assert.equal(analyze([], 0).truncated, true);
});

test('summary includes separate bounded samples and counts even for long paths', t => {
  const report = fixture(t, { 'a.js': '', 'a.test.js': "import './a';" }).analyze(['a.js']);
  const summary = formatBlastRadiusSummary(report);
  for (const expected of ['low risk', 'Changed: 1', 'direct importers: 1', 'affected tests: 1',
    'Top direct importers: a.test.js', 'Affected tests: a.test.js']) assert.ok(summary.includes(expected));
  const long = Array(12).fill('p'.repeat(1000));
  long.length = 2 ** 32 - 1; // Maximum count width without allocating billions of paths.
  const bounded = formatBlastRadiusSummary({ changedPaths: long, directImporters: long, transitiveDependents: long,
    affectedTests: long, riskLevel: 'high', truncated: true });
  assert.ok(bounded.length <= 800);
  assert.match(bounded, /scan truncated/);
  assert.match(bounded, /Affected tests: p/);
});
