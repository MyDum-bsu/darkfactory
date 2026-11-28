#!/usr/bin/env node
// Read-only audit: inspect release data, never install or run a candidate CLI.
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { compareVersions, defaultRunner, managedNpmInstall, parseSemver, probeHex } from './local/df-auto-update.mjs';

const stack = [
  { name: '@vercel/board', bin: 'vb', packages: ['@vercel/board'] },
  { name: 'herdr-core', bin: 'hc' },
  { name: 'herdr-app', bin: 'herdr-app', packages: ['herdr-app'] },
  { name: 'pi', bin: 'pi', packages: ['@mariozechner/pi-coding-agent', '@earendil-works/pi-coding-agent'] },
  { name: 'bb-app', bin: 'bb', packages: ['bb-app'] },
  { name: 'agy', bin: 'agy' }, { name: 'devin', bin: 'devin' },
];

async function optionalJson(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function output(runner, command, args) {
  const result = await runner(command, args, { timeoutMs: 30_000, maxBuffer: 1024 * 1024 });
  if (result.code !== 0) throw new Error(`${command} ${args[0]} unavailable`);
  return result.stdout.trim();
}

async function installed(spec, home, runner) {
  for (const pkg of spec.packages ?? []) {
    const layout = await managedNpmInstall(home, pkg, spec.bin);
    if (layout) return { version: (await optionalJson(layout.file))?.version, bin: layout.bin, pkg };
  }
  const run = await runner(spec.bin, ['--version'], { timeoutMs: 10_000 });
  if (run.code !== 0) {
    if (run.code === 127) return null;
    throw new Error(`${spec.bin} --version unavailable`);
  }
  const version = String(run.stdout || run.stderr).trim().split(/\s+/).map(x => x.replace(/^v/, '')).find(parseSemver);
  return { version, bin: spec.bin, pkg: spec.bin === 'vb' ? spec.name : null };
}

// Summaries are bounded and plain text (including when displayed on a terminal).
function lines(text) {
  return [...new Set(String(text ?? '').split('\n').map(s => s.replace(/[\x00-\x1f\x7f]/g, ' ').trim())
    .filter(s => /[a-z]/i.test(s)))];
}
function compact(items) { return items.slice(0, 4).map(s => s.slice(0, 160)); }

function publishedFeatures(diff) {
  const changes = { added: [], removed: [], highlights: [] };
  let changelog = false;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) { changelog = /\/CHANGELOG\b/i.test(line); continue; }
    if (line.startsWith('--- ') || !/^[+-]/.test(line)) continue;
    const text = line.slice(1).trim();
    if (changelog) {
      if (line[0] === '+' && !/^#|^\[?v?\d+\.\d+\./.test(text)) changes.highlights.push(text);
    } else {
      changes[line[0] === '+' ? 'added' : 'removed'].push(text);
    }
  }
  // A command moved to a different section is neither new nor removed.
  const added = new Set(lines(changes.added.join('\n'))), removed = new Set(lines(changes.removed.join('\n')));
  return { added: compact([...added].filter(s => !removed.has(s))), removed: compact([...removed].filter(s => !added.has(s))),
    highlights: compact(lines(changes.highlights.join('\n'))) };
}

async function featureDiff(ctx, current, latest, snapshot) {
  if (snapshot) {
    const features = { added: [], removed: [], highlights: compact(lines(snapshot.changelog)) };
    if (typeof snapshot.help === 'string') {
      const old = new Set(lines(await output(ctx.runner, current.bin, ['--help'])));
      const next = new Set(lines(snapshot.help));
      features.added = compact([...next].filter(line => !old.has(line)));
      features.removed = compact([...old].filter(line => !next.has(line)));
    }
    return features;
  }
  if (!current.pkg) return null;
  // Compare published CLI reference and release notes as data. npx <latest>
  // --help would execute code we have not yet reviewed.
  const diff = await output(ctx.runner, 'npm', ['diff', `--diff=${current.pkg}@${current.version}`,
    `--diff=${current.pkg}@${latest}`, '--ignore-scripts', '--color=false', '--diff-unified=0', '--',
    'CHANGELOG.md', 'CHANGELOG', 'docs/04-reference/01-cli.md']);
  return publishedFeatures(diff);
}

async function inspect(spec, ctx) {
  const row = { name: spec.name, installed: null, latest: null, status: 'unknown' };
  try {
    const current = await installed(spec, ctx.home, ctx.runner);
    if (!current) return { ...row, status: 'not_installed' };
    const from = parseSemver(current.version);
    if (!from) throw new Error('invalid installed version');
    row.installed = current.version;
    const snapshot = ctx.candidateDir ? await optionalJson(join(ctx.candidateDir, `${spec.bin}.json`)) : null;
    let latest;
    if (snapshot) {
      latest = snapshot.version;
      row.source = 'local_snapshot';
    } else if (current.pkg) {
      latest = await output(ctx.runner, 'npm', ['view', current.pkg, 'version']);
      row.source = 'npm';
    } else if (spec.bin === 'hc') {
      latest = JSON.parse(await output(ctx.runner, 'curl', ['-fsSL', '--max-time', '15', 'https://releases.herdr.dev/core/latest.json'])).version;
      row.source = 'herdr_manifest';
    } else throw new Error(`supply a local release snapshot: --candidate-dir DIR (${spec.bin}.json)`);
    const to = parseSemver(latest);
    if (!to) throw new Error('invalid candidate version');
    row.latest = latest;
    if (!compareVersions(latest, current.version)) {
      return { ...row, status: compareVersions(current.version, latest) ? 'ahead' : 'current' };
    }
    row.jump = ['major', 'minor', 'patch'][to.core.findIndex((part, i) => part !== from.core[i])] ?? 'prerelease_transition';
    row.status = 'update_available';
    if (row.jump !== 'major' && row.jump !== 'minor') return { ...row, recommendation: 'Review release in an idle maintenance window.' };
    try { row.features = await featureDiff(ctx, current, latest, snapshot); }
    catch (error) { row.features = null; row.note = error.message; }
    const capability = row.features?.highlights[0] ?? row.features?.added[0];
    row.recommendation = capability ? `Review and trial: ${capability}.` : 'Review upstream release notes; no capability evidence available.';
    if (row.features?.removed.length) row.recommendation += ` Check removed usage: ${row.features.removed[0]}.`;
    if (row.jump === 'major' || from.core[0] === '0') row.recommendation += ' Check compatibility on a scratch install first.';
    return row;
  } catch (error) { return { ...row, status: 'unknown', recommendation: error.message }; }
}

// Stable JSON for a weekly audit; neither mode upgrades anything. Optional
// local snapshots are <bin>.json: {version, help?: "...", changelog?: "..."}.
// `help` is candidate --help captured elsewhere; changelog is the highlights
// for this release range. Missing snapshots fall back to the normal source.
export async function runReleaseRadar(options = {}, deps = {}) {
  if (options.role !== undefined && !['laptop', 'brain', 'hub', 'worker'].includes(options.role)) throw new Error('unknown host role');
  const ctx = { home: deps.home ?? homedir(), runner: deps.runner ?? defaultRunner, candidateDir: options.candidateDir };
  const components = [];
  for (const spec of stack) components.push(await inspect(spec, ctx));
  if (options.role === 'laptop') {
    try {
      const catalog = await probeHex(ctx.runner);
      components.push({ name: 'hex', status: 'checked', ...catalog, recommendation: catalog.available ? 'Trial gigaam_v4 locally.' : 'Recheck the voice catalog later.' });
    } catch { components.push({ name: 'hex', status: 'unknown', recommendation: 'Check local hex model catalog.' }); }
  }
  return { schema: 'df-release-radar.v1', dryRun: Boolean(options.dryRun), components };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const { values } = parseArgs({ options: { 'dry-run': { type: 'boolean' }, json: { type: 'boolean' },
      role: { type: 'string' }, 'candidate-dir': { type: 'string' }, help: { type: 'boolean' } } });
    if (values.help) console.log('df-release-radar.mjs [--dry-run] [--json] [--role laptop|brain|hub|worker] [--candidate-dir DIR]\nRead-only; queries release metadata. Optional DIR/<bin>.json: {version, help?, changelog?}.');
    else {
      const report = await runReleaseRadar({ dryRun: values['dry-run'], candidateDir: values['candidate-dir'], role: values.role });
      if (values.json) console.log(JSON.stringify(report));
      else for (const row of report.components) console.log(`${row.name}: ${row.installed ?? '-'} -> ${row.latest ?? '-'} (${row.status}) ${row.recommendation ?? ''}`.trim());
    }
  } catch (error) { console.error(error.message); process.exitCode = 2; }
}
