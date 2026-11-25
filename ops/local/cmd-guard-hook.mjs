#!/usr/bin/env node
// Hook and CLI adapter for the deterministic command guard. The wrapper is
// intentionally dependency-free and fail-closed: malformed input, oversized
// payloads, or parser failure deny the command instead of letting it run.

import { pathToFileURL } from 'node:url';
import * as guard from '../../board_pipeline/cmd-guard.mjs';

const MAX_PAYLOAD_BYTES = 1024 * 1024;
const HOOK_TIMEOUT_MS = 200;
const SHELL_TOOLS = new Set([
  'shell', 'bash', 'sh', 'command', 'exec', 'execute_command', 'run_command',
  'run-shell-command', 'terminal', 'process', 'cmd',
]);

function normalizeGuardResult(result) {
  if (!result || typeof result !== 'object') {
    return { decision: 'deny', severity: 'CRITICAL', rule: 'guard_error',
      reason: 'command guard returned no inspection result' };
  }
  const blocked = result.decision === 'block' || result.decision === 'deny' || result.blocked === true;
  const severity = String(result.severity ?? (blocked ? 'critical' : 'allow')).toUpperCase();
  if (!blocked) return { decision: 'allow' };
  return {
    decision: 'deny',
    severity,
    rule: typeof result.rule === 'string' ? result.rule : 'blocked',
    reason: typeof result.reason === 'string' && result.reason
      ? result.reason
      : 'command rejected by deterministic safety policy',
  };
}

export function inspectCommand(command, options = {}) {
  try {
    const inspect = typeof guard.inspectCommand === 'function'
      ? guard.inspectCommand
      : guard.checkCommand;
    return normalizeGuardResult(inspect(command, { timeoutMs: HOOK_TIMEOUT_MS, ...options }));
  } catch (error) {
    return { decision: 'deny', severity: 'CRITICAL', rule: 'guard_error',
      reason: `command guard failed closed: ${error.message}` };
  }
}

function commandFromValue(value) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  for (const key of ['command', 'cmd', 'input', 'script']) {
    if (typeof value[key] === 'string') return value[key];
  }
  if (Array.isArray(value.argv) && value.argv.every(part => typeof part === 'string')) {
    return value.argv.join(' ');
  }
  return null;
}

export function extractHookCommand(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { command: null, applies: true };
  }
  if (typeof payload.command === 'string') return { command: payload.command, applies: true };
  const toolCall = payload.toolCall ?? payload.tool_call ?? null;
  if (!toolCall || typeof toolCall !== 'object') return { command: null, applies: true };
  const name = typeof toolCall.name === 'string' ? toolCall.name : '';
  const applies = SHELL_TOOLS.has(name) || SHELL_TOOLS.has(name.toLowerCase());
  return { command: applies ? commandFromValue(toolCall.args) : null, applies };
}

async function readStdinBounded(timeoutMs = HOOK_TIMEOUT_MS) {
  if (process.stdin.isTTY) return '';
  let timer = null;
  try {
    return await Promise.race([
      (async () => {
        const chunks = [];
        let total = 0;
        for await (const chunk of process.stdin) {
          total += chunk.length;
          if (total > MAX_PAYLOAD_BYTES) throw new Error('oversized hook payload');
          chunks.push(chunk);
        }
        return Buffer.concat(chunks).toString('utf8');
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          process.stdin.destroy();
          reject(new Error('hook payload read timeout'));
        }, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function runCli(argv = process.argv.slice(2), io = process) {
  const failClosed = reason => {
    io.stdout.write(`${JSON.stringify({ decision: 'deny', severity: 'CRITICAL',
      rule: 'hook_input', reason })}\n`);
    return 2;
  };

  if (argv[0] === '--check') {
    const command = argv.slice(1).join(' ');
    if (!command.trim()) return failClosed('missing command for --check');
    const result = inspectCommand(command);
    io.stdout.write(`${JSON.stringify(result)}\n`);
    return result.decision === 'deny' ? 2 : 0;
  }

  if (argv[0] === '--stdin-json') {
    let payload;
    try {
      const text = await readStdinBounded();
      payload = JSON.parse(text);
    } catch (error) {
      return failClosed(`invalid hook payload: ${error.message}`);
    }
    const extracted = extractHookCommand(payload);
    if (!extracted.applies) {
      io.stdout.write('{"decision":"allow"}\n');
      return 0;
    }
    if (typeof extracted.command !== 'string' || !extracted.command.trim()) {
      return failClosed('shell tool payload does not contain a command string');
    }
    const result = inspectCommand(extracted.command);
    io.stdout.write(`${JSON.stringify(result)}\n`);
    return result.decision === 'deny' ? 2 : 0;
  }

  io.stderr.write('use: cmd-guard-hook.mjs --stdin-json | --check "<command>"\n');
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const code = await runCli();
  process.exitCode = code;
}
