import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { cp, lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { promisify, parseArgs } from 'node:util';
import { homedir } from 'node:os';
import { CASES } from '../board_pipeline/ab-pilot.mjs';
import { loadRoleRegistry } from '../board_pipeline/role-registry.mjs';
import { requireWorkspaceSpace } from './local/check-workspace-space.mjs';

const exec = promisify(execFile);
const SOURCE = join(import.meta.dirname, '..');
const BASE = '6872d3cbb23aa90908a8f530671816a3620ff972';
const WORKER = { provider: 'pi', model: 'opencode-go/deepseek-v4.1-flash' };
const CRITIC = { provider: 'google', model: 'gemini-4-neon', reasoningLevel: 'medium', skills: ['logika'] };
const ARBITER = { provider: 'openai', model: 'gpt-6.2-sol', reasoningLevel: 'medium' };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const trim = async (cmd, args, opts) => (await exec(cmd, args, opts)).stdout.trim();

const POLICY_ORACLE = `import assert from 'node:assert/strict';
import {isPolicyKey} from './board_pipeline/policy-key.mjs';
for (const s of ['a','test-1','a'.repeat(24)]) assert.equal(isPolicyKey(s), true);
for (const s of ['',null,1,[],{},'A','1x','a b','a\\n','é','a'.repeat(25),'a_1']) assert.equal(isPolicyKey(s), false);`;
const DOC_ORACLE = `import assert from 'node:assert/strict';
import fs from 'node:fs'; import {spawnSync} from 'node:child_process';
const text=fs.readFileSync('docs/typed-handoff-quickstart.md','utf8');
assert.deepEqual([...text.matchAll(/^## (.+)$/gm)].map(x=>x[1]), ['Fields','Rejection','Verification']);
const blocks=[...text.matchAll(/\x60\x60\x60json\\r?\\n([\\s\\S]*?)\x60\x60\x60/g)];
assert.equal(blocks.length,1);
const example=JSON.parse(blocks[0][1]);
assert.deepEqual(Object.keys(example).sort(),['attempt_id','candidate_sha','epoch','task_id','worker_thread_id']);
assert.match(example.candidate_sha,/^[a-f0-9]{40}$/);
const check=(...args)=>spawnSync(process.execPath,['board_pipeline/handoff-doc-check.mjs',...args],{timeout:3000,encoding:'utf8'});
assert.equal(check().status,0);
const invalid='/tmp/ab-invalid-handoff-doc.md'; fs.writeFileSync(invalid,text.replace('## Rejection','## Missing'));
const result=check(invalid); assert.ok(Number.isInteger(result.status)&&result.status!==0); assert.ok((result.stdout+result.stderr).trim());`;

async function writeCatalog(catalog, name) {
  await mkdir(join(catalog, '.darkfactory'), { recursive: true, mode: 0o700 });
  await cp(join(SOURCE, '.darkfactory/shared-skills'), join(catalog, '.darkfactory/shared-skills'), { recursive: true });
  const role = (kind, model, verifier, skills) => ({ kind, model, verifier, skills,
    mode: kind === 'writer' ? 'write' : 'read-only', phaseBudgetMs: 120000,
    reasoning: kind === 'verifier' ? 'medium' : 'inherit', tools: kind === 'writer' ? ['snapshot-read', 'worktree-edit'] : ['snapshot-read'] });
  const roles = {
    implementation: role('writer', 'executor', 'change-set', name === 'policy'
      ? ['feature-blueprint', 'property-testing'] : ['goal-rules', 'session-handoff']),
    verification: role('verifier', 'critic', 'change-set', ['three-pass-review', 'issue-register']),
  };
  const steps = Object.keys(roles);
  for (const id of steps) {
    await mkdir(join(catalog, '.darkfactory/stations', id, 'skills'), { recursive: true, mode: 0o700 });
    await writeFile(join(catalog, '.darkfactory/stations', id, 'instructions.md'),
      `# ${id}\n\n${id} station of the A/B pilot: role protocol, prohibitions, and output format.\n`, { mode: 0o600 });
  }
  const stages = steps.map((id, i) => ({ id, role: id, next: { pass: steps[i + 1] ?? 'ready', rework: 'hold' } }));
  const manifest = { version: 2, stations: roles, playbooks: { [name]: { entry: steps[0], stages } },
    skillPicker: { defaults: ['goal-rules'], rules: [] } };
  await writeFile(join(catalog, '.darkfactory/factory.yaml'), JSON.stringify(manifest), { mode: 0o600 });
  return (await loadRoleRegistry(catalog)).digest;
}

async function startBoard(vb, dir, env) {
  const child = spawn(vb, ['serve', '--port', '0', '--dir', join(dir, 'board'), '--no-inspect', '--no-open'],
    { env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.resume();
  try {
    const url = await new Promise((resolve, reject) => {
      let banner = '';
      const timer = setTimeout(() => reject(new Error('pilot_board_start_timeout')), 15_000);
      child.once('error', err => { clearTimeout(timer); reject(err); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('pilot_board_exited')); });
      child.stdout.on('data', bytes => {
        banner = (banner + bytes.toString()).slice(-8192);
        const match = /serving a local board at (http:\/\/127\.0\.0\.1:[0-9]+\/api\/board)/.exec(banner);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      });
    });
    if (new URL(url).port === '44100') throw new Error('pilot_board_reserved_port');
    return { url, child };
  } catch (error) { child.kill('SIGTERM'); throw error; }
}

async function writeSealedCase({ run, name, arm, project, parent, owner, url, tree, baseSha, image }) {
  const dir = join(run, 'operator');
  const brief = join(dir, 'brief.md'), reviewPrompt = join(dir, 'review.md');
  const reviewGate = join(dir, 'board-review.mjs'), routes = join(dir, 'routes.json');
  const logikaSkill = join(dir, 'logika.md');
  const policyFile = join(dir, 'policy.json'), switchFile = join(run, 'switch', 'run');
  await mkdir(dir, { mode: 0o700 });
  await mkdir(join(run, 'switch'), { mode: 0o700 });
  await writeFile(switchFile, 'run\n', { mode: 0o600 });
  await writeFile(brief, CASES[name].brief + '\nWork only in the specified test copy. Do not access the environment, home files, external data, or other threads. Do not use network, push, PR, or Board. Only local commit and the specified envelope.\n', { mode: 0o600 });
  await writeFile(reviewPrompt, `Independent read-only review. ${CASES[name].brief}\nInspect the exact diff and synthetic tests. Block only proven contract mismatch or test weakening. Do not access the network, other threads, or operational data.`, { mode: 0o600 });
  await writeFile(logikaSkill, '# Logika Review\nVerify contract invariants, edge cases, and test fidelity strictly against the diff.\n', { mode: 0o600 });
  await cp(join(SOURCE, 'ops/local/board-review.mjs'), reviewGate);
  await writeFile(routes, '{}\n', { mode: 0o600 });
  const label = { key: 'queue', value: `ab-${name}-${arm}` };
  const abPilot = { arm, case: name, parent, switch: switchFile };
  if (arm === 'foreman') {
    const catalog = join(run, 'catalog');
    const workspace = join(run, 'observer');
    await mkdir(workspace, { mode: 0o700 });
    Object.assign(abPilot, { catalog, observerWorkspace: workspace, playbook: name, registryDigest: await writeCatalog(catalog, name) });
  }
  const checks = [{ image, cwd: '.', timeoutMs: 20_000,
    argv: ['node', '--input-type=module', '-e', name === 'policy' ? POLICY_ORACLE : DOC_ORACLE] }];
  if (name === 'policy') checks.push({ image, cwd: '.', timeoutMs: 20_000,
    argv: ['node', '--test', 'board_pipeline/policy-key.test.mjs'] });
  const version = 'ab-1448';
  const policy = { scope: 'isolated', boardUrl: url, channel: 'pilot', owner, label, version, waitMs: 360000,
    bb: { ...WORKER, project, permissionMode: 'full' }, arbiter: ARBITER,
    routing: { mode: 'shadow', allowlist: { worker: [WORKER], critic: [CRITIC], arbiter: [ARBITER] } },
    route: { repoId: 'ab-case', base: baseSha, worktree: tree, policyVersion: version, checkProfile: 'case', finish: 'verified' },
    profiles: { case: { branch: 'pilot', review: CRITIC, checks } },
    brief, reviewPrompt, reviewGate, reviewSkillFiles: { logika: logikaSkill }, handoffDir: join(run, 'inbox'), abPilot };
  await writeFile(policyFile, JSON.stringify(policy), { mode: 0o600 });
  const hashes = await Promise.all([policyFile, brief, reviewPrompt, reviewGate, routes, logikaSkill].map(async path => sha(await readFile(path))));
  return { policyFile, label, specDigest: hashes[2], policyDigest: sha(JSON.stringify(hashes)) };
}

async function stopKnownChildren(run, parent, project) {
  const readOptional = async path => {
    try { return await readFile(path, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
  };
  const raw = await readOptional(join(run, 'state/attempt.json'));
  const attempt = raw ? JSON.parse(raw) : null;
  const stageLog = await readOptional(join(run, 'state/ab-stage-threads.jsonl'));
  const known = stageLog.split('\n').filter(Boolean)
    .map(line => [JSON.parse(line).threadId, join(run, 'observer')]);
  if (attempt?.threadId) known.push([attempt.threadId, join(run, 'worktree')]);
  for (const [id, workspace] of known) {
    if (!/^thr_[a-z0-9]+$/.test(id ?? '')) throw new Error('pilot_cleanup_unbound');
    const snapshot = JSON.parse(await trim('bb', ['thread', 'show', id, '--json'], { timeout: 8000 }));
    const thread = snapshot.thread;
    if (thread?.id !== id || thread.parentThreadId !== parent || thread.projectId !== project ||
        (snapshot.environment?.path !== workspace && !(thread.status === 'starting' && snapshot.environment?.path == null))) {
      throw new Error('pilot_cleanup_unbound');
    }
    if (!['idle', 'failed', 'interrupted'].includes(thread.status) || thread.activeBackgroundAgentCount > 0) {
      await exec('bb', ['thread', 'stop', id], { timeout: 15000 });
    }
  }
}

async function runCell(name, arm, root, parent, project) {
  const runnerSha = await trim('git', ['-C', SOURCE, 'rev-parse', 'HEAD']);
  if (await trim('git', ['-C', SOURCE, 'status', '--porcelain=v1', '--untracked-files=all'])) {
    throw new Error('pilot_runner_not_clean');
  }
  const run = join(root, `${name}-${arm}`);
  await mkdir(run, { mode: 0o700 }); // a second launch of the same cell must fail
  for (const sub of ['seed', 'inbox', 'state', 'config', 'xdg-state', 'tmp']) await mkdir(join(run, sub), { mode: 0o700 });
  const env = { ...process.env, XDG_CONFIG_HOME: join(run, 'config'), XDG_STATE_HOME: join(run, 'xdg-state'), TMPDIR: join(run, 'tmp') };
  delete env.BOARD_TOKEN;
  delete env.BOARD_URL;
  const snapshot = join(run, 'source.tar');
  const { stdout } = await exec('git', ['archive', BASE], { cwd: SOURCE, encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 });
  await writeFile(snapshot, stdout, { mode: 0o600 });
  await exec('tar', ['-xf', snapshot, '-C', join(run, 'seed')]);
  const seed = join(run, 'seed'), tree = join(run, 'worktree');
  const git = (...args) => trim('git', ['-C', seed, ...args], { env: { ...env,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' } });
  await git('init', '--initial-branch=fixture');
  await git('add', '.');
  await git('-c', 'user.name=Pilot Fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '-m', 'Sanitized A/B substrate');
  const baseSha = await git('rev-parse', 'HEAD');
  await git('worktree', 'add', '-b', 'pilot', tree, baseSha);
  const image = await trim('docker', ['image', 'inspect', 'node:22.23.2-bookworm-slim', '--format', '{{.Id}}']);
  if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error('pilot_check_image_unavailable');
  const vb = join(homedir(), '.local/share/vercel-board/node_modules/.bin/vb');
  const board = await startBoard(vb, run, env);
  const callBoard = async (...args) => JSON.parse(await trim(vb, ['--url', board.url, ...args, '--json'], { env, timeout: 12_000 }));
  try {
    await callBoard('channels', 'create', 'pilot');
    const { principal: owner } = await callBoard('whoami');
    if (typeof owner !== 'string') throw new Error('pilot_board_owner_unconfirmed');
    const { policyFile, label, policyDigest, specDigest } = await writeSealedCase({ run, name, arm, project, parent,
      owner, url: board.url, tree, baseSha, image });
    const created = await callBoard('tasks', 'create', 'pilot', `Isolated #1448 ${name}`, '--no-sync',
      '--label', `${label.key}=${label.value}`, '--label', 'repo_id=ab-case', '--label', 'profile_id=case',
      '--label', 'finish=verified', '--label', `spec_digest=${specDigest}`, '--label', `policy_digest=${policyDigest}`);
    const taskId = created.task?.id;
    if (!/^[1-9][0-9]*$/.test(taskId ?? '')) throw new Error('pilot_task_unconfirmed');
    const started = Date.now();
    const output = await exec(process.execPath, [join(SOURCE, 'board_pipeline/run-isolated.mjs'), '--execute',
      '--policy', policyFile, '--state', join(run, 'state')], { env, timeout: 360_000, maxBuffer: 2 * 1024 * 1024 })
      .then(r => ({ ...r, code: 0 }), e => ({ stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code ?? null }));
    const wall = Date.now() - started;
    await writeFile(join(run, 'runner.log'), output.stdout + '\n' + output.stderr, { mode: 0o600 });
    const snapshot = await callBoard('read', taskId);
    if (await trim('git', ['-C', SOURCE, 'rev-parse', 'HEAD']) !== runnerSha ||
        await trim('git', ['-C', SOURCE, 'status', '--porcelain=v1', '--untracked-files=all'])) throw new Error('pilot_runner_drift');
    const outcome = { name, arm, taskId, baseSha, runnerSha, elapsed_ms: wall, exit: output.code,
      board: snapshot.message?.task?.state ?? null };
    await writeFile(join(run, 'outcome.json'), JSON.stringify(outcome), { mode: 0o600 });
    await writeFile(join(run, 'board-receipt.json'), JSON.stringify(snapshot.message), { mode: 0o600 });
    console.log(JSON.stringify(outcome));
  } finally {
    try { await stopKnownChildren(run, parent, project); }
    finally {
      if (board.child.exitCode === null) { const stopped = once(board.child, 'exit'); board.child.kill('SIGTERM'); await stopped; }
    }
  }
}

try {
  const { values } = parseArgs({ options: { execute: { type: 'boolean' }, case: { type: 'string' },
    arm: { type: 'string' }, root: { type: 'string' } } });
  const parent = process.env.BB_THREAD_ID;
  const project = process.env.BB_PROJECT_ID;
  if (!values.execute || !Object.hasOwn(CASES, values.case) || !['linear', 'foreman'].includes(values.arm) ||
      !isAbsolute(values.root ?? '') || !/^thr_[a-z0-9]+$/.test(parent ?? '') || !/^proj_[a-z0-9]+$/.test(project ?? '')) {
    throw new Error('Use --execute --case policy|docs --arm linear|foreman --root ABS_DIR from the approved parent thread');
  }
  const root = await realpath(values.root);
  const info = await lstat(root);
  if (root !== values.root || !info.isDirectory() || info.uid !== process.getuid() || info.mode & 0o077) {
    throw new Error('Pilot evidence root must be canonical, private and owned by the operator');
  }
  await requireWorkspaceSpace(root, 'worktree');
  await runCell(values.case, values.arm, root, parent, project);
} catch (error) {
  console.error('ab-pilot:', error.message.split('\n')[0]);
  process.exitCode = 1;
}
