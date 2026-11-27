import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isolatedNeonReviewRunner } from './neon-review.mjs';
import { NEON_ISOLATION } from './review-policy.mjs';
import { agyStreamFixture, commitFile, neonFixture, SPEC } from './review-test-fixture.mjs';

test('Neon ReviewPort: real offline Docker snapshot with a simulated Agy stream', async t => {
  const { repo, journal, binding, profile } = await neonFixture(t);
  const candidate_sha = await commitFile(repo, 'export function sum(a, b) { return a + b; }\n');
  const subject_digest = 'a'.repeat(64);
  const run = isolatedNeonReviewRunner({ journal, prompt: SPEC,
    transport: async ({ prompt, snapshot: cwd, publishSnapshot }) => {
      await publishSnapshot();
      assert.match(prompt, /diff\.patch/);
      assert.doesNotMatch(prompt, /export function sum/);
      assert.deepEqual(JSON.parse(await readFile(join(cwd, 'files.json'), 'utf8')), ['candidate/sum.js']);
      assert.match(await readFile(join(cwd, 'diff.patch'), 'utf8'), /\+export function sum/);
      return { code: 0, cwd, stdout: agyStreamFixture({ verdict: 'PASS', subject_digest, summary: 'Matches the spec',
        findings: [], checked_invariants: ['sum'] }, { cwd, reads: ['candidate/sum.js', 'diff.patch'] }) };
    } });
  const receipt = await run({ ...binding, candidate_sha, subject_digest }, profile);
  assert.equal(receipt.verdict, 'REVIEW_OK');
  assert.equal(receipt.isolation, NEON_ISOLATION);
  assert.equal(receipt.snapshot_reads, 2);
  assert.equal((await lstat(join(journal, receipt.transcript_file))).mode & 0o777, 0o600);
});
