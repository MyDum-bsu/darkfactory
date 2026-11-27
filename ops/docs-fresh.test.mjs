import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { DISK_TIER1_GIB } from '../board_pipeline/resource-steward.mjs';

const readRepoFile = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('RESOURCE-STEWARD documents the exact Tier 1 disk threshold from the implementation', () => {
  const document = readRepoFile('ops/local/RESOURCE-STEWARD.md');
  const threshold = String(DISK_TIER1_GIB);
  assert.ok(
    document.includes(`< ${threshold} GiB`),
    `expected operator documentation to mention < ${threshold} GiB`,
  );
  assert.equal(document.includes('BB-тредов'), false);
  assert.match(document, /`?hc`?-сессий\/тредов|hc-сессий\/тредов/);
});

test('headline documentation does not repeat the stale frozen test count', () => {
  for (const path of ['README.md', 'docs/STATUS.md']) {
    const document = readRepoFile(path);
    assert.equal(document.includes('1231'), false, `${path} must not contain the stale 1231 count`);
    assert.match(document, /npm test/);
  }
});
