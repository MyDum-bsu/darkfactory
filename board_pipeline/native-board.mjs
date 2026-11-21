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

  return {
    lookup,
    verifyHeld,
    async matches(taskId, { owner, label, state }) {
      const root = await rootOf(taskId);
      return root.task.state === state && root.task.owner === owner && root.labels?.[label.key] === label.value;
    },
    async claim(taskId, { token } = {}) {
      await lookup(taskId);
      const claim = await handle.tasks.claim(taskId, token === undefined ? { lease } : { lease, token });
      held.set(taskId, claim);
      return { epoch: claim.epoch, until: claim.until };
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
