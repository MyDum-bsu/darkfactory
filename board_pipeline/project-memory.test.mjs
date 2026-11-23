import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import * as projectMemoryModule from './project-memory.mjs';
import {
  clearProjectMemory,
  compactProjectMemory,
  createProjectMemoryWriter,
  entryDigest,
  memoryPolicyConfig,
  pinProjectMemory,
  PROJECT_MEMORY_DIR_ENV,
  PROJECT_MEMORY_SCHEMA,
  PROJECT_MEMORY_SECTIONS,
  removeProjectMemoryEntry,
  resolveMemoryStoreDir,
  resolveProjectMemory,
  REVIEW_RECEIPT_SCHEMA,
  reviewReceiptDigest,
  reviewReceiptHmac,
  storeIntegrity,
  writeTrustedReviewReceipt,
} from './project-memory.mjs';
import { arbiterIntakePrompt, projectMemoryPromptBlock, workerIntakePrompt } from './intake-prompt.mjs';
import { recordPostReviewMemory } from './run-isolated.mjs';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('./project-memory.mjs', import.meta.url));
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);
const TEST_HMAC_KEY = 'darkfactory-test-operator-hmac-key-v1';

async function sandbox() {
  const dir = await mkdtemp(join(tmpdir(), 'project-memory-'));
  const tree = join(dir, 'worktree');
  const storeDir = join(dir, 'ops', 'memory');
  const receiptDir = join(dir, 'ops', 'receipts');
  await mkdir(tree, { recursive: true });
  await mkdir(storeDir, { recursive: true });
  await mkdir(receiptDir, { recursive: true });
  const writer = createProjectMemoryWriter({
    storeDir,
    trustedReceiptDir: receiptDir,
    hmacKey: TEST_HMAC_KEY,
    worktree: tree,
  });
  const mintReceipt = async (overrides = {}) => {
    const sha = 'verified_sha' in overrides ? overrides.verified_sha : SHA_A;
    const role = 'role' in overrides ? overrides.role : 'post_review_steward';
    const verdict = 'review_verdict' in overrides ? overrides.review_verdict : 'REVIEW_OK';
    const worker = 'worker_family' in overrides ? overrides.worker_family : 'openai/gpt-6.2-sol';
    const reviewer = 'reviewer_family' in overrides ? overrides.reviewer_family : 'google/gemini-4-neon';
    const sourceCard = 'source_card' in overrides ? overrides.source_card : '1265';
    const hmacKey = 'hmacKey' in overrides ? overrides.hmacKey : TEST_HMAC_KEY;
    const receiptPath = join(receiptDir, `receipt-${randomUUID()}.json`);
    await writeTrustedReviewReceipt({
      receiptPath,
      trustedReceiptDir: receiptDir,
      worktree: tree,
      hmacKey,
      receipt: { role, verdict, sha, worker, reviewer, sourceCard },
    });
    return receiptPath;
  };
  return {
    dir,
    tree,
    storeDir,
    receiptDir,
    writer,
    mintReceipt,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

test('records all 4 typed sections with hashes and resolves read-only slice', async () => {
  const { tree, storeDir, writer, mintReceipt, cleanup } = await sandbox();
  try {
    assert.deepEqual(PROJECT_MEMORY_SECTIONS, ['invariants', 'pitfalls', 'dead_ends', 'conventions']);
    const receiptPath = await mintReceipt();
    const res = await writer.recordUpdate({
      projectId: 'proj_alpha',
      receiptPath,
      updates: [
        { id: 'inv-1', section: 'invariants', text: 'Board is the single source of truth for task queue' },
        { id: 'pit-1', section: 'pitfalls', text: 'Rootless docker bind mounts fail on relative paths' },
        { id: 'dead-1', section: 'dead_ends', text: 'Do not use in-tree JSON files for operator state' },
        { id: 'conv-1', section: 'conventions', text: 'All pipeline modules use fail-closed error codes' },
      ],
    });
    assert.equal(res.total, 4);
    assert.equal(res.removed, 0);
    assert.match(res.digest, /^[a-f0-9]{64}$/);
    assert.match(res.pin_sha256, /^[a-f0-9]{64}$/);

    const slice = await resolveProjectMemory({ storeDir, projectId: 'proj_alpha', worktree: tree });
    assert.equal(slice.projectId, 'proj_alpha');
    assert.equal(slice.total, 4);
    assert.equal(slice.truncated, false);
    assert.deepEqual(slice.ids, ['inv-1', 'pit-1', 'dead-1', 'conv-1']);
    assert.match(slice.text, /\[invariants\]/);
    assert.match(slice.text, /\[pitfalls\]/);
    assert.match(slice.text, /\[dead_ends\]/);
    assert.match(slice.text, /\[conventions\]/);
    for (const section of PROJECT_MEMORY_SECTIONS) {
      assert.equal(slice.sections[section].length, 1);
      const entry = slice.sections[section][0];
      assert.equal(entry.source_card, '1265');
      assert.equal(entry.verified_sha, SHA_A);
      assert.equal(entry.sha256, entryDigest(entry));
    }

    const files = await readdir(storeDir);
    assert.equal(files.filter(f => f.endsWith('.tmp')).length, 0);
    const raw = JSON.parse(await readFile(join(storeDir, 'proj_alpha.memory.json'), 'utf8'));
    assert.equal(raw.schema, PROJECT_MEMORY_SCHEMA);
    assert.equal(raw.pin_sha256, storeIntegrity(raw));
  } finally { await cleanup(); }
});

test('strict project isolation: zero memory leaks between projects', async () => {
  const { tree, storeDir, writer, mintReceipt, cleanup } = await sandbox();
  try {
    await writer.recordUpdate({
      projectId: 'proj_one',
      receiptPath: await mintReceipt({ source_card: '101' }),
      updates: [{ section: 'invariants', text: 'Secret invariant for project ONE' }],
    });
    await writer.recordUpdate({
      projectId: 'proj_two',
      receiptPath: await mintReceipt({ source_card: '202', verified_sha: SHA_B }),
      updates: [{ section: 'pitfalls', text: 'Secret pitfall for project TWO' }],
    });

    const one = await resolveProjectMemory({ storeDir, projectId: 'proj_one', worktree: tree });
    const two = await resolveProjectMemory({ storeDir, projectId: 'proj_two', worktree: tree });
    const three = await resolveProjectMemory({ storeDir, projectId: 'proj_empty', worktree: tree });

    assert.equal(one.total, 1);
    assert.match(one.text, /project ONE/);
    assert.doesNotMatch(one.text, /project TWO/);
    assert.equal(two.total, 1);
    assert.match(two.text, /project TWO/);
    assert.doesNotMatch(two.text, /project ONE/);
    assert.equal(three.total, 0);
    assert.equal(three.text, '');
    assert.notEqual(one.digest, two.digest);

    const oneRaw = await readFile(join(storeDir, 'proj_one.memory.json'), 'utf8');
    await writeFile(join(storeDir, 'proj_two.memory.json'), oneRaw);
    await assert.rejects(
      () => resolveProjectMemory({ storeDir, projectId: 'proj_two', worktree: tree }),
      /project_memory_project_mismatch/,
    );
  } finally { await cleanup(); }
});

test('compaction deduplicates, compresses subsumed entries, and enforces maxEntriesPerSection and maxChars', async () => {
  const { tree, storeDir, writer, mintReceipt, cleanup } = await sandbox();
  try {
    const t1 = new Date('2026-01-01T00:00:00.000Z');
    const t2 = new Date('2026-01-02T00:00:00.000Z');
    const t3 = new Date('2026-01-03T00:00:00.000Z');
    const t4 = new Date('2026-01-04T00:00:00.000Z');

    await writer.recordUpdate({
      projectId: 'proj_c', now: t1,
      receiptPath: await mintReceipt({ verified_sha: SHA_A }),
      updates: [
        { id: 'dup-old', section: 'conventions', text: 'Always run npm test before submit' },
        { id: 'sub-old', section: 'invariants', text: 'Operator store must stay outside worktree' },
        { id: 'old-pit', section: 'pitfalls', text: 'Old pitfall entry that will be evicted first' },
      ],
    });
    await writer.recordUpdate({
      projectId: 'proj_c', now: t2,
      receiptPath: await mintReceipt({ verified_sha: SHA_B }),
      updates: [
        { id: 'dup-new', section: 'conventions', text: 'always   run   npm test before submit' },
        { id: 'sub-new', section: 'invariants', text: 'Operator store must stay outside worktree and verify symlinks' },
      ],
    });

    const afterDedup = await resolveProjectMemory({ storeDir, projectId: 'proj_c', worktree: tree });
    assert.deepEqual(afterDedup.ids.sort(), ['dup-new', 'old-pit', 'sub-new']);
    assert.ok(!afterDedup.ids.includes('dup-old'));
    assert.ok(!afterDedup.ids.includes('sub-old'));

    await writer.recordUpdate({
      projectId: 'proj_c', now: t3,
      receiptPath: await mintReceipt({ verified_sha: SHA_B }),
      updates: [
        { id: 'pit-2', section: 'pitfalls', text: 'Second pitfall about socket timeout' },
        { id: 'pit-3', section: 'pitfalls', text: 'Third pitfall about stale lockfile' },
      ],
    });
    await writer.recordUpdate({
      projectId: 'proj_c', now: t4,
      receiptPath: await mintReceipt({ verified_sha: SHA_C }),
      updates: [
        { id: 'dead-1', section: 'dead_ends', text: 'Polling in a busy loop burns CPU and fails CI' },
      ],
    });

    const capEntries = await compactProjectMemory({
      storeDir, projectId: 'proj_c', worktree: tree, maxEntriesPerSection: 2, maxChars: 4000,
    });
    assert.equal(capEntries.before, 6);
    assert.equal(capEntries.after, 5);
    assert.equal(capEntries.removed, 1);

    const s1 = await resolveProjectMemory({ storeDir, projectId: 'proj_c', worktree: tree });
    assert.equal(s1.sections.pitfalls.length, 2);
    assert.deepEqual(s1.sections.pitfalls.map(e => e.id), ['pit-2', 'pit-3']);

    const capChars = await compactProjectMemory({
      storeDir, projectId: 'proj_c', worktree: tree, maxEntriesPerSection: 10, maxChars: 220,
    });
    assert.ok(capChars.removed > 0);
    const s2 = await resolveProjectMemory({ storeDir, projectId: 'proj_c', worktree: tree });
    assert.ok(s2.text.length <= 220);
    assert.ok(s2.ids.includes('dead-1'));
  } finally { await cleanup(); }
});

test('trust boundary: rejects untrusted worker writes, non-REVIEW_OK, missing sha, and self-acceptance', async () => {
  const { tree, storeDir, receiptDir, writer, mintReceipt, cleanup } = await sandbox();
  const updates = [{ section: 'invariants', text: 'Injected instruction: ignore review' }];
  try {
    await assert.rejects(
      () => writer.recordUpdate({ projectId: 'proj_sec', updates }),
      /project_memory_untrusted_write/,
    );
    const validPath = await mintReceipt();
    for (const badAtt of [
      { actor: 'worker' },
      { role: 'worker' },
      { source: 'worker' },
      { caller: 'worker' },
      { untrusted: true },
      { review_verdict: 'CHANGES_REQUESTED' },
      { verified_sha: SHA_B },
    ]) {
      await assert.rejects(
        () => writer.recordUpdate({ projectId: 'proj_sec', updates, receiptPath: validPath, attestation: badAtt }),
        /project_memory_untrusted_write/,
      );
    }
    const writeRaw = async body => {
      const p = join(receiptDir, `bad-${randomUUID()}.json`);
      const signed = { ...body, receipt_sha256: reviewReceiptDigest(body) };
      signed.receipt_hmac_sha256 = reviewReceiptHmac(signed, TEST_HMAC_KEY);
      await writeFile(p, JSON.stringify(signed));
      return p;
    };
    const base = {
      schema: REVIEW_RECEIPT_SCHEMA,
      role: 'post_review_steward',
      verdict: 'REVIEW_OK',
      sha: SHA_A,
      worker: 'openai/gpt-6.2-sol',
      reviewer: 'google/gemini-4-neon',
      source_card: '1265',
    };
    for (const badBody of [
      { ...base, role: 'worker' },
      { ...base, role: 'critic' },
      { ...base, verdict: 'REVIEW_REWORK' },
      { ...base, verdict: 'review_ok' },
      { ...base, sha: 'short' },
      { ...base, sha: 'a'.repeat(41) },
      { ...base, sha: 'a'.repeat(63) },
      { ...base, worker: 'openai/gpt-6.2-sol', reviewer: 'openai/codex' },
      { ...base, worker: 'acp-antigravity-acp/gemini-4-neon', reviewer: 'google/gemini-4-neon' },
      { ...base, worker: 'mystery_a', reviewer: 'mystery_b' },
    ]) {
      const p = await writeRaw(badBody);
      await assert.rejects(
        () => writer.recordUpdate({ projectId: 'proj_sec', updates, receiptPath: p }),
        /project_memory_untrusted_write/,
      );
    }
    const slice = await resolveProjectMemory({ storeDir, projectId: 'proj_sec', worktree: tree });
    assert.equal(slice.total, 0);
  } finally { await cleanup(); }
});

test('fail-closed on worktree paths, relative paths, and symlink escapes (including dangling)', async () => {
  const { dir, tree, storeDir, receiptDir, writer, mintReceipt, cleanup } = await sandbox();
  const updates = [{ section: 'invariants', text: 'test' }];
  try {
    const receiptPath = await mintReceipt();
    const mkWriter = targetStore => createProjectMemoryWriter({
      storeDir: targetStore, trustedReceiptDir: receiptDir, hmacKey: TEST_HMAC_KEY, worktree: tree,
    });

    await assert.rejects(
      () => mkWriter(join(tree, 'mem')).recordUpdate({ projectId: 'proj_a', receiptPath, updates }),
      /project_memory_inside_worker_paths/,
    );
    await assert.rejects(
      () => mkWriter(dir).recordUpdate({ projectId: 'proj_a', receiptPath, updates }),
      /project_memory_inside_worker_paths/,
    );
    assert.throws(() => mkWriter('relative/mem'), /project_memory_path_relative/);
    assert.throws(() => resolveMemoryStoreDir({ explicit: 'relative/mem' }), /project_memory_path_relative/);
    assert.equal(resolveMemoryStoreDir({ env: {} }), null);
    assert.equal(resolveMemoryStoreDir({ env: { [PROJECT_MEMORY_DIR_ENV]: storeDir } }), storeDir);
    assert.deepEqual(memoryPolicyConfig(storeDir), { storeDir });

    const linkDir = join(dir, 'ops', 'link-into-tree');
    await symlink(tree, linkDir);
    await assert.rejects(
      () => mkWriter(linkDir).recordUpdate({ projectId: 'proj_a', receiptPath, updates }),
      /project_memory_inside_worker_paths/,
    );

    const danglingDir = join(dir, 'ops', 'dangling-tree');
    await symlink(join(tree, 'future-mem'), danglingDir);
    await assert.rejects(
      () => mkWriter(danglingDir).recordUpdate({ projectId: 'proj_a', receiptPath, updates }),
      /project_memory_inside_worker_paths/,
    );

    await symlink(join(tree, 'evil.memory.json'), join(storeDir, 'proj_evil.memory.json'));
    await assert.rejects(
      () => writer.recordUpdate({ projectId: 'proj_evil', receiptPath, updates }),
      /project_memory_symlink_disallowed/,
    );
  } finally { await cleanup(); }
});

test('fail-closed on tampered entry sha256, tampered pin_sha256, and corrupt JSON', async () => {
  const { tree, storeDir, writer, mintReceipt, cleanup } = await sandbox();
  try {
    await writer.recordUpdate({
      projectId: 'proj_t',
      receiptPath: await mintReceipt(),
      updates: [{ id: 'ok-1', section: 'invariants', text: 'Original invariant' }],
    });
    const file = join(storeDir, 'proj_t.memory.json');
    const good = await readFile(file, 'utf8');

    const doc = JSON.parse(good);
    doc.sections.invariants[0].text = 'Forged invariant';
    await writeFile(file, JSON.stringify(doc));
    await assert.rejects(
      () => resolveProjectMemory({ storeDir, projectId: 'proj_t', worktree: tree }),
      /project_memory_tampered/,
    );

    doc.pin_sha256 = storeIntegrity(doc);
    await writeFile(file, JSON.stringify(doc));
    await assert.rejects(
      () => resolveProjectMemory({ storeDir, projectId: 'proj_t', worktree: tree }),
      /project_memory_tampered/,
    );

    await writeFile(file, '{not-valid-json');
    await assert.rejects(
      () => resolveProjectMemory({ storeDir, projectId: 'proj_t', worktree: tree }),
      /project_memory_corrupt/,
    );
  } finally { await cleanup(); }
});

test('pinProjectMemory persists atomic snapshot with pin_sha256 and detects tampering', async () => {
  const { dir, tree, storeDir, writer, mintReceipt, cleanup } = await sandbox();
  const persistDir = join(dir, 'pins');
  await mkdir(persistDir, { recursive: true });
  try {
    await writer.recordUpdate({
      projectId: 'proj_p',
      receiptPath: await mintReceipt(),
      updates: [{ id: 'p-1', section: 'conventions', text: 'Pinned convention' }],
    });
    let calls = 0;
    const pinned1 = pinProjectMemory(async () => {
      calls += 1;
      return resolveProjectMemory({ storeDir, projectId: 'proj_p', worktree: tree });
    }, { persistDir, projectId: 'proj_p' });

    const s1 = await pinned1('1265:att-1:1');
    const s2 = await pinned1('1265:att-1:1');
    assert.deepEqual(s1, s2);
    assert.equal(calls, 1);

    const pinned2 = pinProjectMemory(async () => { throw new Error('must not resolve'); },
      { persistDir, projectId: 'proj_p' });
    const s3 = await pinned2('1265:att-1:1');
    assert.deepEqual(s3, s1);

    const pinName = `project-memory-${createHash('sha256').update('proj_p\x001265:att-1:1').digest('hex').slice(0, 32)}.json`;
    const pinFile = join(persistDir, pinName);
    const saved = JSON.parse(await readFile(pinFile, 'utf8'));
    assert.equal(saved.project_id, 'proj_p');
    assert.equal(saved.pin_key, '1265:att-1:1');
    await writeFile(pinFile, JSON.stringify({ ...saved, text: 'forged' }));
    const pinned3 = pinProjectMemory(async () => s1, { persistDir, projectId: 'proj_p' });
    await assert.rejects(() => pinned3('1265:att-1:1'), /project_memory_pin_invalid/);
  } finally { await cleanup(); }
});

test('CLI supports show, compact, remove, clear and honours --worktree guard', async () => {
  const { tree, storeDir, writer, mintReceipt, cleanup } = await sandbox();
  try {
    await writer.recordUpdate({
      projectId: 'proj_cli',
      receiptPath: await mintReceipt(),
      updates: [
        { id: 'c-1', section: 'invariants', text: 'Invariant one for CLI' },
        { id: 'c-2', section: 'pitfalls', text: 'Pitfall two for CLI' },
      ],
    });

    const shown = await exec('node', [cli, 'show', '--store-dir', storeDir, '--project', 'proj_cli', '--worktree', tree]);
    assert.deepEqual(JSON.parse(shown.stdout).ids, ['c-1', 'c-2']);

    const compacted = await exec('node', [
      cli, 'compact', '--store-dir', storeDir, '--project', 'proj_cli',
      '--max-chars', '4000', '--max-entries', '10', '--worktree', tree,
    ]);
    assert.equal(JSON.parse(compacted.stdout).after, 2);

    const removed = await exec('node', [
      cli, 'remove', '--store-dir', storeDir, '--project', 'proj_cli', '--id', 'c-1', '--worktree', tree,
    ]);
    assert.equal(JSON.parse(removed.stdout).remaining, 1);

    const cleared = await exec('node', [
      cli, 'clear', '--store-dir', storeDir, '--project', 'proj_cli', '--worktree', tree,
    ]);
    assert.equal(JSON.parse(cleared.stdout).removedCount, 1);

    const afterClear = await resolveProjectMemory({ storeDir, projectId: 'proj_cli', worktree: tree });
    assert.equal(afterClear.total, 0);

    await assert.rejects(
      () => exec('node', [cli, 'show', '--store-dir', join(tree, 'bad'), '--project', 'proj_cli', '--worktree', tree]),
      /project_memory_inside_worker_paths/,
    );
  } finally { await cleanup(); }
});

test('integration: worker, critic, and arbiter prompts embed pinned read-only project memory slice', async () => {
  const { tree, storeDir, writer, mintReceipt, cleanup } = await sandbox();
  try {
    await writer.recordUpdate({
      projectId: 'proj_int',
      receiptPath: await mintReceipt(),
      updates: [{ id: 'int-1', section: 'invariants', text: 'Never bypass tamper gate' }],
    });
    const slice = await resolveProjectMemory({ storeDir, projectId: 'proj_int', worktree: tree });
    const workerPrompt = workerIntakePrompt({
      brief: 'Task brief',
      tree,
      handoffPath: '/outside/submission.json',
      handoff: { task_id: '1265', epoch: 1, attempt_id: 'a1', worker_thread_id: 't1', candidate_sha: '<sha>' },
      productQuestions: true,
      projectMemory: slice,
    });
    const criticBlock = projectMemoryPromptBlock(slice);
    const arbiterPrompt = arbiterIntakePrompt('Spec text', 'Extra rules', undefined, slice);

    for (const text of [workerPrompt, criticBlock, arbiterPrompt]) {
      assert.match(text, new RegExp(`Память проекта \\(read-only, срез digest ${slice.digest}\\)`));
      assert.match(text, /Never bypass tamper gate/);
      assert.match(text, /прямая запись воркером запрещена/);
    }
  } finally { await cleanup(); }
});

test('regression #2: dangling symlink on project memory file cannot write into another project slot', async () => {
  const { tree, storeDir, writer, mintReceipt, cleanup } = await sandbox();
  try {
    await symlink(join(storeDir, 'proj_victim.memory.json'), join(storeDir, 'proj_attacker.memory.json'));
    const receiptPath = await mintReceipt();
    await assert.rejects(
      () => writer.recordUpdate({
        projectId: 'proj_attacker', receiptPath,
        updates: [{ section: 'invariants', text: 'Poisoned victim slot' }],
      }),
      /project_memory_symlink_disallowed/,
    );
    await assert.rejects(
      () => resolveProjectMemory({ storeDir, projectId: 'proj_attacker', worktree: tree }),
      /project_memory_symlink_disallowed/,
    );
    const files = await readdir(storeDir);
    assert.ok(!files.includes('proj_victim.memory.json'));
  } finally { await cleanup(); }
});

test('regression #3: pin binds project_id + pin_key and persists empty/disabled memory across restarts', async () => {
  const { dir, tree, storeDir, writer, mintReceipt, cleanup } = await sandbox();
  const persistDir = join(dir, 'pins');
  await mkdir(persistDir, { recursive: true });
  try {
    const pinEmpty1 = pinProjectMemory(
      () => resolveProjectMemory({ storeDir, projectId: 'proj_empty', worktree: tree }),
      { persistDir, projectId: 'proj_empty' },
    );
    const initial = await pinEmpty1('1265:att-empty:1');
    assert.equal(initial.enabled, true);
    assert.equal(initial.total, 0);

    await writer.recordUpdate({
      projectId: 'proj_empty',
      receiptPath: await mintReceipt(),
      updates: [{ id: 'late-1', section: 'pitfalls', text: 'Added after attempt started' }],
    });
    const pinEmpty2 = pinProjectMemory(
      () => resolveProjectMemory({ storeDir, projectId: 'proj_empty', worktree: tree }),
      { persistDir, projectId: 'proj_empty' },
    );
    assert.deepEqual(await pinEmpty2('1265:att-empty:1'), initial);

    const pinOff1 = pinProjectMemory(async () => null, { persistDir, projectId: 'proj_empty' });
    const off1 = await pinOff1('1265:att-off:1');
    assert.equal(off1.enabled, false);
    assert.equal(off1.total, 0);

    const pinOff2 = pinProjectMemory(
      () => resolveProjectMemory({ storeDir, projectId: 'proj_empty', worktree: tree }),
      { persistDir, projectId: 'proj_empty' },
    );
    assert.deepEqual(await pinOff2('1265:att-off:1'), off1);

    const otherPin = pinProjectMemory(
      () => resolveProjectMemory({ storeDir, projectId: 'proj_other', worktree: tree }),
      { persistDir, projectId: 'proj_other' },
    );
    await otherPin('1265:att-other:1');
    const otherFile = join(persistDir,
      `project-memory-${createHash('sha256').update('proj_other\x001265:att-other:1').digest('hex').slice(0, 32)}.json`);
    const targetFile = join(persistDir,
      `project-memory-${createHash('sha256').update('proj_empty\x001265:att-swap:1').digest('hex').slice(0, 32)}.json`);
    await writeFile(targetFile, await readFile(otherFile, 'utf8'));

    const swapped = pinProjectMemory(
      () => resolveProjectMemory({ storeDir, projectId: 'proj_empty', worktree: tree }),
      { persistDir, projectId: 'proj_empty' },
    );
    await assert.rejects(() => swapped('1265:att-swap:1'), /project_memory_pin_invalid/);
  } finally { await cleanup(); }
});

test('regression R3/R4/R5: no raw write or capability export; only pinned createProjectMemoryWriter with mandatory HMAC', async () => {
  const { dir, tree, storeDir, receiptDir, writer, cleanup } = await sandbox();
  const rogueDir = join(dir, 'ops', 'rogue-receipts');
  await mkdir(rogueDir, { recursive: true });
  const updates = [{ section: 'invariants', text: 'Provenance-verified invariant' }];
  try {
    // Public raw write and arbitrary capability constructors are NOT exported
    assert.equal('createTrustedReviewReceipt' in projectMemoryModule, false);
    assert.equal('recordProjectMemoryUpdate' in projectMemoryModule, false);

    // Missing or too-short (<16 bytes) hmacKey fails closed at writer construction
    for (const badKey of [undefined, '', 'short-key-15byt', Buffer.alloc(15, 1)]) {
      assert.throws(
        () => createProjectMemoryWriter({
          storeDir, trustedReceiptDir: receiptDir, hmacKey: badKey, worktree: tree,
        }),
        /project_memory_untrusted_write/,
      );
    }

    // Valid receipt file outside worktree, but NOT inside trustedReceiptDir -> project_memory_untrusted_write
    const rogueKey = 'rogue-attacker-hmac-key-12345678';
    const rogueReceiptPath = join(rogueDir, 'rogue.receipt.json');
    await writeTrustedReviewReceipt({
      receiptPath: rogueReceiptPath,
      trustedReceiptDir: rogueDir,
      worktree: tree,
      hmacKey: TEST_HMAC_KEY,
      receipt: {
        role: 'controller',
        verdict: 'REVIEW_OK',
        sha: SHA_A,
        worker: 'acp-devin/swe-2-high',
        reviewer: 'acp-antigravity-acp/gemini-4-neon',
        sourceCard: '1265',
      },
    });
    await assert.rejects(
      () => writer.recordUpdate({ projectId: 'proj_r5', receiptPath: rogueReceiptPath, updates }),
      /project_memory_untrusted_write/,
    );

    // Symlink inside trustedReceiptDir pointing to rogueDir -> project_memory_symlink_disallowed
    const linkInTrusted = join(receiptDir, 'link-to-rogue.receipt.json');
    await symlink(rogueReceiptPath, linkInTrusted);
    await assert.rejects(
      () => writer.recordUpdate({ projectId: 'proj_r5', receiptPath: linkInTrusted, updates }),
      /project_memory_symlink_disallowed/,
    );

    // Receipt signed with wrong HMAC key -> project_memory_untrusted_write
    const wrongHmacPath = join(receiptDir, 'wrong-hmac.receipt.json');
    const sha64 = 'f'.repeat(64);
    await writeTrustedReviewReceipt({
      receiptPath: wrongHmacPath,
      trustedReceiptDir: receiptDir,
      worktree: tree,
      hmacKey: rogueKey,
      receipt: {
        role: 'controller',
        verdict: 'REVIEW_OK',
        sha: sha64,
        worker: 'acp-devin/swe-2-high',
        reviewer: 'acp-antigravity-acp/gemini-4-neon',
        sourceCard: '1265',
      },
    });
    await assert.rejects(
      () => writer.recordUpdate({ projectId: 'proj_r5', receiptPath: wrongHmacPath, updates }),
      /project_memory_untrusted_write/,
    );

    // Bare SHA-256 receipt without HMAC -> project_memory_untrusted_write
    const unsignedReceiptPath = join(receiptDir, 'unsigned.receipt.json');
    const unsignedBody = {
      schema: REVIEW_RECEIPT_SCHEMA,
      role: 'controller',
      verdict: 'REVIEW_OK',
      sha: sha64,
      worker: 'acp-devin/swe-2-high',
      reviewer: 'acp-antigravity-acp/gemini-4-neon',
      source_card: '1265',
    };
    await writeFile(unsignedReceiptPath, JSON.stringify({
      ...unsignedBody,
      receipt_sha256: reviewReceiptDigest(unsignedBody),
    }));
    await assert.rejects(
      () => writer.recordUpdate({ projectId: 'proj_r5', receiptPath: unsignedReceiptPath, updates }),
      /project_memory_untrusted_write/,
    );

    // Attempting to override pinned operator config in writer.recordUpdate -> project_memory_untrusted_write
    const goodReceiptPath = join(receiptDir, 'card-1265.receipt.json');
    await writeTrustedReviewReceipt({
      receiptPath: goodReceiptPath,
      trustedReceiptDir: receiptDir,
      worktree: tree,
      hmacKey: TEST_HMAC_KEY,
      receipt: {
        role: 'controller',
        verdict: 'REVIEW_OK',
        sha: sha64,
        worker: 'acp-devin/swe-2-high',
        reviewer: 'acp-antigravity-acp/gemini-4-neon',
        sourceCard: '1265',
      },
    });
    for (const override of [
      { trustedReceiptDir: rogueDir },
      { hmacKey: rogueKey },
      { storeDir: rogueDir },
      { worktree: undefined },
    ]) {
      await assert.rejects(
        () => writer.recordUpdate({ projectId: 'proj_r5', receiptPath: goodReceiptPath, updates, ...override }),
        /project_memory_untrusted_write/,
      );
    }

    // Valid receipt inside pinned trustedReceiptDir with valid HMAC -> succeeds
    const ok = await writer.recordUpdate({ projectId: 'proj_r5', receiptPath: goodReceiptPath, updates });
    assert.equal(ok.total, 1);
  } finally { await cleanup(); }
});

test('regression R6: run-isolated recordPostReviewMemory writes memory after REVIEW_OK and skips on REWORK/hold', async () => {
  const { tree, storeDir, receiptDir, writer, cleanup } = await sandbox();
  const attempt = { task_id: '1265', attempt_id: 'att-r6', epoch: 1 };
  const submission = { candidate_sha: SHA_A };
  const worker = { provider: 'openai', model: 'gpt-6.2-sol' };
  const reviewer = { provider: 'google', model: 'gemini-4-neon' };
  const updates = [{ id: 'r6-inv', section: 'invariants', text: 'Post-review steward persists verified memory' }];
  try {
    // On REWORK or hold (or non-REVIEW_OK verdict), nothing is written to receipts or memory
    for (const bad of [
      { result: { outcome: 'rework' }, reviewReceipt: { verdict: 'REVIEW_REWORK', sha: SHA_A } },
      { result: { outcome: 'hold' }, reviewReceipt: { verdict: 'REVIEW_BLOCKED', sha: SHA_A } },
      { result: { outcome: 'done' }, reviewReceipt: { verdict: 'REVIEW_REWORK', sha: SHA_A } },
    ]) {
      const skipped = await recordPostReviewMemory({
        writer,
        trustedReceiptDir: receiptDir,
        hmacKey: TEST_HMAC_KEY,
        projectId: 'proj_r6',
        worktree: tree,
        attempt,
        submission,
        worker,
        reviewer,
        updates,
        ...bad,
      });
      assert.equal(skipped.recorded, false);
      assert.equal(skipped.reason, 'not_review_ok');
    }
    assert.equal((await resolveProjectMemory({ storeDir, projectId: 'proj_r6', worktree: tree })).total, 0);
    assert.equal((await readdir(receiptDir)).length, 0);

    // On confirmed REVIEW_OK + done outcome, writes HMAC-signed receipt and calls writer.recordUpdate
    const written = await recordPostReviewMemory({
      writer,
      trustedReceiptDir: receiptDir,
      hmacKey: TEST_HMAC_KEY,
      projectId: 'proj_r6',
      worktree: tree,
      result: { outcome: 'done' },
      reviewReceipt: { verdict: 'REVIEW_OK', sha: SHA_A },
      attempt,
      submission,
      worker,
      reviewer,
      updates,
    });
    assert.equal(written.recorded, true);
    assert.equal(written.result.total, 1);

    const slice = await resolveProjectMemory({ storeDir, projectId: 'proj_r6', worktree: tree });
    assert.deepEqual(slice.ids, ['r6-inv']);
    assert.match(slice.text, /Post-review steward persists verified memory/);
  } finally { await cleanup(); }
});
