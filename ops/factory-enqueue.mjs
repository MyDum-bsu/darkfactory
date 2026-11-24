// Тонкий операторский CLI постановки одной задачи на Board через
// `vb tasks create`. Только безопасная постановка: без обхода очереди,
// без claim/spawn — исполнение идёт строго через принятый контроллер
// (board_pipeline/run-isolated.mjs / daemon.mjs, см. ops/factory-run.mjs).
// Все проверки — до любого эффекта; --dry-run печатает план без вызова vb.
//
//   node ops/factory-enqueue.mjs \
//     --board-url URL --channel CH (--title T | --text BODY) \
//     --repo-id R --profile P --finish verified|deployed \
//     (--spec-digest HEX64 | --brief FILE) \
//     (--policy-digest HEX64 | --policy FILE) \
//     [--label k=v ...] [--ticket ID] [--worktree DIR] [--memory-dir DIR] \
//     [--ledger-path FILE] [--vb PATH] [--dry-run] [--json]
//
// --policy FILE: дайджест считается так же, как контроллер закрепляет
// входы при приёмке — sha256 JSON-массива sha256-хэшей файлов маршрута
// [policyFile, brief, reviewPrompt, reviewGate, routes.json, ...skillPaths]
// (board_pipeline/run-isolated.mjs readOperatorInputs); иначе метка
// policy_digest не сойдётся с отпечатком и seal вернёт policy_digest_drift.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { operatorReviewSetup } from '../board_pipeline/review-setup.mjs';

const execFileAsync = promisify(execFile);
const HEX64 = /^[0-9a-f]{64}$/;
const REPO_LABEL = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;
const FINISH = new Set(['verified', 'deployed']);
// Контрактные метки и ключи проверенных CLI-путей: произвольный --label их
// не переопределяет (иначе в Board уйдёт путь без проверки).
const RESERVED_LABELS = new Set(
  ['spec_digest', 'policy_digest', 'repo_id', 'profile_id', 'finish',
    'memory_dir', 'ledger_path', 'worktree', 'ticket']);

function fail(code) { throw new Error(code); }

// Канонический путь существующего входа: без симлинка ни на конечном пути,
// ни среди предков (отсечение обхода вида wt/link -> внешний файл), и ни
// буквальный, ни resolved путь не лежат внутри worktree (если задан).
async function canonicalInput(path, { worktreeReal, mustBe } = {}) {
  if (typeof path !== 'string' || !path) fail('path_required');
  const literal = resolve(path);
  if (worktreeReal && (literal === worktreeReal || literal.startsWith(`${worktreeReal}/`))) {
    fail('path_inside_worktree');
  }
  // Симлинк-предок внутри worktree (wt/link -> наружу) отсекается проверкой
  // буквального пути выше; предок снаружи, ведущий внутрь worktree, —
  // сверкой realpath ниже. Проверка каждого предка отклоняла бы легальные
  // входы под симлинкованными tmp/монтированиями.
  const st = await lstat(literal).catch(() => fail('path_missing'));
  if (st.isSymbolicLink()) fail('path_symlink_refused');
  if (mustBe === 'file' && !st.isFile()) fail('path_not_file');
  if (mustBe === 'dir' && !st.isDirectory()) fail('path_not_dir');
  const real = await realpath(literal);
  if (worktreeReal && (real === worktreeReal || real.startsWith(`${worktreeReal}/`))) {
    fail('path_inside_worktree');
  }
  return real;
}

const sha256File = async path =>
  createHash('sha256').update(await readFile(path)).digest('hex');

// Тот же отпечаток, что контроллер запишет в route.policyDigest и приёмка
// сверит с меткой карточки на seal (readOperatorInputs, run-isolated.mjs).
// Каждый вложенный вход проходит ту же проверку, что и --brief/--policy:
// не симлинк и строго вне worktree — контроллер отклонил бы такую политику
// ('Operator files must be outside worker paths'), карточка не создаётся.
async function pinnedPolicyDigest(policyFile, { worktreeReal } = {}) {
  const file = await realpath(policyFile);
  const policy = JSON.parse(await readFile(file, 'utf8'));
  const reviewSetup = await operatorReviewSetup(policy);
  const check = p => canonicalInput(p, { worktreeReal, mustBe: 'file' });
  const gate = await check(policy.reviewGate);
  const files = [file, await check(policy.brief), await check(policy.reviewPrompt),
    gate, await check(join(dirname(gate), 'routes.json')),
    ...await Promise.all(reviewSetup.skillPaths.map(check))];
  const hashes = await Promise.all(files.map(sha256File));
  return createHash('sha256').update(JSON.stringify(hashes)).digest('hex');
}

// Собирает проверенный план вызова `vb tasks create`. Ничего не исполняет.
export async function buildEnqueuePlan(values) {
  const url = values['board-url'];
  try {
    const parsed = new URL(url ?? '');
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') fail('board_url_invalid');
  } catch (error) {
    if (error.code === 'ERR_INVALID_URL' || url === undefined) fail('board_url_invalid');
    throw error;
  }
  for (const [flag, v] of [['channel', values.channel], ['profile_id', values.profile]]) {
    if (typeof v !== 'string' || !v.trim()) fail(`${flag}_required`);
  }
  // Формат нативной очереди (native-board.mjs): вне формата карточка не
  // допускается к захвату — отказ до её создания.
  if (!REPO_LABEL.test(values['repo-id'] ?? '')) fail('repo_id_invalid');
  const title = values.title ?? values.text;
  if (typeof title !== 'string' || !title.trim()) fail('title_or_text_required');
  if (!FINISH.has(values.finish)) fail('finish_invalid');

  const worktreeReal = values.worktree === undefined ? null
    : await canonicalInput(values.worktree, { mustBe: 'dir' });
  let specDigest = values['spec-digest'];
  if (values.brief !== undefined) {
    specDigest = await sha256File(
      await canonicalInput(values.brief, { worktreeReal, mustBe: 'file' }));
  }
  let policyDigest = values['policy-digest'];
  if (values.policy !== undefined) {
    policyDigest = await pinnedPolicyDigest(
      await canonicalInput(values.policy, { worktreeReal, mustBe: 'file' }), { worktreeReal });
  }
  if (!HEX64.test(specDigest ?? '')) fail('spec_digest_invalid');
  if (!HEX64.test(policyDigest ?? '')) fail('policy_digest_invalid');

  const extra = {};
  for (const [flag, key] of [['memory-dir', 'memory_dir'], ['ledger-path', 'ledger_path']]) {
    if (values[flag] !== undefined) {
      extra[key] = await canonicalInput(values[flag],
        { worktreeReal, mustBe: flag === 'memory-dir' ? 'dir' : 'file' });
    }
  }
  if (values.ticket !== undefined) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(values.ticket)) fail('ticket_invalid');
    extra.ticket = values.ticket;
  }
  if (worktreeReal) extra.worktree = worktreeReal;

  const labels = { spec_digest: specDigest, policy_digest: policyDigest,
    repo_id: values['repo-id'], profile_id: values.profile, finish: values.finish, ...extra };
  for (const item of values.label ?? []) {
    const i = item.indexOf('=');
    const key = i < 0 ? item : item.slice(0, i);
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(key) || RESERVED_LABELS.has(key)) fail('label_invalid');
    labels[key] = item.slice(i + 1);
  }

  // Реальный синтаксис vb: `vb --url URL tasks create CHANNEL TITLE --label k=v --json`.
  const argv = ['--url', url, 'tasks', 'create', values.channel, title];
  for (const [key, value] of Object.entries(labels)) argv.push('--label', `${key}=${value}`);
  argv.push('--json');
  return { tool: values.vb ?? 'vb', argv, labels,
    meta: { boardUrl: url, channel: values.channel, finish: values.finish } };
}

export async function runEnqueue(argv, deps = {}) {
  const { values } = parseArgs({ args: argv, options: {
    'board-url': { type: 'string' }, channel: { type: 'string' },
    title: { type: 'string' }, text: { type: 'string' },
    'repo-id': { type: 'string' }, profile: { type: 'string' }, finish: { type: 'string' },
    'spec-digest': { type: 'string' }, brief: { type: 'string' },
    'policy-digest': { type: 'string' }, policy: { type: 'string' },
    label: { type: 'string', multiple: true }, ticket: { type: 'string' },
    worktree: { type: 'string' }, 'memory-dir': { type: 'string' },
    'ledger-path': { type: 'string' }, vb: { type: 'string' },
    'dry-run': { type: 'boolean' }, json: { type: 'boolean' } } });
  const plan = await buildEnqueuePlan(values);
  if (values['dry-run']) {
    return { dryRun: true, plan };
  }
  const exec = deps.exec ?? (async (cmd, args) =>
    (await execFileAsync(cmd, args, { timeout: 60_000 })).stdout);
  const stdout = await exec(plan.tool, plan.argv);
  return { dryRun: false, plan, stdout };
}

async function cli(argv) {
  try {
    const result = await runEnqueue(argv);
    const { values } = parseArgs({ args: argv, options: {
      json: { type: 'boolean' }, 'dry-run': { type: 'boolean' } }, strict: false });
    if (result.dryRun || values.json) {
      process.stdout.write(`${JSON.stringify(result.plan ?? result, null, 2)}\n`);
    } else if (result.stdout) {
      process.stdout.write(result.stdout);
    }
  } catch (error) {
    process.stderr.write(`factory-enqueue: ${error.message}\n`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await cli(process.argv.slice(2));
}
