import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { enrollAbPilot } from './ab-pilot.mjs';

async function enrollLinear(t, waitMs) {
  const base = await mkdtemp(join(tmpdir(), 'df-ab-pilot-test-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  for (const name of ['tree', 'root', 'inbox', 'switch']) await mkdir(join(base, name), { mode: 0o700 });
  const switchFile = join(base, 'switch', 'run');
  await writeFile(switchFile, 'run\n', { mode: 0o600 });
  const parent = 'thr_fixture';
  return enrollAbPilot({ arm: 'linear', case: 'policy', parent, switch: switchFile }, {
    policy: {
      scope: 'isolated',
      channel: 'pilot',
      waitMs,
      label: { key: 'queue', value: 'ab-policy-linear' },
      route: { finish: 'verified' },
    },
    tree: join(base, 'tree'),
    root: join(base, 'root'),
    inbox: join(base, 'inbox'),
    daemon: false,
    allowLive: false,
    parent,
  });
}

test('A/B pilot accepts the full enclosed wait range through 360000 ms', async t => {
  for (const waitMs of [5000, 360000]) {
    const enrolled = await enrollLinear(t, waitMs);
    assert.equal(enrolled.arm, 'linear');
    assert.equal(enrolled.case, 'policy');
    await enrolled.assertOpen();
  }
});

test('A/B pilot accepts the full enclosed wait range through 600000 ms', async t => {
  for (const waitMs of [5000, 360001, 540000, 600000]) {
    const enrolled = await enrollLinear(t, waitMs);
    assert.equal(enrolled.arm, 'linear');
    assert.equal(enrolled.case, 'policy');
    await enrolled.assertOpen();
  }
});

test('A/B pilot rejects wait values outside the enclosed range', async t => {
  for (const waitMs of [4999, 600001, 600000.5, Number.NaN, null, undefined, Number.POSITIVE_INFINITY]) {
    await assert.rejects(enrollLinear(t, waitMs), /ab_pilot_scope_denied/);
  }
});
