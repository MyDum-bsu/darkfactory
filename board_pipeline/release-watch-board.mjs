import { ReleaseDenied } from './release-contract.mjs';
import { releaseEndpoint } from './release-readback.mjs';

const BOARD_PATH = '/api/board';

export const INTAKE_CHANNEL = 'intake';
export const RELEASE_CHANNEL = 'pilot';
export const isMessageId = value => typeof value === 'string' && /^[1-9][0-9]{0,14}$/.test(value);

export function watchBoardEndpoint(url) {
  if (typeof url !== 'string' || !url.endsWith(BOARD_PATH)) throw new ReleaseDenied('watch_policy_invalid');
  return releaseEndpoint(url.slice(0, -BOARD_PATH.length));
}

async function readReply(response) {
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.length;
    if (size > 128 * 1024) throw new ReleaseDenied('watch_board_reply_too_large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

// Board 0.54.0 lacks a separate grant for native task operations. Use a
// narrowed identity AND a closed transport: there is no task/release verb.
export function watchBoardPort(url, token) {
  watchBoardEndpoint(url);
  if (typeof token !== 'string' || !token || /\s/.test(token)) throw new ReleaseDenied('watch_board_token_required');
  const headers = { authorization: `Bearer ${token}`, 'x-board-profile': 'release-observer',
    'x-board-can': `${RELEASE_CHANNEL}=read;${INTAKE_CHANNEL}=read,post`, 'content-type': 'application/json' };

  async function call(path, { body, absentPost = false } = {}) {
    let response, data;
    try {
      response = await fetch(`${url}${path}`, { method: body ? 'POST' : 'GET', headers, redirect: 'error',
        signal: AbortSignal.timeout(5000), body: body && JSON.stringify(body) });
      data = await readReply(response);
    } catch (cause) {
      if (cause instanceof ReleaseDenied) throw cause;
      throw new ReleaseDenied('watch_board_unavailable', { cause });
    }
    if (response.ok) return data;
    if (absentPost && response.status === 404 && data?.error?.code === 'post_not_found') return null;
    if (response.status === 409 && data?.error?.code === 'revision_conflict') {
      throw new ReleaseDenied('watch_incident_conflict');
    }
    throw new ReleaseDenied('watch_board_refused', { cause: new Error(`HTTP ${response.status}`) });
  }

  function messagePath(id) {
    if (!isMessageId(id)) throw new ReleaseDenied('watch_board_message_invalid');
    return `/messages/${id}`;
  }

  return {
    async read(id) { return (await call(`${messagePath(id)}?limit=1`))?.message; },
    async posted(key) {
      const result = await call(`/posts/${encodeURIComponent(key)}`, { absentPost: true });
      return result === null ? null : result?.message;
    },
    async post(id, text) {
      return (await call('/messages', { body: { channel: INTAKE_CHANNEL, id, text, noSync: true } }))?.message;
    },
    async edit(id, text, revision) {
      const result = await call(`${messagePath(id)}/edit`, { body: { text, revision } });
      if (result?.ok !== true) throw new ReleaseDenied('watch_board_edit_unconfirmed');
    },
  };
}
