import { setTimeout as delay } from 'node:timers/promises';
import { checkChannel, cliRunner, createRolePass, requireRole } from './board-stigmergy.mjs';
import { PilotDenied } from './pilot-gate.mjs';
import { pilotProjection, pilotScopeMatches } from './pilot-projection.mjs';

function boardErrorCode(error) {
  return error?.code ?? error?.error?.code ?? error?.response?.data?.error?.code ?? null;
}

function boardErrorStatus(error) {
  const status = error?.statusCode ?? error?.status ?? error?.response?.status;
  if (typeof status !== 'number' && typeof status !== 'string') return null;
  const numeric = Number(status);
  return Number.isSafeInteger(numeric) ? numeric : null;
}

function isClaimConflict(error) {
  const code = boardErrorCode(error);
  return boardErrorStatus(error) === 409 ||
    ['claim_conflict', 'claim_lost', 'already_claimed'].includes(code) ||
    /(?:^|_)already_claimed(?:_|$)|claim_lost|claim_conflict/.test(String(error?.message ?? ''));
}

// Окончательная потеря захвата/эпохи: конфликт claim, чужая эпоха или отзыв
// пилота. Не сетевой сбой и не 5xx — повторять аренду бессмысленно.
export function isDefinitiveClaimLoss(error) {
  return error instanceof PilotDenied || isClaimConflict(error) || boardErrorCode(error) === 'epoch_mismatch';
}

// Транзитный сбой Board: сетевая ошибка без HTTP-статуса либо ответ 5xx.
// Обратная сторона isDefinitiveClaimLoss: такие ошибки не доказывают потерю
// аренды — контроллер сохраняет попытку и повторяет обновление.
export function isTransientBoardError(error) {
  if (error === null || typeof error !== 'object' || isDefinitiveClaimLoss(error)) return false;
  const status = boardErrorStatus(error);
  if (status !== null) return status >= 500 && status < 600;
  const code = typeof error?.code === 'string' ? error.code : '';
  if (['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'EPIPE', 'EAI_AGAIN',
    'ENETUNREACH', 'EHOSTUNREACH', 'ENETDOWN', 'EHOSTDOWN', 'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET'].includes(code)) {
    return true;
  }
  return /timeout|timed out|network|fetch failed|socket hang up/i.test(String(error?.message ?? ''));
}

const cursorOf = page => {
  if (typeof page?.cursor !== 'string' || !page.cursor.length || page.cursor.length > 4096) throw new Error('invalid_board_cursor');
  return page.cursor;
};

// HTTP equivalent of Board's tail/wait: /events long-polls from an opaque
// event cursor. /tasks pagination cursors and message timestamps are NOT event cursors.
export function httpBoardFeed({ base, headers, fetchImpl = fetch }) {
  return { async poll(query, signal) {
    const url = `${base.replace(/\/$/, '')}/events?${new URLSearchParams(query)}`;
    const res = await fetchImpl(url, { method: 'GET', redirect: 'error', headers, signal });
    if (!res.ok) {
      const body = res.status === 400 ? await res.json().catch(() => null) : null;
      throw Object.assign(new Error(`board_events_http_${res.status}`), { code: body?.error?.code });
    }
    const page = await res.json();
    if (!Array.isArray(page.events)) throw new Error('invalid_board_event_page');
    cursorOf(page);
    return page;
  } };
}

// Change notifications only invalidate an authoritative snapshot; they never
// authorize work. One bounded wait in flight. No timer or reconnect loop left
// behind when a consumer stops. Even a silent/missing feed can't hide lease
// expiry, WAL recovery or permission changes past the reconciliation deadline.
export function eventSnapshots(feed, channel, { now = Date.now, maxAgeMs = 25_000, onChange } = {}) {
  checkChannel(channel);
  if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs < 1 || maxAgeMs > 60_000) throw new Error('invalid_event_deadline');
  let cursor, cache, until = 0, retryAt = 0, pending, generation = 0, primed = false;
  function reset() {
    ++generation;
    pending?.abort(); pending = undefined; cache = undefined; until = 0;
  }
  function arm() {
    if (pending) return;
    const ac = pending = new AbortController();
    const signal = AbortSignal.any([ac.signal, AbortSignal.timeout(30_000)]);
    Promise.resolve().then(() => feed.poll({ channel, after: cursor, wait: 25 }, signal)).then(page => {
      if (pending !== ac) return;
      if (!Array.isArray(page.events)) throw new Error('invalid_board_event_page');
      const next = cursorOf(page);
      if (page.events.length && next === cursor) throw new Error('board_cursor_stalled');
      cursor = next;
      if (page.events.length) { until = 0; onChange?.(); }
    }).catch(error => {
      if (pending !== ac) return;
      if (boardErrorCode(error) === 'invalid_cursor') cursor = undefined;
      until = 0; retryAt = now() + 1000; // disconnect: next caller takes a bounded snapshot
    }).finally(() => { if (pending === ac) pending = undefined; });
  }
  return { reset, async read(load, cacheable = () => true) {
    if (!feed?.poll) return load();
    if (now() < retryAt) {
      if (now() < until) return cache;
      const version = generation;
      const result = await load();
      if (version === generation && cacheable(result)) { cache = result; until = retryAt; }
      return result;
    }
    // A one-shot observer never opens a stream. On reuse, anchor BEFORE
    // taking the first cacheable snapshot, so the snapshot/subscribe gap replays.
    if (!primed) { primed = true; return load(); }
    if (now() < until) { arm(); return cache; }
    reset();
    const version = generation;
    let anchor;
    try {
      anchor = cursor ?? cursorOf(await feed.poll({ channel, last: 1 }, AbortSignal.timeout(3000)));
    } catch { retryAt = now() + 1000; return load(); }
    const result = await load();
    if (version === generation && cacheable(result)) {
      cursor = anchor; cache = result; until = now() + maxAgeMs; arm();
    }
    return result;
  } };
}

// SDK equivalents of `tail` and `wait --after`. One fallback notification
// asks the consumer for a snapshot. Never invent a cursor on disconnect.
export function boardChanges(handle, channel) {
  checkChannel(channel);
  async function* follow(after, { signal, timeoutMs = 25_000, fallbackMs = 1000 } = {}, once) {
    if (after != null) cursorOf({ cursor: after });
    if (![timeoutMs, fallbackMs].every(n => Number.isSafeInteger(n) && n > 0 && n <= 60_000)) throw new Error('invalid_event_deadline');
    const timer = AbortSignal.timeout(timeoutMs);
    const bounded = signal ? AbortSignal.any([signal, timer]) : timer;
    const query = { channel, ...(after == null ? {} : { after }) };
    try {
      if (!once && handle.events) {
        for await (const event of handle.events(query, { signal: bounded })) {
          const next = cursorOf(event);
          if (next === after) continue;
          after = next; yield { cursor: next, event };
        }
      } else if (handle.wait) {
        const event = await handle.wait(query, { timeout: timeoutMs, signal: bounded });
        if (event && cursorOf(event) !== after) { yield { cursor: event.cursor, event }; return; }
      }
    } catch { signal?.throwIfAborted(); }
    signal?.throwIfAborted();
    await delay(fallbackMs, undefined, { signal });
    yield { cursor: after ?? null, event: null, fallback: true };
  }
  return { tailChanges: (after, options) => follow(after, options, false),
    async waitForChange(after, options) { for await (const item of follow(after, options, true)) return item; } };
}

// The native claim token never leaves this adapter. Trace writes are opt-in
// for an enrolled channel; do not silently mutate an existing pilot Board.
export function nativeBoardPort(handle, { channel, lease = 1800, isolatedQuestionOwner = false, pilot,
  role = process.env.DF_STIGMERGY_CHANNEL === channel ? process.env.BOARD_PROFILE ?? 'arbiter' : 'arbiter',
  traceRun = process.env.DF_STIGMERGY_CHANNEL === channel ? cliRunner({ url: process.env.BOARD_URL }) : null }) {
  if (pilot && (pilot.scope.channel !== channel || typeof pilot.assertOpen !== 'function')) {
    throw new PilotDenied('pilot_route_not_allowed');
  }
  const held = new Map();
  let idleView, filterKey;
  function pass(taskId, epoch) {
    if (!traceRun) throw new Error('stigmergy_not_enrolled');
    return createRolePass({ role, taskId, epoch, channel, run: traceRun,
      guard: pilot ? (id, epoch, action) => allowEffect(id, action === 'assign' ? 'ready' : 'claimed', epoch) : undefined });
  }

  async function rootOf(taskId) {
    const { message } = await handle.thread(taskId, { limit: 1 });
    if (message?.id !== taskId || message.channel !== channel || !message.task) {
      throw new Error('No task root in the permitted Board channel');
    }
    return message;
  }

  async function allowEffect(taskId, state, epoch, seen) {
    if (!pilot) return;
    const root = seen ?? await rootOf(taskId);
    if (!pilotScopeMatches(root, pilot.scope) || root.task.state !== state ||
        (epoch !== undefined && root.task.epoch !== epoch) ||
        (state === 'claimed' && !(Date.parse(root.task.claim?.until) > Date.now()))) {
      throw new PilotDenied('pilot_route_revoked');
    }
    await pilot.assertOpen();
  }

  async function project(taskId, epoch, phase, sha) {
    requireRole(role, 'complete');
    const root = await rootOf(taskId);
    const change = pilotProjection({ phase, epoch, sha }, root, pilot.scope);
    if (!change) return;
    await pilot.assertOpen();
    await handle.label(taskId, change);
  }

  const blockText = (epoch, detail) => pilot ? `Factory paused at epoch ${epoch}; operator review.` : detail.slice(0, 1000);

  async function lookup(taskId) {
    const { state, epoch, claim, result, blocked } = (await rootOf(taskId)).task;
    let decoded;
    if (typeof result === 'string') {
      try {
        decoded = JSON.parse(result);
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
      }
    }
    // task.claim несёт только actor/until — токен держателя остаётся внутри адаптера.
    return { state, epoch, claim, result: decoded,
      ...(blocked && typeof blocked === 'object' ? { blocked } : {}) };
  }

  // Метки корня карточки: канал контракта приёмки (spec_digest, policy_digest, repo_id, finish).
  async function labels(taskId) {
    return (await rootOf(taskId)).labels;
  }

  function claimFor(taskId, epoch) {
    const claim = held.get(taskId);
    if (!claim || claim.epoch !== epoch) throw new Error('No native Board claim for this attempt');
    return claim;
  }

  // Настоящее доказательство удерживаемой аренды: native renew отвечает 409 claim_lost,
  // если эпоха истекла, освобождена или её забрал другой. Токен остаётся внутри адаптера.
  async function verifyHeld(taskId, epoch) {
    try {
      const claim = held.get(taskId);
      if (!claim) {
        const error = new Error('no native claim is held for this attempt');
        error.code = 'claim_lost';
        throw error;
      }
      if (claim.epoch !== epoch) {
        const error = new Error(`held epoch ${claim.epoch} is not the attempt epoch ${epoch}`);
        error.code = 'epoch_mismatch';
        throw error;
      }
      await allowEffect(taskId, 'claimed', epoch);
      const renewed = await claim.renew(lease);
      claim.until = renewed?.until ?? claim.until;
      return { epoch: claim.epoch, until: claim.until };
    } catch (error) {
      if (isDefinitiveClaimLoss(error)) held.delete(taskId);
      throw error;
    }
  }

  // Минимальный набор контрактных меток, без которых карточка не допускается к захвату.
  const CONTRACT_MIN = ['profile_id', 'repo_id', 'spec_digest', 'policy_digest'];
  const REPO_LABEL = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;
  const HEX64 = /^[0-9a-f]{64}$/;

  // Фильтр должен быть явным и полным: пустой или частичный allowlist захват не делает.
  function checkFilter(filter) {
    if (filter === null || typeof filter !== 'object' || Array.isArray(filter) ||
        typeof filter.owner !== 'string' || !filter.owner ||
        typeof filter.profileId !== 'string' || !filter.profileId) {
      throw new Error('A trusted claim filter is required');
    }
    const { key, value } = filter.label ?? {};
    if (typeof key !== 'string' || !key || typeof value !== 'string' || !value) {
      throw new Error('A trusted claim filter is required');
    }
    if (typeof filter.finish !== 'string' || !filter.finish ||
        (filter.finish !== 'verified' && filter.finish !== 'deployed')) {
      throw new Error('A trusted claim filter is required');
    }
    if (!Array.isArray(filter.required) ||
        !filter.required.every(item => typeof item === 'string' && item) ||
        !CONTRACT_MIN.every(key => filter.required.includes(key))) {
      throw new Error('A trusted claim filter is required');
    }
    if (filter.repoId !== undefined &&
        (typeof filter.repoId !== 'string' || !REPO_LABEL.test(filter.repoId))) {
      throw new Error('A trusted claim filter is required');
    }
    // Ожидаемый policyDigest слота — строго 64 hex, иначе фильтр недоверенный:
    // ослабленная форма не должна молча отключать сверку политик.
    if (filter.policyDigest !== undefined && !HEX64.test(filter.policyDigest)) {
      throw new Error('A trusted claim filter is required');
    }
    return { owner: filter.owner, label: { key, value }, finish: filter.finish,
      profileId: filter.profileId, required: [...new Set(filter.required)],
      ...(filter.repoId !== undefined ? { repoId: filter.repoId } : {}),
      ...(filter.policyDigest !== undefined ? { policyDigest: filter.policyDigest } : {}) };
  }

  // Значения контрактных меток валидируются, не только presence: дайджесты — 64 hex,
  // repo_id — канонический идентификатор, finish — целевой статус выпуска.
  function contractLabelsValid(labels) {
    if (typeof labels.profile_id !== 'string' || !labels.profile_id) return false;
    if (typeof labels.repo_id !== 'string' || !REPO_LABEL.test(labels.repo_id)) return false;
    if (!HEX64.test(labels.spec_digest) || !HEX64.test(labels.policy_digest)) return false;
    if (labels.finish !== 'verified' && labels.finish !== 'deployed') return false;
    if (labels.fixtures_digest !== undefined &&
        (typeof labels.fixtures_digest !== 'string' || !HEX64.test(labels.fixtures_digest))) return false;
    return true;
  }

  // Авторизация карточки по allowlist оператора: владелец, маршрутная метка, целевой finish,
  // разрешённый профиль и полный валидный контракт. Метка маршрутизирует, но не выдаёт полномочий.
  function admits(filter, root) {
    if (root.task?.state !== 'ready') return false;
    if (root.task.owner !== filter.owner) return false;
    if (root.labels?.[filter.label.key] !== filter.label.value) return false;
    if (root.labels?.finish !== filter.finish) return false;
    if (root.labels?.profile_id !== filter.profileId) return false;
    // Явный repoId фильтра: карточка чужого repo_id никогда не захватывается.
    if (filter.repoId !== undefined && root.labels?.repo_id !== filter.repoId) return false;
    // Явный policyDigest фильтра: карточка, поставленная под другой политикой,
    // никогда не захватывается этим слотом — слоты с разными политиками не
    // крадут карточки друг друга даже при совпадающих owner/метке/профиле.
    if (filter.policyDigest !== undefined && root.labels?.policy_digest !== filter.policyDigest) {
      return false;
    }
    const labels = root.labels;
    if (labels === null || typeof labels !== 'object' || !contractLabelsValid(labels)) return false;
    for (const key of filter.required) {
      if (typeof labels[key] !== 'string' || !labels[key]) return false;
    }
    return true;
  }

  async function acquire(taskId, token, seen) {
    requireRole(role, 'complete'); // a claim token also authorizes completion
    await allowEffect(taskId, 'ready', undefined, seen);
    const claim = await handle.tasks.claim(taskId, token === undefined ? { lease } : { lease, token });
    held.set(taskId, claim);
    return { epoch: claim.epoch, until: claim.until };
  }

  async function claimById(taskId, { token } = {}) {
    const root = await lookup(taskId);
    // Захват только готовой карточки: waiting/blocked и живой чужой claim не берутся.
    // Просроченная аренда считается готовой (нативная семантика re-claim после expiry).
    const expiredLease = root.state === 'claimed' && typeof root.claim?.until === 'string' &&
      Number.isFinite(Date.parse(root.claim.until)) && Date.now() >= Date.parse(root.claim.until);
    if (root.state !== 'ready' && !expiredLease) {
      throw new Error('Task is not ready for a native claim');
    }
    return acquire(taskId, token);
  }

  async function questionState(question, blockText) {
    if (!isolatedQuestionOwner) throw new Error('QuestionGate requires an exclusive isolated Board owner');
    const { task } = await rootOf(question.task_id);
    if (task.owner !== question.respondent || task.epoch !== question.epoch) return 'stale';
    if (task.state === 'blocked') {
      return task.blocked?.kind === 'needs_input' && task.blocked.reason === blockText ? 'blocked' : 'stale';
    }
    return task.state;
  }

  return {
    ...(pilot ? { project, blockText, guardTask: (taskId, epoch) => allowEffect(taskId, 'claimed', epoch) } : {}),
    ...boardChanges(handle, channel),
    postTrace: (taskId, schema, data, evidence) => pass(taskId, data?.epoch).post(schema, data, evidence),
    assign: (taskId, epoch, assignee) => pass(taskId, epoch).assign(epoch, assignee),
    questionState,
    async unblockQuestion(question, blockText) {
      requireRole(role, 'complete');
      if (await questionState(question, blockText) !== 'blocked') throw new Error('Question hold changed');
      // Board 0.54.0 has no CAS on unblock. This capability is only enabled on
      // the isolated owner-exclusive queue, never on the public pilot route.
      await allowEffect(question.task_id, 'blocked', question.epoch);
      await handle.tasks.unblock(question.task_id);
    },
    async claimForQuestion(question, { token }) {
      if (await questionState(question) !== 'ready') throw new Error('Question epoch is no longer ready');
      return acquire(question.task_id, token);
    },
    lookup,
    labels,
    verifyHeld,
    async matches(taskId, { owner, label, state }) {
      const root = await rootOf(taskId);
      return root.task.state === state && root.task.owner === owner && root.labels?.[label.key] === label.value &&
        (!pilot || pilotScopeMatches(root, pilot.scope));
    },
    async claim(taskId, { token } = {}) {
      requireRole(role, 'complete');
      return claimById(taskId, { token });
    },
    // Захват старейшей готовой карточки этого канала по allowlist. waiting-карточки с
    // незакрытыми needs и неавторизованные карточки не трогаются: эффектов нет, возврат null.
    async claimReady(filter, { token } = {}) {
      const trusted = checkFilter(filter);
      requireRole(role, 'complete');
      const key = JSON.stringify(trusted);
      if (key !== filterKey) {
        idleView?.reset(); filterKey = key; idleView = eventSnapshots(handle, channel);
      }
      return idleView.read(() => scanReady(trusted, token), result => result === null);
    },
    async adopt(taskId, { epoch, token }) {
      requireRole(role, 'complete');
      if (!Number.isSafeInteger(epoch) || !/^[a-zA-Z0-9_-]{43}$/.test(token ?? '')) {
        throw new Error('A trusted held capability is required');
      }
      const root = await lookup(taskId);
      if (root.state !== 'claimed' || root.epoch !== epoch) {
        const error = new Error('Held epoch no longer owns the card');
        error.code = root.epoch !== epoch ? 'epoch_mismatch' : 'claim_lost';
        throw error;
      }
      const capability = handle.tasks.held(taskId, { epoch, token });
      held.set(taskId, { epoch, until: null, renew: () => capability.renew(lease),
        complete: result => capability.complete(result), block: (reason, opts) => capability.block(reason, opts) });
    },
    async block(taskId, epoch, reason) {
      const claim = claimFor(taskId, epoch);
      await allowEffect(taskId, 'claimed', epoch);
      await claim.block(blockText(epoch, reason), { kind: 'needs_input' });
      held.delete(taskId);
    },
    async complete(taskId, epoch, evidence) {
      requireRole(role, 'complete');
      const claim = claimFor(taskId, epoch);
      let publicEvidence = evidence;
      if (pilot && evidence?.arbitration && Object.hasOwn(evidence.arbitration, 'notes')) {
        // Model prose belongs in the private arbitration receipt, not on a pilot card.
        const { notes, ...arbitration } = evidence.arbitration;
        publicEvidence = { ...evidence, arbitration };
      }
      const text = JSON.stringify(publicEvidence);
      if (typeof text !== 'string' || text.length > 1000) {
        throw new Error('Board result requires compact typed evidence (up to 1000 characters)');
      }
      await allowEffect(taskId, 'claimed', epoch);
      if (traceRun) {
        // Project from the same frozen bytes as complete, never model notes or paths.
        const { sha, review, checks, finish, target, smoke, verdict } = JSON.parse(text);
        const trace = pass(taskId, epoch);
        if (finish === 'deployed') {
          await trace.post('df.deploy_receipt@1', { epoch, sha, target, smoke });
        } else {
          const data = { epoch, sha, verdict: review?.verdict ?? verdict };
          await trace.post('df.l2_verdict@1', data, { 'verdict.json': JSON.stringify(data),
            ...(checks ? { 'l1-tail.txt': JSON.stringify(checks) } : {}) });
        }
        await allowEffect(taskId, 'claimed', epoch);
      }
      await claim.complete(text);
      held.delete(taskId);
    },
  };

  async function scanReady(trusted, token) {
    const query = { channel, state: 'ready', limit: 200, owner: trusted.owner,
      label: [`${trusted.label.key}=${trusted.label.value}`, `finish=${trusted.finish}`, ...trusted.required] };
    let after;
    for (let pages = 0; pages < 100; pages++) {
      const page = await handle.tasks.list({ ...query, ...(after ? { after } : {}) });
      for (const entry of page.tasks ?? []) {
        const listed = entry?.message;
        if (listed?.channel !== channel || !admits(trusted, listed)) continue;
        // Never claim from a cached hint: check the exact root passed to acquire.
        const fresh = await rootOf(listed.id);
        if (!admits(trusted, fresh)) continue;
        try {
          const claim = await acquire(listed.id, token, fresh);
          return { taskId: listed.id, ...claim, labels: fresh.labels,
            ...(typeof fresh.text === 'string' ? { text: fresh.text } : {}) };
        } catch (error) {
          if (isClaimConflict(error)) continue;
          throw error;
        }
      }
      if (!page.cursor || page.cursor === after || !page.tasks?.length) return null;
      after = page.cursor;
    }
    throw new Error('board_pagination_exceeded');
  }
}
