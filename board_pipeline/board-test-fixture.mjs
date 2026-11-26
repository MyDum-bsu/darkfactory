// In-memory Board для изолированных проверок: та же форма handle, что у
// SDK board({backend}) поверх backend-local (channel, tasks, thread,
// label) и семантика claim/epoch/lease/needs, на которую опираются
// nativeBoardPort и контроллер. Используется только тестами, когда
// установленный SDK (~/.local/share/vercel-board) недоступен — в read-only
// check-контейнере приватного пакета нет, а на хосте тесты идут по
// настоящему SDK.

const CLAIM_CONFLICT = () => {
  const error = new Error('claim_conflict');
  error.code = 'claim_conflict';
  error.statusCode = 409;
  return error;
};

const CLAIM_LOST = () => {
  const error = new Error('claim_lost');
  error.code = 'claim_lost';
  error.statusCode = 409;
  return error;
};

export function memoryBoard({ actor = 'board:client' } = {}) {
  const messages = new Map();
  let seq = 0;
  let claimSeq = 0;

  const expired = task =>
    task.state === 'claimed' && task.claim !== null && Date.now() >= Date.parse(task.claim.until);

  const releaseDependents = doneId => {
    for (const entry of messages.values()) {
      const task = entry.task;
      if (task.state !== 'waiting') continue;
      const pending = task.needs.filter(id => messages.get(id)?.task?.state !== 'completed');
      if (pending.length === 0) task.state = 'ready';
    }
    return doneId;
  };

  const capability = task => {
    const heldEpoch = task.epoch;
    const token = task.claimRec.token;
    const held = () => {
      const rec = task.claimRec;
      if (task.state !== 'claimed' || rec === null || rec.epoch !== heldEpoch ||
          rec.token !== token || Date.now() >= Date.parse(rec.until)) throw CLAIM_LOST();
    };
    return {
      epoch: heldEpoch,
      until: task.claimRec.until,
      token,
      async renew(lease) {
        held();
        task.claimRec.until = new Date(Date.now() + lease * 1000).toISOString();
        task.claim.until = task.claimRec.until;
        return { until: task.claim.until };
      },
      async complete(result) {
        held();
        task.state = 'completed';
        task.result = result;
        task.claim = null;
        task.claimRec = null;
        releaseDependents(task.id);
      },
      async block(reason, opts = {}) {
        held();
        task.state = 'blocked';
        task.blocked = { kind: opts.kind ?? 'needs_input', reason };
        task.claim = null;
        task.claimRec = null;
      },
    };
  };

  const tasks = {
    async create(channel, { text, noSync, labels = {}, needs = [] } = {}) {
      const id = String(++seq);
      const waiting = needs.length > 0 &&
        needs.some(dep => messages.get(dep)?.task?.state !== 'completed');
      const task = { id, state: waiting ? 'waiting' : 'ready', owner: actor, by: actor,
        epoch: 0, blocked: null, result: null, reason: null, needs: [...needs],
        claim: null, claimRec: null };
      messages.set(id, { id, channel, text: text ?? '', labels: { ...labels },
        noSync: noSync === true, task, blocks: [] });
      return { task };
    },
    async createMany(channel, items) {
      const created = [];
      for (const item of items) created.push((await tasks.create(channel, item)).task);
      return created;
    },
    async claim(taskId, { lease = 1800, token } = {}) {
      const task = messages.get(taskId)?.task;
      if (!task) throw CLAIM_LOST();
      if (task.state !== 'ready' && !expired(task)) throw CLAIM_CONFLICT();
      task.epoch += 1;
      // Как у настоящего бэкенда: без явного токена сервер его генерирует
      // (формат тот, что проверяет adopt — 43 символа [a-zA-Z0-9_-]).
      task.claimRec = { epoch: task.epoch,
        token: token ?? `native-${++claimSeq}`.padEnd(43, 'x'),
        until: new Date(Date.now() + lease * 1000).toISOString() };
      task.state = 'claimed';
      task.claim = { actor, until: task.claimRec.until };
      return capability(task);
    },
    held(taskId, { epoch, token } = {}) {
      const task = messages.get(taskId)?.task;
      const rec = task?.claimRec;
      if (!task || task.state !== 'claimed' || rec === null ||
          rec.epoch !== epoch || rec.token !== token || Date.now() >= Date.parse(rec.until)) {
        throw CLAIM_LOST();
      }
      return capability(task);
    },
    async unblock(taskId) {
      const task = messages.get(taskId)?.task;
      if (!task || task.state !== 'blocked') throw CLAIM_CONFLICT();
      task.state = 'ready';
      task.blocked = null;
    },
    async list({ channel, state, limit = 200, owner, label = [], after } = {}) {
      const entries = [...messages.values()];
      const start = after === undefined ? 0 : entries.findIndex(m => m.id === after) + 1;
      const matched = [];
      for (const message of entries.slice(Math.max(start, 0))) {
        const task = message.task;
        if (channel !== undefined && message.channel !== channel) continue;
        if (state !== undefined && task.state !== state) continue;
        if (owner !== undefined && task.owner !== owner) continue;
        const labels = message.labels ?? {};
        const ok = label.every(item => {
          const eq = item.indexOf('=');
          return eq === -1 ? typeof labels[item] === 'string' && labels[item].length > 0
            : labels[item.slice(0, eq)] === item.slice(eq + 1);
        });
        if (ok) matched.push(message);
      }
      const page = matched.slice(0, limit);
      return { tasks: page.map(message => ({ message })),
        cursor: matched.length > page.length ? page.at(-1).id : null };
    },
  };

  return {
    tasks,
    async createChannel() {},
    async thread(id) {
      const message = messages.get(id);
      if (!message) throw new Error('No task root');
      return { message };
    },
    async label(id, change) {
      const message = messages.get(id);
      if (!message) throw new Error('No task root');
      // Семантика бэкенда: set — слияние значений, unset — снятие меток;
      // прочие ключи изменения применяются напрямую, как раньше.
      message.labels ??= {};
      const { set, unset, ...rest } = change ?? {};
      Object.assign(message.labels, rest, set ?? {});
      for (const key of unset ?? []) delete message.labels[key];
    },
  };
}

// Та же форма, что loadSdk(): {board, local} — для тестовых лабораторий.
export function memoryBoardSdk(options) {
  return {
    board: () => memoryBoard(options),
    local: () => ({ async close() {} }),
  };
}
