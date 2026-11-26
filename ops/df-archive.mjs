#!/usr/bin/env node
// df-archive — operator CLI for the local Session Archive.

import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  openSessionArchive,
  parseAgyTranscript,
  parsePiTranscript,
} from '../board_pipeline/session-archive.mjs';

const USAGE = `usage:
  node ops/df-archive.mjs ingest --db PATH --file JSONL --harness agy|pi --host HOST --project PROJECT [--session-id ID] [--title TITLE] [--json]
  node ops/df-archive.mjs search --db PATH --query QUERY [--host HOST] [--project PROJECT] [--harness HARNESS] [--limit N] [--json]
  node ops/df-archive.mjs stats --db PATH [--json]`;

const COMMANDS = new Set(['ingest', 'search', 'stats']);
const COMMAND_OPTIONS = {
  ingest: new Set(['db', 'file', 'harness', 'host', 'project', 'session-id', 'title', 'json']),
  search: new Set(['db', 'query', 'host', 'project', 'harness', 'limit', 'json']),
  stats: new Set(['db', 'json']),
};
const BOOLEAN_OPTIONS = new Set(['json']);
const HARNESSES = new Set(['agy', 'pi']);

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

function requireHarness(value, optionName = '--harness') {
  if (!HARNESSES.has(value)) throw usageError(`${optionName} must be agy or pi`);
  return value;
}

function parseLimit(value) {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) throw usageError('--limit must be a positive integer');
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
    throw usageError('--limit must be between 1 and 1000');
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

async function ingest(values, defaultDbPath) {
  requireOptions(values, ['file', 'harness', 'host', 'project'], 'ingest');
  const dbPath = requireDb(values, defaultDbPath, 'ingest');
  const harness = requireHarness(values.harness);
  const inputPath = resolve(values.file);
  const canonicalPath = await realpath(inputPath);
  const jsonl = await readFile(canonicalPath, 'utf8');
  const messages = harness === 'agy' ? parseAgyTranscript(jsonl) : parsePiTranscript(jsonl);
  if (messages.length === 0) {
    throw new Error('df_archive_transcript_empty: no ingestible messages found');
  }
  const timestamps = messages.map(message => message.createdAt).filter(Boolean);
  const sessionId = values['session-id'] ?? derivedSessionId({
    harness,
    host: values.host,
    project: values.project,
    canonicalPath,
  });
  const archive = openSessionArchive(dbPath);
  try {
    return archive.ingestSession({
      sessionId,
      host: values.host,
      harness,
      project: values.project,
      title: values.title,
      startedAt: timestamps[0],
      updatedAt: timestamps.at(-1),
      messages,
    });
  } finally {
    archive.close();
  }
}

async function search(values, defaultDbPath) {
  requireOptions(values, ['query'], 'search');
  const dbPath = requireDb(values, defaultDbPath, 'search');
  const input = {
    query: values.query,
    limit: parseLimit(values.limit),
    mode: 'fts',
  };
  for (const key of ['host', 'project', 'harness']) {
    if (values[key] !== undefined) input[key] = values[key];
  }
  if (input.limit === undefined) delete input.limit;
  const archive = openSessionArchive(dbPath);
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

async function executeArchiveCli(argv, { defaultDbPath } = {}) {
  if (!Array.isArray(argv) || argv.some(value => typeof value !== 'string')) {
    throw usageError('argv must be an array of strings');
  }
  const [command, ...rest] = argv;
  if (command === undefined) throw usageError('missing command');
  if (!COMMANDS.has(command)) throw usageError(`unknown command: ${command}`);
  const values = parseCommandArgs(rest, command);
  let payload;
  if (command === 'ingest') payload = await ingest(values, defaultDbPath);
  else if (command === 'search') payload = await search(values, defaultDbPath);
  else payload = stats(values, defaultDbPath);
  return { command, values, payload };
}

export async function runArchiveCli(argv, { defaultDbPath } = {}) {
  const { payload } = await executeArchiveCli(argv, { defaultDbPath });
  return payload;
}

function oneLine(value) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
}

function humanOutput(command, payload) {
  if (command === 'ingest') {
    return `ingested ${payload.sessionId}: +${payload.insertedMessages} messages (${payload.messageCount} total)\n`;
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
