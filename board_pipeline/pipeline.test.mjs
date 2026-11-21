import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { accept } from './acceptance.mjs';
import { nativeBoardPort } from './native-board.mjs';
import { offlineDockerRunner, worktreeInspector } from './runtime.mjs';
import { loadSdk } from './sdk.mjs';

const REVIEW = { provider: 'openai', model: 'gpt-6.2-sol', reasoningLevel: 'medium' };

function command(bin, args) {
  return execFileSync(bin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

for (const red of [false, true]) {
  test(`Board + Git + isolated runner: ${red ? 'red is blocked' : 'green unlocks dependent once'}`, async t => {
    const originalUmask = process.umask(0o077);
    t.after(() => process.umask(originalUmask));
    const temp = await mkdtemp(join(tmpdir(), 'board-pilot-integration-'));
    t.after(() => rm(temp, { recursive: true, force: true }));
    const tree = join(temp, 'worktree');
    const journal = join(temp, 'journal');
    await mkdir(tree);
    await mkdir(journal, { mode: 0o700 });
    const git = (...args) => command('git', ['-C', tree, ...args]);
    git('init', '--initial-branch=pilot');
    const commit = title => git('-c', 'user.email=fixture@example.invalid', '-c', 'user.name=Fixture',
      '-c', 'commit.gpgsign=false', 'commit', '-m', title);
    await writeFile(join(tree, 'check.mjs'), 'process.exit(1);\n');
    git('add', 'check.mjs');
    commit('Synthetic baseline');
    const base = git('rev-parse', 'HEAD');
    await writeFile(join(tree, 'check.mjs'), `console.log('Synthetic candidate'); process.exit(${red ? 3 : 0});\n`);
    git('add', 'check.mjs');
    commit('Synthetic candidate');
    const candidate = git('rev-parse', 'HEAD');

    const { board, local } = loadSdk();
    const backend = local({ memory: true });
    t.after(() => backend.close());
    const handle = board({ backend });
    await handle.createChannel('pilot');
    const [task, dependent] = await handle.tasks.createMany('pilot', [
      { key: 'pilot', text: 'Synthetic acceptance integration', noSync: true },
      { text: 'Synthetic dependent', needs: [{ key: 'pilot' }], noSync: true },
    ], { id: 'isolated-pilot-v1' });
    const image = command('docker', ['image', 'inspect', 'node:22.23.2-bookworm-slim', '--format', '{{.Id}}']);
    const profile = { task: task.id, worktree: tree, branch: 'pilot', base, worker: 'thr_fixture',
      review: REVIEW, check: { image, argv: ['node', 'check.mjs'], cwd: '.', timeoutMs: 20_000 } };
    const policy = { version: '1', profiles: { pilot: profile } };
    const handoff = { task_id: task.id, worker_thread_id: 'thr_fixture', worktree: tree,
      base_sha: base, candidate_sha: candidate, check_profile: 'pilot' };
    let reviewed = 0;
    const ports = {
      board: nativeBoardPort(handle, { channel: 'pilot' }),
      inspect: worktreeInspector(policy),
      local: offlineDockerRunner(journal),
      async review(handoff) {
        reviewed++;
        // Explicit fixture: this test proves the handoff, not the BB/model runtime.
        return { task: handoff.task_id, sha: handoff.candidate_sha, actual: REVIEW,
          verdict: 'REVIEW_OK', checkpoint: 'feed80ab' };
      },
    };
    const input = { handoff, policy, journal, ports };
    const outcome = red ? 'blocked' : 'completed';
    assert.equal((await accept(input)).outcome, outcome);
    const result = await ports.board.lookup(task.id);
    assert.equal(result.state, outcome);
    if (!red) {
      assert.equal(result.result.sha, candidate);
      assert.equal(result.result.review.checkpoint, 'feed80ab');
    }
    assert.equal((await ports.board.lookup(dependent.id)).state, red ? 'waiting' : 'ready');
    const repeat = await accept(input);
    assert.equal(repeat.outcome, outcome);
    assert.equal(repeat.repeated, true);
    assert.equal(reviewed, red ? 0 : 1);
  });
}
