#!/usr/bin/env node
// df-decisions — operator CLI for the approval-gated Unified Owner Decision Ledger.

import { createHash, randomUUID } from 'node:crypto';
import { rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_MAX_CHARS, openUnifiedLedger } from '../board_pipeline/unified-ledger.mjs';

const USAGE = `usage:
  node ops/df-decisions.mjs propose --db PATH --scope SCOPE --topic TOPIC --decision DECISION [--rationale TEXT] [--applicability TEXT] --by ACTOR [--json]
  node ops/df-decisions.mjs approve --db PATH --id PROPOSAL_ID --by OWNER [--supersedes DECISION_ID] [--json]
  node ops/df-decisions.mjs reject --db PATH --id PROPOSAL_ID --by OWNER [--reason TEXT] [--json]
  node ops/df-decisions.mjs query --db PATH [--project PROJECT] [--area NAME ...] [--q KEYWORD] [--json]
  node ops/df-decisions.mjs export --db PATH [--project PROJECT] [--area NAME ...] [--out MARKDOWN_PATH] [--json]
  node ops/df-decisions.mjs pending --db PATH [--json]`;

const COMMANDS = new Set(['propose', 'approve', 'reject', 'query', 'export', 'pending']);
const COMMAND_OPTIONS = {
  propose: new Set(['db', 'scope', 'topic', 'decision', 'rationale', 'applicability', 'by', 'json']),
  approve: new Set(['db', 'id', 'by', 'supersedes', 'json']),
  reject: new Set(['db', 'id', 'by', 'reason', 'json']),
  query: new Set(['db', 'project', 'area', 'q', 'json']),
  export: new Set(['db', 'project', 'area', 'out', 'json']),
  pending: new Set(['db', 'json']),
};
const BOOLEAN_OPTIONS = new Set(['json']);
const REPEATABLE_OPTIONS = new Set(['area']);
const PROJECT_NAME = /^[a-z0-9_-]+$/i;

function usageError(message) {
  return new Error(`df_decisions_usage: ${message}`);
}

function parseCommandArgs(args, command) {
  const allowed = COMMAND_OPTIONS[command];
  const values = {};
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const body = token.slice(2);
    if (!body) throw usageError('empty option');
    const equals = body.indexOf('=');
    const key = equals === -1 ? body : body.slice(0, equals);
    const inlineValue = equals === -1 ? undefined : body.slice(equals + 1);
    if (!allowed.has(key)) throw usageError(`unknown option --${key} for command ${command}`);
    const repeatable = REPEATABLE_OPTIONS.has(key);
    if (!repeatable && Object.hasOwn(values, key)) throw usageError(`duplicate option --${key}`);
    if (BOOLEAN_OPTIONS.has(key)) {
      if (inlineValue !== undefined) throw usageError(`option --${key} does not take a value`);
      values[key] = true;
      continue;
    }
    let value = inlineValue;
    if (value === undefined) {
      i += 1;
      value = args[i];
      if (value === undefined || value.startsWith('--')) {
        throw usageError(`option --${key} requires a value`);
      }
    }
    if (value.trim() === '') throw usageError(`option --${key} requires a non-empty value`);
    if (repeatable) {
      if (values[key] === undefined) values[key] = [];
      values[key].push(value);
    } else {
      values[key] = value;
    }
  }
  if (positional.length) {
    throw usageError(`command ${command} does not accept positional arguments: ${positional.join(' ')}`);
  }
  return values;
}

function requireOptions(values, keys, command) {
  for (const key of keys) {
    if (values[key] === undefined) throw usageError(`${command} requires --${key}`);
  }
}

function requireDb(values, defaultDbPath, command) {
  const dbPath = values.db ?? defaultDbPath;
  if (typeof dbPath !== 'string' || dbPath.trim() === '') {
    throw usageError(`${command} requires --db`);
  }
  return dbPath;
}

function projectOption(values) {
  if (values.project !== undefined && !PROJECT_NAME.test(values.project)) {
    throw usageError('--project must match /^[a-z0-9_-]+$/i');
  }
  return values.project;
}

async function writeFileAtomic(path, content) {
  const fullPath = resolve(path);
  const temporary = join(
    dirname(fullPath),
    `.${basename(fullPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  try {
    await rename(temporary, fullPath);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
  return fullPath;
}

function withLedger(dbPath, operation) {
  const ledger = openUnifiedLedger(dbPath);
  try {
    return operation(ledger);
  } finally {
    ledger.close();
  }
}

function propose(values, defaultDbPath) {
  requireOptions(values, ['scope', 'topic', 'decision', 'by'], 'propose');
  const dbPath = requireDb(values, defaultDbPath, 'propose');
  return withLedger(dbPath, ledger => ledger.proposeDecision({
    scope: values.scope,
    topic: values.topic,
    decision: values.decision,
    rationale: values.rationale,
    applicability: values.applicability,
    proposedBy: values.by,
  }));
}

function approve(values, defaultDbPath) {
  requireOptions(values, ['id', 'by'], 'approve');
  const dbPath = requireDb(values, defaultDbPath, 'approve');
  return withLedger(dbPath, ledger => ledger.approveProposal(values.id, {
    approvedBy: values.by,
    supersedesId: values.supersedes,
  }));
}

function reject(values, defaultDbPath) {
  requireOptions(values, ['id', 'by'], 'reject');
  const dbPath = requireDb(values, defaultDbPath, 'reject');
  return withLedger(dbPath, ledger => ledger.rejectProposal(values.id, {
    rejectedBy: values.by,
    reason: values.reason,
  }));
}

function query(values, defaultDbPath) {
  const dbPath = requireDb(values, defaultDbPath, 'query');
  return withLedger(dbPath, ledger => ledger.queryRelevantDecisions({
    projectId: projectOption(values),
    areas: values.area,
    query: values.q,
  }));
}

function renderDecisionMarkdown(rows, maxChars = DEFAULT_MAX_CHARS) {
  const inline = text => text.replace(/\s+/g, ' ').trim();
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
  const blocks = [];
  for (const scope of scopeOrder) {
    const entries = byScope.get(scope).map(row => [
      `- **${inline(row.topic)}**: ${inline(row.decision)}`,
      row.rationale ? `  - Rationale: ${inline(row.rationale)}` : null,
      row.applicability ? `  - Applicability: ${inline(row.applicability)}` : null,
      `  - ID: \`${row.id}\` — approved by ${inline(row.approved_by)} at ${row.approved_at}`,
    ].filter(line => line !== null).join('\n')).join('\n');
    blocks.push({ scope, text: `\n## ${scope}\n\n${entries}\n` });
  }
  const full = header + blocks.map(block => block.text).join('');
  let markdown = full;
  let truncated = false;
  if (full.length > maxChars) {
    truncated = true;
    const included = [];
    let idsCount = 0;
    for (const block of blocks) {
      const shown = included.length + 1;
      const notice = `\n\n_Truncated: showing ${shown} of ${blocks.length} scope sections._\n`;
      if ((header + included.join('') + block.text + notice).length <= maxChars) {
        included.push(block.text);
        idsCount += 1;
      } else {
        break;
      }
    }
    if (included.length === 0) {
      markdown = full.slice(0, maxChars);
    } else {
      const notice = `\n\n_Truncated: showing ${idsCount} of ${blocks.length} scope sections._\n`;
      markdown = header + included.join('') + notice;
      if (markdown.length > maxChars) markdown = markdown.slice(0, maxChars);
    }
  }
  const digest = createHash('sha256').update(markdown).digest('hex');
  return { markdown, digest, truncated, total: rows.length };
}

async function exportLedger(values, defaultDbPath) {
  const dbPath = requireDb(values, defaultDbPath, 'export');
  const projectId = projectOption(values);
  const exported = withLedger(dbPath, ledger => {
    if (values.area === undefined) {
      return ledger.exportMarkdown({ projectId });
    }
    return renderDecisionMarkdown(ledger.queryRelevantDecisions({
      projectId,
      areas: values.area,
      limit: Number.MAX_SAFE_INTEGER,
    }));
  });
  if (values.out === undefined) return exported;
  const outPath = await writeFileAtomic(values.out, exported.markdown);
  return { ...exported, outPath };
}

function pending(values, defaultDbPath) {
  const dbPath = requireDb(values, defaultDbPath, 'pending');
  withLedger(dbPath, () => {});
  const db = new DatabaseSync(dbPath);
  try {
    return db.prepare(`SELECT * FROM decision_proposals
      WHERE status = 'pending'
      ORDER BY created_at ASC, rowid ASC`).all();
  } finally {
    db.close();
  }
}

async function executeDecisionsCli(argv, { defaultDbPath } = {}) {
  if (!Array.isArray(argv) || argv.some(value => typeof value !== 'string')) {
    throw usageError('argv must be an array of strings');
  }
  const [command, ...rest] = argv;
  if (command === undefined) throw usageError('missing command');
  if (!COMMANDS.has(command)) throw usageError(`unknown command: ${command}`);
  const values = parseCommandArgs(rest, command);
  let payload;
  if (command === 'propose') payload = propose(values, defaultDbPath);
  else if (command === 'approve') payload = approve(values, defaultDbPath);
  else if (command === 'reject') payload = reject(values, defaultDbPath);
  else if (command === 'query') payload = query(values, defaultDbPath);
  else if (command === 'pending') payload = pending(values, defaultDbPath);
  else payload = await exportLedger(values, defaultDbPath);
  return { command, values, payload };
}

export async function runDecisionsCli(argv, { defaultDbPath } = {}) {
  const { payload } = await executeDecisionsCli(argv, { defaultDbPath });
  return payload;
}

function oneLine(value) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
}

function humanOutput(command, payload) {
  if (command === 'propose') return `proposal ${payload.proposal_id} pending\n`;
  if (command === 'approve') return `decision ${payload.id} active\n`;
  if (command === 'reject') return `proposal ${payload.proposal_id} rejected\n`;
  if (command === 'query') {
    if (!payload.length) return 'no active decisions\n';
    return `${payload.map(row =>
      `- [${row.scope}] ${oneLine(row.topic)}: ${oneLine(row.decision)} (${row.id})`)
      .join('\n')}\n`;
  }
  if (command === 'pending') {
    if (!payload.length) return 'no pending proposals\n';
    return `${payload.map(row =>
      `- [${row.scope}] ${oneLine(row.topic)}: ${oneLine(row.decision)} (${row.proposal_id})`)
      .join('\n')}\n`;
  }
  if (payload.outPath !== undefined) {
    return `exported ${payload.total} decisions to ${payload.outPath}\ndigest: ${payload.digest}\n`;
  }
  return payload.markdown;
}

async function cli(argv) {
  try {
    if (argv[0] === 'help' || argv[0] === '--help' || argv[0] === '-h') {
      process.stdout.write(`${USAGE}\n`);
      return 0;
    }
    const { command, values, payload } = await executeDecisionsCli(argv);
    process.stdout.write(values.json
      ? `${JSON.stringify(payload, null, 2)}\n`
      : humanOutput(command, payload));
    return 0;
  } catch (error) {
    process.stderr.write(`df-decisions: ${error.message}\n`);
    return 2;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = await cli(process.argv.slice(2));
}
