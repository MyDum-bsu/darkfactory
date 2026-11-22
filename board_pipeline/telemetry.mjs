// VS-3 Telemetry: учёт wall-clock времени по фазам, числа раундов и фактических
// моделей/токенов в конце цикла фабрики. Телеметрия — наблюдатель попытки:
// принцип fail-open — любой её сбой или отсутствие usage у провайдера
// превращаются в null/заметку в приватном журнале и никогда не ломают приёмку
// и эффекты контроллера. Никаких секретов и сырых логов в сводке.

import { appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const TELEMETRY_SCHEMA = 1;

// Канонические фазы попытки: spawn воркера, окно работы воркера (между
// подтверждённым spawn/feedback и следующей приёмкой), детерминированные
// гейты (L1 local, tamper, L3 visual), L2 critic, арбитр и total. Замер других
// фаз (например worker_feedback) попадает в журнал, но не в компактную сводку.
export const TELEMETRY_PHASES = ['spawn', 'worker', 'l1_local', 'tamper', 'l3_visual', 'l2_critic', 'arbiter', 'total'];
const ROLES = ['worker', 'critic', 'arbiter'];
const NOTE_LIMIT = 16;
// Лимит компактной квитанции Board.complete — строка телеметрии влезает
// только вместе с квитанцией; не влезла — квитанция уходит без неё.
const EMBED_LIMIT = 1000;

// Токены принимаются только конечные неотрицательные числа; всё прочее —
// null: явная недоступность вместо выдуманных цифр. Ноль — валидное значение.
const token = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const pick = (raw, keys) => {
  for (const key of keys) {
    const value = token(raw?.[key]);
    if (value !== null) return value;
  }
  return null;
};

// Нормализация usage провайдера в { input, output, cached }: agy/anthropic
// (input_tokens, cache_read_input_tokens), openai (prompt_tokens,
// completion_tokens, cached_tokens, вложенный prompt_tokens_details) и
// camelCase/pi-варианты (input, output, cacheRead).
export function normalizeUsage(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const input = pick(raw, ['input_tokens', 'inputTokens', 'prompt_tokens', 'promptTokens', 'input']);
  const output = pick(raw, ['output_tokens', 'outputTokens', 'completion_tokens', 'completionTokens', 'output']);
  const cached = pick(raw, ['cache_read_input_tokens', 'cacheReadInputTokens', 'cached_tokens',
    'cachedTokens', 'cache_read_tokens', 'cached', 'cacheRead']) ??
    pick(raw?.prompt_tokens_details, ['cached_tokens']);
  if (input === null && output === null && cached === null) return null;
  return { input, output, cached };
}

// Суммирование токенов: null остаётся null, пока не появится число; числа
// разных раундов/ходов складываются. `== null` ловит и undefined от `prev?.`
// при первом вызове, иначе отсутствие поля превращается в выдуманный 0.
const sumTokens = (a, b) => a == null && b == null ? null : (a ?? 0) + (b ?? 0);
const mergeTokens = (prev, usage) => ({ input: sumTokens(prev?.input, usage.input),
  output: sumTokens(prev?.output, usage.output), cached: sumTokens(prev?.cached, usage.cached) });

// Суммарный usage нескольких ходов/раундов (pi-транскрипт, повторные вызовы);
// ни одного числового значения — null.
export function sumUsages(raws) {
  if (!Array.isArray(raws)) return null;
  let totals = null;
  for (const raw of raws) {
    const usage = normalizeUsage(raw);
    if (!usage) continue;
    totals = mergeTokens(totals ?? { input: null, output: null, cached: null }, usage);
  }
  return totals;
}

// usage из снимков bb/pi: защита от неизвестных форм — ищем usage в известных
// местах снимка потока/треда; нет — провайдер не отдал, остаётся null.
export function threadUsage(snapshot) {
  if (snapshot === null || typeof snapshot !== 'object') return null;
  return normalizeUsage(snapshot.usage) ?? normalizeUsage(snapshot.thread?.usage) ??
    normalizeUsage(snapshot.event?.usage) ?? normalizeUsage(snapshot.context?.usage) ??
    normalizeUsage(snapshot.data?.usage);
}

// Причина возврата на доработку → гейт раунда: те же соответствия, что и в
// worker-selector (GATE_BY_REASON) плюс L2/арбитр.
export function roundGateOf(reason) {
  if (reason === 'local_checks_failed') return 'l1';
  if (reason === 'tamper_gate_failed') return 'tamper';
  if (reason === 'visual_gate_failed') return 'l3';
  if (typeof reason === 'string' && reason.startsWith('review_verdict:')) return 'l2';
  if (reason === 'arbiter_directed_rework') return 'arbiter';
  return null;
}

const fmtSec = ms => `${(ms / 1000).toFixed(1)}s`;
const fmtTokens = usage => usage === null || typeof usage !== 'object' ? '-' :
  `${usage.input ?? '-'} / ${usage.output ?? '-'} / ${usage.cached ?? '-'}`;

// Компактная строка-сводка попытки: только тайминги, раунды и токены.
// Без секретов, worktree, тредов и сырых логов; не измеренное — не печатается.
export function formatTelemetrySummary(record) {
  if (record === null || typeof record !== 'object') return null;
  const parts = [];
  const phases = record.phases_ms ?? {};
  for (const phase of TELEMETRY_PHASES) {
    if (Number.isFinite(phases[phase])) parts.push(`${phase}=${fmtSec(phases[phase])}`);
  }
  const rounds = record.rounds ?? {};
  if (Number.isFinite(rounds.total)) {
    parts.push(`rounds=${rounds.total}`, `rw=${rounds.rework ?? 0}`, `pass=${rounds.pass ?? 0}`);
    if (rounds.open) parts.push(`open=${rounds.open}`);
    if (rounds.arbitration) parts.push(`arb_rounds=${rounds.arbitration}`);
  }
  for (const role of ROLES) {
    parts.push(`tok[${role}]=${fmtTokens(record.tokens?.[role])}`);
  }
  return parts.join(' ');
}

export function createTelemetryRecorder({ journal, file = 'telemetry.jsonl', clock = Date.now,
  models = {}, subject = null } = {}) {
  const path = typeof journal === 'string' && journal ? join(journal, file) : null;
  let events = 0;
  let startedAt = null;
  let endedAt = null;
  let finished = false;
  let lastResult = null;
  let spawnSeen = false;
  let workerResumeAt = null;
  let workerMs = 0;
  let workerSeen = false;
  let notes = [];
  const phases = new Map();
  const rounds = { total: 0, rework: 0, pass: 0, arbitration: 0, open: 0 };
  const gateCounts = new Map();
  const tokens = { worker: null, critic: null, arbiter: null };
  const identity = { task_id: null, attempt_id: null, epoch: null };
  const roleModels = { worker: null, critic: null, arbiter: null };

  // Модели из доверенной политики: фактические переопределяются при spawn.
  for (const role of ROLES) {
    if (models?.[role] !== null && typeof models?.[role] === 'object' &&
        typeof models[role].provider === 'string' && models[role].provider &&
        typeof models[role].model === 'string' && models[role].model) {
      roleModels[role] = { provider: models[role].provider, model: models[role].model };
    }
  }

  // Fail-open каркас: внутренние сбои телеметрии — заметка, не ошибка.
  const note = text => {
    notes = [...notes.slice(0, NOTE_LIMIT - 1), String(text).slice(0, 200)];
  };
  const guarded = (fn, label) => {
    try { return fn(); } catch (error) { note(`telemetry_internal_error:${label}:${error?.code ?? error?.message ?? ''}`); }
  };
  const now = () => {
    const value = clock();
    return Number.isFinite(value) ? value : null;
  };
  const observe = subject => {
    if (subject === null || typeof subject !== 'object') return;
    if (typeof subject.task_id === 'string' && subject.task_id) identity.task_id = subject.task_id;
    if (typeof subject.attempt_id === 'string' && subject.attempt_id) identity.attempt_id = subject.attempt_id;
    if (Number.isSafeInteger(subject.epoch)) identity.epoch = subject.epoch;
  };
  const model = (role, spec) => {
    if (!ROLES.includes(role) || spec === null || typeof spec !== 'object' ||
        typeof spec.provider !== 'string' || !spec.provider ||
        typeof spec.model !== 'string' || !spec.model) return;
    roleModels[role] = { provider: spec.provider, model: spec.model };
  };
  const closePhase = (name, start, ok) => {
    const at = now();
    if (at === null || start === null) return;
    if (startedAt === null || start < startedAt) startedAt = start;
    const entry = phases.get(name) ?? { ms: 0, n: 0, fail: 0 };
    entry.ms += Math.max(0, at - start);
    entry.n += 1;
    if (!ok) entry.fail += 1;
    phases.set(name, entry);
    events += 1;
  };
  if (subject !== null && typeof subject === 'object') observe(subject);

  return {
    observe(subject) { guarded(() => observe(subject), 'observe'); },

    // Длительность шага эффектов: длительность фиксируется и при отказе,
    // сама ошибка шага проходит без изменений (fail-open). Окно работы
    // воркера закрывается в НАЧАЛЕ приёмки — следующий шаг гейта исключает
    // время самого гейта из окна воркера.
    async phase(name, fn, { workerWindow = false, subject = null, worker = null } = {}) {
      const start = guarded(now, `phase_start:${name}`);
      guarded(() => {
        if (workerWindow && workerResumeAt !== null) {
          const at = now();
          if (at !== null) {
            workerMs += Math.max(0, at - workerResumeAt);
            workerSeen = true;
          }
          workerResumeAt = null;
        }
        if (subject !== null) observe(subject);
        if (worker !== null) model('worker', worker);
      }, `phase_open:${name}`);
      let ok = false;
      try {
        const value = await fn();
        ok = true;
        return value;
      } finally {
        guarded(() => {
          if (start !== null) closePhase(name, start, ok);
          // Попытка начата в этом процессе: рестарт без spawn помечается partial.
          if (name === 'spawn' && ok) spawnSeen = true;
        }, `phase_end:${name}`);
      }
    },

    // Порт приёмки с замером фазы (порты L1/tamper/L3/L2).
    port(name, fn, options = {}) {
      return (...args) => this.phase(name, () => fn(...args), { workerWindow: true, ...options });
    },

    // Окно работы воркера открыто: spawn подтверждён или feedback доставлен.
    workerResume({ subject: next = null, worker = null } = {}) {
      guarded(() => {
        const at = now();
        if (at === null) return;
        workerResumeAt = at;
        if (next !== null) observe(next);
        if (worker !== null) model('worker', worker);
      }, 'worker_resume');
    },

    // Раунд приёмки начался (verify): квитанция complete внутри acceptHeld
    // видит текущий раунд как открытый, а не пропущенный.
    roundStart() {
      guarded(() => {
        rounds.total += 1;
        rounds.open += 1;
        events += 1;
      }, 'round_start');
    },

    // Раунд приёмки завершён с исходом acceptHeld.
    recordRound({ outcome = null, reason = null } = {}) {
      guarded(() => {
        rounds.open = Math.max(0, rounds.open - 1);
        if (outcome === 'rework') rounds.rework += 1;
        if (outcome === 'verified') rounds.pass += 1;
        events += 1;
        const gate = roundGateOf(reason);
        if (gate !== null) gateCounts.set(gate, (gateCounts.get(gate) ?? 0) + 1);
      }, 'record_round');
    },

    // Арбитраж: фактическое решение арбитра получено.
    recordArbitration() {
      guarded(() => {
        rounds.arbitration += 1;
        events += 1;
      }, 'record_arbitration');
    },

    // Токены роли: многораундовое СУММИРОВАНИЕ — числа разных раундов/ходов
    // складываются, null остаётся null; источник — последний известный.
    recordUsage(role, raw, source = null) {
      return guarded(() => {
        if (!ROLES.includes(role)) return null;
        const usage = normalizeUsage(raw);
        if (usage) {
          const prev = tokens[role];
          tokens[role] = {
            ...mergeTokens(prev, usage),
            ...(typeof (source ?? prev?.source) === 'string'
              ? { source: source ?? prev.source } : {}),
          };
        }
        return usage;
      }, 'record_usage') ?? null;
    },

    // Текущий снимок записи попытки: null там, где фаза/токены не измерены.
    summary() {
      return guarded(() => {
        const at = endedAt ?? now();
        const total = startedAt !== null && at !== null ? Math.max(0, at - startedAt) : null;
        const phasesMs = {};
        for (const phase of TELEMETRY_PHASES) {
          if (phase === 'total') { phasesMs.total = total; continue; }
          // Окно воркера ни разу не закрыто — фаза не измерена, null вместо 0.
          if (phase === 'worker') { phasesMs.worker = workerSeen ? workerMs : null; continue; }
          const measured = phases.get(phase);
          phasesMs[phase] = measured ? measured.ms : null;
        }
        for (const [name, measured] of phases.entries()) {
          if (!TELEMETRY_PHASES.includes(name)) phasesMs[name] = measured.ms;
        }
        return {
          task_id: identity.task_id,
          attempt_id: identity.attempt_id,
          epoch: identity.epoch,
          phases_ms: phasesMs,
          rounds: { ...rounds,
            ...(gateCounts.size ? { gates: Object.fromEntries([...gateCounts.entries()].sort()) } : {}) },
          models: { ...roleModels },
          tokens: { ...tokens },
          partial: !spawnSeen && events > 0,
          notes_count: notes.length,
          ...(startedAt !== null ? { started_at: new Date(startedAt).toISOString() } : {}),
          ...(at !== null ? { ended_at: new Date(at).toISOString() } : {}),
        };
      }, 'summary');
    },

    summaryLine() {
      return guarded(() => formatTelemetrySummary(this.summary()), 'summary_line');
    },

    // Квитанция закрытия карточки со строкой телеметрии: детерминированное
    // ужатие — полная строка, затем краткая, затем исходная квитанция.
    // Пустая телеметрия квитанцию не меняет. На момент complete текущий раунд
    // закрывается успехом: открытый раунд отражается как pass, а не как
    // открытый (финальная запись журнала закрывает его тем же recordRound).
    embed(evidence) {
      try {
        if (!events || evidence === null || typeof evidence !== 'object' ||
            Array.isArray(evidence)) return evidence;
        const record = this.summary() ?? {};
        const rounds = record.rounds ?? {};
        const open = rounds.open ?? 0;
        const projected = open > 0 ? { ...record, rounds: { ...rounds,
          pass: (rounds.pass ?? 0) + open, open: 0 } } : record;
        const full = formatTelemetrySummary(projected);
        if (!full) return evidence;
        const mini = `rounds=${projected.rounds?.total ?? 0} tok[critic]=${fmtTokens(projected.tokens?.critic)}`;
        for (const telemetry of [full, mini]) {
          const candidate = { ...evidence, telemetry };
          if (JSON.stringify(candidate).length <= EMBED_LIMIT) return candidate;
        }
        return evidence;
      } catch {
        return evidence;
      }
    },

    // Итог попытки: одна строка в приватном JSONL-журнале. Пустая телеметрия
    // (простой очереди) файл не создаёт; повторный finish возвращает кэш.
    async finish({ outcome = null, reason = null, open = false } = {}) {
      if (finished) return lastResult;
      finished = true;
      endedAt = now();
      if (!events) return { record: null, summary: null };
      const record = this.summary();
      if (record === null || typeof record !== 'object') return { record: null, summary: null };
      record.outcome = typeof outcome === 'string' && outcome ? outcome : null;
      record.reason = typeof reason === 'string' && reason ? reason : null;
      record.open = Boolean(open);
      lastResult = { record, summary: formatTelemetrySummary(record) };
      if (path) {
        try {
          const line = { kind: 'attempt_summary', schema: TELEMETRY_SCHEMA, ...record };
          if (notes.length) line.notes = [...notes];
          await appendFile(path, `${JSON.stringify(line)}\n`, { mode: 0o600 });
        } catch (error) {
          note(`telemetry_write_failed:${error?.code ?? error?.message ?? 'unknown'}`);
        }
      }
      return lastResult;
    },
  };
}

// Одна строка журнала → запись; чужие/битые строки отбрасываются отчётом.
export function aggregateTelemetry(lines, { task = null, since = null, open = null } = {}) {
  const aggregate = {
    attempts: 0, open_attempts: 0, outcomes: {}, corrupt: 0,
    phases_ms: {}, rounds: { total: 0, rework: 0, pass: 0, arbitration: 0, open: 0 },
    tokens: {}, models: {}, first: null, last: null,
  };
  const sinceTs = Number.isFinite(since) ? since : null;
  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { aggregate.corrupt += 1; continue; }
    if (entry?.kind !== 'attempt_summary' || entry?.schema !== TELEMETRY_SCHEMA) continue;
    if (task !== null && String(entry.task_id ?? '') !== String(task)) continue;
    if (open !== null && Boolean(entry.open) !== open) continue;
    if (sinceTs !== null) {
      const started = Date.parse(entry.started_at ?? '');
      if (!Number.isFinite(started) || started < sinceTs) continue;
    }
    aggregate.attempts += 1;
    if (entry.open) aggregate.open_attempts += 1;
    else {
      const outcome = typeof entry.outcome === 'string' && entry.outcome ? entry.outcome : 'unknown';
      aggregate.outcomes[outcome] = (aggregate.outcomes[outcome] ?? 0) + 1;
    }
    for (const [phase, ms] of Object.entries(entry.phases_ms ?? {})) {
      if (!Number.isFinite(ms)) continue;
      const slot = aggregate.phases_ms[phase] ?? { n: 0, sum: 0, max: 0 };
      slot.n += 1;
      slot.sum += ms;
      slot.max = Math.max(slot.max, ms);
      aggregate.phases_ms[phase] = slot;
    }
    for (const key of ['total', 'rework', 'pass', 'arbitration', 'open']) {
      aggregate.rounds[key] += Number.isFinite(entry.rounds?.[key]) ? entry.rounds[key] : 0;
    }
    for (const role of ROLES) {
      const usage = entry.tokens?.[role];
      if (usage !== null && typeof usage === 'object' &&
          (usage.input !== null || usage.output !== null || usage.cached !== null)) {
        const slot = aggregate.tokens[role] ?? { attempts_with_usage: 0, input: 0, output: 0, cached: 0 };
        slot.attempts_with_usage += 1;
        slot.input += usage.input ?? 0;
        slot.output += usage.output ?? 0;
        slot.cached += usage.cached ?? 0;
        aggregate.tokens[role] = slot;
      }
      const model = entry.models?.[role];
      if (model !== null && typeof model === 'object' &&
          typeof model.provider === 'string' && typeof model.model === 'string') {
        const name = `${model.provider}/${model.model}`;
        const slot = aggregate.models[role] ?? {};
        slot[name] = (slot[name] ?? 0) + 1;
        aggregate.models[role] = slot;
      }
    }
    const started = Date.parse(entry.started_at ?? '');
    if (Number.isFinite(started)) {
      aggregate.first = aggregate.first === null ? started : Math.min(aggregate.first, started);
      aggregate.last = aggregate.last === null ? started : Math.max(aggregate.last, started);
    }
  }
  for (const slot of Object.values(aggregate.phases_ms)) slot.mean = slot.n > 0 ? slot.sum / slot.n : 0;
  return aggregate;
}

export function formatTelemetryReport(aggregate) {
  const lines = [`VS-3 telemetry: ${aggregate.attempts} attempts` +
    ` (${aggregate.open_attempts} open), corrupt lines: ${aggregate.corrupt}`];
  const outcomes = Object.entries(aggregate.outcomes)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  if (outcomes.length) {
    lines.push(`Outcomes: ${outcomes.map(([outcome, count]) => `${outcome}=${count}`).join(' ')}`);
  }
  const phases = Object.entries(aggregate.phases_ms)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  if (phases.length) {
    lines.push('Phases (mean/max/n):');
    for (const [phase, slot] of phases) {
      lines.push(`  ${phase} ${fmtSec(slot.mean)} / ${fmtSec(slot.max)} / n=${slot.n}`);
    }
  }
  const rounds = aggregate.rounds;
  const meanRounds = aggregate.attempts > 0 ? (rounds.total / aggregate.attempts).toFixed(2) : '0';
  lines.push(`Rounds: total=${rounds.total} (mean ${meanRounds}/attempt), ` +
    `rework=${rounds.rework}, pass=${rounds.pass}, arbitration=${rounds.arbitration}` +
    (rounds.open ? `, open=${rounds.open}` : ''));
  const tokenRoles = Object.entries(aggregate.tokens);
  if (tokenRoles.length) {
    lines.push('Tokens (sum):');
    for (const [role, slot] of tokenRoles) {
      lines.push(`  ${role}: in ${slot.input} / out ${slot.output} / cached ${slot.cached}` +
        ` (attempts with usage: ${slot.attempts_with_usage})`);
    }
  } else {
    lines.push('Tokens: unavailable (null — провайдер не отдал usage)');
  }
  const models = Object.entries(aggregate.models);
  if (models.length) {
    lines.push(`Models: ${models.map(([role, slot]) =>
      `${role} ${Object.entries(slot).map(([name, count]) => `${name} x${count}`).join(', ')}`).join('; ')}`);
  }
  if (aggregate.first !== null) {
    lines.push(`Window: ${new Date(aggregate.first).toISOString()} — ${new Date(aggregate.last).toISOString()}`);
  }
  return lines.join('\n');
}

// Чтение журнала для CLI: отсутствующий файл — пустой список, не ошибка.
export async function readTelemetryLines(path) {
  const text = await readFile(path, 'utf8');
  return text.split('\n').filter(line => line.trim() !== '');
}
