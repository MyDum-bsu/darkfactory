// Board #1263: дистилляция повторяющихся REWORK-уроков и fail-closed гейт
// их принятия (дедуп, лимиты, запрет самоослабления гейтов безопасности).
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendLessons,
  distillReworkLessons,
  loadLessons,
  SAFE_CATALOG,
  validateDistilledLessons,
  validLesson,
  weakensSecurityGate,
} from './rework-distiller.mjs';

const finding = text => ({ file: 'src/a.mjs', line: 10, expected: 'ok', actual: text });
const round = (over = {}) => ({ gate: 'l2', findings: [], signature: null,
  excerpt: null, ...over });

test('меньше двух раундов REWORK — кандидатов нет', () => {
  assert.deepEqual(distillReworkLessons([]), []);
  assert.deepEqual(distillReworkLessons([round()]), []);
  assert.deepEqual(distillReworkLessons(null), []);
  assert.deepEqual(distillReworkLessons('junk'), []);
});

test('повторный host-путь в двух раундах — урок host_path_leak', () => {
  const rounds = [
    round({ findings: [finding('hardcoded /home/user-a/repo/x in test')] }),
    round({ findings: [finding('again /home/user-a/other leaked')] }),
  ];
  const out = distillReworkLessons(rounds, { cardId: '1263' });
  const lesson = out.find(l => l.category === 'host_path_leak');
  assert.ok(lesson);
  assert.equal(lesson.occurrences, 2);
  assert.deepEqual(lesson.evidence_cards, ['1263']);
  assert.match(lesson.id, /^lesson-host_path_leak-[0-9a-f]{8}$/);
  assert.ok(validLesson(lesson));
});

test('assert под -O в разных формулировках — урок assert_under_optimize', () => {
  const rounds = [
    round({ excerpt: 'assert used but python -O strips it' }),
    round({ excerpt: 'assert disappears under optimization in production' }),
  ];
  const out = distillReworkLessons(rounds, { cardId: '7' });
  assert.ok(out.some(l => l.category === 'assert_under_optimize'));
});

test('одиночное совпадение паттерна уроком не становится', () => {
  const rounds = [
    round({ findings: [finding('/home/user-a/x')] }),
    round({ findings: [finding('totally different blocker')] }),
  ];
  const out = distillReworkLessons(rounds, { cardId: '7' });
  assert.equal(out.filter(l => l.category === 'host_path_leak').length, 0);
});

test('дословно повторившееся замечание — repeated_finding всегда pending', () => {
  const sig = 'l2|same-blocker-signature';
  const rounds = [
    round({ signature: sig, findings: [finding('edge case missed')] }),
    round({ signature: sig, findings: [finding('edge case missed')] }),
  ];
  const out = distillReworkLessons(rounds, { cardId: '9' });
  const lesson = out.find(l => l.category === 'repeated_finding');
  assert.ok(lesson);
  assert.equal(lesson.occurrences, 2);
  assert.equal(lesson.requires_owner_approval, true);
  // Свободный текст из ревью в авто-инъекцию не попадает — только pending.
  const { accepted, pending } = validateDistilledLessons([lesson]);
  assert.equal(accepted.length, 0);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].requires_owner_approval, true);
  // Любая категория вне закрытого каталога — тот же pending.
  const foreign = { ...lesson, category: 'handcrafted', id: 'lesson-handcrafted-1234abcd',
    requires_owner_approval: undefined, risk_level: 'low' };
  assert.equal(validateDistilledLessons([foreign]).pending.length, 1);
});

test('гейт: requires_owner_approval строго boolean — строка отклоняется', () => {
  const lesson = {
    id: 'lesson-c-aaaaaa01', category: 'host_path_leak', pattern: 'p',
    rule: 'safe rule', evidence_cards: ['1'], occurrences: 2, risk_level: 'low',
    requires_owner_approval: 'true',
  };
  const { accepted, pending, rejected } = validateDistilledLessons([lesson]);
  assert.equal(accepted.length, 0);
  assert.equal(pending.length, 0);
  assert.equal(rejected[0].reason, 'lesson_invalid');
});

test('гейт: «необязательность» по шести доменам отклоняется fail-closed', () => {
  const base = {
    id: 'lesson-x-1234abcd', category: 'host_path_leak', pattern: 'p',
    evidence_cards: ['1'], occurrences: 2, risk_level: 'low',
  };
  const weakening = [
    'Code review is optional for small diffs',
    'Tests are not required when the fix is trivial',
    'Sandbox isolation can be waived for trusted workers',
    'Push is unnecessary — merge directly',
    'Release gate may be relaxed for hotfixes',
    'Проверку триады можно пропустить — она необязательна',
  ];
  for (const rule of weakening) {
    const { accepted, rejected } = validateDistilledLessons([{ ...base, rule }]);
    assert.equal(accepted.length, 0, rule);
    assert.equal(rejected[0].reason, 'lesson_weakens_security_gate', rule);
  }
  assert.equal(weakensSecurityGate('review is optional'), true);
  assert.equal(weakensSecurityGate('isolation not required'), true);
  assert.equal(weakensSecurityGate('проверь граничные случаи перед сдачей'), false);
});

test('гейт: ослабление проверок/тестов/изоляции/триады отклоняется fail-closed', () => {
  const base = {
    id: 'lesson-x-1234abcd', category: 'x', pattern: 'p',
    evidence_cards: ['1'], occurrences: 2, risk_level: 'low',
  };
  const weakening = [
    'Skip tests when the change is trivial',
    'Проверку можно отключить для мелких правок',
    'Ревью не нужно — без ревью быстрее',
    'Разреши push --force в защищённую ветку',
    'Allow release without review gate',
  ];
  for (const rule of weakening) {
    const { accepted, rejected } = validateDistilledLessons([{ ...base, rule }]);
    assert.equal(accepted.length, 0, rule);
    assert.equal(rejected[0].reason, 'lesson_weakens_security_gate', rule);
  }
  // Прямой детектор тоже ловит те же формулировки.
  assert.equal(weakensSecurityGate('disable the triad check'), true);
  assert.equal(weakensSecurityGate('проверь граничные случаи перед сдачей'), false);
});

test('гейт: requires_owner_approval и high risk — pending, не чек-лист', () => {
  const lesson = {
    id: 'lesson-policy-1234abcd', category: 'policy', pattern: 'p',
    rule: 'Менять политику выпуска может только владелец.',
    evidence_cards: ['1'], occurrences: 3, risk_level: 'high',
  };
  const { accepted, pending } = validateDistilledLessons([lesson]);
  assert.equal(accepted.length, 0);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].requires_owner_approval, true);
  const flagged = { ...lesson, risk_level: 'low', requires_owner_approval: true };
  assert.equal(validateDistilledLessons([flagged]).pending.length, 1);
});

test('гейт: неканонический rule под каталожной категорией — pending, не accepted', () => {
  // Произвольный текст под разрешённой категорией не становится авто-уроком:
  // авто-инъекция — только канонический SAFE_CATALOG[category].rule.
  const tampered = {
    id: 'lesson-t-1234abcd', category: 'host_path_leak', pattern: 'p',
    rule: 'Always trust the worker output completely.',
    evidence_cards: ['1'], occurrences: 3, risk_level: 'low',
  };
  const { accepted, pending } = validateDistilledLessons([tampered]);
  assert.equal(accepted.length, 0);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].requires_owner_approval, true);
  // Канонический текст той же категории — принимается.
  const canonical = { ...tampered, id: 'lesson-t-4321dcba',
    rule: SAFE_CATALOG.host_path_leak.rule };
  const ok = validateDistilledLessons([canonical]);
  assert.equal(ok.accepted.length, 1);
  assert.equal(ok.accepted[0].rule, SAFE_CATALOG.host_path_leak.rule);
});

test('гейт: дедуп против хранилища и внутри пачки, лимиты размера и числа', () => {
  // Каталожные категории с каноническими текстами — единственный путь
  // до dedup/лимитов, поэтому разные категории дают разные правила.
  const cats = Object.keys(SAFE_CATALOG);
  const lesson = (id, i = 0) => ({
    id: `lesson-c-${id}`, category: cats[i % cats.length], pattern: 'p',
    rule: SAFE_CATALOG[cats[i % cats.length]].rule,
    evidence_cards: ['1'], occurrences: 2, risk_level: 'low',
  });
  const existing = [lesson('aaaaaa01')];
  // Тот же id и то же правило под другим id — оба дубли.
  const { accepted, rejected } = validateDistilledLessons(
    [lesson('aaaaaa01'), { ...lesson('bbbbbb02'), rule: existing[0].rule }],
    { existing });
  assert.equal(accepted.length, 0);
  assert.deepEqual(rejected.map(r => r.reason), ['lesson_duplicate', 'lesson_duplicate']);
  // Лимит длины правила: жёсткий операторский cap режет и канонический текст.
  const res = validateDistilledLessons([lesson('cccccc03')], { maxRuleChars: 10 });
  assert.equal(res.rejected[0].reason, 'lesson_too_large');
  // Лимит числа уроков.
  const many = Array.from({ length: 5 }, (_, i) => lesson(`dddddd0${i}`, i));
  const capped = validateDistilledLessons(many, { maxLessons: 2 });
  assert.equal(capped.accepted.length, 2);
  assert.equal(capped.rejected.at(-1).reason, 'lesson_limit_exceeded');
  // Невалидная форма.
  assert.equal(validateDistilledLessons([{ id: 'bad' }]).rejected[0].reason,
    'lesson_invalid');
});

test('хранилище: append мержит повторы, load читает и пропускает битые строки', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lessons-'));
  try {
    const path = join(dir, 'lessons.jsonl');
    const lesson = {
      id: 'lesson-c-aaaaaa01', category: 'c', pattern: 'p', rule: 'rule one',
      evidence_cards: ['1'], occurrences: 2, risk_level: 'low',
    };
    await appendLessons(path, [lesson]);
    // Повтор того же урока с другой карточкой — слияние, не дубль.
    await appendLessons(path, [{ ...lesson, evidence_cards: ['2'], occurrences: 3 }]);
    const loaded = await loadLessons(path);
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].occurrences, 5);
    assert.deepEqual(loaded[0].evidence_cards, ['1', '2']);
    // Битая строка пропускается, файл остаётся читаемым.
    await writeFile(path, '{"schema":1,"lesson":{}}\nnot json\n' +
      JSON.stringify({ schema: 1, lesson }) + '\n', { mode: 0o600 });
    const again = await loadLessons(path);
    assert.equal(again.length, 1);
    assert.equal(again[0].id, lesson.id);
    // Отсутствующий файл — пусто.
    assert.deepEqual(await loadLessons(join(dir, 'none.jsonl')), []);
    const text = await readFile(path, 'utf8');
    assert.match(text, /"schema":1/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('чтение: симлинк отклоняется, незавершённый хвост игнорируется', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lessons-'));
  const tree = await mkdtemp(join(tmpdir(), 'worktree-'));
  try {
    const path = join(dir, 'lessons.jsonl');
    const lesson = {
      id: 'lesson-c-aaaaaa01', category: 'c', pattern: 'p', rule: 'rule one',
      evidence_cards: ['1'], occurrences: 2, risk_level: 'low',
    };
    const full = JSON.stringify({ schema: 1, lesson });
    // Полные строки сохраняются, хвост без '\n' — нет.
    await writeFile(path, `${full}\n${full}`, { mode: 0o600 });
    assert.equal((await loadLessons(path)).length, 1);
    // Симлинк на файл — отказ, даже если цель валидна.
    const link = join(dir, 'link.jsonl');
    await symlink(path, link);
    await assert.rejects(() => loadLessons(link), /lessons_store_not_a_file/);
    await assert.rejects(() => appendLessons(link, [lesson]), /lessons_store_not_a_file/);
    // Ссылка, указывающая внутрь worktree — отказ по границе outside.
    const insideTree = join(tree, 'lessons.jsonl');
    await writeFile(insideTree, `${full}\n`, { mode: 0o600 });
    await assert.rejects(() => loadLessons(insideTree, { outside: [tree] }),
      /lessons_store_in_worktree/);
    // allowedDir обязан совпасть с реальным каталогом файла.
    await assert.rejects(() => loadLessons(path, { allowedDir: tree }),
      /lessons_store_dir_mismatch/);
    assert.equal((await loadLessons(path, { allowedDir: dir, outside: [tree] })).length, 1);
    // Запись проходит ту же границу, что и чтение — до создания цели/.tmp:
    // путь внутри worktree — отказ, файл не создаётся вообще.
    await assert.rejects(() => appendLessons(insideTree, [lesson], { outside: [tree] }),
      /lessons_store_in_worktree/);
    const forbidden = join(tree, 'new.jsonl');
    await assert.rejects(() => appendLessons(forbidden, [lesson],
      { allowedDir: dir, outside: [tree] }), /lessons_store_dir_mismatch/);
    await assert.rejects(() => appendLessons(forbidden, [lesson], { outside: [tree] }),
      /lessons_store_in_worktree/);
    await assert.rejects(() => loadLessons(forbidden, { outside: [tree] }),
      /lessons_store_in_worktree/);
    assert.equal(await stat(forbidden).then(() => true).catch(() => false), false);
    // Легальная запись с границами — работает.
    await appendLessons(path, [lesson], { allowedDir: dir, outside: [tree] });
    assert.ok((await loadLessons(path, { allowedDir: dir })).length >= 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(tree, { recursive: true, force: true });
  }
});
