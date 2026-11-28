#!/usr/bin/env node
// Enroll ONE exact channel on an operator-selected Board. The broker is a
// dedicated non-admin userId, never a worker credential. --reader may be
// repeated for observer/agent principals; without a pass they can only read.
// node ops/df-board-setup.mjs --dry-run --channel factory --broker df-controller
// --apply additionally requires --url. Use the Board administrator for setup.
// Then run the controller (not the worker) with the private broker credential,
// BOARD_URL at that mount, DF_STIGMERGY_CHANNEL= factory's exact channel and
// BOARD_PROFILE=arbiter (or deployer on a deployment slot). Keep `board` on its
// trusted PATH. Only the task owner can assign its card to a settlement profile.
// Workloads must not inherit the broker's token, CLI config/claims or SDK handle;
// issue createRolePass({role, channel, taskId, epoch, run}) in the broker instead.
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { checkChannel, cliRunner, roleActions, schemas } from '../board_pipeline/board-stigmergy.mjs';

const user = userId => {
  if (typeof userId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/.test(userId)) throw new Error('invalid_user_id');
  return { kind: 'user', userId };
};
function grantKey(grant, channel) {
  // Board expands a userId to {kind, userId, email:null} in its response.
  const ids = grant.principals.map(p => p.kind === 'user' ? `user:${p.userId}` : p.kind).sort();
  return JSON.stringify([ids, Array.isArray(grant.can[channel]) ? [...grant.can[channel]].sort() : grant.can[channel]]);
}
export async function setup(argv, { run } = {}) {
  const { values: v } = parseArgs({ args: argv, options: {
    'dry-run': { type: 'boolean' }, apply: { type: 'boolean' }, channel: { type: 'string' },
    broker: { type: 'string' }, reader: { type: 'string', multiple: true }, url: { type: 'string' },
  } });
  if (v.apply && v['dry-run']) throw new Error('choose_one_setup_mode');
  if (v.apply && (!v.url || !v.channel || !v.broker)) throw new Error('apply_requires_url_channel_broker');
  const channel = checkChannel(v.channel ?? 'darkfactory');
  const broker = user(v.broker ?? 'df-controller');
  const readers = [...new Set(v.reader)].sort().map(user);
  if (readers.some(r => r.userId === broker.userId)) throw new Error('broker_must_be_private');
  const grants = [{ principals: [{ kind: 'everyone' }], can: { [channel]: [] } },
    { principals: [broker], can: { [channel]: ['read', 'post', 'label'] } },
    ...(readers.length ? [{ principals: readers, can: { [channel]: ['read'] } }] : [])];
  const commands = Object.entries(schemas).map(([id, def]) => ['--as', 'owner', 'schemas', 'create', id, '--data', JSON.stringify(def)]);
  const plan = { channel, roles: roleActions, grants, schemas: commands };
  if (!v.apply) return { mode: 'dry-run', ...plan };

  run ??= cliRunner({ url: v.url });
  const { grants: existing } = await run(['--as', 'owner', 'grants', 'list']);
  const wanted = new Map(grants.map(g => [grantKey(g, channel), g]));
  const present = new Set();
  for (const grant of existing) {
    // The exact channel wins over all broader grants (including default g1).
    // Tied grants add permissions. Never accept or revoke an unknown tie.
    if (!Object.hasOwn(grant.can, channel)) continue;
    const key = grantKey(grant, channel);
    if (!wanted.has(key)) throw new Error('conflicting_exact_channel_grant');
    present.add(key);
  }
  for (const cmd of commands) await run(cmd); // identical version is a no-op; drift is fatal
  const missing = grants.filter(g => !present.has(grantKey(g, channel)));
  if (missing.length) await run(['--as', 'owner', 'grants', 'create', '--file', '-'], JSON.stringify(missing));
  return { mode: 'apply', ...plan, grantsCreated: missing.length };
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  setup(process.argv.slice(2)).then(result => console.log(JSON.stringify(result, null, 2)))
    .catch(e => { console.error(`df-board-setup: ${e.message}`); process.exitCode = 1; });
}
