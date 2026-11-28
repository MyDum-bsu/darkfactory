// Board 0.54 grants name principals, NOT --as profiles, and `post` is not
// schema-specific. Keep the writer credential and this issuer on the trusted
// controller. Give a caller one bound pass, never `run`, the SDK or its token.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fail = code => { throw new Error(code); };
const record = x => x !== null && typeof x === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(x));
const deepFreeze = x => {
  if (x && typeof x === 'object') Object.values(Object.freeze(x)).forEach(deepFreeze);
  return x;
};
const str = maxLength => ({ type: 'string', minLength: 1, maxLength });
const sha = { ...str(40), minLength: 40 };
const schema = props => {
  const properties = { epoch: { type: 'integer', minimum: 0 }, ...props };
  return { type: 'object', properties, required: Object.keys(properties), additionalProperties: false };
};
export const schemas = deepFreeze({
  'df.submission@1': schema({ task_id: str(64), attempt_id: str(64), worker_thread_id: str(64), candidate_sha: sha }),
  'df.l2_verdict@1': schema({ sha, verdict: { enum: ['REVIEW_OK', 'REVIEW_BLOCKED', 'REVIEW_ESCALATE'] } }),
  'df.rework@1': schema({ reason: str(800) }),
  'df.deploy_receipt@1': schema({ sha, target: str(160), smoke: { enum: ['pass', 'fail'] } }),
  'df.owner_request@1': schema({ request: str(4000) }),
});
export const roleActions = deepFreeze({
  teamlead: ['assign'], worker: ['df.submission@1'], critic: ['df.l2_verdict@1', 'df.rework@1'],
  arbiter: ['complete', 'df.l2_verdict@1', 'df.rework@1'], deployer: ['complete', 'df.deploy_receipt@1'],
  owner: ['assign', 'df.owner_request@1'], pi: ['df.owner_request@1'],
});
export function requireRole(role, action) {
  if (!Object.hasOwn(roleActions, role) || !roleActions[role].includes(action)) fail('role_denied');
}
export function checkChannel(channel) {
  if (typeof channel !== 'string' || channel.length > 2048 || !/^[a-z0-9][a-z0-9_-]*(?:\/[a-z0-9][a-z0-9_-]*)*$/.test(channel)) fail('invalid_board_channel');
  return channel;
}

// execFile (no shell); do not echo argv, stderr or payloads to a public card.
export function cliRunner({ url, executable = 'board' }) {
  if (!url || !['http:', 'https:'].includes(new URL(url).protocol)) fail('explicit_board_url_required');
  return (args, input = '') => new Promise((resolve, reject) => {
    const child = execFile(executable, ['--url', url, '--json', ...args],
      { timeout: 30_000, maxBuffer: 2 ** 20 }, (error, out) => {
        if (error) return reject(new Error(`board_command_failed:${error.code ?? error.signal}`));
        try { resolve(JSON.parse(out)); } catch { reject(new Error('board_response_invalid')); }
      });
    child.stdin.on('error', e => { if (e.code !== 'EPIPE') reject(e); });
    child.stdin.end(input);
  });
}

// Normalize once before any await. Only JSON scalar fields reach the Board;
// do not stringify caller objects with custom serialization hooks.
function checkedData(id, data) {
  if (!Object.hasOwn(schemas, id) || !record(data)) fail('invalid_trace');
  const { properties, required } = schemas[id];
  if (Object.keys(data).length !== required.length) fail('invalid_trace');
  return Object.fromEntries(required.map(k => {
    const v = Object.getOwnPropertyDescriptor(data, k)?.value, rule = properties[k];
    if (rule.enum ? !rule.enum.includes(v) : rule.type === 'integer' ? !Number.isSafeInteger(v) || v < rule.minimum :
      typeof v !== 'string' || !v.trim() || !v.isWellFormed() || v.includes('\0') ||
      v.length < rule.minLength || v.length > rule.maxLength || ((k === 'sha' || k === 'candidate_sha') && !/^[0-9a-f]{40}$/.test(v))) fail('invalid_trace');
    return [k, v];
  }));
}
const evidenceKinds = deepFreeze({ 'df.submission@1': ['l1-tail.txt', 'diff-summary.txt'],
  'df.l2_verdict@1': ['verdict.json', 'l1-tail.txt'], 'df.rework@1': ['verdict.json', 'l1-tail.txt', 'diff-summary.txt'] });
function checkedFiles(schema, evidence) {
  if (!record(evidence)) fail('invalid_evidence');
  return Object.keys(evidence).sort().map(name => {
    const text = evidence[name];
    if (!evidenceKinds[schema]?.includes(name) || typeof text !== 'string' || !text.trim() ||
        Buffer.byteLength(text) > 4096 || text.includes('\0') || !text.isWellFormed()) fail('invalid_evidence');
    if (name === 'verdict.json' && !record(JSON.parse(text))) fail('invalid_evidence');
    return [name, text];
  });
}

// taskId cannot be parsed by `post` as a channel or CLI option. The Board
// thread read also binds it to the enrolled channel, not to caller metadata.
export function createRolePass({ role, channel, taskId, epoch: pinnedEpoch, run, completeHeld, guard }) {
  if (!Object.hasOwn(roleActions, role)) fail('role_denied');
  checkChannel(channel);
  if (typeof taskId !== 'string' || !/^(?:[1-9][0-9]*|msg_[0-9a-f-]+_[0-9]+)$/.test(taskId)) fail('invalid_task_id');
  if (!Number.isSafeInteger(pinnedEpoch) || pinnedEpoch < 0) fail('invalid_epoch');
  const as = ['--as', role];
  async function check(epoch, action) {
    if (epoch !== pinnedEpoch) fail('trace_scope_changed');
    const { message } = await run([...as, 'read', taskId, '--limit', '1']);
    if (message?.channel !== channel || message.id !== taskId || !message.task || message.task.epoch !== epoch) fail('trace_scope_changed');
    await guard?.(taskId, epoch, action);
  }
  return Object.freeze({
    async post(schema, payload, evidence = {}) {
      requireRole(role, schema);
      const data = checkedData(schema, payload), files = checkedFiles(schema, evidence);
      if (data.task_id !== undefined && data.task_id !== taskId) fail('trace_scope_changed');
      const key = 'df-' + createHash('sha256').update(JSON.stringify([channel, taskId, role, schema, data, files])).digest('hex');
      const argv = [...as, 'post', taskId, JSON.stringify(data), '--schema', schema, '--no-sync', '--idempotency-key', key];
      let dir;
      try {
        if (files.length) dir = await mkdtemp(join(tmpdir(), 'df-evidence-'));
        for (const [name, text] of files) {
          const path = join(dir, name);
          await writeFile(path, text, { flag: 'wx', mode: 0o600 });
          argv.push('--attach', path);
        }
        await check(data.epoch, schema);
        const result = await run(argv);
        // Board deduplicates by key, not by re-validating a retry's body.
        // Require the acknowledged typed reply (including its evidence) before
        // allowing a caller such as native complete to proceed to settlement.
        const m = result?.message, block = m?.blocks?.[0];
        if (m?.channel !== channel || m.re !== taskId || m.blocks?.length !== 1 ||
            `${block?.schema}@${block?.version}` !== schema ||
            JSON.stringify(checkedData(schema, block.data)) !== JSON.stringify(data) ||
            !Array.isArray(m.attachments) || m.attachments.length !== files.length ||
            files.some(([name, text]) => !m.attachments.some(a => a.name === name && a.size === Buffer.byteLength(text)))) {
          fail('trace_ack_mismatch');
        }
        return result;
      } finally { if (dir) await rm(dir, { recursive: true, force: true }); }
    },
    async assign(epoch, assignee = 'arbiter') {
      requireRole(role, 'assign');
      if (!['arbiter', 'deployer'].includes(assignee)) fail('invalid_settlement_profile');
      await check(epoch, 'assign');
      return run([...as, 'tasks', 'assign', taskId, assignee]);
    },
    async complete(epoch, receipt) {
      requireRole(role, 'complete');
      if (!completeHeld) fail('held_capability_required');
      const text = JSON.stringify(receipt);
      if (!record(receipt) || typeof text !== 'string' || text.length > 1000) fail('compact_receipt_required');
      const snapshot = JSON.parse(text);
      if (!record(snapshot)) fail('compact_receipt_required');
      await check(epoch, 'complete');
      return completeHeld(taskId, epoch, snapshot);
    },
  });
}
