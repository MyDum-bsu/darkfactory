'use strict';

// Trusted bootstrap in --network=none. This TCP listener exists only in the
// container's loopback; the only host connection is the broker's Unix socket.
const { spawn } = require('node:child_process');
const { connect, createServer } = require('node:net');

const [command, ...args] = process.argv.slice(2);
const sockets = new Set();
function track(socket) {
  sockets.add(socket);
  socket.once('close', () => sockets.delete(socket));
}
const listener = createServer(local => {
  const forward = connect('/model-proxy/upstream.sock');
  track(local);
  track(forward);
  local.once('error', () => forward.destroy());
  forward.once('error', () => local.destroy());
  local.once('close', () => forward.destroy());
  forward.once('close', () => local.destroy());
  local.pipe(forward).pipe(local);
});
listener.maxConnections = 16;
listener.once('error', () => { process.stderr.write('model_proxy_listener_failed\n'); process.exitCode = 1; });
listener.listen(0, '127.0.0.1', () => {
  const port = String(listener.address().port);
  if (port === '44100') { listener.close(); process.exitCode = 1; return; }
  const proxy = `http://127.0.0.1:${port}`;
  const { DF_CHILD_NODE_OPTIONS, ...rest } = process.env;
  const env = { ...rest, ...(DF_CHILD_NODE_OPTIONS ? { NODE_OPTIONS: DF_CHILD_NODE_OPTIONS } : {}),
    HTTPS_PROXY: proxy, HTTP_PROXY: proxy, https_proxy: proxy, http_proxy: proxy,
    NO_PROXY: '', no_proxy: '', DF_MODEL_PROXY_PORT: port };
  const child = spawn(command, args, { stdio: ['ignore', 'inherit', 'inherit'], env });
  const stop = () => { for (const socket of sockets) socket.destroy(); listener.close(); };
  child.once('error', () => { stop(); process.stderr.write('model_client_spawn_failed\n'); process.exitCode = 1; });
  child.once('exit', (code, signal) => { stop(); process.exitCode = signal ? 1 : code; });
  process.once('SIGTERM', () => child.kill('SIGTERM'));
});
