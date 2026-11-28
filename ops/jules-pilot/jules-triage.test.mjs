import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { triageIssue } from './jules-triage.mjs';

const repository = 'acme/sampler';
const cases = [
  ['docs', 'Fix a documentation typo', 'docs/guide.md'],
  ['unit-test', 'Test the empty input case', 'tests/unit/format.test.mjs'],
  ['isolated-refactor', 'Extract a repeated literal into a local constant', 'examples/format.js'],
];
const policy = { repository, files: cases.map(([, , file]) => file) };
function issue([label, title, file] = cases[0]) {
  return { repository, number: 1, state: 'OPEN', title, body: `File: ${file}\nLine: 1`, labels: [label] };
}
function denied(input, enrollment = policy) {
  assert.equal(triageIssue(input, enrollment).eligible, false);
}

test('each supported task yields a stable one-file candidate', () => {
  for (const entry of cases) {
    const [kind, , path] = entry;
    const snapshot = Object.freeze(issue(entry));
    for (let i = 0; i < 2; i++) {
      assert.deepEqual(triageIssue(snapshot, policy), { eligible: true, kind, path });
    }
  }
  assert.equal(triageIssue({ ...issue(), labels: [], body: 'File: docs/guide.md' }, policy).eligible, true);
});

test('line bounds and issue numbers are inclusive, integral and positive', () => {
  const body = 'File: docs/guide.md\nLine: ';
  assert.equal(triageIssue({ ...issue(), body: body + '9999999', number: Number.MAX_SAFE_INTEGER }, policy).eligible, true);
  for (const line of ['00', '01', '-1', '1.1', '10000000', '1\r\n']) denied({ ...issue(), body: body + line });
  for (const number of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) denied({ ...issue(), number });
});

test('sensitive targets cannot be enrolled, including sensitive docs and tests', () => {
  for (const path of [
    'board_pipeline/example.test.js', 'ops/local/guide.md', '.env', '.github/workflows/ci.yml',
    'docs/Board_Pipeline/guide.md', 'docs/ops/local/guide.md', 'docs/Trust-Kernel.md',
    'docs/secrets.md', 'docs/credential.md', 'docs/API-Key.md', 'docs/private_key.md', 'docs/token.md',
    'docs/passwd.md', 'docs/PII.md', 'docs/personal-data.md', 'docs/email.md', 'docs/ssn.md',
    'tests/unit/oauth.test.js', 'docs/login.md', 'docs/RLS.md', 'docs/row_level_security.md',
    'docs/billing.md', 'docs/stripe.md', 'docs/payments.md', 'docs/Deploy.md', 'docs/terraform.md',
    'docs/Dockerfile.md', 'docs/kubernetes.md', 'docs/moml-course/intro.md',
  ]) {
    const [label, title] = path.endsWith('.js') ? cases[1] : cases[0];
    denied(issue([label, title, path]), { repository, files: [path] });
  }
});

test('unsafe or extra prose is not made safe by a label or a benign file', () => {
  for (const text of ['secrets', 'Jane Example', 'auth/RLS', 'board_pipeline', 'ops/local', 'billing',
    'deploy configs', 'moml-course', 'also update the server', 'https://example.invalid', 'alice@example.invalid']) {
    for (const addition of [{ title: issue().title + ' ' + text }, { body: issue().body + '\n' + text },
      { labels: ['docs', text] }, { comments: [text] }]) denied({ ...issue(), ...addition });
  }
  for (const repo of ['acme/mOmL-CoUrSe', 'moml-course/sampler', 'acme/billing']) {
    denied({ ...issue(), repository: repo }, { ...policy, repository: repo });
  }
});

test('scope must be canonical, enrolled, single-file and appropriate for the operation', () => {
  for (const path of ['docs/../guide.md', 'docs/%2e%2e/guide.md', 'docs//guide.md', './docs/guide.md',
    'docs/.hidden.md', 'docs/guide*.md', '/docs/guide.md', 'docs\\guide.md', 'docs/а.md', 'docs/guide.md\n',
    'docs/guide.md\nFile: docs/extra.md', 'docs/guide.md\u0000', 'docs/config.yml', 'docs.md']) {
    denied(issue(['docs', cases[0][1], path]), { repository, files: [path] });
  }
  denied(issue(['docs', cases[0][1], 'docs/new.md']));
  denied(issue(['docs', cases[0][1], cases[1][2]]));
  denied({ ...issue(), labels: ['unit-test'] });
  denied({ ...issue(), repository: 'other/sampler' });
});

test('missing, ambiguous and malformed inputs default to denial', () => {
  for (const value of [null, undefined, {}, [], 0, 'docs']) denied(value);
  for (const key of Object.keys(issue())) {
    const snapshot = issue(); delete snapshot[key]; denied(snapshot);
  }
  for (const fields of [{ number: 0 }, { number: '1' }, { state: 'CLOSED' }, { labels: null },
    { labels: [null] }, { title: '' }, { body: '' }, { body: 'File: docs/guide.md\nLine: 0' },
    { body: 'File: docs/guide.md\nLine: 1\n' }, { paths: [] }]) denied({ ...issue(), ...fields });
  for (const enrollment of [null, {}, { repository }, { repository, files: [] }, { repository, files: 'docs/guide.md' }]) {
    denied(issue(), enrollment);
  }
});

test('CLI emits JSON and exits nonzero without echoing rejected input', t => {
  const dir = mkdtempSync(join(tmpdir(), 'jules-triage-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const manifest = join(dir, 'policy.json');
  writeFileSync(manifest, JSON.stringify(policy));
  const run = input => spawnSync(process.execPath, [fileURLToPath(new URL('./jules-triage.mjs', import.meta.url)), manifest],
    { input, encoding: 'utf8' });
  const ok = run(JSON.stringify(issue()));
  assert.equal(ok.status, 0); assert.deepEqual(JSON.parse(ok.stdout), triageIssue(issue(), policy));
  for (const input of ['', 'not_json_canary', JSON.stringify({ ...issue(), body: 'private_canary' })]) {
    const result = run(input);
    assert.equal(result.status, 1); assert.equal(JSON.parse(result.stdout).eligible, false);
    assert.doesNotMatch(result.stdout + result.stderr, /canary/);
  }
});
