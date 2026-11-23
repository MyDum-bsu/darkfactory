// Owner Decision Ledger (Board #1261): append-only JSONL журнал решений
// владельца в доверенном операторском каталоге вне Git-репозитория воркера.
// Путь приходит только извне (policy.decisionLedger или DF_DECISION_LEDGER_PATH);
// в модуле нет зашитых путей. Чтение fail-closed: битая строка, подмена
// контентного sha256 или ledger внутри worktree — ошибка, а не пустой срез.

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { appendFile, link, lstat, mkdir, open, readFile, readlink, realpath, rm,
  unlink, writeFile } from 'node:fs/promises';
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
// Возвращает канонически разрешённую цель ledgerPath — вся последующая работа
// (lockfile, read, append) идёт по ней, так что прямой путь и симлинк на тот же
// журнал делят один lockfile и не обходят блокировку.
async function assertLedgerOutside(ledgerPath, worktree) {
  if (!isAbsolute(ledgerPath)) throw new Error('decision_ledger_path_relative');
  const target = await resolveLoose(ledgerPath);
  if (worktree === undefined) return target;
  const tree = await resolveExisting(worktree);
  if (tree === null) throw new Error('decision_ledger_worktree_missing');
  const norm = resolve(ledgerPath);
  const dirTarget = await resolveLoose(dirname(ledgerPath));
  const targetDir = dirname(target);
  // Проверяются журнал, родитель исходного пути и родитель канонической цели:
  // lockfile создаётся рядом с канонической целью, а симлинк не может вывести
  // запись или лок внутрь worktree.
  if (inside(tree, norm) || inside(norm, tree) ||
      inside(tree, target) || inside(target, tree) ||
      inside(tree, dirTarget) || inside(dirTarget, tree) ||
      inside(tree, targetDir) || inside(targetDir, tree)) {
    throw new Error('decision_ledger_inside_worker_paths');
  }
  return target;
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
  for (const rec of entries) {
    // Повторный id в журнале — подмена (project:b перекрывает global): fail-closed.
    if (byId.has(rec.id)) throw new Error('decision_ledger_duplicate_id');
    byId.set(rec.id, rec);
  }
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
  const target = await assertLedgerOutside(ledgerPath, worktree);
  const entries = await readEntries(target);
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
  const items = ids.map((id, i) => ({ id, scope: active[i].scope, rule: active[i].rule.trim() }));
  const digest = createHash('sha256').update(canonicalJson(items)).digest('hex');
  return { text: lines.join('\n'), digest, ids, truncated, total: active.length, items };
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
  const target = await assertLedgerOutside(ledgerPath, worktree);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  return withLedgerLock(target, async () => {
    const entries = await readEntries(target);
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
    // Повторный id в журнале недопустим (см. foldEntries): не доводить до
    // append, который необратимо испортил бы лог.
    if (byId.has(id)) throw new Error('decision_ledger_duplicate_id');
    const record = { schema: LEDGER_SCHEMA, id, scope, status: 'active', rule: rule.trim(),
      source_card: card, timestamp: now.toISOString(), recorded_by: recordedBy,
      ...(supersedes !== undefined ? { supersedes } : {}) };
    record.sha256 = recordDigest(record);
    await appendFile(target, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    return record;
  });
}

const isSlice = s => s !== null && typeof s === 'object' && !Array.isArray(s) &&
  DIGEST.test(s.digest) && Array.isArray(s.ids) && s.ids.every(id => typeof id === 'string') &&
  typeof s.text === 'string' && typeof s.truncated === 'boolean' && Number.isSafeInteger(s.total);

const sliceDigest = items => createHash('sha256').update(canonicalJson(items)).digest('hex');

// pin_sha256 покрывает все поля pin-файла — подмена total/truncated/digest/
// text/items не проходит сверку при чтении.
const pinIntegrity = s => createHash('sha256').update(canonicalJson(
  { digest: s.digest, ids: s.ids, items: s.items, truncated: s.truncated,
    total: s.total })).digest('hex');

// Срез, пригодный к публикации: items согласованы с digest/text/ids/truncated/
// total — pin-файл всегда самопроверяем.
const isSliceContent = s => isSlice(s) && Array.isArray(s.items) &&
  s.items.length === s.ids.length &&
  s.total >= s.ids.length &&
  s.items.every((item, i) => item !== null && typeof item === 'object' &&
    item.id === s.ids[i] && typeof item.scope === 'string' && typeof item.rule === 'string') &&
  s.text === s.items.map(item => `- [${item.scope}] ${item.rule} (${item.id})`).join('\n') &&
  s.truncated === (s.total > s.ids.length) &&
  sliceDigest(s.items) === s.digest;

// Персистированный pin: валидное содержимое плюс pin_sha256, покрывающий все
// поля — подмена любого поля без пересчёта не проходит.
const isPin = s => isSliceContent(s) &&
  DIGEST.test(s.pin_sha256 ?? '') && pinIntegrity(s) === s.pin_sha256;

// Закрепление активного среза за попыткой: воркер, критик и арбитр одного
// кандидата видят один и тот же snapshot/digest, а не независимо перечитанный
// журнал. Ключ — task_id:epoch попытки. In-flight Promise кладётся в кэш
// синхронно (параллельные первые вызовы делят один срез); при persistDir
// snapshot пишется атомарно (wx) в доверенный state-каталог — после рестарта
// процесса тот же epoch получает строго тот же срез, который видел воркер.
export function pinDecisions(resolve_, { persistDir } = {}) {
  const pins = new Map();
  const fileFor = key => join(persistDir,
    `decisions-${createHash('sha256').update(key).digest('hex').slice(0, 32)}.json`);
  const readPinned = async file => {
    let saved;
    try { saved = JSON.parse(await readFile(file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
    if (!isPin(saved)) throw new Error('decision_ledger_pin_invalid');
    const { text, digest, ids, truncated, total, items } = saved;
    return { text, digest, ids, truncated, total, items };
  };
  return key => {
    let pin = pins.get(key);
    if (pin === undefined) {
      pin = (async () => {
        const file = persistDir === undefined ? null : fileFor(key);
        if (file !== null) {
          const saved = await readPinned(file);
          if (saved !== undefined) return saved;
        }
        const slice = (await resolve_()) ?? null;
        if (file !== null && slice !== null) {
          if (!isSliceContent(slice)) throw new Error('decision_ledger_slice_invalid');
          // Атомарная публикация: полные байты во временном файле, link() делает
          // появление pinPath мгновенным и failsafe-EEXIST — канон чужого pin.
          const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
          try {
            await writeFile(tmp, JSON.stringify({ ...slice, pin_sha256: pinIntegrity(slice) }), { mode: 0o600 });
            try {
              await link(tmp, file);
            } catch (error) {
              if (error.code !== 'EEXIST') throw error;
              const saved = await readPinned(file);
              if (saved === undefined) throw new Error('decision_ledger_pin_invalid');
              return saved;
            }
          } finally {
            await unlink(tmp).catch(() => {});
          }
        }
        return slice;
      })();
      pins.set(key, pin);
    }
    return pin;
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
