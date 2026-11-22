// The native claim token never leaves this adapter.
export function nativeBoardPort(handle, { channel, lease = 1800 }) {
  const held = new Map();

  async function rootOf(taskId) {
    const { message } = await handle.thread(taskId, { limit: 1 });
    if (message?.id !== taskId || message.channel !== channel || !message.task) {
      throw new Error('No task root in the permitted Board channel');
    }
    return message;
  }

  async function lookup(taskId) {
    const { state, epoch, result } = (await rootOf(taskId)).task;
    let decoded;
    if (typeof result === 'string') {
      try {
        decoded = JSON.parse(result);
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
      }
    }
    return { state, epoch, result: decoded };
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
    let renewed;
    try {
      renewed = await claim.renew(lease);
    } catch (error) {
      held.delete(taskId);
      throw error;
    }
    claim.until = renewed?.until ?? claim.until;
    return { epoch: claim.epoch, until: claim.until };
  }

  function checkFilter(filter) {
    if (filter === null || typeof filter !== 'object' || Array.isArray(filter)) {
      throw new Error('A trusted claim filter is required');
    }
    const trusted = {};
    if (filter.owner !== undefined) {
      if (typeof filter.owner !== 'string' || !filter.owner) throw new Error('A trusted claim filter is required');
      trusted.owner = filter.owner;
    }
    if (filter.label !== undefined) {
      const { key, value } = filter.label ?? {};
      if (typeof key !== 'string' || !key || typeof value !== 'string' || !value) {
        throw new Error('A trusted claim filter is required');
      }
      trusted.label = { key, value };
    }
    if (filter.finish !== undefined) {
      if (typeof filter.finish !== 'string' || !filter.finish) throw new Error('A trusted claim filter is required');
      trusted.finish = filter.finish;
    }
    if (filter.required !== undefined) {
      if (!Array.isArray(filter.required) || !filter.required.every(key => typeof key === 'string' && key)) {
        throw new Error('A trusted claim filter is required');
      }
      trusted.required = filter.required;
    }
    return trusted;
  }

  // Авторизация карточки по allowlist оператора: владелец, маршрутная метка, целевой finish
  // и presence обязательных полей контракта. Метка маршрутизирует, но не выдаёт полномочий.
  function admits(filter, root) {
    if (root.task?.state !== 'ready') return false;
    if (filter.owner !== undefined && root.task.owner !== filter.owner) return false;
    if (filter.label !== undefined && root.labels?.[filter.label.key] !== filter.label.value) return false;
    if (filter.finish !== undefined && root.labels?.finish !== filter.finish) return false;
    for (const key of filter.required ?? []) {
      if (typeof root.labels?.[key] !== 'string' || !root.labels[key]) return false;
    }
    return true;
  }

  async function claimById(taskId, { token } = {}) {
    await lookup(taskId);
    const claim = await handle.tasks.claim(taskId, token === undefined ? { lease } : { lease, token });
    held.set(taskId, claim);
    return claim;
  }

  return {
    lookup,
    labels,
    verifyHeld,
    async matches(taskId, { owner, label, state }) {
      const root = await rootOf(taskId);
      return root.task.state === state && root.task.owner === owner && root.labels?.[label.key] === label.value;
    },
    async claim(taskId, { token } = {}) {
      return claimById(taskId, { token });
    },
    // Захват старейшей готовой карточки этого канала по allowlist. waiting-карточки с
    // незакрытыми needs и неавторизованные карточки не трогаются: эффектов нет, возврат null.
    async claimReady(filter, { token } = {}) {
      const trusted = checkFilter(filter);
      const query = { channel, state: 'ready', limit: 200 };
      if (trusted.owner !== undefined) query.owner = trusted.owner;
      const serverLabels = [];
      if (trusted.label !== undefined) serverLabels.push(`${trusted.label.key}=${trusted.label.value}`);
      if (trusted.finish !== undefined) serverLabels.push(`finish=${trusted.finish}`);
      for (const key of trusted.required ?? []) serverLabels.push(key);
      if (serverLabels.length) query.label = serverLabels;
      let after;
      for (;;) {
        const page = await handle.tasks.list({ ...query, ...(after ? { after } : {}) });
        for (const entry of page.tasks ?? []) {
          const root = entry?.message;
          if (root?.channel !== channel || !admits(trusted, root)) continue;
          const claim = await claimById(root.id, { token });
          return { taskId: root.id, epoch: claim.epoch, until: claim.until, labels: root.labels };
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
      const text = JSON.stringify(evidence);
      if (typeof text !== 'string' || text.length > 1000) {
        throw new Error('Board result requires compact typed evidence (up to 1000 characters)');
      }
      await claim.complete(text);
      held.delete(taskId);
    },
    async block(taskId, epoch, reason) {
      const claim = claimFor(taskId, epoch);
      await claim.block(reason.slice(0, 1000), { kind: 'needs_input' });
      held.delete(taskId);
    },
  };
}
