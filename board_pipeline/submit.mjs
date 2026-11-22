import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative } from 'node:path';
import { parseArgs } from 'node:util';
import { accept } from './acceptance.mjs';
import { nativeBoardPort } from './native-board.mjs';
import { nativeReviewVerifier, offlineProfileRunner, offlineVisualRunner, readJson,
  worktreeInspector } from './runtime.mjs';
import { tamperGate } from './tamper-gate.mjs';
import { loadSdk } from './sdk.mjs';

function inside(root, path) {
  const rel = relative(root, path);
  return !rel || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('../'));
}

async function submit() {
  const { values } = parseArgs({ options: {
    handoff: { type: 'string' }, policy: { type: 'string' }, journal: { type: 'string' }, execute: { type: 'boolean' },
  } });
  if (!values.execute || !values.handoff || !values.policy || !values.journal) {
    throw new Error('Usage: submit.mjs --execute --handoff FILE --policy FILE --journal DIR');
  }
  const handoff = await readJson(values.handoff);
  const tree = await realpath(handoff.worktree);
  const policyFile = await realpath(values.policy);
  const journal = await realpath(values.journal);
  const metadata = await stat(journal);
  if (!metadata.isDirectory() || metadata.mode & 0o077 || inside(tree, policyFile) || inside(tree, journal)) {
    throw new Error('Use a private operator journal and trusted configuration outside the worktree');
  }
  const policy = await readJson(policyFile);
  if (!/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/api\/board$/.test(policy.boardUrl ?? '') ||
      !/^[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)*$/.test(policy.channel ?? '')) {
    throw new Error('Configure an explicit loopback Board and an exact allowed channel');
  }
  for (const file of [policy.reviewGate, policy.reviewPrompt].filter(value => value !== undefined)) {
    if (inside(tree, await realpath(file))) throw new Error('Reviewer files must be outside the candidate');
  }
  process.env.BOARD_URL = policy.boardUrl;
  const { board } = loadSdk();
  const result = await accept({ handoff, policy, journal, ports: {
    board: nativeBoardPort(board(), { channel: policy.channel }),
    inspect: worktreeInspector(policy),
    local: offlineProfileRunner(journal),
    tamper: tamperGate, visual: offlineVisualRunner(journal),
    review: nativeReviewVerifier(policy.reviewGate, policy.reviewPrompt),
  } });
  console.log(JSON.stringify(result));
  if (result.outcome !== 'completed') process.exitCode = 1;
}

try {
  await submit();
} catch (error) {
  console.error(`board-submit: ${error.message}`);
  process.exitCode = 1;
}
