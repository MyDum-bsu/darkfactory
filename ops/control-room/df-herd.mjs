// df-herd — терминальный read-only пульт фабрики: zero-dep Node ESM.
// 4 вкладки: Ops / Models / FinOps / Workspace. HTTP и HTTPS/Tailscale URL
// читаются прямыми node:http(s)-запросами; env proxy не используется.
// Ноль мутаций Board, ноль PTY-записи в треды; весь недоверенный текст через
// sanitizeTerminalText.
//
//   node df-herd.mjs [--url http://127.0.0.1:44110] [--once] [--tab ops]
// Клавиши: 1/2/3/4 или Tab — вкладки, j/k/↑/↓ — выбор в Ops,
// Enter — инспекция, d — drift, r — refresh, ? — help, q — quit.

import { get as httpGet } from 'node:http';
import { get as httpsGet } from 'node:https';
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
const eur = n => n == null ? '—' : `€${Number(n).toFixed(2)}`;
const pad = (s, w) => { const v = visibleLen(s); return s + ' '.repeat(Math.max(0, w - v)); };

export const fetchJson = (url, timeoutMs = 6000) => new Promise((resolve, reject) => {
  let parsed;
  try { parsed = new URL(url); } catch (error) { reject(error); return; }
  const get = parsed.protocol === 'https:' ? httpsGet : parsed.protocol === 'http:' ? httpGet : null;
  if (!get) { reject(new Error(`unsupported URL scheme: ${parsed.protocol}`)); return; }
  const req = get(parsed, res => {
    if (res.statusCode !== 200) { res.resume(); reject(new Error(`HTTP ${res.statusCode}`)); return; }
    let body = '';
    res.on('data', c => { body += c; });
    res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
  });
  req.on('error', reject);
  req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
});

// --- общие элементы -------------------------------------------------------------

const TABS = [
  ['ops', 'Ops'], ['models', 'Models'], ['finops', 'FinOps'], ['workspace', 'Workspace']];

function tabLine(snap, active, width) {
  const parts = TABS.map(([id, label], i) =>
    id === active ? `${C.invert}[${i + 1}:${label}]${C.reset}` : ` ${i + 1}:${label} `);
  const mode = snap.models?.ok ? `mode:${clean(snap.models.mode ?? '—')}` : 'mode:—';
  const cloud = `cloud-bb-worker:${clean(snap.netHealth?.cloudWorker?.status ?? 'unknown')}`;
  return fitAnsi(`${parts.join(' ')}  ${C.accent}${mode}${C.reset}  ${cloud}`, width);
}

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
    `shiva:${snap.shiva?.dirty === 0 ? 'clean' : `dirty(${snap.shiva?.dirty ?? '—'})`}`,
  ];
  if (snap.lastError) parts.push(`${C.bad}${clean(snap.lastError)}${C.reset}`);
  return fitAnsi(parts.join('  '), width);
}

const visibleLen = s => s.replace(/\x1b\[[0-9;]*m/g, '').length;

function fitAnsi(s, w) {
  // Сначала строим безопасную строку: разрешены только наши SGR-коды, каждый
  // видимый символ дополнительно проходит clean(). Затем, только если visible
  // width действительно превышает w, обрезаем до w-1 и добавляем '…'.
  const sgrAt = (text, at) =>
    text.slice(at, at + 5).match(/^\x1b\[(?:0|1|2|7|31|32|33|36)m/)?.[0] ?? null;
  let built = '';
  let visible = 0;
  let open = false;
  for (let i = 0; i < s.length;) {
    if (s[i] === '\x1b') {
      const sequence = sgrAt(s, i);
      if (sequence) {
        built += sequence;
        open = sequence !== C.reset;
        i += sequence.length;
      } else {
        i++; // неизвестный escape никогда не уходит в терминал
      }
      continue;
    }
    const safe = clean(s[i]);
    built += safe;
    if (safe) visible++;
    i++;
  }
  if (visible <= w) return built + (open ? C.reset : '');

  let out = '';
  let outVisible = 0;
  open = false;
  const limit = Math.max(0, w - 1);
  for (let i = 0; i < built.length && outVisible < limit;) {
    if (built[i] === '\x1b') {
      const sequence = sgrAt(built, i);
      if (sequence) {
        out += sequence;
        open = sequence !== C.reset;
        i += sequence.length;
        continue;
      }
    }
    out += built[i];
    outVisible++;
    i++;
  }
  return `${out}…${open ? C.reset : ''}`;
}

const money = n => n == null ? '—' : eur(n);

// --- OPS ------------------------------------------------------------------------

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

function renderOps(snap, { width = 100, selected = 0, projectFilter = null, driftOpen = false } = {}) {
  const available = Math.max(12, width - 6); // два разделителя ' │ ' = 6 visible chars
  const first = Math.floor(available * 0.42);
  const second = Math.floor(available * 0.28);
  const colW = [first, second, available - first - second];
  const filter = cardData => projectFilter === null ||
    (cardData.labels?.project ?? cardData.labels?.repo_id ?? 'default') === projectFilter;
  const cols = [
    ['RUNNING NOW', (snap.running ?? []).filter(filter), 'running'],
    ['QUEUED / WAITING', (snap.queued ?? []).filter(filter), 'queued'],
    ['NEEDS OWNER', (snap.needsOwner ?? []).filter(filter), 'owner'],
  ];
  const lines = [];
  const maxRows = Math.max(...cols.map(([, items]) => items.length), 1) + 2;
  const selectable = [];
  for (let row = 0; row < maxRows; row++) {
    const cells = [];
    for (let c = 0; c < 3; c++) {
      const [title, items, kind] = cols[c];
      if (row === 0) cells.push(fitAnsi(`${C.bold}${clean(title)} (${items.length})${C.reset}`, colW[c]));
      else if (row === 1) cells.push(trunc('─'.repeat(Math.min(colW[c], 40)), colW[c]));
      else {
        const item = items[row - 2];
        if (item) {
          const idx = selectable.length;
          selectable.push({ ...item, kind });
          cells.push(cardLine(item, colW[c], idx === selected));
        } else if (row === 2) {
          cells.push(fitAnsi(`${C.dim}—${C.reset}`, colW[c]));
        } else cells.push('');
      }
    }
    lines.push(cells.map((cell, i) => pad(cell, colW[i])).join(' │ '));
  }
  const done = (snap.recentlyCompleted ?? []).filter(filter);
  lines.push('', fitAnsi(`${C.bold}RECENTLY COMPLETED (${done.length})${C.reset}`, width));
  for (const item of done.slice(0, 8)) lines.push(trunc(`  #${item.task_id} ${item.title}`, width));
  if (done.length > 8) lines.push(trunc(`  … ещё ${done.length - 8}`, width));
  if (driftOpen && snap.branchDrift?.driftDetected === true) {
    lines.push('', fitAnsi(`${C.warn}BRANCH DRIFT${C.reset}`, width));
    for (const b of snap.branchDrift.unmergedBranches ?? []) {
      lines.push(trunc(`  unmerged ${b.branch} (${b.fileCount}f)`, width));
    }
    for (const w of snap.branchDrift.dirtyWorktrees ?? []) {
      lines.push(trunc(`  dirty ${w.path} (${w.dirtyCount}f)`, width));
    }
  }
  lines.push('', fitAnsi(`${C.dim}1-4/Tab:вкладки j/k:выбор Enter:инспекция d:drift r:refresh ?:help q:quit${C.reset}`, width));
  return { lines, selectable };
}

// --- MODELS ---------------------------------------------------------------------

function statusPaint(status) {
  const s = clean(status ?? '—');
  const label = s.replaceAll('_', ' ').toUpperCase();
  if (s === 'promo_free') return `${C.ok}${label}${C.reset}`;
  if (s === 'active') return `${C.accent}${label}${C.reset}`;
  if (s === 'standby') return `${C.dim}${label}${C.reset}`;
  if (s === 'quota_paused') return `${C.warn}${label}${C.reset}`;
  if (s === 'disabled') return `${C.bad}${label}${C.reset}`;
  return label;
}

function modelLayout(width) {
  if (width >= 105) {
    const fixed = { id: 22, provider: 18, family: 10, status: 12, until: 10 };
    return { ...fixed,
      model: Math.max(10, width - fixed.id - fixed.provider - fixed.family -
        fixed.status - fixed.until - 5),
      showProvider: true, showUntil: true };
  }
  const fixed = { id: 20, family: 10, status: 12 };
  const showUntil = width >= 100;
  const until = showUntil ? 10 : 0;
  const separators = showUntil ? 4 : 3;
  return { ...fixed, until,
    model: Math.max(8, width - fixed.id - fixed.family - fixed.status - until - separators),
    showProvider: false, showUntil };
}

function modelRow(model, width) {
  const layout = modelLayout(width);
  const cols = [pad(trunc(model.id, layout.id), layout.id)];
  if (layout.showProvider) cols.push(pad(trunc(model.provider, layout.provider), layout.provider));
  cols.push(pad(trunc(model.model, layout.model), layout.model));
  cols.push(pad(trunc(model.family, layout.family), layout.family));
  const status = pad(statusPaint(model.effectiveStatus ?? model.status), layout.status);
  if (layout.showUntil) {
    cols.push(status, trunc(model.until ?? '—', layout.until));
  } else {
    cols.push(status);
  }
  return fitAnsi(cols.join(' '), width);
}

function modelHeader(width) {
  const layout = modelLayout(width);
  const cols = [pad('id', layout.id)];
  if (layout.showProvider) cols.push(pad('provider', layout.provider));
  cols.push(pad('model', layout.model), pad('family', layout.family), pad('status', layout.status));
  if (layout.showUntil) cols.push('until');
  return cols.join(' ');
}

function renderModels(snap, { width = 100 } = {}) {
  const models = snap.models;
  if (!models?.ok) return { lines: [`${C.bad}models: ${clean(models?.error ?? 'нет данных')}${C.reset}`], selectable: [] };
  const lines = [];
  const triad = models.triad ?? {};
  const roles = [['Coder', triad.coder], ['Reviewer', triad.reviewer], ['Arbiter', triad.arbiter],
    ['Lead', triad.lead], ['UX Critic', triad.ux_critic]];
  lines.push(fitAnsi(`${C.bold}ACTIVE ROUTING — mode:${clean(models.mode)}${C.reset}`, width));
  for (const [role, selected] of roles) {
    const value = selected
      ? `${role}: ${selected.id} [${selected.family}] alt:${(selected.alternatives ?? []).slice(0, 2).join(',') || '—'}`
      : `${role}: —`;
    lines.push(trunc(`  ${value}`, width));
  }
  lines.push('', fitAnsi(`${C.bold}MODEL REGISTRY${C.reset}`, width));
  lines.push(fitAnsi(`${C.dim}${modelHeader(width)}${C.reset}`, width));
  for (const model of models.models ?? []) lines.push(modelRow(model, width));
  lines.push('', fitAnsi(`${C.dim}CLI: df-models set <role> <model> · df-models mode economy|balanced|sprint${C.reset}`, width));
  return { lines, selectable: [] };
}

// --- FINOPS ---------------------------------------------------------------------

function progressBar(pct, width = 18) {
  if (pct == null) return '—';
  const n = Math.max(0, Math.min(width, Math.round((pct / 100) * width)));
  return `[${'█'.repeat(n)}${'░'.repeat(width - n)}] ${pct.toFixed(1)}%`;
}

function renderFinops(snap, { width = 100 } = {}) {
  const finops = snap.finops;
  if (!finops?.ok) return { lines: [`${C.bad}finops: ${clean(finops?.error ?? 'нет данных')}${C.reset}`], selectable: [] };
  const lines = [];
  const totals = finops.totals ?? {};
  lines.push(fitAnsi(`${C.bold}MONEY / CREDITS${C.reset}  month spend ${money(totals.spentMonthCostEur)}  today ${money(totals.spentTodayCostEur)}  budget ${money(totals.monthlyBudgetEur)}  credits ${money(totals.remainingCreditsEur)}  runway ${finops.creditRunway?.days ?? '—'}d`, width), '');
  lines.push(fitAnsi(`${C.bold}GCP credits${C.reset}`, width));
  for (const credit of finops.cloudCredits ?? []) {
    lines.push(trunc(`  ${credit.id}: total ${money(credit.totalEur)} remaining ${money(credit.remainingEur)}${credit.monthlyEur != null ? ` monthly ${money(credit.monthlyEur)}` : ''}${credit.expires ? ` expires ${credit.expires}` : ''}`, width));
  }
  lines.push('', fitAnsi(`${C.bold}Compute VMs${C.reset}`, width));
  for (const vm of finops.computeVms ?? []) {
    lines.push(trunc(`  ${vm.id}: ${vm.machineType ?? '—'} ${vm.state ?? '—'}  today ${money(vm.costTodayEur)} month ${money(vm.costMonthEur)} hours ${((vm.runningMinutesMonth ?? 0) / 60).toFixed(1)}  ${vm.pricing ?? ''}`, width));
  }
  lines.push('', fitAnsi(`${C.bold}Compute quotas${C.reset}`, width));
  for (const quota of finops.computeQuotas ?? []) {
    const token = quota.status === 'underutilized' ? 'IDLE / UNDERUTILIZED' : 'OK';
    const plain = trunc(`  ${quota.id}: ${progressBar(quota.utilizationPct)} of ${quota.totalUnits ?? '—'}${quota.unit ? ` ${quota.unit}` : ''}  ${token}`, width);
    const color = quota.status === 'underutilized' ? C.warn : C.ok;
    lines.push(plain.replace(token, `${color}${token}${C.reset}`));
  }
  lines.push('', fitAnsi(`${C.bold}AI subscriptions${C.reset}`, width));
  for (const sub of finops.aiSubscriptions ?? []) {
    lines.push(trunc(`  ${sub.id}: ${sub.model ?? sub.label ?? '—'}  ${String(sub.status ?? '—').replaceAll('_', ' ').toUpperCase()}${sub.quota ? ` quota:${sub.quota}` : ''}${sub.reset ? ` reset:${sub.reset}` : ''}`, width));
  }
  if (finops.alerts?.length) {
    lines.push('', fitAnsi(`${C.warn}ALERTS${C.reset}`, width));
    for (const alert of finops.alerts) {
      const color = alert.severity === 'bad' ? C.bad : C.warn;
      lines.push(fitAnsi(trunc(`  ${alert.code} ${alert.message}`, width), width).replace(clean(alert.code), () => `${color}${clean(alert.code)}${C.reset}`));
    }
  }
  return { lines, selectable: [] };
}

// --- WORKSPACE ------------------------------------------------------------------

function renderWorkspace(snap, { width = 100 } = {}) {
  const finops = snap.finops;
  if (!finops?.ok) return { lines: [`${C.bad}workspace: ${clean(finops?.error ?? 'нет данных')}${C.reset}`], selectable: [] };
  const lines = [fitAnsi(`${C.bold}WORKSPACE MAP${C.reset}`, width), ''];
  const groups = new Map();
  for (const link of finops.workspaceLinks ?? []) {
    const group = clean(link.group ?? 'workspace');
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(link);
  }
  for (const [group, links] of groups) {
    lines.push(fitAnsi(`${C.accent}${clean(group.replaceAll('_', ' ').toUpperCase())}${C.reset}`, width));
    for (const link of links) {
      const target = link.url ?? link.path ?? '—';
      const cmd = link.command ? `  cmd:${link.command}` : '';
      lines.push(trunc(`  ${link.title}: ${target}${cmd}`, width));
      if (link.notes) lines.push(fitAnsi(`    ${C.dim}${clean(link.notes)}${C.reset}`, width));
    }
    lines.push('');
  }
  lines.push(fitAnsi(`${C.bold}QUICK COMMANDS${C.reset}`, width));
  for (const cmd of ['df-herd', 'df-models', 'vb', 'cloud-brain']) {
    lines.push(trunc(`  ${cmd}`, width));
  }
  return { lines, selectable: [] };
}

// --- dispatcher ------------------------------------------------------------------

function render(snap, { width = 100, selected = 0, projectFilter = null, driftOpen = false, tab = 'ops' } = {}) {
  const active = TABS.some(([id]) => id === tab) ? tab : 'ops';
  const body = active === 'models' ? renderModels(snap, { width })
    : active === 'finops' ? renderFinops(snap, { width })
    : active === 'workspace' ? renderWorkspace(snap, { width })
    : renderOps(snap, { width, selected, projectFilter, driftOpen });
  return {
    text: [tabLine(snap, active, width), statusLine(snap, width), '', ...body.lines].join('\n'),
    selectable: body.selectable ?? [],
  };
}

function projectList(snap) {
  const set = new Set();
  for (const t of [...(snap.running ?? []), ...(snap.queued ?? []),
      ...(snap.needsOwner ?? []), ...(snap.recentlyCompleted ?? [])]) {
    set.add(t.labels?.project ?? t.labels?.repo_id ?? 'default');
  }
  return [...set];
}

// --- main ------------------------------------------------------------------------

async function main(argv) {
  const { values } = parseArgs({ args: argv, options: {
    url: { type: 'string' }, once: { type: 'boolean' }, tab: { type: 'string' },
    width: { type: 'string' }, project: { type: 'string' } } });
  const base = (values.url ?? process.env.DF_CONTROL_ROOM_URL ?? 'http://127.0.0.1:44110')
    .replace(/\/$/, '');
  const width = Number(values.width ?? process.stdout.columns ?? 100);
  const initialTab = TABS.some(([id]) => id === values.tab) ? values.tab : 'ops';

  if (values.once) {
    const snap = await fetchJson(`${base}/api/snapshot`);
    const { text } = render(snap, { width, tab: initialTab });
    process.stdout.write(`${text}\n`);
    return;
  }

  const state = { snap: null, selected: 0, driftOpen: false,
    projectFilter: values.project ?? null, inspect: null, tab: initialTab };
  const redraw = () => {
    if (state.inspect) {
      process.stdout.write(`${C.clear}${C.hide}${state.inspect}\n`);
      return;
    }
    const body = state.snap
      ? render(state.snap, { width, selected: state.selected, tab: state.tab,
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

  const keymap = async key => {
    if (state.inspect !== null) {
      if (key === 'q' || key === '\x1b') { state.inspect = null; redraw(); }
      return;
    }
    if (key === 'q' || key === '\x03') { cleanup(); return; }
    if (key === '\t') {
      const index = TABS.findIndex(([id]) => id === state.tab);
      state.tab = TABS[(index + 1) % TABS.length][0];
      state.selected = 0;
    } else if (/^[1-4]$/.test(key)) {
      state.tab = TABS[Number(key) - 1][0];
      state.selected = 0;
    } else if (state.tab === 'ops' && (key === 'j' || key === '\x1b[B')) {
      state.selected = Math.min(state.selected + 1, Math.max(0, (state.selectable?.length ?? 1) - 1));
    } else if (state.tab === 'ops' && (key === 'k' || key === '\x1b[A')) {
      state.selected = Math.max(0, state.selected - 1);
    } else if (state.tab === 'ops' && key === 'd') {
      state.driftOpen = !state.driftOpen;
    } else if (key === 'r') {
      await refresh(); return;
    } else if (key === '?') {
      state.inspect = 'df-herd: 1 Ops, 2 Models, 3 FinOps, 4 Workspace, Tab — следующая вкладка. В Ops: j/k — навигация, Enter — инспекция, d — drift, r — refresh, q — выход.';
    } else if (state.tab === 'ops' && key === '0') {
      state.projectFilter = null;
    } else if (state.tab === 'ops' && (key === '[' || key === ']')) {
      const list = projectList(state.snap ?? {});
      if (list.length) {
        const index = list.indexOf(state.projectFilter);
        const delta = key === ']' ? 1 : -1;
        state.projectFilter = list[(index + delta + list.length + 1) % (list.length + 1)] ?? null;
      }
    } else if (state.tab === 'ops' && (key === '\r' || key === '\n')) {
      const item = state.selectable?.[state.selected];
      if (item) {
        try {
          const data = await fetchJson(`${base}/api/inspect/${encodeURIComponent(item.task_id)}`);
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
