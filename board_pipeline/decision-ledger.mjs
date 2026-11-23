// Owner Decision Ledger (Board #1261): append-only JSONL журнал решений
// владельца в доверенном операторском каталоге вне Git-репозитория воркера.
// Путь приходит только извне (policy.decisionLedger или DF_DECISION_LEDGER_PATH);
// в модуле нет зашитых путей. Чтение fail-closed: битая строка, подмена
// контентного sha256 или ledger внутри worktree — ошибка, а не пустой срез.

import { createHash, randomUUID } from 'node:crypto';
import { appendFile, lstat, mkdir, open, readFile, readlink, realpath, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { canonicalJson } from './subject.mjs';

export const LEDGER_PATH_ENV = 'DF_DECISION_LEDGER_PATH';
export const LEDGER_SCHEMA = 'darkfactory.owner-decision.v1';
export const DEFAULT_MAX_CHARS = 4000;

const ID = /^[a-z0-9-]{1,64}$/;
const SCOPE = /^(global|project:[a-z0-9_-]{1,64})$/;
const PROJECT = /^[a-z0-9_-]{1,64}$/;
const CARD = /^[0-9]{1,15}$/;
const RECORDED_BY = /^[a-z0-9_.-]{1,64}$/i;
const DIGEST = /^[a-f0-9]{64}$/;
const MAX_RULE_CHARS = 1000;
const MAX_LEDGER_BYTES = 8 * 1024 * 1024;

const inside = (root, p) => {
  const rel = relative(root, p);
  return !rel || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('../'));
};

export function recordDigest(record) {
  const { sha256, ...body } = record;
  return createHash('sha256').update(canonicalJson(body)).digest('hex');
}

function validateRecord(rec) {
  if (rec === null || typeof rec !== 'object' || Array.isArray(rec) ||
      rec.schema !== LEDGER_SCHEMA || !ID.test(rec.id ?? '') ||
      !SCOPE.test(rec.scope ?? '') || !['active', 'superseded'].includes(rec.status) ||
      typeof rec.rule !== 'string' || !rec.rule.trim() || rec.rule.length > MAX_RULE_CHARS ||
      !CARD.test(String(rec.source_card ?? '')) ||
      typeof rec.timestamp !== 'string' || !Number.isFinite(Date.parse(rec.timestamp)) ||
      (rec.supersedes !== undefined && !ID.test(rec.supersedes)) ||
      !RECORDED_BY.test(rec.recorded_by ?? '') || !DIGEST.test(rec.sha256 ?? '')) {
    throw new Error('decision_ledger_record_invalid');
  }
  if (recordDigest(rec) !== rec.sha256) throw new Error('decision_ledger_tampered');
}

async function resolveExisting(path) {
  try { return await realpath(path); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

// Полный резолв цели пути с обходом ещё не существующего хвоста: поднимаемся к
// ближайшему существующему узлу (realpath ловит symlink-предков), а dangling
// symlink в самом пути дочитываем через readlink — ссылка на несуществующий
// файл внутри worktree не должна давать записи туда.
async function resolveLoose(path) {
  let probe = path;
  const tail = [];
  for (;;) {
    const real = await resolveExisting(probe);
    if (real !== null) return tail.length ? join(real, ...tail.reverse()) : real;
    const st = await lstat(probe).catch(() => null);
    if (st?.isSymbolicLink()) {
      probe = resolve(dirname(probe), await readlink(probe));
      continue;
    }
    tail.push(basename(probe));
    const parent = dirname(probe);
    if (parent === probe) return join(probe, ...tail.reverse());
    probe = parent;
  }
}

// Fail-closed граница доверия: ledger и его каталог не могут находиться внутри
// рабочего дерева воркера (воркер мог бы подменить/записать файл), а worktree —
// внутри каталога ledger. Передаётся реальный worktree оператора, не
// контролируемый воркером текст. Сверяется и лексический путь, и полностью
// разрешённая через symlink цель (включая ещё не созданный файл).
async function assertLedgerOutside(ledgerPath, worktree) {
  if (!isAbsolute(ledgerPath)) throw new Error('decision_ledger_path_relative');
  if (worktree === undefined) return;
  const tree = await resolveExisting(worktree);
  if (tree === null) throw new Error('decision_ledger_worktree_missing');
  const norm = resolve(ledgerPath);
  const target = await resolveLoose(ledgerPath);
  if (inside(tree, norm) || inside(norm, tree) ||
      inside(tree, target) || inside(target, tree)) {
    throw new Error('decision_ledger_inside_worker_paths');
  }
}

async function readEntries(ledgerPath) {
  let text;
  try { text = await readFile(ledgerPath, 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  if (Buffer.byteLength(text) > MAX_LEDGER_BYTES) throw new Error('decision_ledger_oversized');
  // Непустой файл обязан заканчиваться '\n': оборванная последняя строка —
  // признак частичной записи; fail-closed, а не молчаливый append поверх неё.
  if (text !== '' && !text.endsWith('\n')) throw new Error('decision_ledger_corrupt');
  const entries = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { throw new Error('decision_ledger_corrupt'); }
    validateRecord(rec);
    entries.push(rec);
  }
  return entries;
}

// Сводит append-only лог к эффективному состоянию: последняя строка с тем же id
// определяет статус; любая запись с supersedes гасит цель. Инвариант scope
// проверяется и при чтении: запись project:b не может гасить global или
// project:a — подменённый журнал даёт ошибку, а не тихую изоляцию нарушителя.
function foldEntries(entries) {
  const byId = new Map();
  for (const rec of entries) byId.set(rec.id, rec);
  const dead = new Set();
  for (const rec of entries) {
    if (rec.status === 'superseded') dead.add(rec.id);
    if (rec.supersedes !== undefined) {
      const target = byId.get(rec.supersedes);
      if (!target || target.scope !== rec.scope) throw new Error('decision_ledger_scope_violation');
      dead.add(rec.supersedes);
    }
  }
  return { byId, dead };
}

// Компактный активный срез: только status active, scope global + project:<id>,
// строгая изоляция чужих проектов. Жёсткий лимит maxChars по тексту среза;
// digest — SHA-256 pinning фактически отданного набора (id+scope+rule).
export async function resolveActiveDecisions({ ledgerPath, projectId, maxChars = DEFAULT_MAX_CHARS, worktree }) {
  if (projectId !== undefined && !PROJECT.test(projectId)) throw new Error('decision_ledger_project_invalid');
  if (!Number.isSafeInteger(maxChars) || maxChars < 1) throw new Error('decision_ledger_maxchars_invalid');
  await assertLedgerOutside(ledgerPath, worktree);
  const entries = await readEntries(ledgerPath);
  const { byId, dead } = foldEntries(entries);
  const wanted = new Set(projectId === undefined ? ['global'] : ['global', `project:${projectId}`]);
  const active = entries.filter(rec => wanted.has(rec.scope) && !dead.has(rec.id) &&
    byId.get(rec.id) === rec);
  const lines = [];
  const ids = [];
  let truncated = false;
  for (const rec of active) {
    const line = `- [${rec.scope}] ${rec.rule.trim()} (${rec.id})`;
    if ([...lines, line].join('\n').length > maxChars) { truncated = true; break; }
    lines.push(line);
    ids.push(rec.id);
  }
  const digest = createHash('sha256').update(canonicalJson(
    ids.map((id, i) => ({ id, scope: active[i].scope, rule: active[i].rule.trim() })))).digest('hex');
  return { text: lines.join('\n'), digest, ids, truncated, total: active.length };
}

// Lockfile рядом с журналом: конкурентные recordDecision (в первую очередь
// два supersedes одной цели) сериализуются, а не проходят оба по stale-снимку.
async function withLedgerLock(ledgerPath, fn) {
  const lock = `${ledgerPath}.lock`;
  let fd;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      fd = await open(lock, 'wx');
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      await delay(50);
    }
  }
  if (fd === undefined) throw new Error('decision_ledger_locked');
  try {
    return await fn();
  } finally {
    await fd.close().catch(() => {});
    await rm(lock, { force: true }).catch(() => {});
  }
}

// Append-only запись решения: одна атомарная строка. supersedes живёт в самой
// новой записи и гасит цель при свёртке — промежуточного состояния «старое
// погашено, нового нет» не существует по построению. Проверки противоречий:
// дубликат активного rule в том же scope от другой карточки, повтор с другой
// целью supersedes, supersede отсутствующего/погашенного/чужого scope — ошибка.
// Идемпотентный повтор (scope+rule+source_card+supersedes) возвращает прошлую
// запись без новой строки.
export async function recordDecision({ ledgerPath, scope, rule, sourceCard, recordedBy,
  supersedes, worktree, now = new Date(), id = randomUUID() }) {
  if (!SCOPE.test(scope ?? '')) throw new Error('decision_ledger_scope_invalid');
  if (typeof rule !== 'string' || !rule.trim() || rule.length > MAX_RULE_CHARS) {
    throw new Error('decision_ledger_rule_invalid');
  }
  const card = String(sourceCard ?? '');
  if (!CARD.test(card)) throw new Error('decision_ledger_source_card_invalid');
  if (!RECORDED_BY.test(recordedBy ?? '')) throw new Error('decision_ledger_recorded_by_invalid');
  await assertLedgerOutside(ledgerPath, worktree);
  await mkdir(dirname(ledgerPath), { recursive: true, mode: 0o700 });
  return withLedgerLock(ledgerPath, async () => {
    const entries = await readEntries(ledgerPath);
    const { byId, dead } = foldEntries(entries);
    const duplicate = entries.find(rec => rec.scope === scope && !dead.has(rec.id) &&
      byId.get(rec.id) === rec && rec.rule.trim() === rule.trim());
    if (duplicate) {
      if (String(duplicate.source_card) === card && (duplicate.supersedes ?? null) === (supersedes ?? null)) {
        return duplicate;
      }
      throw new Error('decision_ledger_rule_conflict');
    }
    if (supersedes !== undefined) {
      const target = byId.get(supersedes);
      if (!target || dead.has(supersedes) || target.scope !== scope) {
        throw new Error('decision_ledger_supersedes_invalid');
      }
    }
    const record = { schema: LEDGER_SCHEMA, id, scope, status: 'active', rule: rule.trim(),
      source_card: card, timestamp: now.toISOString(), recorded_by: recordedBy,
      ...(supersedes !== undefined ? { supersedes } : {}) };
    record.sha256 = recordDigest(record);
    await appendFile(ledgerPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    return record;
  });
}

// Закрепление активного среза за попыткой: воркер, критик и арбитр одного
// кандидата видят один и тот же snapshot/digest, а не независимо перечитанный
// журнал. Ключ — task_id:epoch попытки.
export function pinDecisions(resolve_) {
  const pins = new Map();
  return async key => {
    if (!pins.has(key)) pins.set(key, await resolve_());
    return pins.get(key);
  };
}

// Разрешение пути из конфигурации/env: явный аргумент > policy.decisionLedger
// (строка или { path }) > DF_DECISION_LEDGER_PATH. null — функция выключена.
export function resolveLedgerPath({ explicit, policy, env = process.env } = {}) {
  const raw = explicit ?? (typeof policy === 'string' ? policy : policy?.path) ?? env[LEDGER_PATH_ENV];
  if (raw === undefined || raw === null || raw === '') return null;
  if (!isAbsolute(raw)) throw new Error('decision_ledger_path_relative');
  return raw;
}

export function ledgerPolicyConfig(policy) {
  if (policy === undefined || policy === null) return {};
  if (typeof policy === 'string') return { path: policy };
  if (typeof policy === 'object' && !Array.isArray(policy)) return policy;
  throw new Error('decision_ledger_policy_invalid');
}

async function cli(argv) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true,
    options: { ledger: { type: 'string' }, scope: { type: 'string' }, rule: { type: 'string' },
      'source-card': { type: 'string' }, 'recorded-by': { type: 'string' },
      supersedes: { type: 'string' }, project: { type: 'string' },
      'max-chars': { type: 'string' }, worktree: { type: 'string' } } });
  const ledgerPath = resolveLedgerPath({ explicit: values.ledger });
  if (!ledgerPath) throw new Error(`Ledger path required: --ledger PATH or ${LEDGER_PATH_ENV}`);
  const worktree = values.worktree;
  switch (positionals[0]) {
    case 'record': {
      if (values.scope === undefined || values.rule === undefined ||
          values['source-card'] === undefined || values['recorded-by'] === undefined) {
        throw new Error('record requires --scope --rule --source-card --recorded-by');
      }
      const record = await recordDecision({ ledgerPath, scope: values.scope, rule: values.rule,
        sourceCard: values['source-card'], recordedBy: values['recorded-by'],
        supersedes: values.supersedes, worktree });
      process.stdout.write(`${JSON.stringify(record)}\n`);
      return;
    }
    case 'resolve': {
      const slice = await resolveActiveDecisions({ ledgerPath, projectId: values.project,
        maxChars: values['max-chars'] === undefined ? DEFAULT_MAX_CHARS : Number(values['max-chars']),
        worktree });
      process.stdout.write(`${JSON.stringify(slice)}\n`);
      return;
    }
    default:
      throw new Error('Use: decision-ledger.mjs record|resolve [options]');
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  cli(process.argv.slice(2)).catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
