import { DatabaseSync } from 'node:sqlite';
import { basename, dirname } from 'node:path';
import { lstat, realpath } from 'node:fs/promises';
import { inside } from './fs-safe.mjs';
import { readActiveUnifiedRows } from './unified-ledger.mjs';

const escalate = reason => ({ verdict: 'ESCALATE', reason });
// Conservative denials, not an allowlist. Permission to reuse an answer must
// independently come from the applicability of the exact approved decision.
const hardStops = [
  /\b(gcp|google cloud)\b.*(bill|budget|cap|quota|limit|spend|бюджет|лимит)|(bill|budget|spend|бюджет|лимит).*\b(gcp|google cloud)\b/u,
  /\b(delet\w*|wipe|purge|truncate|destroy|drop|irreversible)\b|удалени|удалить|необратим/u,
  /\b(secrets?|pii|credentials?|passwords?|api[ _-]?keys?|tokens?|personal (?:data|information)|personally identifiable|private keys?)\b|секрет|персональн.*данн|парол/u,
  /\b(pay\w*|buy|purchas\w*|charg\w*|spend\w*|money|funds?|invoice|billing|refund|wire|transact\w*|hire|contact|e-?mail|invite|notify|external (?:people|person|action))\b|[$€₽£]|оплат|плат[её]ж|деньг|связаться|пригласить/u,
  /\b(send|share|publish|disclose|transfer|donate|subscribe|reach out)\b|\b(message|call|tell|ask)\b.*\b(vendor|client|customer|supplier|contractor|partner|person|team|public|external|third.party)s?\b|отправить|разгласить|перечислить|(?:свяж|напиш|позвон).*?(?:поставщик|клиент|подрядчик|заказчик)/u,
  /moml[-_ ]course.*(public|publish|push|github|пуш|публик)|(?:public|publish|push|github|пуш|публик).*moml[-_ ]course|\bd-3\b/u,
];
const redStop = text => hardStops.some(re => re.test(text.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ')));

// SQLite can consult both sidecars on a read-only connection. Check their
// directory too: a writable parent would let another user replace the files.
async function trustedLedger(path) {
  const owned = st => st.uid === process.getuid() && !(st.mode & 0o022);
  if (await realpath(path) !== path || !owned(await lstat(dirname(path)))) return false;
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      const st = await lstat(path + suffix);
      if (!st.isFile() || st.nlink !== 1 || !owned(st)) return false;
    } catch (err) {
      if (!suffix || err.code !== 'ENOENT') throw err;
    }
  }
  return true;
}

// Local sparse character vectors keep private ledger text off embedding APIs.
function vector(text) {
  const v = new Map(), s = `  ${text.toLowerCase()}  `;
  for (let i = 2; i < s.length; i++) {
    const gram = s.slice(i - 2, i + 1);
    v.set(gram, (v.get(gram) ?? 0) + 1);
  }
  const norm = Math.sqrt([...v.values()].reduce((sum, n) => sum + n * n, 0));
  for (const [gram, n] of v) v.set(gram, n / norm);
  return v;
}

// The ledger's mutable SQL projection isn't authoritative. Index only verified
// active journal heads, in memory, and discard the index after this decision.
function hybridSearch(rows, prompt) {
  const tokens = prompt.match(/[\p{L}\p{N}]+/gu);
  if (!tokens?.length) return [];
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE VIRTUAL TABLE docs USING fts5(topic, decision)');
    const insert = db.prepare('INSERT INTO docs(rowid, topic, decision) VALUES (?, ?, ?)');
    const query = vector(prompt);
    const vectors = rows.map((row, i) => {
      insert.run(i + 1, row.topic, row.decision);
      const v = vector(row.topic);
      let similarity = 0;
      for (const [gram, n] of query) similarity += n * (v.get(gram) ?? 0);
      return { i, similarity };
    }).filter(hit => hit.similarity > 0).sort((a, b) => b.similarity - a.similarity);
    const lexical = db.prepare('SELECT rowid FROM docs WHERE docs MATCH ? ORDER BY rank, rowid')
      .all(tokens.map(t => `"${t}"`).join(' OR '));
    const ranks = new Map();
    for (const list of [vectors.map(hit => hit.i), lexical.map(hit => hit.rowid - 1)]) {
      list.forEach((i, rank) => ranks.set(i, (ranks.get(i) ?? 0) + 1 / (61 + rank)));
    }
    return [...ranks].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([i]) => rows[i]);
  } finally { db.close(); }
}

/** Product questions only. A score proposes candidates, never authorization.
 * `applicability` on an approved ledger row may explicitly classify the exact
 * topic as reusable (reversible/matching/medium); free-form conditions are
 * not interpreted. No credentials, paths, or citations come from a handoff.
 */
export async function judgeOwnerQuestion({ kind, prompt, evidence = '', context = '', projectId,
  principal, dbPath, worktree } = {}) {
  if (kind !== 'product' || typeof prompt !== 'string' || !prompt.trim() || prompt.length > 260 ||
      typeof evidence !== 'string' || typeof context !== 'string') return escalate('ineligible_question');
  const input = `${projectId ?? ''} ${context} ${prompt} ${evidence}`;
  if (redStop(input)) return escalate('red_stop');
  if (!dbPath || !principal) return escalate('no_owner_citation');
  try {
    const tree = await realpath(worktree);
    if (inside(tree, dbPath) || inside(dirname(dbPath), tree) || !await trustedLedger(dbPath)) return escalate('untrusted_ledger');
    const rows = readActiveUnifiedRows(dbPath).filter(r => r.scope === 'global' ||
      (projectId && r.scope === `project:${projectId}`));
    const row = hybridSearch(rows, prompt).find(r => r.topic.trim() === prompt.trim());
    // An equally applicable decision outside the retrieval window is still a conflict.
    if (!row || rows.some(r => r !== row && r.topic.trim() === row.topic.trim())) return escalate('no_unique_match');
    if (redStop(`${input} ${row.decision} ${row.applicability} ${row.rationale}`)) return escalate('red_stop');
    if (!['reversible', 'matching', 'medium'].includes(row.applicability) || row.approved_by !== principal ||
        typeof row.decision !== 'string' || !row.decision.trim() || row.decision.length > 512 ||
        !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(row.id ?? '') ||
        !Number.isFinite(Date.parse(row.approved_at)) || new Date(row.approved_at).toISOString() !== row.approved_at) {
      return escalate('no_owner_citation');
    }
    return { verdict: 'RESOLVE', citation: { quote: row.decision,
      source: `${basename(dbPath)}#decisions/${row.id}`, date: row.approved_at } };
  } catch { return escalate('ledger_unavailable'); }
}
