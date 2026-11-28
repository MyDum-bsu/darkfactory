#!/usr/bin/env node
// Portfolio entries have no scope marker: import them as global decisions.
import { randomUUID } from 'node:crypto';
import { open, readFile, realpath, rename, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { appendLedgerRecord, LEDGER_SCHEMA, resolveActiveDecisions } from '../../board_pipeline/decision-ledger.mjs';
import { legacyRuleSummary, openUnifiedLedger, readActiveUnifiedRows } from '../../board_pipeline/unified-ledger.mjs';

export function parsePortfolio(markdown) {
  const entries = [];
  let entry, fence;
  for (const line of markdown.split(/\r?\n/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (marker && marker[1].startsWith(fence) && !marker[2].trim()) fence = null;
    } else if (marker) {
      fence = marker[1];
      entry = null;
    } else {
      const match = /^\d+\.\s+\*\*(.+?)\*\*(.*)$/.exec(line);
      if (match) {
        entry = { scope: 'global', topic: match[1].trim(), decision: match[2].replace(/^\s*[:—–-]\s*/, '').trim() };
        entries.push(entry);
      } else if (entry && /^\s+\S/.test(line)) {
        entry.decision = `${entry.decision} ${line.trim()}`.trim();
      } else {
        entry = null;
      }
    }
  }
  for (const item of entries) item.decision ||= item.topic;
  return entries;
}

const normalize = value => value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
const key = row => JSON.stringify([normalize(row.scope), normalize(row.topic)]);

async function exportSnapshot(db, path) {
  const tmp = `${path}.${randomUUID()}.tmp`;
  const handle = await open(tmp, 'wx', 0o600);
  try {
    try {
      for (const row of readActiveUnifiedRows(db)) {
        // Never widen area decisions to global. The full decision stays in SQLite.
        if (row.scope.startsWith('area:')) throw new Error(`JSONL v1 cannot represent scope ${row.scope}`);
        const rule = legacyRuleSummary(row);
        // The portfolio has no Board card. Reserve "0" for an external source;
        // distinguish the recorder from the actual human approval attribution.
        await appendLedgerRecord({ schema: LEDGER_SCHEMA, id: row.id, scope: row.scope,
          rule, status: 'active', source_card: '0', timestamp: row.approved_at,
          recorded_by: 'import-owner-decisions', approved_by: row.approved_by }, line => handle.writeFile(line));
      }
    } finally {
      await handle.close();
    }
    // Validate the entire snapshot with its consumer before replacing the last good copy.
    await resolveActiveDecisions({ ledgerPath: tmp });
    await rename(tmp, path);
  } finally {
    await rm(tmp, { force: true });
  }
}

async function canonicalTarget(path) {
  try { return await realpath(path); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return join(await realpath(dirname(path)), basename(path));
  }
}

async function run(options) {
  const actor = options['approved-by'].trim();
  const entries = parsePortfolio(await readFile(options.from, 'utf8'));
  const db = await canonicalTarget(options.db);
  const out = options['export-jsonl'] && resolve(options['export-jsonl']);
  if (out) {
    const target = await canonicalTarget(out);
    if ([db, `${db}-wal`, `${db}-shm`, `${db}-journal`, await realpath(options.from)].includes(target)) {
      throw new Error('--export-jsonl must be separate from the portfolio and database');
    }
  }
  const ledger = openUnifiedLedger(db);
  let imported = 0;
  try {
    const keys = new Set(ledger.queryRelevantDecisions({ limit: Number.MAX_SAFE_INTEGER }).map(key));
    for (const entry of entries) {
      const id = key(entry);
      if (keys.has(id)) continue;
      const proposal = ledger.proposeDecision({ ...entry, proposedBy: 'import-owner-decisions' });
      ledger.approveProposal(proposal.proposal_id, { approvedBy: actor });
      keys.add(id);
      imported++;
    }
    if (out) await exportSnapshot(db, out);
  } finally {
    ledger.close();
  }
  return { imported, skipped: entries.length - imported };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let values;
  try {
    ({ values } = parseArgs({ options: Object.fromEntries(
      ['from', 'db', 'approved-by', 'export-jsonl'].map(name => [name, { type: 'string' }])) }));
    for (const name of new Set(['approved-by', 'from', 'db', ...Object.keys(values)])) {
      if (!values[name]?.trim()) throw new Error(`expected non-empty --${name}`);
    }
    if (values['approved-by'].trim().length > 128) throw new Error('--approved-by exceeds ledger actor limit');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
  if (!process.exitCode) {
    try { console.log(JSON.stringify(await run(values))); } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
