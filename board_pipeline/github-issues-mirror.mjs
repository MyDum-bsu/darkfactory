// One tick for one explicitly enrolled GitHub repository. No worker/queue port:
// the only writes are Board intake messages/files and GitHub issue comments.
import { createHash, randomUUID } from 'node:crypto';

const api = 'https://api.github.com';
const issuesQuery = `query MirrorIssues($owner: String!, $name: String!, $after: String) {
  viewer { databaseId }
  repository(owner: $owner, name: $name) { nameWithOwner
    issues(first: 50, after: $after, labels: ["darkfactory"], states: [OPEN, CLOSED], orderBy: {field: CREATED_AT, direction: ASC}) {
      nodes { number title body labels(first: 100) { nodes { name } } author { ... on User { databaseId } }
        lastEditedAt editor { ... on User { databaseId } } }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;
const fail = code => { throw new Error(code); };
const matches = (re, s) => typeof s === 'string' && re.test(s);
const positive = n => Number.isSafeInteger(n) && n > 0;
const idString = s => matches(/^[1-9][0-9]*$/, s) && positive(Number(s));
const keyFor = (...parts) => `df-gh-${createHash('sha256').update(JSON.stringify(parts)).digest('hex')}`;

function policy({ repo, project, taskChannel, ownerIds, boardUrl, boardToken, githubToken }) {
  if (!matches(/^[a-z0-9][a-z0-9-]*\/[a-z0-9_.-]+$/i, repo) || /^\.{1,2}$/.test(repo.split('/')[1]) ||
      !matches(/^[a-z0-9][a-z0-9_-]{0,127}$/, project) || (taskChannel !== undefined &&
      !matches(/^[a-z0-9][a-z0-9_-]*(?:\/[a-z0-9][a-z0-9_-]*)*$/, taskChannel))) fail('invalid_mirror_route');
  if (!Array.isArray(ownerIds) || !ownerIds.length || ![...ownerIds].every(idString)) fail('explicit_owner_ids_required');
  if (![boardToken, githubToken].every(s => matches(/^\S+$/, s))) fail('mirror_tokens_required');
  const url = new URL(boardUrl);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) ||
      url.search || url.hash || url.username || url.password || url.pathname !== '/api/board') fail('invalid_board_url');
  return { repo: repo.toLowerCase(), project, requests: `${project}/requests`, taskChannel, owners: new Set(ownerIds.map(Number)),
    boardUrl: url.href, boardToken, githubToken };
}

function clients(p, fetchImpl) {
  const grants = `${p.requests}=read,post` + (p.taskChannel && p.taskChannel !== p.requests ? `;${p.taskChannel}=read` : '');
  async function request(url, headers, { json, file, lookup = false } = {}) {
    const res = await fetchImpl(url, { method: json === undefined && file === undefined ? 'GET' : 'POST',
      redirect: 'error', signal: AbortSignal.timeout(30_000), headers: { accept: 'application/json', ...headers,
        ...(json !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(file !== undefined ? { 'content-type': 'text/plain', 'x-board-filename': 'github-issue.txt' } : {}) },
      body: file ?? JSON.stringify(json) });
    const readJson = () => res.json().catch(() => fail('invalid_mirror_response'));
    if (lookup && res.status === 404 && (await readJson())?.error?.code === 'post_not_found') return undefined;
    if (!res.ok) fail(`mirror_${new URL(url).hostname}_http_${res.status}`);
    return readJson();
  }
  const gh = (path, opts) => request(api + path, { authorization: `Bearer ${p.githubToken}` }, opts);
  const board = (path, opts) => request(p.boardUrl + path, { authorization: `Bearer ${p.boardToken}`,
    'x-board-profile': 'github-issues-mirror', 'x-board-can': grants }, opts);
  return { board, gh, async posted(id) {
    const data = await board(`/posts/${id}`, { lookup: true });
    return data === undefined ? null : data?.message ?? fail('invalid_board_post');
  }, post: async body => (await board('/messages', { json: { ...body, noSync: true } })).message };
}

async function* issues({ repo }, { gh }) {
  const [owner, name] = repo.split('/');
  let after = null;
  const seen = new Set();
  do {
    const { data, errors } = await gh('/graphql', { json: { query: issuesQuery, variables: { owner, name, after } } });
    const page = data?.repository?.issues, viewer = data?.viewer?.databaseId;
    if (errors || data?.repository?.nameWithOwner?.toLowerCase() !== repo || !positive(viewer) ||
        !Array.isArray(page?.nodes) || typeof page.pageInfo?.hasNextPage !== 'boolean') fail('invalid_github_issue_page');
    for (const issue of page.nodes) yield { issue, viewer };
    if (!page.pageInfo.hasNextPage) return;
    after = page.pageInfo.endCursor;
    if (typeof after !== 'string' || !after || seen.has(after)) fail('invalid_github_cursor');
    seen.add(after);
  } while (true);
}

function checkMessage(m, channel, re) {
  if (!idString(m?.id) || m.channel !== channel || m.re !== re || m.deleted !== false || m.noSync !== true) {
    fail('invalid_board_binding');
  }
  return m;
}

async function requestRoot(p, client, issue) {
  const id = keyFor('request', p.repo, issue.number);
  const existing = await client.posted(id);
  if (existing !== null) return checkMessage(existing, p.requests, null); // first snapshot wins, including after edits
  if (typeof issue.title !== 'string' || typeof issue.body !== 'string') fail('invalid_issue_text');
  const source = `GitHub ${p.repo}#${issue.number}`;
  const text = `${source}\n\n${issue.title}\n\n${issue.body}`;
  // Fence simple mentions so Board won't rewrite @handles. For schema fences,
  // oversize text, etc., retain the bytes as a file; a managed lead ignores an
  // attachment-only post rather than building tasks from an incomplete quote.
  const fenced = text.includes('@') && !text.includes('```');
  let payload = { text: fenced ? `\`\`\`text\n${text}\n\`\`\`` : text };
  if (payload.text.length > 10000 || /json#|\0/.test(text) || (!fenced && text.includes('@'))) {
    const { attachment } = await client.board('/attachments', { file: text });
    if (typeof attachment?.id !== 'string' || !attachment.id) fail('invalid_board_attachment');
    payload = { text: '', attachments: [attachment.id] };
  }
  return checkMessage(await client.post({ channel: p.requests, id, ...payload }), p.requests, null);
}

// A lead may convert the root itself or split it into cards in its enrolled
// work channel. Never confuse one split card's completion with the whole issue.
async function* linkedTasks(p, { board }, root) {
  if (root.task) yield root;
  if (!p.taskChannel) return;
  const query = new URLSearchParams({ channel: p.taskChannel, state: 'all', limit: '200' });
  query.append('label', `verbatim_request_id=${root.id}`);
  query.append('label', `repo_id=${p.project}`);
  const seen = new Set();
  for (;;) {
    const page = await board(`/tasks?${query}`);
    if (!Array.isArray(page?.tasks)) fail('invalid_board_task_page');
    for (const { message: m } of page.tasks) {
      if (m?.channel === p.taskChannel && idString(m.id) && m.re === null && m.deleted === false &&
          m.labels?.repo_id === p.project && m.labels.verbatim_request_id === root.id) yield m;
    }
    if (!page.tasks.length || page.cursor == null || page.cursor === query.get('after')) return;
    if (typeof page.cursor !== 'string' || !page.cursor || seen.has(page.cursor)) fail('invalid_board_cursor');
    seen.add(page.cursor); query.set('after', page.cursor);
  }
}

function statusText({ task, id }, repo) {
  if (!['completed', 'failed', 'canceled'].includes(task?.state)) return null;
  let result = task.result;
  if (typeof result === 'string') {
    try { result = JSON.parse(result); } catch { result = null; } // free-text results are private
  }
  const parts = [`Board task ${id}: ${task.state}`];
  const sha = result?.sha ?? result?.candidate_sha;
  if (matches(/^[a-f0-9]{40}$/i, sha)) parts.push(`SHA \`${sha}\``);
  const pr = result?.pr_number ?? result?.pr_url ?? result?.pr;
  const urlPrefix = `https://github.com/${repo}/pull/`;
  const num = typeof pr === 'string' && pr.toLowerCase().startsWith(urlPrefix) ? pr.slice(urlPrefix.length) : pr;
  if (positive(num) || idString(num)) parts.push(`PR #${num}`);
  return parts.join(' · ');
}

async function writeStatus(p, client, number, viewer, root, body) {
  const path = `/repos/${p.repo}/issues/${number}/comments`;
  const id = keyFor('comment', p.repo, number, body);
  // GitHub has no idempotency key for adding a comment. Reserve its fingerprint
  // on Board before POST. A different runner (or a restarted one) can only
  // confirm delivery, never resend an ambiguous write. This is a reply, not a
  // task claim, and carries no issue-controlled directives or delivery secrets.
  let intent = await client.posted(id);
  if (intent === null) {
    const text = `GitHub status delivery ${randomUUID()}`;
    intent = checkMessage(await client.post({ id, re: root.id, text }), p.requests, root.id);
    if (intent.text === text) {
      const comment = await client.gh(path, { json: { body } });
      if (comment.user?.id !== viewer || comment.body !== body) fail('github_comment_unconfirmed');
      return;
    }
  }
  checkMessage(intent, p.requests, root.id);
  for (let page = 1; ; page++) {
    const list = await client.gh(`${path}?per_page=100&page=${page}`);
    if (!Array.isArray(list)) fail('invalid_github_comment_page');
    if (list.some(c => c?.user?.id === viewer && c.body === body)) return;
    if (list.length < 100) fail(`github_comment_unconfirmed: ${p.repo}#${number}, Board reply ${intent.id}`);
  }
}

export async function syncGithubIssues(options) {
  const p = policy(options), client = clients(p, options.fetchImpl ?? fetch);
  const counts = { requests: 0, rejected: 0, terminal: 0 };
  for await (const { issue, viewer } of issues(p, client)) {
    // Only User.databaseId from GitHub is authoritative; no logins, collaborator
    // roles, assignees, comments, body claims or GitHub labels grant authority.
    if (!p.owners.has(issue?.author?.databaseId) || !Array.isArray(issue.labels?.nodes) ||
        !issue.labels.nodes.some(label => label?.name === 'darkfactory') ||
        ((issue.lastEditedAt !== null || issue.editor !== null) && !p.owners.has(issue.editor?.databaseId))) {
      counts.rejected++; continue;
    }
    if (!positive(issue.number)) fail('invalid_issue_number');
    const root = await requestRoot(p, client, issue);
    counts.requests++;
    for await (const task of linkedTasks(p, client, root)) {
      const body = statusText(task, p.repo);
      if (body === null) continue;
      await writeStatus(p, client, issue.number, viewer, root, body);
      counts.terminal++;
    }
  }
  return counts;
}
