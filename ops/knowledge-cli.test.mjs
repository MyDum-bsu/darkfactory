import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { runArchiveCli } from './df-archive.mjs';
import { runDecisionsCli } from './df-decisions.mjs';

const execFileAsync = promisify(execFile);
const OPS_DIR = dirname(fileURLToPath(import.meta.url));
const ARCHIVE_CLI = join(OPS_DIR, 'df-archive.mjs');
const DECISIONS_CLI = join(OPS_DIR, 'df-decisions.mjs');

async function runCli(script, args) {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ['--no-warnings', script, ...args],
      { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
    );
    return { code: 0, stdout, stderr };
  } catch (error) {
    return {
      code: typeof error.code === 'number' ? error.code : 1,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
    };
  }
}

async function runJson(script, args) {
  const result = await runCli(script, args);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, '');
  return JSON.parse(result.stdout);
}

async function writeJsonl(path, rows) {
  await writeFile(path, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`, 'utf8');
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

test('df-archive end-to-end: agy/pi ingest, idempotence, search, filters, stats, failures', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'df-archive-cli-'));
  try {
    const dbPath = join(dir, 'archive.db');
    const agyPath = join(dir, 'agy-transcript.jsonl');
    const piPath = join(dir, 'pi-transcript.jsonl');
    await writeJsonl(agyPath, [
      {
        type: 'user_message',
        content: 'настройка архива базы знаний',
        createdAt: '2025-01-01T10:00:00Z',
      },
      {
        type: 'assistant_message',
        message: { role: 'assistant', content: 'database archive ready with retention checklist' },
        createdAt: '2025-01-01T10:00:05Z',
      },
    ]);
    await writeJsonl(piPath, [
      {
        type: 'user',
        content: 'hello pi archive operator',
        time: '2025-01-02T09:00:00Z',
      },
      {
        type: 'assistant',
        message: { content: 'English archive note from pi' },
        createdAt: '2025-01-02T09:00:05Z',
      },
    ]);

    const agy = await runJson(ARCHIVE_CLI, [
      'ingest', '--db', dbPath, '--file', agyPath, '--harness', 'agy',
      '--host', 'cloud-hub', '--project', 'darkfactory', '--title', 'AGY archive session', '--json',
    ]);
    assert.match(agy.sessionId, /^agy-[a-f0-9]{24}$/);
    assert.equal(agy.insertedMessages, 2);
    assert.equal(agy.messageCount, 2);

    const reingested = await runJson(ARCHIVE_CLI, [
      'ingest', '--db', dbPath, '--file', agyPath, '--harness', 'agy',
      '--host', 'cloud-hub', '--project', 'darkfactory', '--json',
    ]);
    assert.equal(reingested.sessionId, agy.sessionId);
    assert.equal(reingested.insertedMessages, 0);
    assert.equal(reingested.messageCount, 2);

    const pi = await runJson(ARCHIVE_CLI, [
      'ingest', '--db', dbPath, '--file', piPath, '--harness', 'pi',
      '--host', 'edge-worker', '--project', 'operations', '--session-id', 'pi-session', '--json',
    ]);
    assert.equal(pi.sessionId, 'pi-session');
    assert.equal(pi.insertedMessages, 2);
    assert.equal(pi.messageCount, 2);

    const russian = await runJson(ARCHIVE_CLI, [
      'search', '--db', dbPath, '--query', 'настройка архива', '--json',
    ]);
    assert.ok(russian.length >= 1);
    assert.equal(russian[0].sessionId, agy.sessionId);
    assert.equal(russian[0].host, 'cloud-hub');
    assert.match(russian[0].snippet, /«настройка»/);

    const english = await runJson(ARCHIVE_CLI, [
      'search', '--db', dbPath, '--query', 'English archive', '--json',
    ]);
    assert.ok(english.length >= 1);
    assert.ok(english.some(row => row.sessionId === 'pi-session'));
    assert.equal(english[0].harness, 'pi');

    const hostFiltered = await runJson(ARCHIVE_CLI, [
      'search', '--db', dbPath, '--query', 'archive', '--host', 'edge-worker', '--json',
    ]);
    assert.ok(hostFiltered.length >= 1);
    assert.ok(hostFiltered.every(row => row.host === 'edge-worker'));
    assert.ok(hostFiltered.every(row => row.harness === 'pi'));

    const projectFiltered = await runJson(ARCHIVE_CLI, [
      'search', '--db', dbPath, '--query', 'archive', '--project', 'darkfactory', '--json',
    ]);
    assert.ok(projectFiltered.length >= 1);
    assert.ok(projectFiltered.every(row => row.project === 'darkfactory'));
    assert.ok(projectFiltered.every(row => row.harness === 'agy'));

    const harnessFiltered = await runJson(ARCHIVE_CLI, [
      'search', '--db', dbPath, '--query', 'archive', '--harness', 'pi', '--json',
    ]);
    assert.ok(harnessFiltered.length >= 1);
    assert.ok(harnessFiltered.every(row => row.harness === 'pi'));

    const limited = await runJson(ARCHIVE_CLI, [
      'search', '--db', dbPath, '--query', 'archive', '--limit', '1', '--json',
    ]);
    assert.equal(limited.length, 1);

    const stats = await runJson(ARCHIVE_CLI, ['stats', '--db', dbPath, '--json']);
    assert.deepEqual(stats, {
      sessions: 2,
      messages: 4,
      embeddings: 0,
      hosts: 2,
      projects: 2,
      harnesses: 2,
      schemaVersion: 1,
    });

    const directStats = await runArchiveCli(['stats', '--json'], { defaultDbPath: dbPath });
    assert.deepEqual(directStats, stats);

    const unknown = await runCli(ARCHIVE_CLI, ['unknown-command', '--json']);
    assert.equal(unknown.code, 2);
    assert.match(unknown.stderr, /unknown command: unknown-command/);

    const missingFile = await runCli(ARCHIVE_CLI, [
      'ingest', '--db', dbPath, '--harness', 'agy', '--host', 'cloud-hub',
      '--project', 'darkfactory', '--json',
    ]);
    assert.equal(missingFile.code, 2);
    assert.match(missingFile.stderr, /ingest requires --file/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('df-decisions end-to-end: approval gate, deterministic export, reject workflow', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'df-decisions-cli-'));
  try {
    const dbPath = join(dir, 'ledger.db');
    const proposal = await runJson(DECISIONS_CLI, [
      'propose', '--db', dbPath, '--scope', 'global', '--topic', 'release gate',
      '--decision', 'Release only after explicit owner approval',
      '--rationale', 'Owner approval is the release invariant',
      '--applicability', 'all releases', '--by', 'cto', '--json',
    ]);
    assert.equal(proposal.status, 'pending');
    assert.equal(proposal.proposed_by, 'cto');
    assert.ok(proposal.proposal_id);

    const beforeApproval = await runJson(DECISIONS_CLI, [
      'query', '--db', dbPath, '--json',
    ]);
    assert.deepEqual(beforeApproval, []);

    const missingBy = await runCli(DECISIONS_CLI, [
      'approve', '--db', dbPath, '--id', proposal.proposal_id, '--json',
    ]);
    assert.equal(missingBy.code, 2);
    assert.match(missingBy.stderr, /approve requires --by/);

    const active = await runJson(DECISIONS_CLI, [
      'approve', '--db', dbPath, '--id', proposal.proposal_id, '--by', 'owner', '--json',
    ]);
    assert.equal(active.status, 'active');
    assert.equal(active.approved_by, 'owner');
    assert.equal(active.decision, 'Release only after explicit owner approval');

    const afterApproval = await runJson(DECISIONS_CLI, [
      'query', '--db', dbPath, '--json',
    ]);
    assert.equal(afterApproval.length, 1);
    assert.equal(afterApproval[0].id, active.id);
    assert.equal(afterApproval[0].topic, 'release gate');

    const keyword = await runJson(DECISIONS_CLI, [
      'query', '--db', dbPath, '--q', 'OWNER APPROVAL', '--json',
    ]);
    assert.equal(keyword.length, 1);
    assert.equal(keyword[0].id, active.id);

    const exported = await runJson(DECISIONS_CLI, [
      'export', '--db', dbPath, '--json',
    ]);
    assert.equal(exported.digest, sha256(exported.markdown));
    assert.match(exported.digest, /^[a-f0-9]{64}$/);
    assert.match(exported.markdown, /^# Owner Decision Ledger\n/);
    assert.match(exported.markdown, /Release only after explicit owner approval/);
    assert.equal(exported.truncated, false);
    assert.equal(exported.total, 1);

    const markdownPath = join(dir, 'owner-decisions.md');
    const written = await runJson(DECISIONS_CLI, [
      'export', '--db', dbPath, '--out', markdownPath, '--json',
    ]);
    assert.equal(written.digest, exported.digest);
    assert.equal(written.markdown, exported.markdown);
    assert.equal(written.outPath, markdownPath);
    assert.equal(await readFile(markdownPath, 'utf8'), exported.markdown);

    const directRows = await runDecisionsCli(['query', '--json'], { defaultDbPath: dbPath });
    assert.equal(directRows.length, 1);
    assert.equal(directRows[0].id, active.id);

    const rejectedProposal = await runJson(DECISIONS_CLI, [
      'propose', '--db', dbPath, '--scope', 'global', '--topic', 'temporary exception',
      '--decision', 'Allow an unreviewed release', '--by', 'cto', '--json',
    ]);
    const rejected = await runJson(DECISIONS_CLI, [
      'reject', '--db', dbPath, '--id', rejectedProposal.proposal_id,
      '--by', 'owner', '--reason', 'violates the owner gate', '--json',
    ]);
    assert.equal(rejected.status, 'rejected');
    assert.equal(rejected.rejected_by, 'owner');
    assert.equal(rejected.rejection_reason, 'violates the owner gate');

    const approveRejected = await runCli(DECISIONS_CLI, [
      'approve', '--db', dbPath, '--id', rejectedProposal.proposal_id, '--by', 'owner', '--json',
    ]);
    assert.equal(approveRejected.code, 2);
    assert.match(approveRejected.stderr, /unified_ledger_proposal_not_pending/);

    const finalRows = await runJson(DECISIONS_CLI, [
      'query', '--db', dbPath, '--json',
    ]);
    assert.equal(finalRows.length, 1);
    assert.equal(finalRows[0].id, active.id);

    const replacementProposal = await runJson(DECISIONS_CLI, [
      'propose', '--db', dbPath, '--scope', 'global', '--topic', 'release gate',
      '--decision', 'Release after owner approval and a clean verification record',
      '--by', 'cto', '--json',
    ]);
    const replacement = await runJson(DECISIONS_CLI, [
      'approve', '--db', dbPath, '--id', replacementProposal.proposal_id,
      '--by', 'owner', '--supersedes', active.id, '--json',
    ]);
    assert.equal(replacement.status, 'active');
    const supersededRows = await runJson(DECISIONS_CLI, [
      'query', '--db', dbPath, '--json',
    ]);
    assert.equal(supersededRows.length, 1);
    assert.equal(supersededRows[0].id, replacement.id);
    assert.equal(supersededRows[0].decision, 'Release after owner approval and a clean verification record');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
