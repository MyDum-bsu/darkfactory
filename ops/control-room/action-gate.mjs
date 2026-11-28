import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { closeSync, constants as F, fstatSync, fsyncSync, openSync, writeSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { promisify } from 'node:util';

export const ACTIONS = Object.freeze(['pause', 'resume', 'kill', 'approve-red-stop', 'trigger-deploy-rollback']);
const ADDRESS = /^t[0-9a-z]{1,12}$/;
const NAME = /^df-[a-z0-9_-]{1,12}-[0-9a-f]{10}$/;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const matches = (pattern, value) => typeof value === 'string' && pattern.test(value);
const target = value => matches(ADDRESS, value) || matches(NAME, value);
const hash = s => createHash('sha256').update(s).digest();
const secret = () => randomBytes(32).toString('hex');
const exactKeys = (obj, keys) => obj && typeof obj === 'object' && !Array.isArray(obj) &&
  Object.keys(obj).length === keys.length && keys.every(key => Object.hasOwn(obj, key));

function fault(status, code) { return Object.assign(new Error(code), { status, code }); }
const denied = () => fault(403, 'forbidden');

// One O_APPEND write per JSONL record. Never open for truncation or follow a
// link/FIFO. Sync the intent *before* dispatch; a lone intent after a crash is
// an unknown outcome, not permission to retry. Directory is operator-private.
function auditWriter(path) {
  let last;
  return record => {
    const flags = F.O_WRONLY | F.O_APPEND | F.O_NOFOLLOW | F.O_NONBLOCK;
    let fd;
    try { fd = openSync(path, flags); }
    catch (err) {
      if (err.code !== 'ENOENT') throw err;
      fd = openSync(path, flags | F.O_CREAT | F.O_EXCL, 0o600);
      last = undefined; // confirmed new file, even on filesystems that reuse inode numbers
    }
    try {
      const stat = fstatSync(fd, { bigint: true });
      if (!stat.isFile() || stat.nlink !== 1n || stat.uid !== BigInt(process.getuid()) || (stat.mode & 0o077n)) {
        last = undefined;
        throw Error('unsafe audit file');
      }
      // A new, independently validated inode is normal after rename rotation.
      // Fail this click closed on in-place changes, then recheck on the next.
      if (last && stat.dev === last.dev && stat.ino === last.ino &&
          (stat.size !== last.size || stat.ctimeNs !== last.ctimeNs)) {
        last = stat;
        throw Error('audit log changed');
      }
      const bytes = Buffer.from(JSON.stringify(record) + '\n');
      if (writeSync(fd, bytes) !== bytes.length) throw Error('short audit write');
      fsyncSync(fd);
      last = fstatSync(fd, { bigint: true });
    } finally { closeSync(fd); }
  };
}

// hc has no suspend/continue verb. Stop/continue its registered program, NOT
// a client-supplied PID, shell, or process group. A pidfd survives PID reuse;
// re-attest the immutable hc address *after* opening it. Linux/Python 3.9+.
const PIDFD_SIGNAL = `
import json, os, signal, subprocess, sys
hc, address, task, attempt, created, pid, action = sys.argv[1:]
fd = os.pidfd_open(int(pid))
t = json.loads(subprocess.check_output([hc, 'get', '--json', '--', address], timeout=3))
if (t['address'], t['labels']['darkfactory.task'], t['labels']['darkfactory.attempt'], t['created_ms'], t['pid'], t['state']) != (address, task, attempt, int(created), int(pid), 'live'):
    sys.exit(1)
signal.pidfd_send_signal(fd, {'pause': signal.SIGSTOP, 'resume': signal.SIGCONT}[action])
`;

// Server-owned configuration only. The release controller (not hc or worker
// terminal text) owns release policy. Adapter ABI: VERB -- ADDRESS TASK ATTEMPT;
// exit zero + {"accepted":true} means it accepted that exact request. Without
// the owner-installed adapter, release actions are explicitly unavailable.
function dispatcher({ hcPath, releaseAdapter, exec }) {
  if (!isAbsolute(hcPath) || (releaseAdapter != null && !isAbsolute(releaseAdapter))) throw Error('absolute executables required');
  const run = (file, args) => exec(file, args, { shell: false, timeout: 6000, maxBuffer: 128 * 1024,
    env: { HOME: process.env.HOME, PATH: '/usr/local/bin:/usr/bin:/bin',
      ...Object.fromEntries(['XDG_RUNTIME_DIR', 'XDG_STATE_HOME', 'XDG_CONFIG_HOME'].filter(k => process.env[k]).map(k => [k, process.env[k]])) } });
  return async ({ action, session, task, attempt: expectedAttempt, address }) => {
    const get = async args => JSON.parse((await run(hcPath, args)).stdout);
    const t = await get(['get', '--json', '--', session ?? address]);
    const attempt = t?.labels?.['darkfactory.attempt'];
    const liveAction = ['kill', 'pause', 'resume'].includes(action);
    if (!matches(ADDRESS, t?.address) || (liveAction ? t.state !== 'live' : !['live', 'finished', 'retired'].includes(t.state)) ||
        (address !== undefined && t.address !== address) ||
        (session !== undefined && session !== (matches(ADDRESS, session) ? t.address : t.name)) ||
        t.labels?.['darkfactory.task'] !== task || !matches(ID, attempt) ||
        (expectedAttempt !== undefined && expectedAttempt !== attempt)) throw fault(409, 'target_mismatch');
    if (action === 'kill') {
      const done = await get(['kill', '--json', '--', t.address]);
      if (done?.state !== 'finished' || done.address !== t.address) throw Error('kill unconfirmed');
    } else if (action === 'pause' || action === 'resume') {
      if (!Number.isSafeInteger(t.pid) || t.pid <= 1 || !Number.isSafeInteger(t.created_ms) || t.created_ms < 0) {
        throw fault(409, 'target_mismatch');
      }
      await run('/usr/bin/python3', ['-I', '-c', PIDFD_SIGNAL, hcPath, t.address, task, attempt, String(t.created_ms), String(t.pid), action]);
    } else if (action === 'approve-red-stop' || action === 'trigger-deploy-rollback') {
      if (!releaseAdapter) throw fault(503, 'release_adapter_unavailable');
      const result = await run(releaseAdapter, [action, '--', t.address, task, attempt]);
      if (JSON.parse(result.stdout)?.accepted !== true) throw Error('release request not accepted');
    } else throw fault(400, 'invalid_action');
  };
}

export const header = (req, key) => req.headersDistinct[key]?.length === 1 ? req.headersDistinct[key][0] : undefined;
export function exactSite(req, requireOrigin) {
  // Neither Host, forwarded headers nor Origin determine the trusted endpoint.
  const host = `127.0.0.1${req.socket.localPort === 80 ? '' : ':' + req.socket.localPort}`;
  const h = req.headersDistinct;
  return req.socket.localAddress === '127.0.0.1' && header(req, 'host') === host &&
    ((!requireOrigin && !h.origin) || header(req, 'origin') === `http://${host}`) &&
    (!h['sec-fetch-site'] || ['same-origin', ...(!requireOrigin ? ['none'] : [])].includes(header(req, 'sec-fetch-site')));
}

async function readBody(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > 2048) { req.resume(); throw fault(413, 'body_too_large'); }
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks)); } catch { throw fault(400, 'invalid_json'); }
}

export function createActionGate({ auditPath, actor, token, hcPath = '/usr/local/bin/hc', releaseAdapter,
  exec = promisify(execFile), now = Date.now }) {
  if (!isAbsolute(auditPath) || !matches(ID, actor) || typeof token !== 'string' || token.trim().length < 16) {
    throw Error('private audit path, actor and operator token (16+ characters) required');
  }
  const credential = hash('Bearer ' + token), sessions = new Map();
  const dispatch = dispatcher({ hcPath, releaseAdapter, exec });
  const appendAudit = auditWriter(auditPath);
  // One denial budget for this loopback gate, not one allocation per attacker-
  // supplied identity. Never suppress authenticated action intents or outcomes.
  let denialReset = 0, denialCount = 0;
  function allowDenialAudit() {
    const at = now();
    if (at >= denialReset) { denialReset = at + 60_000; denialCount = 0; }
    if (denialCount >= 32) return false;
    denialCount++;
    return true;
  }
  return async function handle(req) {
    const login = req.url === '/api/action-session';
    const record = { clickId: randomUUID(), actor: 'unauthenticated', action: login ? 'login' : null, session: null, task: null };
    function audit(outcome, code) {
      try {
        appendAudit({ ...record, timestamp: new Date(now()).toISOString(), outcome, code });
      } catch { throw fault(503, 'audit_unavailable'); }
    }
    let started = false;
    try {
      let body, bodyError;
      try { body = await readBody(req); } catch (e) { bodyError = e; }
      // Log only bounded identifiers, never raw payloads, credentials or output.
      if (!login) {
        record.action = matches(ID, body?.action) ? body.action : null;
        record.session = target(body?.session) ? body.session : null;
        record.task = matches(ID, body?.task) ? body.task : null;
        record.attempt = matches(ID, body?.attempt) ? body.attempt : null;
        record.address = matches(ADDRESS, body?.address) ? body.address : null;
      }
      if (!exactSite(req, true)) throw denied();
      if (req.method !== 'POST') throw fault(405, 'post_required');
      if (!/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?$/i.test(header(req, 'content-type') ?? '')) throw fault(415, 'json_required');
      const bearer = header(req, 'authorization') ?? '';
      if (login) {
        if (!timingSafeEqual(credential, hash(bearer))) throw denied();
        record.actor = actor;
        if (bodyError) throw bodyError;
        if (!exactKeys(body, [])) throw fault(400, 'invalid_login');
        const sessionId = secret(), nonce = secret();
        if (sessions.size >= 128) sessions.delete(sessions.keys().next().value);
        audit('succeeded', 'authenticated');
        sessions.set('Bearer ' + sessionId, { nonce: hash(nonce), expires: now() + 900_000 });
        return { status: 200, body: { sessionId, nonce } };
      }
      const session = sessions.get(bearer);
      if (!session || now() >= session.expires) { sessions.delete(bearer); throw denied(); }
      record.actor = actor;
      if (!timingSafeEqual(session.nonce, hash(header(req, 'x-csrf-nonce') ?? ''))) throw denied();
      if (bodyError) throw bodyError;
      const bindings = ['session', 'address', 'attempt'].filter(k => Object.hasOwn(body ?? {}, k));
      if (!exactKeys(body, ['action', 'task', ...bindings]) || !ACTIONS.includes(body.action) || !record.task ||
          bindings.some(k => !record[k]) || (!record.session && !record.address) ||
          (matches(NAME, record.session) && !record.address && !record.attempt)) {
        throw fault(400, 'invalid_action');
      }
      audit('started', 'authorized'); started = true;
      await dispatch(body);
      audit('succeeded', 'accepted');
      return { status: 200, body: { ok: true } };
    } catch (err) {
      if (err.code === 'audit_unavailable') throw err;
      if (!started && !allowDenialAudit()) return { status: 429, body: { error: 'rate_limited' } };
      const known = Number.isInteger(err.status);
      const code = known ? err.code : 'action_unconfirmed';
      audit(started ? 'failed' : 'denied', code);
      return { status: known ? err.status : 502, body: { error: code } };
    }
  };
}
