import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';

export const CORE_SENSITIVE_PATHS = Object.freeze(new Set([
  'board_pipeline/acceptance.mjs', 'board_pipeline/controller.mjs',
  'board_pipeline/tamper-gate.mjs', 'board_pipeline/scope-fence.mjs',
  'board_pipeline/pi-guard.cjs', 'board_pipeline/cmd-guard.mjs',
  'board_pipeline/agy-landlock.py', 'board_pipeline/review-runner.mjs',
]));

const SKIP = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'dist', 'build', 'out',
  '.pytest_cache', '.mypy_cache', '.ruff_cache']);
const JS = new Set(['.mjs', '.js', '.cjs', '.ts', '.tsx', '.jsx']);
const TEST_PATH = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[a-z]+$|(^|\/)test_[^/]*\.py$|_test\.py$/;

// Tokenize literals as units, so comment markers inside strings (and examples of
// imports inside ordinary strings/templates) cannot become import declarations.
function jsImports(source, emit) {
  const lexer = /\/\/[^\r\n]*|\/\*[\s\S]*?(?:\*\/|$)|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`|[\w$]+|[^\s]/g;
  const tokens = (source.match(lexer) ?? []).filter(t => !t.startsWith('//') && !t.startsWith('/*'));
  const isName = t => t != null && /^[\w$]+$/.test(t);
  function emitLiteral(t) {
    if (t && /^["']\.{1,2}(?:\/|["']$)/.test(t)) emit(t.slice(1, -1));
  }
  for (let i = 0; i < tokens.length; i++) {
    const keyword = tokens[i];
    if (tokens[i - 1] === '.') continue;
    let j = i + 1;
    if (keyword === 'require' && tokens[j] === '(' && tokens[j + 2] === ')') {
      emitLiteral(tokens[j + 1]);
    } else if (keyword === 'import' || keyword === 'export') {
      if (keyword === 'import') emitLiteral(tokens[j]); // side-effect import
      if (tokens[j] === 'type' && tokens[j + 1] !== 'from') j++;
      if (keyword === 'import' && isName(tokens[j])) {
        j++;
        if (tokens[j] === ',') j++;
      }
      if (tokens[j] === '*') {
        j++;
        if (tokens[j] === 'as' && isName(tokens[j + 1])) j += 2;
      } else if (tokens[j] === '{') {
        j++;
        while (isName(tokens[j]) || tokens[j] === ',' || /^["']/.test(tokens[j])) j++;
        if (tokens[j] !== '}') continue;
        j++;
      }
      if (tokens[j] === 'from') emitLiteral(tokens[j + 1]);
    }
  }
}

function pyImports(source, emit) {
  // Mask comments and strings, including multiline docstrings, before matching
  // statements. Preserve newlines so an unrelated line cannot extend an import.
  const code = source.replace(/#[^\r\n]*|('''|""")[\s\S]*?\1|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"/g,
    s => s.replace(/[^\r\n]/g, ' ')).replace(/\\\r?\n/g, ' ');
  const statements = /(?:^|[;:])[ \t]*(?:from[ \t]+([\w.]+)[ \t]+)?import\b[ \t]*(\([^)]*\)|[\w.]+(?:[ \t]+as[ \t]+\w+)?(?:[ \t]*,[ \t]*[\w.]+(?:[ \t]+as[ \t]+\w+)?)*|\*)/gm;
  for (const [, base, clause] of code.matchAll(statements)) {
    for (const item of clause.replace(/[()]/g, '').split(',')) {
      const name = item.trim().split(/\s+/)[0];
      if (name) emit(base ?? name, base && name !== '*' ? name : undefined);
    }
  }
}

function visitImports(source, relPath, emit) {
  const ext = posix.extname(relPath);
  if (ext === '.py') pyImports(source, emit);
  else if (JS.has(ext)) jsImports(source, emit);
}

/** Raw module specifiers, in first-appearance order (no filesystem lookup). */
export function extractImports(source, relPath) {
  const specs = new Set();
  visitImports(source, relPath, spec => specs.add(spec));
  return [...specs];
}

function indexFiles(root, cap) {
  const files = new Set();
  function walk(rel) {
    if (files.size >= cap) return;
    const absolute = join(root, rel);
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) return;
    if (stat.isFile()) files.add(rel);
    else if (stat.isDirectory() && !SKIP.has(posix.basename(rel))) {
      for (const name of readdirSync(absolute).sort()) {
        walk(posix.join(rel, name));
        if (files.size >= cap) break;
      }
    }
  }
  walk('');
  return files;
}

function jsTarget(importer, spec, files) {
  const base = posix.join(posix.dirname(importer), spec);
  const candidates = spec.endsWith('/') || spec === '.' || spec === '..' ? []
    : ['', '.mjs', '.js', '.cjs', '.ts'].map(suffix => base + suffix);
  return [...candidates, posix.join(base, 'index.mjs'), posix.join(base, 'index.js')]
    .find(path => files.has(path));
}

function pyTarget(importer, spec, files) {
  const dots = spec.match(/^\.+/)?.[0].length ?? 0;
  const dir = dots ? posix.join(posix.dirname(importer), '../'.repeat(dots - 1)) : '.';
  const base = posix.join(dir, spec.slice(dots).replaceAll('.', '/'));
  return [posix.join(base, '__init__.py'), base + '.py'].find(path => files.has(path));
}

function reverseGraph(repoRoot, files) {
  const graph = new Map();
  for (const importer of files) {
    const ext = posix.extname(importer);
    if (ext !== '.py' && !JS.has(ext)) continue;
    function link(target) {
      if (!target) return;
      if (!graph.has(target)) graph.set(target, new Set());
      graph.get(target).add(importer);
    }
    visitImports(readFileSync(join(repoRoot, importer), 'utf8'), importer, (spec, member) => {
      if (ext !== '.py') return link(jsTarget(importer, spec, files));
      link(pyTarget(importer, spec, files));
      // A from-import may name a submodule rather than an attribute of the base.
      if (member) link(pyTarget(importer, spec + (spec.endsWith('.') ? '' : '.') + member, files));
    });
  }
  return graph;
}

const sorted = items => Object.freeze([...items].sort());

export function analyzeBlastRadius({ repoRoot = '.', changedPaths = [], maxFiles = 2000 } = {}) {
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 0) throw new RangeError('maxFiles must be a non-negative integer');
  const changed = new Set(changedPaths.map(path => path.trim().replaceAll('\\', '/'))
    .filter(Boolean).map(path => posix.normalize(path)));
  const files = indexFiles(repoRoot, maxFiles);
  const graph = reverseGraph(repoRoot, files);
  const dependents = new Set();
  function expand(frontier) {
    const next = new Set();
    for (const path of frontier) {
      for (const caller of graph.get(path) ?? []) {
        if (!changed.has(caller) && !dependents.has(caller)) {
          dependents.add(caller);
          next.add(caller);
        }
      }
    }
    return next;
  }
  const direct = expand(changed);
  expand(direct);
  const high = changed.size > 10 || dependents.size >= 8 || [...changed].some(path => CORE_SENSITIVE_PATHS.has(path));
  const medium = direct.size >= 2 || dependents.size >= 3;
  return Object.freeze({
    changedPaths: sorted(changed), directImporters: sorted(direct), transitiveDependents: sorted(dependents),
    affectedTests: sorted([...changed, ...dependents].filter(path => TEST_PATH.test(path))),
    riskLevel: high ? 'high' : medium ? 'medium' : 'low', truncated: files.size >= maxFiles,
  });
}

export function formatBlastRadiusSummary(report) {
  const { changedPaths, directImporters, transitiveDependents, affectedTests, riskLevel, truncated } = report;
  const sample = paths => paths.slice(0, 3).map(path => {
    const label = path.replace(/[\x00-\x1f\x7f]/g, '?');
    return label.length > 80 ? label.slice(0, 77) + '...' : label;
  }).join(', ') || 'none';
  return `Blast radius: ${riskLevel} risk${truncated ? ' (scan truncated)' : ''}. Changed: ${changedPaths.length}; ` +
    `direct importers: ${directImporters.length}; dependents (up to 2 hops): ${transitiveDependents.length}; affected tests: ${affectedTests.length}.\n` +
    `Top direct importers: ${sample(directImporters)}\nAffected tests: ${sample(affectedTests)}`;
}
