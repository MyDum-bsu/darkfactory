import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { NEON_CRITIC } from './review-policy.mjs';

const exec = promisify(execFile);
export function agyStreamFixture(response, { model = NEON_CRITIC.model, step = {}, cwd = '/candidate', reads = [] } = {}) {
  const conversation_id = 'synthetic-review';
  return [
    { event: 'init', conversation_id, init: { model, cwd, permission_mode: 'request-review', tools: [] } },
    { event: 'step_update', step_update: { conversation_id, step_index: 0, state: 'DONE', step_type: 'user_input' } },
    ...reads.map((path, i) => ({ event: 'step_update', step_update: {
      conversation_id, step_index: i + 1, state: 'DONE', step_type: 'tool', tool_name: 'read_file',
      tool_info: { name: 'read_file', parameters: { Path: path } },
    } })),
    { event: 'step_update', step_update: { conversation_id, step_index: reads.length + 1, state: 'DONE', step_type: 'agent_response', ...step } },
    { event: 'result', result: { conversation_id, status: 'SUCCESS', num_turns: 1, response: JSON.stringify(response) } },
  ].map(x => JSON.stringify(x)).join('\n');
}
export const SPEC = 'Spec: sum.js must export sum(a,b) returning the exact arithmetic sum a+b. ' +
  'The function must not add or subtract a constant. Checked invariant: sum(2,2)===4.';

async function git(repo, ...args) {
  return (await exec('git', ['-C', repo, ...args], { timeout: 15_000 })).stdout.trim();
}

export async function makeRepo() {
  const repo = await mkdtemp(join(tmpdir(), 'review-it-repo-'));
  await git(repo, 'init', '-q', '-b', 'pilot');
  await git(repo, 'config', 'user.email', 'test@local');
  await git(repo, 'config', 'user.name', 'test');
  return repo;
}

export async function commitFile(repo, body) {
  await writeFile(join(repo, 'sum.js'), body);
  await git(repo, 'add', 'sum.js');
  await git(repo, 'commit', '-qm', 'candidate');
  return git(repo, 'rev-parse', 'HEAD');
}

export async function neonFixture(t, baseFiles = {}) {
  const repo = await makeRepo();
  const journal = await mkdtemp(join(tmpdir(), 'neon-it-journal-'));
  t.after(async () => {
    await rm(repo, { recursive: true, force: true });
    await rm(journal, { recursive: true, force: true });
  });
  for (const [name, body] of Object.entries(baseFiles)) {
    const path = join(repo, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
  }
  await git(repo, 'add', '.');
  await git(repo, 'commit', '--allow-empty', '-qm', 'base');
  const base_sha = await git(repo, 'rev-parse', 'HEAD');
  return { repo, journal, binding: { task_id: '9002', worktree: repo, base_sha,
    executor: 'acp-devin/swe-2-high' }, profile: { review: NEON_CRITIC } };
}
