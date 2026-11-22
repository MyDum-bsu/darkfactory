'use strict';

const { execFile, spawn } = require('node:child_process');
const { once } = require('node:events');
const { lstat, readFile, writeFile } = require('node:fs/promises');
const { join } = require('node:path');
const { isDeepStrictEqual, promisify } = require('node:util');
const { checkSnapshotTool, isSnapshotTool } = require('./agy-tools.cjs');
const MODEL = 'gemini-4-neon';
const EFFORT = 'medium';
const LIMIT = 2 * 1024 * 1024;
const STEP_FIELDS = new Set(['conversation_id', 'step_index', 'state', 'step_type',
  'text_delta', 'duration_seconds', 'usage', 'tool_name', 'tool_info']);
const SAFE_STEPS = new Set(['user_input', 'agent_response', 'checkpoint']);
const INIT_FIELDS = new Set(['model', 'cwd', 'tools', 'permission_mode', 'agent', 'json_schema']);
const RESULT_FIELDS = new Set(['conversation_id', 'status', 'response', 'duration_seconds', 'num_turns', 'usage',
  'error', 'finished_reason', 'structured_output', 'json_schema']);
const settings = (cwd, snapshotTools) => JSON.stringify({ toolPermission: 'request-review',
  ...(snapshotTools ? { trustedWorkspaces: [cwd] } : {}), permissions: { deny: [
    ...(!snapshotTools ? ['read_file(*)'] : []), 'write_file(*)', 'command(*)', 'mcp(*)',
    'read_url(*)', 'execute_url(*)', 'download_url(*)',
  ] } });

function error(reason) { return Object.assign(new Error(reason), { reason }); }

function trackSnapshotReads(cwd, enabled) {
  const pending = new Map();
  const reads = new Map();
  const successful = new Set();
  return {
    push(step) {
      const { step_index: index, tool_name: name, tool_info: info } = step;
      if (!enabled || !isSnapshotTool(name) || reads.has(index) ||
          (info?.name !== undefined && info.name !== name)) throw error('review_tool_use_forbidden');
      const prior = pending.get(index);
      if (prior && prior.name !== name) throw error('review_tool_use_forbidden');
      const args = info?.parameters;
      const checked = args === undefined ? null : checkSnapshotTool(cwd, name, args);
      if (prior?.path !== undefined && checked && prior.path !== checked.path) throw error('review_tool_use_forbidden');
      if (step.state === 'ACTIVE') {
        pending.set(index, checked ?? prior ?? { name });
        return;
      }
      if (!checked) throw error('review_tool_use_forbidden');
      pending.delete(index);
      reads.set(index, { stepIdx: index, ...checked });
      if (info.error == null) successful.add(index);
    },
    finish() {
      if (pending.size) throw error('agy_incomplete_turn');
      if (enabled && !successful.size) throw error('agy_snapshot_unread');
      const recorded = [...reads.values()];
      return { reads: recorded, verifiedReads: recorded.filter(read => successful.has(read.stepIdx)) };
    },
  };
}

function monitorAgy(cwd, { snapshotTools = false } = {}) {
  const reader = trackSnapshotReads(cwd, snapshotTools);
  let conversation;
  let result;
  let prompts = 0;
  let answered = false;
  return {
    push(line) {
      let event;
      try { event = JSON.parse(line); } catch { throw error('agy_stream_corrupt'); }
      if (result) throw error('agy_stream_extra_result');
      if (event === null || typeof event !== 'object' || Array.isArray(event) ||
          Object.keys(event).some(key => !['event', 'conversation_id', event.event].includes(key))) {
        throw error('review_tool_use_forbidden');
      }
      switch (event.event) {
        case 'init': {
          const { init } = event;
          if (conversation || typeof event.conversation_id !== 'string' || !event.conversation_id ||
              init?.model !== MODEL || init.cwd !== cwd || init.permission_mode !== 'request-review' ||
              !Array.isArray(init.tools) || !init.tools.every(tool => typeof tool === 'string') ||
              Object.keys(init).some(key => !INIT_FIELDS.has(key))) {
            throw error('agy_init_unattested');
          }
          conversation = event.conversation_id;
          break;
        }
        case 'step_update': {
          const step = event.step_update;
          if (!conversation || step?.conversation_id !== conversation ||
              Object.keys(step).some(key => !STEP_FIELDS.has(key))) throw error('review_tool_use_forbidden');
          if (!Number.isSafeInteger(step.step_index) || step.step_index < 0 ||
              !['ACTIVE', 'DONE'].includes(step.state)) throw error('agy_stream_corrupt');
          if (step.step_type === 'tool') { reader.push(step); break; }
          if (!SAFE_STEPS.has(step.step_type) || Object.hasOwn(step, 'tool_name') || Object.hasOwn(step, 'tool_info')) {
            throw error('review_tool_use_forbidden');
          }
          if (step.step_type === 'user_input' && step.state === 'DONE' && ++prompts !== 1) {
            throw error('agy_stream_extra_turn');
          }
          if (step.step_type === 'agent_response' && step.state === 'DONE') answered = true;
          break;
        }
        case 'result': {
          const reply = event.result;
          if (reply && Object.keys(reply).some(key => !RESULT_FIELDS.has(key))) {
            throw error('review_tool_use_forbidden');
          }
          if (!conversation || reply?.conversation_id !== conversation || prompts !== 1 || !answered ||
              reply.status !== 'SUCCESS' || reply.num_turns !== 1 ||
              typeof reply.response !== 'string' || !reply.response.trim()) throw error('agy_incomplete_turn');
          result = reply.response;
          break;
        }
        default:
          throw error('review_tool_use_forbidden');
      }
    },
    finish() {
      if (!result) throw error('agy_incomplete_turn');
      return { text: result, ...reader.finish(), actual: { provider: 'google', model: MODEL, reasoningLevel: EFFORT },
        evidence: { model: 'agy_stream_init', effort: 'agy_cli_request' } };
    },
  };
}

function parseAgyStream(stream, cwd, options) {
  const monitor = monitorAgy(cwd, options);
  if (Buffer.byteLength(stream) > LIMIT) throw error('agy_stream_too_large');
  for (const line of stream.trimEnd().split('\n')) monitor.push(line);
  return monitor.finish();
}

async function superviseAgy(child, settled, { cwd, onInit, emit, snapshotTools, kill = () => child.kill('SIGKILL') }) {
  const monitor = monitorAgy(cwd, { snapshotTools });
  let pending = '';
  let bytes = 0;
  let initialized = false;
  const acceptLine = async line => {
    monitor.push(line);
    emit(`${line}\n`);
    if (!initialized) {
      initialized = true;
      await onInit();
    }
  };
  try {
    child.stdout.setEncoding('utf8');
    for await (const chunk of child.stdout) {
      bytes += Buffer.byteLength(chunk);
      if (bytes > LIMIT) throw error('agy_stream_too_large');
      pending += chunk;
      let end;
      while ((end = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        await acceptLine(line);
      }
    }
    if (pending) await acceptLine(pending);
    if ((await settled)[0] !== 0) throw error('agy_process_failed');
    return monitor.finish();
  } catch (cause) {
    kill();
    await settled.catch(() => {});
    throw cause;
  }
}

async function guardedReads(boundary, observed) {
  const path = join(boundary.events, 'reads.ndjson');
  const st = await lstat(path).catch(() => null);
  if (!st?.isFile() || st.size > LIMIT) throw error('agy_snapshot_tool_proof_missing');
  const entries = (await readFile(path, 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line));
  const byStep = (a, b) => a.stepIdx - b.stepIdx;
  if (!isDeepStrictEqual(entries.sort(byStep), [...observed].sort(byStep))) {
    throw error('agy_snapshot_tool_proof_mismatch');
  }
}

async function failureReason(cause, boundary, diagnostic, timedOut) {
  if (boundary && await lstat(join(boundary.events, 'forbidden')).catch(() => null)) return 'review_tool_use_forbidden';
  if (diagnostic.split('\n').includes('agy_snapshot_sandbox_unavailable')) return 'agy_snapshot_sandbox_unavailable';
  if (timedOut) return 'agy_timeout';
  const reason = cause.reason ?? 'agy_transport_failed';
  return ['agy_incomplete_turn', 'agy_process_failed'].includes(reason) &&
    /authentication required|authentication failed/i.test(diagnostic) ? 'agy_auth_unavailable' : reason;
}

async function deliverPrompt(child, { boundary, sealBootstrap, beforeEffect, publishSnapshot, prompt }) {
  // No candidate data is present in Agy's cwd while bootstrap is authorized.
  if (boundary) await writeFile(join(boundary.control, 'group'), String(child.pid), { mode: 0o400, flag: 'wx' });
  await sealBootstrap();
  await beforeEffect?.();
  if (boundary) {
    await publishSnapshot();
    await beforeEffect?.();
  }
  child.stdin.end(`${JSON.stringify({ event: 'user', message: { content: prompt } })}\n`);
}

async function runAgy({ binary, cwd, env, prompt, timeoutMs, sealBootstrap, beforeEffect, boundary, publishSnapshot }) {
  let version;
  try {
    version = await promisify(execFile)(binary, ['--version'], { cwd, env, timeout: 5000, maxBuffer: 4096 });
  } catch { throw error('agy_version_unattested'); }
  if (version.stdout.trim() !== '1.5.14') throw error('agy_version_unattested');
  await beforeEffect?.();
  const args = ['--print', '', '--model', MODEL, '--effort', EFFORT,
    '--mode', 'plan', '--disable-slash-commands', '--settings', settings(cwd, Boolean(boundary)),
    '--input-format', 'stream-json', '--output-format', 'stream-json', '--print-timeout', '180s'];
  const command = boundary ? '/usr/bin/python3' : binary;
  const child = spawn(command, boundary ? [boundary.launcher, JSON.stringify({ ...boundary, binary }), ...args] : args,
    { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const settled = once(child, 'close');
  settled.catch(() => {});
  const kill = () => {
    if (!child.pid) return;
    try { process.kill(-child.pid, 'SIGKILL'); } catch (cause) { if (cause.code !== 'ESRCH') throw cause; }
  };
  let diagnostic = '';
  let stdout = '';
  let timedOut = false;
  const deadline = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-4096); });
  child.stdin.on('error', kill);
  try {
    const observed = await superviseAgy(child, settled, { cwd, kill, snapshotTools: Boolean(boundary),
      emit: line => { stdout += line; },
      onInit: () => deliverPrompt(child, { boundary, sealBootstrap, beforeEffect, publishSnapshot, prompt }) });
    if (boundary) await guardedReads(boundary, observed.reads);
    return { code: 0, stdout, cwd };
  } catch (cause) {
    return { code: 1, stdout: '', stderr: await failureReason(cause, boundary, diagnostic, timedOut), cwd };
  } finally {
    clearTimeout(deadline);
    kill();
  }
}

module.exports = { parseAgyStream, runAgy, superviseAgy };
