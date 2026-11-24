// Net Health Monitor для Control Room (V2-3) — адаптация MIT-паттернов
// paddock proxy.ts probe + agentbelt cached_bg на Node stdlib.
//
// СТРОГО диагностика: бесключевая HTTP-проба показывает состояние сети и
// внешних сервисов (403 → blocked, прочие HTTP → ok, ошибка/таймаут →
// dead) — никогда не выбирает семейство моделей и не запускает failover.
// cached_bg (stale-while-revalidate): снапшот не блокируется свежей пробой.
// Статус cloud-bb-worker — read-only из локального файла запусков
// (unknown/stale при отсутствии свежих данных, 0 SSH-сессий — watchdog
// не блокируется). Хостовые метрики: RAM + disk free.

import { readFile, statfs } from 'node:fs/promises';
import { freemem, totalmem } from 'node:os';

export const CLOUD_STALE_MS = 10 * 60 * 1000;

// probes: [{ name, url }]; fetchImpl — инъекция (по умолчанию global fetch
// с AbortSignal.timeout 4s). Каждая проба кэшируется ttlMs: свежая
// оценка запускается в фоне, снапшот отдаёт закэшированное.
export function createNetHealthMonitor({
  probes = [],
  ttlMs = 60_000,
  fetchImpl,
  cloudStatePath = null,
  diskPath = '/',
  cloudStaleMs = CLOUD_STALE_MS,
  now = () => Date.now(),
} = {}) {
  const fetcher = fetchImpl ?? (url => fetch(url, {
    signal: AbortSignal.timeout(4000), redirect: 'manual' }));
  const cache = new Map();

  const classify = response => {
    if (response.status === 403) return 'blocked';
    if (response.status === 429) return 'blocked';
    return 'ok';
  };

  const probeOnce = async probe => {
    try {
      const response = await fetcher(probe.url, { method: 'HEAD' });
      return { status: classify(response), http: response.status };
    } catch (error) {
      if (error?.status || error?.response?.status) {
        const status = error.status ?? error.response.status;
        return { status: status === 403 || status === 429 ? 'blocked' : 'ok', http: status };
      }
      return { status: 'dead', http: null };
    }
  };

  const refresh = probe => {
    probeOnce(probe).then(result => {
      cache.set(probe.name, { ...result, checkedAt: now(), error: null });
    }).catch(() => {
      cache.set(probe.name, { status: 'dead', http: null, checkedAt: now() });
    });
  };

  const probeSnapshot = () => probes.map(probe => {
    const entry = cache.get(probe.name);
    const stale = !entry || now() - entry.checkedAt > ttlMs;
    if (stale) queueMicrotask(() => refresh(probe));
    return { name: probe.name,
      status: entry?.status ?? 'pending',
      http: entry?.http ?? null,
      checkedAt: entry?.checkedAt ?? null,
      stale };
  });

  // Локальный журнал запусков cloud-bb-vm: { status, updatedAt } — RO,
  // без SSH: отсутствие/старость → unknown/stale.
  const cloudStatus = async () => {
    if (typeof cloudStatePath !== 'string' || !cloudStatePath) {
      return { status: 'unknown', updatedAt: null };
    }
    try {
      const raw = JSON.parse(await readFile(cloudStatePath, 'utf8'));
      const updatedAt = typeof raw.updatedAt === 'number' ? raw.updatedAt
        : Date.parse(raw.updatedAt ?? '') || null;
      if (updatedAt === null || now() - updatedAt > cloudStaleMs) {
        return { status: 'stale', updatedAt };
      }
      return { status: typeof raw.status === 'string' ? raw.status : 'unknown',
        updatedAt, detail: typeof raw.detail === 'string' ? raw.detail : null };
    } catch {
      return { status: 'unknown', updatedAt: null };
    }
  };

  const hostMetrics = async () => {
    const mem = { freeBytes: freemem(), totalBytes: totalmem() };
    try {
      const st = await statfs(diskPath, { bigint: true });
      return { mem, disk: { freeBytes: Number(st.bavail * st.bsize),
        totalBytes: Number(st.blocks * st.bsize) } };
    } catch {
      return { mem, disk: { freeBytes: null, totalBytes: null } };
    }
  };

  return {
    async snapshot() {
      const [cloud, host] = await Promise.all([cloudStatus(), hostMetrics()]);
      return { probes: probeSnapshot(), cloudWorker: cloud, host, checkedAt: now() };
    },
  };
}
