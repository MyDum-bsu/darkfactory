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
// Bash понимает '+' так же, как '-': +o/+O тоже берут аргумент.
const SHELL_ARG_FLAGS = new Set(['-o', '-O', '+o', '+O', '--init-file', '--rcfile']);

// Опция оболочки — токен с '-' или с '+' (bash +e, +x, +o pipefail);
// '--' — конец опций, '-' — stdin/операнд.
const isShellOption = tok => typeof tok === 'string' && tok.length > 1 &&
  (tok.startsWith('+') || (tok.startsWith('-') && tok !== '--'));
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

// Маркер динамической подстановки: встраивается в слово argv на месте
// $(...)/`...`/<(...)/>(...), чтобы внешняя команда не «не видела» аргумент.
// Статический анализ не знает результата подстановки — argv[0] с маркером или
// маркер/неэкранированный '$' в аргументах деструктивного глагола = fail-closed.
const SENTINEL = '__DYNAMIC_SUBST__';
const MAX_DEPTH = 16;
const depthError = () => Object.assign(new Error('recursion_depth_exceeded'),
  { code: 'recursion_depth_exceeded' });
// Абсолютные системные/домашние пути: рекурсивный rm без -f по ним — разрушение
// хоста даже в «интерактивном» режиме.
const RM_SYSTEM_PATH = /^\/(?:etc|usr|bin|sbin|lib|lib64|boot|root|opt|proc|sys|dev|var|home)(?:\/|$)/;
const isSystemHomePath = (t, norm) => {
  const n = norm(t);
  return n === '/' || n.startsWith('~') || n.startsWith('$HOME') ||
    n.startsWith('${HOME}') || RM_SYSTEM_PATH.test(n);
};
// Допустимый вид цели регенерируемой директории: простое имя без метасимволов.
const REGEN_TARGET = /^[A-Za-z0-9._\/-]+$/;
// Защищённые ветки: push в них запрещён политикой выпуска даже без force.
const PROTECTED_BRANCH = /^(?:refs\/heads\/)?(?:main|master|production|release\/.+)$/;
// Глаголы, у которых динамический аргумент не даёт статически исключить
// деструктивную форму вызова. git обрабатывается в ruleGit по подкомандам.
const DYNAMIC_SENSITIVE = /^(rm|rmdir|shred|dd|chmod|chown|chgrp|docker|kubectl|gcloud|mkfs.*|mke2fs|mkdosfs|fdisk|parted|wipefs|sfdisk|sgdisk)$/;
const isDynamicWord = w => typeof w === 'string' &&
  (w.includes(SENTINEL) || w.includes('$'));

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
      const end = close < 0 ? line.length : close;
      if (c === "'") {
        cur += line.slice(i + 1, end);
      } else {
        for (let j = i + 1; j < end; j++) {
          const q = line[j];
          if (q === '\\') {
            cur += q + (line[j + 1] ?? '');
            j++;
            continue;
          }
          if (q === '`') {
            const subClose = findBacktickClose(line, j);
            if (subClose > j && subClose < end) {
              subs.push(line.slice(j + 1, subClose));
              cur += SENTINEL;
              j = subClose;
              continue;
            }
          }
          if (q === '$' && line[j + 1] === '(') {
            const subClose = findParenClose(line, j + 1);
            if (subClose > j + 1 && subClose < end) {
              subs.push(line.slice(j + 2, subClose));
              cur += SENTINEL;
              j = subClose;
              continue;
            }
          }
          cur += q;
        }
      }
      inWord = true;
      if (close < 0) break;
      i = close;
      continue;
    }
    if (c === '`') {
      const close = findBacktickClose(line, i);
      if (close > 0) {
        subs.push(line.slice(i + 1, close));
        cur += SENTINEL;
        inWord = true;
        i = close;
      }
      continue;
    }
    if (c === '$' && line[i + 1] === '(') {
      const close = findParenClose(line, i + 1);
      if (close > i + 1) {
        subs.push(line.slice(i + 2, close));
        cur += SENTINEL;
        inWord = true;
        i = close;
      } else { cur += c; inWord = true; }
      continue;
    }
    // Подстановка процесса <(...)/>(...): содержимое уходит в subs на
    // рекурсивный разбор, в потоке слов остаётся маркер — иначе
    // 'bash <(echo rm -rf /)' выглядит как безобидный редирект.
    if ((c === '<' || c === '>') && line[i + 1] === '(') {
      const close = findParenClose(line, i + 1);
      if (close > i + 1) {
        subs.push(line.slice(i + 2, close));
        cur += SENTINEL;
        inWord = true;
        i = close;
        continue;
      }
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
    if (c === ';' || c === '\n' || c === '&') {
      // '&' в fd-дублировании '>&'/'<&' (2>&1, 0<&1) — часть оператора
      // редиректа внутри слова, а не разделитель команд: иначе разбор
      // '2>&1 rm -rf /' дробится на ['2>'] и ['1', 'rm', ...], пряча argv[0].
      // '&>'/'&>>' (redirect both) сюда НЕ входят: в POSIX-sh это background +
      // пустая команда с редиректом — консервативно остаётся разделителем.
      if (c === '&' && (line[i - 1] === '>' || line[i - 1] === '<')) {
        cur += c;
        inWord = true;
        continue;
      }
      pushSegment();
      continue;
    }
    // '<'/'>' — операторы редиректа даже в середине слова: 'rm -rf />x' в
    // shell — rm с целью '/' и редиректом '>x', а не целью '/>x'. Без границы
    // слова цель склеивается с оператором и прячется от проверок путей.
    // Цифры перед оператором — fd-префикс (2>), серия операторов не
    // прерывается (>>, <<<); прочее слово завершается перед оператором.
    if (c === '<' || c === '>') {
      if (inWord && cur && !/^\d*[<>]*$/.test(cur)) pushWord();
      cur += c;
      inWord = true;
      continue;
    }
    if (/\s/.test(c)) { pushWord(); continue; }
    cur += c;
    inWord = true;
  }
  pushSegment();
  // Глубина за пределами MAX_DEPTH — fail-closed: молча отброшенная
  // подстановка прятала бы вложенную деструктивную команду от анализа.
  if (subs.length && depth >= MAX_DEPTH) throw depthError();
  for (const sub of subs) {
    // Каждый sub раскрывается рекурсивно ровно один раз.
    segments.push(...lexCommands(sub, state, depth + 1).segments);
  }
  return { segments };
}

function findQuoteClose(line, start, quote, depth = 0) {
  // Кавычка внутри одинарных — литеральна; внутри двойных \" экранируется.
  // $(...) и `...` внутри двойных кавычек разбираются как единая подстановка:
  // кавычки внутри неё открывают собственный контекст и НЕ закрывают внешнюю
  // строку (bash: echo "$(rm -rf "/")" — валидная вложенность).
  if (depth > 64) throw new Error('nesting too deep');
  for (let i = start + 1; i < line.length; i++) {
    if (quote === '"') {
      if (line[i] === '\\') { i++; continue; }
      if (line[i] === '$' && line[i + 1] === '(') {
        const close = findParenClose(line, i + 1, depth + 1);
        if (close < 0) return -1;
        i = close;
        continue;
      }
      if (line[i] === '`') {
        const close = findBacktickClose(line, i);
        if (close < 0) return -1;
        i = close;
        continue;
      }
    }
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

function findParenClose(line, start, nestDepth = 0) {
  if (nestDepth > 64) throw new Error('nesting too deep');
  let depth = 0;
  for (let i = start; i < line.length; i++) {
    const c = line[i];
    if (c === "'" || c === '"') {
      const close = findQuoteClose(line, i, c, nestDepth + 1);
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

// Токены сегмента → argv: отбрасывание редиректов (> >> < <<< &>) с их
// аргументами и VAR=value присваиваний в начале.
function tokenize(words) {
  const argv = [];
  let beforeCommand = true;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const redir = /^(?:\d*(<<<|<<|>>|<|>)|(&>>?))(.*)$/.exec(w);
    if (redir) {
      const op = redir[1] ?? redir[2];
      // Ведущий редирект съедает цель до определения argv[0]. После команды
      // цель herestring остаётся входным потоком (важно для xargs).
      // Голый '&' после '>'/'<' — fd-дублирование с ОТДЕЛЬНОЙ целью (2>& 1 —
      // валидный shell): цель — следующее слово, как у редиректа без неё.
      const rest = redir[3] === '&' ? '' : redir[3];
      if (!rest && (beforeCommand || op !== '<<<')) i++;
      if (rest && op === '<<<' && !beforeCommand) argv.push(rest);
      continue;
    }
    argv.push(w);
    if (!ASSIGNMENT.test(w)) beforeCommand = false;
  }
  while (argv.length && ASSIGNMENT.test(argv[0])) argv.shift();
  return argv;
}

// env -S/--split-string: значение — СТРОКА КОМАНДЫ (GNU env).
// Возвращает { value, next } или null, если текущий токен не -S.
function envSplitString(args, i) {
  const w = args[i];
  if (typeof w !== 'string') return null;
  if (w.startsWith('--split-string')) {
    if (w.includes('=')) return { value: w.slice(w.indexOf('=') + 1), next: i + 1 };
    return { value: args[i + 1], next: i + 2 };
  }
  if (w.startsWith('--') || !/^-[^-]/.test(w)) return null;
  const idx = w.indexOf('S');
  if (idx < 0) return null;
  const rest = w.slice(idx + 1);
  return rest ? { value: rest, next: i + 1 } : { value: args[i + 1], next: i + 2 };
}

// Снятие обёрток: пути (/bin/rm → rm), sudo/command/env/xargs/sh -c —
// рекурсивный разбор вложенных команд.
function unwrap(argv, depth, state, visit) {
  if (!argv.length) return argv;
  // Обёртки глубже MAX_DEPTH — fail-closed: возврат неразобранного argv
  // позволял спрятать команду за цепочкой sudo/env/nice/timeout.
  if (depth > MAX_DEPTH) throw depthError();
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
    // su [-s shell] [-] [user] -c <cmd> | -c<cmd> | --command=<cmd>
    // -lc/-mc и прочие кластеры коротких флагов содержат c.
    for (let i = 1; i < args.length; i++) {
      const w = args[i];
      if (w === '-c' || w === '--command') {
        if (i + 1 < args.length) visit(args[i + 1]);
        return [];
      }
      const inline = w.startsWith('--command=') ? w.slice('--command='.length)
        : w.startsWith('-c') && !w.startsWith('--') ? w.slice(2) : null;
      if (inline !== null) {
        if (inline) visit(inline);
        else if (i + 1 < args.length) visit(args[i + 1]);
        return [];
      }
      if (/^-[^-]/.test(w) && w.includes('c')) {
        // Комбинированный короткий флаг с c: `su -lc 'rm -rf /'`.
        if (i + 1 < args.length) visit(args[i + 1]);
        return [];
      }
      if (['-s', '--shell', '-g', '--group', '-G', '--supp-group'].includes(w)) {
        i++; continue;
      }
      if (w === '--session-command') {
        if (i + 1 < args.length) visit(args[i + 1]);
        return [];
      }
      if (w.startsWith('--session-command=')) {
        const inline = w.slice('--session-command='.length);
        if (inline) visit(inline);
        return [];
      }
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
      // env -S/--split-string принимает СТРОКУ команды, а не обычное
      // значение флага: '-S rm -rf /' и '-S'rm -rf /'' исполняют её.
      if (first === 'env') {
        const split = envSplitString(args, i);
        if (split) {
          if (split.value) visit(split.value);
          i = split.next;
          continue;
        }
      }
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
      if ((w.startsWith('-') || w.startsWith('+')) && w.includes('c') &&
          !w.startsWith('--')) {
        // -c / -lc / -ec / -xc и их '+' формы (+c, +xc, +ec — bash 5.2 и
        // sh исполняют их так же): командная строка — ПЕРВЫЙ non-option
        // операнд после флагов и '--' (bash -c -- 'cmd', bash -c -e 'cmd',
        // bash -c +o pipefail 'cmd').
        let j = i + 1;
        while (j < args.length) {
          const v = args[j];
          if (v === '--') { j++; continue; }
          if (isShellOption(v)) {
            const takesArg = SHELL_ARG_FLAGS.has(v.split('=')[0]) && !v.includes('=');
            j += takesArg ? 2 : 1;
            continue;
          }
          break;
        }
        if (j < args.length) visit(args[j]);
        return tag(args.slice(0, 0));
      }
      if (w === '--') return unwrap(args.slice(i + 1), depth + 1, state, visit);
      if (isShellOption(w)) { i++; continue; }
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
  if (!targets.length) return null;
  const norm = t => t.replace(/\/+$/, '') || '/';
  if (targets.some(t => BLOCKED_FS_ROOTS.has(norm(t)) || t === '-')) {
    return hit(CRITICAL, 'rm_root', 'rm -rf по корню/домашней/текущей директории');
  }
  // Рекурсивный rm без -f по абсолютным системным/домашним путям всё равно
  // разрушает хост: интерактивные подтверждения не спасают содержимое.
  if (!flags.has('f') && targets.some(t => isSystemHomePath(t, norm))) {
    return hit(CRITICAL, 'rm_recursive_system',
      'rm -r без -f по системной/домашней директории');
  }
  if (!flags.has('f')) return null;
  // REGEN_DIRS — только относительные/проектные цели простого вида: rm -rf
  // /tmp, ~/build и цели с метасимволами/пробелами/'..'/'$' — системные или
  // непроверяемые пути, allow по basename не работает.
  if (targets.every(t => REGEN_TARGET.test(t) && !t.startsWith('/') &&
      !t.includes('..') && !t.includes('$') &&
      REGEN_DIRS.has(norm(t).split('/').pop()))) {
    return hit('allow', 'rm_regen', 'rm -rf по регенерируемой директории');
  }
  return hit(ORDINARY, 'rm_rf', 'rm -rf по не регенерируемой директории');
}

// Деструктивные подкоманды git: маркер подстановки или '$' в их аргументах
// не даёт статически исключить force/reset --hard — fail-closed.
const GIT_DESTRUCTIVE_SUBS = new Set(['push', 'reset', 'clean', 'branch',
  'checkout', 'restore']);

function ruleGit(args) {
  const rest = skipGlobalFlags(args, 'git');
  const sub = rest[0];
  if (typeof sub === 'string' && isDynamicWord(sub)) {
    return hit(CRITICAL, 'dynamic_subst', 'подкоманда git формируется динамически');
  }
  if (GIT_DESTRUCTIVE_SUBS.has(sub) && rest.slice(1).some(isDynamicWord)) {
    return hit(CRITICAL, 'dynamic_subst',
      `git ${sub} с динамическими аргументами не проверяем статически`);
  }
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
    const emptyDestination = w => {
      const colon = w.indexOf(':');
      return colon !== -1 && w.slice(colon + 1) === '';
    };
    // push --delete / push origin :branch — удаление удалённой ветки.
    if (rest.slice(1).some(w => w === '--delete' || w === '-d' || w.startsWith(':') || emptyDestination(w))) {
      return hit(ORDINARY, 'git_push_delete', 'git push удаляет удалённую ветку');
    }
    // Push в защищённую ветку запрещён политикой выпуска даже без force:
    // main/master/production/release/* в любой refspec-позиции (включая
    // refs/heads/main и HEAD:main). Первый позиционный аргумент — remote.
    const positionals = [];
    const withValue = new Set(['-o', '--push-option', '--repo', '--rep',
      '--receive-pack', '--exec', '--recurse-submodules']);
    let endOfOptions = false;
    let bulk = null;
    let repositoryFlag = false;
    for (let i = 1; i < rest.length; i++) {
      const w = rest[i];
      if (!endOfOptions && w === '--') {
        endOfOptions = true;
        continue;
      }
      if (!endOfOptions && w.startsWith('-')) {
        const key = w.split('=')[0];
        if (key === '--all' || key === '--branches') bulk = key;
        if (key === '--repo' || key === '--rep' || key === '--no-repo' || key === '--no-rep') {
          repositoryFlag = true;
        }
        if (withValue.has(key) && !w.includes('=')) i++;
        continue;
      }
      positionals.push(w);
    }
    if (bulk !== null) {
      return hit(CRITICAL, 'git_push_bulk',
        `git push ${bulk} отправляет refs без индивидуальной инспекции`);
    }
    if (repositoryFlag) {
      return hit(CRITICAL, 'git_push_repository_ambiguous',
        'git push --repo делает источник remote неоднозначным для статической проверки');
    }
    if (positionals.length < 2) {
      return hit(CRITICAL, 'git_push_implicit',
        'git push без явного remote и незащищённого refspec может попасть в защищённую ветку');
    }
    for (const refspec of positionals.slice(1)) {
      const colon = refspec.indexOf(':');
      const dest = colon === -1 ? refspec : refspec.slice(colon + 1);
      if (PROTECTED_BRANCH.test(dest)) {
        return hit(CRITICAL, 'git_push_protected',
          `git push в защищённую ветку ${dest} запрещён политикой выпуска`);
      }
      const implicitSource = colon === -1 &&
        (refspec === 'HEAD' || refspec === '@' || refspec.startsWith('@{') ||
          ['FETCH_HEAD', 'ORIG_HEAD', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REBASE_HEAD'].includes(refspec));
      if (implicitSource || dest.includes('*')) {
        return hit(CRITICAL, 'git_push_implicit',
          'git push с неявным или шаблонным назначением не доказывает незащищённую ветку');
      }
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
  const optionWords = args.slice(1).filter(w => w.startsWith('-'));
  const flags = optionWords.join('');
  if (!flags.includes('R') && !optionWords.includes('--recursive')) return null;
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
  const result = { innerArgvs: [] };
  if (args.includes('-delete')) {
    result.hit = hit(ORDINARY, 'find_delete', 'find -delete удаляет найденные файлы');
  }
  for (let execIdx = 0; execIdx < args.length; execIdx++) {
    if (!['-exec', '-execdir', '-ok', '-okdir'].includes(args[execIdx])) continue;
    // find ... -exec rm -rf {} \; — вложенная команда до ';' или '+'.
    const innerArgv = [];
    let end = execIdx + 1;
    for (; end < args.length && args[end] !== ';' && args[end] !== '+'; end++) {
      innerArgv.push(args[end]);
    }
    if (innerArgv.length) result.innerArgvs.push(innerArgv);
    execIdx = end;
  }
  return result.hit || result.innerArgvs.length ? result : null;
}

// --- движок ------------------------------------------------------------------

// Рекурсивный разбор вложенной командной строки (sh -c, eval, env -S,
// herestring): глубина вложения общая для всех точек входа, за пределами
// MAX_DEPTH — fail-closed, а не молчаливый allow.
function recurseLine(inner, state) {
  state.nest = (state.nest ?? 0) + 1;
  if (state.nest > MAX_DEPTH) throw depthError();
  try {
    return analyze(lexCommands(inner, state, 0).segments, state);
  } finally {
    state.nest--;
  }
}

function analyze(segments, state) {
  let worst = hit('allow', 'none', '');
  const raise = h => {
    if (h && SEVERITY_RANK[h.severity] > SEVERITY_RANK[worst.severity]) worst = h;
  };
  const analyzeArgv = (argv, fromPipe = false) => {
    if (!argv.length) return;
    // Ведущие ключевые слова shell — не команда: «if true; then ...».
    // time — ключевое слово со своими флагами (time -p rm -rf /): после
    // него пропускаются опции, чтобы дойти до самой команды.
    while (argv.length && SHELL_KEYWORDS.has(argv[0])) {
      const keyword = argv[0];
      argv = argv.slice(1);
      if (keyword !== 'time') continue;
      while (argv.length && argv[0].startsWith('-') && argv[0] !== '-') {
        const opt = argv[0];
        argv = argv.slice(1);
        if (['-f', '--format', '-o', '--output'].includes(opt.split('=')[0]) &&
            !opt.includes('=') && argv.length) {
          argv = argv.slice(1);
        }
      }
    }
    if (!argv.length) return;
    const unwrapped = unwrap(argv, 0, state, inner => {
      if (FORK_BOMB.test(inner)) raise(hit(CRITICAL, 'fork_bomb', 'fork-бомба'));
      if (SQL_DESTRUCTIVE.test(inner)) {
        raise(hit(CRITICAL, 'sql_destructive', 'DROP/TRUNCATE в тексте команды'));
      }
      raise(recurseLine(inner, state));
    });
    if (!unwrapped.length) {
      if (fromPipe && unwrapped.shellConsumed === true) {
        raise(hit(CRITICAL, 'pipe_to_shell', 'поток данных в интерпретатор shell'));
      }
      return;
    }
    const cmd = unwrapped[0];
    // argv[0] с маркером подстановки или '$' — команда формируется
    // динамически ('$(echo rm) -rf /', 'bash <(...)' после снятия обёртки):
    // статически не проверяемо — fail-closed.
    if (isDynamicWord(cmd)) {
      raise(hit(CRITICAL, 'dynamic_subst', 'команда формируется динамической подстановкой'));
      return;
    }
    // Деструктивные глаголы с динамическими аргументами: подстановка или
    // неэкранированная переменная может нести флаги/цели, которые разбор
    // не видит ('rm -rf $(echo /)', 'docker rm $(echo -f) x').
    if (DYNAMIC_SENSITIVE.test(cmd) && unwrapped.slice(1).some(isDynamicWord)) {
      raise(hit(CRITICAL, 'dynamic_subst',
        `${cmd} с динамическими аргументами не проверяем статически`));
      return;
    }
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
      raise(h?.hit);
      for (const innerArgv of h?.innerArgvs ?? []) analyzeArgv(innerArgv);
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
      raise(recurseLine(inner, state));
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
    if (error.code === 'recursion_depth_exceeded') {
      // Fail-closed: глубина рекурсии/обёрток за пределом — блок, не allow.
      return { decision: 'block', severity: 'critical',
        rule: 'recursion_depth_exceeded', reason: 'recursion_depth_exceeded' };
    }
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
