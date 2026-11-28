// Opt-in Phase 2 listener, separate from the read-only aggregator and its
// Board credentials. Run: DF_CONTROL_ROOM_WRITE_TOKEN=... node ops/control-room/server.mjs
// Visit the printed loopback URL (or SSH-forward the same port). No automatic
// service installation. Set DF_CONTROL_ROOM_RELEASE_ADAPTER to a trusted
// absolute controller executable to enable release decisions (ABI in action-gate.mjs).
import { createServer } from 'node:http';
import { lstat, mkdir, readFile } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ACTIONS, createActionGate, exactSite } from './action-gate.mjs';
import { SECURITY_HEADERS } from './origin-guard.mjs';
import { boardId, readAttemptArtifacts } from './attempt-artifacts.mjs';

const page = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Control Room · hc sessions</title><body data-view="action-gate"><main><h1>hc session actions</h1>
<label>Operator token <input id="hc-token" type="password" autocomplete="off"></label>
<button id="hc-login">Unlock for 15 minutes</button>
<fieldset id="hc-controls" disabled><legend>Target</legend>
<label>hc address or worker name <input id="hc-session" placeholder="t7"></label>
<label>Board task ID <input id="hc-task"></label>
<label>Attempt ID (required for worker names) <input id="hc-attempt"></label>
<label>Action <select id="hc-action">${ACTIONS.map(a => `<option>${a}</option>`).join('')}</select></label>
<button id="hc-submit">Execute</button></fieldset><output id="hc-status" aria-live="polite">Locked</output>
</main><script src="/app.js"></script></body></html>`;

export function createActionServer(options) {
  const gate = createActionGate(options);
  return createServer({ headersTimeout: 5000, requestTimeout: 10000, connectionsCheckingInterval: 1000,
    maxHeaderSize: 8192 }, async (req, res) => {
    const reply = (status, body, type = 'application/json') => {
      // no-referrer can suppress Origin on non-CORS POSTs. Keep the exact
      // same-origin value for this UI, without sending referrers off origin.
      res.writeHead(status, { ...SECURITY_HEADERS, 'Referrer-Policy': 'same-origin', 'Cache-Control': 'no-store', 'Content-Type': type });
      res.end(type === 'application/json' ? JSON.stringify(body) : body);
    };
    try {
      if (req.url === '/api/action' || req.url === '/api/action-session') {
        const result = await gate(req); reply(result.status, result.body); return;
      }
      if (!exactSite(req, false)) return reply(403, { error: 'forbidden' });
      if (req.method !== 'GET' && req.method !== 'HEAD') return reply(405, { error: 'method_not_allowed' });
      if (req.url.startsWith('/api/attempt-artifacts/')) {
        if (req.method !== 'GET') return reply(405, { error: 'method_not_allowed' });
        const id = req.url.slice('/api/attempt-artifacts/'.length);
        if (!boardId(id)) return reply(400, { error: 'invalid_task_id' });
        const artifacts = await readAttemptArtifacts(id, options);
        return artifacts ? reply(200, artifacts) : reply(404, { error: 'not_found' });
      }
      if (req.url === '/') return reply(200, page, 'text/html; charset=utf-8');
      if (req.url === '/app.js') return reply(200, await readFile(new URL('./web/app.js', import.meta.url)), 'text/javascript');
      reply(404, { error: 'not_found' });
    } catch { reply(503, { error: 'action_service_unavailable' }); }
  });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const dir = join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local/state'), 'darkfactory', 'action-gate');
  await mkdir(dir, { mode: 0o700, recursive: true });
  const stat = await lstat(dir);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw Error('private audit directory required');
  const server = createActionServer({ auditPath: join(dir, 'clicks.jsonl'), actor: userInfo().username,
    stateDirs: (process.env.DF_FACTORY_SLOT_DIRS ?? '').split(':').filter(Boolean),
    token: process.env.DF_CONTROL_ROOM_WRITE_TOKEN, releaseAdapter: process.env.DF_CONTROL_ROOM_RELEASE_ADAPTER });
  server.listen(Number(process.env.DF_CONTROL_ROOM_ACTION_PORT ?? 44111), '127.0.0.1', () => {
    console.log(`Control Room actions: http://127.0.0.1:${server.address().port}/`);
  });
}
