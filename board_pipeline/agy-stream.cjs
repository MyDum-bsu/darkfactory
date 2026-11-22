'use strict';

const { execFile, spawn } = require('node:child_process');
const { once } = require('node:events');
const { promisify } = require('node:util');
const MODEL = 'gemini-4-neon';
const EFFORT = 'medium';
const LIMIT = 2 * 1024 * 1024;
const STEP_FIELDS = new Set(['conversation_id', 'step_index', 'state', 'step_type',
  'text_delta', 'duration_seconds', 'usage']);
const SAFE_STEPS = new Set(['user_input', 'agent_response', 'checkpoint']);
const INIT_FIELDS = new Set(['model', 'cwd', 'tools', 'permission_mode', 'agent', 'json_schema']);
const RESULT_FIELDS = new Set(['conversation_id', 'status', 'response', 'duration_seconds', 'num_turns', 'usage',
  'error', 'finished_reason', 'structured_output', 'json_schema']);
const SETTINGS = JSON.stringify({ toolPermission: 'request-review', permissions: { deny: [
  'read_file(*)', 'write_file(*)', 'command(*)', 'mcp(*)', 'read_url(*)', 'execute_url(*)', 'download_url(*)',
] } });

function error(reason) { return Object.assign(new Error(reason), { reason }); }

function monitorAgy(cwd) {
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
              !SAFE_STEPS.has(step?.step_type) || Object.keys(step).some(key => !STEP_FIELDS.has(key))) {
            throw error('review_tool_use_forbidden');
          }
          if (!Number.isSafeInteger(step.step_index) || step.step_index < 0 ||
              !['ACTIVE', 'DONE'].includes(step.state)) throw error('agy_stream_corrupt');
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
      return { text: result, actual: { provider: 'google', model: MODEL, reasoningLevel: EFFORT },
        evidence: { model: 'agy_stream_init', effort: 'agy_cli_request' } };
    },
  };
}

function parseAgyStream(stream, cwd) {
  const monitor = monitorAgy(cwd);
  if (Buffer.byteLength(stream) > LIMIT) throw error('agy_stream_too_large');
  for (const line of stream.trimEnd().split('\n')) monitor.push(line);
  return monitor.finish();
}

async function superviseAgy(child, settled, { cwd, onInit, emit, kill = () => child.kill('SIGKILL') }) {
  const monitor = monitorAgy(cwd);
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
    monitor.finish();
  } catch (cause) {
    kill();
    await settled.catch(() => {});
    throw cause;
  }
}

async function runAgy({ binary, cwd, env, prompt, timeoutMs, sealBootstrap }) {
  let version;
  try {
    version = await promisify(execFile)(binary, ['--version'], { cwd, env, timeout: 5000, maxBuffer: 4096 });
  } catch { throw error('agy_version_unattested'); }
  if (version.stdout.trim() !== '1.5.14') throw error('agy_version_unattested');
  const child = spawn(binary, ['--print', '', '--model', MODEL, '--effort', EFFORT,
    '--mode', 'plan', '--disable-slash-commands', '--settings', SETTINGS,
    '--input-format', 'stream-json', '--output-format', 'stream-json', '--print-timeout', '180s'],
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
    await superviseAgy(child, settled, { cwd, kill, emit: line => { stdout += line; },
      onInit: async () => {
        // Withhold every candidate byte until the startup-only tunnels are revoked.
        await sealBootstrap();
        child.stdin.end(`${JSON.stringify({ event: 'user', message: { content: prompt } })}\n`);
      } });
    return { code: 0, stdout, cwd };
  } catch (cause) {
    let reason = cause.reason ?? 'agy_transport_failed';
    if (timedOut) reason = 'agy_timeout';
    else if (['agy_incomplete_turn', 'agy_process_failed'].includes(reason) &&
        /authentication required|authentication failed/i.test(diagnostic)) reason = 'agy_auth_unavailable';
    return { code: 1, stdout: '', stderr: reason, cwd };
  } finally {
    clearTimeout(deadline);
    kill();
  }
}

module.exports = { parseAgyStream, runAgy, superviseAgy };
