#!/usr/bin/env node
// df-map — deterministic wiring census for the production ESM graph.
// The library functions are pure filesystem readers; CLI effects are confined
// to stdout and the explicitly requested generated document.

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { posix } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

const MODULE_EXTENSIONS = new Set(['.mjs', '.cjs', '.js']);
const SKIPPED_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  'out',
  'review-jobs',
  'journal',
  '__pycache__',
  '.pytest_cache',
]);

const FIXED_ENTRYPOINTS = Object.freeze([
  'ops/factory-run.mjs',
  'ops/factory-enqueue.mjs',
  'ops/check-host.mjs',
  'ops/control-room/aggregator.mjs',
  'ops/control-room/df-herd.mjs',
  'ops/herdr/deploy-herdr.mjs',
  'board_pipeline/daemon.mjs',
  'board_pipeline/run-isolated.mjs',
  'board_pipeline/run-release-watch.mjs',
]);

const compareString = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const sortStrings = values => [...values].sort(compareString);

function isProductionModule(path) {
  const name = posix.basename(path);
  if (!MODULE_EXTENSIONS.has(posix.extname(name))) return false;
  if (/\.test\.[^/]+$/.test(name)) return false;
  if (name.endsWith('-fixture.mjs')) return false;
  return true;
}

function countLines(source) {
  if (source.length === 0) return 0;
  let lines = 0;
  for (const character of source) if (character === '\n') lines += 1;
  return source.endsWith('\n') ? lines : lines + 1;
}

function walkModuleFiles(rootDir) {
  const files = [];
  const directories = new Set(['.']);
  const walk = relativeDirectory => {
    const absoluteDirectory = relativeDirectory === '.' ? rootDir : join(rootDir, relativeDirectory);
    const entries = readdirSync(absoluteDirectory, { withFileTypes: true })
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
      const relativePath = relativeDirectory === '.' ? entry.name : posix.join(relativeDirectory, entry.name);
      if (entry.isDirectory()) {
        directories.add(relativePath);
        walk(relativePath);
      } else if (entry.isFile() && MODULE_EXTENSIONS.has(posix.extname(entry.name))) {
        files.push(relativePath);
      }
    }
  };
  walk('.');
  return { files: sortStrings(files), directories };
}

const identifierStart = character => /[A-Za-z_$]/.test(character ?? '');
const identifierPart = character => /[A-Za-z0-9_$]/.test(character ?? '');

function skipLineComment(source, index) {
  const end = source.indexOf('\n', index + 2);
  return end === -1 ? source.length : end + 1;
}

function skipBlockComment(source, index) {
  const end = source.indexOf('*/', index + 2);
  return end === -1 ? source.length : end + 2;
}

function skipComment(source, index) {
  if (source[index] === '/' && source[index + 1] === '/') return skipLineComment(source, index);
  if (source[index] === '/' && source[index + 1] === '*') return skipBlockComment(source, index);
  return index;
}

function skipQuoted(source, index) {
  const quote = source[index];
  let cursor = index + 1;
  while (cursor < source.length) {
    if (source[cursor] === '\\') {
      cursor += 2;
      continue;
    }
    if (source[cursor] === quote) return cursor + 1;
    cursor += 1;
  }
  return cursor;
}

function readSimpleString(source, index) {
  const quote = source[index];
  if (quote !== '\'' && quote !== '"') return null;
  let value = '';
  let cursor = index + 1;
  while (cursor < source.length) {
    if (source[cursor] === '\\') {
      value += source[cursor + 1] ?? '';
      cursor += 2;
      continue;
    }
    if (source[cursor] === quote) return { value, end: cursor + 1 };
    value += source[cursor];
    cursor += 1;
  }
  return null;
}

function skipWhitespaceAndComments(source, index) {
  let cursor = index;
  for (;;) {
    while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1;
    const afterComment = skipComment(source, cursor);
    if (afterComment === cursor) return cursor;
    cursor = afterComment;
  }
}

function readIdentifier(source, index) {
  if (!identifierStart(source[index])) return null;
  let cursor = index + 1;
  while (identifierPart(source[cursor])) cursor += 1;
  return { word: source.slice(index, cursor), end: cursor };
}

function readImportSpecifier(source, start) {
  let cursor = skipWhitespaceAndComments(source, start);
  if (source[cursor] === '(' || source[cursor] === '.') return null;
  if (source[cursor] === '\'' || source[cursor] === '"') return readSimpleString(source, cursor);
  while (cursor < source.length) {
    cursor = skipWhitespaceAndComments(source, cursor);
    if (source[cursor] === ';' || cursor >= source.length) return null;
    if (source[cursor] === '\'' || source[cursor] === '"' || source[cursor] === '`') {
      cursor = skipQuoted(source, cursor);
      continue;
    }
    const identifier = readIdentifier(source, cursor);
    if (identifier) {
      if (identifier.word === 'from') {
        const afterFrom = skipWhitespaceAndComments(source, identifier.end);
        return readSimpleString(source, afterFrom);
      }
      cursor = identifier.end;
      continue;
    }
    cursor += 1;
  }
  return null;
}

function readExportSpecifier(source, start) {
  let cursor = skipWhitespaceAndComments(source, start);
  const first = source[cursor];
  if (first !== '*' && first !== '{') return null;

  if (first === '{') {
    let depth = 0;
    while (cursor < source.length) {
      cursor = skipWhitespaceAndComments(source, cursor);
      if (source[cursor] === '\'' || source[cursor] === '"' || source[cursor] === '`') {
        cursor = skipQuoted(source, cursor);
        continue;
      }
      if (source[cursor] === '{') depth += 1;
      if (source[cursor] === '}') {
        depth -= 1;
        if (depth === 0) {
          cursor = skipWhitespaceAndComments(source, cursor + 1);
          const keyword = readIdentifier(source, cursor);
          if (keyword?.word !== 'from') return null;
          cursor = skipWhitespaceAndComments(source, keyword.end);
          return readSimpleString(source, cursor);
        }
      }
      if (source[cursor] === ';' && depth <= 0) return null;
      cursor += 1;
    }
    return null;
  }

  while (cursor < source.length) {
    cursor = skipWhitespaceAndComments(source, cursor);
    if (source[cursor] === ';') return null;
    if (source[cursor] === '\'' || source[cursor] === '"' || source[cursor] === '`') {
      cursor = skipQuoted(source, cursor);
      continue;
    }
    const identifier = readIdentifier(source, cursor);
    if (identifier) {
      if (identifier.word === 'from') {
        const afterFrom = skipWhitespaceAndComments(source, identifier.end);
        return readSimpleString(source, afterFrom);
      }
      cursor = identifier.end;
      continue;
    }
    cursor += 1;
  }
  return null;
}

function keywordCanStartHere(source, index) {
  let cursor = index - 1;
  while (cursor >= 0 && /\s/.test(source[cursor])) cursor -= 1;
  return cursor < 0 || (source[cursor] !== '.' && !identifierPart(source[cursor]));
}

export function extractStaticSpecifiers(source) {
  const specifiers = [];
  let cursor = 0;
  while (cursor < source.length) {
    const commentEnd = skipComment(source, cursor);
    if (commentEnd !== cursor) {
      cursor = commentEnd;
      continue;
    }
    if (source[cursor] === '\'' || source[cursor] === '"' || source[cursor] === '`') {
      cursor = skipQuoted(source, cursor);
      continue;
    }
    const identifier = readIdentifier(source, cursor);
    if (identifier) {
      if ((identifier.word === 'import' || identifier.word === 'export') && keywordCanStartHere(source, cursor)) {
        const result = identifier.word === 'import'
          ? readImportSpecifier(source, identifier.end)
          : readExportSpecifier(source, identifier.end);
        if (result?.value) specifiers.push(result.value);
      }
      cursor = identifier.end;
      continue;
    }
    cursor += 1;
  }
  return specifiers;
}

function resolveLogicalSpecifier(fromPath, specifier) {
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) return null;
  const target = posix.normalize(posix.join(posix.dirname(fromPath), specifier));
  if (target === '..' || target.startsWith('../') || posix.isAbsolute(target)) return null;
  return target;
}

function resolveModuleSpecifier(fromPath, specifier, moduleFiles, directories) {
  const logicalTarget = resolveLogicalSpecifier(fromPath, specifier);
  if (!logicalTarget) return null;
  const candidates = [];
  if (MODULE_EXTENSIONS.has(posix.extname(logicalTarget))) {
    candidates.push(logicalTarget);
  } else {
    if (moduleFiles.has(logicalTarget)) candidates.push(logicalTarget);
    for (const extension of ['.mjs', '.js', '.cjs']) candidates.push(`${logicalTarget}${extension}`);
    if (directories.has(logicalTarget) || specifier.endsWith('/')) {
      for (const extension of ['.mjs', '.js', '.cjs']) candidates.push(posix.join(logicalTarget, `index${extension}`));
    }
  }
  const resolved = candidates.find(candidate => moduleFiles.has(candidate));
  return {
    path: resolved ?? null,
    logicalPath: resolved ?? candidates[0] ?? logicalTarget,
    exists: Boolean(resolved),
  };
}

function discoverEntrypoints(productionFiles) {
  const production = new Set(productionFiles);
  const entrypoints = new Set();
  for (const path of FIXED_ENTRYPOINTS) if (production.has(path)) entrypoints.add(path);
  for (const path of productionFiles) {
    if (/^ops\/df-[^/]*\.mjs$/.test(path)) entrypoints.add(path);
  }
  return sortStrings(entrypoints);
}

function compareEdge(left, right) {
  return compareString(left.from, right.from)
    || compareString(left.to, right.to)
    || compareString(left.specifier, right.specifier);
}

function compareReverseLeak(left, right) {
  return compareString(left.path, right.path)
    || compareString(left.target, right.target)
    || compareString(left.specifier, right.specifier);
}

export function analyzeWiring(rootDir) {
  if (typeof rootDir !== 'string' || rootDir.length === 0) throw new Error('rootDir is required');
  const root = resolve(rootDir);
  const { files: moduleFilesList, directories } = walkModuleFiles(root);
  const moduleFiles = new Set(moduleFilesList);
  const productionFiles = moduleFilesList.filter(isProductionModule);
  const productionSet = new Set(productionFiles);
  const entrypoints = discoverEntrypoints(productionFiles);

  const edgeKeys = new Set();
  const edges = [];
  const leakKeys = new Set();
  const reverseLeakFiles = new Set();
  const reverseLeakEdges = [];
  const lineCounts = new Map();

  for (const path of productionFiles) {
    const absolutePath = join(root, ...path.split(posix.sep));
    const source = readFileSync(absolutePath, 'utf8');
    lineCounts.set(path, countLines(source));
    for (const specifier of extractStaticSpecifiers(source)) {
      const resolution = resolveModuleSpecifier(path, specifier, moduleFiles, directories);
      if (!resolution) continue;
      if (resolution.path && productionSet.has(resolution.path)) {
        const key = `${path}\0${resolution.path}`;
        if (!edgeKeys.has(key)) {
          edgeKeys.add(key);
          edges.push({ from: path, to: resolution.path, specifier });
        }
      }
      if (path.startsWith('board_pipeline/') && resolution.logicalPath.startsWith('ops/')) {
        reverseLeakFiles.add(path);
        const key = `${path}\0${resolution.logicalPath}`;
        if (!leakKeys.has(key)) {
          leakKeys.add(key);
          reverseLeakEdges.push({ path, target: resolution.logicalPath, specifier });
        }
      }
    }
  }
  edges.sort(compareEdge);
  reverseLeakEdges.sort(compareReverseLeak);
  const reverseLeaks = sortStrings(reverseLeakFiles);

  const outgoing = new Map();
  for (const edge of edges) {
    if (!outgoing.has(edge.from)) outgoing.set(edge.from, []);
    outgoing.get(edge.from).push(edge.to);
  }

  const wiredSet = new Set(entrypoints);
  const queue = [...entrypoints];
  for (let index = 0; index < queue.length; index += 1) {
    for (const target of outgoing.get(queue[index]) ?? []) {
      if (wiredSet.has(target)) continue;
      wiredSet.add(target);
      queue.push(target);
    }
  }
  const wired = sortStrings(wiredSet);
  const boardAndOpsProduction = productionFiles.filter(path =>
    path.startsWith('board_pipeline/') || path.startsWith('ops/'));
  const unwired = boardAndOpsProduction.filter(path => !wiredSet.has(path));
  const largeFiles = productionFiles
    .map(path => ({ path, lines: lineCounts.get(path) }))
    .filter(entry => entry.lines > 700)
    .sort((left, right) => compareString(left.path, right.path));

  return {
    rootDir: root,
    entrypoints,
    productionFiles,
    wired,
    unwired,
    reverseLeaks,
    reverseLeakEdges,
    largeFiles,
    edges,
    totals: {
      productionFiles: productionFiles.length,
      entrypoints: entrypoints.length,
      wired: wired.length,
      unwired: unwired.length,
      reverseLeaks: reverseLeaks.length,
      largeFiles: largeFiles.length,
      edges: edges.length,
    },
  };
}

const CATEGORY_ORDER = [
  'entryPipeline',
  'entryOps',
  'entryControl',
  'corePipeline',
  'boardSupport',
  'opsControl',
  'opsLocal',
  'opsTools',
  'repoModules',
];

const CATEGORY_INFO = Object.freeze({
  entryPipeline: { id: 'entry_pipeline', label: 'Pipeline entrypoints' },
  entryOps: { id: 'entry_ops', label: 'Ops CLI entrypoints' },
  entryControl: { id: 'entry_control', label: 'Control Room entrypoints' },
  corePipeline: { id: 'core_pipeline', label: 'Core controller and runtime' },
  boardSupport: { id: 'board_support', label: 'Board pipeline support' },
  opsControl: { id: 'ops_control', label: 'Control Room modules' },
  opsLocal: { id: 'ops_local', label: 'Operator/local modules' },
  opsTools: { id: 'ops_tools', label: 'Other ops modules' },
  repoModules: { id: 'repo_modules', label: 'Other repository modules' },
});

const CORE_PIPELINE_FILES = new Set([
  'acceptance.mjs',
  'controller.mjs',
  'daemon.mjs',
  'native-board.mjs',
  'review-runner.mjs',
  'run-isolated.mjs',
  'run-release-watch.mjs',
  'scope-fence.mjs',
  'slot.mjs',
  'tamper-gate.mjs',
  'worker-runtime.mjs',
]);

function categoryFor(path, entrypointSet) {
  if (entrypointSet.has(path)) {
    if (path.startsWith('board_pipeline/')) return 'entryPipeline';
    if (path.startsWith('ops/control-room/')) return 'entryControl';
    return 'entryOps';
  }
  if (path.startsWith('board_pipeline/')) {
    return CORE_PIPELINE_FILES.has(posix.basename(path)) ? 'corePipeline' : 'boardSupport';
  }
  if (path.startsWith('ops/control-room/')) return 'opsControl';
  if (path.startsWith('ops/local/')) return 'opsLocal';
  if (path.startsWith('ops/')) return 'opsTools';
  return 'repoModules';
}

function markdownList(paths) {
  if (paths.length === 0) return '_None._\n';
  return paths.map(path => `- \`${path}\``).join('\n') + '\n';
}

export function formatArchitectureMarkdown(report) {
  const entrypointSet = new Set(report.entrypoints);
  const wiredSet = new Set(report.wired);
  const categories = new Map();
  for (const path of report.wired) {
    const category = categoryFor(path, entrypointSet);
    categories.set(category, (categories.get(category) ?? 0) + 1);
  }

  const crossCategoryEdges = new Map();
  for (const edge of report.edges) {
    if (!wiredSet.has(edge.from) || !wiredSet.has(edge.to)) continue;
    const from = categoryFor(edge.from, entrypointSet);
    const to = categoryFor(edge.to, entrypointSet);
    if (from === to) continue;
    const key = `${from}\0${to}`;
    crossCategoryEdges.set(key, (crossCategoryEdges.get(key) ?? 0) + 1);
  }

  const presentCategories = CATEGORY_ORDER.filter(category => categories.has(category));
  const entryCategories = presentCategories.filter(category => category.startsWith('entry'));
  const moduleCategories = presentCategories.filter(category => !category.startsWith('entry'));
  const mermaid = ['flowchart LR'];
  if (entryCategories.length > 0) {
    mermaid.push('  subgraph entries["Production entrypoints"]');
    for (const category of entryCategories) {
      const info = CATEGORY_INFO[category];
      mermaid.push(`    ${info.id}["${info.label}<br/>${categories.get(category)} module${categories.get(category) === 1 ? '' : 's'}"]`);
    }
    mermaid.push('  end');
  }
  if (moduleCategories.length > 0) {
    mermaid.push('  subgraph modules["Reachable production modules"]');
    for (const category of moduleCategories) {
      const info = CATEGORY_INFO[category];
      mermaid.push(`    ${info.id}["${info.label}<br/>${categories.get(category)} module${categories.get(category) === 1 ? '' : 's'}"]`);
    }
    mermaid.push('  end');
  }
  const sortedCrossEdges = [...crossCategoryEdges.entries()].sort((left, right) => {
    const [leftFrom, leftTo] = left[0].split('\0');
    const [rightFrom, rightTo] = right[0].split('\0');
    return CATEGORY_ORDER.indexOf(leftFrom) - CATEGORY_ORDER.indexOf(rightFrom)
      || CATEGORY_ORDER.indexOf(leftTo) - CATEGORY_ORDER.indexOf(rightTo);
  });
  for (const [key, count] of sortedCrossEdges) {
    const [from, to] = key.split('\0');
    mermaid.push(`  ${CATEGORY_INFO[from].id} -->|${count} static import${count === 1 ? '' : 's'}| ${CATEGORY_INFO[to].id}`);
  }

  const reverseLeakEdges = report.reverseLeakEdges ?? [];
  const reverseRows = reverseLeakEdges.length === 0
    ? '_None._\n'
    : '| Importing file | Ops target | Specifier |\n|---|---|---|\n'
      + reverseLeakEdges.map(leak => `| \`${leak.path}\` | \`${leak.target}\` | \`${leak.specifier}\` |`).join('\n')
      + '\n';
  const largeRows = report.largeFiles.length === 0
    ? '_None._\n'
    : '| File | LOC |\n|---|---:|\n'
      + report.largeFiles.map(file => `| \`${file.path}\` | ${file.lines} |`).join('\n')
      + '\n';

  return `# Architecture Wiring Census

> Generated by \`node ops/df-map.mjs --write-doc\`. Do not edit manually; update the source wiring or the generator instead.

## Mermaid architecture diagram

\`\`\`mermaid
${mermaid.join('\n')}
\`\`\`

The diagram aggregates cross-category static ESM edges so cycles and fan-out remain readable. The inventory below is the exact deterministic census; test files and \`*-fixture.mjs\` files are excluded from production counts.

## Wiring inventory

| Metric | Count |
|---|---:|
| Production modules scanned | ${report.totals.productionFiles} |
| Entrypoints | ${report.totals.entrypoints} |
| Wired production modules | ${report.totals.wired} |
| Unwired production modules under \`board_pipeline/\` and \`ops/\` | ${report.totals.unwired} |
| \`board_pipeline/\` → \`ops/\` reverse leaks | ${report.totals.reverseLeaks} |
| Production files over 700 LOC | ${report.totals.largeFiles} |
| Static production graph edges | ${report.totals.edges} |

### Entrypoints (${report.entrypoints.length})

${markdownList(report.entrypoints)}
### Wired production modules (${report.wired.length})

${markdownList(report.wired)}
### Unwired production modules under board_pipeline/ and ops/ (${report.unwired.length})

${markdownList(report.unwired)}
### Reverse leaks (${report.reverseLeaks.length})

${reverseRows}
### Production files over 700 LOC (${report.largeFiles.length})

${largeRows}`;
}

function writeFileAtomic(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  try {
    writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx' });
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function parseDfMapArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: false,
    options: {
      json: { type: 'boolean', default: false },
      'write-doc': { type: 'boolean', default: false },
      root: { type: 'string', default: process.cwd() },
    },
  });
  return values;
}

export function runDfMap(argv = process.argv.slice(2)) {
  const options = parseDfMapArgs(argv);
  const report = analyzeWiring(options.root);
  let wroteDocument = false;
  if (options['write-doc']) {
    const documentPath = join(report.rootDir, 'docs', 'ARCHITECTURE.generated.md');
    const markdown = formatArchitectureMarkdown(report);
    writeFileAtomic(documentPath, markdown.endsWith('\n') ? markdown : `${markdown}\n`);
    wroteDocument = true;
  }
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`wiring census root: ${report.rootDir}\n`);
    process.stdout.write(`entrypoints: ${report.totals.entrypoints}\n`);
    process.stdout.write(`wired production modules: ${report.totals.wired}\n`);
    process.stdout.write(`unwired production modules: ${report.totals.unwired}\n`);
    process.stdout.write(`board_pipeline -> ops reverse leaks: ${report.totals.reverseLeaks}\n`);
    process.stdout.write(`production files over 700 LOC: ${report.totals.largeFiles}\n`);
    if (wroteDocument) process.stdout.write('wrote docs/ARCHITECTURE.generated.md\n');
  }
  return report;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    runDfMap(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`df-map: ${error.message}\n`);
    process.exitCode = 2;
  }
}
