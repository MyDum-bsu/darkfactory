import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { boardId } from '../ops/control-room/attempt-artifacts.mjs';
import { healProject, sanitizeExcerpt } from './ci-healer.mjs';
import { createDispatcher } from './dispatcher.mjs';

const sha = 'abcde'.repeat(8), branch = 'feat/one';
const secret = 'do-not-publish-this';
const check = (name, head_sha = sha) => ({ name, head_sha, status: 'completed', conclusion: 'failure',
  output: { summary: `TypeError: failed expectation\nAuthorization: Bearer ${secret}` } });

test('redaction precedes UTF-8 truncation and handles empty and multiline input', () => {
  assert.equal(sanitizeExcerpt(null), '');
  // Inert markers exercise redaction even without a valid credential or PEM block.
  const sensitive = [`API_KEY="${secret} with spaces"`, `https://user:${secret}@example.org/?token=tiny`,
    `PRIVATE KEY:\n${secret}`, 'ghp_fixture', 'Authorization: Basic fixture', `PASSWORD: |\n  ${secret}`,
    `Authorization: Digest username="fixture", response="${secret}"`, `API_KEY="fixture\n${secret}"`];
  for (const sample of sensitive) assert.equal(sanitizeExcerpt(sample), '[redacted]');
  assert.equal(sanitizeExcerpt(`bad token=${secret} on line 8\n    at src/foo:8`),
    'bad [redacted] on line 8\n    at src/foo:8');
  const path = 'src/' + 'very-long-directory/'.repeat(4) + 'unit.mjs';
  const context = [sha, path, '-'.repeat(64), '='.repeat(64)].join('\n');
  assert.equal(sanitizeExcerpt(`${context}\nerror ghp_fixture in ${path}\nmore context`),
    `${context}\nerror [redacted] in ${path}\nmore context`);
  const raw = ['\u001b[31merror\u001b[0m', ...sensitive, '界'.repeat(2000)].join('\n');
  assert.equal(Buffer.byteLength(sanitizeExcerpt('x' + '界'.repeat(1000))), 1024);
  assert.equal(Buffer.byteLength(sanitizeExcerpt('界'.repeat(1000))), 1023);
  const excerpt = sanitizeExcerpt(raw);
  assert.match(excerpt, /error/);
  assert.doesNotMatch(excerpt, /do-not-publish|fixture|PRIVATE KEY|\x1b|\ufffd/);
  assert.ok(Buffer.byteLength(excerpt) <= 1024);
});

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'ci-healer-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'control'), { mode: 0o700 });
  const killSwitch = join(dir, 'control', 'switch');
  await writeFile(killSwitch, 'run\n', { mode: 0o600 });
  const p = { repo_id: 'demo', channel: 'demo-ci', state: join(dir, 'state'), worktree: join(dir, 'slot'), policy: join(dir, 'policy') };
  const policy = p.policyData = { scope: 'pilot', boardUrl: 'http://127.0.0.1:44481/api/board', channel: p.channel,
    owner: 'repairer', label: { key: 'queue', value: 'repair' }, route: { repoId: p.repo_id, checkProfile: 'unit', finish: 'verified' },
    policyDigest: 'a'.repeat(64), pilot: { enabled: true, killSwitch }, handoffDir: join(dir, 'inbox'),
    ciHealer: { githubRepo: 'acme/demo', branch, allowedPaths: 'src/,tests/' } };
  const pin = async () => writeFile(p.policy, p.bytes = JSON.stringify(policy));
  await pin();
  const state = { checks: [check('unit')], statuses: [], builds: [], sha, protected: false, posts: new Map(), writes: [] };
  const fetchImpl = async (input, opts) => {
    const u = new URL(input);
    const json = (value, status = 200) => Response.json(value, { status });
    if (u.hostname === 'api.github.com') {
      assert.equal(opts.method ?? 'GET', 'GET');
      assert.equal(opts.headers.authorization, 'Bearer github-only');
      if (u.pathname === '/repos/acme/demo') return json({ default_branch: 'trunk' });
      if (decodeURIComponent(u.pathname) === `/repos/acme/demo/branches/${policy.ciHealer.branch}`) {
        return json({ name: policy.ciHealer.branch, commit: { sha: state.sha }, protected: state.protected });
      }
      if (u.pathname === '/repos/acme/demo/check-runs/17/annotations') return json([
        { annotation_level: 'failure', message: `AssertionError: expected 2\nPassword=${secret}` }]);
      if (u.pathname.endsWith(`/${state.sha}/check-runs`)) return json({ check_runs: state.checks });
      if (u.pathname.endsWith(`/${state.sha}/status`)) return json({ sha: state.sha, statuses: state.statuses });
    }
    if (u.hostname === 'cloudbuild.googleapis.com') {
      assert.equal(opts.method ?? 'GET', 'GET');
      assert.equal(opts.headers.authorization, 'Bearer google-only');
      assert.equal(u.pathname, '/v1/projects/demo/locations/global/builds');
      return json({ builds: state.builds });
    }
    assert.equal(u.origin, 'http://127.0.0.1:44481');
    assert.equal(opts.headers.authorization, 'Bearer board-only');
    assert.equal(opts.headers['x-board-can'], `${p.channel}=read,post,label`);
    if (u.pathname.startsWith('/api/board/posts/')) {
      const msg = state.posts.get(u.pathname.split('/').at(-1));
      return msg ? json({ message: msg }) : json({ error: { code: 'post_not_found' } }, 404);
    }
    assert.equal(opts.method, 'POST');
    const task = u.pathname === '/api/board/tasks';
    assert.ok(task || u.pathname === '/api/board/messages');
    const card = JSON.parse(opts.body);
    assert.equal(card.channel, p.channel);
    assert.equal(card.noSync, true);
    // Board caller-supplied post IDs are atomic, including replay after a lost reply.
    if (!state.posts.has(card.id)) {
      state.writes.push(card);
      state.posts.set(card.id, { ...card, ...(task && { task: { state: 'ready', owner: policy.owner } }) });
    }
    if (state.loseReply) { state.loseReply = false; throw Error('lost reply'); }
    return json({ [task ? 'task' : 'message']: state.posts.get(card.id) });
  };
  const heal = () => healProject(p, { fetchImpl, env: { BOARD_TOKEN: 'board-only', GH_TOKEN: 'github-only', GOOGLE_OAUTH_ACCESS_TOKEN: 'google-only' } });
  return { p, state, policy, pin, heal };
}

test('dispatcher enqueues one bounded card; changing logs or losing the Board reply cannot replay it', async t => {
  const { p, state, heal } = await fixture(t);
  state.checks[0].name = `unit github-only ${'long '.repeat(200)}`;
  state.checks[0].output.summary = `TypeError: ${'界'.repeat(5000)}\nAuthorization: Bearer ${secret}`;
  state.loseReply = true;
  const errors = []; let polls = 0;
  const d = createDispatcher({ projects: [p], ciHealer: heal, poll: () => { polls++; return false; },
    resources: () => ({ availableMemoryBytes: 0, cpuCount: 1 }), launch: assert.fail, onError: (_, e) => errors.push(e) });
  await d.tick(); state.checks[0].output.summary = 'different excerpt'; await d.tick();
  assert.equal(errors.length, 1); assert.equal(polls, 2);
  assert.equal(state.writes.length, 1);
  const [card] = state.writes;
  assert.match(card.text, /TypeError/); assert.match(card.text, /feat\/one/); assert.match(card.text, /unit/);
  assert.match(card.text, new RegExp(sha)); assert.ok(Buffer.byteLength(card.text) <= 2048);
  assert.ok(!JSON.stringify(card).includes(secret)); assert.ok(!card.text.includes('github-only'));
  assert.equal(card.for, undefined);
  assert.equal(card.labels.expected_base_sha, sha);
  assert.equal(card.labels.allowed_paths, 'src/,tests/'); assert.equal(card.labels.repo_id, 'demo');
});

test('two distinct tuples per SHA across branches and racing healers, then one non-runnable operator hold', async t => {
  const { state, policy, pin, heal } = await fixture(t);
  await Promise.all([heal(), heal()]);
  policy.ciHealer.branch = 'fix/two'; await pin();
  await heal(); state.checks.push(check('lint'), check('typecheck')); await heal(); await heal();
  assert.equal(state.writes.length, 3); assert.match(state.writes[2].text, /operator hold/i);
  assert.ok(state.writes.every(card => /^[A-Za-z0-9_-]{1,64}$/.test(card.id)));
  const repairs = [...state.posts.values()].filter(m => m.task);
  assert.equal(repairs.length, 2);
  assert.ok(repairs.every(card => boardId(card.id)));
  state.sha = '4'.repeat(40); state.checks = [check('unit', state.sha)]; await heal();
  assert.equal(state.writes.length, 4);
});

test('only terminal failures at the enrolled unprotected head; GitHub status and native Cloud Build', async t => {
  const { state, policy, pin, heal } = await fixture(t);
  state.protected = true; await heal(); state.protected = false;
  for (const name of ['main', 'master', 'trunk']) { policy.ciHealer.branch = name; await pin(); await heal(); }
  assert.equal(state.posts.size, 0);
  policy.ciHealer.branch = branch;
  policy.ciHealer.cloudBuild = { project: 'demo', location: 'global', triggerId: 'trigger-1' }; await pin();
  state.checks = [check('stale', '0'.repeat(40)), { ...check('pending'), status: 'queued' }, { ...check('ok'), conclusion: 'success' }];
  state.statuses = [{ context: 'Google Cloud Build', state: 'failure', description: 'compile failed' }];
  const build = { buildTriggerId: 'trigger-1', status: 'FAILURE', substitutions: { BRANCH_NAME: branch, COMMIT_SHA: sha },
    failureInfo: { detail: 'image build failed' } };
  state.builds = [{ ...build, buildTriggerId: 'foreign' }]; await heal();
  assert.equal(state.posts.size, 1); assert.match(state.writes[0].text, /compile failed/);
  state.builds = [{ ...build, status: 'SUCCESS' }, build]; await heal(); assert.equal(state.posts.size, 1);
  state.builds = [build]; await heal();
  assert.equal(state.posts.size, 2); assert.match(state.writes[1].text, /image build failed/);
});

test('reads a failure annotation when GitHub Actions omits the check summary', async t => {
  const { state, heal } = await fixture(t);
  state.checks = [{ ...check('actions'), id: 17, output: { annotations_count: 1, annotations_url: 'https://unused.invalid' } }];
  await heal();
  assert.match(state.writes[0].text, /AssertionError: expected 2/); assert.ok(!state.writes[0].text.includes(secret));
});

test('invalid Board capability channel is rejected before any provider call', async t => {
  const { p, policy, pin } = await fixture(t);
  p.channel = policy.channel = 'ci;other=post'; await pin();
  await assert.rejects(healProject(p, { fetchImpl: assert.fail }), /invalid_board_channel/);
});

test('opt-in policy, scope and kill switch are checked before any write', async t => {
  await healProject({ repo_id: 'unenrolled' }, { fetchImpl: assert.fail });
  const { state, p, policy, pin, heal } = await fixture(t);
  await writeFile(p.policy, '{}'); await assert.rejects(heal(), /policy_changed/);
  policy.ciHealer.allowedPaths = ''; await pin(); await assert.rejects(heal(), /scope_required/);
  policy.ciHealer.allowedPaths = 'src/'; await pin(); await writeFile(policy.pilot.killSwitch, 'stop\n');
  await assert.rejects(heal(), /pilot_stopped/); assert.equal(state.posts.size, 0);
});
