import { availableParallelism, loadavg } from 'node:os';
import { eventSnapshots, httpBoardFeed } from './native-board.mjs';
import { checkChannel } from './board-stigmergy.mjs';
import { healProject } from './ci-healer.mjs';
import { planSlotAssignments } from './scope-lock-scheduler.mjs';
import { resolveIntakeMode } from './field-mode.mjs';

// Direct-lead fleets never load the managed runtime (including SQLite).
const watchManaged = async (project, options) => (await import('./teamlead-runner.mjs')).watchProjectRequests(project, options);

const MiB = 2 ** 20;
export const hostResources = () => ({ availableMemoryBytes: process.availableMemory(),
  cpuCount: availableParallelism(), cpuLoad: loadavg()[0] });
const integer = (v, min) => Number.isSafeInteger(v) && v >= min;

// Independent per-project failure streaks for controller launches and managed subscriptions.
function backoff(delays, p) {
  const ms = Math.min(300_000, (delays.get(p) ?? 5_000) * 2);
  delays.set(p, ms);
  return ms;
}

// minSlots keeps a minimum service level under load, but cannot override
// physical CPU/RAM or the operator ceiling. Charge even recent admissions
// whose workers haven't allocated yet; a shrinking pool never evicts a writer.
export function calculateSlotCapacity({ availableMemoryBytes, cpuCount, cpuLoad = 0 }, {
  minSlots = 1, maxSlots = Number.MAX_SAFE_INTEGER, memoryPerSlotMiB = 2048,
} = {}) {
  if (!integer(minSlots, 0) || !integer(maxSlots, minSlots) || !integer(memoryPerSlotMiB, 1)) {
    throw new Error('slot_pool_invalid');
  }
  if (!integer(availableMemoryBytes, 0) || !integer(cpuCount, 0) || !Number.isFinite(cpuLoad) || cpuLoad < 0) {
    throw new Error('host_resources_invalid');
  }
  return Math.min(maxSlots, cpuCount, Math.floor(availableMemoryBytes / MiB / memoryPerSlotMiB),
    Math.max(minSlots, Math.floor(cpuCount - cpuLoad)));
}

// poll is a read-only hint, never a claim. launch holds the reservation until
// the accepted controller exits (including terminal worker stop / slot reset).
export function createDispatcher({ projects, pool, poll, launch, resources = hostResources,
  now = Date.now, onError = () => {}, watchRequests = watchManaged, ciHealer = healProject,
  ciHealerIntervalMs = 60_000,
  feedFor = p => p.policyData?.boardUrl && httpBoardFeed({
    base: p.policyData.boardUrl, headers: { accept: 'application/json', 'x-board-profile': 'control-room-observer',
      'x-board-can': `${checkChannel(p.channel)}=read`, ...(process.env.BOARD_TOKEN ? { authorization: `Bearer ${process.env.BOARD_TOKEN}` } : {}) },
  }) }) {
  if (!Array.isArray(projects) || !projects.length || projects.some(p => typeof p?.repo_id !== 'string' || !p.repo_id.trim()) ||
      new Set(projects.map(p => p.worktree ?? p.repo_id.trim().toLowerCase())).size !== projects.length) {
    throw new Error('fleet_projects_invalid');
  }
  for (const p of projects) if (p.channel !== undefined) checkChannel(p.channel);
  if (!integer(ciHealerIntervalMs, 0)) throw new Error('ci_healer_interval_invalid');
  const active = new Map(), retryAt = new Map(), launchDelays = new Map(), healAt = new Map();
  const managed = projects.filter(p => resolveIntakeMode(p.policyData) === 'managed_dispatcher');
  const feeds = new Map(), feedRetryAt = new Map(), feedDelays = new Map();
  let lifetime = new AbortController();
  let cursor = 0, running, draining = false, wakeRequested = false;
  // Ordinary ticks still reconcile resources, local WALs and expiring leases.
  // A Board event can wake the scheduler between those ticks. Never launch
  // from an event payload, nor start a concurrent admission pass.
  function wake(p) {
    if (draining) return;
    if (running) { wakeRequested = true; return; }
    tick().catch(e => onError(p, e));
  }
  const views = new Map(projects.flatMap(p => {
    const feed = feedFor(p);
    return feed ? [[p, eventSnapshots(feed, p.channel, { now, onChange: () => wake(p) })]] : [];
  }));
  function record(p, error, launchFailure = false) {
    if (error.status === 429 || ['quota_exhausted', 'rate_limited', 'rate_limit'].includes(error.code)) {
      const ms = integer(error.retryAfterMs, 0) ? error.retryAfterMs : 60_000;
      retryAt.set(p, now() + ms);
    } else if (launchFailure) {
      retryAt.set(p, now() + backoff(launchDelays, p));
    }
    onError(p, error);
  }
  function tick() {
    if (draining) throw new Error('dispatch_draining');
    return running ??= dispatch().finally(() => {
      running = null;
      if (wakeRequested) { wakeRequested = false; wake(projects[0]); }
    });
  }
  async function dispatch() {
    const { signal } = lifetime;
    for (const p of managed) if (!feeds.has(p) && (feedRetryAt.get(p) ?? 0) <= now()) {
      feeds.set(p, Promise.resolve().then(() => !signal.aborted && watchRequests(p, { signal }))
        .then(() => {
          if (signal.aborted) return;
          feedDelays.delete(p);
          feeds.delete(p);
        }, error => {
          if (signal.aborted) return;
          feedRetryAt.set(p, now() + backoff(feedDelays, p));
          feeds.delete(p);
          onError(p, error);
        }));
    }
    const ordered = [...projects.slice(cursor), ...projects.slice(0, cursor)];
    const ready = await Promise.all(ordered.map(async p => {
      if (active.has(p) || (retryAt.get(p) ?? 0) > now()) return false;
      // CI intake is best effort; provider outages must not strand ready work.
      if ((healAt.get(p) ?? 0) <= now()) {
        healAt.set(p, now() + ciHealerIntervalMs);
        try { await ciHealer(p); } catch (error) { onError(p, error); }
      }
      try {
        const view = views.get(p);
        return view ? await view.read(() => poll(p), hint => !hint) : await poll(p);
      } catch (error) { record(p, error); return false; }
    }));
    const capacity = calculateSlotCapacity(await resources(), pool);
    for (const [index, p] of ordered.entries()) {
      if (signal.aborted || active.size >= capacity) break;
      if (!ready[index]) continue;
      // Boolean ready/WAL hints carry no scope proof and reserve the whole
      // repository. Card hints only plan slots; the controller rechecks the
      // actual native claim under a shared, durable lock before spawn.
      const hint = ready[index];
      const task = { repoId: p.repo_id, taskId: String(hint.taskId ?? projects.indexOf(p)),
        allowedPaths: hint.taskId == null ? null : hint.allowed_paths };
      if (!planSlotAssignments({ slots: ['next'], readyTasks: [task],
        activeTasks: [...active.values()].map(v => v.task) }).assignments.length) continue;
      const run = Promise.resolve().then(() => launch(p, { signal }))
        .then(() => launchDelays.delete(p), error => {
          if (!signal.aborted || error !== signal.reason) record(p, error, true);
        })
        .finally(() => active.delete(p));
      active.set(p, { task, run });
      cursor = (projects.indexOf(p) + 1) % projects.length;
    }
    return { capacity, active: active.size };
  }
  return { tick, async drain() {
    draining = true;
    lifetime.abort();
    try {
      await running;
      for (const view of views.values()) view.reset();
      await Promise.all([...feeds.values(), ...Array.from(active.values(), v => v.run)]);
    } finally {
      feeds.clear();
      lifetime = new AbortController();
      draining = false;
    }
  } };
}
