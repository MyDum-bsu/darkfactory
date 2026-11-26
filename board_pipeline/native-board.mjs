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

function isDefinitiveClaimLoss(error) {
  return error instanceof PilotDenied || isClaimConflict(error) || boardErrorCode(error) === 'epoch_mismatch';
}

// The native claim token never leaves this adapter.
export function nativeBoardPort(handle, { channel, lease = 1800, isolatedQuestionOwner = false, pilot }) {
  if (pilot && (pilot.scope.channel !== channel || typeof pilot.assertOpen !== 'function')) {
    throw new PilotDenied('pilot_route_not_allowed');
  }
  const held = new Map();

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
    return { owner: filter.owner, label: { key, value }, finish: filter.finish,
      profileId: filter.profileId, required: [...new Set(filter.required)],
      ...(filter.repoId !== undefined ? { repoId: filter.repoId } : {}) };
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
    const labels = root.labels;
    if (labels === null || typeof labels !== 'object' || !contractLabelsValid(labels)) return false;
    for (const key of filter.required) {
      if (typeof labels[key] !== 'string' || !labels[key]) return false;
    }
    return true;
  }

  async function acquire(taskId, token, seen) {
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
    questionState,
    async unblockQuestion(question, blockText) {
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
      return claimById(taskId, { token });
    },
    // Захват старейшей готовой карточки этого канала по allowlist. waiting-карточки с
    // незакрытыми needs и неавторизованные карточки не трогаются: эффектов нет, возврат null.
    async claimReady(filter, { token } = {}) {
      const trusted = checkFilter(filter);
      const query = { channel, state: 'ready', limit: 200, owner: trusted.owner };
      const serverLabels = [`${trusted.label.key}=${trusted.label.value}`, `finish=${trusted.finish}`];
      for (const key of trusted.required) serverLabels.push(key);
      query.label = serverLabels;
      let after;
      for (;;) {
        const page = await handle.tasks.list({ ...query, ...(after ? { after } : {}) });
        for (const entry of page.tasks ?? []) {
          const listed = entry?.message;
          if (listed?.channel !== channel || !admits(trusted, listed)) continue;
          // Единственный перечитанный снимок непосредственно перед SDK claim: владелец,
          // метка, профиль и контракт проверяются на нём же, его метки и возвращаются.
          const fresh = await rootOf(listed.id);
          if (fresh.task.state !== 'ready' || !admits(trusted, fresh)) continue;
          try {
            const claim = await acquire(listed.id, token, fresh);
            return { taskId: listed.id, ...claim, labels: fresh.labels,
              ...(typeof fresh.text === 'string' ? { text: fresh.text } : {}) };
          } catch (error) {
            if (isClaimConflict(error)) continue;
            throw error;
          }
        }
        // Сервер сообщает курсор следующей страницы; без сдвига или без карточек очередь кончилась.
        if (!page.cursor || page.cursor === after || !page.tasks?.length) return null;
        after = page.cursor;
      }
    },
    async adopt(taskId, { epoch, token }) {
      if (!Number.isSafeInteger(epoch) || !/^[a-zA-Z0-9_-]{43}$/.test(token ?? '')) {
        throw new Error('A trusted held capability is required');
      }
      const root = await lookup(taskId);
      if (root.state !== 'claimed' || root.epoch !== epoch) throw new Error('Held epoch no longer owns the card');
      const capability = handle.tasks.held(taskId, { epoch, token });
      held.set(taskId, { epoch, until: null, renew: () => capability.renew(lease),
        complete: result => capability.complete(result), block: (reason, opts) => capability.block(reason, opts) });
    },
    async complete(taskId, epoch, evidence) {
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
      await claim.complete(text);
      held.delete(taskId);
    },
    async block(taskId, epoch, reason) {
      const claim = claimFor(taskId, epoch);
      await allowEffect(taskId, 'claimed', epoch);
      await claim.block(blockText(epoch, reason), { kind: 'needs_input' });
      held.delete(taskId);
    },
  };
}
