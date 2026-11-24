import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBbStageObserver, matchesNativeStageWitness, pilotWriterWorkspaceReady,
  verifyBbStageTurn, writerWorkspaceReady } from './bb-stage-adapter.mjs';
import { createAttemptSignals } from './signals.mjs';
import { abEffectGuard, enrollAbPilot, foremanArtifacts, guardAbBoard, inspectPilotDiff, pilotArtifacts, CASES } from './ab-pilot.mjs';
import { resolveArbitration } from './worker-selector.mjs';

const parentThread = 'thr_parent';
const threadId = 'thr_fixture';
const project = 'proj_fixture';
const provider = 'pi';
const model = 'opencode-go/deepseek-v4.1-flash';
const challenge = 'a'.repeat(64);
function trace(workspace, nonce = challenge) {
  const snapshot = { thread: { id: threadId, parentThreadId: parentThread, projectId: project, providerId: provider,
    status: 'idle', activeBackgroundAgentCount: 0, queuedMessageCount: 0 }, environment: { path: workspace } };
  const event = (seq, type, data) => ({ threadId, seq, type, data, scope: { turnId: 't1' } });
  const providerThreadId = 'pid-1';
  const events = [event(1, 'client/turn/requested', { execution: { model, permissionMode: 'accept-edits' },
    input: [{ type: 'text', text: `Challenge: ${nonce}` }] }),
    event(2, 'thread/identity', { providerThreadId }),
    event(3, 'turn/started', { providerThreadId }),
    event(4, 'item/completed', { providerThreadId, item: { type: 'agentMessage', text: `${nonce} PASS` } }),
    event(5, 'turn/completed', { providerThreadId, providerCheckpointId: 'checkpoint-1', status: 'completed' })];
  return { snapshot, events, threadId, workspace, parentThread, project, provider, model, reasoning: null, challenge: nonce,
    promptText: `Challenge: ${nonce}` };
}

test('native stage proof binds only the single requested turn and rejects foreign/model/tool evidence', () => {
  const valid = trace('/isolated');
  assert.deepEqual(verifyBbStageTurn(valid), { verdict: 'PASS', eventSeq: 5, checkpoint: 'checkpoint-1', session: 'pid-1' });
  const noCheckpoint = structuredClone(valid);
  delete noCheckpoint.events[4].data.providerCheckpointId;
  assert.throws(() => verifyBbStageTurn(noCheckpoint), /stage_turn_unconfirmed/);
  const noStart = { ...valid, events: valid.events.filter(event => event.type !== 'turn/started') };
  assert.throws(() => verifyBbStageTurn(noStart), /stage_turn_unconfirmed/);
  assert.throws(() => verifyBbStageTurn({ ...valid, parentThread: 'thr_other' }), /stage_bb_unconfirmed/);
  assert.throws(() => verifyBbStageTurn({ ...valid, model: 'another-model' }), /stage_turn_unconfirmed/);
  assert.throws(() => verifyBbStageTurn({ ...valid, promptText: `Changed artifact. Challenge: ${challenge}` }), /stage_turn_unconfirmed/);
  assert.throws(() => verifyBbStageTurn({ ...valid, events: valid.events.slice(0, 2) }), /stage_turn_unconfirmed/);
  const tool = structuredClone(valid);
  tool.events[3].data.item.type = 'commandExecution';
  assert.throws(() => verifyBbStageTurn(tool), /stage_unexpected_tool_use/);
  const badNonce = structuredClone(valid);
  badNonce.events[3].data.item.text = 'b'.repeat(64) + ' PASS';
  assert.throws(() => verifyBbStageTurn(badNonce), /stage_verdict_unconfirmed/);
});

test('a shaped but different stage witness cannot cover native usage', () => {
  const native = { session: 'p', checkpoint: 'checkpoint-live', eventSeq: 137 };
  assert.equal(matchesNativeStageWitness({ ...native }, native), true);
  for (const modified of [{ session: 'other' }, { checkpoint: 'other' }, { eventSeq: 138 }]) {
    assert.equal(matchesNativeStageWitness({ ...native, ...modified }, native), false);
  }
  assert.equal(matchesNativeStageWitness(native, null), false);
});

test('the same attempt effect guard rejects arbitration after the cutoff', async () => {
  let renews = 0, effects = 0;
  const expired = { assertOpen() { throw new Error('ab_pilot_dispatch_deadline'); } };
  const guard = abEffectGuard(expired, {
    verifyHeld: () => { renews++; return { epoch: 1 }; }, assertPinned: () => {},
  }, '1', 1);
  const arbitrate = async () => { await guard(); effects++; };
  await assert.rejects(arbitrate(), /ab_pilot_dispatch_deadline/);
  assert.equal(renews, 0);
  assert.equal(effects, 0);
});

test('native arbitration resolver cannot renew or invoke the reviewer after pilot cutoff', async () => {
  let renews = 0, reviews = 0, blocks = 0;
  const board = guardAbBoard({ assertOpen() { throw new Error('ab_pilot_dispatch_deadline'); } }, {
    verifyHeld() { renews++; return { epoch: 1 }; },
    block() { blocks++; },
  });
  const result = await resolveArbitration({
    attempt: { task_id: '1', epoch: 1, attempt_id: 'attempt-1' },
    trigger: { trigger: 'no_progress' }, subjectDigest: 'a'.repeat(64),
    verifyHeld: board.verifyHeld, arbitrate: () => { reviews++; },
  });
  assert.equal(result.reason, 'lease_lost_before_arbitration');
  await assert.rejects(board.block('1', 1, 'red'), /ab_pilot_dispatch_deadline/);
  assert.deepEqual([renews, reviews, blocks], [0, 0, 0]);
});

test('writer provision is wait-only; wrong ready environment or parent stays denied', () => {
  const desired = trace('/isolated');
  const starting = { thread: { ...desired.snapshot.thread, status: 'starting' }, environment: null };
  assert.equal(pilotWriterWorkspaceReady(starting, desired), false);
  assert.equal(pilotWriterWorkspaceReady(desired.snapshot, desired), true);
  assert.throws(() => pilotWriterWorkspaceReady({ ...starting, environment: { path: '/other' } }, desired), /workspace changed/);
  assert.throws(() => pilotWriterWorkspaceReady({ ...starting, thread: { ...starting.thread, parentThreadId: 'thr_other' } }, desired),
    /ab_pilot_writer_identity_drift/);
});

test('observer binds embedded skill and host artifact to one operator-parented spawn, no repeat', async t => {
  const root = await mkdtemp(join(tmpdir(), 'df-ab-stage-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'observer'), journal = join(root, 'journal');
  await mkdir(workspace, { mode: 0o700 });
  await mkdir(journal, { mode: 0o700 });
  let current, spawnCalls = 0;
  const tracked = [], witnesses = [];
  const artifact = Buffer.from(JSON.stringify({ type: 'inventory', inventory: 'a'.repeat(64), items: 1, unresolved: 0 }));
  const execBb = async argv => {
    let result = {};
    if (argv[1] === 'spawn') {
      spawnCalls++;
      assert.equal(argv[argv.indexOf('--parent-thread') + 1], parentThread);
      assert.equal(argv[argv.indexOf('--environment') + 1], workspace);
      assert.equal(argv[argv.indexOf('--permission-mode') + 1], 'accept-edits');
      const prompt = await readFile(argv[argv.indexOf('--prompt-file') + 1], 'utf8');
      assert.match(prompt, /Embedded fixture skill/);
      assert.ok(prompt.includes(artifact.toString()));
      current = trace(workspace, /Challenge: ([a-f0-9]{64})/.exec(prompt)[1]);
      current.events[0].data.input[0].text = prompt;
      result = { id: threadId };
    } else if (argv[1] === 'show') result = current.snapshot;
    else if (argv[1] === 'log') result = current.events;
    return { stdout: JSON.stringify(result) };
  };
  const ports = { assertCurrent() {}, readArtifact: () => ({ artifact, material: 'Measured facts' }),
    record: row => tracked.push(row), recordWitness: row => witnesses.push(row), execBb };
  const settings = { workspace, project, journal, parentThread, deadline: Date.now() + 60_000 };
  const unapproved = await createBbStageObserver(settings, ports);
  const observe = await createBbStageObserver(settings, { ...ports, assertReadOnly: () => true });
  const req = { stage: 'intake', role: 'materials-reader', verifier: 'inventory', playbook: 'policy',
    registryDigest: 'a'.repeat(64), inputArtifactDigest: null,
    model: { provider, model, reasoning: null },
    binding: { task_id: '1', candidate_sha: 'a'.repeat(40), subject_digest: 'b'.repeat(64) },
    skills: [{ text: 'Embedded fixture skill' }] };
  await assert.rejects(unapproved(req), /stage_read_only_transport_not_enrolled/);
  assert.equal(spawnCalls, 0);
  const got = await observe(req);
  assert.equal(got.verdict, 'PASS');
  assert.ok(got.artifact.equals(artifact));
  assert.equal(tracked[0].threadId, threadId);
  assert.equal(witnesses[0].checkpoint, 'checkpoint-1');
  assert.equal(witnesses[0].artifactDigest, got.artifactDigest);
  await assert.rejects(observe(req), /stage_intent_already_exists/);
  assert.equal(spawnCalls, 1);
});

test('role artifacts require verified L1 evidence on the same Git candidate', () => {
  const candidate = 'a'.repeat(40);
  const args = { candidate, diff: { diffDigest: 'e'.repeat(64), files: CASES.policy.files },
    brief: 'Frozen task', review: 'Frozen independent check',
    localEvidence: { ok: true, sha: candidate, evidence: [{ exit: 0, sha256: 'f'.repeat(64) }] } };
  assert.throws(() => pilotArtifacts({ ...args, localEvidence: null }), /ab_pilot_l1_unconfirmed/);
  assert.throws(() => pilotArtifacts({ ...args, localEvidence: { ...args.localEvidence, sha: 'b'.repeat(40) } }), /ab_pilot_l1_unconfirmed/);
  const read = pilotArtifacts(args);
  const { artifact, material } = read({ verifier: 'change-set' });
  assert.match(material, /Frozen independent check/);
  assert.deepEqual(JSON.parse(artifact), {
    type: 'change-set', diff: 'e'.repeat(64), changed: 2, failedChecks: 0,
  });
  assert.throws(() => read({ verifier: 'visual-report' }), /ab_pilot_artifact_not_available/);
});

test('retired or non-DeepSeek model cannot launch and out-of-scope pilot cannot opt in', async t => {
  const root = await mkdtemp(join(tmpdir(), 'df-ab-deny-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'observer'), journal = join(root, 'journal');
  await mkdir(workspace, { mode: 0o700 });
  await mkdir(journal, { mode: 0o700 });
  const unexpected = () => assert.fail('unexpected effect');
  const observe = await createBbStageObserver({ workspace, project, journal, parentThread, deadline: Date.now() + 60_000 }, {
    assertCurrent() {}, readArtifact: unexpected, record: unexpected, recordWitness: unexpected, execBb: unexpected,
  });
  await assert.rejects(observe({ model: { provider: 'pi', model: 'opencode-go/other' } }), /stage_model_denied/);
  await assert.rejects(enrollAbPilot({ arm: 'linear', case: 'policy', parent: parentThread }, {
    parent: parentThread, policy: { scope: 'pilot', channel: 'pilot' },
  }), /ab_pilot_scope_denied/);
  assert.equal(await enrollAbPilot(undefined, {}), null);
  const git = (...args) => args.includes('--name-status') ? CASES.policy.files.map(name => `A\0${name}\0`).join('') : 'diff';
  assert.equal((await inspectPilotDiff({ case: 'policy' }, { git, base: 'x', candidate: 'y' })).files.length, 2);
  await assert.rejects(inspectPilotDiff({ case: 'policy' }, { git: () => 'A\0outside.mjs\0', base: 'x', candidate: 'y' }),
    /ab_pilot_diff_out_of_scope/);
  await assert.rejects(inspectPilotDiff({ case: 'policy' }, { git: () => `M\0${CASES.policy.files[0]}\0A\0${CASES.policy.files[1]}\0`,
    base: 'x', candidate: 'y' }), /ab_pilot_diff_out_of_scope/);
});

test('writerWorkspaceReady: общий путь без parentThread — тот же grace starting->ready', () => {
  const desired = trace('/isolated');
  const args = { threadId, project, workspace: '/isolated' };
  const starting = { thread: { ...desired.snapshot.thread, status: 'starting' }, environment: null };
  assert.equal(writerWorkspaceReady(starting, args), false);
  assert.equal(writerWorkspaceReady(desired.snapshot, args), true);
  assert.throws(() => writerWorkspaceReady({ ...starting, environment: { path: '/other' } }, args),
    /BB workspace changed/);
  assert.throws(() => writerWorkspaceReady({ ...starting, thread: { ...starting.thread, id: 'thr_other' } }, args),
    /writer_identity_drift/);
  assert.throws(() => writerWorkspaceReady(
    { ...starting, thread: { ...starting.thread, parentThreadId: 'thr_other' } },
    { ...args, parentThread }), /writer_identity_drift/);
});

test('observer идёт через аттестованный sandbox-транспорт и пишет stage_witness, bb spawn не вызывается', async t => {
  const root = await mkdtemp(join(tmpdir(), 'df-stage-sandbox-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'observer'), journal = join(root, 'journal');
  await mkdir(workspace, { mode: 0o700 });
  await mkdir(journal, { mode: 0o700 });
  const witnesses = [];
  const observed = [];
  const artifact = Buffer.from(JSON.stringify({ type: 'inventory', inventory: 'a'.repeat(64), items: 1, unresolved: 0 }));
  const transport = {
    async assertReadOnly(model) { assert.equal(model.model, 'gpt-6.2-sol'); return true; },
    async observe(req) {
      observed.push(req);
      assert.equal(req.artifactDigest.length, 64);
      assert.match(req.prompt, new RegExp(`Challenge: ${req.challenge}`));
      return { verdict: 'PASS', transcript_file: null, witness: {
        mode: 'read-only', transport: 'docker-ro-v1', snapshotDigest: 'c'.repeat(64),
        worktreeFingerprint: { head: 'a'.repeat(40) }, challenge: req.challenge, verdict: 'PASS',
        artifactDigest: req.artifactDigest, transcript_sha256: 'e'.repeat(64), checkpoint: 'feed80ab',
        actual: { provider: 'openai', model: 'gpt-6.2-sol', reasoningLevel: 'medium' } } };
    },
  };
  const tracked = [];
  const observer = await createBbStageObserver({ workspace, project, journal,
    parentThread: undefined, deadline: Date.now() + 60_000 }, {
    assertCurrent() {}, readArtifact: () => ({ artifact, material: 'Measured facts' }),
    record: row => tracked.push(row), recordWitness: row => witnesses.push(row),
    execBb: async () => assert.fail('host bb spawn запрещён в sandbox-пути'),
    sandboxTransport: transport,
  });
  const req = { stage: 'intake', role: 'materials-reader', verifier: 'inventory', playbook: 'policy',
    registryDigest: 'a'.repeat(64), inputArtifactDigest: null,
    model: { provider: 'openai', model: 'gpt-6.2-sol', reasoning: null },
    binding: { task_id: '1', candidate_sha: 'a'.repeat(40), subject_digest: 'b'.repeat(64) },
    skills: [{ text: 'Embedded fixture skill' }] };
  const got = await observer(req);
  assert.equal(got.verdict, 'PASS');
  assert.equal(got.witness.transport, 'docker-ro-v1');
  assert.equal(witnesses[0].mode, 'read-only');
  assert.equal(witnesses[0].threadId, 'sandbox:docker-ro-v1');
  assert.equal(witnesses[0].challenge, observed[0].challenge);
});

test('без аттестованного assertReadOnly остаётся fail-closed stage_read_only_transport_not_enrolled', async t => {
  const root = await mkdtemp(join(tmpdir(), 'df-stage-deny-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'observer'), journal = join(root, 'journal');
  await mkdir(workspace, { mode: 0o700 });
  await mkdir(journal, { mode: 0o700 });
  const unexpected = () => assert.fail('не должно быть дочернего вызова');
  const observer = await createBbStageObserver({ workspace, project, journal,
    deadline: Date.now() + 60_000 }, {
    assertCurrent() {}, readArtifact: () => ({ artifact: Buffer.from(JSON.stringify(
      { type: 'inventory', inventory: 'a'.repeat(64), items: 1, unresolved: 0 })), material: 'm' }),
    record: unexpected, recordWitness: unexpected, execBb: unexpected,
    sandboxTransport: { assertReadOnly: async () => false, observe: unexpected },
  });
  const req = { stage: 'intake', role: 'r', verifier: 'inventory', registryDigest: 'a'.repeat(64),
    model: { provider: 'openai', model: 'gpt-6.2-sol', reasoning: null },
    binding: { task_id: '1', candidate_sha: 'a'.repeat(40), subject_digest: 'b'.repeat(64) },
    skills: [{ text: 's' }] };
  await assert.rejects(observer(req), /stage_read_only_transport_not_enrolled/);
});

test('phase-aware deadline: исчерпанный бюджет stages отклоняет наблюдение до транспорта', async t => {
  const root = await mkdtemp(join(tmpdir(), 'df-stage-phase-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'observer'), journal = join(root, 'journal');
  await mkdir(workspace, { mode: 0o700 });
  await mkdir(journal, { mode: 0o700 });
  const artifact = Buffer.from(JSON.stringify({ type: 'inventory', inventory: 'a'.repeat(64), items: 1, unresolved: 0 }));
  const unexpected = () => assert.fail('transport не должен вызываться');
  const observer = await createBbStageObserver({ workspace, project, journal,
    deadline: Date.now() + 60_000 }, {
    assertCurrent() {}, readArtifact: () => ({ artifact, material: 'm' }),
    record: unexpected, recordWitness: unexpected, execBb: unexpected,
    sandboxTransport: { assertReadOnly: async () => true, observe: unexpected },
    phaseBudget: { remaining: () => 0 },
  });
  const req = { stage: 'intake', role: 'r', verifier: 'inventory', registryDigest: 'a'.repeat(64),
    model: { provider: 'openai', model: 'gpt-6.2-sol', reasoning: null },
    binding: { task_id: '1', candidate_sha: 'a'.repeat(40), subject_digest: 'b'.repeat(64) },
    skills: [{ text: 's' }] };
  await assert.rejects(observer(req), /phase_deadline_exceeded:stages/);
});

test('cleanup при abort/timeout: thread stop идёт даже при сбое промежуточного thread show', async t => {
  const root = await mkdtemp(join(tmpdir(), 'df-stage-stop-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'observer'), journal = join(root, 'journal');
  await mkdir(workspace, { mode: 0o700 });
  await mkdir(journal, { mode: 0o700 });
  let stopped = 0;
  const artifact = Buffer.from(JSON.stringify({ type: 'inventory', inventory: 'a'.repeat(64), items: 1, unresolved: 0 }));
  const execBb = async argv => {
    if (argv[1] === 'spawn') return { stdout: JSON.stringify({ id: threadId }) };
    if (argv[1] === 'wait') throw new Error('lost transport');
    if (argv[1] === 'show') throw new Error('show unavailable');
    if (argv[1] === 'stop') { stopped++; return { stdout: '{}' }; }
    return { stdout: '{}' };
  };
  const observer = await createBbStageObserver({ workspace, project, journal, parentThread,
    deadline: Date.now() + 60_000 }, {
    assertCurrent() {}, assertReadOnly: () => true,
    readArtifact: () => ({ artifact, material: 'm' }), record: () => {}, recordWitness: () => {}, execBb });
  const req = { stage: 'intake', role: 'r', verifier: 'inventory', registryDigest: 'a'.repeat(64),
    model: { provider, model, reasoning: null },
    binding: { task_id: '1', candidate_sha: 'a'.repeat(40), subject_digest: 'b'.repeat(64) },
    skills: [{ text: 's' }] };
  await assert.rejects(observer(req), /stage_wait_unconfirmed/);
  assert.equal(stopped, 1, 'подтверждённый дочерний тред обязан быть остановлен');
});

test('sandbox-путь без phaseBudgets: signals без бюджетов не ломает наблюдение', async t => {
  const root = await mkdtemp(join(tmpdir(), 'df-stage-nobudget-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'observer'), journal = join(root, 'journal');
  await mkdir(workspace, { mode: 0o700 });
  await mkdir(journal, { mode: 0o700 });
  const artifact = Buffer.from(JSON.stringify({ type: 'inventory', inventory: 'a'.repeat(64), items: 1, unresolved: 0 }));
  const signals = createAttemptSignals({ deadline: Date.now() + 60_000 });
  const observer = await createBbStageObserver({ workspace, project, journal,
    deadline: Date.now() + 60_000 }, {
    assertCurrent() {}, readArtifact: () => ({ artifact, material: 'm' }),
    record: () => {}, recordWitness: () => {},
    execBb: async () => assert.fail('host bb spawn запрещён'),
    sandboxTransport: { assertReadOnly: async () => true,
      async observe(req) { return { verdict: 'PASS', transcript_file: null, witness: {
        mode: 'read-only', transport: 'docker-ro-v1', snapshotDigest: 'c'.repeat(64),
        worktreeFingerprint: {}, challenge: req.challenge, verdict: 'PASS',
        artifactDigest: req.artifactDigest, transcript_sha256: 'e'.repeat(64), checkpoint: 'feed80ab',
        actual: { provider: 'openai', model: 'gpt-6.2-sol', reasoningLevel: 'medium' } } }; } },
    signals,
  });
  const req = { stage: 'intake', role: 'r', verifier: 'inventory', registryDigest: 'a'.repeat(64),
    playbook: 'p', model: { provider: 'openai', model: 'gpt-6.2-sol', reasoning: null },
    binding: { task_id: '1', candidate_sha: 'a'.repeat(40), subject_digest: 'b'.repeat(64) },
    skills: [{ text: 's' }] };
  const got = await observer(req);
  assert.equal(got.verdict, 'PASS', 'без phaseBudgets — maxSeconds и общий deadline');
  signals.dispose();
});

test('сбой record() после подтверждённого spawn останавливает дочерний тред', async t => {
  const root = await mkdtemp(join(tmpdir(), 'df-stage-recstop-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'observer'), journal = join(root, 'journal');
  await mkdir(workspace, { mode: 0o700 });
  await mkdir(journal, { mode: 0o700 });
  let stopped = 0;
  const artifact = Buffer.from(JSON.stringify({ type: 'inventory', inventory: 'a'.repeat(64), items: 1, unresolved: 0 }));
  const execBb = async argv => {
    if (argv[1] === 'spawn') return { stdout: JSON.stringify({ id: threadId }) };
    if (argv[1] === 'show') throw new Error('show unavailable');
    if (argv[1] === 'stop') { stopped++; return { stdout: '{}' }; }
    return { stdout: '{}' };
  };
  const observer = await createBbStageObserver({ workspace, project, journal, parentThread,
    deadline: Date.now() + 60_000 }, {
    assertCurrent() {}, assertReadOnly: () => true,
    readArtifact: () => ({ artifact, material: 'm' }),
    record: async () => { throw new Error('ENOSPC'); },
    recordWitness: () => {}, execBb });
  const req = { stage: 'intake', role: 'r', verifier: 'inventory', registryDigest: 'a'.repeat(64),
    model: { provider, model, reasoning: null },
    binding: { task_id: '1', candidate_sha: 'a'.repeat(40), subject_digest: 'b'.repeat(64) },
    skills: [{ text: 's' }] };
  await assert.rejects(observer(req), /ENOSPC/);
  assert.equal(stopped, 1, 'дочерний тред обязан быть остановлен при сбое record');
});

test('foremanArtifacts: inventory измеряется из дерева кандидата, прочие verifier — fail-closed', async () => {
  const candidate = 'a'.repeat(40);
  const files = ['src/a.mjs', 'src/b.mjs'];
  const git = async (...args) => args[0] === 'ls-tree' ? files.join('\n') : 'x';
  const args = { candidate,
    diff: { diffDigest: 'e'.repeat(64), files: ['src/a.mjs', 'src/b.mjs'] },
    brief: 'Frozen task', review: 'Frozen check',
    localEvidence: { ok: true, sha: candidate, evidence: [{ exit: 0, sha256: 'f'.repeat(64) }] },
    git };
  const read = foremanArtifacts(args);
  const { artifact, material } = await read({ verifier: 'inventory' });
  const inv = JSON.parse(artifact);
  assert.equal(inv.type, 'inventory');
  assert.equal(inv.items, 2);
  assert.equal(inv.unresolved, 0);
  assert.match(inv.inventory, /^[a-f0-9]{64}$/);
  assert.match(material, /src\/a\.mjs/);
  // Расхождение доказанного diff и листинга — измеряемый unresolved → REWORK.
  const drifted = foremanArtifacts({ ...args,
    diff: { diffDigest: 'e'.repeat(64), files: ['src/a.mjs', 'src/missing.mjs'] } });
  assert.equal(JSON.parse((await drifted({ verifier: 'inventory' })).artifact).unresolved, 1);
  // change-set делегируется pilotArtifacts (тот же гейт L1); прочие — отказ.
  assert.deepEqual(JSON.parse((await read({ verifier: 'change-set' })).artifact).type, 'change-set');
  await assert.rejects(read({ verifier: 'course-outline' }), /ab_pilot_artifact_not_available/);
});
