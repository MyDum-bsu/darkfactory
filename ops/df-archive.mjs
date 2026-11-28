#!/usr/bin/env node
// df-archive — operator CLI for the local Session Archive.

import { createHash } from 'node:crypto';
import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  DEFAULT_EMBED_BATCH,
  DEFAULT_EMBED_MODEL,
  configuredArchiveEmbedder,
  extractTranscriptMeta,
  importDevinSqlite,
  importOpencodeSqlite,
  inferSessionProject,
  openSessionArchive,
  parseAgyTranscript,
  parseClaudeTranscript,
  parseCodexTranscript,
  parseDevinTranscript,
  parseOmpTranscript,
  parsePiTranscript,
} from '../board_pipeline/session-archive.mjs';

const USAGE = `usage:
  node ops/df-archive.mjs ingest --db PATH --file TRANSCRIPT --harness agy|pi|omp|codex|claude|devin --host HOST [--cwd SESSION_CWD] [--project FALLBACK] [--session-id ID] [--title TITLE] [--include-system] [--json]
  node ops/df-archive.mjs import-db --db PATH --source SQLITE --harness devin|opencode|zcode --host HOST [--project FALLBACK] [--since ISO] [--limit N] [--include-system] [--json]
  node ops/df-archive.mjs embed --db PATH [--batch N] [--model NAME] [--best-effort] [--json]
  node ops/df-archive.mjs search --db PATH --query QUERY [--mode auto|fts|hybrid] [--model NAME] [--host HOST] [--project PROJECT] [--harness HARNESS] [--limit N] [--json]
  node ops/df-archive.mjs stats --db PATH [--json]`;

const COMMANDS = new Set(['ingest', 'import-db', 'embed', 'search', 'stats']);
const COMMAND_OPTIONS = {
  ingest: new Set(['db', 'file', 'harness', 'host', 'project', 'cwd', 'session-id', 'title', 'include-system', 'json']),
  'import-db': new Set(['db', 'source', 'harness', 'host', 'project', 'since', 'limit', 'include-system', 'json']),
  embed: new Set(['db', 'batch', 'model', 'best-effort', 'json']),
  search: new Set(['db', 'query', 'mode', 'model', 'host', 'project', 'harness', 'limit', 'json']),
  stats: new Set(['db', 'json']),
};
const BOOLEAN_OPTIONS = new Set(['json', 'best-effort', 'include-system']);
const PARSERS = { agy: parseAgyTranscript, pi: parsePiTranscript, omp: parseOmpTranscript, codex: parseCodexTranscript,
  claude: parseClaudeTranscript, devin: parseDevinTranscript };
const IMPORTERS = { devin: importDevinSqlite, opencode: importOpencodeSqlite, zcode: importOpencodeSqlite };
const HARNESSES = [...new Set([...Object.keys(PARSERS), ...Object.keys(IMPORTERS)])];
const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;

function usageError(message) {
  return new Error(`df_archive_usage: ${message}`);
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
    if (Object.hasOwn(values, key)) throw usageError(`duplicate option --${key}`);
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
    values[key] = value;
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

function requireHarness(value, allowed) {
  if (!allowed.includes(value)) throw usageError(`--harness must be one of ${allowed.join(', ')}`);
  return value;
}

function parseLimit(value, max = 1000) {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) throw usageError('--limit must be a positive integer');
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > max) {
    throw usageError(`--limit must be between 1 and ${max}`);
  }
  return limit;
}

function derivedSessionId({ harness, host, project, canonicalPath }) {
  const digest = createHash('sha256')
    .update([harness, host, project, canonicalPath].join('\0'), 'utf8')
    .digest('hex')
    .slice(0, 24);
  return `${harness}-${digest}`;
}

async function regularInput(path, kind) {
  const check = async name => {
    const info = await lstat(name);
    if (!info.isFile()) throw new Error(`df_archive_${kind}_not_file: input ${kind} must be a regular file`);
    if (kind === 'transcript' && info.size > MAX_TRANSCRIPT_BYTES) {
      throw new Error('df_archive_transcript_too_large: input transcript exceeds 64 MiB');
    }
    return info;
  };
  await check(path);
  const canonicalPath = await realpath(path);
  const info = await check(canonicalPath);
  return { canonicalPath, info };
}

async function ingest(values, defaultDbPath) {
  requireOptions(values, ['file', 'harness', 'host'], 'ingest');
  const dbPath = requireDb(values, defaultDbPath, 'ingest');
  const harness = requireHarness(values.harness, Object.keys(PARSERS));
  const { canonicalPath } = await regularInput(resolve(values.file), 'transcript');
  const jsonl = await readFile(canonicalPath, 'utf8');
  const messages = PARSERS[harness](jsonl, { includeSystem: values['include-system'] });
  if (messages.length === 0) {
    throw new Error('df_archive_transcript_empty: no ingestible messages found');
  }
  const meta = extractTranscriptMeta(harness, jsonl);
  const cwd = values.cwd ?? meta.cwd;
  const title = values.title ?? meta.title;
  const project = inferSessionProject({ cwd, title, fallback: values.project });
  const timestamps = messages.map(message => message.createdAt).filter(Boolean);
  const sessionId = values['session-id'] ?? meta.sessionId ?? derivedSessionId({
    harness,
    host: values.host,
    project: values.project ?? '', // keep existing explicit-project IDs stable across retagging
    canonicalPath,
  });
  const archive = openSessionArchive(dbPath);
  try {
    return archive.ingestSession({
      sessionId,
      host: values.host,
      harness,
      project, cwd, title,
      startedAt: timestamps[0],
      updatedAt: timestamps.at(-1),
      messages,
    });
  } finally {
    archive.close();
  }
}

async function importDb(values, defaultDbPath) {
  requireOptions(values, ['source', 'harness', 'host'], 'import-db');
  const harness = requireHarness(values.harness, Object.keys(IMPORTERS));
  const dbPath = requireDb(values, defaultDbPath, 'import-db');
  const limit = parseLimit(values.limit, Number.MAX_SAFE_INTEGER);
  const { canonicalPath: sourceDbPath, info } = await regularInput(resolve(values.source), 'source');
  // Compare inodes before opening the archive (which would change mode and
  // initialize its schema), including hard links and symlinked destinations.
  const destination = dbPath === ':memory:' ? dbPath : resolve(dbPath);
  if (destination !== ':memory:') {
    try {
      const dest = await stat(destination);
      if (dest.dev === info.dev && dest.ino === info.ino) throw usageError('--source and --db must be different files');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const archive = openSessionArchive(destination);
  try {
    return IMPORTERS[harness]({ archive, sourceDbPath, harness, host: values.host, fallbackProject: values.project,
      since: values.since, limit, includeSystem: values['include-system'] });
  } finally { archive.close(); }
}

async function embed(values, defaultDbPath, embedder) {
  const dbPath = requireDb(values, defaultDbPath, 'embed');
  const batchSize = values.batch === undefined ? DEFAULT_EMBED_BATCH : Number(values.batch);
  if ((values.batch !== undefined && !/^\d+$/.test(values.batch)) || batchSize < 1 || batchSize > 128) {
    throw usageError('--batch must be an integer between 1 and 128');
  }
  const model = values.model?.trim() ?? DEFAULT_EMBED_MODEL;
  if (embedder === undefined) embedder = configuredArchiveEmbedder(model, 'RETRIEVAL_DOCUMENT');
  if (embedder === null) {
    if (values['best-effort']) return { embedded: 0, skipped: true, reason: 'embedder_unconfigured' };
    throw new Error('df_archive_embedder_unconfigured');
  }
  const archive = openSessionArchive(dbPath, { embedder });
  try {
    return await archive.embedPending({ batchSize, model });
  } finally {
    archive.close();
  }
}

async function search(values, defaultDbPath, embedder) {
  requireOptions(values, ['query'], 'search');
  const dbPath = requireDb(values, defaultDbPath, 'search');
  const input = {
    query: values.query,
    limit: parseLimit(values.limit),
    mode: values.mode ?? 'fts',
  };
  if (!['auto', 'fts', 'hybrid'].includes(input.mode)) throw usageError('--mode must be auto, fts or hybrid');
  if (values.model !== undefined) input.queryModel = values.model.trim();
  if (input.mode !== 'fts' && embedder === undefined) {
    input.queryModel ??= DEFAULT_EMBED_MODEL;
    embedder = configuredArchiveEmbedder(input.queryModel, 'RETRIEVAL_QUERY');
  }
  if (input.mode === 'hybrid' && embedder === null) throw new Error('df_archive_embedder_unconfigured');
  if (values.harness !== undefined) requireHarness(values.harness, HARNESSES);
  for (const key of ['host', 'project', 'harness']) {
    if (values[key] !== undefined) input[key] = values[key];
  }
  if (input.limit === undefined) delete input.limit;
  const archive = openSessionArchive(dbPath, { embedder });
  try {
    return await archive.search(input);
  } finally {
    archive.close();
  }
}

function stats(values, defaultDbPath) {
  const dbPath = requireDb(values, defaultDbPath, 'stats');
  const archive = openSessionArchive(dbPath);
  try {
    return archive.stats();
  } finally {
    archive.close();
  }
}

async function executeArchiveCli(argv, { defaultDbPath, embedder } = {}) {
  if (!Array.isArray(argv) || argv.some(value => typeof value !== 'string')) {
    throw usageError('argv must be an array of strings');
  }
  const [command, ...rest] = argv;
  if (command === undefined) throw usageError('missing command');
  if (!COMMANDS.has(command)) throw usageError(`unknown command: ${command}`);
  const values = parseCommandArgs(rest, command);
  let payload;
  if (command === 'ingest') payload = await ingest(values, defaultDbPath);
  else if (command === 'import-db') payload = await importDb(values, defaultDbPath);
  else if (command === 'embed') payload = await embed(values, defaultDbPath, embedder);
  else if (command === 'search') payload = await search(values, defaultDbPath, embedder);
  else payload = stats(values, defaultDbPath);
  return { command, values, payload };
}

export async function runArchiveCli(argv, options = {}) {
  const { payload } = await executeArchiveCli(argv, options);
  return payload;
}

function oneLine(value) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
}

function humanOutput(command, payload) {
  if (command === 'ingest') {
    return `ingested ${payload.sessionId}: +${payload.insertedMessages} messages (${payload.messageCount} total)\n`;
  }
  if (command === 'import-db') {
    return `imported ${payload.ingestedSessions}/${payload.scannedSessions} ${payload.harness} sessions ` +
      `(${payload.skippedEmpty} empty): +${payload.insertedMessages} messages (${payload.totalMessages} total)\n`;
  }
  if (command === 'search') {
    if (!payload.length) return 'no matches\n';
    return `${payload.map(row => [
      row.rank,
      `${row.host}/${row.project ?? '-'}`,
      `${row.sessionId}#${row.seq}`,
      row.role,
      oneLine(row.snippet),
    ].join('\t')).join('\n')}\n`;
  }
  return `${Object.entries(payload).map(([key, value]) => `${key}: ${value}`).join('\n')}\n`;
}

async function cli(argv) {
  try {
    if (argv[0] === 'help' || argv[0] === '--help' || argv[0] === '-h') {
      process.stdout.write(`${USAGE}\n`);
      return 0;
    }
    const { command, values, payload } = await executeArchiveCli(argv);
    process.stdout.write(values.json
      ? `${JSON.stringify(payload, null, 2)}\n`
      : humanOutput(command, payload));
    return 0;
  } catch (error) {
    process.stderr.write(`df-archive: ${error.message}\n`);
    return 2;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = await cli(process.argv.slice(2));
}
