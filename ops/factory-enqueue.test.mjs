// Тесты контракта --brief/--text тонкого CLI постановки ops/factory-enqueue.mjs.
// Без внешних эффектов: план собирается в памяти, временные каталоги
// удаляются в finally.
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { buildEnqueuePlan, runEnqueue } from './factory-enqueue.mjs';

const execFileAsync = promisify(execFile);
const OPS_DIR = dirname(fileURLToPath(import.meta.url));
const ENQUEUE_CLI = join(OPS_DIR, 'factory-enqueue.mjs');

const HEX = 'a'.repeat(64);
const HEX2 = 'b'.repeat(64);
const sha256File = async path => createHash('sha256').update(await readFile(path)).digest('hex');
const sha256Text = text => createHash('sha256').update(text).digest('hex');

// Канонический каталог фикстур: TMPDIR может идти через симлинк-предка —
// позитивные сценарии обязаны передавать CLI канонические пути.
async function tempdir() {
  return realpath(await mkdtemp(join(tmpdir(), 'factory-enqueue-')));
}

const baseValues = () => ({
  'board-url': 'https://board.example', channel: 'ops', title: 'T',
  'repo-id': 'repo', profile: 'prof', finish: 'verified',
  'spec-digest': HEX, 'policy-digest': HEX2 });

test('enqueue hashes validated rule inputs rather than slot locations', async t => {
  const dir = await tempdir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const at = file => join(dir, file);
  for (const name of ['slot1', 'slot2', 'handoff']) await mkdir(at(name));
  for (const name of ['brief', 'prompt', 'gate', 'skill']) await writeFile(at(name), name);
  const p = { brief: at('brief'), reviewPrompt: at('prompt'), reviewGate: at('gate'), reviewSkillFiles: { logika: at('skill') },
    handoffDir: at('handoff'), profiles: { prof: { review: { provider: 'openai', model: 'gpt-6.2-sol', reasoningLevel: 'medium' } } },
    route: { checkProfile: 'prof', worktree: at('slot1'), base: 'a'.repeat(40) } };
  const routes = { routes: [{ ...p.route, gate: 'enforce' }] };
  const getDigest = async () => {
    await writeFile(at('policy.json'), JSON.stringify(p));
    await writeFile(at('routes.json'), JSON.stringify(routes));
    return (await buildEnqueuePlan({ ...baseValues(), policy: at('policy.json'), 'policy-digest': undefined })).labels.policy_digest;
  };
  const original = await getDigest();
  p.route.base = 'HEAD'; assert.equal(await getDigest(), original);
  p.route.worktree = at('slot2'); assert.equal(await getDigest(), original);
  Object.assign(routes.routes[0], p.route); assert.equal(await getDigest(), original);
  routes.routes[0].gate = 'changed'; assert.notEqual(await getDigest(), original);
  routes.routes[0].gate = 'enforce';
  await writeFile(at('skill'), 'new skill bytes'); assert.notEqual(await getDigest(), original);
  p.route.worktree = dir; await assert.rejects(getDigest(), /path_inside_worktree/);
});

const fieldArgs = ['--board-url', 'https://board.example', '--channel', 'ops', '--title', 'T',
  '--repo-id', 'repo', '--profile', 'prof', '--finish', 'verified', '--spec-digest', HEX,
  '--policy-digest', HEX2, '--dry-run'];

test('enqueue emits normalized field labels only for explicit choices', async () => {
  const defaults = await runEnqueue(fieldArgs);
  assert.ok(!Object.hasOwn(defaults.plan.labels, 'field_mode'));
  assert.ok(!Object.hasOwn(defaults.plan.labels, 'task_plan'));
  for (const flags of [['--field-mode', ' GreenField ', '--task-plan', ' MVP '],
    ['--label', 'field_mode= GreenField ', '--label', 'task_plan=MVP']]) {
    const { plan } = await runEnqueue([...fieldArgs, ...flags]);
    assert.deepEqual(plan.argv.filter(s => /^(field_mode|task_plan)=/.test(s)), ['field_mode=greenfield', 'task_plan=mvp']);
  }
});

test('enqueue rejects invalid or duplicate field/plan inputs with exit 2', async () => {
  for (const [flags, message] of [
    [['--field-mode', 'experimental'], 'field_mode_invalid'], [['--task-plan', ''], 'task_plan_invalid'],
    [['--label', 'field_mode=invalid'], 'field_mode_invalid'], [['--label', 'task_plan=invalid'], 'task_plan_invalid'],
    [['--field-mode', 'brownfield', '--label', 'field_mode=greenfield'], 'field_mode_duplicate'],
    [['--label', 'task_plan=mvp', '--label', 'task_plan=mvp'], 'task_plan_duplicate'],
    [['--field-mode', 'invalid', '--field-mode', 'greyfield'], 'field-mode_duplicate'],
  ]) {
    await assert.rejects(execFileAsync(process.execPath, [ENQUEUE_CLI, ...fieldArgs, ...flags]),
      err => err.code === 2 && err.stdout === '' && err.stderr.includes(message));
  }
});

test('ticket preflight reads every page, rejects duplicates, and fails closed on unreadable listings', async () => {
  const args = [...fieldArgs.slice(0, -1), '--ticket', 'V12-1'];
  const prefix = ['--url', 'https://board.example', 'tasks', 'ops', '--json'];
  for (const state of ['ready', 'claimed', 'waiting', 'blocked']) {
    const calls = [];
    await assert.rejects(runEnqueue(args, { exec: async (cmd, argv) => {
      assert.equal(cmd, 'vb'); calls.push(argv);
      return JSON.stringify(calls.length === 1 ? { tasks: [{ id: '1', state: 'done', labels: { ticket: 'V12-1' } }], cursor: '1' }
        : { tasks: [{ message: { id: '2', task: { state }, labels: { ticket: 'V12-1' } } }] });
    } }), /duplicate_open_ticket:V12-1/);
    assert.deepEqual(calls, [prefix, [...prefix, '--after', '1']]);
  }
  for (const listing of ['bad json', '{}', '{"tasks":[{}]}']) {
    let calls = 0;
    await assert.rejects(runEnqueue(args, { exec: async () => { calls++; return listing; } }));
    assert.equal(calls, 1);
  }
  const calls = [];
  await runEnqueue(args, { exec: async (_, argv) => { calls.push(argv); return '[]'; } });
  assert.equal(calls.length, 2); assert.equal(calls[1][3], 'create');
  await runEnqueue([...args, '--allow-duplicate-ticket'], { exec: async (_, argv) => assert.equal(argv[3], 'create') });
});

test('supersedes cancels before create; invalid IDs, failed cancel and dry-run never create', async () => {
  const args = [...fieldArgs.slice(0, -1), '--ticket', 'V12-1', '--supersedes'];
  const calls = [];
  const deps = { exec: async (_, argv) => { calls.push(argv); return '{}'; } };
  await assert.rejects(runEnqueue([...args, '2x'], deps), /supersedes_invalid/);
  const { plan } = await runEnqueue([...args, '27', '--dry-run'], deps);
  assert.equal(plan.labels.supersedes, '27'); assert.deepEqual(calls, []);
  await runEnqueue([...args, '27'], deps);
  assert.deepEqual(calls, [['--url', 'https://board.example', 'tasks', 'cancel', '27', 'superseded_by_requeue'], plan.argv]);
  assert.ok(plan.argv.includes('supersedes=27'));
  await assert.rejects(runEnqueue([...args, '27'], { exec: async (_, argv) => {
    assert.equal(argv[3], 'cancel'); throw new Error('cancel refused');
  } }), /cancel refused/);
});

const cliArgs = brief => [
  '--board-url', 'https://board.example', '--channel', 'ops',
  '--repo-id', 'repo', '--profile', 'prof', '--finish', 'verified',
  '--spec-digest', HEX, '--policy-digest', HEX2,
  '--brief', brief, '--text', 'body', '--dry-run',
];

test('enqueue: операторские --brief вместе с --text отклоняются понятной ошибкой до эффекта', async () => {
  const dir = await tempdir();
  try {
    const brief = join(dir, 'brief.md');
    await writeFile(brief, 'spec body\n');
    // Уровень разобранных CLI-флагов: совместная передача неоднозначна
    // (--brief молча терял бы всякий эффект) — отказ до сборки плана и
    // до вызова vb, в любом порядке флагов.
    await assert.rejects(() => runEnqueue(cliArgs(brief)),
      /brief_text_conflict: pass either --brief or --text, not both/);
    const reversed = [
      '--board-url', 'https://board.example', '--channel', 'ops',
      '--repo-id', 'repo', '--profile', 'prof', '--finish', 'verified',
      '--spec-digest', HEX, '--policy-digest', HEX2,
      '--text', 'body', '--brief', brief, '--dry-run',
    ];
    await assert.rejects(() => runEnqueue(reversed), /brief_text_conflict/);
    // Уровень операторского процесса: exit 2 и понятное сообщение в stderr.
    try {
      await execFileAsync(process.execPath, [ENQUEUE_CLI, ...cliArgs(brief)],
        { encoding: 'utf8' });
      assert.fail('CLI must reject --brief together with --text');
    } catch (error) {
      assert.equal(error.code, 2);
      assert.match(error.stderr,
        /factory-enqueue: brief_text_conflict: pass either --brief or --text, not both/);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('enqueue: --text или --brief по отдельности остаются рабочими входами', async () => {
  const dir = await tempdir();
  try {
    // Только --text: текст карточки — само значение, конфликта нет.
    const textOnly = await buildEnqueuePlan({ ...baseValues(), title: undefined, text: 'body' });
    assert.equal(textOnly.argv[5], 'body');
    const textRun = await runEnqueue([
      '--board-url', 'https://b', '--channel', 'c', '--text', 'body', '--repo-id', 'r',
      '--profile', 'p', '--finish', 'verified', '--spec-digest', HEX,
      '--policy-digest', HEX2, '--dry-run',
    ]);
    assert.equal(textRun.dryRun, true);
    // Только --brief: текст карточки — байт-в-байт содержимое файла,
    // spec_digest совпадает с хэшем файла.
    const brief = join(dir, 'brief.md');
    const body = 'first line\nsecond line\n';
    await writeFile(brief, body);
    const briefOnly = await buildEnqueuePlan({ ...baseValues(), title: undefined,
      'spec-digest': undefined, brief });
    assert.equal(briefOnly.argv[5], body);
    assert.equal(briefOnly.labels.spec_digest, await sha256File(brief));
    const briefRun = await runEnqueue([
      '--board-url', 'https://b', '--channel', 'c', '--repo-id', 'r',
      '--profile', 'p', '--finish', 'verified',
      '--policy-digest', HEX2, '--brief', brief, '--dry-run',
    ]);
    assert.equal(briefRun.dryRun, true);
    assert.equal(briefRun.plan.argv[5], body);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('enqueue: программный контракт buildEnqueuePlan с двумя значениями сохранён', async () => {
  const dir = await tempdir();
  try {
    // Программный вызов с обоими значениями — задокументированная
    // первичность text (регрессия #WAVE2-1): тело и дайджест — из text.
    // CLI-отказ адресует только неоднозначную операторскую команду.
    const brief = join(dir, 'brief.md');
    await writeFile(brief, 'brief body\n');
    const plan = await buildEnqueuePlan({ ...baseValues(), title: undefined,
      text: 'explicit text', 'spec-digest': undefined, brief });
    assert.equal(plan.argv[5], 'explicit text');
    assert.equal(plan.labels.spec_digest, sha256Text('explicit text'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
