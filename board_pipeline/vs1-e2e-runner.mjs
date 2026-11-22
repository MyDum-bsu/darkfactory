// Живой сквозной E2E VS-1 (Тикет 06): изолированный vb serve + чистый worktree
// БГУ + две связанные синтетические карточки + реальный контроллер
// run-isolated.mjs в queue-driven режиме с исполнителем acp-devin/swe-2-high.
// Ноль ручных пересылок: красный L1 → содержательный L2 REWORK → зелёный
// L1+tamper+L3+L2+seal → complete(#1) → #2 нативно ready → пустой тик idle.
// Границы: никогда порт 44100, никакой живой Board/кабинета/сети кандидата.
import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, stat, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs, promisify } from 'node:util';
import { requireWorkspaceSpace } from '../ops/local/check-workspace-space.mjs';

const exec = promisify(execFile);
const HERE = import.meta.dirname;
const BASE = 'ed83f15714f6c1dd72104fa365a68b283f4d0ff7';
// Кандидаты, уже прошедшие живой цикл фабрики: ход 2 — реализация с явным
// дефектом (ALLOW_INSECURE_HTTP_SCHEDULE_URL), ход 3 — чистая версия после
// всех замечаний независимого критика. Хранятся в бандле вне дерева bsu.
const DEFECT = '5578c155dbaf6cded5e71ae6263e11e500ec624d';
// Финал — верхушка сходимости реального критика: прошёл REVIEW_OK в живом
// прогоне (кандидаты ниже получали REVIEW_BLOCKED по новым находкам).
const FINAL = 'c7a8daeb89862ba5390609ee2facd25af0349bd5';
const FINAL_TREE = '437187e6bbe78e7f7ccbf9cd00171cd4ee77767b';
const BUNDLE = process.env.VS1_E2E_BUNDLE ?? '';
const VB = join(homedir(), '.local/share/vercel-board/node_modules/.bin/vb');

const sha256 = async path => createHash('sha256').update(await readFile(path)).digest('hex');
const sha256Text = text => createHash('sha256').update(text).digest('hex');

const WORKER_BRIEF = `Изолированный живой E2E VS-1 фабрики на синтетической карточке БГУ — ровно три хода, каждый заканчивается атомарной записью конверта и завершением хода.

Ход 1: начальный HEAD ${BASE}. Не меняй ни одного файла и немедленно сдай этот SHA по конверту. Он специально не пройдёт детерминированную проверку меню; не выясняй причину и не исправляй до замечания фабрики. Заверши ход.

Ход 2 (только ПОСЛЕ первого замечания фабрики): переключи worktree на закреплённый кандидат с реализацией: \`git reset --hard ${DEFECT}\`. Объект уже в локальной истории. Этот кандидат содержит дефект против правила строгой валидации публичного URL расписаний (в \`bsu-cabinet/src/bsu_cabinet/setup_options.py\` есть \`ALLOW_INSECURE_HTTP_SCHEDULE_URL = True\`), который не ломает детерминированные проверки, но должен быть пойман независимым ревью. Ничего не исправляй и не меняй: проверь \`git status\` чистым и сдай этот SHA (${DEFECT}) по тому же конверту. Заверши ход.

Ход 3 (только ПОСЛЕ второго замечания фабрики — оно придёт от независимого ревью): приведи дерево точно к чистому состоянию ${FINAL}: \`git reset --hard ${FINAL}\`, убедись, что \`git status --porcelain\` пуст и дерево ${FINAL_TREE}, затем сдай этот SHA (${FINAL}) тем же конвертом. Заверши ход.

Во всех сдачах сохраняй task_id, epoch, attempt_id из первого конверта и worker_thread_id = собственный BB_THREAD_ID. Для файла сдачи — временный файл в том же каталоге и rename. Никакого доступа к реальному кабинету, сети, телефону, рабочей Board, другим тредам, CI/PR/push.`;

const REVIEW_PROMPT = `Независимое ревью синтетической E2E-задачи БГУ. Кандидат указан в заголовке, база ${BASE.slice(0, 7)}. Только чтение. Точный diff лежит в /review/diff.patch — проверяй его, а не реконструируй историю.

Блокером является ТОЛЬКО нарушение одного из перечисленных инвариантов (докажи конкретным input и file:line):
1. Любой флаг, константа, комментарий или код, разрешающий не-HTTPS (http://) публичный URL расписаний — например ALLOW_INSECURE_HTTP_SCHEDULE_URL или ослабление проверки scheme/host.
2. Сохранённый URL расписаний может получиться не https://drive.google.com/... — принимаются query-параметры, fragment или креды в URL (нормализация обязана отвергать их до записи).
3. Навигация или сетевые действия во время сохранения настроек.
4. Сохранение привязано не к точному локальному URL и main frame.
5. Чтение SMS без явного выбора пользователя или неявно выбранный телефон для ADB.

Всё остальное — только summary, не блокер. Инвариант считается выполненным, если ты не можешь показать конкретный контрпример в файле и строке: при отсутствии доказанного блокера выдавай PASS. Не ходить в реальный кабинет, не читать SMS и credentials, не запускать CI и не править код. Закончить одной строкой REVIEW_OK или REVIEW_BLOCKED.`;

async function vbCli(url, argv) {
  const { stdout } = await exec(VB, ['--url', url, ...argv, '--json'], { timeout: 30_000 });
  return JSON.parse(stdout);
}

// Строгая проверка доступности TCP-порта на 127.0.0.1 до запуска vb serve.
async function assertPortFree(port) {
  await new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.once('error', err => reject(new Error(`Port ${port} is not free (${err.code ?? err.message}); refusing to start`)));
    srv.listen(port, '127.0.0.1', () => srv.close(err => (err ? reject(err) : resolve())));
  });
}

// Прямой счётчик append-only журнала событий SQLite изолированной Board:
// любой claim/release/complete/block увеличивает a2_events.
async function boardEventCount(sqliteDir) {
  const dbFile = (await readdir(sqliteDir)).find(f => f.endsWith('.db'));
  if (!dbFile) throw new Error(`No SQLite .db file in ${sqliteDir}`);
  const db = new DatabaseSync(join(sqliteDir, dbFile), { readOnly: true });
  try {
    return Number(db.prepare('SELECT COUNT(*) AS n FROM a2_events').get().n);
  } finally {
    db.close();
  }
}

// Исполняемые шимы на время пустого тика: логируют любой реальный вызов
// bb / docker / pi (включая абсолютный $HOME/.pi/agent/bin/pi) до исполнения.
async function createIdleShims(shimDir, idleHome, logFile, basePath, realPi) {
  await mkdir(shimDir, { recursive: true, mode: 0o700 });
  await mkdir(join(idleHome, '.pi', 'agent', 'bin'), { recursive: true, mode: 0o700 });
  await writeFile(logFile, '', { mode: 0o600 });
  for (const bin of ['bb', 'docker', 'pi']) {
    const p = join(shimDir, bin);
    const execTarget = bin === 'pi' ? JSON.stringify(realPi) : bin;
    await writeFile(p, `#!/bin/sh
printf '%s\\n' ${JSON.stringify(bin)} >> ${JSON.stringify(logFile)}
PATH=${JSON.stringify(basePath)} exec ${execTarget} "$@"
`, { mode: 0o700 });
    await chmod(p, 0o700);
  }
  await copyFile(join(shimDir, 'pi'), join(idleHome, '.pi', 'agent', 'bin', 'pi'));
  await chmod(join(idleHome, '.pi', 'agent', 'bin', 'pi'), 0o700);
  await mkdir(join(idleHome, '.local', 'share'), { recursive: true, mode: 0o700 });
  await symlink(join(homedir(), '.local', 'share', 'vercel-board'),
    join(idleHome, '.local', 'share', 'vercel-board'));
}

// Снимок состояния карточки для сравнения «без эффектов»: только стабильные поля.
function cardSnapshot(read) {
  const task = read?.message?.task ?? read?.task ?? {};
  return { state: task.state, epoch: task.epoch, claim: task.claim ?? null,
    result: task.result ?? null };
}

function runController(policyFile, stateDir, env, wlog, onLine, extraArgs = []) {
  return new Promise(resolve => {
    const child = spawn(process.execPath,
      [join(HERE, 'run-isolated.mjs'), '--execute', '--policy', policyFile, '--state', stateDir,
        ...extraArgs],
      { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const lines = [];
    child.stdout.on('data', chunk => {
      for (const line of String(chunk).split('\n')) {
        if (!line.trim()) continue;
        lines.push(line);
        wlog(line + '\n');
        try { onLine(JSON.parse(line)); } catch { /* не-JSON строка */ }
      }
    });
    child.stderr.on('data', chunk => wlog(`[stderr] ${chunk}`));
    child.on('exit', (code, signal) => resolve({ code, signal, lines }));
  });
}

async function execute() {
  const { values } = parseArgs({ options: {
    execute: { type: 'boolean' },
    'lab-parent': { type: 'string', default: process.env.VS1_E2E_LAB_PARENT ?? tmpdir() },
    'bsu-repo': { type: 'string', default: process.env.VS1_E2E_REPO ?? '' },
    port: { type: 'string', default: '44199' },
    proof: { type: 'string' },
  } });
  if (!values.execute || !values.proof) throw new Error('Use --execute --proof FILE [--lab-parent DIR --port N]');
  const port = Number(values.port);
  if (!Number.isSafeInteger(port) || port === 44100 || port < 1024 || port > 65535) {
    throw new Error('Isolated Board port must be a free loopback port other than 44100');
  }
  const space = await requireWorkspaceSpace(await realpath(values['lab-parent']), 'worktree');
  console.log(JSON.stringify({ step: 'disk_preflight', ...space }));

  const lab = await mkdtemp(join(values['lab-parent'], 'vs1-e2e-lab-'));
  // Приватные каталоги (state, inbox, операторские файлы) — на POSIX-ФС:
  // Некоторые ФС (например fuseblk/NTFS) не хранят биты прав, а контроллер требует
  // state 0700 uid=process. Тяжёлые данные (worktree, sqlite, tmp, лог) — на Data.
  const priv = await mkdtemp(join(tmpdir(), 'vs1-e2e-state-'));
  const dirs = { state: join(priv, 'state'),
    inbox: join(priv, 'inbox'), gate: join(priv, 'gate'), operator: join(priv, 'operator'),
    sqlite: join(lab, 'sqlite'), tmp: join(lab, 'check-tmp'),
    worktree: join(lab, 'worktree') };
  for (const dir of [dirs.state, dirs.inbox, dirs.sqlite,
    dirs.gate, dirs.operator, dirs.tmp]) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  }
  const log = await open(join(lab, 'e2e.log'), 'w', 0o600);
  const wlog = text => log.write(text).catch(() => {});
  const say = async obj => { const line = JSON.stringify(obj); console.log(line); await wlog(line + '\n'); };

  // Исходный репозиторий БГУ не трогаем совсем: локальный клон в лабораторию,
  // теги кандидатов из бандла, feature-worktree от базы — всё внутри $lab.
  const branch = `feat/vs1-e2e-${randomUUID().slice(0, 8)}`;
  const bsu = await realpath(values['bsu-repo']);
  const origin = join(lab, 'bsu-origin');
  // fuseblk не поддерживает жёсткие ссылки: --no-hardlinks копирует объекты.
  await exec('git', ['clone', '--no-hardlinks', '-q', bsu, origin], { timeout: 180_000 });
  await exec('git', ['-C', origin, 'fetch', '-q', BUNDLE,
    'refs/tags/*:refs/tags/*'], { timeout: 60_000 });
  await exec('git', ['-C', origin, 'config', 'extensions.worktreeConfig', 'true']);
  await exec('git', ['-C', origin, 'worktree', 'add', dirs.worktree, '-b', branch, BASE],
    { timeout: 60_000 });
  await exec('git', ['-C', dirs.worktree, 'config', '--worktree', 'core.filemode', 'false']);
  const factorySha = (await exec('git', ['-C', HERE, 'rev-parse', 'HEAD'])).stdout.trim();
  await say({ step: 'worktree', path: dirs.worktree, branch, base: BASE, factorySha });

  // Операторские файлы вне worktree/inbox/state.
  const brief = join(dirs.operator, 'vs1-worker.md');
  const reviewPrompt = join(dirs.operator, 'vs1-review.md');
  await writeFile(brief, WORKER_BRIEF, { mode: 0o600 });
  await writeFile(reviewPrompt, REVIEW_PROMPT, { mode: 0o600 });
  await copyFile(join(HERE, '../ops/local/board-review.mjs'), join(dirs.gate, 'board-review.mjs'));
  await writeFile(join(dirs.gate, 'routes.json'), JSON.stringify({ workerPresets: { reviewer: {
    provider: 'pi', model: 'openai/gpt-6.2-sol', reasoningLevel: 'medium' } } }), { mode: 0o600 });
  const specDigest = await sha256(reviewPrompt);
  // Контрактный дайджест политики: детерминированная 64-hex константа прогона;
  // seal сверяет её с живой меткой карточки (policy_digest_drift при смене).
  const policyDigest = sha256Text(`vs1-bsu-e2e-1:${specDigest}`);

  // Порт обязан быть свободен ДО старта (прямой TCP bind на 127.0.0.1).
  await assertPortFree(port);
  // Изолированный vb serve на loopback, порт != 44100.
  const boardUrl = `http://127.0.0.1:${port}/api/board`;
  const readyBanner = `serving a local board at ${boardUrl}`;
  const boardProc = spawn(VB, ['serve', '--port', String(port), '--dir', dirs.sqlite,
    '--no-inspect', '--no-open'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let sawBanner = false;
  let boardOut = '';
  boardProc.stdout.on('data', c => {
    const s = String(c);
    wlog(`[vb] ${s}`);
    boardOut += s;
    if (boardOut.includes(readyBanner)) sawBanner = true;
  });
  boardProc.stderr.on('data', c => wlog(`[vb:err] ${c}`));
  let boardReady = false;
  for (let i = 0; i < 60 && boardProc.exitCode === null; i++) {
    if (sawBanner && (await readdir(dirs.sqlite)).some(f => f.endsWith('.db'))) {
      try {
        await vbCli(boardUrl, ['channels', 'list']);
        boardReady = true;
        break;
      } catch { /* ждём завершение инициализации Board API */ }
    }
    await new Promise(r => setTimeout(r, 300));
  }
  if (!boardReady) {
    boardProc.kill('SIGTERM');
    throw new Error('Isolated vb serve did not become ready');
  }
  await say({ step: 'board', url: boardUrl, pid: boardProc.pid });

  const env = { ...process.env, XDG_CONFIG_HOME: join(dirs.gate, 'config'),
    XDG_STATE_HOME: join(homedir(), '.local', 'state'), TMPDIR: dirs.tmp };
  // Изолированный XDG_CONFIG_HOME: идентичность Board (~/.config/board)
  // переносим в приватный config, чтобы claimReady мог аутентифицироваться.
  await mkdir(join(dirs.gate, 'config'), { recursive: true });
  await exec('cp', ['-a', join(homedir(), '.config/board'), join(dirs.gate, 'config/board')]);
  const proof = { factorySha, lab, stateDir: priv, boardUrl, channel: 'pilot', provider: 'acp-devin',
    model: 'swe-2-high', permissionMode: 'full', specDigest, policyDigest,
    cards: {}, candidates: [], journal: {}, idleTickZeroCalls: false };
  const cleanup = async () => {
    try {
      if (proof.workerThread) await exec('bb', ['thread', 'stop', proof.workerThread],
        { timeout: 30_000, env });
    } catch { /* уже остановлен */ }
    boardProc.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 800));
    if (boardProc.exitCode === null) boardProc.kill('SIGKILL');
    await log.close();
  };
  try {
    await vbCli(boardUrl, ['channels', 'create', 'pilot']);
    const contract = ['finish=verified', 'profile_id=bsu', 'repo_id=bsu-cabinet',
      `spec_digest=${specDigest}`, `policy_digest=${policyDigest}`, 'has_ui=true'];
    const card1 = await vbCli(boardUrl, ['tasks', 'create', 'pilot',
      'БГУ E2E-1: меню онбординга, публичная папка, телефон, headless (VS-1 synthetic)',
      '--label', 'automation=vs1-e2e', ...contract.flatMap(l => ['--label', l]), '--no-sync']);
    const id1 = card1.task?.id;
    // Карточка #2: waiting по needs, БЕЗ маршрутной метки automation=vs1-e2e —
    // после complete(#1) она ready, но не захватывается фильтром этого слота.
    const card2 = await vbCli(boardUrl, ['tasks', 'create', 'pilot',
      'БГУ E2E-2: зависимая синтетическая карточка (VS-1 synthetic)',
      '--needs', String(id1), ...contract.flatMap(l => ['--label', l]), '--no-sync']);
    const id2 = card2.task?.id;
    const owner = card1.task?.task?.owner;
    if (typeof owner !== 'string' || !owner) throw new Error('No task owner on card #1');
    proof.cards = { first: id1, second: id2 };

    const image = async ref =>
      (await exec('docker', ['image', 'inspect', ref, '--format', '{{.Id}}'], { timeout: 15_000 })).stdout.trim();
    const nodeImage = await image('node:22.23.2-bookworm-slim');
    const pytestImage = await image('313cf8f190a1');
    const inspect = `const s = require('node:fs').readFileSync('src/bsu_cabinet/assets/setup.html','utf8');
const missing = ['schedule-folder','phone-login','headless'].filter(id => !s.includes('id="'+id+'"'));
if (!/<details\\b/i.test(s)) missing.push('раскрывающееся меню');
if (missing.length) { console.error('PILOT_EXPECTATION: В меню отсутствуют: '+missing.join(', ')); process.exitCode = 1; }
else console.log('Onboarding controls are present');`;
    const version = 'vs1-bsu-e2e-1';
    const policy = {
      scope: 'isolated', boardUrl, channel: 'pilot', owner, policyDigest,
      label: { key: 'automation', value: 'vs1-e2e' }, version, waitMs: 3_600_000,
      brief, reviewPrompt, reviewGate: join(dirs.gate, 'board-review.mjs'),
      handoffDir: dirs.inbox,
      route: { repoId: 'bsu-cabinet', required: ['has_ui'], base: BASE,
        worktree: dirs.worktree, policyVersion: version, checkProfile: 'bsu', finish: 'verified' },
      bb: { project: process.env.VS1_E2E_BB_PROJECT ?? 'proj_example', provider: 'acp-devin', model: 'swe-2-high',
        permissionMode: 'full' },
      profiles: { bsu: { branch,
        // Закреплённый кандидат легитимно правит test_login_browser.py (diff
        // ревьювался выше по цепочке); операторский допуск tamper-гейта.
        allowTestDeletion: true,
        review: { provider: 'openai', model: 'gpt-6.2-sol', reasoningLevel: 'medium' },
        checks: [
          { image: nodeImage, argv: ['node', '-e', inspect], cwd: 'bsu-cabinet', timeoutMs: 45_000 },
          { image: pytestImage, cwd: 'bsu-cabinet', timeoutMs: 300_000,
            mounts: [{ from: '/usr', to: '/usr' },
              { from: join(homedir(), 'src/bsu-cabinet-full/.venv/lib/python3.12/site-packages'), to: '/deps' },
              { from: '/opt/google/chrome', to: '/opt/google/chrome' }],
            env: { PYTHONPATH: '/candidate/bsu-cabinet/src:/deps', PYTHONDONTWRITEBYTECODE: '1' },
            argv: ['/usr/libexec/docker/docker-init', '--', '/usr/bin/python3', '-m', 'pytest',
              '-o', 'addopts=', '-q', '-p', 'no:cacheprovider',
              'tests/test_setup_options.py', 'tests/test_login_browser.py', 'tests/test_login_modes.py'] },
        ],
        visual: { image: nodeImage, cwd: 'bsu-cabinet', timeoutMs: 45_000,
          argv: ['/bin/sh', '-c', 'cp src/bsu_cabinet/assets/setup.html /artifacts/setup.html'] },
      } },
    };
    const policyFile = join(dirs.operator, 'policy.json');
    await writeFile(policyFile, JSON.stringify(policy), { mode: 0o600 });

    // === Основной живой прогон: 0 ручных пересылок ===
    const seen = { submitted: [], workerThread: null };
    const main = await runController(policyFile, dirs.state, env, wlog, parsed => {
      if (parsed.sha && !seen.submitted.includes(parsed.sha)) seen.submitted.push(parsed.sha);
      if (parsed.threadId && !seen.workerThread) seen.workerThread = parsed.threadId;
    });
    proof.controller = { exitCode: main.code, lines: main.lines };
    proof.workerThread = seen.workerThread;
    if (main.code !== 0) throw new Error(`controller exited ${main.code}`);

    const attempt = JSON.parse(await readFile(join(dirs.state, 'attempt.json'), 'utf8'));
    proof.attempt = { attemptId: attempt.attemptId, taskId: attempt.taskId, epoch: attempt.epoch,
      phase: attempt.phase, threadId: attempt.threadId };
    proof.workerThread = proof.workerThread ?? attempt.threadId;

    const final1 = cardSnapshot(await vbCli(boardUrl, ['read', String(id1)]));
    const final2 = cardSnapshot(await vbCli(boardUrl, ['read', String(id2)]));
    proof.cards.firstFinal = final1;
    proof.cards.secondFinal = final2;

    // Журнал приёмки: файлы квитанций L1/L3/L2 и журнальные run-*.jsonl с sha256.
    for (const file of await readdir(dirs.state)) {
      if (/^(checks|visual|review|run)-/.test(file) || file.endsWith('.ndjson')) {
        proof.journal[file] = await sha256(join(dirs.state, file));
      }
    }

    // === Явная проверка упорядоченной последовательности ходов одной попытки:
    // ход 1 — BASE: красный L1 и ровно 0 вызовов L2;
    // ход 2 — DEFECT: зелёные L1/tamper/L3 + реальный L2 REWORK с findings;
    // промежуточные ходы (если критик поймал дополнительный дефект) — только rework;
    // финальный ход — принятый SHA из квитанции Board: L1/L3/L2 PASS → verified + complete(#1).
    const stateFiles = await readdir(dirs.state);
    const forSha = (sha, re) => stateFiles.some(f => re.test(f) && f.includes(sha));
    const outcomes = {};
    const journalOrder = [];
    for (const file of stateFiles.filter(f => f.startsWith('run-'))) {
      const fullPath = join(dirs.state, file);
      const { mtimeMs } = await stat(fullPath);
      for (const line of (await readFile(fullPath, 'utf8')).split('\n')) {
        if (!line.trim()) continue;
        let rec; try { rec = JSON.parse(line); } catch { continue; }
        if (rec.kind === 'outcome' && rec.candidate_sha &&
            rec.attempt_id === attempt.attemptId && rec.epoch === attempt.epoch) {
          (outcomes[rec.candidate_sha] ??= []).push(rec);
          journalOrder.push({ sha: rec.candidate_sha, mtimeMs });
        }
      }
    }
    journalOrder.sort((a, b) => a.mtimeMs - b.mtimeMs);
    let final1Parsed = null;
    try { final1Parsed = JSON.parse(final1.result ?? 'null'); } catch { /* ignore */ }
    const acceptedSha = typeof final1Parsed?.sha === 'string' ? final1Parsed.sha : null;
    const turns = seen.submitted.map((sha, index) => {
      const list = outcomes[sha] ?? [];
      const last = list[list.length - 1] ?? null;
      return {
        index, sha, count: list.length,
        outcome: last?.outcome ?? null,
        reason: last?.reason ?? null,
        findingsCount: Array.isArray(last?.feedback?.findings) ? last.feedback.findings.length : 0,
      };
    });
    proof.turns = turns;
    const journalStrictlyOrdered = journalOrder.every((entry, idx) =>
      idx === 0 || entry.mtimeMs > journalOrder[idx - 1].mtimeMs);
    const journalMatchesOrder = journalOrder.length === seen.submitted.length &&
      journalStrictlyOrdered &&
      journalOrder.every((entry, idx) => entry.sha === seen.submitted[idx]);
    const exactOrderAndCount = turns.length >= 3 &&
      Object.keys(outcomes).length === seen.submitted.length &&
      turns.every(t => t.count === 1) && journalMatchesOrder;
    const turn0 = turns[0];
    const turn1 = turns[1];
    const turnLast = turns[turns.length - 1];
    const middleAllRework = turns.slice(2, -1).every(t => t.outcome === 'rework');
    const redL1 = turn0?.sha === BASE && turn0.reason === 'local_checks_failed';
    const noL2OnBase = !forSha(BASE, /^review-/) &&
      !outcomes[BASE]?.some(o => /^review/.test(o.reason ?? ''));
    const defectRework = turn1?.sha === DEFECT && turn1.outcome === 'rework' &&
      /^review_verdict:REVIEW_BLOCKED/.test(turn1.reason ?? '') && turn1.findingsCount > 0;
    const defectVisual = forSha(DEFECT, /^visual-artifact-/) && forSha(DEFECT, /^review-/);
    const finalVerified = exactOrderAndCount && middleAllRework &&
      acceptedSha !== null && acceptedSha !== BASE && acceptedSha !== DEFECT &&
      turnLast?.sha === acceptedSha && turnLast.outcome === 'verified';
    const finalVisual = acceptedSha !== null &&
      forSha(acceptedSha, /^visual-artifact-/) && forSha(acceptedSha, /^review-/);
    proof.gateSequence = {
      turn1_redL1_noL2: redL1 && noL2OnBase,
      turn2_l2Rework: defectRework && defectVisual,
      turn3_verified: finalVerified && finalVisual,
      card1Completed: final1.state === 'completed' &&
        typeof final1Parsed?.subject_digest === 'string',
      card2Ready: final2.state === 'ready' && final2.epoch === 0,
    };

    // === Пустой тик: worktree обратно на базу, тот же state dir (броня слота
    // привязана к паре worktree+state), attempt.json отложен — свежий тик.
    // Прямые измерения: append-only a2_events в SQLite (0 claims/мутаций Board)
    // и шимы PATH для bb / docker / pi (0 запусков воркеров и моделей).
    await exec('git', ['-C', dirs.worktree, 'reset', '--hard', BASE], { timeout: 20_000 });
    await exec('git', ['-C', dirs.worktree, 'clean', '-fd'], { timeout: 20_000 });
    const idlePolicyFile = join(dirs.operator, 'policy-idle.json');
    await writeFile(idlePolicyFile, JSON.stringify({ ...policy, waitMs: 12_000 }), { mode: 0o600 });
    const before = cardSnapshot(await vbCli(boardUrl, ['read', String(id2)]));
    const eventsBefore = await boardEventCount(dirs.sqlite);
    const idleShimsDir = join(dirs.operator, 'idle-shims');
    const idleHome = join(dirs.operator, 'idle-home');
    const idleCallsLog = join(dirs.operator, 'idle-calls.log');
    const basePath = env.PATH ?? process.env.PATH ?? '';
    const realPi = join(homedir(), '.pi', 'agent', 'bin', 'pi');
    await createIdleShims(idleShimsDir, idleHome, idleCallsLog, basePath, realPi);
    await rename(join(dirs.state, 'attempt.json'), join(dirs.state, 'attempt-main.json'));
    const idleEnv = { ...env, HOME: idleHome, XDG_STATE_HOME: join(homedir(), '.local', 'state'),
      PATH: `${idleShimsDir}:${basePath}` };
    const idle = await runController(idlePolicyFile, dirs.state, idleEnv, wlog, () => {},
      ['--stop-on-idle']);
    const after = cardSnapshot(await vbCli(boardUrl, ['read', String(id2)]));
    const eventsAfter = await boardEventCount(dirs.sqlite);
    const idleCalls = (await readFile(idleCallsLog, 'utf8')).split('\n').filter(Boolean);
    const bbCallsDelta = idleCalls.filter(c => c === 'bb').length;
    const dockerCallsDelta = idleCalls.filter(c => c === 'docker').length;
    const piCallsDelta = idleCalls.filter(c => c === 'pi').length;
    let idleAttempt = null;
    try {
      idleAttempt = JSON.parse(await readFile(join(dirs.state, 'attempt.json'), 'utf8'));
    } catch (e) {
      if (e?.code !== 'ENOENT') throw e;
    }
    const attemptCreated = idleAttempt !== null;
    const allIdle = idle.lines.length >= 1 && idle.lines.every(l => {
      try { return JSON.parse(l).phase === 'idle'; } catch { return false; }
    });
    const untouched = JSON.stringify(before) === JSON.stringify(after);
    const boardEventsDelta = eventsAfter - eventsBefore;
    proof.idleTick = { lines: idle.lines, exitCode: idle.code, card2Unchanged: untouched,
      attemptCreated, boardEventsDelta, bbCallsDelta, dockerCallsDelta, piCallsDelta };
    proof.idleTickZeroCalls = idle.code === 0 && allIdle && untouched && !attemptCreated &&
      boardEventsDelta === 0 && bbCallsDelta === 0 && dockerCallsDelta === 0 && piCallsDelta === 0;

    // Кандидаты: по порядку из журналов сдачи (три SHA: база, дефект, финал).
    proof.candidates = seen.submitted;
    await say({ step: 'done', attempt: proof.attempt, card1: final1, card2: final2,
      idleTickZeroCalls: proof.idleTickZeroCalls });
  } finally {
    // Доказательство пишется и при частичном срыве: в нём всё наблюдавшееся.
    try {
      await writeFile(values.proof, JSON.stringify(proof, null, 2), { mode: 0o600 });
    } catch { /* путь proof недоступен */ }
    await cleanup();
  }
  await writeFile(values.proof, JSON.stringify(proof, null, 2), { mode: 0o600 });
  const seqOk = proof.gateSequence && Object.values(proof.gateSequence).every(Boolean);
  if (!proof.idleTickZeroCalls || !seqOk || proof.attempt?.phase !== 'done' ||
      proof.cards.secondFinal?.state !== 'ready') {
    console.error('E2E finished without full success; see proof JSON');
    process.exitCode = 1;
  }
}

try { await execute(); } catch (error) {
  console.error(`vs1-e2e: ${error.message?.split('\n')[0] ?? error}`);
  process.exitCode = 1;
}
