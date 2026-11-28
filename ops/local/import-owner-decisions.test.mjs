import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { resolveActiveDecisions } from '../../board_pipeline/decision-ledger.mjs';
import { openUnifiedLedger } from '../../board_pipeline/unified-ledger.mjs';
import { parsePortfolio } from './import-owner-decisions.mjs';

const local = import.meta.dirname;
const cli = join(local, 'import-owner-decisions.mjs');
const sync = join(local, 'df-telemetry-sync.sh');
const ingest = join(local, 'df-archive-ingest.sh');
const text = path => readFileSync(path, 'utf8');
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'df-local-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function invoke(exe, args, env = {}, status = 0) {
  const result = spawnSync(exe, args, { encoding: 'utf8', env: { ...process.env, ...env } });
  assert.ifError(result.error);
  assert.equal(result.status, status, result.stderr);
  return result;
}

test('parse numbered bold entries, including title-only rules, but not prose or code samples', () => {
  const md = ['# Owner portfolio', '1. unrelated list', '1. **Signing**: Use offline keys',
    '   for releases.', '', '```md', '2. **Not approved**', '```', '12. **Keep backups**'];
  assert.deepEqual(parsePortfolio(md.join('\r\n')), [
    { scope: 'global', topic: 'Signing', decision: 'Use offline keys for releases.' },
    { scope: 'global', topic: 'Keep backups', decision: 'Keep backups' },
  ]);
});

test('missing, valueless or whitespace-only approval fails before any file access', t => {
  const dir = fixture(t);
  const db = join(dir, 'unified-ledger.db');
  for (const approval of [[], ['--approved-by'], ['--approved-by', '   ']]) {
    const { stderr } = invoke(process.execPath, [cli, '--from', join(dir, 'absent.md'), '--db', db, ...approval], {}, 2);
    assert.match(stderr, /approved-by/);
    assert.equal(existsSync(db), false);
  }
});

function approve(ledger, scope, topic, decision, supersedesId) {
  const proposal = ledger.proposeDecision({ scope, topic, decision, proposedBy: 'operator' });
  return ledger.approveProposal(proposal.proposal_id, { approvedBy: 'owner', supersedesId });
}

test('repeat import adds zero; private JSONL snapshot preserves all active project and global IDs', async t => {
  const dir = fixture(t);
  const db = join(dir, 'unified-ledger.db'), from = join(dir, 'portfolio.md'), out = join(dir, 'sync.jsonl');
  const ledger = openUnifiedLedger(db);
  const old = approve(ledger, 'project:test', 'Launch', 'not yet');
  const current = approve(ledger, 'project:test', 'Launch', 'ready', old.id);
  approve(ledger, 'global', ' Old   rule ', 'Keep it');
  ledger.proposeDecision({ scope: 'global', topic: 'Pending', decision: 'Not approved', proposedBy: 'operator' });
  ledger.close();
  writeFileSync(from, '1. **old rule**: Must not replace it\n2. **Launch**: Review first\n3. **Back up**\n4. **BACK  UP**\n');
  const args = [cli, '--db', db, '--from', from, '--approved-by', 'Owner One', '--export-jsonl', out];
  assert.deepEqual(JSON.parse(invoke(process.execPath, args).stdout), { imported: 2, skipped: 2 });
  const snapshot = text(out);
  assert.deepEqual(JSON.parse(invoke(process.execPath, args).stdout), { imported: 0, skipped: 4 });
  assert.equal(text(out), snapshot);
  assert.equal(statSync(out).mode & 0o777, 0o600);
  const rows = snapshot.trimEnd().split('\n').map(line => JSON.parse(line));
  assert.equal(rows.filter(r => r.approved_by === 'Owner One').length, 2);
  const slice = await resolveActiveDecisions({ ledgerPath: out, projectId: 'test' });
  assert.equal(slice.total, 4);
  assert.ok(slice.ids.includes(current.id));
  assert.ok(!slice.ids.includes(old.id));
  assert.ok(slice.items.some(item => item.scope === 'global' && item.rule === 'Launch: Review first'));
  assert.ok(slice.items.some(item => item.rule.endsWith('Keep it')));
  assert.equal((await resolveActiveDecisions({ ledgerPath: out })).total, 3);

  // An area has no v1 scope equivalent. Never publish a partial or broader export.
  const updated = openUnifiedLedger(db);
  approve(updated, 'area:legal', 'Legal decision', 'Restricted');
  updated.close();
  assert.match(invoke(process.execPath, args, {}, 1).stderr, /cannot represent scope area:legal/);
  assert.equal(text(out), snapshot);
});

test('bash syntax for both scheduled scripts', () => {
  for (const script of [sync, ingest]) invoke('bash', ['-n', script]);
});

test('telemetry merges dynamic slots in order and contacts rclone only in upload mode', t => {
  const dir = fixture(t), out = join(dir, 'merged'), trace = join(dir, 'upload');
  const env = { PATH: `${dir}:${process.env.PATH}`, DF_STATE_ROOT: dir, TMPDIR: dir, TRACE: trace, DF_TELEMETRY_REMOTE: '' };
  writeFileSync(join(dir, 'rclone'), '#!/bin/sh\nprintf "%s\\n" "$1" "$2" "$4" > "$TRACE"\ncat "$3" >> "$TRACE"\n', { mode: 0o700 });
  invoke(sync, [], env); // No slot logs: do not overwrite a previous remote snapshot.
  assert.equal(existsSync(trace), false);
  const expected = '{"n":2}\n{"n":1}\n{"n":3}\n';
  for (const [slot, data] of [['-slot9', '{"n":1}\n{"n":3}\n'], ['', '{"n":2}\n\n{"n":1}\n{"n":2}']]) {
    const root = join(dir, `daemon-state${slot}`);
    mkdirSync(root);
    writeFileSync(join(root, 'telemetry.jsonl'), data);
  }
  invoke(sync, ['--dry-run', '--out', out], env);
  assert.equal(existsSync(out), false);
  invoke(sync, ['--out', out], env);
  assert.equal(text(out), expected);
  assert.equal(existsSync(trace), false);
  invoke(sync, [], env);
  assert.equal(text(trace), `copyto\n--checksum\ngdrive:darkfactory-telemetry/telemetry-worker-all.jsonl\n${expected}`);
  writeFileSync(join(dir, 'rclone'), '#!/bin/sh\nexit 17\n');
  invoke(sync, [], env, 17); // Upload failures must reach the caller.
});

test('archive ingests recent transcripts despite individual failures with embeddings disabled', t => {
  const dir = fixture(t), db = join(dir, 'archive.db');
  const agy = join(dir, 'agy transcripts'), pi = join(dir, 'pi');
  mkdirSync(agy); mkdirSync(pi);
  writeFileSync(join(agy, 'bad.jsonl'), 'invalid\n');
  writeFileSync(join(agy, 'agy.jsonl'), '{"type":"user_message","content":"archive this"}\n');
  writeFileSync(join(pi, 'pi.jsonl'), '{"type":"user","content":"archive this too"}\n');
  writeFileSync(join(pi, 'old.jsonl'), '{"type":"user","content":"not recent"}\n');
  utimesSync(join(pi, 'old.jsonl'), 1000, 1000);
  const repo = resolve(local, '../..');
  const env = { DF_REPO: repo, DF_ARCHIVE_DB: db, DF_ARCHIVE_AGY_DIRS: `${dir}/missing:${agy}`,
    DF_ARCHIVE_PI_DIRS: pi, DF_ARCHIVE_HOST: 'test-host', DF_ARCHIVE_PROJECT: 'test', DF_ARCHIVE_SKIP_EMBED: '1' };
  assert.match(invoke(ingest, ['--dry-run'], env).stdout, /Would ingest pi/);
  assert.equal(existsSync(db), false);
  assert.match(invoke(ingest, [], env).stderr, /Skipping failed agy transcript/);
  const stats = JSON.parse(invoke(process.execPath, [join(repo, 'ops/df-archive.mjs'), 'stats', '--db', db, '--json']).stdout);
  assert.equal(stats.sessions, 2);
  assert.equal(stats.embeddings, 0);
});

test('archive runs bounded best-effort embed batches after ingest unless disabled', t => {
  const dir = fixture(t), db = join(dir, 'archive db'), trace = join(dir, 'calls');
  const ops = join(dir, 'ops'), file = join(dir, 'session.jsonl');
  mkdirSync(ops);
  writeFileSync(file, '{}\n');
  writeFileSync(join(ops, 'df-archive.mjs'), `
    import { appendFileSync } from 'node:fs';
    const args = process.argv.slice(2);
    appendFileSync(process.env.TRACE, JSON.stringify(args) + '\\n');
    if (args[0] === 'embed') {
      if (process.env.RESPONSE === 'fail') process.exit(2);
      console.log(process.env.RESPONSE);
    }
  `);
  const env = { DF_REPO: dir, DF_ARCHIVE_DB: db, DF_ARCHIVE_AGY_DIRS: '', DF_ARCHIVE_PI_DIRS: dir,
    DF_ARCHIVE_HOST: 'host', DF_ARCHIVE_PROJECT: 'project', DF_ARCHIVE_SKIP_EMBED: '0',
    DF_ARCHIVE_EMBED_MAX_BATCHES: '', TRACE: trace, RESPONSE: '{"embedded":1}' };
  const ingestArgs = ['ingest', '--db', db, '--harness', 'pi', '--file', file, '--host', 'host', '--project', 'project'];
  const embedArgs = ['embed', '--db', db, '--best-effort', '--json'];
  function check(args, overrides, expected) {
    writeFileSync(trace, '');
    invoke(ingest, args, { ...env, ...overrides });
    const calls = text(trace).split('\n').filter(Boolean).map(line => JSON.parse(line));
    assert.deepEqual(calls, expected);
  }
  check(['--dry-run'], {}, []);
  check([], { DF_ARCHIVE_SKIP_EMBED: '1' }, [ingestArgs]);
  check([], {}, [ingestArgs, ...Array(4).fill(embedArgs)]);
  check([], { DF_ARCHIVE_EMBED_MAX_BATCHES: '2' }, [ingestArgs, embedArgs, embedArgs]);
  check([], { DF_ARCHIVE_EMBED_MAX_BATCHES: '0' }, [ingestArgs]);
  check([], { DF_ARCHIVE_EMBED_MAX_BATCHES: 'invalid' }, [ingestArgs]);
  for (const RESPONSE of ['{"embedded":0}', '{"skipped":true,"embedded":1}', 'fail', 'not JSON']) {
    check([], { RESPONSE }, [ingestArgs, embedArgs]);
  }
});
