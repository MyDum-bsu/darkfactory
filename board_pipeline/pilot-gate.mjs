import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { checkChannel } from './board-stigmergy.mjs';

const LOOPBACK_BOARD = /^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/api\/board$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const RUN = Buffer.from('run\n');
const isId = value => typeof value === 'string' && ID.test(value);

export class PilotDenied extends Error {
  constructor(code, options) {
    super(code, options);
    this.code = code;
  }
}

export function boardActivation(policy, { allowLive = false, pilotChannel } = {}) {
  const { scope, boardUrl, channel, owner, label, route, pilot, questionGate } = policy;
  if (!LOOPBACK_BOARD.test(boardUrl ?? '')) throw new PilotDenied('pilot_route_not_allowed');
  let url;
  try { url = new URL(boardUrl); } catch (cause) { throw new PilotDenied('pilot_route_not_allowed', { cause }); }
  const live = url.port === '44100';
  if (scope === 'isolated') {
    if (live || channel !== 'pilot') throw new PilotDenied('pilot_route_not_allowed');
    return null;
  }
  try { checkChannel(pilotChannel); }
  catch (cause) { throw new PilotDenied('pilot_route_not_allowed', { cause }); }
  if (scope !== 'pilot' || pilotChannel.length > 128 || channel !== pilotChannel || !isId(owner) ||
      !isId(label?.key) || label.key.startsWith('factory.') ||
      typeof label?.value !== 'string' || !label.value || label.value.length > 128 ||
      !isId(route?.repoId) || !isId(route?.checkProfile) ||
      route?.finish !== 'verified' || route.taskId !== undefined || questionGate !== undefined) {
    throw new PilotDenied('pilot_route_not_allowed');
  }
  if (pilot?.enabled !== true) throw new PilotDenied('pilot_disabled');
  if (live && allowLive !== true) throw new PilotDenied('pilot_live_not_authorized');
  if (!isAbsolute(pilot.killSwitch ?? '')) throw new PilotDenied('pilot_switch_invalid');
  return { live, killSwitch: pilot.killSwitch,
    scope: { owner, channel, repoId: route.repoId, profileId: route.checkProfile, finish: 'verified',
      label: { key: label.key, value: label.value } } };
}

function privateDirectory(st) {
  return st.isDirectory() && st.uid === process.getuid() && (st.mode & 0o077) === 0;
}

export async function createPilotSwitch(path, { permitDirectory = () => true } = {}) {
  if (!isAbsolute(path)) throw new PilotDenied('pilot_switch_invalid');
  const directory = await realpath(dirname(path)).catch(cause => {
    throw new PilotDenied('pilot_switch_invalid', { cause });
  });
  if (directory !== dirname(path) || !permitDirectory(directory)) {
    throw new PilotDenied('pilot_switch_invalid');
  }
  const identity = await lstat(directory);
  if (!privateDirectory(identity)) throw new PilotDenied('pilot_switch_invalid');
  const switchFile = join(directory, basename(path));
  return async function assertOpen() {
    try {
      const current = await lstat(directory);
      if (!privateDirectory(current) || current.dev !== identity.dev || current.ino !== identity.ino) {
        throw new PilotDenied('pilot_stopped');
      }
      const file = await open(switchFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const st = await file.stat();
        if (!st.isFile() || st.uid !== identity.uid || st.nlink !== 1 || (st.mode & 0o077) || st.size !== RUN.length) {
          throw new PilotDenied('pilot_stopped');
        }
        const bytes = Buffer.alloc(RUN.length + 1);
        const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
        if (bytesRead !== RUN.length || !bytes.subarray(0, bytesRead).equals(RUN)) throw new PilotDenied('pilot_stopped');
      } finally { await file.close(); }
    } catch (cause) {
      if (cause instanceof PilotDenied) throw cause;
      throw new PilotDenied('pilot_stopped', { cause });
    }
  };
}

export function guardedEffect(assertOpen, effect) {
  return async (...args) => {
    await assertOpen?.();
    return effect(...args);
  };
}
