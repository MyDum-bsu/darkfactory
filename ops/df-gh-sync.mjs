#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { syncGithubIssues } from '../board_pipeline/github-issues-mirror.mjs';

const help = `Usage: node ops/df-gh-sync.mjs --repo OWNER/REPO --project PROJECT
       --board-url URL/api/board --owner-id NUM [--owner-id NUM ...] [--task-channel CHANNEL]

Run one sync of open and closed GitHub Issues labeled darkfactory. --owner-id is
an immutable numeric GitHub user ID, not a login or a Board actor. Use GH_TOKEN
or GITHUB_TOKEN (user token with repository issues read/write) and BOARD_TOKEN. Keep the same
Board principal; profile github-issues-mirror needs read/post on PROJECT/requests.
For managed intake enroll that profile as the project's owner actor. Supply the
lead's task channel (read only) to report cards linked by verbatim_request_id.
Issue edits never replace the Board request. No GitHub state changes or claims.
If a comment delivery is unconfirmed, inspect the issue and Board reply; the
mirror won't repeat a POST whose outcome is unknown.`;

try {
  const { values } = parseArgs({ options: { repo: { type: 'string' }, project: { type: 'string' },
    'board-url': { type: 'string' }, 'owner-id': { type: 'string', multiple: true },
    'task-channel': { type: 'string' }, help: { type: 'boolean', short: 'h' } } });
  if (values.help) console.log(help);
  else console.log(JSON.stringify(await syncGithubIssues({ repo: values.repo, project: values.project,
    taskChannel: values['task-channel'], boardUrl: values['board-url'], ownerIds: values['owner-id'],
    githubToken: process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN, boardToken: process.env.BOARD_TOKEN })));
} catch (error) {
  console.error(`df-gh-sync: ${error.message}`);
  process.exitCode = 1;
}
