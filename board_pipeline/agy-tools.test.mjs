import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import tools from './agy-tools.cjs';

const exec = promisify(execFile);

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'df-agy-tools-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const snapshot = join(root, 'review');
  const outside = join(root, 'outside.txt');
  await mkdir(join(snapshot, 'candidate'), { recursive: true });
  await writeFile(join(snapshot, 'candidate', 'ok.txt'), 'snapshot fixture');
  await writeFile(outside, 'unrelated fixture');
  return { root, snapshot, outside };
}

test('snapshot tool schema admits only known read/search operations with contained paths', async t => {
  const { root, snapshot, outside } = await fixture(t);
  const path = join(snapshot, 'candidate', 'ok.txt');
  await symlink(outside, join(snapshot, 'candidate', 'escape'));
  for (const [name, args, expected] of [
    ['read_file', { Path: path }, 'candidate/ok.txt'],
    ['read_file', { Path: path, StartLine: 1, EndLine: 100, ByteOffset: 46080 }, 'candidate/ok.txt'],
    ['view_file', { AbsolutePath: path, StartLine: 1 }, 'candidate/ok.txt'],
    ['grep_search', { SearchPath: 'candidate', Query: 'fixture', Includes: ['*.txt'] }, 'candidate'],
    ['find_by_name', { SearchDirectory: snapshot, Pattern: 'ok.*' }, '.'],
    ['list_dir', { DirectoryPath: 'candidate' }, 'candidate'],
    ['glob', { path: '.', pattern: '**/*.txt' }, '.'],
  ]) assert.deepEqual(tools.checkSnapshotTool(snapshot, name, args), { name, path: expected });
  for (const [name, args] of [
    ['read_file', { Path: outside }], ['read_file', { Path: '../outside.txt' }],
    ['read_file', { Path: 'candidate/escape' }], ['view_file', { AbsolutePath: path, IsSkillFile: true }],
    ['read_file', { Path: path, other: root }], ['read_file', { Path: 'https://example.invalid/' }],
    ['grep_search', { SearchPath: 'candidate', Query: 'fixture', Includes: ['../*.txt'] }],
    ['run_command', { CommandLine: 'true' }], ['read_url_content', { Url: 'https://example.invalid/' }],
    ['write_to_file', { TargetFile: path }], ['invoke_subagent', { Prompt: 'read' }],
  ]) assert.throws(() => tools.checkSnapshotTool(snapshot, name, args), { reason: 'review_tool_use_forbidden' });
});

test('raw traversal through an internal symlink cannot outsmart normalized path checks', async t => {
  const { snapshot, outside } = await fixture(t);
  await mkdir(join(snapshot, 'candidate', 'deep', 'more'), { recursive: true });
  await symlink('../..', join(snapshot, 'candidate', 'deep', 'more', 'alias'));
  await writeFile(join(snapshot, 'candidate', 'deep', 'outside.txt'), 'lexically resolved file');
  const raw = 'candidate/deep/more/alias/../../outside.txt';
  assert.equal(await realpath(`${snapshot}/${raw}`), outside);
  assert.throws(() => tools.checkSnapshotTool(snapshot, 'read_file', { Path: raw }),
    { reason: 'review_tool_use_forbidden' });
});

test('a URL-shaped argument is not a file path even if a matching pathname exists', async t => {
  const { snapshot } = await fixture(t);
  await mkdir(join(snapshot, 'https:'));
  await writeFile(join(snapshot, 'https:', 'example.invalid'), 'local fixture');
  assert.throws(() => tools.checkSnapshotTool(snapshot, 'read_file', { Path: 'https://example.invalid' }),
    { reason: 'review_tool_use_forbidden' });
});

test('missing files inside the snapshot are permitted for deletion checks, but dangling or outside symlinks are denied', async t => {
  const { root, snapshot } = await fixture(t);
  assert.deepEqual(
    tools.checkSnapshotTool(snapshot, 'view_file', { AbsolutePath: join(snapshot, 'candidate', 'deleted.py') }),
    { name: 'view_file', path: 'candidate/deleted.py' },
  );
  assert.deepEqual(
    tools.checkSnapshotTool(snapshot, 'read_file', { Path: 'candidate/removed-dir/deleted.py' }),
    { name: 'read_file', path: 'candidate/removed-dir/deleted.py' },
  );
  await symlink(join(root, 'missing-outside.txt'), join(snapshot, 'candidate', 'dangling'));
  await symlink(root, join(snapshot, 'candidate', 'ext-dir'));
  for (const bad of [
    join(snapshot, 'candidate', 'dangling'),
    join(snapshot, 'candidate', 'ext-dir', 'missing.txt'),
    join(root, 'missing-outside.txt'),
  ]) {
    assert.throws(() => tools.checkSnapshotTool(snapshot, 'read_file', { Path: bad }),
      { reason: 'review_tool_use_forbidden' });
  }
});

test('the trusted pre-tool hook records contained reads and denies traversal before dispatch', async t => {
  const { root, snapshot, outside } = await fixture(t);
  // This standalone test intentionally has no process-group file. Live Agy
  // sessions enroll their own detached group before first sending the prompt.
  const hook = fileURLToPath(new URL('./agy-pre-tool.cjs', import.meta.url));
  const { spawn } = await import('node:child_process');
  async function invoke(path) {
    const child = spawn(process.execPath, [hook, snapshot, root, root], { stdio: ['pipe', 'pipe', 'inherit'] });
    const done = once(child, 'close');
    child.stdin.end(JSON.stringify({ stepIdx: 2, toolCall: { name: 'read_file', args: { Path: path } } }));
    const chunks = [];
    for await (const chunk of child.stdout) chunks.push(chunk);
    assert.equal((await done)[0], 0);
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  assert.equal((await invoke('candidate/ok.txt')).decision, 'allow');
  assert.equal((await invoke(outside)).decision, 'deny');
});

test('Landlock permits snapshot reads, denies writes and ambient file reads, and fences TCP', async t => {
  const { root, snapshot, outside } = await fixture(t);
  const dirs = Object.fromEntries(['home', 'runtime', 'tmp', 'events', 'control'].map(key => [key, join(root, key)]));
  await Promise.all(Object.values(dirs).map(path => mkdir(path)));
  const allowed = createServer(socket => socket.end());
  const denied = createServer(() => assert.fail('blocked TCP port was reached'));
  for (const server of [allowed, denied]) {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise(resolve => server.close(resolve)));
  }
  const spec = { ...dirs, snapshot, proxyPort: allowed.address().port, binary: process.execPath, node: process.execPath };
  const script = `import assert from 'node:assert/strict';
    import {readFile,writeFile} from 'node:fs/promises';
    import {connect} from 'node:net'; import {once} from 'node:events';
    assert.equal(await readFile('candidate/ok.txt','utf8'),'snapshot fixture');
    await assert.rejects(writeFile('candidate/ok.txt','bad'),{code:'EACCES'});
    await assert.rejects(readFile(${JSON.stringify(outside)}),{code:'EACCES'});
    const good=connect(${allowed.address().port},'127.0.0.1'); await once(good,'connect'); good.destroy();
    const bad=connect(${denied.address().port},'127.0.0.1');
    assert.equal((await once(bad,'error'))[0].code,'EACCES');
  `;
  const launcher = fileURLToPath(new URL('./agy-landlock.py', import.meta.url));
  await exec('/usr/bin/python3', [launcher, JSON.stringify(spec), '--input-type=module', '-e', script],
    { cwd: snapshot, timeout: 10_000 });
});
