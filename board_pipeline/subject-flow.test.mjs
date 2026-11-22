// Интеграция VS-1.1: реальный loopback `vb serve` (порт 0, никогда :44100), реальный Git
// и настоящая нативная разблокировка needs. Внешние границы WorkerPort/L1/L2 подменены
// детерминированными cut points; Board, acceptHeld и invariant claimReady — по-настоящему.

import assert from 'node:assert/strict';
import { execFileSync, spawn as spawnProcess } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { acceptHeld } from './acceptance.mjs';
import { advance } from './controller.mjs';
import { nativeBoardPort } from './native-board.mjs';
import { buildSubject, subjectDigest } from './subject.mjs';
import { loadSdk } from './sdk.mjs';
import { worktreeInspector } from './runtime.mjs';

const REVIEW = { provider: 'openai', model: 'gpt-6.2-sol', reasoningLevel: 'medium' };
const SPEC = 'a'.repeat(64);
const POLICY_DIGEST = 'b'.repeat(64);
const REPO = 'darkfactory-vs1-fixture';

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function commit(cwd, title) {
  git(cwd, '-c', 'user.email=fixture@example.invalid', '-c', 'user.name=Fixture',
    '-c', 'commit.gpgsign=false', 'commit', '-m', title);
}

// Тот же установленный SDK, что и во всём контуре (loadSdk), — CLI `vb` из его bin.
function boardCli() {
  const cli = join(homedir(), '.local/share/vercel-board/node_modules/@vercel/board/dist/cli.mjs');
  readFileSync(cli);
  return cli;
}

async function startBoard(cli, t) {
  const dir = await mkdtemp(join(tmpdir(), 'vs1-subject-flow-'));
  const child = spawnProcess(process.execPath, [cli, 'serve', '--port', '0',
    '--dir', join(dir, '.board'), '--no-inspect', '--no-open'],
  { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { child.kill('SIGTERM'); return rm(dir, { recursive: true, force: true }); });
  const url = await new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error(`vb serve did not report a URL: ${buffer}`)), 20_000);
    child.stdout.on('data', data => {
      buffer += String(data);
      const match = /serving a local board at (http:\/\/127\.0\.0\.1:\d+\/api\/board)/.exec(buffer);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    child.on('exit', code => reject(new Error(`vb serve exited early: ${code}`)));
  });
  return { url, dir };
}

test('две связанные карточки на реальном vb serve: claimReady, subject_digest и нативная разблокировка needs', async t => {
  const { url, dir } = await startBoard(boardCli(), t);
  process.env.BOARD_URL = url;
  const { board } = loadSdk();
  const handle = board();

  const root = await mkdtemp(join(tmpdir(), 'vs1-worktree-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tree = join(root, 'worktree');
  await mkdir(tree, { mode: 0o700 });
  git(tree, 'init', '--initial-branch=pilot');
  await writeFile(join(tree, 'check.mjs'), 'process.exit(0);\n');
  git(tree, 'add', 'check.mjs');
  commit(tree, 'Synthetic base');
  const base = git(tree, 'rev-parse', 'HEAD');
  await writeFile(join(tree, 'check.mjs'), 'console.log("Synthetic candidate"); process.exit(0);\n');
  git(tree, 'add', 'check.mjs');
  commit(tree, 'Synthetic candidate');
  const candidate = git(tree, 'rev-parse', 'HEAD');
  const treeSha = git(tree, 'rev-parse', `${candidate}^{tree}`);

  // Изолированный канал на живом сервере; карточки связаны нативными needs.
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await handle.createChannel('pilot');
      break;
    } catch (error) {
      if (attempt === 5) throw error;
      await new Promise(resolve => setTimeout(resolve, 300));
    }
  }
  const labels = { spec_digest: SPEC, policy_digest: POLICY_DIGEST, repo_id: REPO,
    profile_id: 'pilot', finish: 'verified', queue: 'vs1' };
  const [head, dependent] = await handle.tasks.createMany('pilot', [
    { key: 'vs1', text: 'Synthetic VS-1 head', noSync: true, labels },
    { text: 'Synthetic VS-1 dependent', needs: [{ key: 'vs1' }], noSync: true, labels },
  ], { id: 'vs1-subject-flow' });
  const owner = (await handle.thread(head.id, { limit: 1 })).message.task.owner;

  const seen = { claim: 0 };
  const ported = {
    ...handle,
    tasks: {
      ...handle.tasks,
      claim: async (...args) => { seen.claim++; return handle.tasks.claim(...args); },
    },
  };
  const port = nativeBoardPort(ported, { channel: 'pilot', lease: 900 });
  const card = async id => (await handle.thread(id, { limit: 1 })).message.task;

  const effects = { spawn: 0, verify: 0, completed: [] };
  const state = () => {
    let stored;
    return {
      cfg: {
        route: { allowlist: { owner, label: { key: 'queue', value: 'vs1' } }, base,
          policyVersion: 'vs1-1', checkProfile: 'pilot', worktree: tree, finish: 'verified' },
        authorize: async () => true,
        state: { load: async () => structuredClone(stored), save: async value => { stored = structuredClone(value); } },
        board: port,
        bb: { async spawn() { effects.spawn++; return { threadId: `thr_vs${effects.spawn}` }; } },
        submissions: { async read(attempt, after) {
          if (!effects.completed.length || effects.completed.length <= after) return;
          const turnSeq = effects.completed.length;
          return { turnSeq, submission: {
            task_id: attempt.task_id, epoch: attempt.epoch, attempt_id: attempt.attempt_id,
            worker_thread_id: attempt.bb_thread_id, candidate_sha: effects.completed[turnSeq - 1] } };
        } },
        async verify(attempt, submission) {
          effects.verify++;
          const policy = { version: 'vs1-1', digest: POLICY_DIGEST, profiles: { pilot: {
            task: attempt.task_id, worker: attempt.bb_thread_id, worktree: tree, branch: 'pilot',
            base: attempt.base_sha, finish: attempt.finish, review: REVIEW } } };
          const journal = await mkdtemp(join(dir, 'journal-'));
          const result = await acceptHeld({
            attempt: { ...attempt, tree_sha: treeSha },
            submission,
            policy,
            journal,
            ports: {
              board: port,
              inspect: worktreeInspector(policy),
              local: async binding => ({ sha: binding.candidate_sha, ok: true,
                evidence: [{ file: 'checks-vs1.log', sha256: 'c'.repeat(64), exit: 0 }] }),
              review: async binding => ({ task: binding.task_id, sha: binding.candidate_sha,
                actual: REVIEW, verdict: 'REVIEW_OK', checkpoint: 'feed80ab' }),
            },
          });
          return result;
        },
      },
      reset: () => { stored = undefined; },
    };
  };

  const expectedDigest = subjectDigest(buildSubject({
    kind: 'git_tree', repoId: REPO, baseSha: base, candidateSha: candidate, treeSha,
    specDigest: SPEC, policyDigest: POLICY_DIGEST, fixturesDigest: null,
    releaseTarget: { finish: 'verified' },
  }));

  // Слот 1: автоподхват готовой карточки #1 из очереди по allowlist.
  let slot = state();
  assert.equal((await advance(slot.cfg)).phase, 'working');
  assert.equal(effects.spawn, 1);
  assert.equal(seen.claim, 1);
  assert.equal((await card(head.id)).state, 'claimed');
  assert.equal((await card(dependent.id)).state, 'waiting', 'зависимая карточка ждёт завершения #1');

  // Сдача того же кандидата проходит настоящий acceptHeld: Git-снимок + seal + complete.
  effects.completed.push(candidate);
  const settledHead = await advance(slot.cfg);
  assert.equal(settledHead.phase, 'done', settledHead.reason ?? '');
  const headTask = await card(head.id);
  assert.equal(headTask.state, 'completed');
  const receipt = typeof headTask.result === 'string' ? JSON.parse(headTask.result) : headTask.result;
  assert.equal(receipt.sha, candidate);
  assert.equal(receipt.subject_digest, expectedDigest, 'квитанция карточки привязана к subject_digest');
  assert.equal((await card(dependent.id)).state, 'ready', 'нативная разблокировка waiting → ready');

  // Слот 2: подхват освободившейся зависимой карточки через claimReady.
  slot.reset();
  assert.equal((await advance(slot.cfg)).phase, 'working');
  assert.equal(effects.spawn, 2);
  assert.equal(seen.claim, 2);
  assert.equal((await card(dependent.id)).state, 'claimed');
  effects.completed.push(candidate);
  const settledDependent = await advance(slot.cfg);
  assert.equal(settledDependent.phase, 'done', settledDependent.reason ?? '');
  assert.equal((await card(dependent.id)).state, 'completed');

  // Пустая очередь: 0 claim и 0 spawn.
  slot.reset();
  assert.equal((await advance(slot.cfg)).phase, 'idle');
  assert.equal(effects.spawn, 2);
  assert.equal(seen.claim, 2);
});
