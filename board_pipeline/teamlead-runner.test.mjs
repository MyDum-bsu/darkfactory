import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDispatcher } from './dispatcher.mjs';
import { resolveIntakeMode } from './field-mode.mjs';
import { queueModeSpecInputs } from './run-transport.mjs';
import { watchProjectRequests } from './teamlead-runner.mjs';
import { openUnifiedLedger } from './unified-ledger.mjs';
import { buildReviewInstruction } from './review-policy.mjs';

const quote = '  Сохранить API.\r\nDo not deploy.  \n';
const request = { verbatim_request_id: '51', verbatim_owner_quote: quote };
const binding = { task_id: '52', candidate_sha: 'a'.repeat(40) };

test('L2 checks the exact owner words in both full and diff-scoped review', () => {
  for (const round of [1, 2]) {
    const prompt = buildReviewInstruction({ binding, card: request, round, prompt: 'Lead summary' });
    assert.ok(prompt.includes('Verbatim Owner Request'));
    assert.ok(prompt.includes(quote));
    assert.match(prompt, /verbatim_request_id: 51/);
    assert.ok(!buildReviewInstruction({ binding, round, prompt: 'legacy' }).includes('Verbatim Owner Request'));
    assert.throws(() => buildReviewInstruction({ binding, card: { verbatim_request_id: '51' } }), /verbatim_request_invalid/);
  }
});

const posted = message => ({ type: 'message.posted', message });
const owner = { id: '51', channel: 'demo/requests', re: null, by: { actor: 'owner' }, labels: {}, text: quote };
const split = { ...owner, id: '60', by: { actor: 'arbiter' }, text: 'Separate compatibility checks.',
  labels: { decision: 'SPLIT', verbatim_request_id: owner.id } };
const plan = { cards: [
  { key: 'build', text: 'Implement API', allowed_paths: 'src/api', needs: [] },
  { key: 'check', text: 'Check compatibility', allowed_paths: 'tests/api', needs: ['build'] },
] };

async function fixture(t, channel = 'writers') {
  const root = await mkdtemp(join(tmpdir(), 'df-managed-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo_dir = join(root, 'repo'), vault = join(root, 'private'), storeDir = join(vault, 'memory');
  await mkdir(repo_dir); await mkdir(storeDir, { recursive: true, mode: 0o700 });
  const docsPath = join(root, 'docs.json');
  await writeFile(docsPath, JSON.stringify({ 'herdr-app': { value: { spaces: [
    { name: 'Demo', folder: repo_dir, id: 'sp-demo' }, { name: 'Other', folder: root, id: 'sp-other' },
  ] } } }));
  const sqlitePath = join(vault, 'ledger.db');
  const ledger = openUnifiedLedger(sqlitePath);
  for (const [scope, decision] of [['project:demo', 'Preserve API'], ['project:other', 'Unrelated decision']]) {
    const p = ledger.proposeDecision({ scope, topic: 'API', decision, proposedBy: 'lead' });
    ledger.approveProposal(p.proposal_id, { approvedBy: 'owner' });
  }
  ledger.close();
  const killSwitch = join(root, 'switch');
  await writeFile(killSwitch, 'run\n', { mode: 0o600 });
  const policyData = { intake_mode: 'managed_dispatcher', channel, boardUrl: 'http://127.0.0.1:12345/api/board',
    pilot: { killSwitch }, teamlead: { owner_actor: 'owner', arbiter_actor: 'arbiter' }, route: { repoId: 'demo',
      checkProfile: 'checks', finish: 'verified' }, policyDigest: 'b'.repeat(64), label: { key: 'queue', value: 'dev' },
    decisionLedger: { sqlitePath }, projectMemory: { storeDir } };
  const project = { repo_id: 'demo', repo_dir, channel, herdr_space_name: 'Demo', policy: join(root, 'policy'),
    policyData, bytes: JSON.stringify(policyData) };
  await writeFile(project.policy, project.bytes);
  const batches = new Map(), launches = [], prompts = [];
  async function run(events, { result = plan, original = owner } = {}) {
    const stop = new AbortController();
    let sent = false;
    await watchProjectRequests(project, { docsPath, signal: stop.signal, execFile: async (command, argv) => {
      launches.push([command, argv]);
      prompts.push(await readFile(argv.at(-1).slice(1), 'utf8'));
      await writeFile(argv[argv.indexOf('-c') + 2], JSON.stringify(result));
      return { stdout: '' };
    }, fetchImpl: async (url, init) => {
      const { pathname, searchParams } = new URL(url);
      assert.equal(init.redirect, 'error');
      assert.equal(init.headers['x-board-can'], `demo/requests=read;${channel}=read,post,label`);
      if (pathname.endsWith('/events')) {
        assert.equal(searchParams.get('channel'), 'demo/requests');
        assert.equal(searchParams.get('after'), sent ? '70' : '0');
        if (sent) { stop.abort(); return Response.json({ events: [], cursor: '70' }); }
        sent = true; return Response.json({ events, cursor: '70' });
      }
      if (pathname.includes('/tasks/batch/')) {
        const batch = batches.get(pathname.split('/').at(-1));
        return batch ? Response.json({ tasks: batch.tasks.map(() => ({ channel: batch.channel })) }) :
          Response.json({ error: { code: 'batch_not_found' } }, { status: 404 });
      }
      if (pathname.endsWith('/messages/51')) return Response.json({ message: original });
      assert.equal(pathname, '/api/board/tasks/batch');
      assert.equal(init.method, 'POST');
      const batch = JSON.parse(init.body);
      assert.ok(!batches.has(batch.id)); batches.set(batch.id, batch);
      return Response.json({ tasks: batch.tasks.map(() => ({ channel: batch.channel })) });
    } });
  }
  return { project, run, batches, launches, prompts };
}

test('managed Board event → project-bound tool-less hc → atomic DAG → digest-verified L2 spec', async t => {
  const { project, run, batches, launches, prompts } = await fixture(t);
  await run([posted(owner), posted(owner)]);
  await run([posted(owner)]); // feed replay after restart
  assert.equal(launches.length, 1); assert.equal(batches.size, 1);
  const [[command, args]] = launches;
  assert.equal(command, 'hc'); assert.equal(args[0], 'run');
  assert.equal(args[args.indexOf('--cwd') + 1], project.repo_dir);
  assert.ok(args.includes('herdr.space=sp-demo'));
  assert.deepEqual(args.slice(args.indexOf('pi'), -1), ['pi', '--print', '--provider', 'google', '--model', 'gemini-4-neon',
    '--no-session', '--no-tools', '--no-mcp', '--no-extensions', '--no-skills', '--no-context-files', '--no-prompt-templates', '--no-approve', '--']);
  assert.ok(!args.join(' ').includes(quote));
  assert.ok(prompts[0].includes(quote)); assert.match(prompts[0], /Project memory \(read-only, slice digest/);
  assert.match(prompts[0], /Preserve API/); assert.doesNotMatch(prompts[0], /Unrelated decision/);
  const [batch] = batches.values();
  assert.equal(batch.channel, 'writers');
  assert.deepEqual(batch.tasks.map(c => c.needs), [[], [{ key: 'build' }]]);
  for (const card of batch.tasks) {
    assert.equal(card.labels.verbatim_request_id, '51');
    assert.equal(card.labels.spec_digest, createHash('sha256').update(card.text).digest('hex'));
    // Production queue transport has only text + spec_digest, not a request object.
    const { reviewSpec } = queueModeSpecInputs({ route: {}, attempt: { specText: card.text, spec_digest: card.labels.spec_digest },
      operatorBrief: 'implement', reviewSpec: 'verify' });
    for (const round of [1, 2]) {
      assert.ok(buildReviewInstruction({ binding, prompt: reviewSpec, round }).includes(quote));
      assert.ok(buildReviewInstruction({ binding, card, prompt: 'Lead summary only', round }).includes(quote));
      const labeled = { ...binding, labels: card.labels };
      assert.equal(buildReviewInstruction({ binding: labeled, prompt: reviewSpec, round }).split(quote).length, 2);
      assert.throws(() => buildReviewInstruction({ binding: labeled, prompt: 'Lead summary only', round }), /verbatim_request_invalid/);
    }
  }
});

test('unrelated events are inert; authenticated SPLIT resolves the owner root, not the arbiter paraphrase', async t => {
  const { run, batches, launches, prompts } = await fixture(t);
  await run([{ type: 'task.completed', message: owner }, posted({ ...owner, re: '1' }), posted({ ...owner, text: ' \n' }),
    posted({ ...owner, channel: 'other/requests' }), posted({ ...split, by: { actor: 'writer' } }),
    posted({ ...split, labels: {} })]);
  assert.equal(launches.length, 0);
  await assert.rejects(run([posted(split)], { original: { ...owner, channel: 'other/requests' } }), /verbatim_request_invalid/);
  assert.equal(launches.length, 0);
  await run([posted({ ...split, re: owner.id, labels: { decision: 'SPLIT' } })]);
  assert.ok(prompts[0].includes(split.text));
  for (const card of [...batches.values()][0].tasks) {
    assert.equal(card.labels.verbatim_request_id, owner.id); assert.ok(card.text.includes(quote));
    assert.ok(!card.text.includes(split.text));
  }
});

test('hierarchical task channel uses the fleet channel grammar for both grants', async t => {
  const { project, run, batches } = await fixture(t, 'optimization/tracker');
  await run([posted(owner)]);
  assert.equal([...batches.values()][0].channel, 'optimization/tracker');
  project.channel = project.policyData.channel = 'bad//path';
  await assert.rejects(run([]), /invalid_board_channel/);
  project.channel = project.policyData.channel = 'writers';
  project.repo_id = project.policyData.route.repoId = 'bad:repo';
  await assert.rejects(run([]), /invalid_board_channel/);
});

test('wrong Herdr Space is refused before hc; invalid model plans cannot publish', async t => {
  const { run, project, launches, batches } = await fixture(t);
  project.herdrSpaceId = 'sp-other';
  await assert.rejects(run([posted(owner)]), /herdr_space_mismatch/);
  assert.equal(launches.length, 0); assert.equal(batches.size, 0);
  delete project.herdrSpaceId;
  for (const result of [null, { cards: [] }, { cards: [{ ...plan.cards[0], needs: ['build'] }] },
    { cards: [{ ...plan.cards[0], labels: { repo_id: 'other' } }] }]) {
    await assert.rejects(run([posted(owner)], { result }), /teamlead_plan_invalid/);
  }
  await assert.rejects(run([posted({ ...owner, labels: { allowed_paths: 'src/' } })]), /teamlead_scope_invalid/);
  assert.equal(batches.size, 0);
});

test('direct_lead default does not subscribe; fleet starts one feed for each managed project and drains it', async () => {
  assert.equal(resolveIntakeMode(), 'direct_lead');
  for (const intake_mode of ['', null, 'manage']) assert.throws(() => resolveIntakeMode({ intake_mode }), /intake_mode_invalid/);
  await watchProjectRequests({ policyData: {} }, { fetchImpl: assert.fail, execFile: assert.fail });
  const starts = [], stops = [];
  const d = createDispatcher({ projects: [{ repo_id: 'one' }, { repo_id: 'two', policyData: { intake_mode: 'managed_dispatcher' } }],
    poll: () => false, launch: assert.fail, resources: () => ({ availableMemoryBytes: 0, cpuCount: 2 }),
    watchRequests: (p, { signal }) => new Promise(resolve => {
      starts.push(p.repo_id); signal.addEventListener('abort', () => { stops.push(p.repo_id); resolve(); }, { once: true });
    }) });
  await d.tick(); await d.tick(); await d.drain();
  assert.deepEqual(starts, ['two']); assert.deepEqual(stops, ['two']);
});
