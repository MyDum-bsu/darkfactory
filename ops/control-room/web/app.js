/* Darkfactory Control Room — zero-dep клиент поверх /api/snapshot + SSE.
   Весь недоверенный текст рендерится строго через textContent —
   HTML-инъекций в логах/карточках/событиях быть не может. */
'use strict';

const $ = id => document.getElementById(id);
const state = { snapshot: null, showAllDone: false, driftOpen: false, cleanOnly: true, tab: 'ops',
  boardChannel: 'all', boardState: 'all', boardSearch: '' };

const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};

const fmtBytes = n => n == null ? '—' : `${(n / (1 << 30)).toFixed(1)}G`;
const eur = n => n == null ? '—' : `€${Number(n).toFixed(2)}`;
const safeHttpUrl = value => {
  if (typeof value !== 'string' || !value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
};
const fmtMs = ms => {
  if (ms == null) return '—';
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};


const moneyUsd = n => n == null ? '—' : `$${Number(n).toFixed(3)}`;
const pct = n => n == null ? '—' : `${Math.round(Number(n))}%`;
const shortSha = value => typeof value === 'string' && value ? value.slice(0, 12) : '—';
const statusClass = status => status === 'pass' || status === 'done' || status === 'completed' ? 'ok'
  : status === 'running' || status === 'rework' || status === 'claimed' || status === 'ready' ? 'accent'
  : status === 'hold' || status === 'blocked' || status === 'waiting' || status === 'pending' ? 'warn'
  : status === 'fail' || status === 'failed' ? 'bad' : '';

function pill(text, cls) {
  return el('span', `pill${cls ? ` ${cls}` : ''}`, text ?? '—');
}

function tokenText(tokens) {
  if (tokens == null) return '—';
  if (Number.isFinite(tokens)) return String(tokens);
  if (typeof tokens === 'object') {
    const total = Number.isFinite(tokens.total) ? tokens.total
      : (tokens.input ?? 0) + (tokens.output ?? 0);
    const cached = Number.isFinite(tokens.cached) && tokens.cached ? ` · cache ${tokens.cached}` : '';
    return `${total || '—'} tok${cached}`;
  }
  return String(tokens);
}

function opsMetric(label, value, sub, cls) {
  const node = el('div', `ops-metric${cls ? ` ${cls}` : ''}`);
  node.append(el('div', 'ops-label', label));
  node.append(el('div', 'ops-value', value));
  node.append(el('div', 'ops-sub', sub ?? 'read-only'));
  return node;
}

function renderOpsSummary(snap) {
  const box = $('ops-summary');
  box.replaceChildren();
  const trees = Array.isArray(snap.activeTrees) ? snap.activeTrees : [];
  const active = trees.filter(tree => ['running', 'rework'].includes(tree.status));
  const rounds = trees.reduce((sum, tree) => sum + (Number.isFinite(tree.rounds) ? tree.rounds : 0), 0);
  const reviews = trees.reduce((sum, tree) => sum + (tree.stages ?? []).filter(stage =>
    ['l2_critic', 'arbiter'].includes(stage.kind) && stage.status === 'running').length, 0);
  const burn = active.reduce((sum, tree) => sum + (Number.isFinite(tree.burnRatePerHr) ? tree.burnRatePerHr : 0), 0);
  const credits = snap.finops?.totals?.remainingCreditsEur;
  const slots = snap.repoSlots ?? { activeByRepo: {}, multiWriterWarnings: [] };
  const slotCount = Object.values(slots.activeByRepo ?? {}).reduce((a, b) => a + b, 0);
  const warnings = slots.multiWriterWarnings?.length ?? 0;
  box.append(
    opsMetric('Активные задачи', String(active.length), `всего деревьев ${trees.length}`, active.length ? 'ok' : null),
    opsMetric('Раунды', String(rounds), `rework ${trees.reduce((sum, tree) => sum + (tree.reworkRounds ?? 0), 0)}`),
    opsMetric('Ревью в работе', String(reviews), 'L2 critic + arbiter', reviews ? 'warn' : null),
    opsMetric('Burn rate', burn ? `$${burn.toFixed(2)}/h` : '—', 'оценка активных воркеров', burn ? 'warn' : null),
    opsMetric('GCP credits', credits == null ? '—' : eur(credits), 'остаток по FinOps', credits ? 'ok' : null),
    opsMetric('Изоляция repo slots', `${slotCount}/repo ≤ 1`, warnings ? `${warnings} конфликт(а)` : 'по одному писателю', warnings ? 'bad' : 'ok'),
  );
}

function stageTitle(kind) {
  return { l1_local: 'L1 Docker', tamper: 'Tamper', scope_fence: 'Scope Fence',
    l2_critic: 'L2 Critic', arbiter: 'Arbiter' }[kind] ?? kind;
}

function stageNode(stage) {
  const node = el('li', `stage-node status-${stage.status ?? 'pending'}`);
  const top = el('div', 'stage-top');
  top.append(el('span', 'stage-name', stageTitle(stage.kind)));
  top.append(pill(stage.status ?? 'pending', statusClass(stage.status)));
  node.append(top);
  const meta = el('div', 'stage-meta');
  if (stage.model) meta.append(el('span', null, stage.model));
  if (stage.round != null) meta.append(el('span', null, `round ${stage.round}`));
  if (stage.elapsedMs != null) meta.append(el('span', null, fmtMs(stage.elapsedMs)));
  if (stage.reason) meta.append(el('span', null, stage.reason));
  if (!meta.childNodes.length) meta.append(el('span', null, 'ожидание'));
  node.append(meta);
  return node;
}

function workerNode(worker) {
  const node = el('div', 'worker-node');
  const title = el('div', 'worker-title');
  title.append(el('span', null, 'Worker'));
  title.append(pill(worker?.phase ?? 'unknown', statusClass(worker?.phase)));
  node.append(title);
  node.append(el('div', 'worker-subtitle',
    [worker?.provider, worker?.model].filter(Boolean).join(' / ') || 'модель не сообщена'));
  const meta = el('div', 'tree-meta');
  if (worker?.threadId) meta.append(pill(worker.threadId, 'violet'));
  if (worker?.branch) meta.append(pill(worker.branch, 'accent'));
  if (worker?.elapsedMs != null) meta.append(pill(`⏱ ${fmtMs(worker.elapsedMs)}`));
  if (worker?.cacheStatus) meta.append(pill(`cache ${worker.cacheStatus}`, 'ok'));
  meta.append(pill(tokenText(worker?.tokens)));
  node.append(meta);
  const line = el('div', 'context-line');
  const bar = el('div', 'context-bar');
  const fill = el('div');
  const value = Number.isFinite(worker?.contextPct) ? Math.max(0, Math.min(100, worker.contextPct)) : 0;
  fill.style.width = `${value}%`;
  bar.append(fill);
  line.append(bar, el('span', null, `ctx ${pct(worker?.contextPct)}`));
  node.append(line);
  return node;
}

function treeCard(tree) {
  const node = el('article', `tree-card status-${tree.status ?? 'running'}`);
  const head = el('div', 'tree-head');
  head.append(el('span', 'tree-id', `#${tree.taskId}`));
  head.append(el('span', 'tree-title', tree.title || '(без названия)'));
  head.append(pill(tree.status ?? 'running', statusClass(tree.status)));
  node.append(head);
  const meta = el('div', 'tree-meta');
  meta.append(pill(tree.channel ?? 'unassigned', 'accent'));
  if (tree.repoId) meta.append(pill(`repo ${tree.repoId}`, 'violet'));
  node.append(meta);
  const kpis = el('div', 'tree-kpis');
  for (const [label, value] of [
    ['elapsed', fmtMs(tree.elapsedMs)],
    ['rounds', tree.rounds ?? '—'],
    ['rework', tree.reworkRounds ?? '—'],
    ['cost / burn', `${moneyUsd(tree.estCostUsd)} · ${tree.burnRatePerHr == null ? '—' : `$${tree.burnRatePerHr.toFixed(2)}/h`}`],
  ]) {
    const kpi = el('div', 'tree-kpi');
    kpi.append(el('span', null, label));
    kpi.append(el('b', null, String(value)));
    kpis.append(kpi);
  }
  node.append(kpis);
  node.append(workerNode(tree.worker ?? {}));
  const stages = el('ol', 'stage-list');
  for (const stage of tree.stages ?? []) stages.append(stageNode(stage));
  node.append(stages);
  node.addEventListener('click', () => openInspect(tree.taskId));
  return node;
}

function renderAgentTrees(snap) {
  const box = $('agent-trees');
  box.replaceChildren();
  const trees = Array.isArray(snap.activeTrees) ? snap.activeTrees : [];
  for (const tree of trees) box.append(treeCard(tree));
  if (!trees.length) box.append(el('div', 'empty', 'Нет активных деревьев исполнения'));
}

function boardTaskMatches(task, query) {
  if (!query) return true;
  const labels = Object.entries(task.labels ?? {}).map(([key, value]) => `${key}=${value}`).join(' ');
  return [task.id, task.title, task.repoId, task.channel, task.state, task.priority, labels]
    .filter(Boolean).join(' ').toLowerCase().includes(query);
}

function channelFilterOptions(channels) {
  const names = channels.map(channel => channel.name);
  const options = ['all', ...names];
  if (names.some(name => name === 'optimization' || name.startsWith('optimization/'))) {
    options.splice(1, 0, 'optimization/*');
  }
  return [...new Set(options)];
}

function channelMatchesFilter(name, filter) {
  if (filter === 'all') return true;
  if (filter.endsWith('/*')) return name === filter.slice(0, -2) || name.startsWith(filter.slice(0, -1));
  return name === filter;
}

function updateBoardChannelOptions(channels) {
  const select = $('board-channel-filter');
  const selected = state.boardChannel;
  const options = channelFilterOptions(channels);
  select.replaceChildren();
  for (const value of options) {
    const option = el('option', null, value === 'all' ? 'Все' : value);
    option.value = value;
    select.append(option);
  }
  select.value = options.includes(selected) ? selected : 'all';
  state.boardChannel = select.value;
}

function openBoardTask(task) {
  const drawer = $('board-task-drawer');
  drawer.classList.remove('hidden');
  $('board-task-title').textContent = `#${task.id} · ${task.title || '(без названия)'}`;
  const body = $('board-task-body');
  body.replaceChildren();
  const rows = [
    ['id', task.id], ['channel', task.channel], ['state', task.state],
    ['priority', task.priority ?? '—'], ['repo_id', task.repoId ?? '—'],
    ['updatedAt', task.updatedAt ?? '—'], ['title', task.title || '(без названия)'],
  ];
  for (const [key, value] of rows) {
    const row = el('div', 'detail-row');
    row.append(el('div', 'detail-key', key));
    row.append(el('div', 'detail-value', String(value ?? '—')));
    body.append(row);
  }
  const shaRow = el('div', 'detail-row');
  shaRow.append(el('div', 'detail-key', 'receipt SHA'));
  shaRow.append(el('div', 'detail-value detail-sha', task.receiptSha ?? '—'));
  body.append(shaRow);
  const labels = el('div', 'detail-labels');
  labels.textContent = Object.entries(task.labels ?? {}).map(([key, value]) => `${key}: ${value}`).join('\n') || 'labels: —';
  body.append(labels);
}

function boardTaskCard(task) {
  const node = el('button', 'board-task-card');
  node.type = 'button';
  const top = el('div', 'board-task-top');
  top.append(el('span', 'board-task-id', `#${task.id}`));
  top.append(el('span', 'board-task-title', task.title || '(без названия)'));
  top.append(pill(task.state, statusClass(task.state)));
  node.append(top);
  const meta = el('div', 'board-task-meta');
  if (task.priority) meta.append(pill(`P ${task.priority}`, 'warn'));
  if (task.repoId) meta.append(pill(task.repoId, 'violet'));
  if (task.receiptSha) meta.append(pill(`sha ${shortSha(task.receiptSha)}`, 'ok'));
  node.append(meta);
  node.append(el('div', 'board-task-updated', `updated ${task.updatedAt ?? '—'}`));
  node.addEventListener('click', () => openBoardTask(task));
  return node;
}

function renderBoardExplorer(snap) {
  const explorer = snap.boardExplorer ?? { channels: [] };
  const channels = Array.isArray(explorer.channels) ? explorer.channels : [];
  updateBoardChannelOptions(channels);
  for (const button of document.querySelectorAll('#board-state-filter .state-pill')) {
    button.classList.toggle('active', button.dataset.state === state.boardState);
  }
  const box = $('board-explorer');
  box.replaceChildren();
  const query = state.boardSearch.trim().toLowerCase();
  let shown = 0;
  for (const channel of channels) {
    if (!channelMatchesFilter(channel.name, state.boardChannel)) continue;
    const tasks = (channel.tasks ?? []).filter(task =>
      (state.boardState === 'all' || task.state === state.boardState) && boardTaskMatches(task, query));
    if (!tasks.length) continue;
    shown += tasks.length;
    const section = el('section', 'channel-section');
    const head = el('div', 'channel-head');
    head.append(el('span', 'channel-name', channel.name));
    const counts = el('span', 'channel-counts');
    for (const stateName of ['ready', 'claimed', 'waiting', 'blocked', 'completed']) {
      counts.append(pill(`${stateName} ${channel.counts?.[stateName] ?? 0}`, statusClass(stateName)));
    }
    head.append(counts);
    section.append(head);
    const listNode = el('div', 'channel-tasks');
    for (const task of tasks) listNode.append(boardTaskCard(task));
    section.append(listNode);
    box.append(section);
  }
  if (!shown) box.append(el('div', 'empty', 'По фильтру задач нет'));
}

function chip(id, text, cls) {
  const node = $(id);
  node.textContent = text;
  node.classList.remove('ok', 'warn', 'bad');
  if (cls) node.classList.add(cls);
}

function renderStatus(snap) {
  const host = snap.netHealth?.host ?? {};
  const running = snap.running?.length ?? 0;
  const activeByRepo = Object.values(snap.repoSlots?.activeByRepo ?? {}).reduce((a, b) => a + b, 0);
  const slotWarnings = snap.repoSlots?.multiWriterWarnings?.length ?? 0;
  chip('chip-slots', `слоты ${activeByRepo || running}/repo≤1`,
    slotWarnings ? 'bad' : (activeByRepo || running) ? 'ok' : null);
  const ks = Boolean(snap.killSwitch ?? snap.pilot?.killSwitch);
  chip('chip-killswitch', ks ? 'KILL-SWITCH' : 'kill-switch: off',
    ks ? 'bad' : null);
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
    if (!byProject.has(proj)) byProject.set(proj, { Lead: 0, Worker: 0, 'Stage/Critic': 0, Arbiter: 0 });
    const counts = byProject.get(proj);
    // Состояние Board (ready/claimed/blocked/completed) и фаза контроллера
    // (working/checking/claiming) — разные оси одной карточки: воркер и
    // критик считаются по фазе попытки, lead и блокировки — по состоянию.
    if (t.phase === 'working' || t.state === 'working') counts.Worker += 1;
    else if (t.phase === 'checking' || t.state === 'checking') counts['Stage/Critic'] += 1;
    else if (t.phase === 'claiming' || t.state === 'claimed') counts.Lead += 1;
    else if (t.state === 'blocked') counts.Arbiter += 1;
  }
  if (!byProject.size) {
    box.append(el('span', 'empty', 'Проекты: нет активных'));
    return;
  }
  for (const [name, counts] of byProject) {
    const proj = el('div', 'proj');
    proj.append(el('span', 'name', name));
    for (const [role, n] of Object.entries(counts)) {
      // DOM append возвращает undefined: chaining `.append(...).append(...)`
      // падает в браузере до первой цифры — оба узла добавляются одним вызовом.
      proj.append(el('span', 'role', `${role} `), el('b', null, String(n)));
    }
    box.append(proj);
  }
}

function metric(label, value, cls) {
  const node = el('div', `metric${cls ? ` ${cls}` : ''}`);
  node.append(el('div', 'metric-label', label));
  node.append(el('div', 'metric-value', value));
  return node;
}

function tableInto(box, headers, rows) {
  box.replaceChildren();
  const table = el('table');
  const head = el('thead');
  const hr = el('tr');
  for (const title of headers) hr.append(el('th', null, title));
  head.append(hr);
  table.append(head);
  const body = el('tbody');
  for (const row of rows) {
    const tr = el('tr');
    for (const cell of row) {
      const spec = typeof cell === 'object' && cell !== null ? cell : { text: cell };
      tr.append(el('td', spec.cls ?? null, String(spec.text ?? '—')));
    }
    body.append(tr);
  }
  table.append(body);
  box.append(table);
}

function renderModels(snap) {
  const summary = $('models-summary');
  const tableBox = $('models-table');
  summary.replaceChildren();
  tableBox.replaceChildren();
  const models = snap.models;
  if (!models?.ok) {
    summary.append(metric('Model registry', models?.error ?? 'нет данных', 'bad'));
    return;
  }
  summary.append(metric('Active mode', models.mode ?? '—', 'ok'));
  const roles = [['Coder', models.triad?.coder], ['Reviewer', models.triad?.reviewer],
    ['Arbiter', models.triad?.arbiter], ['Lead', models.triad?.lead],
    ['UX Critic', models.triad?.ux_critic]];
  for (const [role, selected] of roles) {
    summary.append(metric(role, selected
      ? `${selected.id} · ${selected.family}` : '—', selected ? null : 'warn'));
  }
  const rows = (models.models ?? []).map(model => {
    const status = model.effectiveStatus ?? model.status ?? '—';
    const cls = status === 'promo_free' ? 'status-promo'
      : status === 'active' ? 'status-active'
      : status === 'quota_paused' ? 'status-paused'
      : status === 'disabled' ? 'status-disabled' : 'status-standby';
    return [model.id, model.provider, model.model, model.family,
      { text: String(status).replaceAll('_', ' ').toUpperCase(), cls }, model.until ?? '—'];
  });
  tableInto(tableBox, ['id', 'provider', 'model', 'family', 'status', 'until'], rows);
}

function simpleCards(box, items, empty) {
  box.replaceChildren();
  if (!items.length) {
    box.append(el('div', 'empty', empty));
    return;
  }
  for (const item of items) box.append(item);
}

function quotaCard(quota) {
  const node = el('div', 'resource-card');
  const top = el('div', 'resource-top');
  top.append(el('span', 'resource-title', quota.label ?? quota.id ?? 'quota'));
  if (quota.status === 'underutilized') top.append(el('span', 'badge quota-idle', 'IDLE / UNDERUTILIZED'));
  else top.append(el('span', 'badge shiva-clean', 'OK'));
  node.append(top);
  const pct = typeof quota.utilizationPct === 'number' ? quota.utilizationPct : null;
  const bar = el('div', 'progress quota-bar');
  if (pct != null) {
    const fill = el('div');
    fill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
    bar.append(fill);
  }
  node.append(bar);
  node.append(el('div', 'meta',
    `${pct == null ? 'usage unknown' : `${pct.toFixed(1)}%`} · total ${quota.totalUnits ?? '—'}${quota.unit ? ` ${quota.unit}` : ''}`));
  if (quota.notes) node.append(el('div', 'last', quota.notes));
  return node;
}

function renderFinops(snap) {
  const summary = $('finops-summary');
  summary.replaceChildren();
  const finops = snap.finops;
  for (const id of ['finops-credits', 'finops-vms', 'finops-quotas',
    'finops-subscriptions', 'finops-alerts']) $(id).replaceChildren();
  if (!finops?.ok) {
    summary.append(metric('FinOps', finops?.error ?? 'нет данных', 'bad'));
    return;
  }
  const totals = finops.totals ?? {};
  summary.append(metric('Month spend', eur(totals.spentMonthCostEur), 'warn'));
  summary.append(metric('Today', eur(totals.spentTodayCostEur)));
  summary.append(metric('Monthly budget', eur(totals.monthlyBudgetEur)));
  summary.append(metric('GCP credits', eur(totals.remainingCreditsEur), 'ok'));
  summary.append(metric('Credit runway', finops.creditRunway?.days == null
    ? '—' : `${finops.creditRunway.days} days`));
  summary.append(metric('Worker hours', `${totals.runningHoursMonth ?? 0} h/mo`));

  simpleCards($('finops-credits'), (finops.cloudCredits ?? []).map(credit => {
    const node = el('div', 'resource-card');
    node.append(el('div', 'resource-title', credit.label ?? credit.id ?? 'credit'));
    node.append(el('div', 'meta',
      `total ${eur(credit.totalEur)} · remaining ${eur(credit.remainingEur)}${credit.monthlyEur != null ? ` · monthly ${eur(credit.monthlyEur)}` : ''}`));
    if (credit.expires) node.append(el('div', 'meta', `expires ${credit.expires}`));
    if (credit.notes) node.append(el('div', 'last', credit.notes));
    return node;
  }), 'Нет cloud credits');

  simpleCards($('finops-vms'), (finops.computeVms ?? []).map(vm => {
    const node = el('div', 'resource-card');
    const top = el('div', 'resource-top');
    top.append(el('span', 'resource-title', vm.id ?? 'vm'));
    top.append(el('span', 'badge', vm.state ?? 'unknown'));
    node.append(top);
    node.append(el('div', 'meta',
      `${vm.machineType ?? '—'} · today ${eur(vm.costTodayEur)} · month ${eur(vm.costMonthEur)}`));
    node.append(el('div', 'meta',
      `hours ${(((vm.runningMinutesMonth ?? 0) / 60)).toFixed(1)} · wakes ${vm.wakesMonth ?? 0}${vm.pricing ? ` · ${vm.pricing}` : ''}`));
    if (vm.notes) node.append(el('div', 'last', vm.notes));
    return node;
  }), 'Нет compute VM');

  simpleCards($('finops-quotas'), (finops.computeQuotas ?? []).map(quotaCard), 'Нет compute quotas');

  simpleCards($('finops-subscriptions'), (finops.aiSubscriptions ?? []).map(sub => {
    const node = el('div', 'resource-card');
    const top = el('div', 'resource-top');
    top.append(el('span', 'resource-title', sub.label ?? sub.id ?? 'subscription'));
    top.append(el('span', `badge ${sub.status === 'quota_paused' ? 'quota-idle' : 'shiva-clean'}`,
      String(sub.status ?? 'active').replaceAll('_', ' ')));
    node.append(top);
    node.append(el('div', 'meta', `${sub.model ?? '—'}${sub.quota ? ` · quota ${sub.quota}` : ''}${sub.reset ? ` · reset ${sub.reset}` : ''}`));
    if (sub.notes) node.append(el('div', 'last', sub.notes));
    return node;
  }), 'Нет AI subscriptions');

  simpleCards($('finops-alerts'), (finops.alerts ?? []).map(alert =>
    el('div', `alert ${alert.severity === 'bad' ? 'bad' : 'warn'}`,
      `${alert.code}: ${alert.message}`)), 'Алертов нет');
}


function fallbackCopyText(value) {
  const area = el('textarea', 'clipboard-helper');
  area.value = value;
  area.setAttribute('readonly', '');
  document.body.append(area);
  area.select();
  try {
    document.execCommand?.('copy');
  } catch { /* clipboard может быть недоступен в insecure context */ }
  area.remove();
}

function copyCommandChip(value, tag = 'div') {
  const node = el(tag, 'cmd copyable', value);
  node.tabIndex = 0;
  node.setAttribute('role', 'button');
  node.title = 'Клик — скопировать команду';
  const copied = () => {
    node.classList.add('copied');
    setTimeout(() => node.classList.remove('copied'), 900);
  };
  const copy = ev => {
    ev?.stopPropagation?.();
    ev?.preventDefault?.();
    try {
      const write = navigator.clipboard?.writeText;
      if (write) {
        write.call(navigator.clipboard, value)
          .then(copied)
          .catch(() => { fallbackCopyText(value); copied(); });
      } else {
        fallbackCopyText(value);
        copied();
      }
    } catch {
      fallbackCopyText(value);
      copied();
    }
  };
  node.addEventListener('click', copy);
  node.addEventListener('keydown', ev => {
    if (ev.key === 'Enter' || ev.key === ' ') copy(ev);
  });
  return node;
}

function renderWorkspace(snap) {
  const box = $('workspace-links');
  const commands = $('workspace-commands');
  box.replaceChildren();
  commands.replaceChildren();
  const finops = snap.finops;
  if (!finops?.ok) {
    box.append(el('div', 'empty', finops?.error ?? 'workspace map недоступна'));
    return;
  }
  const groups = new Map();
  for (const link of finops.workspaceLinks ?? []) {
    const group = String(link.group ?? 'workspace');
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(link);
  }
  for (const [group, links] of groups) {
    const section = el('section', 'workspace-group');
    section.append(el('h2', null, group.replaceAll('_', ' ').toUpperCase()));
    for (const link of links) {
      const cardNode = el('div', 'resource-card workspace-card');
      cardNode.append(el('div', 'resource-title', link.title ?? link.id ?? 'link'));
      const url = safeHttpUrl(link.url);
      if (url) {
        const anchor = el('a', 'workspace-url', url);
        anchor.href = url;
        anchor.target = '_blank';
        anchor.rel = 'noopener noreferrer';
        cardNode.append(anchor);
      } else if (link.path) {
        cardNode.append(copyCommandChip(link.path));
      }
      if (link.command) cardNode.append(copyCommandChip(link.command));
      if (link.notes) cardNode.append(el('div', 'last', link.notes));
      section.append(cardNode);
    }
    box.append(section);
  }
  for (const cmd of ['df-herd', 'df-models', 'vb', 'cloud-brain']) {
    commands.append(copyCommandChip(cmd, 'span'));
  }
}

function setTab(tab) {
  state.tab = tab;
  for (const button of document.querySelectorAll('#tabs .tab')) {
    button.classList.toggle('active', button.dataset.tab === tab);
  }
  const pages = { ops: 'board', board: 'board-page', models: 'models-page', finops: 'finops-page', workspace: 'workspace-page' };
  for (const [name, id] of Object.entries(pages)) $(id).classList.toggle('hidden', name !== tab);
  $('projects-footer').classList.toggle('hidden', tab !== 'ops');
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
  renderOpsSummary(snap);
  renderAgentTrees(snap);
  renderBoard(snap);
  renderBoardExplorer(snap);
  renderProjects(snap);
  renderModels(snap);
  renderFinops(snap);
  renderWorkspace(snap);
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
  let refreshTimer = null;
  // Debounce ~250ms: лавина событий не долбит /api/snapshot.
  const debouncedRefresh = () => {
    if (refreshTimer) return;
    refreshTimer = setTimeout(() => { refreshTimer = null; refresh(); }, 250);
  };
  es.onmessage = ev => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'snapshot') render(msg.data);
      else if (msg.type === 'event') debouncedRefresh();
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
$('board-task-close').addEventListener('click', () => $('board-task-drawer').classList.add('hidden'));
$('board-channel-filter').addEventListener('change', ev => {
  state.boardChannel = ev.target.value;
  if (state.snapshot) renderBoardExplorer(state.snapshot);
});
$('board-search').addEventListener('input', ev => {
  state.boardSearch = ev.target.value;
  if (state.snapshot) renderBoardExplorer(state.snapshot);
});
for (const button of document.querySelectorAll('#board-state-filter .state-pill')) {
  button.addEventListener('click', () => {
    state.boardState = button.dataset.state;
    if (state.snapshot) renderBoardExplorer(state.snapshot);
  });
}
$('toggle-clean').addEventListener('change', ev => { state.cleanOnly = ev.target.checked; });
for (const button of document.querySelectorAll('#tabs .tab')) {
  button.addEventListener('click', () => setTab(button.dataset.tab));
}

document.addEventListener('keydown', ev => {
  if (ev.key === 'Escape') {
    $('inspect').classList.add('hidden');
    $('board-task-drawer').classList.add('hidden');
  }
});

refresh();
connectSse();
setInterval(refresh, 5000);
