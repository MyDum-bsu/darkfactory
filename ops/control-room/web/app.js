/* Darkfactory Control Room — zero-dep клиент поверх /api/snapshot + SSE.
   Весь недоверенный текст рендерится строго через textContent —
   HTML-инъекций в логах/карточках/событиях быть не может. */
'use strict';

const $ = id => document.getElementById(id);
const state = { snapshot: null, showAllDone: false, driftOpen: false, cleanOnly: true };

const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};

const fmtBytes = n => n == null ? '—' : `${(n / (1 << 30)).toFixed(1)}G`;
const fmtMs = ms => {
  if (ms == null) return '—';
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

function chip(id, text, cls) {
  const node = $(id);
  node.textContent = text;
  node.classList.remove('ok', 'warn', 'bad');
  if (cls) node.classList.add(cls);
}

function renderStatus(snap) {
  const host = snap.netHealth?.host ?? {};
  const running = snap.running?.length ?? 0;
  chip('chip-slots', `слоты ${running}`, running ? 'ok' : null);
  chip('chip-killswitch', snap.killSwitch ? 'KILL-SWITCH' : 'kill-switch: off',
    snap.killSwitch ? 'bad' : null);
  chip('chip-disk', `disk ${fmtBytes(host.disk?.freeBytes)}`,
    host.disk && host.disk.freeBytes < 8 * (1 << 30) ? 'warn' : null);
  chip('chip-ram', `RAM ${fmtBytes(host.mem?.freeBytes)}/${fmtBytes(host.mem?.totalBytes)}`);
  const cloud = snap.netHealth?.cloudWorker?.status ?? 'unknown';
  chip('chip-cloud', `cloud ${cloud}`, cloud === 'running' ? 'ok' : cloud === 'stale' ? 'warn' : 'dim');
  const probes = snap.netHealth?.probes ?? [];
  const worst = probes.some(p => p.status === 'dead') ? 'bad'
    : probes.some(p => p.status === 'blocked') ? 'warn' : 'ok';
  chip('chip-net', `net ${probes.length ? worst : '—'}`, probes.length ? worst : 'dim');
  const drift = snap.branchDrift;
  if (drift == null) {
    chip('chip-drift', 'drift —', 'dim');
  } else if (drift.driftDetected === true) {
    const n = (drift.unmergedBranches?.length ?? 0) + (drift.dirtyWorktrees?.length ?? 0);
    chip('chip-drift', `drift: ${n} bb/thr_*: ${drift.bbThreadWorktrees?.length ?? 0}`, 'warn');
  } else {
    chip('chip-drift', 'drift: clean', 'ok');
  }
  $('chip-ts').textContent = (snap.ts ?? '').slice(11, 19);
}

function renderDriftPanel(snap) {
  const panel = $('drift-panel');
  panel.classList.toggle('hidden', !state.driftOpen);
  if (!state.driftOpen) return;
  panel.replaceChildren();
  const drift = snap.branchDrift;
  if (!drift || drift.driftDetected !== true) {
    panel.append(el('div', null, 'Невлитых веток и грязных worktree нет.'));
    return;
  }
  for (const b of drift.unmergedBranches ?? []) {
    panel.append(el('div', null,
      `unmerged: ${b.branch} (${b.fileCount} files)${b.isBbThread ? ' [bb]' : ''}`));
  }
  for (const w of drift.dirtyWorktrees ?? []) {
    panel.append(el('div', null,
      `dirty: ${w.path} (${w.dirtyCount} files)${w.isBbThread ? ' [bb]' : ''}`));
  }
}

function dagProgress(card) {
  const bar = el('div', 'progress');
  const phases = ['claiming', 'working', 'checking', 'returning', 'done'];
  const idx = phases.indexOf(card.phase);
  if (idx >= 0) {
    const fill = el('div');
    fill.style.width = `${Math.round(((idx + 1) / phases.length) * 100)}%`;
    bar.append(fill);
  }
  return bar;
}

function card(cardData, kind, shivaLookup) {
  const node = el('div', 'card');
  const top = el('div', 'top');
  top.append(el('span', 'id', `#${cardData.task_id}`));
  top.append(el('span', 'title', cardData.title || '(без названия)'));
  if (cardData.mode) top.append(el('span', `badge ${cardData.mode === 'write' ? 'rw' : 'ro'}`,
    cardData.mode === 'write' ? 'RW' : 'RO'));
  if (cardData.role) top.append(el('span', 'badge', cardData.role));
  const shiva = shivaLookup?.(cardData);
  if (shiva) top.append(el('span', `badge shiva-${shiva.clean ? 'clean' : 'dirty'}`,
    `шива ${shiva.count}`));
  node.append(top);

  const meta = el('div', 'meta');
  if (cardData.phase) meta.append(el('span', null, `фаза ${cardData.phase}`));
  if (cardData.model) meta.append(el('span', null, cardData.model));
  if (cardData.round != null) meta.append(el('span', null, `R${cardData.round}`));
  if (cardData.tokens != null) meta.append(el('span', null, `tok ${cardData.tokens}`));
  if (cardData.deadline_rem_ms != null) {
    meta.append(el('span', null, `⏱ ${fmtMs(cardData.deadline_rem_ms)}`));
  }
  if (meta.childNodes.length) node.append(meta);
  if (kind === 'running') node.append(dagProgress(cardData));
  if (cardData.lastEvent) node.append(el('div', 'last', String(cardData.lastEvent)));
  if (cardData.question || cardData.evidence) {
    node.append(el('div', 'evidence',
      `${cardData.question ?? ''}${cardData.evidence ? `\n${cardData.evidence}` : ''}`));
  }
  if (cardData.cli) {
    const cmd = el('div', 'cmd', cardData.cli);
    cmd.title = 'Клик — скопировать команду ответа';
    cmd.addEventListener('click', ev => {
      ev.stopPropagation();
      navigator.clipboard?.writeText(cardData.cli).catch(() => {});
    });
    node.append(cmd);
  }
  node.addEventListener('click', () => openInspect(cardData.task_id));
  return node;
}

const list = (id, items, kind, empty, shivaLookup) => {
  const box = $(id);
  box.replaceChildren();
  for (const item of items) box.append(card(item, kind, shivaLookup));
  if (!items.length) box.append(el('div', 'empty', empty));
};

function renderBoard(snap) {
  $('count-running').textContent = snap.running?.length ?? 0;
  $('count-queued').textContent = snap.queued?.length ?? 0;
  $('count-owner').textContent = snap.needsOwner?.length ?? 0;
  list('running', snap.running ?? [], 'running', 'Нет активных попыток');
  list('queued', snap.queued ?? [], 'queued', 'Очередь пуста');
  list('needs-owner', snap.needsOwner ?? [], 'owner', 'Нет вопросов владельцу');
  const done = snap.recentlyCompleted ?? [];
  $('count-done').textContent = done.length;
  const shown = state.showAllDone ? done : done.slice(0, 10);
  list('done', shown, 'done', 'Пока пусто');
  const toggle = $('toggle-done');
  toggle.classList.toggle('hidden', done.length <= 10);
  toggle.textContent = state.showAllDone ? 'Свернуть' : `Показать все ${done.length}`;
}

function renderProjects(snap) {
  const box = $('projects');
  box.replaceChildren();
  const byProject = new Map();
  for (const t of [...(snap.running ?? []), ...(snap.queued ?? []),
      ...(snap.needsOwner ?? []), ...(snap.recentlyCompleted ?? [])]) {
    const proj = t.labels?.project ?? t.labels?.repo_id ?? 'default';
    if (!byProject.has(proj)) byProject.set(proj, {});
    byProject.get(proj)[t.state] = (byProject.get(proj)[t.state] ?? 0) + 1;
  }
  if (!byProject.size) {
    box.append(el('span', 'empty', 'Проекты: нет активных'));
    return;
  }
  for (const [name, counts] of byProject) {
    const proj = el('div', 'proj');
    proj.append(el('span', 'name', name));
    for (const [role, n] of Object.entries({ Lead: counts.claimed ?? 0,
        Worker: counts.working ?? 0, 'Stage/Critic': counts.checking ?? 0,
        Arbiter: counts.blocked ?? 0 })) {
      proj.append(el('span', 'role', `${role} `)).append(el('b', null, String(n)));
    }
    box.append(proj);
  }
}

async function openInspect(taskId) {
  const panel = $('inspect');
  panel.classList.remove('hidden');
  $('inspect-title').textContent = `inspect #${taskId}`;
  const body = $('inspect-body');
  body.textContent = 'загрузка…';
  try {
    const res = await fetch(`/api/inspect/${encodeURIComponent(taskId)}`);
    const data = await res.json();
    body.textContent = data.text || '(пусто)';
    if (data.artifacts?.length) {
      body.textContent += `\n\nartifacts:\n${data.artifacts.join('\n')}`;
    }
  } catch (error) {
    body.textContent = `ошибка: ${error.message}`;
  }
}

function render(snap) {
  state.snapshot = snap;
  renderStatus(snap);
  renderDriftPanel(snap);
  renderBoard(snap);
  renderProjects(snap);
}

async function refresh() {
  try {
    const res = await fetch('/api/snapshot');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    render(await res.json());
    $('state-banner').classList.add('hidden');
  } catch (error) {
    const banner = $('state-banner');
    banner.classList.remove('hidden');
    banner.textContent = `Нет связи с агрегатором: ${error.message}`;
  }
}

function connectSse() {
  const es = new EventSource('/api/events');
  es.onmessage = ev => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'snapshot') render(msg.data);
      else if (msg.type === 'event') refresh();
    } catch { /* noop */ }
  };
  es.onerror = () => { es.close(); setTimeout(connectSse, 3000); };
}

$('toggle-done').addEventListener('click', () => {
  state.showAllDone = !state.showAllDone;
  if (state.snapshot) renderBoard(state.snapshot);
});
$('chip-drift').addEventListener('click', () => {
  state.driftOpen = !state.driftOpen;
  if (state.snapshot) renderDriftPanel(state.snapshot);
});
$('inspect-close').addEventListener('click', () => $('inspect').classList.add('hidden'));
$('toggle-clean').addEventListener('change', ev => { state.cleanOnly = ev.target.checked; });

document.addEventListener('keydown', ev => {
  if (ev.key === 'Escape') $('inspect').classList.add('hidden');
});

refresh();
connectSse();
setInterval(refresh, 5000);
