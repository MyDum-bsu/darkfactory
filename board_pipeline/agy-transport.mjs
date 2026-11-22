import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import { homedir, tmpdir, userInfo } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
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

// Host model transport only. All source material comes from an offline pack;
// the child gets neither worktree/state paths nor inherited ambient env.
export async function hostAgyTransport({ prompt, timeoutMs = 210_000, env = process.env,
  launch = agyStream.runAgy }) {
  const binary = await ownedFile(env.DF_AGY_BINARY ?? join(homedir(), '.local', 'opt', 'antigravity-cli', 'agy'),
    'agy_binary_not_enrolled');
  const scope = await ownedFile(env.DF_AGY_SCOPE_FILE ?? join(homedir(), '.config', 'antigravity', 'credential-user-scope'),
    'agy_scope_not_enrolled');
  const scratch = await mkdtemp(join(tmpdir(), 'df-agy-'));
  const empty = join(scratch, 'empty');
  try {
    await mkdir(empty, { mode: 0o500 });
    const home = join(scratch, 'home');
    const config = join(home, '.config');
    const runtime = join(scratch, 'run');
    const keyring = join(scratch, 'keyring.sock');
    await mkdir(runtime, { mode: 0o700 });
    await mkdir(join(config, 'antigravity'), { recursive: true, mode: 0o700 });
    await copyFile(scope, join(config, 'antigravity', 'credential-user-scope'));
    const username = userInfo().username;
    const proxyEnv = env.DF_AGY_HTTPS_PROXY ? { HTTPS_PROXY: env.DF_AGY_HTTPS_PROXY } : env;
    const result = await withAgyKeyring({ address: env.DBUS_SESSION_BUS_ADDRESS, path: keyring, item: env.DF_AGY_KEYRING_ITEM },
      revokeKeyring => withModelProxy({ allow: EGRESS, bootstrap: BOOTSTRAP, env: proxyEnv, hostClient: true },
        (proxy, sealModelBootstrap) => launch({ binary, cwd: empty, prompt, timeoutMs,
          sealBootstrap: () => { sealModelBootstrap(); return revokeKeyring(); },
          env: { PATH: '/usr/bin:/bin', HOME: home, XDG_CONFIG_HOME: config, XDG_RUNTIME_DIR: runtime,
            USER: username, LOGNAME: username, LANG: 'C.UTF-8',
            DBUS_SESSION_BUS_ADDRESS: `unix:path=${keyring}`,
            HTTPS_PROXY: proxy, HTTP_PROXY: proxy, https_proxy: proxy, http_proxy: proxy,
            NO_PROXY: '', no_proxy: '' } })));
    if (((await lstat(empty)).mode & 0o777) !== 0o500 || (await readdir(empty)).length !== 0) {
      throw new ReviewDenied('agy_cwd_mutated');
    }
    return result;
  } finally {
    try { await chmod(empty, 0o700); } catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
    await rm(scratch, { recursive: true, force: true });
  }
}
