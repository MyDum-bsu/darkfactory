// Тесты контракта --brief/--text тонкого CLI постановки ops/factory-enqueue.mjs.
// Без внешних эффектов: план собирается в памяти, временные каталоги
// удаляются в finally.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildEnqueuePlan, runEnqueue } from './factory-enqueue.mjs';

const HEX = 'a'.repeat(64);
const HEX2 = 'b'.repeat(64);
const sha256File = async path => createHash('sha256').update(await readFile(path)).digest('hex');

// Канонический каталог фикстур: TMPDIR может идти через симлинк-предка —
// позитивные сценарии обязаны передавать CLI канонические пути.
async function tempdir() {
  return realpath(await mkdtemp(join(tmpdir(), 'factory-enqueue-')));
}

const baseValues = () => ({
  'board-url': 'https://board.example', channel: 'ops', title: 'T',
  'repo-id': 'repo', profile: 'prof', finish: 'verified',
  'spec-digest': HEX, 'policy-digest': HEX2 });

test('enqueue: --brief вместе с --text отклоняется понятной ошибкой до любого эффекта', async () => {
  const dir = await tempdir();
  try {
    const brief = join(dir, 'brief.md');
    await writeFile(brief, 'spec body\n');
    // Уровень собранных значений: конфликт отклоняется до проверки путей
    // и до вызова vb, а не молчаливым отбрасыванием --brief.
    await assert.rejects(() => buildEnqueuePlan({ ...baseValues(), brief, text: 'body' }),
      /brief_text_conflict: pass either --brief or --text, not both/);
    // Конфликт первичен даже перед валидацией остальных полей: оператор
    // получает одну понятную причину отказа, а не косвенную.
    await assert.rejects(() => buildEnqueuePlan({ brief, text: 'body' }),
      /brief_text_conflict/);
    // Уровень CLI argv: тот же отказ через разбор флагов.
    await assert.rejects(() => runEnqueue([
      '--board-url', 'https://board.example', '--channel', 'ops',
      '--repo-id', 'repo', '--profile', 'prof', '--finish', 'verified',
      '--spec-digest', HEX, '--policy-digest', HEX2,
      '--brief', brief, '--text', 'body', '--dry-run',
    ]), /brief_text_conflict: pass either --brief or --text, not both/);
    await assert.rejects(() => runEnqueue([
      '--board-url', 'https://board.example', '--channel', 'ops',
      '--repo-id', 'repo', '--profile', 'prof', '--finish', 'verified',
      '--spec-digest', HEX, '--policy-digest', HEX2,
      '--text', 'body', '--brief', brief, '--dry-run',
    ]), /brief_text_conflict/);
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
    // Только --brief: текст карточки — байт-в-байт содержимое файла,
    // spec_digest совпадает с хэшем файла.
    const brief = join(dir, 'brief.md');
    const body = 'first line\nsecond line\n';
    await writeFile(brief, body);
    const briefOnly = await buildEnqueuePlan({ ...baseValues(), title: undefined,
      'spec-digest': undefined, brief });
    assert.equal(briefOnly.argv[5], body);
    assert.equal(briefOnly.labels.spec_digest, await sha256File(brief));
    // --title вместе с --brief — не конфликт: тело всё равно из файла.
    const titled = await buildEnqueuePlan({ ...baseValues(), 'spec-digest': undefined, brief });
    assert.equal(titled.argv[5], body);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
