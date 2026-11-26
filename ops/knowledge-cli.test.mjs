import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, truncate, writeFile } from 'node:fs/promises';
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

test('df-decisions: repeatable --area фильтрует query и export, --project валидируется', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'df-decisions-area-'));
  try {
    const dbPath = join(dir, 'ledger.db');
    const activate = async (scope, topic, decision) => {
      const proposal = await runJson(DECISIONS_CLI, [
        'propose', '--db', dbPath, '--scope', scope, '--topic', topic,
        '--decision', decision, '--by', 'cto', '--json',
      ]);
      const active = await runJson(DECISIONS_CLI, [
        'approve', '--db', dbPath, '--id', proposal.proposal_id, '--by', 'owner', '--json',
      ]);
      return active.id;
    };
    const globalId = await activate('global', 'global gate', 'Global owner gate decision');
    const backendId = await activate('area:backend', 'backend gate', 'Backend area decision');
    const frontendId = await activate('area:frontend', 'frontend gate', 'Frontend area decision');
    const projectId = await activate('project:demo', 'demo gate', 'Demo project decision');

    const ids = rows => rows.map(row => row.id).sort();
    // Без --area: только global — областные и проектные решения не видны.
    assert.deepEqual(ids(await runJson(DECISIONS_CLI, ['query', '--db', dbPath, '--json'])), [globalId]);
    // Один --area: global + выбранная область.
    const backendOnly = await runJson(DECISIONS_CLI, [
      'query', '--db', dbPath, '--area', 'backend', '--json',
    ]);
    assert.deepEqual(ids(backendOnly), [backendId, globalId].sort());
    // Повторяемый --area накапливается: обе области плюс global.
    const bothAreas = await runJson(DECISIONS_CLI, [
      'query', '--db', dbPath, '--area', 'backend', '--area', 'frontend', '--json',
    ]);
    assert.deepEqual(ids(bothAreas), [backendId, frontendId, globalId].sort());
    // --area и --project комбинируются.
    const projectArea = await runJson(DECISIONS_CLI, [
      'query', '--db', dbPath, '--project', 'demo', '--area', 'backend', '--json',
    ]);
    assert.deepEqual(ids(projectArea), [backendId, globalId, projectId].sort());
    // Форма area:<name> тоже принимается без двойного префикса.
    const prefixed = await runJson(DECISIONS_CLI, [
      'query', '--db', dbPath, '--area', 'area:backend', '--json',
    ]);
    assert.deepEqual(ids(prefixed), [backendId, globalId].sort());

    // --project валидируется: мусорные значения отклоняются до чтения.
    for (const bad of ['bad project', 'UPPER space', 'a/b', 'проект', 'x;drop']) {
      const rejected = await runCli(DECISIONS_CLI, [
        'query', '--db', dbPath, '--project', bad, '--json',
      ]);
      assert.equal(rejected.code, 2, bad);
      assert.match(rejected.stderr, /--project must match/);
      const rejectedExport = await runCli(DECISIONS_CLI, [
        'export', '--db', dbPath, '--project', bad, '--json',
      ]);
      assert.equal(rejectedExport.code, 2, bad);
      assert.match(rejectedExport.stderr, /--project must match/);
    }
    for (const good of ['demo', 'A-1_b']) {
      const accepted = await runJson(DECISIONS_CLI, [
        'query', '--db', dbPath, '--project', good, '--json',
      ]);
      assert.ok(Array.isArray(accepted));
    }

    // export --area: markdown содержит выбранную область и global, но не
    // чужую область и не проектную запись; дайджест совпадает с текстом.
    const exported = await runJson(DECISIONS_CLI, [
      'export', '--db', dbPath, '--area', 'backend', '--json',
    ]);
    assert.equal(exported.digest, sha256(exported.markdown));
    assert.match(exported.markdown, /Backend area decision/);
    assert.match(exported.markdown, /Global owner gate decision/);
    assert.doesNotMatch(exported.markdown, /Frontend area decision/);
    assert.doesNotMatch(exported.markdown, /Demo project decision/);
    assert.equal(exported.total, 2);
    // Повторяемый --area в export включает обе области.
    const exportedBoth = await runJson(DECISIONS_CLI, [
      'export', '--db', dbPath, '--area', 'backend', '--area', 'frontend', '--json',
    ]);
    assert.match(exportedBoth.markdown, /Backend area decision/);
    assert.match(exportedBoth.markdown, /Frontend area decision/);
    assert.equal(exportedBoth.total, 3);
    // Без --area прежний контракт export сохраняется: global (+ project).
    const exportedPlain = await runJson(DECISIONS_CLI, [
      'export', '--db', dbPath, '--project', 'demo', '--json',
    ]);
    assert.match(exportedPlain.markdown, /Global owner gate decision/);
    assert.match(exportedPlain.markdown, /Demo project decision/);
    assert.doesNotMatch(exportedPlain.markdown, /Backend area decision/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('df-decisions: pending перечисляет ожидающие предложения в обоих режимах вывода', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'df-decisions-pending-'));
  try {
    const dbPath = join(dir, 'ledger.db');
    // Пустая база: json — пустой массив, человеческий вывод — понятная строка.
    assert.deepEqual(await runJson(DECISIONS_CLI, ['pending', '--db', dbPath, '--json']), []);
    const emptyHuman = await runCli(DECISIONS_CLI, ['pending', '--db', dbPath]);
    assert.equal(emptyHuman.code, 0, emptyHuman.stderr);
    assert.equal(emptyHuman.stdout, 'no pending proposals\n');

    const first = await runJson(DECISIONS_CLI, [
      'propose', '--db', dbPath, '--scope', 'global', '--topic', 'first topic',
      '--decision', 'First pending decision', '--by', 'cto', '--json',
    ]);
    const second = await runJson(DECISIONS_CLI, [
      'propose', '--db', dbPath, '--scope', 'area:backend', '--topic', 'second topic',
      '--decision', 'Second pending decision', '--by', 'cto', '--json',
    ]);

    const rows = await runJson(DECISIONS_CLI, ['pending', '--db', dbPath, '--json']);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map(row => row.proposal_id), [first.proposal_id, second.proposal_id]);
    assert.ok(rows.every(row => row.status === 'pending'));
    assert.equal(rows[0].topic, 'first topic');
    assert.equal(rows[1].scope, 'area:backend');
    // Утверждённые/отклонённые предложения в выдачу не попадают.
    assert.equal(rows.some(row => row.status !== 'pending'), false);

    const human = await runCli(DECISIONS_CLI, ['pending', '--db', dbPath]);
    assert.equal(human.code, 0, human.stderr);
    assert.match(human.stdout, /first topic/);
    assert.match(human.stdout, new RegExp(first.proposal_id));
    assert.match(human.stdout, /Second pending decision/);

    // Одобренное предложение исчезает из pending; approved-запись в выдачу
    // не попадает даже после появления активного решения.
    await runJson(DECISIONS_CLI, [
      'approve', '--db', dbPath, '--id', first.proposal_id, '--by', 'owner', '--json',
    ]);
    const remaining = await runJson(DECISIONS_CLI, ['pending', '--db', dbPath, '--json']);
    assert.deepEqual(remaining.map(row => row.proposal_id), [second.proposal_id]);
    // Отклонённое тоже исчезает.
    await runJson(DECISIONS_CLI, [
      'reject', '--db', dbPath, '--id', second.proposal_id, '--by', 'owner', '--json',
    ]);
    assert.deepEqual(await runJson(DECISIONS_CLI, ['pending', '--db', dbPath, '--json']), []);

    // Чужие флаги pending не принимает.
    const unknown = await runCli(DECISIONS_CLI, ['pending', '--db', dbPath, '--q', 'x']);
    assert.equal(unknown.code, 2);
    assert.match(unknown.stderr, /unknown option --q for command pending/);

    // Прямой вызов runDecisionsCli возвращает тот же типизированный массив.
    const direct = await runDecisionsCli(['pending', '--json'], { defaultDbPath: dbPath });
    assert.deepEqual(direct, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('df-archive: вход ingest обязан быть обычным файлом не более 64 MiB', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'df-archive-guard-'));
  try {
    const dbPath = join(dir, 'archive.db');
    const ingestArgs = file => [
      'ingest', '--db', dbPath, '--file', file, '--harness', 'agy',
      '--host', 'cloud-hub', '--project', 'darkfactory', '--json',
    ];

    // Каталог отклоняется до чтения содержимого.
    const folder = join(dir, 'transcript-dir');
    await mkdir(folder);
    const asDir = await runCli(ARCHIVE_CLI, ingestArgs(folder));
    assert.equal(asDir.code, 2);
    assert.match(asDir.stderr, /df_archive_transcript_not_file/);

    // Файл больше 64 MiB отклоняется по lstat до чтения (разреженный
    // файл: проверка размера детерминирована и не зависит от содержимого).
    const oversized = join(dir, 'oversized.jsonl');
    await writeFile(oversized, '');
    await truncate(oversized, 64 * 1024 * 1024 + 1);
    const tooLarge = await runCli(ARCHIVE_CLI, ingestArgs(oversized));
    assert.equal(tooLarge.code, 2);
    assert.match(tooLarge.stderr, /df_archive_transcript_too_large/);

    // Симлинк на валидный транскрипт — не regular file по lstat: контракт
    // проверки входа отклоняет его до realpath.
    const realTranscript = join(dir, 'real.jsonl');
    await writeJsonl(realTranscript, [
      { type: 'user_message', content: 'guard rail session', createdAt: '2025-01-01T10:00:00Z' },
    ]);
    const link = join(dir, 'linked.jsonl');
    await symlink(realTranscript, link);
    const asLink = await runCli(ARCHIVE_CLI, ingestArgs(link));
    assert.equal(asLink.code, 2);
    assert.match(asLink.stderr, /df_archive_transcript_not_file/);

    // Граничный валидный файл по-прежнему принимается.
    const ingested = await runJson(ARCHIVE_CLI, ingestArgs(realTranscript));
    assert.equal(ingested.insertedMessages, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
