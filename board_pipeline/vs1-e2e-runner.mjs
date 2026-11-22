// Живой сквозной E2E VS-1 (Тикет 06): изолированный vb serve + чистый worktree
// БГУ + две связанные синтетические карточки + реальный контроллер
// run-isolated.mjs в queue-driven режиме с исполнителем acp-devin/swe-2-high.
// Ноль ручных пересылок: красный L1 → содержательный L2 REWORK → зелёный
// L1+tamper+L3+L2+seal → complete(#1) → #2 нативно ready → пустой тик idle.
// Границы: никогда порт 44100, никакой живой Board/кабинета/сети кандидата.
import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, open, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { requireWorkspaceSpace } from '../ops/local/check-workspace-space.mjs';

const exec = promisify(execFile);
const HERE = import.meta.dirname;
const BASE = 'ed83f15714f6c1dd72104fa365a68b283f4d0ff7';
const INTERMEDIATE = '94bcf53';
const FINAL = 'f1333faa20cb7eeb0a96df06fcc1ce75676e4ea3';
const FINAL_TREE = 'cf44245b4ce901cd708f11b7136cfd20da3f3179';
const VB = join(homedir(), '.local/share/vercel-board/node_modules/.bin/vb');

const sha256 = async path => createHash('sha256').update(await readFile(path)).digest('hex');
const sha256Text = text => createHash('sha256').update(text).digest('hex');

const WORKER_BRIEF = `Изолированный живой E2E VS-1 фабрики на синтетической карточке БГУ — ровно три хода, каждый заканчивается атомарной записью конверта и завершением хода.

Ход 1: начальный HEAD ${BASE}. Не меняй ни одного файла и немедленно сдай этот SHA по конверту. Он специально не пройдёт детерминированную проверку меню; не выясняй причину и не исправляй до замечания фабрики. Заверши ход.

Ход 2 (только ПОСЛЕ первого замечания фабрики): перенеси уже прошедшую ревью реализацию двумя локальными командами в этом же worktree: \`git cherry-pick ${INTERMEDIATE}\` затем \`git cherry-pick ${FINAL}\`. Оба объекта уже в локальной истории. Затем внеси РОВНО один маленький дефект против правила строгой валидации публичного URL расписаний: в файл \`bsu-cabinet/src/bsu_cabinet/setup_options.py\` добавь строку \`ALLOW_INSECURE_HTTP_SCHEDULE_URL = True\` (константа-флаг, разрешающая не-HTTPS публичный URL; она не ломает тесты). Закоммить оба изменения коммитом с сообщением "test: e2e candidate with defect" (\`git commit -am\`), проверь \`git status\` чистым и сдай новый полный HEAD SHA по тому же конверту. Заверши ход.

Ход 3 (только ПОСЛЕ второго замечания фабрики — оно придёт от независимого ревью): приведи дерево точно к чистому состоянию ${FINAL} без дефекта: \`git reset --hard ${FINAL}\`, убедись, что \`git status --porcelain\` пуст и дерево ${FINAL_TREE}, затем сдай этот SHA (${FINAL}) тем же конвертом. Заверши ход.

Во всех сдачах сохраняй task_id, epoch, attempt_id из первого конверта и worker_thread_id = собственный BB_THREAD_ID. Для файла сдачи — временный файл в том же каталоге и rename. Никакого доступа к реальному кабинету, сети, телефону, рабочей Board, другим тредам, CI/PR/push.`;

const REVIEW_PROMPT = `Независимое ревью синтетической E2E-задачи БГУ. Кандидат указан в заголовке, база ${BASE.slice(0, 7)}. Только чтение. По изменениям setup и настроек проверь: реальное раскрывающееся меню, дефолт публичной папки расписаний из документации, настройки действительно используются, строгая валидация публичного URL без навигации/сетевых действий при сохранении (принимается только https://drive.google.com, путь нормализуется, fragment/params/креды в URL отвергаются), существующее безопасное поведение ручного SMS и только явно выбранный телефон для ADB, headless под теми же ограничениями, привязка сохранения к точному локальному URL и main frame. Блокером является ЛЮБОЙ флаг, константа, комментарий или код, разрешающий или допускающий не-HTTPS (http://) публичный URL расписаний — например ALLOW_INSECURE_HTTP_SCHEDULE_URL или ослабление проверки scheme/host. Не ходить в реальный кабинет, не читать SMS и credentials, не запускать CI и не править код. Локальный офлайн-раннер уже проверил точный SHA. Найденный блокер — воспроизводимый конкретный случай и file:line. Закончить одной строкой REVIEW_OK или REVIEW_BLOCKED.`;

async function vbCli(url, argv) {
  const { stdout } = await exec(VB, ['--url', url, ...argv, '--json'], { timeout: 30_000 });
  return JSON.parse(stdout);
}

// Снимок состояния карточки для сравнения «без эффектов»: только стабильные поля.
function cardSnapshot(read) {
  const task = read?.message?.task ?? read?.task ?? {};
  return { state: task.state, epoch: task.epoch, claim: task.claim ?? null,
    result: task.result ?? null };
}

function runController(policyFile, stateDir, env, wlog, onLine) {
  return new Promise(resolve => {
    const child = spawn(process.execPath,
      [join(HERE, 'run-isolated.mjs'), '--execute', '--policy', policyFile, '--state', stateDir],
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
    'lab-parent': { type: 'string', default: '/media/mydum/Data' },
    'bsu-repo': { type: 'string', default: '/media/mydum/Data/board-v2-lab.dp5xC3Kj/bsu' },
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
  // fuseblk на /media/mydum/Data не хранит биты прав, а контроллер требует
  // state 0700 uid=process. Тяжёлые данные (worktree, sqlite, tmp, лог) — на Data.
  const priv = await mkdtemp(join(tmpdir(), 'vs1-e2e-state-'));
  const dirs = { state: join(priv, 'state'), stateIdle: join(priv, 'state-idle'),
    inbox: join(priv, 'inbox'), gate: join(priv, 'gate'), operator: join(priv, 'operator'),
    sqlite: join(lab, 'sqlite'), tmp: join(lab, 'check-tmp'),
    worktree: join(lab, 'worktree') };
  for (const dir of [dirs.state, dirs.stateIdle, dirs.inbox, dirs.sqlite,
    dirs.gate, dirs.operator, dirs.tmp]) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  }
  const log = await open(join(lab, 'e2e.log'), 'w', 0o600);
  const wlog = text => log.write(text).catch(() => {});
  const say = async obj => { const line = JSON.stringify(obj); console.log(line); await wlog(line + '\n'); };

  // Чистый feature-worktree БГУ от закреплённой базы.
  const branch = `feat/vs1-e2e-${randomUUID().slice(0, 8)}`;
  const bsu = await realpath(values['bsu-repo']);
  await exec('git', ['-C', bsu, 'worktree', 'add', dirs.worktree, '-b', branch, BASE], { timeout: 60_000 });
  await exec('git', ['-C', dirs.worktree, 'config', 'core.filemode', 'false']);
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

  // Изолированный vb serve на loopback, порт != 44100.
  const boardProc = spawn(VB, ['serve', '--port', String(port), '--dir', dirs.sqlite,
    '--no-inspect', '--no-open'], { stdio: ['ignore', 'pipe', 'pipe'] });
  boardProc.stdout.on('data', c => wlog(`[vb] ${c}`));
  boardProc.stderr.on('data', c => wlog(`[vb:err] ${c}`));
  const boardUrl = `http://127.0.0.1:${port}/api/board`;
  for (let i = 0; i < 60; i++) {
    try { await exec('curl', ['-fsS', '--max-time', '0.3', `http://127.0.0.1:${port}/tasks`]); break; }
    catch { if (boardProc.exitCode !== null) throw new Error('vb serve exited'); await new Promise(r => setTimeout(r, 300)); }
  }
  await say({ step: 'board', url: boardUrl, pid: boardProc.pid });

  const env = { ...process.env, XDG_CONFIG_HOME: join(dirs.gate, 'config'), TMPDIR: dirs.tmp };
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
      scope: 'isolated', boardUrl, channel: 'pilot', owner,
      label: { key: 'automation', value: 'vs1-e2e' }, version, waitMs: 3_600_000,
      brief, reviewPrompt, reviewGate: join(dirs.gate, 'board-review.mjs'),
      handoffDir: dirs.inbox,
      route: { repoId: 'bsu-cabinet', required: ['has_ui'], base: BASE,
        worktree: dirs.worktree, policyVersion: version, checkProfile: 'bsu', finish: 'verified' },
      bb: { project: 'proj_xdrdfgw7hs', provider: 'acp-devin', model: 'swe-2-high',
        permissionMode: 'full' },
      profiles: { bsu: { branch,
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

    // === Пустой тик: worktree обратно на базу, свежее состояние, короткий wait ===
    await exec('git', ['-C', dirs.worktree, 'reset', '--hard', BASE], { timeout: 20_000 });
    await exec('git', ['-C', dirs.worktree, 'clean', '-fd'], { timeout: 20_000 });
    const idlePolicyFile = join(dirs.operator, 'policy-idle.json');
    await writeFile(idlePolicyFile, JSON.stringify({ ...policy, waitMs: 12_000 }), { mode: 0o600 });
    const before = cardSnapshot(await vbCli(boardUrl, ['read', String(id2)]));
    const idle = await runController(idlePolicyFile, dirs.stateIdle, env, wlog, () => {});
    const after = cardSnapshot(await vbCli(boardUrl, ['read', String(id2)]));
    const allIdle = idle.lines.length >= 2 && idle.lines.every(l => {
      try { return JSON.parse(l).phase === 'idle'; } catch { return false; }
    });
    const untouched = JSON.stringify(before) === JSON.stringify(after);
    const noGateFiles = (await readdir(dirs.stateIdle))
      .every(f => !/^(checks|visual|review)-/.test(f));
    proof.idleTick = { lines: idle.lines, exitCode: idle.code, card2Unchanged: untouched };
    proof.idleTickZeroCalls = allIdle && untouched && noGateFiles;

    // Кандидаты: по порядку из журналов сдачи (три SHA: база, дефект, финал).
    proof.candidates = seen.submitted;
    await say({ step: 'done', attempt: proof.attempt, card1: final1, card2: final2,
      idleTickZeroCalls: proof.idleTickZeroCalls });
  } finally {
    await cleanup();
  }
  await writeFile(values.proof, JSON.stringify(proof, null, 2), { mode: 0o600 });
  if (!proof.idleTickZeroCalls || proof.attempt?.phase !== 'done' ||
      proof.cards.secondFinal?.state !== 'ready') {
    console.error('E2E finished without full success; see proof JSON');
    process.exitCode = 1;
  }
}

try { await execute(); } catch (error) {
  console.error(`vs1-e2e: ${error.message?.split('\n')[0] ?? error}`);
  process.exitCode = 1;
}
