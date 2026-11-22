import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { accept } from './acceptance.mjs';
import { nativeBoardPort } from './native-board.mjs';
import { offlineDockerRunner, offlineVisualRunner, worktreeInspector } from './runtime.mjs';
import { tamperGate } from './tamper-gate.mjs';
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
      tamper: tamperGate,
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

test('визуальный гейт: tmpfs-квота при записи, артефакты возвращаются и аттестуются', async (t) => {
  const temp = await mkdtemp(join(tmpdir(), 'board-visual-integration-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const journal = join(temp, 'journal');
  await mkdir(journal, { mode: 0o700 });
  const tree = join(temp, 'tree');
  await mkdir(tree);
  const git = (...args) => command('git', ['-C', tree, ...args]);
  git('init', '--initial-branch=pilot');
  await writeFile(join(tree, 'page.txt'), 'hello\n');
  git('add', 'page.txt');
  git('-c', 'user.email=fixture@example.invalid', '-c', 'user.name=Fixture',
    '-c', 'commit.gpgsign=false', 'commit', '-m', 'base');
  const candidate = git('rev-parse', 'HEAD');
  const image = command('docker', ['image', 'inspect', 'node:22.23.2-bookworm-slim', '--format', '{{.Id}}']);
  const runner = offlineVisualRunner(journal);
  const binding = { task_id: 't-visual', worktree: tree, candidate_sha: candidate };
  const visual = (argv) => ({ visual: { image, argv, cwd: '.', timeoutMs: 60_000 } });

  // Обычный артефакт возвращается через tmpfs-квоту и копирование в /out.
  const res = await runner(binding, visual(['sh', '-c', 'echo shot > /artifacts/shot.png']));
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.status, 'pass');
  assert.equal(res.artifacts.length, 1);
  assert.match(res.artifacts[0].sha256, /^[0-9a-f]{64}$/);
  assert.ok(res.artifacts[0].bytes >= 1);

  // Квота nr_inodes при записи: ядро не даёт создать все 200 файлов; сверх 64
  // собранных артефактов сбор отказывает — оба исхода безопасны.
  const many = await runner(binding, visual(['sh', '-c',
    'for i in $(seq 1 200); do echo x > /artifacts/f$i; done; true']))
    .then((r) => r, (e) => ({ error: String(e) }));
  if ('error' in many) {
    assert.match(many.error, /Visual artifacts exceed|visual/);
  } else {
    assert.ok(many.artifacts.length < 200,
      `ядро ограничило число файлов tmpfs: ${many.artifacts.length}`);
  }

  // Квота при записи: 40 МиБ в tmpfs size=32m и fsize=8MiB — на хост попадает
  // только ограниченный объём, заполнить диск журнала рецепт не может.
  const big = await runner(binding, visual(['sh', '-c',
    'dd if=/dev/zero of=/artifacts/big.bin bs=1M count=40 2>/dev/null; ' +
    'for i in $(seq 1 8); do dd if=/dev/zero of=/artifacts/p$i bs=1M count=9 2>/dev/null; done; true']))
    .then((r) => r, (e) => ({ error: String(e) }));
  if ('error' in big) {
    // Лимит сбора — второй контур после ядерной квоты: переполнение невозможно.
    assert.match(big.error, /Visual artifacts exceed/);
  } else {
    const total = big.artifacts.reduce((sum, a) => sum + a.bytes, 0);
    assert.ok(total <= 32 * 1024 * 1024, `сумма ограничена квотой tmpfs: ${total}`);
    assert.ok(big.artifacts.every((a) => a.bytes <= 8 * 1024 * 1024),
      'каждый файл ограничен fsize');
    assert.ok(big.artifacts.length <= 64, 'число файлов ограничено nr_inodes/сбором');
  }
});
