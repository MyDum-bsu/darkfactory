import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const CYRILLIC = /[\u0400-\u04FF]/u;

async function markdownFiles(dir) {
  const out = [];
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && entry.name.endsWith('.md')) out.push(path);
    }
  }
  await walk(dir);
  return out;
}

test('darkfactory shared skills and station instructions contain no Cyrillic', async () => {
  for (const dir of ['.darkfactory/shared-skills', '.darkfactory/stations']) {
    const absolute = join(root, dir);
    const files = await markdownFiles(absolute);
    assert.ok(files.length > 0, `${dir} must contain markdown files`);
    for (const file of files) {
      const text = await readFile(file, 'utf8');
      assert.equal(CYRILLIC.test(text), false, `${file} contains Cyrillic characters`);
    }
  }
});
