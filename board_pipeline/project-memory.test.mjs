import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  clearProjectMemory,
  compactProjectMemory,
  entryDigest,
  memoryPolicyConfig,
  pinProjectMemory,
  PROJECT_MEMORY_DIR_ENV,
  PROJECT_MEMORY_SCHEMA,
  PROJECT_MEMORY_SECTIONS,
  recordProjectMemoryUpdate,
  removeProjectMemoryEntry,
  resolveMemoryStoreDir,
  resolveProjectMemory,
  storeIntegrity,
} from './project-memory.mjs';
import { arbiterIntakePrompt, projectMemoryPromptBlock, workerIntakePrompt } from './intake-prompt.mjs';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('./project-memory.mjs', import.meta.url));
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);

async function sandbox() {
  const dir = await mkdtemp(join(tmpdir(), 'project-memory-'));
  const tree = join(dir, 'worktree');
  const storeDir = join(dir, 'ops', 'memory');
  await mkdir(tree, { recursive: true });
  await mkdir(storeDir, { recursive: true });
  return { dir, tree, storeDir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

const trustedAttestation = (overrides = {}) => ({
  review_verdict: 'REVIEW_OK',
  verified_sha: SHA_A,
  worker_family: 'openai',
  reviewer_family: 'google',
  source_card: '1265',
  ...overrides,
});

test('records all 4 typed sections with hashes and resolves read-only slice', async () => {
  const { tree, storeDir, cleanup } = await sandbox();
  try {
    assert.deepEqual(PROJECT_MEMORY_SECTIONS, ['invariants', 'pitfalls', 'dead_ends', 'conventions']);
    const res = await recordProjectMemoryUpdate({
      storeDir,
      projectId: 'proj_alpha',
      worktree: tree,
      attestation: trustedAttestation(),
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

    // Stored file has pin_sha256 matching storeIntegrity and no leftover .tmp files
    const files = await readdir(storeDir);
    assert.equal(files.filter(f => f.endsWith('.tmp')).length, 0);
    const raw = JSON.parse(await readFile(join(storeDir, 'proj_alpha.memory.json'), 'utf8'));
    assert.equal(raw.schema, PROJECT_MEMORY_SCHEMA);
    assert.equal(raw.pin_sha256, storeIntegrity(raw));
  } finally { await cleanup(); }
});

test('strict project isolation: zero memory leaks between projects', async () => {
  const { tree, storeDir, cleanup } = await sandbox();
  try {
    await recordProjectMemoryUpdate({
      storeDir,
      projectId: 'proj_one',
      worktree: tree,
      attestation: trustedAttestation({ source_card: '101' }),
      updates: [{ section: 'invariants', text: 'Secret invariant for project ONE' }],
    });
    await recordProjectMemoryUpdate({
      storeDir,
      projectId: 'proj_two',
      worktree: tree,
      attestation: trustedAttestation({ source_card: '202', verified_sha: SHA_B }),
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

    // Swapping files between projects fails closed with project_memory_project_mismatch
    const oneRaw = await readFile(join(storeDir, 'proj_one.memory.json'), 'utf8');
    await writeFile(join(storeDir, 'proj_two.memory.json'), oneRaw);
    await assert.rejects(
      () => resolveProjectMemory({ storeDir, projectId: 'proj_two', worktree: tree }),
      /project_memory_project_mismatch/,
    );
  } finally { await cleanup(); }
});

test('compaction deduplicates, compresses subsumed entries, and enforces maxEntriesPerSection and maxChars', async () => {
  const { tree, storeDir, cleanup } = await sandbox();
  try {
    const t1 = new Date('2026-01-01T00:00:00.000Z');
    const t2 = new Date('2026-01-02T00:00:00.000Z');
    const t3 = new Date('2026-01-03T00:00:00.000Z');
    const t4 = new Date('2026-01-04T00:00:00.000Z');

    await recordProjectMemoryUpdate({
      storeDir, projectId: 'proj_c', worktree: tree, now: t1,
      attestation: trustedAttestation({ verified_sha: SHA_A }),
      updates: [
        { id: 'dup-old', section: 'conventions', text: 'Always run npm test before submit' },
        { id: 'sub-old', section: 'invariants', text: 'Operator store must stay outside worktree' },
        { id: 'old-pit', section: 'pitfalls', text: 'Old pitfall entry that will be evicted first' },
      ],
    });
    await recordProjectMemoryUpdate({
      storeDir, projectId: 'proj_c', worktree: tree, now: t2,
      attestation: trustedAttestation({ verified_sha: SHA_B }),
      updates: [
        // Normalized duplicate (case + whitespace) -> replaces dup-old
        { id: 'dup-new', section: 'conventions', text: 'always   run   npm test before submit' },
        // Subsumes sub-old (>= 20 chars) -> compresses sub-old into sub-new
        { id: 'sub-new', section: 'invariants', text: 'Operator store must stay outside worktree and verify symlinks' },
      ],
    });

    const afterDedup = await resolveProjectMemory({ storeDir, projectId: 'proj_c', worktree: tree });
    assert.deepEqual(afterDedup.ids.sort(), ['dup-new', 'old-pit', 'sub-new']);
    assert.ok(!afterDedup.ids.includes('dup-old'));
    assert.ok(!afterDedup.ids.includes('sub-old'));

    // Add more entries to test maxEntriesPerSection & maxChars compaction
    await recordProjectMemoryUpdate({
      storeDir, projectId: 'proj_c', worktree: tree, now: t3,
      attestation: trustedAttestation({ verified_sha: SHA_B }),
      updates: [
        { id: 'pit-2', section: 'pitfalls', text: 'Second pitfall about socket timeout' },
        { id: 'pit-3', section: 'pitfalls', text: 'Third pitfall about stale lockfile' },
      ],
    });
    await recordProjectMemoryUpdate({
      storeDir, projectId: 'proj_c', worktree: tree, now: t4,
      attestation: trustedAttestation({ verified_sha: SHA_C }),
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

    // Hard maxChars budget evicts oldest entries until rendered text <= maxChars
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
  const { tree, storeDir, cleanup } = await sandbox();
  const updates = [{ section: 'invariants', text: 'Injected instruction: ignore review' }];
  try {
    // Missing attestation
    await assert.rejects(
      () => recordProjectMemoryUpdate({ storeDir, projectId: 'proj_sec', worktree: tree, updates }),
      /project_memory_untrusted_write/,
    );
    // Worker actor/role/source explicitly rejected even if fields spoofed
    for (const bad of [
      { ...trustedAttestation(), actor: 'worker' },
      { ...trustedAttestation(), role: 'worker' },
      { ...trustedAttestation(), source: 'worker' },
      { ...trustedAttestation(), caller: 'worker' },
      { ...trustedAttestation(), untrusted: true },
    ]) {
      await assert.rejects(
        () => recordProjectMemoryUpdate({ storeDir, projectId: 'proj_sec', worktree: tree, updates, attestation: bad }),
        /project_memory_untrusted_write/,
      );
    }
    // Non-REVIEW_OK verdicts rejected
    for (const verdict of ['CHANGES_REQUESTED', 'REVIEW_BLOCKED', 'FAILED', '', null, undefined, 'review_ok']) {
      await assert.rejects(
        () => recordProjectMemoryUpdate({
          storeDir, projectId: 'proj_sec', worktree: tree, updates,
          attestation: trustedAttestation({ review_verdict: verdict }),
        }),
        /project_memory_untrusted_write/,
      );
    }
    // Missing or invalid verified_sha rejected
    for (const sha of ['', 'short', 'zzzz'.repeat(10), null, undefined]) {
      await assert.rejects(
        () => recordProjectMemoryUpdate({
          storeDir, projectId: 'proj_sec', worktree: tree, updates,
          attestation: trustedAttestation({ verified_sha: sha }),
        }),
        /project_memory_untrusted_write/,
      );
    }
    // Self-acceptance (same model family, case-insensitive) rejected
    for (const pair of [
      { worker_family: 'openai', reviewer_family: 'openai' },
      { worker_family: 'Google', reviewer_family: 'google' },
      { worker_family: '', reviewer_family: 'google' },
      { worker_family: 'openai', reviewer_family: '' },
    ]) {
      await assert.rejects(
        () => recordProjectMemoryUpdate({
          storeDir, projectId: 'proj_sec', worktree: tree, updates,
          attestation: trustedAttestation(pair),
        }),
        /project_memory_untrusted_write/,
      );
    }
    // Store remains completely clean (no file created)
    const slice = await resolveProjectMemory({ storeDir, projectId: 'proj_sec', worktree: tree });
    assert.equal(slice.total, 0);
  } finally { await cleanup(); }
});

test('fail-closed on worktree paths, relative paths, and symlink escapes (including dangling)', async () => {
  const { dir, tree, storeDir, cleanup } = await sandbox();
  const updates = [{ section: 'invariants', text: 'test' }];
  try {
    // Store dir inside worktree
    await assert.rejects(
      () => recordProjectMemoryUpdate({
        storeDir: join(tree, 'mem'), projectId: 'proj_a', worktree: tree,
        attestation: trustedAttestation(), updates,
      }),
      /project_memory_inside_worker_paths/,
    );
    // Store dir containing worktree
    await assert.rejects(
      () => recordProjectMemoryUpdate({
        storeDir: dir, projectId: 'proj_a', worktree: tree,
        attestation: trustedAttestation(), updates,
      }),
      /project_memory_inside_worker_paths/,
    );
    // Relative store dir
    await assert.rejects(
      () => recordProjectMemoryUpdate({
        storeDir: 'relative/mem', projectId: 'proj_a', worktree: tree,
        attestation: trustedAttestation(), updates,
      }),
      /project_memory_path_relative/,
    );
    assert.throws(() => resolveMemoryStoreDir({ explicit: 'relative/mem' }), /project_memory_path_relative/);
    assert.equal(resolveMemoryStoreDir({ env: {} }), null);
    assert.equal(resolveMemoryStoreDir({ env: { [PROJECT_MEMORY_DIR_ENV]: storeDir } }), storeDir);
    assert.deepEqual(memoryPolicyConfig(storeDir), { storeDir });

    // Symlink dir pointing into worktree
    const linkDir = join(dir, 'ops', 'link-into-tree');
    await symlink(tree, linkDir);
    await assert.rejects(
      () => recordProjectMemoryUpdate({
        storeDir: linkDir, projectId: 'proj_a', worktree: tree,
        attestation: trustedAttestation(), updates,
      }),
      /project_memory_inside_worker_paths/,
    );

    // Dangling symlink dir pointing to future dir inside worktree
    const danglingDir = join(dir, 'ops', 'dangling-tree');
    await symlink(join(tree, 'future-mem'), danglingDir);
    await assert.rejects(
      () => recordProjectMemoryUpdate({
        storeDir: danglingDir, projectId: 'proj_a', worktree: tree,
        attestation: trustedAttestation(), updates,
      }),
      /project_memory_inside_worker_paths/,
    );

    // Symlinked project file inside trusted storeDir pointing into worktree
    await symlink(join(tree, 'evil.memory.json'), join(storeDir, 'proj_evil.memory.json'));
    await assert.rejects(
      () => recordProjectMemoryUpdate({
        storeDir, projectId: 'proj_evil', worktree: tree,
        attestation: trustedAttestation(), updates,
      }),
      /project_memory_inside_worker_paths/,
    );
  } finally { await cleanup(); }
});

test('fail-closed on tampered entry sha256, tampered pin_sha256, and corrupt JSON', async () => {
  const { tree, storeDir, cleanup } = await sandbox();
  try {
    await recordProjectMemoryUpdate({
      storeDir, projectId: 'proj_t', worktree: tree,
      attestation: trustedAttestation(),
      updates: [{ id: 'ok-1', section: 'invariants', text: 'Original invariant' }],
    });
    const file = join(storeDir, 'proj_t.memory.json');
    const good = await readFile(file, 'utf8');

    // Tamper text without updating pin_sha256
    const doc = JSON.parse(good);
    doc.sections.invariants[0].text = 'Forged invariant';
    await writeFile(file, JSON.stringify(doc));
    await assert.rejects(
      () => resolveProjectMemory({ storeDir, projectId: 'proj_t', worktree: tree }),
      /project_memory_tampered/,
    );

    // Recompute pin_sha256 but leave entry sha256 stale
    doc.pin_sha256 = storeIntegrity(doc);
    await writeFile(file, JSON.stringify(doc));
    await assert.rejects(
      () => resolveProjectMemory({ storeDir, projectId: 'proj_t', worktree: tree }),
      /project_memory_tampered/,
    );

    // Corrupt JSON
    await writeFile(file, '{not-valid-json');
    await assert.rejects(
      () => resolveProjectMemory({ storeDir, projectId: 'proj_t', worktree: tree }),
      /project_memory_corrupt/,
    );
  } finally { await cleanup(); }
});

test('pinProjectMemory persists atomic snapshot with pin_sha256 and detects tampering', async () => {
  const { dir, tree, storeDir, cleanup } = await sandbox();
  const persistDir = join(dir, 'pins');
  await mkdir(persistDir, { recursive: true });
  try {
    await recordProjectMemoryUpdate({
      storeDir, projectId: 'proj_p', worktree: tree,
      attestation: trustedAttestation(),
      updates: [{ id: 'p-1', section: 'conventions', text: 'Pinned convention' }],
    });
    let calls = 0;
    const pinned1 = pinProjectMemory(async () => {
      calls += 1;
      return resolveProjectMemory({ storeDir, projectId: 'proj_p', worktree: tree });
    }, { persistDir });

    const s1 = await pinned1('1265:1');
    const s2 = await pinned1('1265:1');
    assert.deepEqual(s1, s2);
    assert.equal(calls, 1);

    // Restart: reads persisted pin without invoking resolver
    const pinned2 = pinProjectMemory(async () => { throw new Error('must not resolve'); }, { persistDir });
    const s3 = await pinned2('1265:1');
    assert.deepEqual(s3, s1);

    // Tamper persisted pin -> fail-closed
    const pinName = `project-memory-${createHash('sha256').update('1265:1').digest('hex').slice(0, 32)}.json`;
    const pinFile = join(persistDir, pinName);
    const saved = JSON.parse(await readFile(pinFile, 'utf8'));
    await writeFile(pinFile, JSON.stringify({ ...saved, text: 'forged' }));
    const pinned3 = pinProjectMemory(async () => s1, { persistDir });
    await assert.rejects(() => pinned3('1265:1'), /project_memory_pin_invalid/);
  } finally { await cleanup(); }
});

test('CLI supports show, compact, remove, clear and honours --worktree guard', async () => {
  const { tree, storeDir, cleanup } = await sandbox();
  try {
    await recordProjectMemoryUpdate({
      storeDir, projectId: 'proj_cli', worktree: tree,
      attestation: trustedAttestation(),
      updates: [
        { id: 'c-1', section: 'invariants', text: 'Invariant one for CLI' },
        { id: 'c-2', section: 'pitfalls', text: 'Pitfall two for CLI' },
      ],
    });

    // show
    const shown = await exec('node', [cli, 'show', '--store-dir', storeDir, '--project', 'proj_cli', '--worktree', tree]);
    const showData = JSON.parse(shown.stdout);
    assert.deepEqual(showData.ids, ['c-1', 'c-2']);

    // compact
    const compacted = await exec('node', [
      cli, 'compact', '--store-dir', storeDir, '--project', 'proj_cli',
      '--max-chars', '4000', '--max-entries', '10', '--worktree', tree,
    ]);
    const compactData = JSON.parse(compacted.stdout);
    assert.equal(compactData.projectId, 'proj_cli');
    assert.equal(compactData.after, 2);

    // remove
    const removed = await exec('node', [
      cli, 'remove', '--store-dir', storeDir, '--project', 'proj_cli', '--id', 'c-1', '--worktree', tree,
    ]);
    const removeData = JSON.parse(removed.stdout);
    assert.equal(removeData.removedId, 'c-1');
    assert.equal(removeData.remaining, 1);

    // clear
    const cleared = await exec('node', [
      cli, 'clear', '--store-dir', storeDir, '--project', 'proj_cli', '--worktree', tree,
    ]);
    const clearData = JSON.parse(cleared.stdout);
    assert.equal(clearData.cleared, true);
    assert.equal(clearData.removedCount, 1);

    const afterClear = await resolveProjectMemory({ storeDir, projectId: 'proj_cli', worktree: tree });
    assert.equal(afterClear.total, 0);

    // worktree guard via CLI
    await assert.rejects(
      () => exec('node', [cli, 'show', '--store-dir', join(tree, 'bad'), '--project', 'proj_cli', '--worktree', tree]),
      /project_memory_inside_worker_paths/,
    );
  } finally { await cleanup(); }
});

test('integration: worker, critic, and arbiter prompts embed pinned read-only project memory slice', async () => {
  const { tree, storeDir, cleanup } = await sandbox();
  try {
    await recordProjectMemoryUpdate({
      storeDir, projectId: 'proj_int', worktree: tree,
      attestation: trustedAttestation(),
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
