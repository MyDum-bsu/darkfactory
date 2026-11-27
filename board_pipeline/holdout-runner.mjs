import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const IMAGE = /^sha256:[a-f0-9]{64}$/;
const HOLDOUT_MAX_FILES = 64;
const HOLDOUT_MAX_FILE_BYTES = 1024 * 1024;
const HOLDOUT_MAX_TOTAL_BYTES = 8 * 1024 * 1024;
// Ресурсные рамки контейнера прогона: без них runaway-сценарий голодает
// хост по памяти/pids/cpu, а при таймауте execFile убивает лишь docker
// CLI — контейнер продолжает жить. Дефолты консервативны и перекрываются
// вызывающим; имя уникально на прогон, чтобы cleanup в finally всегда
// адресовал ровно этот контейнер.
const HOLDOUT_MEMORY_DEFAULT = '2g';
const HOLDOUT_PIDS_LIMIT_DEFAULT = 256;
const HOLDOUT_CPUS_DEFAULT = 2;
const HOLDOUT_MEMORY = /^[1-9][0-9]{0,5}[bkmg]$/i;
const HOLDOUT_CONTAINER_NAME = /^df-holdout-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CONTROL = /[\x00-\x1f\x7f]/;
const ANSI = /(?:\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\))/g;
const SAFE_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const SAFE_TOKEN = /^[a-z][a-z0-9-]{1,80}$/;
const SAFE_SELECTOR = /^[A-Za-z0-9#.\[\]_:=,>+~*()$-]{1,180}$/;
const HOST_PATH = /(?:^|\s)(?:\/holdouts(?:\/|\s|$)|\/(?:home|Users|media)\/[^\s"')\]]+|(?:[A-Za-z]:\\[^\s"')\]]+))/;
const SECRETISH = /(?:secret|password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|bearer\s+[A-Za-z0-9._~-]+|-----BEGIN [A-Z ]*PRIVATE KEY-----|sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9_]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|AKIA[0-9A-Z]{12,20}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|[A-Za-z0-9_-]{40,})/i;

const fail = reason => Object.assign(new Error(reason), { reason });
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function canonicalExistingDirectory(path, reason) {
  if (!isAbsolute(path ?? '')) throw fail(reason);
  const info = await lstat(path).catch(() => { throw fail(reason); });
  if (!info.isDirectory() || info.isSymbolicLink()) throw fail(reason);
  const canonical = await realpath(path).catch(() => { throw fail(reason); });
  if (canonical !== resolve(path)) throw fail(reason);
  return canonical;
}

function inside(child, parent) {
  return parent === sep ? child.startsWith(sep)
    : child === parent || child.startsWith(`${parent}${sep}`);
}

// The private StrongDM holdout catalog must be outside the writable candidate
// worktree. Endpoint symlinks and symlinked intermediate components are rejected
// by comparing the spelling with realpath; recursive entries are independently
// lstat'ed below, so a symlink escape inside the catalog is also impossible.
export async function validateHoldoutDir(holdoutDir, worktree) {
  const holdout = await canonicalExistingDirectory(holdoutDir, 'holdout_dir_invalid');
  const tree = await canonicalExistingDirectory(worktree, 'holdout_worktree_invalid');
  if (holdout === sep) throw fail('holdout_dir_invalid');
  if (inside(holdout, tree)) throw fail('holdout_inside_worktree');
  if (inside(tree, holdout)) throw fail('holdout_overlaps_worktree');
  // Docker --mount uses comma-separated key/value text even when argv itself is
  // an array. Reject separator/control bytes instead of letting a lawful Unix
  // filename become a second mount option.
  if (/[\x00-\x1f\x7f,]/.test(holdout)) throw fail('holdout_dir_invalid');
  return holdout;
}

async function scan(holdoutDir) {
  const files = [];
  let totalBytes = 0;
  async function walk(dir, prefix) {
    const entries = (await readdir(dir, { withFileTypes: true }))
      .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = join(dir, entry.name);
      const info = await lstat(full);
      if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) {
        throw fail('holdout_unsafe_entry');
      }
      if (info.isDirectory()) {
        await walk(full, rel);
        continue;
      }
      if (files.length >= HOLDOUT_MAX_FILES || info.size < 1 ||
          info.size > HOLDOUT_MAX_FILE_BYTES || totalBytes + info.size > HOLDOUT_MAX_TOTAL_BYTES) {
        throw fail('holdout_size_limit');
      }
      const data = await readFile(full);
      if (data.length !== info.size) throw fail('holdout_mutated');
      files.push({ path: rel, bytes: data.length, sha256: sha256(data), data });
      totalBytes += data.length;
    }
  }
  await walk(holdoutDir, '');
  if (!files.length) throw fail('holdout_empty');
  return files;
}

// Deterministic provenance digest over sorted relative paths, sizes, per-file
// SHA-256 and bytes. Ordering is applied again here so the contract does not
// depend on filesystem traversal.
export function digestHoldoutFiles(files) {
  const ordered = [...files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const hash = createHash('sha256');
  for (const file of ordered) {
    hash.update(file.path, 'utf8');
    hash.update('\0');
    hash.update(String(file.bytes));
    hash.update('\0');
    hash.update(file.sha256);
    hash.update('\0');
    if (file.data) hash.update(file.data);
    hash.update('\0');
  }
  return hash.digest('hex');
}

export async function holdoutDigest(holdoutDir) {
  const files = await scan(holdoutDir);
  return { holdout_digest: digestHoldoutFiles(files),
    files: files.map(({ path, bytes, sha256: digest }) => ({ path, bytes, sha256: digest })) };
}

function safeDockerRecipe({ image, argv, cwd = '/candidate' } = {}) {
  if (!IMAGE.test(image ?? '') || !Array.isArray(argv) || !argv.length ||
      !argv.every(arg => typeof arg === 'string' && arg.length > 0 && !arg.includes('\0')) ||
      typeof cwd !== 'string' || CONTROL.test(cwd) ||
      !(cwd === '/candidate' || cwd.startsWith('/candidate/')) || cwd.split('/').includes('..')) {
    throw fail('holdout_recipe_invalid');
  }
  return { image, argv: [...argv], cwd };
}

// Docker argv is data, never shell text. The private catalog is the only extra
// mount and it is read-only at /holdouts. Resource bounds are explicit on every
// run and the container carries a unique df-holdout-<uuid> name so the finally
// cleanup can address exactly this container even when the CLI is killed on
// timeout. Bounds are validated as strict scalar shapes: they are data tokens
// of argv, never shell text, and a malformed value fails closed before spawn.
export function buildHoldoutDockerArgv({ holdoutDir, image, argv, cwd = '/candidate',
  memory = HOLDOUT_MEMORY_DEFAULT, pidsLimit = HOLDOUT_PIDS_LIMIT_DEFAULT,
  cpus = HOLDOUT_CPUS_DEFAULT, name } = {}) {
  if (!isAbsolute(holdoutDir ?? '') || /[\x00-\x1f\x7f,]/.test(holdoutDir)) throw fail('holdout_dir_invalid');
  const recipe = safeDockerRecipe({ image, argv, cwd });
  if (!HOLDOUT_MEMORY.test(memory ?? '') ||
      !Number.isSafeInteger(pidsLimit) || pidsLimit < 1 || pidsLimit > 65536 ||
      typeof cpus !== 'number' || !Number.isFinite(cpus) || cpus <= 0 || cpus > 64) {
    throw fail('holdout_recipe_invalid');
  }
  const container = name ?? `df-holdout-${randomUUID()}`;
  if (!HOLDOUT_CONTAINER_NAME.test(container)) throw fail('holdout_recipe_invalid');
  return ['run', '--rm', '--pull=never', '--network=none', '--read-only',
    '--cap-drop=ALL', '--security-opt=no-new-privileges', '--user=65534:65534',
    `--memory=${memory}`, `--pids-limit=${pidsLimit}`, `--cpus=${cpus}`,
    '--name', container,
    '--tmpfs=/tmp:rw,nosuid,nodev,mode=1777,size=64m', '-e', 'HOME=/tmp',
    '--mount', `type=bind,src=${holdoutDir},dst=/holdouts,readonly`,
    '--workdir', recipe.cwd, recipe.image, ...recipe.argv];
}

export async function runHoldoutL3({ holdoutDir, worktree, image, argv, cwd = '/candidate',
  timeoutMs = 120_000, memory = HOLDOUT_MEMORY_DEFAULT, pidsLimit = HOLDOUT_PIDS_LIMIT_DEFAULT,
  cpus = HOLDOUT_CPUS_DEFAULT, name, execDocker = exec } = {}) {
  const canonical = await validateHoldoutDir(holdoutDir, worktree);
  const provenance = await holdoutDigest(canonical);
  const container = name ?? `df-holdout-${randomUUID()}`;
  const args = buildHoldoutDockerArgv({ holdoutDir: canonical, image, argv, cwd,
    memory, pidsLimit, cpus, name: container });
  let exit = 0;
  let output = '';
  try {
    const run = await execDocker('docker', args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 });
    output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  } catch (error) {
    exit = typeof error.code === 'number' ? error.code : null;
    output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
  } finally {
    // Таймаут/отказ docker CLI оставляет контейнер живым даже с --rm:
    // execFile убивает клиента, не контейнер. Уникальное имя адресует
    // ровно этот прогон; сбой cleanup (контейнер уже удалён через --rm,
    // daemon недоступен) не маскирует результат прогона.
    try {
      await execDocker('docker', ['rm', '-f', container], { timeout: 30_000, maxBuffer: 1024 * 1024 });
    } catch { /* cleanup best-effort: контейнер уже удалён или daemon недоступен */ }
  }
  const feedback = sanitizeHoldoutFeedback(parseStructuredOutput(output));
  const workerFeedback = exit !== 0 && !feedback.failures.length
    ? sanitizeHoldoutFeedback({ failures: [{ failed_assertion_category: 'execution-failure' }] })
    : feedback;
  return { ok: exit === 0 && workerFeedback.verdict === 'PASS', exit, holdout_digest: provenance.holdout_digest,
    scenario_files: provenance.files.length, docker_argv: Object.freeze(args), feedback: workerFeedback };
}

function stripped(value) {
  return typeof value === 'string' ? value.replace(ANSI, '').trim() : '';
}
function compromised(value) {
  return CONTROL.test(value) || HOST_PATH.test(value) || SECRETISH.test(value);
}
function safeId(value, fallback) {
  const text = stripped(value);
  return !compromised(text) && SAFE_ID.test(text) ? text : fallback;
}
function safeToken(value, fallback = 'unspecified') {
  const text = stripped(value).replaceAll('_', '-').replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
  return !compromised(text) && SAFE_TOKEN.test(text) ? text : fallback;
}
function safeSelector(value) {
  const text = stripped(value);
  // Deliberately no quotes or slash: attribute text and filesystem-shaped data
  // cannot become a covert channel for scenario source, secrets or host paths.
  return !compromised(text) && SAFE_SELECTOR.test(text) && !text.includes('/') &&
    !text.includes('"') && !text.includes("'") ? text : undefined;
}
function numberIn(value, min, max) {
  return Number.isFinite(value) && value >= min && value <= max ? value : undefined;
}
function safeViewport(value) {
  if (typeof value === 'string') {
    const match = /^([1-9][0-9]{2,4})x([1-9][0-9]{2,4})$/.exec(value.trim());
    if (match) return { width: Number(match[1]), height: Number(match[2]) };
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const width = numberIn(value.width, 1, 100000);
    const height = numberIn(value.height, 1, 100000);
    if (width && height) return { width, height };
  }
  return undefined;
}
function safeCoordinates(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const x = numberIn(value.x, 0, 100000);
  const y = numberIn(value.y, 0, 100000);
  if (x === undefined || y === undefined) return undefined;
  const out = { x, y };
  const width = numberIn(value.width, 0, 100000);
  const height = numberIn(value.height, 0, 100000);
  if (width !== undefined) out.width = width;
  if (height !== undefined) out.height = height;
  return out;
}

function failureFrom(input, index) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const target = source.target && typeof source.target === 'object' ? source.target : {};
  const failure = {
    scenario_id: safeId(source.scenario_id ?? source.scenarioId ?? source.id, `scenario-${index + 1}`),
    failed_assertion_category: safeToken(source.failed_assertion_category ?? source.category ??
      source.assertion_category ?? source.kind),
  };
  const viewport = safeViewport(source.viewport ?? source.viewport_size ?? source.size);
  if (viewport) failure.viewport = viewport;
  const selector = safeSelector(source.selector ?? target.selector);
  if (selector) failure.selector = selector;
  const coordinates = safeCoordinates(source.coordinates ?? source.boundingBox ?? target.coordinates);
  if (coordinates) failure.coordinates = coordinates;
  return failure;
}

function parseStructuredOutput(output) {
  if (typeof output !== 'string' || !output.trim()) return {};
  const parse = text => {
    try {
      const value = JSON.parse(text);
      return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    } catch { return null; }
  };
  const whole = parse(output.trim());
  if (whole) return whole;
  // Harnesses may prefix structured output with ordinary progress lines. Only
  // complete JSON object lines are evidence; arbitrary surrounding prose is not
  // extracted and therefore cannot become a redaction bypass.
  for (const line of output.trim().split(/\r?\n/).reverse()) {
    const text = line.trim();
    if (text.startsWith('{') && text.endsWith('}')) {
      const value = parse(text);
      if (value) return value;
    }
  }
  return {};
}

function collectFailures(input) {
  if (Array.isArray(input?.failures)) return input.failures;
  if (Array.isArray(input?.violations)) return input.violations;
  if (Array.isArray(input?.scenarios)) {
    return input.scenarios.flatMap((scenario, scenarioIndex) => {
      const nested = Array.isArray(scenario?.failures) ? scenario.failures
        : Array.isArray(scenario?.assertions) ? scenario.assertions.filter(x => x?.passed === false) : [];
      return nested.map(item => ({ scenario_id: scenario?.id ?? scenario?.scenario_id ?? `scenario-${scenarioIndex + 1}`,
        viewport: scenario?.viewport, ...item }));
    });
  }
  return input && typeof input === 'object' && (input.scenario_id || input.failed_assertion_category ||
    input.category || input.selector || input.coordinates) ? [input] : [];
}

// Worker-facing feedback is allowlisted structure, never prose. Free-form
// output, source snippets, file paths, ANSI control sequences and secret-shaped
// material are dropped rather than redacted into a reusable leak channel.
export function sanitizeHoldoutFeedback(input) {
  const failures = collectFailures(input).slice(0, 64).map(failureFrom);
  const deduped = [];
  const seen = new Set();
  for (const failure of failures) {
    const key = JSON.stringify(failure);
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(failure);
    }
  }
  return Object.freeze({ type: 'holdout-feedback',
    verdict: deduped.length ? 'REWORK' : 'PASS',
    failures: Object.freeze(deduped) });
}

function assertionEntries(assertions) {
  if (!assertions || typeof assertions !== 'object' || Array.isArray(assertions)) return [];
  return Object.entries(assertions).filter(([key, value]) => /^[a-z][A-Za-z0-9-]{1,80}$/.test(key) && Number.isSafeInteger(value));
}

function metric(report, key) {
  const value = report?.[key];
  return Number.isSafeInteger(value) ? value : null;
}

// Controller-side evaluation of JSON scenarios. This function is intentionally
// not exposed to the worker; its return includes only sanitized worker feedback
// plus provenance. Strict JSON prevents comments/anchors from becoming input.
export async function evaluateHoldoutScenarios({ holdoutDir, worktree, report } = {}) {
  const canonical = await validateHoldoutDir(holdoutDir, worktree);
  const files = await scan(canonical);
  const provenance = digestHoldoutFiles(files);
  const failures = [];
  let evaluated = 0;
  for (const file of files.filter(entry => entry.path.endsWith('.json'))) {
    let scenario;
    try { scenario = JSON.parse(file.data.toString('utf8')); }
    catch { throw fail('holdout_scenario_invalid'); }
    if (!scenario || typeof scenario !== 'object' || Array.isArray(scenario)) throw fail('holdout_scenario_invalid');
    const assertions = assertionEntries(scenario.assertions);
    if (!assertions.length) throw fail('holdout_scenario_invalid');
    evaluated++;
    for (const [key, expected] of assertions) {
      const actual = metric(report, key);
      if (actual !== expected) {
        failures.push({ scenario_id: scenario.id ?? file.path.replace(/\.json$/, ''),
          viewport: scenario.viewport, failed_assertion_category: key,
          selector: scenario.selector, coordinates: scenario.coordinates });
      }
    }
  }
  if (!evaluated) throw fail('holdout_scenario_invalid');
  const feedback = sanitizeHoldoutFeedback({ failures });
  return Object.freeze({ holdout_digest: provenance, scenarios: evaluated,
    holdoutFailures: failures.length, feedback });
}

// Deterministic static sandbox analyzer used by offline integration tests and
// the synthetic L3 harness. Controls without a design-system class are unstyled;
// lists/tables with more than 10 rows need explicit collapse/pagination.
export function analyzeMoTrackerUiHtml(html, { width = 1440, height = 900 } = {}) {
  if (typeof html !== 'string' || !html.length) throw fail('ui_html_invalid');
  const violations = [];
  const seen = new Set();
  const add = (category, index, selector) => {
    const key = `${category}:${index}`;
    if (seen.has(key)) return;
    seen.add(key);
    const before = html.slice(0, index);
    const line = before.split('\n').length;
    const column = before.length - before.lastIndexOf('\n');
    violations.push({ category, selector,
      viewport: { width, height },
      coordinates: { x: Math.min(width - 1, Math.max(0, (column - 1) * 8)),
        y: Math.min(height - 1, Math.max(0, (line - 1) * 24)), width: 160, height: 32 } });
  };
  for (const match of html.matchAll(/<(select|input|textarea)\b[^>]*>/gi)) {
    const tag = match[0];
    if (!/\bclass\s*=\s*["'][^"']*(?:control|input|select|field|button)[^"']*["']/i.test(tag) &&
        !/\bdata-ui\s*=\s*["']styled["']/i.test(tag)) {
      add('unstyled-control', match.index, match[1].toLowerCase());
    }
  }
  for (const match of html.matchAll(/<(ul|ol|tbody)\b([^>]*)>([\s\S]*?)<\/\1>/gi)) {
    const rows = (match[3].match(/<(li|tr)\b/gi) ?? []).length;
    const attrs = match[2] ?? '';
    const collapsed = /\bdata-(?:collapsed|pagination|virtualized)\s*=\s*["']true["']/i.test(attrs) ||
      /<details\b/i.test(html.slice(Math.max(0, match.index - 160), match.index));
    if (rows > 10 && !collapsed) add('uncollapsed-long-list', match.index, match[1].toLowerCase());
  }
  for (const state of ['loading', 'empty', 'error', 'ready']) {
    const present = new RegExp(`(?:data-state|data-testid|class)=["'][^"']*${state}`, 'i').test(html) ||
      (state === 'loading' && /\baria-busy=["']true["']/i.test(html));
    if (!present) violations.push({ category: 'missing-state', selector: `[data-state=${state}]`,
      viewport: { width, height }, coordinates: { x: 0, y: 0, width, height: 32 } });
  }
  const unstyledControls = violations.filter(v => v.category === 'unstyled-control').length;
  const uncollapsedLongLists = violations.filter(v => v.category === 'uncollapsed-long-list').length;
  const missingStates = violations.filter(v => v.category === 'missing-state').length;
  const score = Math.max(0, 100 - unstyledControls * 25 - uncollapsedLongLists * 20 - missingStates * 15);
  return { unstyledControls, uncollapsedLongLists, missingStates,
    consoleErrors: 0, a11yViolations: 0, a11yCritical: 0, satisfactionScore: score,
    viewport: { width, height }, violations };
}
