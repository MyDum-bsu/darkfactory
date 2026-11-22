import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { boardActivation, createPilotSwitch, guardedEffect } from './pilot-gate.mjs';

const base = { scope: 'pilot', boardUrl: 'http://127.0.0.1:44100/api/board', channel: 'bgu-cabinet',
  owner: 'local:user:test', label: { key: 'automation', value: 'bgu' },
  route: { repoId: 'bgu-repo', checkProfile: 'bgu-verified', finish: 'verified' } };

test('live pilot is default-off and requires explicit owner, repo, profile, finish and activation', () => {
  assert.throws(() => boardActivation(base), { code: 'pilot_disabled' });
  const policy = { ...base, pilot: { enabled: true, killSwitch: '/operator/switch' } };
  assert.throws(() => boardActivation(policy), { code: 'pilot_live_not_authorized' });
  assert.throws(() => boardActivation({ ...policy, channel: 'other' }, { allowLive: true }), { code: 'pilot_route_not_allowed' });
  assert.throws(() => boardActivation({ ...policy, route: { ...base.route, finish: 'deployed' } }, { allowLive: true }),
    { code: 'pilot_route_not_allowed' });
  assert.throws(() => boardActivation({ ...policy, route: { ...base.route, repoId: '' } }, { allowLive: true }),
    { code: 'pilot_route_not_allowed' });
  assert.throws(() => boardActivation({ ...policy, questionGate: {} }, { allowLive: true }), { code: 'pilot_route_not_allowed' });
  assert.deepEqual(boardActivation(policy, { allowLive: true }).scope, {
    owner: 'local:user:test', channel: 'bgu-cabinet', repoId: 'bgu-repo', profileId: 'bgu-verified',
    finish: 'verified', label: { key: 'automation', value: 'bgu' },
  });
  assert.equal(boardActivation({ scope: 'isolated', boardUrl: 'http://127.0.0.1:44101/api/board', channel: 'pilot' }), null);
  assert.throws(() => boardActivation({ ...base, scope: 'isolated', channel: 'pilot' }), { code: 'pilot_route_not_allowed' });
});

test('read the private switch at the last effect boundary, fail closed on absence, stop and unsafe files', async t => {
  const root = await mkdtemp(join(tmpdir(), 'df-switch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'switch');
  const gate = await createPilotSwitch(file);
  let calls = 0;
  const work = guardedEffect(gate, async label => { calls++; return label; });
  await assert.rejects(work('absent'), { code: 'pilot_stopped' });
  await writeFile(file, 'run\n', { mode: 0o600 });
  assert.equal(await work('allowed'), 'allowed');
  await writeFile(file, 'stop\n');
  await assert.rejects(work('stopped'), { code: 'pilot_stopped' });
  await writeFile(file, 'run\n');
  await chmod(file, 0o644);
  await assert.rejects(work('mode'), { code: 'pilot_stopped' });
  await rm(file);
  await symlink(join(root, 'another'), file);
  await writeFile(join(root, 'another'), 'run\n', { mode: 0o600 });
  await assert.rejects(work('symlink'), { code: 'pilot_stopped' });
  assert.equal(calls, 1);
  const publicDir = join(root, 'public');
  await mkdir(publicDir);
  await chmod(publicDir, 0o755);
  await assert.rejects(createPilotSwitch(join(publicDir, 'switch')), { code: 'pilot_switch_invalid' });
});
