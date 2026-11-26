import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, symlink, utimes,
  writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { formatDecisionsMarkdown, pinDecisions, recordDecision, recordDigest,
  resolveActiveDecisions, resolveLedgerPath, LEDGER_PATH_ENV, LEDGER_SCHEMA } from './decision-ledger.mjs';
import { canonicalJson } from './subject.mjs';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('./decision-ledger.mjs', import.meta.url));

async function sandbox() {
  const dir = await mkdtemp(join(tmpdir(), 'decision-ledger-'));
  const tree = join(dir, 'worktree');
  const ops = join(dir, 'ops');
  await mkdir(tree, { recursive: true });
  await mkdir(ops, { recursive: true });
  return { dir, tree, ledger: join(ops, 'decisions.jsonl'), cleanup: () => rm(dir, { recursive: true, force: true }) };
}

const base = recordedBy => ({ recordedBy, sourceCard: '1261' });

test('recordDecision appends a hashed record; resolve reads it back', async () => {
  const { tree, ledger, cleanup } = await sandbox();
  try {
    const rec = await recordDecision({ ledgerPath: ledger, scope: 'global',
      rule: 'CSV для ручной выгрузки', worktree: tree, ...base('lead') });
    assert.match(rec.id, /^[a-z0-9-]{36}$/);
    assert.equal(rec.status, 'active');
    assert.equal(rec.sha256, recordDigest(rec));
    const lines = (await readFile(ledger, 'utf8')).trim().split('\n');
    assert.equal(lines.length, 1);
    const slice = await resolveActiveDecisions({ ledgerPath: ledger, worktree: tree });
    assert.deepEqual(slice.ids, [rec.id]);
    assert.match(slice.text, /\[global\] CSV для ручной выгрузки/);
    assert.match(slice.digest, /^[a-f0-9]{64}$/);
  } finally { await cleanup(); }
});

test('resolve isolates projects strictly: only global plus the requested project', async () => {
  const { tree, ledger, cleanup } = await sandbox();
  try {
    await recordDecision({ ledgerPath: ledger, scope: 'global', rule: 'global rule', ...base('lead') });
    await recordDecision({ ledgerPath: ledger, scope: 'project:proj_aaa', rule: 'aaa rule', ...base('lead') });
    await recordDecision({ ledgerPath: ledger, scope: 'project:proj_bbb', rule: 'bbb secret rule', ...base('lead') });
    const a = await resolveActiveDecisions({ ledgerPath: ledger, projectId: 'proj_aaa', worktree: tree });
    assert.equal(a.ids.length, 2);
    assert.doesNotMatch(a.text, /bbb/);
    const none = await resolveActiveDecisions({ ledgerPath: ledger, worktree: tree });
    assert.equal(none.ids.length, 1);
    assert.match(none.text, /global rule/);
    const b = await resolveActiveDecisions({ ledgerPath: ledger, projectId: 'proj_bbb', worktree: tree });
    assert.equal(b.ids.length, 2);
    assert.notEqual(a.digest, b.digest);
  } finally { await cleanup(); }
});

test('supersedes marks the old decision via append-only tombstone', async () => {
  const { tree, ledger, cleanup } = await sandbox();
  try {
    const old = await recordDecision({ ledgerPath: ledger, scope: 'global', rule: 'old rule', ...base('lead') });
    const next = await recordDecision({ ledgerPath: ledger, scope: 'global', rule: 'new rule',
      supersedes: old.id, ...base('lead') });
    const lines = (await readFile(ledger, 'utf8')).trim().split('\n').map(l => JSON.parse(l));
    // Одна атомарная строка: supersedes живёт в новой записи, прошлая строка не
    // перезаписана и промежуточного «погашено без нового» не существует.
    assert.equal(lines.length, 2);
    assert.equal(lines[0].status, 'active');
    assert.equal(lines[1].id, next.id);
    assert.equal(lines[1].supersedes, old.id);
    const slice = await resolveActiveDecisions({ ledgerPath: ledger, worktree: tree });
    assert.deepEqual(slice.ids, [next.id]);
    assert.doesNotMatch(slice.text, /old rule/);
  } finally { await cleanup(); }
});

test('maxChars hard-limits the slice and flags truncation', async () => {
  const { tree, ledger, cleanup } = await sandbox();
  try {
    await recordDecision({ ledgerPath: ledger, scope: 'global', rule: 'r'.repeat(200), ...base('lead') });
    await recordDecision({ ledgerPath: ledger, scope: 'global', rule: 'q'.repeat(200), ...base('lead') });
    const slice = await resolveActiveDecisions({ ledgerPath: ledger, maxChars: 300, worktree: tree });
    assert.ok(slice.text.length <= 300);
    assert.equal(slice.truncated, true);
    assert.equal(slice.total, 2);
    assert.equal(slice.ids.length, 1);
    const full = await resolveActiveDecisions({ ledgerPath: ledger, worktree: tree });
    assert.equal(full.truncated, false);
    assert.equal(full.ids.length, 2);
  } finally { await cleanup(); }
});

test('fail-closed on corrupt JSONL and tampered sha256', async () => {
  const { tree, ledger, cleanup } = await sandbox();
  try {
    await recordDecision({ ledgerPath: ledger, scope: 'global', rule: 'fine', ...base('lead') });
    const good = await readFile(ledger, 'utf8');
    await writeFile(ledger, `${good}not-json\n`);
    await assert.rejects(() => resolveActiveDecisions({ ledgerPath: ledger, worktree: tree }),
      /decision_ledger_corrupt/);
    const rec = JSON.parse(good);
    rec.rule = 'forged';
    await writeFile(ledger, `${JSON.stringify(rec)}\n`);
    await assert.rejects(() => resolveActiveDecisions({ ledgerPath: ledger, worktree: tree }),
      /decision_ledger_tampered/);
    await assert.rejects(() => recordDecision({ ledgerPath: ledger, scope: 'global', rule: 'x', ...base('lead') }),
      /decision_ledger_tampered/);
  } finally { await cleanup(); }
});

test('fail-closed when the ledger lives inside the worker tree', async () => {
  const { tree, dir, cleanup } = await sandbox();
  try {
    const inside = join(tree, 'decisions.jsonl');
    await assert.rejects(() => recordDecision({ ledgerPath: inside, scope: 'global', rule: 'x',
      worktree: tree, ...base('lead') }), /decision_ledger_inside_worker_paths/);
    await writeFile(inside, `${JSON.stringify({})}\n`);
    await assert.rejects(() => resolveActiveDecisions({ ledgerPath: inside, worktree: tree }),
      /decision_ledger_inside_worker_paths/);
    const rel = 'relative/decisions.jsonl';
    await assert.rejects(() => recordDecision({ ledgerPath: rel, scope: 'global', rule: 'x',
      ...base('lead') }), /decision_ledger_path_relative/);
    assert.throws(() => resolveLedgerPath({ explicit: rel }), /decision_ledger_path_relative/);
    assert.equal(resolveLedgerPath({ env: {} }), null);
    assert.equal(resolveLedgerPath({ env: { [LEDGER_PATH_ENV]: join(dir, 'ops', 'd.jsonl') } }),
      join(dir, 'ops', 'd.jsonl'));
  } finally { await cleanup(); }
});

test('contradiction checks: duplicate rule, invalid and cross-scope supersedes', async () => {
  const { tree, ledger, cleanup } = await sandbox();
  try {
    const a = await recordDecision({ ledgerPath: ledger, scope: 'project:proj_aaa', rule: 'same', ...base('lead') });
    // Идемпотентный повтор той же записи — та же строка, новых линий нет.
    const again = await recordDecision({ ledgerPath: ledger, scope: 'project:proj_aaa', rule: 'same',
      sourceCard: '1261', recordedBy: 'lead' });
    assert.equal(again.id, a.id);
    assert.equal((await readFile(ledger, 'utf8')).trim().split('\n').length, 1);
    // Та же формулировка от другой карточки — противоречие.
    await assert.rejects(() => recordDecision({ ledgerPath: ledger, scope: 'project:proj_aaa',
      rule: 'same', sourceCard: '9', recordedBy: 'lead' }), /decision_ledger_rule_conflict/);
    await assert.rejects(() => recordDecision({ ledgerPath: ledger, scope: 'project:proj_aaa',
      rule: 'new', supersedes: 'nope', ...base('lead') }), /decision_ledger_supersedes_invalid/);
    // Проектное решение не гасит global — иначе утечка полномочий между проектами.
    const g = await recordDecision({ ledgerPath: ledger, scope: 'global', rule: 'g', ...base('lead') });
    await assert.rejects(() => recordDecision({ ledgerPath: ledger, scope: 'project:proj_aaa',
      rule: 'x', supersedes: g.id, ...base('lead') }), /decision_ledger_supersedes_invalid/);
    const b = await recordDecision({ ledgerPath: ledger, scope: 'project:proj_aaa', rule: 'r2',
      supersedes: a.id, ...base('lead') });
    await assert.rejects(() => recordDecision({ ledgerPath: ledger, scope: 'project:proj_aaa',
      rule: 'r3', supersedes: a.id, ...base('lead') }), /decision_ledger_supersedes_invalid/);
    const slice = await resolveActiveDecisions({ ledgerPath: ledger, projectId: 'proj_aaa', worktree: tree });
    assert.deepEqual(slice.ids, [g.id, b.id]);
  } finally { await cleanup(); }
});

test('CLI record/resolve roundtrip honours --worktree guard', async () => {
  const { tree, ledger, cleanup } = await sandbox();
  try {
    const { stdout } = await exec('node', [cli, 'record', '--ledger', ledger, '--scope', 'global',
      '--rule', 'from cli', '--source-card', '1261', '--recorded-by', 'lead', '--worktree', tree]);
    const rec = JSON.parse(stdout);
    assert.equal(rec.status, 'active');
    const resolved = await exec('node', [cli, 'resolve', '--ledger', ledger, '--project', 'proj_aaa',
      '--worktree', tree]);
    assert.deepEqual(JSON.parse(resolved.stdout).ids, [rec.id]);
    await assert.rejects(() => exec('node', [cli, 'record', '--ledger', join(tree, 'x.jsonl'),
      '--scope', 'global', '--rule', 'x', '--source-card', '1', '--recorded-by', 'lead',
      '--worktree', tree]), /decision_ledger_inside_worker_paths/);
  } finally { await cleanup(); }
});

test('fail-closed on symlink escape into the worktree, dangling or not', async () => {
  const { tree, dir, cleanup } = await sandbox();
  try {
    // Существующий файл внутри worktree через symlink в операторском каталоге.
    await writeFile(join(tree, 'inside.jsonl'), '');
    await symlink(join(tree, 'inside.jsonl'), join(dir, 'ops', 'link.jsonl'));
    await assert.rejects(() => recordDecision({ ledgerPath: join(dir, 'ops', 'link.jsonl'),
      scope: 'global', rule: 'x', worktree: tree, sourceCard: '1', recordedBy: 'lead' }),
      /decision_ledger_inside_worker_paths/);
    // Dangling symlink на ещё не созданный файл внутри worktree.
    await symlink(join(tree, 'future.jsonl'), join(dir, 'ops', 'dangling.jsonl'));
    await assert.rejects(() => recordDecision({ ledgerPath: join(dir, 'ops', 'dangling.jsonl'),
      scope: 'global', rule: 'x', worktree: tree, sourceCard: '1', recordedBy: 'lead' }),
      /decision_ledger_inside_worker_paths/);
    // Симлинк-родитель, указывающий внутрь worktree.
    await symlink(tree, join(dir, 'ops', 'treedir'));
    await assert.rejects(() => recordDecision({ ledgerPath: join(dir, 'ops', 'treedir', 'd.jsonl'),
      scope: 'global', rule: 'x', worktree: tree, sourceCard: '1', recordedBy: 'lead' }),
      /decision_ledger_inside_worker_paths/);
  } finally { await cleanup(); }
});

function forged(overrides) {
  const rec = { schema: LEDGER_SCHEMA, id: 'forge-1', scope: 'project:proj_bbb',
    status: 'active', rule: 'hostile', source_card: '1', timestamp: new Date().toISOString(),
    recorded_by: 'lead', ...overrides };
  rec.sha256 = recordDigest(rec);
  return rec;
}

test('read is fail-closed on cross-scope and dangling supersedes in the journal', async () => {
  const { tree, ledger, cleanup } = await sandbox();
  try {
    const g = await recordDecision({ ledgerPath: ledger, scope: 'global', rule: 'g', ...base('lead') });
    // Валидный по sha256 журнал, нарушающий инвариант scope: project:b гасит global.
    await appendFile(ledger, `${JSON.stringify(forged({ supersedes: g.id }))}\n`);
    await assert.rejects(() => resolveActiveDecisions({ ledgerPath: ledger, worktree: tree }),
      /decision_ledger_scope_violation/);
    await writeFile(ledger, `${JSON.stringify(forged({ id: 'forge-2', supersedes: 'ghost' }))}\n`);
    await assert.rejects(() => resolveActiveDecisions({ ledgerPath: ledger, worktree: tree }),
      /decision_ledger_scope_violation/);
  } finally { await cleanup(); }
});

test('concurrent supersedes of one target serialize under the lock', async () => {
  const { tree, ledger, cleanup } = await sandbox();
  try {
    const a = await recordDecision({ ledgerPath: ledger, scope: 'global', rule: 'a', ...base('lead') });
    const results = await Promise.allSettled([
      recordDecision({ ledgerPath: ledger, scope: 'global', rule: 'r1', supersedes: a.id, ...base('lead') }),
      recordDecision({ ledgerPath: ledger, scope: 'global', rule: 'r2', supersedes: a.id, ...base('lead') }),
    ]);
    const ok = results.filter(r => r.status === 'fulfilled');
    const failed = results.filter(r => r.status === 'rejected');
    assert.equal(ok.length, 1);
    assert.match(String(failed[0].reason), /decision_ledger_supersedes_invalid/);
    const lines = (await readFile(ledger, 'utf8')).trim().split('\n');
    assert.equal(lines.length, 2);
    const slice = await resolveActiveDecisions({ ledgerPath: ledger, worktree: tree });
    assert.equal(slice.ids.length, 1);
  } finally { await cleanup(); }
});

test('idempotent retry must match supersedes; a different target is a conflict', async () => {
  const { tree, ledger, cleanup } = await sandbox();
  try {
    const a = await recordDecision({ ledgerPath: ledger, scope: 'global', rule: 'a', ...base('lead') });
    const c = await recordDecision({ ledgerPath: ledger, scope: 'global', rule: 'c', ...base('lead') });
    const b = await recordDecision({ ledgerPath: ledger, scope: 'global', rule: 'b',
      supersedes: a.id, ...base('lead') });
    const again = await recordDecision({ ledgerPath: ledger, scope: 'global', rule: 'b',
      supersedes: a.id, ...base('lead') });
    assert.equal(again.id, b.id);
    await assert.rejects(() => recordDecision({ ledgerPath: ledger, scope: 'global', rule: 'b',
      supersedes: c.id, ...base('lead') }), /decision_ledger_rule_conflict/);
    await assert.rejects(() => recordDecision({ ledgerPath: ledger, scope: 'global', rule: 'b',
      ...base('lead') }), /decision_ledger_rule_conflict/);
  } finally { await cleanup(); }
});

test('a journal not ending in newline fails closed and stays untouched', async () => {
  const { tree, ledger, cleanup } = await sandbox();
  try {
    const rec = await recordDecision({ ledgerPath: ledger, scope: 'global', rule: 'ok', ...base('lead') });
    const partial = JSON.stringify(forged({ id: 'part-1', scope: 'global' }));
    await appendFile(ledger, partial); // без '\n' — оборванная частичная запись
    await assert.rejects(() => resolveActiveDecisions({ ledgerPath: ledger, worktree: tree }),
      /decision_ledger_corrupt/);
    await assert.rejects(() => recordDecision({ ledgerPath: ledger, scope: 'global', rule: 'more',
      worktree: tree, ...base('lead') }), /decision_ledger_corrupt/);
    const lines = (await readFile(ledger, 'utf8')).split('\n').filter(Boolean);
    assert.equal(lines.length, 2); // append поверх обрыва не состоялся
    assert.equal(JSON.parse(lines[0]).id, rec.id);
  } finally { await cleanup(); }
});

test('pinDecisions resolves once per attempt key and reuses the snapshot', async () => {
  let calls = 0;
  const pinned = pinDecisions(async () => ({ text: `t${++calls}`, digest: 'd'.repeat(64), ids: [] }));
  const a1 = await pinned('1:1');
  const a2 = await pinned('1:1');
  const b = await pinned('1:2');
  assert.equal(a1, a2);
  assert.notEqual(a1, b);
  assert.equal(calls, 2);
});

test('ledger parent directory containing or inside the worktree is rejected', async () => {
  const { tree, dir, cleanup } = await sandbox();
  try {
    // Журнал в каталоге, который содержит worktree: lockfile/запись небезопасны.
    await assert.rejects(() => recordDecision({ ledgerPath: join(dir, 'top.jsonl'),
      scope: 'global', rule: 'x', worktree: tree, sourceCard: '1', recordedBy: 'lead' }),
      /decision_ledger_inside_worker_paths/);
    // А журнал в изолированном операторском каталоге по-прежнему работает.
    const rec = await recordDecision({ ledgerPath: join(dir, 'ops', 'ok.jsonl'),
      scope: 'global', rule: 'x', worktree: tree, sourceCard: '1', recordedBy: 'lead' });
    assert.equal(rec.status, 'active');
  } finally { await cleanup(); }
});

test('a symlink to the same ledger shares the canonical lockfile', async () => {
  const { tree, dir, ledger, cleanup } = await sandbox();
  try {
    const a = await recordDecision({ ledgerPath: ledger, scope: 'global', rule: 'a', ...base('lead') });
    const alias = join(dir, 'ops', 'alias.jsonl');
    await symlink(ledger, alias);
    const results = await Promise.allSettled([
      recordDecision({ ledgerPath: alias, scope: 'global', rule: 'r1', supersedes: a.id, ...base('lead') }),
      recordDecision({ ledgerPath: ledger, scope: 'global', rule: 'r2', supersedes: a.id, ...base('lead') }),
    ]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    const lines = (await readFile(ledger, 'utf8')).trim().split('\n');
    assert.equal(lines.length, 2);
    const slice = await resolveActiveDecisions({ ledgerPath: alias, worktree: tree });
    assert.equal(slice.ids.length, 1);
    // Lockfile после завершения убран; ни один не остался рядом с симлинком.
    assert.rejects(() => readFile(`${ledger}.lock`), /ENOENT/);
  } finally { await cleanup(); }
});

test('a duplicated id in the journal fails closed instead of masking scope', async () => {
  const { tree, ledger, cleanup } = await sandbox();
  try {
    const g = await recordDecision({ ledgerPath: ledger, scope: 'global', rule: 'g', ...base('lead') });
    // Валидная по sha256 запись project:b с тем же id — не должна перекрывать global.
    await appendFile(ledger, `${JSON.stringify(forged({ id: g.id }))}\n`);
    await assert.rejects(() => resolveActiveDecisions({ ledgerPath: ledger, worktree: tree }),
      /decision_ledger_duplicate_id/);
    await assert.rejects(() => recordDecision({ ledgerPath: ledger, scope: 'global', rule: 'x',
      worktree: tree, ...base('lead') }), /decision_ledger_duplicate_id/);
  } finally { await cleanup(); }
});

test('pinDecisions caches the in-flight promise: one resolve under a race', async () => {
  let calls = 0;
  const pinned = pinDecisions(async () => {
    calls += 1;
    await new Promise(r => setTimeout(r, 20));
    return { text: 't', digest: 'd'.repeat(64), ids: [], truncated: false, total: 0 };
  });
  const [a, b, c] = await Promise.all([pinned('1:1'), pinned('1:1'), pinned('1:1')]);
  assert.equal(calls, 1);
  assert.equal(a, b);
  assert.equal(b, c);
});

// Срез с настоящим пересчитываемым digest — как у resolveActiveDecisions.
const sliceFor = items => {
  const digest = createHash('sha256').update(canonicalJson(items)).digest('hex');
  return { text: items.map(i => `- [${i.scope}] ${i.rule} (${i.id})`).join('\n'),
    digest, ids: items.map(i => i.id), truncated: false, total: items.length, items };
};

test('pinned snapshot persists across process restart for the same epoch', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'decision-pin-'));
  try {
    const slice = sliceFor([{ id: 'x', scope: 'global', rule: 'r' }]);
    let calls = 0;
    const first = pinDecisions(async () => { calls += 1; return slice; }, { persistDir: dir });
    assert.deepEqual(await first('7:1'), slice);
    // «Рестарт»: новый экземпляр, resolver упал бы — но вызова нет, срез из state.
    const second = pinDecisions(async () => { throw new Error('must not resolve'); },
      { persistDir: dir });
    assert.deepEqual(await second('7:1'), slice);
    assert.equal(calls, 1);
    // Другой epoch — свой snapshot, не наследует чужой.
    const y = sliceFor([{ id: 'y', scope: 'global', rule: 'r2' }]);
    const third = pinDecisions(async () => y, { persistDir: dir });
    assert.deepEqual((await third('7:2')).ids, ['y']);
    // Подмена любого поля без пересчёта pin_sha256 — fail-closed; для каждой
    // подмены — свежий pinDecisions, чтобы гарантированно читать файл с диска.
    const name = `decisions-${createHash('sha256').update('7:1').digest('hex').slice(0, 32)}.json`;
    const file = join(dir, name);
    const saved = JSON.parse(await readFile(file, 'utf8'));
    for (const tampered of [
      { ...saved, text: 'forged' },
      { ...saved, digest: 'f'.repeat(64) },
      { ...saved, total: 0 },
      { ...saved, truncated: true },
      { ...saved, ids: [] },
      { ...saved, pin_sha256: 'f'.repeat(64) },
    ]) {
      await writeFile(file, JSON.stringify(tampered));
      const fresh = pinDecisions(async () => slice, { persistDir: dir });
      await assert.rejects(() => fresh('7:1'), /decision_ledger_pin_invalid/);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('pin publish is atomic: tmp+link, no partial file, winner pin is canonical', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'decision-pin-'));
  try {
    const a = sliceFor([{ id: 'a', scope: 'global', rule: 'ra' }]);
    const b = sliceFor([{ id: 'b', scope: 'global', rule: 'rb' }]);
    // Два «процесса» (два экземпляра) публикуют одновременно — выигрывает один,
    // оба вызова получают один и тот же канонический срез.
    const pinA = pinDecisions(async () => a, { persistDir: dir });
    const pinB = pinDecisions(async () => b, { persistDir: dir });
    const [ra, rb] = await Promise.all([pinA('8:1'), pinB('8:1')]);
    assert.deepEqual(ra, rb);
    assert.ok(ra.ids[0] === 'a' || ra.ids[0] === 'b');
    const files = await readdir(dir);
    assert.equal(files.filter(f => f.endsWith('.tmp')).length, 0);
    const saved = JSON.parse(await readFile(join(dir, files[0]), 'utf8'));
    assert.equal(saved.digest, ra.digest);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('canonical target parent inside/containing the worktree is rejected', async () => {
  const { tree, dir, cleanup } = await sandbox();
  try {
    // Симлинк в операторском каталоге на файл в каталоге, СОДЕРЖАЩЕМ worktree:
    // сам target вне tree, но его канонический родитель — нет.
    const alias = join(dir, 'ops', 'linked.jsonl');
    await symlink(join(dir, 'real.jsonl'), alias);
    await assert.rejects(() => recordDecision({ ledgerPath: alias, scope: 'global', rule: 'x',
      worktree: tree, sourceCard: '1', recordedBy: 'lead' }),
      /decision_ledger_inside_worker_paths/);
  } finally { await cleanup(); }
});

test('recordDecision refuses a duplicated id before appending', async () => {
  const { tree, ledger, cleanup } = await sandbox();
  try {
    const a = await recordDecision({ ledgerPath: ledger, scope: 'global', rule: 'a', ...base('lead') });
    await assert.rejects(() => recordDecision({ ledgerPath: ledger, scope: 'project:proj_bbb',
      rule: 'hostile', id: a.id, ...base('lead') }), /decision_ledger_duplicate_id/);
    const lines = (await readFile(ledger, 'utf8')).trim().split('\n');
    assert.equal(lines.length, 1); // журнал не испорчен
  } finally { await cleanup(); }
});

// AUDIT-3b: гарантированно мёртвый pid — завершившийся дочерний процесс.
async function spawnDeadPid() {
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    child.on('exit', () => resolve(child.pid));
    child.on('error', () => resolve(2 ** 22 + 12345));
  });
}

test('stale lock recovery: expired dead-pid lock is reclaimed and recordDecision succeeds', async () => {
  const { tree, ledger, cleanup } = await sandbox();
  try {
    const deadPid = await spawnDeadPid();
    const lockPath = `${ledger}.lock`;
    // Лок снимается только когда он И просрочен, И владелец мёртв.
    await writeFile(lockPath, JSON.stringify({
      pid: deadPid, token: 'dead-token', createdAt: new Date(Date.now() - 120_000).toISOString(),
    }));
    const rec = await recordDecision({ ledgerPath: ledger, scope: 'global',
      rule: 'written after dead-pid lock recovery', worktree: tree, ...base('lead') });
    assert.equal(rec.status, 'active');
    // Лок снят владельцем после записи — файла не осталось.
    await assert.rejects(() => readFile(lockPath), /ENOENT/);
  } finally { await cleanup(); }
});

test('fresh dead-pid lock is NOT reclaimed: expiry is required alongside owner death', async () => {
  const { tree, ledger, cleanup } = await sandbox();
  try {
    const deadPid = await spawnDeadPid();
    const lockPath = `${ledger}.lock`;
    // Мёртвый pid, но лок свежий — оба условия обязательны, рейпа нет.
    await writeFile(lockPath, JSON.stringify({
      pid: deadPid, token: 'fresh-dead-token', createdAt: new Date().toISOString(),
    }));
    await assert.rejects(() => recordDecision({ ledgerPath: ledger, scope: 'global',
      rule: 'must never land', worktree: tree, ...base('lead') }), /decision_ledger_locked/);
    const meta = JSON.parse(await readFile(lockPath, 'utf8'));
    assert.equal(meta.pid, deadPid);
    await rm(lockPath, { force: true });
  } finally { await cleanup(); }
});

test('multi-slot TOCTOU: expired lock of a LIVE pid is never reclaimed', async () => {
  const { tree, ledger, cleanup } = await sandbox();
  try {
    const lockPath = `${ledger}.lock`;
    // pid жив (наш собственный процесс) и лок старше staleLockMs — владелец
    // может быть просто медленным; рейп под живым pid размыкал бы exclusion.
    await writeFile(lockPath, JSON.stringify({
      pid: process.pid,
      token: 'live-token',
      createdAt: new Date(Date.now() - 120_000).toISOString(),
    }));
    await assert.rejects(() => recordDecision({ ledgerPath: ledger, scope: 'global',
      rule: 'must never land', worktree: tree, ...base('lead') }), /decision_ledger_locked/);
    // Живой лок не тронут восстановлением — контент с токеном на месте.
    const meta = JSON.parse(await readFile(lockPath, 'utf8'));
    assert.equal(meta.pid, process.pid);
    assert.equal(meta.token, 'live-token');
    await rm(lockPath, { force: true });
    // После ручного снятия запись снова работает — журнал не испорчен.
    const rec = await recordDecision({ ledgerPath: ledger, scope: 'global',
      rule: 'lands after manual unlock', worktree: tree, ...base('lead') });
    assert.equal(rec.status, 'active');
  } finally { await cleanup(); }
});

test('corrupt legacy lock without a pid is reclaimed by mtime expiry once stale', async () => {
  const { tree, ledger, cleanup } = await sandbox();
  try {
    const lockPath = `${ledger}.lock`;
    // Оборванная на создании запись (crash между open и writeFile) не несёт
    // pid: живого владельца не существует, лок судится по mtime и снимается.
    await writeFile(lockPath, '###');
    const past = new Date(Date.now() - 120_000);
    await utimes(lockPath, past, past);
    const rec = await recordDecision({ ledgerPath: ledger, scope: 'global',
      rule: 'written after legacy lock recovery', worktree: tree, ...base('lead') });
    assert.equal(rec.status, 'active');
    await assert.rejects(() => readFile(lockPath), /ENOENT/);
  } finally { await cleanup(); }
});

test('live lock contention is preserved: fresh lock of a live pid still blocks writes', async () => {
  const { tree, ledger, cleanup } = await sandbox();
  try {
    const lockPath = `${ledger}.lock`;
    await writeFile(lockPath, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
    await assert.rejects(() => recordDecision({ ledgerPath: ledger, scope: 'global',
      rule: 'must never land', worktree: tree, ...base('lead') }), /decision_ledger_locked/);
    // Живой лок не тронут восстановлением — убираем вручную.
    const meta = JSON.parse(await readFile(lockPath, 'utf8'));
    assert.equal(meta.pid, process.pid);
    await rm(lockPath, { force: true });
    // После ручного снятия запись снова работает — журнал не испорчен.
    const rec = await recordDecision({ ledgerPath: ledger, scope: 'global',
      rule: 'lands after manual unlock', worktree: tree, ...base('lead') });
    assert.equal(rec.status, 'active');
    const lines = (await readFile(ledger, 'utf8')).trim().split('\n');
    assert.equal(lines.length, 1);
  } finally { await cleanup(); }
});

test('formatDecisionsMarkdown renders a concise table of active decisions for intake sync', async () => {
  const { tree, ledger, cleanup } = await sandbox();
  try {
    const a = await recordDecision({ ledgerPath: ledger, scope: 'global',
      rule: 'Board is the single queue', worktree: tree, ...base('lead') });
    const old = await recordDecision({ ledgerPath: ledger, scope: 'project:proj_aaa',
      rule: 'outdated project rule', worktree: tree, ...base('lead') });
    const b = await recordDecision({ ledgerPath: ledger, scope: 'project:proj_aaa',
      rule: 'pipe | and newline\nmust not break the table', supersedes: old.id, worktree: tree, ...base('lead') });

    const entries = (await readFile(ledger, 'utf8')).trim().split('\n').map(l => JSON.parse(l));
    const md = formatDecisionsMarkdown(entries);
    assert.match(md, /^\| id \| scope \| rule \| source_card \|/);
    assert.match(md, /\| --- \| --- \| --- \| --- \|/);
    assert.match(md, new RegExp(`\\| ${a.id} \\| global \\| Board is the single queue \\| 1261 \\|`));
    assert.match(md, new RegExp(`\\| ${b.id} \\| project:proj_aaa \\|`));
    // Погашенная supersedes-цель отфильтрована по семантике append-only
    // журнала, хотя её строка в логе всё ещё status 'active'.
    assert.doesNotMatch(md, /outdated project rule/);
    // Явный status 'superseded' фильтруется так же.
    const md2 = formatDecisionsMarkdown(entries.map(e => ({ ...e, status: 'superseded' })));
    assert.equal(md2, '_No active decisions._');
    // Пайпы экранируются, переводы строк схлопываются — таблица не ломается.
    assert.match(md, /pipe \\\| and newline must not break the table/);
    assert.ok(!md.split('\n').some(line => line.includes('must not break') && !line.startsWith('| ')));
    // Пустой/неактивный набор — честная заглушка, а не битая таблица.
    assert.equal(formatDecisionsMarkdown([]), '_No active decisions._');
    assert.equal(formatDecisionsMarkdown(null), '_No active decisions._');
    assert.equal(formatDecisionsMarkdown([{ ...entries[0], status: 'superseded' }]), '_No active decisions._');
    // Срез items (camelCase sourceCard, без status) тоже рендерится.
    const slice = await resolveActiveDecisions({ ledgerPath: ledger, projectId: 'proj_aaa', worktree: tree });
    const md3 = formatDecisionsMarkdown(slice.items.map(i => ({ ...i, sourceCard: '1261' })));
    assert.match(md3, /\| global \| Board is the single queue \| 1261 \|/);
  } finally { await cleanup(); }
});

test('pinDecisions evicts rejected pins: a later call retries resolve instead of pinning the failure', async () => {
  let calls = 0;
  const pinned = pinDecisions(async () => {
    calls += 1;
    if (calls === 1) throw new Error('transient ledger read failure');
    return { text: 't', digest: 'd'.repeat(64), ids: [], truncated: false, total: 0 };
  });
  await assert.rejects(() => pinned('9:1'), /transient ledger read failure/);
  const retry = await pinned('9:1');
  assert.equal(calls, 2);
  assert.equal(retry.digest, 'd'.repeat(64));
  // Успешный результат закрепляется — третий вызов не перечитывает.
  assert.equal(await pinned('9:1'), retry);
  assert.equal(calls, 2);
});

test('pinDecisions LRU cap: at most 64 pinned keys per factory, oldest evicted first', async () => {
  let calls = 0;
  const mk = keyCalls => pinDecisions(async () => {
    keyCalls.n = (keyCalls.n ?? 0) + 1;
    return { text: 't', digest: 'd'.repeat(64), ids: [], truncated: false, total: 0 };
  });
  const counter = { n: 0 };
  const pinned = mk(counter);
  // 64 ключа помещаются в кэш; 65-й вытесняет самый старый ('lru:0').
  for (let i = 0; i < 64; i++) await pinned(`lru:${i}`);
  assert.equal(counter.n, 64);
  // Повтор свежего ключа — кэш, новых resolve нет.
  await pinned('lru:63');
  assert.equal(counter.n, 64);
  await pinned('lru:overflow');
  assert.equal(counter.n, 65);
  // 'lru:0' вытеснен — обращение перезапускает resolve; 'lru:1' ещё в кэше.
  await pinned('lru:1');
  assert.equal(counter.n, 65);
  await pinned('lru:0');
  assert.equal(counter.n, 66);
});
