// Unified Owner Decision Ledger (Board #7919): a single SQLite-backed registry
// of owner decisions, replacing disconnected decision stores. Writes are
// strictly approval-gated: a proposal only ever enters `decision_proposals`
// as `pending`; a decision becomes `active` solely through explicit owner
// approval. There is no path — API or otherwise — that auto-activates an
// unapproved decision.
//
// Storage uses the built-in `node:sqlite` DatabaseSync (zero npm deps).
// Approval is atomic: proposal transition, decision insertion and optional
// supersede happen in one IMMEDIATE transaction, so a crash cannot leave a
// half-recorded approval.

import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_MAX_CHARS, ledgerTextDigest, openSqliteLedgerJournal } from './decision-ledger.mjs';

export const LEDGER_SCHEMA_VERSION = 1;
export { DEFAULT_MAX_CHARS };
export const DEFAULT_QUERY_LIMIT = 100;

const SCOPE = /^(global|project:[a-z0-9_-]{1,64}|area:[a-z0-9_-]{1,64})$/;
const MAX_TOPIC_CHARS = 200;
const MAX_TEXT_CHARS = 4000;
const MAX_ACTOR_CHARS = 128;

const err = code => new Error(code);

function validateScope(scope) {
  if (typeof scope !== 'string' || !SCOPE.test(scope)) throw err('unified_ledger_scope_invalid');
  return scope;
}

function validateText(value, field, { required, maxChars = MAX_TEXT_CHARS } = {}) {
  if (value === undefined || value === null) {
    if (required) throw err('unified_ledger_input_invalid');
    return '';
  }
  if (typeof value !== 'string' || value.length > maxChars ||
      (required && value.trim() === '')) {
    throw err('unified_ledger_input_invalid');
  }
  return value;
}

function validateActor(value, code) {
  if (typeof value !== 'string' || value.trim() === '' || value.length > MAX_ACTOR_CHARS) {
    throw err(code);
  }
  return value.trim();
}

// Flatten whitespace for Markdown embedding: multi-line text would break the
// deterministic one-line-per-entry rendering used for prompt injection.
const inline = text => text.replace(/\s+/g, ' ').trim();

// The SQLite file (including :memory:) is the synchronous transport for the
// checksummed journal. The original v1 tables are its SQL projection: in particular
// df-decisions pending reads decision_proposals on a separate connection. No
// sidecar file or second lock/commit is involved.
const PROPOSALS = 'decision_proposals';
const DECISIONS = 'decisions';
const columns = {
  [PROPOSALS]: ['proposal_id', 'scope', 'topic', 'decision', 'rationale', 'applicability',
    'proposed_by', 'status', 'rejected_by', 'rejection_reason', 'created_at'],
  [DECISIONS]: ['id', 'scope', 'topic', 'decision', 'rationale', 'applicability', 'status',
    'superseded_by', 'approved_by', 'approved_at', 'created_at'],
};

function openRowJournal(db) {
  const entry = (collection, row) => ({ collection, entity: row[columns[collection][0]], row });
  const journal = openSqliteLedgerJournal(db, append => {
    for (const collection of Object.keys(columns)) {
      for (const row of db.prepare(`SELECT * FROM ${collection} ORDER BY rowid`).iterate()) {
        append(entry(collection, row));
      }
    }
  });

  const projections = new Map(Object.entries(columns).map(([table, keys]) => [table, db.prepare(
    `INSERT INTO ${table} (${keys}) VALUES (${keys.map(() => '?')}) ON CONFLICT(${keys[0]}) DO UPDATE SET
     ${keys.slice(1).map(k => `${k}=excluded.${k}`)}`)]));
  const sqlRow = row => Object.assign(Object.create(null), row);
  return {
    write: fn => journal.write(append => fn((collection, row) => {
      append(entry(collection, row));
      projections.get(collection).run(...columns[collection].map(k => row[k]));
      return sqlRow(row);
    })),
    get(collection, id) {
      const record = journal.get(collection, id);
      return record && sqlRow(record.row);
    },
    rows(collection) {
      // Stable sort preserves insertion (v1 rowid) order for equal timestamps.
      return journal.entries(collection).map(record => sqlRow(record.row)).sort((a, b) =>
        a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0);
    },
  };
}

export function openUnifiedLedger(dbPath) {
  if (typeof dbPath !== 'string' || dbPath === '') throw err('unified_ledger_path_invalid');
  const db = new DatabaseSync(dbPath);
  let open = true;

  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS decisions (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      topic TEXT NOT NULL,
      decision TEXT NOT NULL,
      rationale TEXT NOT NULL DEFAULT '',
      applicability TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      superseded_by TEXT,
      approved_by TEXT NOT NULL,
      approved_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS decision_proposals (
      proposal_id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      topic TEXT NOT NULL,
      decision TEXT NOT NULL,
      rationale TEXT NOT NULL DEFAULT '',
      applicability TEXT NOT NULL DEFAULT '',
      proposed_by TEXT NOT NULL,
      status TEXT NOT NULL,
      rejected_by TEXT,
      rejection_reason TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_decisions_status_scope_created
      ON decisions(status, scope, created_at);
  `);

  const ensureOpen = () => { if (!open) throw err('unified_ledger_closed'); };

  let journal;
  try { journal = openRowJournal(db); } catch (error) { db.close(); throw error; }
  const getProposal = id => journal.get(PROPOSALS, id);
  const getDecision = id => journal.get(DECISIONS, id);

  // Insert a candidate decision as a pending proposal. NEVER activates: the
  // only way into `decisions` is approveProposal with explicit owner approval.
  function proposeDecision({ scope, topic, decision, rationale, applicability, proposedBy } = {}) {
    ensureOpen();
    validateScope(scope);
    const cleanTopic = validateText(topic, 'topic', { required: true, maxChars: MAX_TOPIC_CHARS });
    const cleanDecision = validateText(decision, 'decision', { required: true });
    const cleanRationale = validateText(rationale, 'rationale');
    const cleanApplicability = validateText(applicability, 'applicability');
    const proposer = validateActor(proposedBy, 'unified_ledger_input_invalid');
    const proposalId = randomUUID();
    return journal.write(append => append(PROPOSALS, {
      proposal_id: proposalId, scope, topic: cleanTopic, decision: cleanDecision, rationale: cleanRationale,
      applicability: cleanApplicability, proposed_by: proposer, status: 'pending', rejected_by: null,
      rejection_reason: null, created_at: new Date().toISOString(),
    }));
  }

  // Atomically approve a pending proposal: the proposal flips to `approved`,
  // the decision is inserted as `active`, and an optional superseded decision
  // is tombstoned — all in one transaction. Empty approvedBy, missing or
  // already-processed proposals, and invalid supersede targets are rejected
  // fail-closed before any write is committed. Supersede stays within the
  // same scope, matching the established decision-ledger invariant.
  function approveProposal(proposalId, { approvedBy, overrideDecision, supersedesId } = {}) {
    ensureOpen();
    const approver = validateActor(approvedBy, 'unified_ledger_approver_required');
    if (typeof proposalId !== 'string' || proposalId === '') throw err('unified_ledger_proposal_not_found');
    return journal.write(append => {
      const proposal = getProposal(proposalId);
      if (proposal === undefined) throw err('unified_ledger_proposal_not_found');
      if (proposal.status !== 'pending') throw err('unified_ledger_proposal_not_pending');
      const decisionText = overrideDecision === undefined
        ? proposal.decision
        : validateText(overrideDecision, 'decision', { required: true });
      let superseded = null;
      if (supersedesId !== undefined && supersedesId !== null) {
        superseded = getDecision(supersedesId);
        if (superseded === undefined || superseded.status !== 'active' ||
            superseded.scope !== proposal.scope) {
          throw err('unified_ledger_supersedes_invalid');
        }
      }
      const now = new Date().toISOString();
      const id = randomUUID();
      const active = append(DECISIONS, { id, scope: proposal.scope, topic: proposal.topic,
        decision: decisionText, rationale: proposal.rationale, applicability: proposal.applicability,
        status: 'active', superseded_by: null, approved_by: approver, approved_at: now, created_at: now });
      append(PROPOSALS, { ...proposal, status: 'approved' });
      if (superseded !== null) append(DECISIONS, { ...superseded, status: 'superseded', superseded_by: id });
      return active;
    });
  }

  // Reject a pending proposal. Rejected proposals never enter `decisions` and
  // can no longer be approved — the status transition is one-way. The update
  // is atomic: the pending check and append share the write lock, so a
  // concurrent approve+reject cannot give the proposal two terminal states.
  function rejectProposal(proposalId, { rejectedBy, reason } = {}) {
    ensureOpen();
    const rejector = validateActor(rejectedBy, 'unified_ledger_input_invalid');
    if (typeof proposalId !== 'string' || proposalId === '') throw err('unified_ledger_proposal_not_found');
    const cleanReason = validateText(reason, 'reason');
    return journal.write(append => {
      const proposal = getProposal(proposalId);
      if (proposal === undefined) throw err('unified_ledger_proposal_not_found');
      if (proposal.status !== 'pending') throw err('unified_ledger_proposal_not_pending');
      return append(PROPOSALS, { ...proposal, status: 'rejected', rejected_by: rejector, rejection_reason: cleanReason });
    });
  }

  // Pending proposals in deterministic submission order, oldest first. This
  // is the owner-facing approval queue; approved/rejected proposals never
  // reappear here.
  function listPendingProposals() {
    ensureOpen();
    return journal.rows(PROPOSALS).filter(row => row.status === 'pending');
  }

  // Read-only view for leads/workers: ONLY `active` decisions whose scope is
  // `global`, `project:<projectId>` or one of the requested `area:<name>`
  // scopes. Proposals — pending, approved or rejected — are never visible
  // here. Optional `query` is a case-insensitive substring matched against
  // topic/decision/rationale. Rows are ordered deterministically by
  // creation time and insertion order, then bounded by `limit`.
  function queryRelevantDecisions({ projectId, areas, query, limit = DEFAULT_QUERY_LIMIT } = {}) {
    ensureOpen();
    if (!Number.isSafeInteger(limit) || limit < 1) throw err('unified_ledger_input_invalid');
    const scopes = ['global'];
    if (projectId !== undefined && projectId !== null) {
      if (typeof projectId !== 'string' || projectId === '') throw err('unified_ledger_input_invalid');
      scopes.push(`project:${projectId}`);
    }
    if (areas !== undefined && areas !== null) {
      if (!Array.isArray(areas) || areas.some(area => typeof area !== 'string' || area === '')) {
        throw err('unified_ledger_input_invalid');
      }
      for (const area of areas) scopes.push(area.startsWith('area:') ? area : `area:${area}`);
    }
    const rows = journal.rows(DECISIONS).filter(row => row.status === 'active' && scopes.includes(row.scope));
    let filtered = rows;
    if (query !== undefined && query !== null && query !== '') {
      if (typeof query !== 'string') throw err('unified_ledger_input_invalid');
      const needle = query.toLowerCase();
      filtered = rows.filter(row =>
        row.topic.toLowerCase().includes(needle) ||
        row.decision.toLowerCase().includes(needle) ||
        row.rationale.toLowerCase().includes(needle));
    }
    return filtered.slice(0, limit);
  }

  // Deterministic Markdown rendering of active decisions relevant to a project
  // (global + project scope + optional area scopes) plus its sha256 digest.
  // The digest pins exactly the emitted text so prompt injection can verify
  // what was shown. Output is bounded by maxChars: truncation happens strictly
  // on whole decision entry boundaries — entries are included in order while
  // they fit alongside the truncation marker, and the marker explicitly states
  // how many of the total entries are shown. A entry is never sliced
  // mid-sentence; when nothing fits, only the header and the marker remain.
  // `ids` lists exactly the decision ids present in the emitted markdown.
  function exportMarkdown({ project, projectId, areas, maxChars = DEFAULT_MAX_CHARS } = {}) {
    ensureOpen();
    if (!Number.isSafeInteger(maxChars) || maxChars < 1) throw err('unified_ledger_input_invalid');
    if (project !== undefined && projectId !== undefined && project !== projectId) {
      throw err('unified_ledger_input_invalid');
    }
    const effectiveProject = project !== undefined ? project : projectId;
    const rows = queryRelevantDecisions({ projectId: effectiveProject, areas, limit: Number.MAX_SAFE_INTEGER });
    const header = '# Owner Decision Ledger\n';
    const byScope = new Map();
    for (const row of rows) {
      if (!byScope.has(row.scope)) byScope.set(row.scope, []);
      byScope.get(row.scope).push(row);
    }
    const scopeOrder = [...byScope.keys()].sort((a, b) => {
      if (a === 'global') return -1;
      if (b === 'global') return 1;
      return a < b ? -1 : 1;
    });
    // Атомарная единица усечения — целиком одна запись решения; заголовок
    // scope-секции приклеен к первой записи секции, чтобы никогда не
    // оставаться без единой записи.
    const units = [];
    for (const scope of scopeOrder) {
      const scopeRows = byScope.get(scope);
      scopeRows.forEach((row, index) => {
        const entry = [
          `- **${inline(row.topic)}**: ${inline(row.decision)}`,
          row.rationale ? `  - Rationale: ${inline(row.rationale)}` : null,
          row.applicability ? `  - Applicability: ${inline(row.applicability)}` : null,
          `  - ID: \`${row.id}\` — approved by ${inline(row.approved_by)} at ${row.approved_at}`,
        ].filter(line => line !== null).join('\n');
        units.push({ id: row.id, text: `${index === 0 ? `\n## ${scope}\n\n` : ''}${entry}\n` });
      });
    }
    const full = header + units.map(unit => unit.text).join('');
    let markdown = full;
    let truncated = false;
    let ids = units.map(unit => unit.id);
    if (full.length > maxChars) {
      truncated = true;
      // Длина маркера зависит от числа показанных записей; резервируется
      // максимальная длина (total — верхняя граница shown), поэтому итог
      // никогда не превышает maxChars.
      const noticeFor = shown => `\n_Truncated: showing ${shown} of ${rows.length} decision entries._\n`;
      const reserved = noticeFor(rows.length).length;
      const included = [];
      const includedIds = [];
      for (const unit of units) {
        const candidate = header + included.join('') + unit.text;
        if (candidate.length + reserved > maxChars) break;
        included.push(unit.text);
        includedIds.push(unit.id);
      }
      const notice = noticeFor(included.length);
      markdown = header + included.join('') + notice;
      ids = includedIds;
    }
    const digest = ledgerTextDigest(markdown);
    return { markdown, digest, truncated, total: rows.length, ids };
  }

  function close() {
    if (!open) return;
    open = false;
    db.close();
  }

  return { proposeDecision, approveProposal, rejectProposal, listPendingProposals,
    queryRelevantDecisions, exportMarkdown, close };
}
