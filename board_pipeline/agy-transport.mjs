import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, lstat, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir, userInfo } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ReviewDenied } from './review-runner.mjs';
import { withModelProxy } from './model-proxy.mjs';
import agyStream from './agy-stream.cjs';

const BUS_ROOT = '/org/freedesktop/secrets';
const BUS_SERVICE = 'org.freedesktop.secrets';
const KEY_ITEM = /^\/org\/freedesktop\/secrets\/collection\/[a-zA-Z0-9_]+\/[a-zA-Z0-9_]+$/;
const EGRESS = ['daily-cloudcode-pa.googleapis.com:443', 'cloudcode-pa.googleapis.com:443'];
// Host Agy's account bootstrap also needs Google's user-info endpoint.
const BOOTSTRAP = ['play.googleapis.com:443', 'www.googleapis.com:443'];

async function ownedFile(path, error) {
  if (!isAbsolute(path ?? '')) throw new ReviewDenied(error);
  try {
    const canonical = await realpath(path);
    const st = await lstat(canonical);
    if (!st.isFile() || st.uid !== process.getuid() || st.mode & 0o022) throw new ReviewDenied(error);
    return canonical;
  } catch (cause) {
    if (cause instanceof ReviewDenied) throw cause;
    throw new ReviewDenied(error, { cause });
  }
}

function keyringRules(item) {
  const collection = dirname(item);
  return [`org.freedesktop.Secret.Service.OpenSession@${BUS_ROOT}`,
    `org.freedesktop.Secret.Service.Unlock@${BUS_ROOT}`,
    `org.freedesktop.DBus.Properties.Get@${BUS_ROOT}`,
    `org.freedesktop.Secret.Collection.SearchItems@${collection}`,
    `org.freedesktop.Secret.Item.GetSecret@${item}`,
    `org.freedesktop.Secret.Session.Close@${BUS_ROOT}/session/*`,
  ].map(rule => `--call=${BUS_SERVICE}=${rule}`);
}

async function withAgyKeyring({ address, path, item }, run) {
  if (!/^unix:path=\/[^;\r\n]+$/.test(address ?? '') || !KEY_ITEM.test(item ?? '')) {
    throw new ReviewDenied('agy_keyring_item_not_enrolled');
  }
  const child = spawn('xdg-dbus-proxy', ['--fd=3', address, path, '--filter', ...keyringRules(item)],
    { stdio: ['ignore', 'ignore', 'ignore', 'pipe'] });
  const ready = child.stdio[3];
  const exit = once(child, 'close');
  const abort = new AbortController();
  let revoked = false;
  const revoke = async () => {
    if (!revoked) {
      revoked = true;
      ready.destroy();
      child.kill('SIGTERM');
    }
    await exit.catch(() => {});
  };
  const timer = setTimeout(() => abort.abort(), 3000);
  try {
    try {
      await Promise.race([once(ready, 'data', { signal: abort.signal }), exit.then(() => {
        throw new ReviewDenied('agy_keyring_bridge_failed');
      })]);
    } catch (cause) {
      throw new ReviewDenied('agy_keyring_bridge_failed', { cause });
    }
    clearTimeout(timer);
    return await run(revoke);
  } finally {
    clearTimeout(timer);
    abort.abort();
    await revoke();
  }
}

const local = filename => fileURLToPath(new URL(`./${filename}`, import.meta.url));
const sh = value => `'${value.replaceAll("'", "'\\''")}'`;

async function snapshotBoundary(cwd, scratch, home, runtime) {
  if (!isAbsolute(cwd) || await realpath(cwd) !== cwd) throw new ReviewDenied('agy_snapshot_workspace_invalid');
  if ((await readdir(cwd)).length !== 0) throw new ReviewDenied('agy_snapshot_workspace_invalid');
  const control = join(scratch, 'control');
  const events = join(scratch, 'events');
  const tmp = join(scratch, 'tmp');
  const hooks = join(home, '.gemini', 'config');
  await Promise.all([control, events, tmp, hooks].map(dir => mkdir(dir, { recursive: true, mode: 0o700 })));
  const node = await realpath(process.execPath);
  for (const file of ['agy-pre-tool.cjs', 'agy-tools.cjs']) await copyFile(local(file), join(control, file));
  const command = [node, join(control, 'agy-pre-tool.cjs'), cwd, control, events].map(sh).join(' ');
  await writeFile(join(hooks, 'hooks.json'), JSON.stringify({
    'snapshot-guard': { PreToolUse: [{ matcher: '', hooks: [{ command }] }] },
  }), { mode: 0o600, flag: 'wx' });
  return { launcher: local('agy-landlock.py'), snapshot: cwd, control, events, tmp, home, runtime, node };
}

// Host model transport over the offline snapshot; no ambient env or worker path.
export async function hostAgyTransport({ prompt, snapshot, publishSnapshot, timeoutMs = 210_000, env = process.env,
  launch = agyStream.runAgy, beforeEffect }) {
  const binary = await ownedFile(env.DF_AGY_BINARY ?? join(homedir(), '.local', 'opt', 'antigravity-cli', 'agy'),
    'agy_binary_not_enrolled');
  const scope = await ownedFile(env.DF_AGY_SCOPE_FILE ?? join(homedir(), '.config', 'antigravity', 'credential-user-scope'),
    'agy_scope_not_enrolled');
  const scratch = await mkdtemp(join(tmpdir(), 'df-agy-'));
  const cwd = snapshot;
  try {
    if (!isAbsolute(cwd ?? '') || typeof publishSnapshot !== 'function') throw new ReviewDenied('agy_snapshot_workspace_invalid');
    const initial = await lstat(cwd);
    if (!initial.isDirectory() || (initial.mode & 0o777) !== 0o500) throw new ReviewDenied('agy_snapshot_workspace_invalid');
    const home = join(scratch, 'home');
    const config = join(home, '.config');
    const runtime = join(scratch, 'run');
    const keyring = join(scratch, 'keyring.sock');
    await mkdir(runtime, { mode: 0o700 });
    await mkdir(join(config, 'antigravity'), { recursive: true, mode: 0o700 });
    await copyFile(scope, join(config, 'antigravity', 'credential-user-scope'));
    const boundary = await snapshotBoundary(cwd, scratch, home, runtime);
    const username = userInfo().username;
    const proxyEnv = env.DF_AGY_HTTPS_PROXY ? { HTTPS_PROXY: env.DF_AGY_HTTPS_PROXY } : env;
    const result = await withAgyKeyring({ address: env.DBUS_SESSION_BUS_ADDRESS, path: keyring, item: env.DF_AGY_KEYRING_ITEM },
      revokeKeyring => withModelProxy({ allow: EGRESS, bootstrap: BOOTSTRAP, env: proxyEnv,
        hostClient: true, beforeConnect: beforeEffect },
        (proxy, sealModelBootstrap) => launch({ binary, cwd, prompt, timeoutMs, beforeEffect, publishSnapshot,
          boundary: { ...boundary, proxyPort: Number(new URL(proxy).port) },
          sealBootstrap: () => { sealModelBootstrap(); return revokeKeyring(); },
          env: { PATH: '/usr/bin:/bin', HOME: home, XDG_CONFIG_HOME: config, XDG_RUNTIME_DIR: runtime,
            TMPDIR: boundary.tmp,
            USER: username, LOGNAME: username, LANG: 'C.UTF-8',
            DBUS_SESSION_BUS_ADDRESS: `unix:path=${keyring}`,
            HTTPS_PROXY: proxy, HTTP_PROXY: proxy, https_proxy: proxy, http_proxy: proxy,
            NO_PROXY: '', no_proxy: '' } })));
    const final = await lstat(cwd);
    if (final.dev !== initial.dev || final.ino !== initial.ino || (final.mode & 0o777) !== 0o500) {
      throw new ReviewDenied('agy_cwd_mutated');
    }
    return result;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
