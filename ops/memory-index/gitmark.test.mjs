import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const exec = promisify(execFile);
const GITMARK = new URL('./gitmark.py', import.meta.url).pathname;

const run = (args, opts = {}) => exec('python3', [GITMARK, ...args], opts)
  .then(r => ({ code: 0, stdout: r.stdout }))
  .catch(e => ({ code: e.code, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }));

const put = async (root, rel, text) => {
  const p = join(root, rel);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, text);
};

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'gitmark-')));
  await put(root, 'memory/decisions.md',
    '# Owner Decisions\n\nOwner approved the controller design in phase review.\n');
  await put(root, 'memory/notes.md',
    '# Notes\n\nВеха V2-3 добавляет шину событий и пульт управления.\n');
  await put(root, 'ops/log.jsonl',
    '{"task":1,"phase":"done","model":"swe-2"}\n{"task":2,"phase":"hold"}\n');
  return root;
}

test('index creates .gitmark/index.db and indexes md+jsonl', async () => {
  const root = await fixture();
  const r = await run(['index', root, '--json']);
  assert.equal(r.code, 0, r.stderr);
  const payload = JSON.parse(r.stdout);
  assert.ok(payload.indexed_chunks >= 3);
  assert.ok(payload.db.endsWith('.gitmark/index.db'));
});

test('search finds RU and EN content', async () => {
  const root = await fixture();
  await run(['index', root]);
  const ru = await run(['search', root, 'веха событий', '--json']);
  assert.equal(ru.code, 0);
  const ruHits = JSON.parse(ru.stdout).results;
  assert.equal(ruHits[0].path, 'memory/notes.md');
  const en = await run(['search', root, 'controller design', '--json']);
  assert.equal(JSON.parse(en.stdout).results[0].path, 'memory/decisions.md');
  const jl = await run(['search', root, 'phase hold', '--json']);
  assert.equal(JSON.parse(jl.stdout).results[0].path, 'ops/log.jsonl');
});

test('search on missing index returns code 2', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'gitmark-empty-')));
  const r = await run(['search', root, 'x', '--json']);
  assert.equal(r.code, 2);
});

test('lint reports broken link, missing h1, empty file, dup heading', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'gitmark-lint-')));
  await put(root, 'a.md', '# A\n\nsee [ghost](ghost.md)\n');
  await put(root, 'b.md', 'no heading here\n');
  await put(root, 'c.md', '');
  await put(root, 'd.md', '# D\n\n## Same\n\n## Same\n');
  const r = await run(['lint', root, '--json']);
  assert.equal(r.code, 1);
  const rules = JSON.parse(r.stdout).violations.map(v => `${v.rule}:${v.path}`);
  assert.ok(rules.includes('broken_link:a.md'));
  assert.ok(rules.includes('missing_h1:b.md'));
  assert.ok(rules.includes('empty_file:c.md'));
  assert.ok(rules.includes('duplicate_heading:d.md'));
});

test('lint passes on clean docs', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'gitmark-clean-')));
  await put(root, 'a.md', '# A\n\nfine [b](b.md)\n');
  await put(root, 'b.md', '# B\n');
  const r = await run(['lint', root, '--json']);
  assert.equal(r.code, 0);
});

test('lint --baseline tolerates old debt, fails on new violations', async () => {
  // git-репозиторий: старое нарушение закоммичено, новое в рабочем дереве.
  const root = await realpath(await mkdtemp(join(tmpdir(), 'gitmark-git-')));
  await exec('git', ['init', '-q'], { cwd: root });
  await exec('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit',
    '--allow-empty', '-qm', 'init'], { cwd: root });
  await put(root, 'old.md', 'no h1 heading\n');
  await exec('git', ['add', '.'], { cwd: root });
  await exec('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'old debt'],
    { cwd: root });
  // Только старый долг — ratchet пропускает.
  const ok = await run(['lint', root, '--baseline', 'HEAD', '--json']);
  assert.equal(ok.code, 0, ok.stdout);
  // Новое нарушение — 1.
  await put(root, 'new.md', 'also no h1\n');
  const bad = await run(['lint', root, '--baseline', 'HEAD', '--json']);
  assert.equal(bad.code, 1);
  const payload = JSON.parse(bad.stdout);
  assert.equal(payload.new, 1);
  assert.equal(payload.violations[0].path, 'new.md');
});

test('lint --baseline fails closed (2) on git error', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'gitmark-nogit-')));
  await put(root, 'a.md', '# A\n');
  const r = await run(['lint', root, '--baseline', 'HEAD', '--json'],
    { env: { ...process.env, GITMARK_NO_GIT: '1' } });
  assert.equal(r.code, 2);
});

test('secrets detects key patterns, clean tree exits 0', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'gitmark-sec-')));
  await put(root, 'ok.md', '# A\n\nnothing here\n');
  const clean = await run(['secrets', root, '--json']);
  assert.equal(clean.code, 0);
  await put(root, 'leak.md', '# A\n\nghp_abcdefghijklmnopqrstuvwxyz012345\n');
  const r = await run(['secrets', root, '--json']);
  assert.equal(r.code, 1);
  assert.equal(JSON.parse(r.stdout).secrets[0].rule, 'ghp');
});

test('secrets detects private key and BOARD_TOKEN', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'gitmark-sec2-')));
  await put(root, 'a.txt', 'BOARD_TOKEN=secret123\n-----BEGIN PRIVATE KEY-----\n');
  const r = await run(['secrets', root, '--json']);
  assert.equal(r.code, 1);
  const rules = JSON.parse(r.stdout).secrets.map(s => s.rule);
  assert.ok(rules.includes('board_token'));
  assert.ok(rules.includes('private_key'));
});
