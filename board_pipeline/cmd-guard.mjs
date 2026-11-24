// Clean-room Command Guard (V2-3): реализация с нуля под лицензией
// проекта (код destructive-guard НЕ копировался — только концепция
// тиринга severity). Два тира находок:
//   CRITICAL — необратимое разрушение хоста/данных/истории: rm -rf / ~ .,
//     mkfs, dd of=/dev/..., git push --force, git reset --hard,
//     git clean -fd, DROP TABLE/DATABASE/TRUNCATE, gcloud/kubectl delete,
//     docker system prune -a, chmod -R 777 /, fork-bomb.
//   ORDINARY — деструктивно, но локально обратимо: rm -rf <non-regen>,
//     git branch -D, git checkout -- ., docker rm -f, kill -9 -1.
// Allowlist REGEN_DIRS: rm -rf node_modules/.next/dist/... → allow (0 FP).
// git push --force-with-lease / --force-if-includes → allow (0 FP).
// Таймаут разбора жёсткий (200 мс): превышение — fail-closed block.
// Только Node stdlib.

import { pathToFileURL } from 'node:url';

const REGEN_DIRS = new Set(['node_modules', '.next', 'dist', 'build', '.cache',
  '__pycache__', '.pytest_cache', 'target', 'coverage', '.turbo', 'tmp', '.vite']);

const FORK_BOMB = /([^\s()]+)\s*\(\s*\)\s*\{[^}]*\|[^}]*&[^}]*\}\s*;?\s*\1/;
const SQL_DESTRUCTIVE = /\b(drop\s+(table|database|schema)|truncate\s+(table\s+)?[\w`"'])/i;
const SHELL_WRAPPERS = new Set(['sh', 'bash', 'zsh', 'dash', 'ash', 'ksh']);
// Флаги оболочек, принимающие ОТДЕЛЬНЫЙ аргумент до -c (bash -o pipefail -c).
const SHELL_ARG_FLAGS = new Set(['-o', '-O', '--init-file', '--rcfile']);
// Ведущие ключевые слова shell пропускаются: if/for/while — не команды.
const SHELL_KEYWORDS = new Set(['if', 'then', 'elif', 'else', 'fi', 'do',
  'done', 'while', 'until', 'for', 'in', 'case', 'esac', 'time', '!',
  'coproc', 'select', 'function']);
const SIMPLE_WRAPPERS = new Set(['command', 'builtin', 'exec', 'nohup', 'time', 'stdbuf', 'nice', 'ionice', 'busybox', 'chrt', 'taskset', 'timeout', 'setsid', 'watch']);
// Флаги обёрток с ОТДЕЛЬНЫМ аргументом (exec -c/-a различаются, timeout -s).
const WRAPPER_ARG_FLAGS = {
  exec: new Set(['-a', '--argv0']),
  nice: new Set(['-n', '--adjustment']),
  stdbuf: new Set(['-o', '-e', '-i']),
  taskset: new Set(['-c']),
  chrt: new Set(['-p']),
  ionice: new Set(['-c', '-n', '-p', '-t']),
  timeout: new Set(['-s', '-k', '--signal', '--kill-after']),
  watch: new Set(['-n', '--interval']),
};
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

// Глобальные флаги со значением (следующий токен — значение, если флаг без =).
const GLOBAL_FLAGS = {
  git: new Set(['-C', '-c', '--git-dir', '--work-tree', '--exec-path', '--namespace']),
  docker: new Set(['-H', '--host', '--context', '--config', '-l', '--log-level']),
  kubectl: new Set(['-n', '--namespace', '--context', '--kubeconfig', '-s', '--server', '--as', '--cluster', '--user', '--token']),
  gcloud: new Set(['--project', '--account', '--configuration', '--format']),
  sudo: new Set(['-u', '-g', '-h', '-p', '-r', '-t', '-C', '-T', '-D', '-R', '-U', '--askpass']),
  doas: new Set(['-u', '-C', '-D', '-n']),
  env: new Set(['-u', '--unset', '-C', '--chdir', '-S', '--split-string']),
  xargs: new Set(['-I', '-n', '-P', '-d', '-s', '-L', '-a', '-E', '-J', '-R', '--max-procs', '--max-args', '--delimiter', '--arg-file']),
};

const CRITICAL = 'critical';
const ORDINARY = 'ordinary';
const SEVERITY_RANK = { allow: 0, ordinary: 1, critical: 2 };

const hit = (severity, rule, reason) => ({ severity, rule, reason });
const BLOCKED_FS_ROOTS = new Set(['/', '~', '$HOME', '${HOME}', '.', '..', '*', '/*', '~/*']);

// Лексер: разбор командной строки в сегменты команд с границами слов —
// с учётом кавычек и экранирования. Кавычки и backslash снимаются на лету
// и сливаются со словом: 'r'm → rm, "rm" → rm, \rm → rm; важно, что
// 'rm -rf /' остаётся ОДНИМ словом (аргумент sh -c / xargs -I сохраняется
// целиком и разбирается рекурсивно). $(...) и `...` извлекаются в subs —
// их содержимое проверяется рекурсивно, в потоке слов подстановка
// остаётся словом-маркером.
// Возвращает { segments: [[word,...],...] } — subs раскрыты рекурсивно.
function lexCommands(line, state, depth) {
  const segments = [];
  const subs = [];
  let words = [];
  let cur = '';
  let inWord = false;
  let pipePending = false;
  const pushWord = () => { if (inWord) words.push(cur); cur = ''; inWord = false; };
  // pipePending: сегмент — приёмник '|' → «что-то | sh» детектируется
  // отдельным правилом (поток в интерпретатор — критично).
  const pushSegment = () => {
    pushWord();
    if (words.length) {
      words.fromPipe = pipePending;
      pipePending = false;
      segments.push(words);
    }
    words = [];
  };
  for (let i = 0; i < line.length; i++) {
    state.check();
    const c = line[i];
    if (c === '\\') { cur += line[++i] ?? ''; inWord = true; continue; }
    if (c === "'" || c === '"') {
      const close = findQuoteClose(line, i, c);
      if (close < 0) { cur += line.slice(i + 1); inWord = true; break; }
      cur += line.slice(i + 1, close);
      inWord = true;
      i = close;
      continue;
    }
    if (c === '`') {
      const close = findBacktickClose(line, i);
      if (close > 0) { subs.push(line.slice(i + 1, close)); i = close; }
      continue;
    }
    if (c === '$' && line[i + 1] === '(') {
      const close = findParenClose(line, i + 1);
      if (close > i + 1) { subs.push(line.slice(i + 2, close)); i = close; }
      else { cur += c; inWord = true; }
      continue;
    }
    if ((c === '&' && line[i + 1] === '&') || (c === '|' && line[i + 1] === '|')) {
      pushSegment(); i++; continue;
    }
    if (c === '|') { pushSegment(); pipePending = true; continue; }
    // Групповые операторы — границы команд: (rm -rf /), { rm -rf /; }.
    // '{'/'}' — только как отдельные слова (зарезервированные в shell);
    // '{}' в find -exec остаётся словом.
    if (c === '(' || c === ')') { pushSegment(); continue; }
    if (c === '{' || c === '}') {
      const next = line[i + 1];
      if (!inWord && (next === undefined || /[\s;]/.test(next))) {
        pushSegment(); continue;
      }
      cur += c; inWord = true; continue;
    }
    if (c === ';' || c === '\n' || c === '&') { pushSegment(); continue; }
    if (/\s/.test(c)) { pushWord(); continue; }
    cur += c;
    inWord = true;
  }
  pushSegment();
  if (depth < 16) {
    for (const sub of subs) {
      // Каждый sub раскрывается рекурсивно ровно один раз.
      segments.push(...lexCommands(sub, state, depth + 1).segments);
    }
  }
  return { segments };
}

function findQuoteClose(line, start, quote) {
  // Кавычка внутри одинарных — литеральна; внутри двойных \" экранируется.
  for (let i = start + 1; i < line.length; i++) {
    if (quote === '"' && line[i] === '\\') { i++; continue; }
    if (line[i] === quote) return i;
  }
  return -1;
}

function findBacktickClose(line, start) {
  for (let i = start + 1; i < line.length; i++) {
    if (line[i] === '`') return i;
  }
  return -1;
}

function findParenClose(line, start) {
  let depth = 0;
  for (let i = start; i < line.length; i++) {
    const c = line[i];
    if (c === "'" || c === '"') {
      const close = findQuoteClose(line, i, c);
      if (close < 0) return -1;
      i = close;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// Токены сегмента → argv: отбрасывание редиректов (> >> < <<<) с их
// аргументами и VAR=value присваиваний в начале.
function tokenize(words) {
  const argv = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (/^\d*(<<<|>>?|<)/.test(w)) {
      // '>' '<' '>>' съедают следующее слово (имя файла); '<<<' — нет:
      // содержимое herestring анализируется в analyze и остаётся аргументом.
      if (/^\d*(<|>)$/.test(w) || /^\d*<{1,2}$/.test(w)) i++;
      continue;
    }
    argv.push(w);
  }
  while (argv.length && ASSIGNMENT.test(argv[0])) argv.shift();
  return argv;
}

// Снятие обёрток: пути (/bin/rm → rm), sudo/command/env/xargs/sh -c —
// рекурсивный разбор вложенных команд.
function unwrap(argv, depth, state, visit) {
  if (!argv.length || depth > 16) return argv;
  state.check();
  let args = argv.slice();
  let first = args[0];
  // Путь к бинарю: /bin/rm, /usr/bin/git, ./rm → basename.
  if (/[/\\]/.test(first)) first = first.split(/[/\\]/).pop();
  if (!first) return args.slice(1);
  args[0] = first;

  if (first === 'eval') {
    // eval объединяет аргументы и исполняет — разбираем рекурсивно.
    if (args.length > 1) visit(args.slice(1).join(' '));
    return [];
  }
  if (first === 'su') {
    // su [-s shell] [-] [user] -c <cmd> — ищем -c/-s, остальное флаги/логин.
    for (let i = 1; i < args.length; i++) {
      const w = args[i];
      if (w === '-c' || w === '--command') {
        if (i + 1 < args.length) visit(args[i + 1]);
        return [];
      }
      if (['-s', '--shell', '-g', '--group', '-G', '--supp-group',
        '--session-command'].includes(w)) { i++; continue; }
    }
    return [];
  }
  if (SIMPLE_WRAPPERS.has(first)) {
    // timeout -s KILL 5 rm → 5 — длительность; watch -n 1; setsid -f.
    const withArg = WRAPPER_ARG_FLAGS[first] ?? new Set();
    let positional = false;
    let i = 1;
    while (i < args.length) {
      const w = args[i];
      if (withArg.has(w.split('=')[0])) { i += w.includes('=') ? 1 : 2; continue; }
      if (w.startsWith('-')) { i++; continue; }
      if (first === 'timeout' && !positional) { positional = true; i++; continue; }
      break;
    }
    return unwrap(args.slice(i), depth + 1, state, visit);
  }
  if (first === 'sudo' || first === 'doas' || first === 'env' || first === 'xargs') {
    const withArg = GLOBAL_FLAGS[first];
    let i = 1;
    while (i < args.length) {
      const w = args[i];
      if (first === 'env' && ASSIGNMENT.test(w)) { i++; continue; }
      if (withArg.has(w.split('=')[0])) {
        i += w.includes('=') ? 1 : 2;
        continue;
      }
      if (w.startsWith('-')) { i++; continue; }
      break;
    }
    const inner = unwrap(args.slice(i), depth + 1, state, visit);
    // xargs берёт цели из stdin: помечаем вложенную команду, чтобы
    // «xargs rm -rf» без явных целей тоже блокировался.
    if (first === 'xargs') {
      try { Object.defineProperty(inner, 'viaXargs', { value: true }); } catch { /* noop */ }
    }
    return inner;
  }
  if (SHELL_WRAPPERS.has(first)) {
    // Помечаем, что ведущая команда — интерпретатор shell: «| sh» без
    // аргументов оставляет пустой argv, но pipe_to_shell должен сработать.
    const tag = out => {
      try { Object.defineProperty(out, 'shellConsumed', { value: true }); } catch { /* noop */ }
      return out;
    };
    let i = 1;
    while (i < args.length) {
      const w = args[i];
      if (SHELL_ARG_FLAGS.has(w.split('=')[0])) {
        i += w.includes('=') ? 1 : 2;
        continue;
      }
      if (w.startsWith('-') && w.includes('c') && !w.startsWith('--')) {
        if (i + 1 < args.length) visit(args[i + 1]);
        return tag(args.slice(0, 0));
      }
      if (w === '--') return unwrap(args.slice(i + 1), depth + 1, state, visit);
      if (w.startsWith('-')) { i++; continue; }
      break;
    }
    return tag(args.slice(i));
  }
  return args;
}

function skipGlobalFlags(args, tool) {
  const withArg = GLOBAL_FLAGS[tool] ?? new Set();
  let i = 1;
  while (i < args.length) {
    const w = args[i];
    if (!w.startsWith('-')) break;
    const key = w.split('=')[0];
    if (withArg.has(key) || withArg.has(w)) { i += w.includes('=') ? 1 : 2; continue; }
    i++;
  }
  return args.slice(i);
}

// --- правила по инструментам -------------------------------------------------

function ruleRm(args) {
  const flags = new Set();
  const targets = [];
  for (const w of args.slice(1)) {
    if (w.startsWith('-')) {
      if (w === '--') continue;
      for (const ch of w.replace(/^--?/, '')) flags.add(ch);
      continue;
    }
    targets.push(w);
  }
  if (!flags.has('r') && !flags.has('R')) return null;
  if (!flags.has('f')) return null;
  if (!targets.length) return null;
  const norm = t => t.replace(/\/+$/, '') || '/';
  if (targets.some(t => BLOCKED_FS_ROOTS.has(norm(t)) || t === '-')) {
    return hit(CRITICAL, 'rm_root', 'rm -rf по корню/домашней/текущей директории');
  }
  // REGEN_DIRS — только относительные/проектные цели: rm -rf /tmp и
  // ~/build — системные/домашние пути, allow по basename не работает.
  if (targets.every(t => !/^[\/~$]/.test(t) && REGEN_DIRS.has(norm(t).split('/').pop()))) {
    return hit('allow', 'rm_regen', 'rm -rf по регенерируемой директории');
  }
  return hit(ORDINARY, 'rm_rf', 'rm -rf по не регенерируемой директории');
}

function ruleGit(args) {
  const rest = skipGlobalFlags(args, 'git');
  const sub = rest[0];
  if (sub === 'push') {
    const flags = rest.slice(1);
    if (flags.some(f => f === '-f' || f === '--force' || f === '--force-all' ||
        f === '--mirror' || /^-[^-].*f/.test(f))) {
      return hit(CRITICAL, 'git_push_force', 'git push --force перезаписывает историю');
    }
    // '+refspec' — force-push без слова --force: git push origin +main.
    if (rest.slice(1).some(w => w.startsWith('+'))) {
      return hit(CRITICAL, 'git_push_plus', 'git push +refspec перезаписывает историю');
    }
    // push --delete / push origin :branch — удаление удалённой ветки.
    if (rest.slice(1).some(w => w === '--delete' || w === '-d' || w.startsWith(':'))) {
      return hit(ORDINARY, 'git_push_delete', 'git push удаляет удалённую ветку');
    }
    // --force-with-lease / --force-if-includes — безопасные форс-пуши.
    return null;
  }
  if (sub === 'reset' && rest.includes('--hard')) {
    return hit(CRITICAL, 'git_reset_hard', 'git reset --hard теряет незакоммиченные правки');
  }
  if (sub === 'clean') {
    const flags = rest.slice(1).filter(w => w.startsWith('-')).join('');
    if (flags.includes('f') && flags.includes('d')) {
      return hit(CRITICAL, 'git_clean_fd', 'git clean -fd удаляет untracked файлы и каталоги');
    }
  }
  if (sub === 'branch' && rest.slice(1).some(w => w === '-D' || /^-[^-]*D/.test(w))) {
    return hit(ORDINARY, 'git_branch_D', 'git branch -D удаляет невлитую ветку');
  }
  if ((sub === 'checkout' || sub === 'restore') &&
      rest.slice(1).some(w => w === '.' || w === './' || w === '*')) {
    return hit(ORDINARY, 'git_checkout_dot', 'git checkout/restore по текущему дереву');
  }
  return null;
}

function ruleDd(args) {
  if (args.some(w => /^of=\/dev\//.test(w))) {
    return hit(CRITICAL, 'dd_of_dev', 'dd of=/dev/* перезаписывает блочное устройство');
  }
  return null;
}

function ruleMkfs(args, cmd) {
  if (/^(mkfs|mke2fs|mkdosfs|fdisk|parted|wipefs|sfdisk|sgdisk)/.test(cmd)) {
    return hit(CRITICAL, 'mkfs', 'форматирование/разметка блочного устройства');
  }
  return null;
}

function ruleChmod(args, cmd) {
  if (cmd !== 'chmod' && cmd !== 'chown' && cmd !== 'chgrp') return null;
  const flags = args.slice(1).filter(w => w.startsWith('-')).join('');
  if (!flags.includes('R')) return null;
  const operands = args.slice(1).filter(w => !w.startsWith('-'));
  const targets = cmd === 'chmod' ? operands.slice(1) : operands.slice(1);
  const modeOrSpec = operands[0] ?? '';
  const dangerousMode = cmd === 'chmod' ? /^(0*7{3}|0*[67]{3}|[ugoa]*[+=]r?w?x)/.test(modeOrSpec) : true;
  if (dangerousMode && targets.some(t => BLOCKED_FS_ROOTS.has(t.replace(/\/+$/, '') || '/'))) {
    return hit(CRITICAL, 'chmod_recursive_root', `${cmd} -R по корню/домашней директории`);
  }
  return null;
}

function ruleGcloud(args) {
  const rest = skipGlobalFlags(args, 'gcloud');
  const words = rest.filter(w => !w.startsWith('-'));
  if (words.some(w => w === 'delete' || w === 'deallocate')) {
    return hit(CRITICAL, 'gcloud_delete', 'gcloud ... delete удаляет облачный ресурс');
  }
  return null;
}

function ruleKubectl(args) {
  const rest = skipGlobalFlags(args, 'kubectl');
  const sub = rest.find(w => !w.startsWith('-'));
  if (sub === 'delete' || sub === 'drain') {
    return hit(CRITICAL, 'kubectl_delete', `kubectl ${sub} удаляет кластерные ресурсы`);
  }
  return null;
}

function ruleDocker(args) {
  const rest = skipGlobalFlags(args, 'docker');
  const words = rest.filter(w => !w.startsWith('-'));
  if (words[0] === 'system' && words[1] === 'prune') {
    const flags = rest.slice(1).filter(w => w.startsWith('-'));
    if (flags.some(w => w === '-a' || w === '--all' || w === '--volumes' || /^-[a-z]*a/.test(w))) {
      return hit(CRITICAL, 'docker_prune_all', 'docker system prune -a сносит все образы');
    }
    return hit(ORDINARY, 'docker_prune', 'docker system prune удаляет неиспользуемые данные');
  }
  if ((words[0] === 'rm' || words[0] === 'rmi' || words[0] === 'container' && words[1] === 'rm' ||
      words[0] === 'image' && words[1] === 'rm')) {
    const flags = rest.slice(1).filter(w => w.startsWith('-')).join('');
    if (flags.includes('f')) {
      return hit(ORDINARY, 'docker_rm_f', 'docker rm -f принудительно удаляет контейнер/образ');
    }
  }
  return null;
}

function ruleKill(args, cmd) {
  if (!['kill', 'pkill', 'killall'].includes(cmd)) return null;
  const flags = args.slice(1).filter(w => w.startsWith('-')).join(' ');
  const sig9 = /(-9|-KILL|-SIGKILL|\bk\b)/.test(flags);
  // Отрицательные/числовые аргументы — pid'ы (kill -9 -1 = все процессы).
  const targets = args.slice(1).filter(w => /^-?\d+$/.test(w) || !w.startsWith('-'));
  if (sig9 && targets.some(t => t === '-1' || t === '1')) {
    return hit(ORDINARY, 'kill_all', 'kill -9 по всем процессам/PID 1');
  }
  if (cmd !== 'kill' && targets.some(t => t === '-1' || t === '1')) {
    return hit(ORDINARY, 'kill_all', `${cmd} по всем процессам`);
  }
  return null;
}

function ruleShutdown(args, cmd) {
  if (['shutdown', 'reboot', 'halt', 'poweroff', 'init', 'telinit'].includes(cmd)) {
    return hit(CRITICAL, 'shutdown', 'остановка/перезагрузка хоста');
  }
  return null;
}

function ruleFind(args) {
  if (args.includes('-delete')) {
    return hit(ORDINARY, 'find_delete', 'find -delete удаляет найденные файлы');
  }
  const execIdx = args.findIndex(w => w === '-exec' || w === '-execdir' || w === '-ok' || w === '-okdir');
  if (execIdx >= 0 && execIdx + 1 < args.length) {
    // find ... -exec rm -rf {} \; — вложенная команда до ';' или '+'.
    const innerArgv = [];
    for (let i = execIdx + 1; i < args.length && args[i] !== ';' && args[i] !== '+'; i++) {
      innerArgv.push(args[i]);
    }
    return { innerArgv };
  }
  return null;
}

// --- движок ------------------------------------------------------------------

function analyze(segments, state) {
  let worst = hit('allow', 'none', '');
  const raise = h => {
    if (h && SEVERITY_RANK[h.severity] > SEVERITY_RANK[worst.severity]) worst = h;
  };
  const analyzeArgv = (argv, fromPipe = false) => {
    if (!argv.length) return;
    // Ведущие ключевые слова shell — не команда: «if true; then ...».
    while (argv.length && SHELL_KEYWORDS.has(argv[0])) argv = argv.slice(1);
    if (!argv.length) return;
    const unwrapped = unwrap(argv, 0, state, inner => {
      if (FORK_BOMB.test(inner)) raise(hit(CRITICAL, 'fork_bomb', 'fork-бомба'));
      if (SQL_DESTRUCTIVE.test(inner)) {
        raise(hit(CRITICAL, 'sql_destructive', 'DROP/TRUNCATE в тексте команды'));
      }
      raise(analyze(lexCommands(inner, state, 0).segments, state));
    });
    if (!unwrapped.length) {
      if (fromPipe && unwrapped.shellConsumed === true) {
        raise(hit(CRITICAL, 'pipe_to_shell', 'поток данных в интерпретатор shell'));
      }
      return;
    }
    const cmd = unwrapped[0];
    // Поток в интерпретатор без видимого тела команды: curl x | bash,
    // echo "rm -rf /" | sh, ... | bash -o pipefail — критично.
    if (fromPipe && (SHELL_WRAPPERS.has(cmd) || unwrapped.shellConsumed === true)) {
      raise(hit(CRITICAL, 'pipe_to_shell', 'поток данных в интерпретатор shell'));
      return;
    }
    // xargs исполняет команду с целями из stdin — явных целей нет, но
    // деструктивная команда всё равно блокируется.
    if (unwrapped.viaXargs === true && ['rm', 'rmdir', 'shred', 'dd'].includes(cmd)) {
      const innerHit = cmd === 'rm' ? ruleRm(unwrapped) : null;
      raise(innerHit ?? hit(ORDINARY, 'xargs_destructive',
        `${cmd} с целями из stdin через xargs`));
      return;
    }
    if (cmd === 'rm') raise(ruleRm(unwrapped));
    else if (cmd === 'git') raise(ruleGit(unwrapped));
    else if (cmd === 'dd') raise(ruleDd(unwrapped));
    else if (cmd === 'gcloud') raise(ruleGcloud(unwrapped));
    else if (cmd === 'kubectl') raise(ruleKubectl(unwrapped));
    else if (cmd === 'docker') raise(ruleDocker(unwrapped));
    else if (cmd === 'find') {
      const h = ruleFind(unwrapped);
      if (h?.innerArgv) analyzeArgv(h.innerArgv);
      else raise(h);
    } else {
      raise(ruleMkfs(unwrapped, cmd));
      raise(ruleChmod(unwrapped, cmd));
      raise(ruleKill(unwrapped, cmd));
      raise(ruleShutdown(unwrapped, cmd));
    }
  };
  for (const words of segments) {
    state.check();
    if (SQL_DESTRUCTIVE.test(words.join(' '))) {
      raise(hit(CRITICAL, 'sql_destructive', 'DROP/TRUNCATE в тексте команды'));
      continue;
    }
    // cmd <<< 'rm -rf /': herestring — команда/ввод в следующем слове,
    // разбирается как вложенная командная строка (и остаётся аргументом
    // argv — для xargs это реальный источник целей).
    const hereIdx = words.findIndex(w => w === '<<<');
    if (hereIdx >= 0 && words[hereIdx + 1] !== undefined) {
      const inner = words[hereIdx + 1];
      if (FORK_BOMB.test(inner)) raise(hit(CRITICAL, 'fork_bomb', 'fork-бомба'));
      if (SQL_DESTRUCTIVE.test(inner)) {
        raise(hit(CRITICAL, 'sql_destructive', 'DROP/TRUNCATE в тексте команды'));
      }
      raise(analyze(lexCommands(inner, state, 0).segments, state));
    }
    analyzeArgv(tokenize(words), words.fromPipe === true);
    if (worst.severity === CRITICAL) return worst;
  }
  return worst;
}

// checkCommand(command, { timeoutMs }) -> { decision, severity, rule, reason }
// decision: 'allow' | 'block'; severity: 'critical' | 'ordinary' | 'allow'.
export function checkCommand(command, { timeoutMs = 200 } = {}) {
  const deadline = Date.now() + timeoutMs;
  const state = {
    steps: 0,
    check() {
      if (++this.steps > 20000 || Date.now() > deadline) {
        throw Object.assign(new Error('guard_timeout'), { code: 'guard_timeout' });
      }
    },
  };
  try {
    if (typeof command !== 'string' || !command.trim()) {
      return { decision: 'allow', severity: 'allow', rule: 'empty', reason: '' };
    }
    if (FORK_BOMB.test(command)) {
      return { decision: 'block', severity: 'critical', rule: 'fork_bomb',
        reason: 'fork-бомба' };
    }
    const worst = analyze(lexCommands(command, state, 0).segments, state);
    if (worst.severity === 'allow') {
      return { decision: 'allow', severity: 'allow', rule: worst.rule, reason: '' };
    }
    return { decision: 'block', severity: worst.severity, rule: worst.rule, reason: worst.reason };
  } catch (error) {
    if (error.code === 'guard_timeout') {
      // Fail-closed: неуспевший разбор блокирует, а не пропускает.
      return { decision: 'block', severity: 'critical', rule: 'guard_timeout',
        reason: 'разбор превысил таймаут' };
    }
    // Любая иная ошибка парсера — тоже fail-closed.
    return { decision: 'block', severity: 'critical', rule: 'guard_error',
      reason: `ошибка разбора: ${error.message}` };
  }
}

// CLI: node cmd-guard.mjs --test "<cmd>" — dry-run без исполнения.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const idx = process.argv.indexOf('--test');
  if (idx < 0 || process.argv[idx + 1] === undefined) {
    console.error('use: cmd-guard.mjs --test "<command>"');
    process.exitCode = 2;
  } else {
    console.log(JSON.stringify(checkCommand(process.argv[idx + 1]), null, 2));
  }
}
