// Тесты контракта --brief/--text тонкого CLI постановки ops/factory-enqueue.mjs.
// Без внешних эффектов: план собирается в памяти, временные каталоги
// удаляются в finally.
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
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
