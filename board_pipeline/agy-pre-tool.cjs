'use strict';

const { appendFileSync, readFileSync, readSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { checkSnapshotTool } = require('./agy-tools.cjs');
const [snapshot, control, events] = process.argv.slice(2);

function readHookPayload() {
  const chunks = [];
  let size = 0;
  for (;;) {
    const buf = Buffer.alloc(8192);
    const count = readSync(0, buf, 0, buf.length, null);
    if (count === 0) break;
    size += count;
    if (size > 1024 * 1024) throw new Error('oversized hook payload');
    chunks.push(buf.subarray(0, count));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

try {
  const { toolCall, stepIdx } = readHookPayload();
  if (!Number.isSafeInteger(stepIdx) || stepIdx < 0) throw new Error('invalid hook index');
  const checked = checkSnapshotTool(snapshot, toolCall?.name, toolCall?.args);
  appendFileSync(join(events, 'reads.ndjson'), `${JSON.stringify({ stepIdx, ...checked })}\n`, { mode: 0o600 });
  process.stdout.write('{"decision":"allow"}\n');
} catch {
  // Agy may report a tool only after execution. Terminate here, before the
  // tool runs. The protected PID belongs to this detached Agy process group.
  try {
    writeFileSync(join(events, 'forbidden'), 'review_tool_use_forbidden\n', { mode: 0o600 });
    const group = Number(readFileSync(join(control, 'group'), 'utf8'));
    if (Number.isSafeInteger(group) && group > 1) process.kill(-group, 'SIGKILL');
  } catch { /* Never allow if termination has no observable acknowledgement. */ }
  process.stdout.write('{"decision":"deny","reason":"review_tool_use_forbidden"}\n');
}
