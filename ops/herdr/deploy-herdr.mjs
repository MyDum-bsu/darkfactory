// SHA-stamped, idempotent deployer for Herdr host helpers (WAVE2-6).
//
// Copies versioned ops files from the Git worktree into the Herdr host
// target directory. Safety contract:
//   - every source file must resolve INSIDE repoRoot (symlink-aware, no
//     path traversal, no absolute escapes);
//   - .mjs/.js sources must pass `node --check` ESM syntax validation,
//     every other source must be non-empty;
//   - existing target files are backed up to `<name>.bak` before the first
//     overwrite;
//   - source permission bits (exec bit on .sh helpers) are preserved;
//   - identical content is skipped (no backup churn) so repeated runs are
//     truly idempotent;
//   - a `.herdr-deploy.json` manifest { sha, deployedAt, files: [{ name,
//     sha256 }] } is written atomically into the target directory;
//   - dry-run is the default everywhere: applyDeploy(plan) without options
//     changes nothing on disk, and the CLI requires --apply to write.
//
// CLI:
//   node ops/herdr/deploy-herdr.mjs --repo-root DIR --target-dir DIR \
//     --sha COMMIT --files a.mjs,b.sh [--dry-run|--apply]

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const MANIFEST_NAME = '.herdr-deploy.json';
const JS_EXTENSIONS = new Set(['.mjs', '.js', '.cjs']);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

// Containment check on canonicalized absolute paths. Both paths must be
// real (no symlink indirection) before comparison.
function isInside(rootReal, candidateReal) {
  if (candidateReal === rootReal) return true;
  const prefix = rootReal.endsWith(sep) ? rootReal : `${rootReal}${sep}`;
  return candidateReal.startsWith(prefix);
}

// ESM syntax validation through the same Node runtime that will execute the
// file. `node --check` honors the extension, so .mjs is validated as a
// module. Deterministic: same input, same verdict, no environment influence.
async function checkJsSyntax(file) {
  try {
    await execFileAsync(process.execPath, ['--check', file]);
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: String(error.stderr || error.message).trim() };
  }
}

// Builds the deterministic deploy plan. Throws on any contract violation:
// validation is fail-closed because a half-deployed helper set is worse
// than none.
export async function planDeploy({ repoRoot, targetDir, sha, files }) {
  if (typeof repoRoot !== 'string' || !repoRoot) throw new TypeError('repo_root_required');
  if (typeof targetDir !== 'string' || !targetDir) throw new TypeError('target_dir_required');
  if (typeof sha !== 'string' || !/^[0-9a-f]{7,64}$/i.test(sha)) {
    throw new TypeError('sha_invalid');
  }
  if (!Array.isArray(files) || files.length === 0) throw new TypeError('files_required');

  const rootReal = await realpath(repoRoot).catch(() => {
    throw new Error('repo_root_missing');
  });

  const entries = [];
  const seen = new Set();
  for (const file of files) {
    if (typeof file !== 'string' || !file.trim()) throw new TypeError('file_name_invalid');
    const name = file.trim();
    if (isAbsolute(name)) throw new Error(`source_path_absolute:${name}`);
    const nameKey = basename(name);
    if (seen.has(nameKey)) throw new Error(`duplicate_file_name:${nameKey}`);

    // Containment is checked twice: lexically on the resolved path (cheap
    // rejection of obvious traversal) and physically after realpath, which
    // also resolves symlink escapes. realpath failing means the source does
    // not exist — a hard error either way.
    const resolved = resolve(rootReal, name);
    let sourceReal;
    try {
      sourceReal = await realpath(resolved);
    } catch {
      throw new Error(`source_missing:${name}`);
    }
    if (!isInside(rootReal, sourceReal)) throw new Error(`source_escapes_repo:${name}`);

    const info = await stat(sourceReal);
    if (!info.isFile()) throw new Error(`source_not_file:${name}`);
    const content = await readFile(sourceReal);
    const extension = nameKey.slice(nameKey.lastIndexOf('.'));
    if (JS_EXTENSIONS.has(extension)) {
      const syntax = await checkJsSyntax(sourceReal);
      if (!syntax.ok) throw new Error(`source_syntax_invalid:${name}`);
    } else if (content.length === 0) {
      throw new Error(`source_empty:${name}`);
    }

    seen.add(nameKey);
    entries.push({
      name: nameKey,
      relativePath: name,
      source: sourceReal,
      target: join(targetDir, nameKey),
      backup: join(targetDir, `${nameKey}.bak`),
      sha256: sha256Hex(content),
      bytes: content.length,
      mode: info.mode & 0o777,
      content,
    });
  }

  return {
    repoRoot: rootReal,
    targetDir,
    sha: sha.toLowerCase(),
    files: entries,
  };
}

async function writeAtomic(file, content, mode) {
  const tmp = `${file}.tmp-${process.pid}`;
  await writeFile(tmp, content, mode === undefined ? {} : { mode });
  await rename(tmp, file);
}

// Applies a plan. Default is dry-run: the full action list is computed but
// nothing is written. Returns per-file actions plus the manifest object so
// callers (and tests) can verify exactly what happened or would happen.
export async function applyDeploy(plan, { dryRun = true } = {}) {
  if (!isPlainObject(plan) || !Array.isArray(plan.files)) {
    throw new TypeError('plan_invalid');
  }
  const actions = [];
  const manifestFiles = [];

  if (!dryRun) await mkdir(plan.targetDir, { recursive: true });

  for (const entry of plan.files) {
    let existing = null;
    try {
      existing = await readFile(entry.target);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }

    const alreadyCurrent = existing !== null && sha256Hex(existing) === entry.sha256;
    if (alreadyCurrent) {
      actions.push({ name: entry.name, action: 'unchanged', backup: false });
      manifestFiles.push({ name: entry.name, sha256: entry.sha256 });
      continue;
    }

    const backup = existing !== null;
    if (!dryRun) {
      if (backup) await copyFile(entry.target, entry.backup);
      await writeAtomic(entry.target, entry.content, entry.mode);
    }
    actions.push({
      name: entry.name,
      action: dryRun ? 'would-copy' : 'copied',
      backup,
      bytes: entry.bytes,
    });
    manifestFiles.push({ name: entry.name, sha256: entry.sha256 });
  }

  const manifest = {
    sha: plan.sha,
    deployedAt: new Date().toISOString(),
    files: manifestFiles,
  };

  if (!dryRun) {
    await writeAtomic(join(plan.targetDir, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`);
  }

  return { dryRun, actions, manifest };
}

// --- CLI ---------------------------------------------------------------------

function parseCli(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      'repo-root': { type: 'string' },
      'target-dir': { type: 'string' },
      sha: { type: 'string' },
      files: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      apply: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    strict: true,
  });
  return values;
}

const USAGE = `usage: node deploy-herdr.mjs --repo-root DIR --target-dir DIR \\
  --sha COMMIT --files a.mjs,b.sh [--dry-run|--apply]

Options:
  --repo-root DIR   Git worktree root the sources are copied from
  --target-dir DIR  Herdr host target directory
  --sha COMMIT      Git SHA stamped into the deploy manifest
  --files LIST      Comma-separated source files, relative to repo root
  --dry-run         Print planned actions without writing (default)
  --apply           Actually copy files, backups and manifest
`;

export async function main(argv, { out = process.stdout, err = process.stderr } = {}) {
  let values;
  try {
    values = parseCli(argv);
  } catch (error) {
    err.write(`${error.message}\n${USAGE}`);
    return 2;
  }
  if (values.help) {
    out.write(USAGE);
    return 0;
  }
  if (!values['repo-root'] || !values['target-dir'] || !values.sha || !values.files) {
    err.write(USAGE);
    return 2;
  }
  if (values.apply && values['dry-run']) {
    err.write('--apply and --dry-run are mutually exclusive\n');
    return 2;
  }
  const dryRun = !values.apply;
  const files = values.files.split(',').map(name => name.trim()).filter(Boolean);

  try {
    const plan = await planDeploy({
      repoRoot: values['repo-root'],
      targetDir: values['target-dir'],
      sha: values.sha,
      files,
    });
    const result = await applyDeploy(plan, { dryRun });
    for (const action of result.actions) {
      const backupNote = action.backup ? ' (backup .bak)' : '';
      out.write(`${action.action}: ${action.name}${backupNote}\n`);
    }
    out.write(`${dryRun ? 'would write' : 'wrote'} ${MANIFEST_NAME} sha=${plan.sha}\n`);
    if (dryRun) out.write('dry-run: no files changed; pass --apply to deploy\n');
    return 0;
  } catch (error) {
    err.write(`deploy-herdr: ${error.message}\n`);
    return 1;
  }
}

const invokedAsScript = process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (invokedAsScript) {
  main(process.argv.slice(2)).then(code => process.exit(code), error => {
    process.stderr.write(`deploy-herdr: ${error.message}\n`);
    process.exit(1);
  });
}
