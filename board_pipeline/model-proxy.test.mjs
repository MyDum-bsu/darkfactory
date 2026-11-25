import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { lstat, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { withModelProxy } from './model-proxy.mjs';

function exchange(path, text) {
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    let output = '';
    socket.once('connect', () => socket.write(text));
    socket.on('data', data => { output += data; });
    socket.once('end', () => resolve(output));
    socket.once('error', reject);
    socket.setTimeout(3000, () => socket.destroy(new Error('proxy exchange timeout')));
  });
}

function tunnel(authority) {
  return `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\nProxy-Authorization: injected-client-value\r\n\r\n`;
}

test('model bridge forwards only CONNECT to enrolled authorities via configured host proxy', async t => {
  const seen = [];
  const upstream = createServer();
  upstream.on('connect', (req, socket) => {
    seen.push({ authority: req.url, proxyAuth: req.headers['proxy-authorization'] });
    socket.end('HTTP/1.1 200 Connection Established\r\n\r\nallowed response');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => upstream.close(resolve)));
  const proxy = `http://127.0.0.1:${upstream.address().port}`;
  await withModelProxy({ allow: ['chatgpt.com:443'], env: { HTTPS_PROXY: proxy } }, async path => {
    for (const denied of ['127.0.0.1:44100', '10.2.3.4:443', 'chatgpt.com:44100', 'chatgpt.com.evil.invalid:443',
      '[::1]:443', 'other.invalid:443', 'chatgpt.com:443/path']) {
      assert.match(await exchange(path, tunnel(denied)), /^HTTP\/1\.1 403 /);
    }
    assert.match(await exchange(path, 'GET http://chatgpt.com/ HTTP/1.1\r\nHost: chatgpt.com\r\n\r\n'), /^HTTP\/1\.1 405 /);
    assert.equal(seen.length, 0);
    const response = await exchange(path, tunnel('chatgpt.com:443'));
    assert.match(response, /^HTTP\/1\.1 200 /);
    assert.match(response, /allowed response$/);
  });
  assert.deepEqual(seen, [{ authority: 'chatgpt.com:443', proxyAuth: undefined }]);
});

test('model bridge does not fall back to direct dialing and rejects the Board as proxy', async () => {
  for (const env of [{}, { HTTPS_PROXY: 'http://127.0.0.1:44100' },
    { HTTPS_PROXY: 'http://proxy.example.invalid/api/board' }, { HTTPS_PROXY: 'file:///tmp/credentials' }]) {
    await assert.rejects(withModelProxy({ allow: ['chatgpt.com:443'], env }, async () => assert.fail('unexpected listener')),
      /model_proxy_(missing|invalid)/);
  }
  await assert.rejects(withModelProxy({ allow: ['127.0.0.1:443'], env: { HTTPS_PROXY: 'http://127.0.0.1:3128' } },
    async () => assert.fail('unexpected listener')), /model_proxy_allowlist_invalid/);
});

test('prompt release revokes active and new bootstrap CONNECT lanes first', async t => {
  const seen = [];
  const upstream = createServer();
  upstream.on('connect', (req, socket) => {
    seen.push(req.url);
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (req.url === 'daily-cloudcode-pa.googleapis.com:443') socket.end('model lane');
    else {
      socket.on('data', () => assert.fail('bootstrap tunnel transmitted prompt material'));
      socket.once('end', () => socket.end());
    }
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => upstream.close(resolve)));
  const env = { HTTPS_PROXY: `http://127.0.0.1:${upstream.address().port}` };
  await withModelProxy({ allow: ['daily-cloudcode-pa.googleapis.com:443'], bootstrap: ['play.googleapis.com:443'], env },
    async (path, sealBootstrap) => {
      const bootstrap = connect(path);
      const closed = once(bootstrap, 'close');
      await once(bootstrap, 'connect');
      bootstrap.write(tunnel('play.googleapis.com:443'));
      assert.match((await once(bootstrap, 'data'))[0].toString(), /^HTTP\/1\.1 200 /);
      sealBootstrap();
      await closed;
      assert.match(await exchange(path, tunnel('play.googleapis.com:443')), /^HTTP\/1\.1 403 /);
      assert.match(await exchange(path, tunnel('daily-cloudcode-pa.googleapis.com:443')), /model lane$/);
    });
  assert.deepEqual(seen, ['play.googleapis.com:443', 'daily-cloudcode-pa.googleapis.com:443']);
});

test('host Agy broker requires its per-run proxy credential and does not forward it', async t => {
  const observed = [];
  const upstream = createServer();
  upstream.on('connect', (req, socket) => {
    observed.push(req.headers['proxy-authorization']);
    socket.end('HTTP/1.1 200 Connection Established\r\n\r\n');
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  t.after(() => new Promise(resolve => upstream.close(resolve)));
  const env = { HTTPS_PROXY: `http://127.0.0.1:${upstream.address().port}` };
  await withModelProxy({ allow: ['daily-cloudcode-pa.googleapis.com:443'],
    bootstrap: ['www.googleapis.com:443'], env, hostClient: true }, async (endpoint, seal) => {
    const url = new URL(endpoint);
    const socket = { host: url.hostname, port: Number(url.port) };
    const word = Buffer.from(`${url.username}:${url.password}`).toString('base64');
    const request = dest => tunnel(dest).replace('injected-client-value', `Basic ${word}`);
    assert.match(await exchange(socket, tunnel('www.googleapis.com:443')), /^HTTP\/1\.1 407 /);
    assert.match(await exchange(socket, request('www.googleapis.com:443')), /^HTTP\/1\.1 200 /);
    seal();
    assert.match(await exchange(socket, request('www.googleapis.com:443')), /^HTTP\/1\.1 403 /);
    assert.match(await exchange(socket, request('daily-cloudcode-pa.googleapis.com:443')), /^HTTP\/1\.1 200 /);
  });
  assert.deepEqual(observed, [undefined, undefined]);
});

test('pilot closure stops even an enrolled model CONNECT before going upstream', async t => {
  let outbound = 0;
  let open = true;
  const upstream = createServer();
  upstream.on('connect', (_, socket) => { outbound++; socket.end('HTTP/1.1 200 Connection Established\r\n\r\n'); });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  t.after(() => new Promise(resolve => upstream.close(resolve)));
  await withModelProxy({ allow: ['chatgpt.com:443'], env: { HTTPS_PROXY: `http://127.0.0.1:${upstream.address().port}` },
    beforeConnect: async () => { if (!open) throw new Error('pilot_stopped'); } }, async path => {
    assert.match(await exchange(path, tunnel('chatgpt.com:443')), /^HTTP\/1\.1 200 /);
    open = false;
    assert.match(await exchange(path, tunnel('chatgpt.com:443')), /^HTTP\/1\.1 403 /);
  });
  assert.equal(outbound, 1);
});

test('explicit DF_MODEL_PROXY_DIRECT=1 allows allowlisted direct mode while still rejecting unlisted hosts', async () => {
  await withModelProxy({ allow: ['chatgpt.com:443'], env: { DF_MODEL_PROXY_DIRECT: '1' } }, async path => {
    for (const denied of ['127.0.0.1:44100', '10.2.3.4:443', 'other.invalid:443', 'chatgpt.com:80']) {
      assert.match(await exchange(path, tunnel(denied)), /^HTTP\/1\.1 403 /);
    }
    assert.match(await exchange(path, 'GET http://chatgpt.com/ HTTP/1.1\r\nHost: chatgpt.com\r\n\r\n'), /^HTTP\/1\.1 405 /);
  });
  await assert.rejects(
    withModelProxy({ allow: ['chatgpt.com:443'], env: { DF_MODEL_PROXY_DIRECT: '0' } }, async () => assert.fail('unexpected')),
    /model_proxy_missing/,
  );
});

test('deep TMPDIR uses a short private unix socket path and removes it on close', async t => {
  const originalTmpdir = process.env.TMPDIR;
  const base = await mkdtemp(join(tmpdir(), 'df-long-tmpdir-test-'));
  const deep = join(base, ...Array.from({ length: 6 }, (_, i) => `nested-${i}-${'x'.repeat(20)}`));
  await mkdir(deep, { recursive: true, mode: 0o700 });
  process.env.TMPDIR = deep;
  t.after(async () => {
    if (originalTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = originalTmpdir;
    await rm(base, { recursive: true, force: true });
  });

  const upstream = createServer();
  upstream.on('connect', (_, socket) => {
    socket.end('HTTP/1.1 200 Connection Established\r\n\r\nlong path response');
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  t.after(() => new Promise(resolve => upstream.close(resolve)));

  let endpoint;
  await withModelProxy({ allow: ['chatgpt.com:443'], env: { HTTPS_PROXY: `http://127.0.0.1:${upstream.address().port}` } },
    async path => {
      endpoint = path;
      assert.match(path, /^\/tmp\/df-mp-.+\/m\.sock$/);
      assert.ok(Buffer.byteLength(path, 'utf8') <= 88);
      assert.equal((await lstat(dirname(path))).mode & 0o077, 0);
      assert.equal((await readdir(deep)).length, 1);
      assert.match(await exchange(path, tunnel('chatgpt.com:443')), /long path response$/);
    });
  assert.deepEqual(await readdir(deep), []);
  await assert.rejects(lstat(dirname(endpoint)), { code: 'ENOENT' });
});
