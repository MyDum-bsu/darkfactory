import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openUnifiedLedger } from './unified-ledger.mjs';

function proposal(overrides = {}) {
  return {
    scope: 'global',
    topic: 'release policy',
    decision: 'release only on owner approval',
    rationale: 'owner gate is mandatory',
    applicability: 'all releases',
    proposedBy: 'cto',
    ...overrides,
  };
}

test('proposeDecision stays invisible to queryRelevantDecisions until approved', () => {
  const ledger = openUnifiedLedger(':memory:');
  try {
    const prop = ledger.proposeDecision(proposal());
    assert.equal(prop.status, 'pending');
    assert.equal(ledger.queryRelevantDecisions({}).length, 0);
    assert.equal(ledger.queryRelevantDecisions({ projectId: 'anyproj' }).length, 0);
    ledger.approveProposal(prop.proposal_id, { approvedBy: 'owner' });
    const rows = ledger.queryRelevantDecisions({});
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'active');
    assert.equal(rows[0].decision, 'release only on owner approval');
    assert.equal(rows[0].approved_by, 'owner');
  } finally { ledger.close(); }
});

test('approveProposal is atomic and supersedes the old decision', () => {
  const ledger = openUnifiedLedger(':memory:');
  try {
    const first = ledger.proposeDecision(proposal({ decision: 'old rule' }));
    const active1 = ledger.approveProposal(first.proposal_id, { approvedBy: 'owner' });
    const second = ledger.proposeDecision(proposal({ decision: 'new rule' }));
    const active2 = ledger.approveProposal(second.proposal_id,
      { approvedBy: 'owner', supersedesId: active1.id });
    const rows = ledger.queryRelevantDecisions({});
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, active2.id);
    assert.equal(rows[0].decision, 'new rule');
    // the old decision is tombstoned, not deleted
    const all = ledger.queryRelevantDecisions({ query: 'old rule' });
    assert.equal(all.length, 0);
    // supersede of a non-active or missing decision is rejected fail-closed
    const third = ledger.proposeDecision(proposal({ decision: 'third rule' }));
    assert.throws(() => ledger.approveProposal(third.proposal_id,
      { approvedBy: 'owner', supersedesId: active1.id }), /^Error: unified_ledger_supersedes_invalid$/);
    assert.throws(() => ledger.approveProposal(third.proposal_id,
      { approvedBy: 'owner', supersedesId: 'missing-id' }), /^Error: unified_ledger_supersedes_invalid$/);
    // failed approvals leave the proposal pending — no partial state
    assert.equal(ledger.approveProposal(third.proposal_id, { approvedBy: 'owner' }).status, 'active');
  } finally { ledger.close(); }
});

test('approveProposal supports overrideDecision text', () => {
  const ledger = openUnifiedLedger(':memory:');
  try {
    const prop = ledger.proposeDecision(proposal({ decision: 'draft text' }));
    const active = ledger.approveProposal(prop.proposal_id,
      { approvedBy: 'owner', overrideDecision: 'final text' });
    assert.equal(active.decision, 'final text');
    assert.throws(() => ledger.approveProposal(ledger.proposeDecision(proposal()).proposal_id,
      { approvedBy: 'owner', overrideDecision: '  ' }), /^Error: unified_ledger_input_invalid$/);
  } finally { ledger.close(); }
});

test('rejectProposal marks the proposal rejected and it can never be approved', () => {
  const ledger = openUnifiedLedger(':memory:');
  try {
    const prop = ledger.proposeDecision(proposal());
    const rejected = ledger.rejectProposal(prop.proposal_id, { rejectedBy: 'owner', reason: 'out of scope' });
    assert.equal(rejected.status, 'rejected');
    assert.equal(rejected.rejected_by, 'owner');
    assert.equal(rejected.rejection_reason, 'out of scope');
    assert.equal(ledger.queryRelevantDecisions({}).length, 0);
    assert.throws(() => ledger.approveProposal(prop.proposal_id, { approvedBy: 'owner' }),
      /^Error: unified_ledger_proposal_not_pending$/);
    assert.throws(() => ledger.rejectProposal(prop.proposal_id, { rejectedBy: 'owner' }),
      /^Error: unified_ledger_proposal_not_pending$/);
  } finally { ledger.close(); }
});

test('missing proposals and empty approvedBy are rejected fail-closed', () => {
  const ledger = openUnifiedLedger(':memory:');
  try {
    const prop = ledger.proposeDecision(proposal());
    for (const bad of ['', '   ', undefined, null]) {
      assert.throws(() => ledger.approveProposal(prop.proposal_id, { approvedBy: bad }),
        /^Error: unified_ledger_approver_required$/, JSON.stringify(bad));
    }
    assert.throws(() => ledger.approveProposal('no-such-id', { approvedBy: 'owner' }),
      /^Error: unified_ledger_proposal_not_found$/);
    assert.throws(() => ledger.rejectProposal('no-such-id', { rejectedBy: 'owner' }),
      /^Error: unified_ledger_proposal_not_found$/);
    // double approval is impossible
    ledger.approveProposal(prop.proposal_id, { approvedBy: 'owner' });
    assert.throws(() => ledger.approveProposal(prop.proposal_id, { approvedBy: 'owner' }),
      /^Error: unified_ledger_proposal_not_pending$/);
  } finally { ledger.close(); }
});

test('queryRelevantDecisions filters scopes strictly: global + project:X, never project:Y', () => {
  const ledger = openUnifiedLedger(':memory:');
  try {
    for (const [scope, topic] of [
      ['global', 'g-topic'],
      ['project:proj_x', 'x-topic'],
      ['project:proj_y', 'y-secret-topic'],
      ['area:finops', 'area-topic'],
    ]) {
      const prop = ledger.proposeDecision(proposal({ scope, topic }));
      ledger.approveProposal(prop.proposal_id, { approvedBy: 'owner' });
    }
    const x = ledger.queryRelevantDecisions({ projectId: 'proj_x' });
    assert.deepEqual(x.map(r => r.topic).sort(), ['g-topic', 'x-topic']);
    const xWithArea = ledger.queryRelevantDecisions({ projectId: 'proj_x', areas: ['finops'] });
    assert.deepEqual(xWithArea.map(r => r.topic).sort(), ['area-topic', 'g-topic', 'x-topic']);
    const globalOnly = ledger.queryRelevantDecisions({});
    assert.deepEqual(globalOnly.map(r => r.topic), ['g-topic']);
    const y = ledger.queryRelevantDecisions({ projectId: 'proj_y' });
    assert.equal(y.length, 2);
    assert.ok(!xWithArea.some(r => r.topic === 'y-secret-topic'));
  } finally { ledger.close(); }
});

test('queryRelevantDecisions applies keyword query and limit deterministically', () => {
  const ledger = openUnifiedLedger(':memory:');
  try {
    for (const topic of ['alpha one', 'beta two', 'alpha three']) {
      const prop = ledger.proposeDecision(proposal({ topic, decision: `body of ${topic}` }));
      ledger.approveProposal(prop.proposal_id, { approvedBy: 'owner' });
    }
    const alpha = ledger.queryRelevantDecisions({ query: 'ALPHA' });
    assert.equal(alpha.length, 2);
    assert.deepEqual(alpha.map(r => r.topic), ['alpha one', 'alpha three']);
    const limited = ledger.queryRelevantDecisions({ limit: 2 });
    assert.equal(limited.length, 2);
    assert.deepEqual(limited.map(r => r.topic), ['alpha one', 'beta two']);
    // deterministic across repeated calls
    assert.deepEqual(ledger.queryRelevantDecisions({}), ledger.queryRelevantDecisions({}));
  } finally { ledger.close(); }
});

test('exportMarkdown renders deterministic markdown with stable digest', () => {
  const ledger = openUnifiedLedger(':memory:');
  try {
    const g = ledger.proposeDecision(proposal({ scope: 'global', topic: 'g', decision: 'global rule' }));
    ledger.approveProposal(g.proposal_id, { approvedBy: 'owner' });
    const x = ledger.proposeDecision(proposal({ scope: 'project:proj_x', topic: 'x', decision: 'project rule' }));
    ledger.approveProposal(x.proposal_id, { approvedBy: 'owner' });
    const first = ledger.exportMarkdown({ projectId: 'proj_x' });
    const second = ledger.exportMarkdown({ projectId: 'proj_x' });
    assert.equal(first.markdown, second.markdown);
    assert.equal(first.digest, second.digest);
    assert.match(first.digest, /^[a-f0-9]{64}$/);
    assert.match(first.markdown, /^# Owner Decision Ledger/);
    assert.match(first.markdown, /## global/);
    assert.match(first.markdown, /## project:proj_x/);
    assert.match(first.markdown, /global rule/);
    assert.equal(first.truncated, false);
    assert.equal(first.total, 2);
    // different project view — different digest
    const other = ledger.exportMarkdown({ projectId: 'proj_y' });
    assert.notEqual(other.digest, first.digest);
    // bounded truncation
    const tiny = ledger.exportMarkdown({ projectId: 'proj_x', maxChars: 200 });
    assert.ok(tiny.markdown.length <= 200);
    assert.equal(tiny.truncated, true);
    assert.match(tiny.digest, /^[a-f0-9]{64}$/);
  } finally { ledger.close(); }
});

test('ledger persists across close and reopen on a file-backed database', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'unified-ledger-'));
  try {
    const dbPath = join(dir, 'ledger.sqlite');
    const ledger = openUnifiedLedger(dbPath);
    const prop = ledger.proposeDecision(proposal({ topic: 'persisted' }));
    const active = ledger.approveProposal(prop.proposal_id, { approvedBy: 'owner' });
    const before = ledger.exportMarkdown({});
    ledger.close();

    const reopened = openUnifiedLedger(dbPath);
    const rows = reopened.queryRelevantDecisions({});
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, active.id);
    assert.equal(rows[0].topic, 'persisted');
    const after = reopened.exportMarkdown({});
    assert.equal(after.digest, before.digest);
    assert.equal(after.markdown, before.markdown);
    reopened.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('invalid input is rejected fail-closed and closed ledger refuses operations', () => {
  const ledger = openUnifiedLedger(':memory:');
  assert.throws(() => ledger.proposeDecision(proposal({ scope: 'project:' })),
    /^Error: unified_ledger_scope_invalid$/);
  assert.throws(() => ledger.proposeDecision(proposal({ scope: 'bogus' })),
    /^Error: unified_ledger_scope_invalid$/);
  assert.throws(() => ledger.proposeDecision(proposal({ topic: '' })),
    /^Error: unified_ledger_input_invalid$/);
  assert.throws(() => ledger.proposeDecision(proposal({ decision: '' })),
    /^Error: unified_ledger_input_invalid$/);
  assert.throws(() => ledger.proposeDecision(proposal({ proposedBy: '' })),
    /^Error: unified_ledger_input_invalid$/);
  assert.throws(() => openUnifiedLedger(''), /^Error: unified_ledger_path_invalid$/);
  ledger.close();
  assert.throws(() => ledger.queryRelevantDecisions({}), /^Error: unified_ledger_closed$/);
  assert.throws(() => ledger.proposeDecision(proposal()), /^Error: unified_ledger_closed$/);
});
