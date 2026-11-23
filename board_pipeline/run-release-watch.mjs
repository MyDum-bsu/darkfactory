import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { parseArgs } from 'node:util';
import { ReleaseDenied } from './release-contract.mjs';
import { watchReleaseTick } from './release-watch.mjs';

try {
  const { values } = parseArgs({ options: { policy: { type: 'string' } } });
  if (!isAbsolute(values.policy ?? '')) throw new ReleaseDenied('watch_policy_path_required');
  const policy = JSON.parse(await readFile(values.policy, 'utf8'));
  console.log(JSON.stringify(await watchReleaseTick(policy, process.env.DF_WATCH_BOARD_TOKEN)));
} catch (error) {
  console.error(`release-watch: ${error instanceof ReleaseDenied ? error.code : 'watch_configuration_failed'}`);
  process.exitCode = 1;
}
