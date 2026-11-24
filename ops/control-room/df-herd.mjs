// df-herd — терминальный read-only пульт фабрики (V2-3): zero-dep Node ESM
// TUI поверх aggregator.mjs (HTTP + SSE), работает по SSH/mosh. Ноль
// мутаций Board, ноль PTY-записи в треды; весь недоверенный текст через
// sanitizeTerminalText.
//
//   node df-herd.mjs [--url http://127.0.0.1:44110] [--once] [--project IDX]
// --once — один отрендеренный кадр и выход (smoke-тесты, SSH).
// Клавиши: j/k/↑/↓ — выбор, Enter — инспекция (plain-text логи/квитанции),
// 0-5 — фильтр проекта, d — детали Branch Drift, r — reconcile/refresh,
// ? — help, q — quit.

import { get } from 'node:http';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { sanitizeTerminalText } from './origin-guard.mjs';

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', invert: '\x1b[7m',
  accent: '\x1b[36m', ok: '\x1b[32m', warn: '\x1b[33m', bad: '\x1b[31m',
  clear: '\x1b[2J\x1b[H', hide: '\x1b[?25l', show: '\x1b[?25h',
};
const clean = s => sanitizeTerminalText(String(s ?? ''));
const trunc = (s, w) => { s = clean(s); return s.length > w ? s.slice(0, w - 1) + '…' : s; };
const fmtBytes = n => n == null ? '—' : `${(n / (1 << 30)).toFixed(1)}G`;
const fmtMs = ms => ms == null ? '—' : `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;

const fetchJson = (url, timeoutMs = 6000) => new Promise((resolve, reject) => {
  const req = get(url, res => {
    if (res.statusCode !== 200) { res.resume(); reject(new Error(`HTTP ${res.statusCode}`)); return; }
    let body = '';
    res.on('data', c => { body += c; });
    res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
  });
  req.on('error', reject);
  req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
});

// --- рендер -------------------------------------------------------------------

function statusLine(snap, width) {
  const host = snap.netHealth?.host ?? {};
  const drift = snap.branchDrift;
  const driftText = drift == null ? 'drift —'
    : drift.driftDetected === true
      ? `drift:${(drift.unmergedBranches?.length ?? 0) + (drift.dirtyWorktrees?.length ?? 0)} bb:${drift.bbThreadWorktrees?.length ?? 0}`
      : 'drift:clean';
  const cloud = snap.netHealth?.cloudWorker?.status ?? 'unknown';
  const parts = [
    `DF HERD ${C.accent}${clean((snap.ts ?? '').slice(11, 19))}${C.reset}`,
    `slots:${snap.running?.length ?? 0}`,
    `disk:${fmtBytes(host.disk?.freeBytes)}`,
    `RAM:${fmtBytes(host.mem?.freeBytes)}`,
    `cloud:${clean(cloud)}`,
    driftText,
    `shiva:${snap.shiva?.dirty === 0 ? 'clean' : `dirty(${snap.shiva?.dirty})`}`,
  ];
  return trunc(parts.join('  '), width);
}

function cardLine(cardData, width, selected) {
  const base = `#${cardData.task_id} ${trunc(cardData.title, Math.max(10, width - 46))}`;
  const meta = [
    cardData.phase ?? cardData.state, cardData.role, cardData.model,
    cardData.round != null ? `R${cardData.round}` : null,
    cardData.deadline_rem_ms != null ? `⏱${fmtMs(cardData.deadline_rem_ms)}` : null,
    cardData.tokens != null ? `tok:${cardData.tokens}` : null,
  ].filter(Boolean).join(' ');
  const line = `${base} ${meta}`;
  return `${selected ? C.invert : ''}${trunc(line, width)}${selected ? C.reset : ''}`;
}

function render(snap, { width = 100, selected = 0, projectFilter = null, driftOpen = false } = {}) {
  const colW = [Math.floor(width * 0.42), Math.floor(width * 0.28), width - Math.floor(width * 0.42) - Math.floor(width * 0.28)];
  const filter = cardData => projectFilter === null ||
    (cardData.labels?.project ?? cardData.labels?.repo_id ?? 'default') === projectFilter;
  const cols = [
    ['RUNNING NOW', (snap.running ?? []).filter(filter), 'running'],
    ['QUEUED / WAITING', (snap.queued ?? []).filter(filter), 'queued'],
    ['NEEDS OWNER', (snap.needsOwner ?? []).filter(filter), 'owner'],
  ];
  const lines = [statusLine(snap, width), ''];
  const maxRows = Math.max(...cols.map(([, items]) => items.length), 1) + 2;
  const selectable = [];
  for (let row = 0; row < maxRows; row++) {
    const cells = [];
    for (let c = 0; c < 3; c++) {
      const [title, items, kind] = cols[c];
      if (row === 0) cells.push(trunc(`${C.bold}${title} (${items.length})${C.reset}`, colW[c]));
      else if (row === 1) cells.push(trunc('─'.repeat(Math.min(colW[c], 40)), colW[c]));
      else {
        const item = items[row - 2];
        if (item) {
          const idx = selectable.length;
          selectable.push({ ...item, kind });
          cells.push(cardLine(item, colW[c], idx === selected));
        } else if (row === 2) {
          cells.push(trunc(`${C.dim}—${C.reset}`, colW[c]));
        } else cells.push('');
      }
    }
    lines.push(cells.map((cell, i) => {
      const pad = Math.max(0, colW[i] - visibleLen(cell));
      return cell + ' '.repeat(pad);
    }).join(' │ '));
  }
  const done = (snap.recentlyCompleted ?? []).filter(filter);
  lines.push('', trunc(`${C.bold}RECENTLY COMPLETED (${done.length})${C.reset}`, width));
  for (const item of done.slice(0, 8)) lines.push(trunc(`  #${item.task_id} ${item.title}`, width));
  if (done.length > 8) lines.push(trunc(`  … ещё ${done.length - 8}`, width));
  if (driftOpen && snap.branchDrift?.driftDetected === true) {
    lines.push('', trunc(`${C.warn}BRANCH DRIFT${C.reset}`, width));
    for (const b of snap.branchDrift.unmergedBranches ?? []) {
      lines.push(trunc(`  unmerged ${b.branch} (${b.fileCount}f)`, width));
    }
    for (const w of snap.branchDrift.dirtyWorktrees ?? []) {
      lines.push(trunc(`  dirty ${w.path} (${w.dirtyCount}f)`, width));
    }
  }
  lines.push('', trunc(`${C.dim}j/k:выбор Enter:инспекция 0-5:проект d:drift r:refresh ?:help q:quit${C.reset}`, width));
  return { text: lines.join('\n'), selectable };
}

const visibleLen = s => s.replace(/\x1b\[[0-9;]*m/g, '').length;

function projectList(snap) {
  const set = new Set();
  for (const t of [...(snap.running ?? []), ...(snap.queued ?? []),
      ...(snap.needsOwner ?? []), ...(snap.recentlyCompleted ?? [])]) {
    set.add(t.labels?.project ?? t.labels?.repo_id ?? 'default');
  }
  return [...set];
}

// --- main ----------------------------------------------------------------------

async function main(argv) {
  const { values } = parseArgs({ args: argv, options: {
    url: { type: 'string' }, once: { type: 'boolean' },
    width: { type: 'string' }, project: { type: 'string' } } });
  const base = (values.url ?? process.env.DF_CONTROL_ROOM_URL ?? 'http://127.0.0.1:44110')
    .replace(/\/$/, '');
  const width = Number(values.width ?? process.stdout.columns ?? 100);

  if (values.once) {
    const snap = await fetchJson(`${base}/api/snapshot`);
    const { text } = render(snap, { width });
    process.stdout.write(`${text}\n`);
    return;
  }

  // Live-режим: опрос + клавиатурная навигация. Недоверенные строки уже
  // проходят sanitizeTerminalText внутри рендера.
  const state = { snap: null, selected: 0, driftOpen: false,
    projectFilter: values.project ?? null, inspect: null };
  const redraw = () => {
    if (state.inspect) {
      process.stdout.write(`${C.clear}${C.hide}${state.inspect}\n`);
      return;
    }
    const body = state.snap
      ? render(state.snap, { width, selected: state.selected,
        projectFilter: state.projectFilter, driftOpen: state.driftOpen })
      : { text: 'connecting…', selectable: [] };
    state.selectable = body.selectable;
    process.stdout.write(`${C.clear}${C.hide}${body.text}\n`);
  };
  const refresh = async () => {
    try {
      state.snap = await fetchJson(`${base}/api/snapshot`);
    } catch (error) {
      state.snap = { ts: new Date().toISOString(), running: [], queued: [],
        needsOwner: [], recentlyCompleted: [],
        lastError: `aggregator: ${clean(error.message)}` };
    }
    redraw();
  };

  const projects = () => projectList(state.snap ?? {});
  const keymap = async key => {
    if (state.inspect !== null) {
      if (key === 'q' || key === '\x1b') { state.inspect = null; redraw(); }
      return;
    }
    if (key === 'q' || key === '\x03') { cleanup(); return; }
    if (key === 'j' || key === '\x1b[B') {
      state.selected = Math.min(state.selected + 1, Math.max(0, (state.selectable?.length ?? 1) - 1));
    } else if (key === 'k' || key === '\x1b[A') {
      state.selected = Math.max(0, state.selected - 1);
    } else if (key === 'd') {
      state.driftOpen = !state.driftOpen;
    } else if (key === 'r') {
      await refresh(); return;
    } else if (key === '?') {
      state.inspect = 'df-herd: j/k — навигация, Enter — инспекция, 0-5 — фильтр проекта, d — drift, r — refresh, q — выход.';
    } else if (/^[0-5]$/.test(key)) {
      const list = projects();
      state.projectFilter = key === '0' ? null : list[Number(key) - 1] ?? state.projectFilter;
    } else if (key === '\r' || key === '\n') {
      const item = state.selectable?.[state.selected];
      if (item) {
        try {
          const data = await fetchJson(`${base}/api/inspect/${encodeURIComponent(item.task_id)}`);
          // Весь недоверенный текст — через clean(): title/artifacts/text.
          state.inspect = clean(`#${item.task_id} ${item.title}\n\n` +
            `${data.text || '(пусто)'}` +
            (data.artifacts?.length
              ? `\n\n${data.artifacts.map(clean).join('\n')}` : ''));
        } catch (error) {
          state.inspect = `ошибка: ${clean(error.message)}`;
        }
      }
    }
    redraw();
  };

  const cleanup = () => {
    process.stdout.write(`${C.show}${C.reset}`);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
    process.exit(0);
  };

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    let pending = '';
    process.stdin.on('data', chunk => {
      pending += chunk;
      if (pending === '\x1b[') return;
      const keys = [];
      while (pending.length) {
        if (pending.startsWith('\x1b[') && pending.length < 3) break;
        if (pending.startsWith('\x1b[')) { keys.push(pending.slice(0, 3)); pending = pending.slice(3); }
        else { keys.push(pending[0]); pending = pending.slice(1); }
      }
      for (const key of keys) keymap(key).catch(() => {});
    });
  }
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  await refresh();
  const timer = setInterval(refresh, 3000);
  timer.unref();
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try { await main(process.argv.slice(2)); } catch (error) {
    console.error(`df-herd: ${sanitizeTerminalText(error.message)}`);
    process.exitCode = 1;
  }
}
