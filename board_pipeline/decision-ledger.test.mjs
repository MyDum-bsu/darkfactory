import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { pinDecisions, recordDecision, recordDigest, resolveActiveDecisions,
  resolveLedgerPath, LEDGER_PATH_ENV, LEDGER_SCHEMA } from './decision-ledger.mjs';

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
