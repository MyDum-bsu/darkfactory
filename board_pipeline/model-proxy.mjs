import { Buffer } from 'node:buffer';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { once } from 'node:events';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { isIP } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const AUTHORITY = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}:443$/;
const LIMIT = 16;
const IO_TIMEOUT_MS = 120_000;

function proxyConfig(env) {
  const chosen = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy;
  if (!chosen) throw new Error('model_proxy_missing');
  let proxy;
  try { proxy = new URL(chosen); } catch { throw new Error('model_proxy_invalid'); }
  if (!['http:', 'https:'].includes(proxy.protocol) || !proxy.hostname || proxy.port === '44100' ||
      proxy.pathname !== '/' || proxy.search || proxy.hash) throw new Error('model_proxy_invalid');
  const headers = {};
  if (proxy.username || proxy.password) {
    try {
      const userpass = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
      headers['proxy-authorization'] = `Basic ${Buffer.from(userpass).toString('base64')}`;
    } catch { throw new Error('model_proxy_invalid'); }
  }
  return { request: proxy.protocol === 'https:' ? httpsRequest : httpRequest,
    hostname: proxy.hostname.replace(/^\[|\]$/g, ''), port: proxy.port || (proxy.protocol === 'https:' ? 443 : 80), headers };
}

function permit(allow) {
  if (!Array.isArray(allow) || !allow.length || allow.some(authority => {
    if (typeof authority !== 'string' || !AUTHORITY.test(authority)) return true;
    const host = authority.slice(0, -4);
    return isIP(host) !== 0 || /(?:^|\.)(?:localhost|local|internal|lan|home)$/.test(host);
  })) throw new Error('model_proxy_allowlist_invalid');
  return new Set(allow);
}

function deny(socket, code, reason) {
  if (!socket.destroyed) socket.end(`HTTP/1.1 ${code} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function connectUpstream(proxy, authority, client, pending, upstreamHead, track) {
  // Never forward client-controlled headers, including Proxy-Authorization.
  let connected;
  const upstream = proxy.request({ method: 'CONNECT', path: authority, hostname: proxy.hostname, port: proxy.port,
    headers: { ...proxy.headers, Host: authority }, agent: false });
  pending.add(upstream);
  upstream.once('close', () => pending.delete(upstream));
  client.once('close', () => upstream.destroy());
  upstream.once('error', () => deny(client, 502, 'Model Proxy Unavailable'));
  upstream.setTimeout(IO_TIMEOUT_MS, () => upstream.destroy(new Error('model_proxy_timeout')));
  upstream.once('connect', (response, tunnel, head) => {
    if (response.statusCode !== 200 || client.destroyed) {
      tunnel.destroy();
      deny(client, 502, 'Model Proxy Refused');
      return;
    }
    connected = tunnel;
    track(tunnel);
    tunnel.once('error', () => client.destroy());
    client.once('error', () => tunnel.destroy());
    client.once('close', () => tunnel.destroy());
    tunnel.once('close', () => client.end());
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length) client.write(head);
    if (upstreamHead.length) tunnel.write(upstreamHead);
    client.pipe(tunnel).pipe(client);
  });
  upstream.end();
  return () => {
    client.destroy();
    upstream.destroy();
    connected?.destroy();
  };
}

async function connectPhase(allowed, startup, authority, beforeConnect) {
  if (!startup.has(authority) && !allowed.has(authority)) return null;
  try { await beforeConnect?.(); } catch { return null; }
  // Bootstrap may have been revoked while reading the operator switch.
  return startup.has(authority) ? 'startup' : allowed.has(authority) ? 'model' : null;
}

export async function withModelProxy({ allow, bootstrap = [], env = process.env, hostClient = false, beforeConnect }, run) {
  const allowed = permit(allow);
  const startup = bootstrap.length ? permit(bootstrap) : new Set();
  if ([...startup].some(host => allowed.has(host))) throw new Error('model_proxy_phase_overlap');
  const startups = new Set();
  const sealBootstrap = () => {
    startup.clear();
    for (const close of startups) close();
    startups.clear();
  };
  const proxy = proxyConfig(env);
  const dir = await mkdtemp(join(tmpdir(), 'df-model-proxy-'));
  const path = join(dir, 'model.sock');
  const password = hostClient ? randomBytes(32).toString('hex') : null;
  const auth = password === null ? null : Buffer.from(`Basic ${Buffer.from(`review:${password}`).toString('base64')}`);
  const pending = new Set();
  const sockets = new Set();
  const track = socket => {
    sockets.add(socket);
    socket.setTimeout(IO_TIMEOUT_MS, () => socket.destroy());
    socket.on('error', () => socket.destroy());
    socket.once('close', () => sockets.delete(socket));
  };
  const server = createServer({ maxHeaderSize: 8192, headersTimeout: 5000, requestTimeout: 5000 },
    (_, res) => { res.writeHead(405, { Connection: 'close' }); res.end(); });
  server.maxConnections = LIMIT;
  server.on('connection', track);
  server.on('connect', async (request, client, head) => {
    if (auth) {
      const proposed = Buffer.from(request.headers['proxy-authorization'] ?? '');
      if (proposed.length !== auth.length || !timingSafeEqual(auth, proposed)) {
        deny(client, 407, 'Model Proxy Authentication Required');
        return;
      }
    }
    const phase = await connectPhase(allowed, startup, request.url, beforeConnect);
    if (phase === null || client.destroyed) { deny(client, 403, 'Model Destination Denied'); return; }
    const close = connectUpstream(proxy, request.url, client, pending, head, track);
    if (phase === 'startup') {
      startups.add(close);
      client.once('close', () => startups.delete(close));
    }
  });
  try {
    if (hostClient) server.listen(0, '127.0.0.1');
    else server.listen(path);
    await once(server, 'listening');
    if (!hostClient) {
      // The parent directory stays 0700; Docker receives only this inode.
      await chmod(path, 0o600);
    }
    const endpoint = hostClient ? `http://review:${password}@127.0.0.1:${server.address().port}` : path;
    return await run(endpoint, sealBootstrap);
  } finally {
    sealBootstrap();
    for (const request of pending) request.destroy();
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
}
