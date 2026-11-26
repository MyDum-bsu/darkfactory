#!/usr/bin/env python3
"""gitmark — zero-dep индекс памяти и артефактов Darkfactory.

Порт движка ontoship skills/kb-search/gitmark.py (MIT) под нужды фабрики:
SQLite FTS5 BM25 (unicode61) + trigram + 4-gram fuzzy, слитые через RRF —
работает по RU и EN корпусам Project Memory / Owner Decision Ledger / docs
без единого LLM-токена. Линтер Markdown: битые относительные ссылки,
отсутствующий H1, пустые файлы, дубли заголовков; храповик --baseline REF
через `git archive` (старый долг не ломает сборку, новые нарушения → 1,
ошибка git → 2). Сканер секретов: утечки ключей → 1.

Индекс лежит в <root>/.gitmark/index.db — приватный операторский каталог,
никогда внутри worktree воркера. GITMARK_NO_GIT=1 отключает git-функции
для не-git каталогов.
Только Python 3 stdlib (sqlite3 FTS5, re, json, hashlib, pathlib, subprocess,
argparse, tarfile, tempfile, collections).
"""

import argparse
import collections
import io
import json
import os
import re
import sqlite3
import stat
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path

CHUNK_MAX = 1200          # макс. символов на чанк .md
SKIP_DIRS = {'.git', '.gitmark', 'node_modules', '.next', 'dist', 'build',
             '__pycache__', '.cache', '.turbo', 'coverage', '.venv', 'target'}
INDEXABLE = {'.md', '.jsonl'}
RRF_K = 60

SECRET_PATTERNS = [
    ('private_key', re.compile(r'-----BEGIN [A-Z ]*PRIVATE KEY-----')),
    ('ghp', re.compile(r'ghp_[A-Za-z0-9]{20,}')),
    ('github_pat', re.compile(r'github_pat_[A-Za-z0-9_]{20,}')),
    ('sk_key', re.compile(r'\bsk-[A-Za-z0-9_-]{16,}')),
    ('aws_akia', re.compile(r'\bAKIA[0-9A-Z]{16}\b')),
    ('board_token', re.compile(r'BOARD_TOKEN\s*=\s*\S+')),
]

HEADING = re.compile(r'^(#{1,6})\s+(.+?)\s*#*\s*$', re.MULTILINE)
MD_LINK = re.compile(r'\[[^\]]*\]\(([^)\s]+)\)')

SCHEMA = """
CREATE TABLE IF NOT EXISTS chunks(
  id INTEGER PRIMARY KEY, path TEXT NOT NULL, line INTEGER NOT NULL, text TEXT NOT NULL);
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  text, content='chunks', content_rowid='id', tokenize='unicode61');
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_trigram USING fts5(
  text, content='chunks', content_rowid='id', tokenize='trigram');
CREATE TABLE IF NOT EXISTS chunks_grams(chunk_id INTEGER NOT NULL, gram TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS grams_idx ON chunks_grams(gram);
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
"""


def _escapes_root(path: Path, root: Path) -> bool:
    """Симлинк, указывающий за пределы root, — файл не читаем."""
    try:
        path.resolve().relative_to(root)
        return False
    except (OSError, ValueError):
        return True


def iter_files(root: Path):
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for name in sorted(filenames):
            path = Path(dirpath) / name
            if path.is_symlink() and _escapes_root(path, root):
                continue
            if path.suffix.lower() in INDEXABLE:
                yield path


def chunk_md(path: Path, rel: str):
    """Чанки .md: граница — заголовок или CHUNK_MAX символов."""
    try:
        lines = path.read_text(encoding='utf-8', errors='replace').split('\n')
    except OSError:
        return
    buf, start = [], 1
    for i, line in enumerate(lines, 1):
        is_head = bool(HEADING.match(line))
        if (is_head and buf) or sum(len(x) for x in buf) >= CHUNK_MAX:
            text = '\n'.join(buf).strip()
            if text:
                yield rel, start, text
            buf, start = [], i
        buf.append(line)
    text = '\n'.join(buf).strip()
    if text:
        yield rel, start, text


def chunk_jsonl(path: Path, rel: str):
    try:
        lines = path.read_text(encoding='utf-8', errors='replace').split('\n')
    except OSError:
        return
    for i, line in enumerate(lines, 1):
        line = line.strip()
        if line:
            yield rel, i, line[:CHUNK_MAX * 4]


def grams4(text: str):
    t = re.sub(r'\s+', ' ', text.lower())
    return {t[i:i + 4] for i in range(len(t) - 3)}


def db_path(root: Path, override):
    if override:
        return Path(override)
    return root / '.gitmark' / 'index.db'


def cmd_index(root: Path, db: Path):
    """Индекс строится во временном sibling-файле и атомарно подменяет live db.

    DROP TABLE на живой index.db ломал параллельных читателей (search/lint) на
    время перестройки. Теперь перестройка идёт в index.db.tmp.<pid> рядом с db
    (та же ФС — os.replace атомарен), WAL + busy_timeout не дают блокировкам
    читателей оборвать запись, а финальный os.replace подменяет файл мгновенно:
    открытые соединения дочитывают старый inode, новые видят новый индекс.
    """
    db.parent.mkdir(parents=True, exist_ok=True)
    tmp = db.parent / f'{db.name}.tmp.{os.getpid()}'
    for stale in (tmp, Path(f'{tmp}-wal'), Path(f'{tmp}-shm')):
        try:
            stale.unlink()
        except FileNotFoundError:
            pass
    try:
        con = sqlite3.connect(tmp)
        try:
            con.execute('PRAGMA journal_mode=WAL')
            con.execute('PRAGMA busy_timeout=5000')
            con.executescript(SCHEMA)
            count = 0
            for path in iter_files(root):
                rel = str(path.relative_to(root))
                chunks = chunk_jsonl(path, rel) if path.suffix == '.jsonl' else chunk_md(path, rel)
                for rel_path, line, text in chunks:
                    cur = con.execute('INSERT INTO chunks(path,line,text) VALUES(?,?,?)',
                                      (rel_path, line, text))
                    cid = cur.lastrowid
                    con.execute('INSERT INTO chunks_fts(rowid,text) VALUES(?,?)', (cid, text))
                    con.execute('INSERT INTO chunks_trigram(rowid,text) VALUES(?,?)', (cid, text))
                    con.executemany('INSERT INTO chunks_grams(chunk_id,gram) VALUES(?,?)',
                                    [(cid, g) for g in grams4(text)])
                    count += 1
            con.execute('INSERT INTO meta VALUES(?,?)', ('indexed_files',
                        str(sum(1 for _ in iter_files(root)))))
            con.commit()
        finally:
            con.close()
        os.replace(tmp, db)
        return count
    finally:
        for leftover in (tmp, Path(f'{tmp}-wal'), Path(f'{tmp}-shm')):
            try:
                leftover.unlink()
            except FileNotFoundError:
                pass


def fts5_query(query: str) -> str:
    terms = re.findall(r'[\w\u0400-\u04FF]+', query.lower())
    return ' OR '.join(f'"{t}"' for t in terms[:24]) or '""'


def snippet(text: str, terms, width=200):
    lower = text.lower()
    pos = min((lower.find(t) for t in terms if t and lower.find(t) >= 0), default=0)
    start = max(0, pos - 40)
    s = text[start:start + width].replace('\n', ' ')
    return ('…' if start else '') + s + ('…' if start + width < len(text) else '')


def cmd_search(root: Path, db: Path, query: str, limit: int, as_json: bool):
    if not db.exists():
        return 2, {'error': 'index_missing', 'db': str(db)}
    con = sqlite3.connect(db)
    q = fts5_query(query)
    terms = re.findall(r'[\w\u0400-\u04FF]+', query.lower())
    bm25, tri, fuzz = {}, {}, {}
    try:
        for cid, path, line, text in con.execute(
                'SELECT c.id,c.path,c.line,c.text FROM chunks_fts f '
                'JOIN chunks c ON c.id=f.rowid WHERE chunks_fts MATCH ? '
                'ORDER BY bm25(chunks_fts) LIMIT 50', (q,)):
            bm25[len(bm25)] = (cid, path, line, text)
    except sqlite3.OperationalError:
        pass
    if terms:
        try:
            for cid, path, line, text in con.execute(
                    'SELECT c.id,c.path,c.line,c.text FROM chunks_trigram f '
                    'JOIN chunks c ON c.id=f.rowid WHERE chunks_trigram MATCH ? '
                    'ORDER BY bm25(chunks_trigram) LIMIT 50', (q,)):
                tri[len(tri)] = (cid, path, line, text)
        except sqlite3.OperationalError:
            pass
    # sorted() делает срез детерминированным: порядок итерации set в Python
    # зависит от PYTHONHASHSEED, а без cap длинный запрос упирается в
    # SQLITE_LIMIT_VARIABLE_NUMBER и убивает весь поиск.
    qgrams = sorted(grams4(query))[:200]
    if qgrams:
        marks = ','.join('?' * len(qgrams))
        try:
            for cid, cnt, path, line, text in con.execute(
                    f'SELECT g.chunk_id, COUNT(*), c.path, c.line, c.text FROM chunks_grams g '
                    f'JOIN chunks c ON c.id=g.chunk_id WHERE g.gram IN ({marks}) '
                    'GROUP BY g.chunk_id ORDER BY COUNT(*) DESC LIMIT 50', tuple(qgrams)):
                fuzz[len(fuzz)] = (cid, path, line, text)
        except sqlite3.OperationalError:
            pass
    con.close()

    lists = []
    for ranked in (bm25, tri, fuzz):
        lists.append({v[0]: v for v in ranked.values()})
    scores = collections.defaultdict(float)
    rows = {}
    for ranked in lists:
        for rank, cid in enumerate(ranked):
            scores[cid] += 1.0 / (RRF_K + rank)
            rows[cid] = ranked[cid]
    top = sorted(scores, key=scores.get, reverse=True)[:limit]
    results = [{'path': rows[cid][1], 'line': rows[cid][2],
                'score': round(scores[cid], 4),
                'snippet': snippet(rows[cid][3], terms)} for cid in top]
    if as_json:
        return 0, {'results': results}
    out = [f"{r['path']}:{r['line']}  score={r['score']}  {r['snippet']}" for r in results]
    return 0, {'text': '\n'.join(out) if out else 'no hits'}


def lint_root(root: Path):
    """Список нарушений [(rule, rel_path, detail)]."""
    violations = []
    for path in iter_files(root):
        rel = str(path.relative_to(root))
        try:
            text = path.read_text(encoding='utf-8', errors='replace')
        except OSError:
            violations.append(('unreadable', rel, 'io error'))
            continue
        if path.suffix == '.jsonl':
            if not text.strip():
                violations.append(('empty_file', rel, ''))
            continue
        if not text.strip():
            violations.append(('empty_file', rel, ''))
            continue
        headings = HEADING.findall(text)
        if not any(level == '#' for level, _ in headings):
            violations.append(('missing_h1', rel, ''))
        seen = set()
        for _, title in headings:
            key = title.strip().lower()
            if key in seen:
                violations.append(('duplicate_heading', rel, title.strip()[:80]))
            seen.add(key)
        for m in MD_LINK.finditer(text):
            target = m.group(1).split('#')[0]
            if not target or re.match(r'^[a-z]+://', target) or target.startswith('mailto:'):
                continue
            if target.startswith('/'):
                violations.append(('broken_link', rel, target))
                continue
            resolved = (path.parent / target).resolve()
            try:
                resolved.relative_to(root.resolve())
            except ValueError:
                violations.append(('broken_link', rel, target))
                continue
            if not resolved.exists():
                violations.append(('broken_link', rel, target))
    return violations


def violation_counter(violations):
    return collections.Counter(f'{rule}:{path}' for rule, path, _ in violations)


def git_archive(root: Path, ref: str, dest: Path):
    """git archive REF | tar -x в dest; ошибка git → CalledProcessError."""
    if os.environ.get('GITMARK_NO_GIT') == '1':
        raise subprocess.CalledProcessError(2, 'git')
    proc = subprocess.run(['git', '-C', str(root), 'archive', ref],
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if proc.returncode != 0:
        raise subprocess.CalledProcessError(proc.returncode, 'git', output=proc.stdout,
                                            stderr=proc.stderr)
    with tarfile.open(fileobj=io.BytesIO(proc.stdout)) as tar:
        tar.extractall(dest, filter='data')


def cmd_lint(root: Path, baseline: str, as_json: bool):
    current = lint_root(root)
    new_violations = list(current)
    baseline_n = 0
    if baseline:
        # ref, начинающийся с '-', — инъекция git-опции: fail-closed (2).
        if str(baseline).startswith('-'):
            return 2, {'error': 'baseline_invalid', 'baseline': baseline}
        with tempfile.TemporaryDirectory() as tmp:
            try:
                git_archive(root, baseline, Path(tmp))
            except subprocess.CalledProcessError:
                return 2, {'error': 'git_archive_failed', 'baseline': baseline}
            base_violations = lint_root(Path(tmp))
        baseline_n = len(base_violations)
        allowed = violation_counter(base_violations)
        new_violations = []
        counts = collections.Counter()
        for v in current:
            key = f'{v[0]}:{v[1]}'
            counts[key] += 1
            if counts[key] > allowed.get(key, 0):
                new_violations.append(v)
    payload = {'total': len(current), 'new': len(new_violations),
               'baseline_violations': baseline_n,
               'violations': [{'rule': r, 'path': p, 'detail': d}
                              for r, p, d in new_violations[:200]]}
    return (1 if new_violations else 0), payload


def cmd_secrets(root: Path, as_json: bool):
    hits = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for name in sorted(filenames):
            path = Path(dirpath) / name
            if path.is_symlink() and _escapes_root(path, root):
                continue
            # Только обычные файлы ограниченного размера: FIFO/сокет/устройство
            # заблокировали бы читателя навсегда, а многогигабайтный blob —
            # память процесса. stat() идёт по симлинку внутри root осознанно.
            try:
                st = path.stat()
            except OSError:
                continue
            if not stat.S_ISREG(st.st_mode) or st.st_size > 2 * 1024 * 1024:
                continue
            try:
                text = path.read_text(encoding='utf-8', errors='replace')
            except OSError:
                continue
            rel = str(path.relative_to(root))
            for line_no, line in enumerate(text.split('\n'), 1):
                for rule, rx in SECRET_PATTERNS:
                    if rx.search(line):
                        hits.append({'rule': rule, 'path': rel, 'line': line_no})
    return (1 if hits else 0), {'secrets': hits[:200]}


def main(argv=None):
    ap = argparse.ArgumentParser(prog='gitmark')
    sub = ap.add_subparsers(dest='cmd', required=True)
    for name in ('index', 'search', 'lint', 'secrets'):
        p = sub.add_parser(name)
        p.add_argument('root')
        p.add_argument('--db')
        p.add_argument('--json', action='store_true')
    sub.choices['search'].add_argument('query')
    sub.choices['search'].add_argument('--limit', type=int, default=10)
    sub.choices['lint'].add_argument('--baseline')
    args = ap.parse_args(argv)
    root = Path(args.root).resolve()
    db = db_path(root, args.db)

    if args.cmd == 'index':
        n = cmd_index(root, db)
        payload = {'indexed_chunks': n, 'db': str(db)}
        code = 0
    elif args.cmd == 'search':
        code, payload = cmd_search(root, db, args.query, args.limit, args.json)
    elif args.cmd == 'lint':
        code, payload = cmd_lint(root, args.baseline, args.json)
    elif args.cmd == 'secrets':
        code, payload = cmd_secrets(root, args.json)

    # Не-JSON search печатает человекочитаемые строки path:line score snippet;
    # остальные команды машиночитаемы и потому всегда JSON.
    if args.json or args.cmd != "search":
        print(json.dumps(payload, ensure_ascii=False))
    else:
        print(payload.get('text', json.dumps(payload, ensure_ascii=False)))
    return code


if __name__ == '__main__':
    sys.exit(main())
