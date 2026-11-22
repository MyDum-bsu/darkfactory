import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { isolatedNeonReviewRunner } from './neon-review.mjs';
import { commitFile, neonFixture, SPEC } from './review-test-fixture.mjs';

test('Neon ReviewPort: real offline Docker snapshot with a simulated Google HTTP reply', async t => {
  const { repo, journal, binding, profile } = await neonFixture(t);
  const candidate_sha = await commitFile(repo, 'export function sum(a, b) { return a + b; }\n');
  const subject_digest = 'a'.repeat(64);
  const run = isolatedNeonReviewRunner({ journal, prompt: SPEC, credential: async () => 'test-credential',
    request: async (_, options) => {
      const requestData = JSON.parse(options.body);
      const { files, diff } = JSON.parse(requestData.contents[0].parts[0].text);
      assert.deepEqual(files, [{ path: 'sum.js', text: 'export function sum(a, b) { return a + b; }\n' }]);
      assert.match(diff, /\+export function sum/);
      return Response.json({ modelVersion: 'gemini-4-neon', responseId: 'fixture-turn',
        candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({
          verdict: 'PASS', subject_digest, summary: 'Matches the spec', findings: [], checked_invariants: ['sum'],
        }) }] } }] });
    } });
  const receipt = await run({ ...binding, candidate_sha, subject_digest }, profile);
  assert.equal(receipt.verdict, 'REVIEW_OK');
  assert.equal(receipt.isolation, 'docker-ro-v1');
  assert.equal((await lstat(join(journal, receipt.transcript_file))).mode & 0o777, 0o600);
});
