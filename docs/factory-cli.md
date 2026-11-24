# Фабрика: единый CLI Лида

Два тонких входа для оператора-Лида. Оба — только встроенные модули Node,
все проверки до любого эффекта, `--dry-run` печатает план без вызова.

## Постановка задачи — `ops/factory-enqueue.mjs`

Безопасная постановка одной карточки на Board через `vb tasks create`.
Без обхода очереди, без claim/spawn — исполнение остаётся за контроллером.

```sh
node ops/factory-enqueue.mjs \
  --board-url https://board.example --channel ops \
  --title "Карточка X" --repo-id darkfactory --profile p0 \
  --finish verified \
  --brief spec/brief.md --policy policy/operator.json \
  --label domain=pipeline --ticket DF-OPS-2 \
  --worktree /path/wt --memory-dir /path/memory --ledger-path /path/ledger.jsonl \
  --dry-run
```

Обязательные: `--board-url` (http/https), `--channel`, `--title` или
`--text`, `--repo-id`, `--profile`, `--finish` (`verified`|`deployed`),
`--spec-digest` или `--brief`, `--policy-digest` или `--policy`.
Дайджесты файлов считаются sha256 самим CLI. Контрактные метки
(`spec_digest`, `policy_digest`, `repo_id`, `profile_id`, `finish`)
резервированы: `--label` их не переопределяет.

Проверки путей до эффекта: `lstat`+`realpath`, симлинк — отказ, путь
внутри `--worktree` — отказ.

## Запуск контроллера — `ops/factory-run.mjs`

Тонкая обёртка над `board_pipeline/run-isolated.mjs`:

```sh
node ops/factory-run.mjs \
  --provider acp-devin --model swe-2-high \
  --policy policy.json --state state-dir \
  [--daemon] [--stop-on-idle] [--switch V] [--interval-ms N] \
  [--allow-live-pilot] [--recheck-rejected-handoff] [--dry-run]
```

### Матрица моделей (обязательна)

- Без явных `--provider` и `--model` — программный отказ.
- Если передан `--policy`, CLI-спека обязана совпадать с
  `policy.bb.provider` / `policy.bb.model`.
- Жёстко запрещены в любом сегменте `provider/model` (регистр не важен,
  включая вложенные `pi/a/b/...`): `gpt-6.1-terra`, `zcode` /
  `acp-zcode-start`, `glm` / `glm-*`.
- Проверка применяется к CLI-спеке, `policy.bb`, критику профиля
  (`profiles[route.checkProfile].review`) и `policy.arbiter`, плюс
  `opencodeGoPolicyViolation` и `retiredProviderViolation` из
  `board_pipeline/worker-selector.mjs`.

### NTFS `core.fileMode false` guard

Перед запуском worktree (`--worktree` или `policy.route.worktree`)
проверяется как валидный git worktree (`git rev-parse
--is-inside-work-tree`), затем локально выставляется
`git -C <worktree> config --local core.fileMode false` — checkout на
не-POSIX ФС не должен ломать учёт executable-бита.

### Чистый старт с Project Memory и Owner Decision Ledger

Пути берутся из `--memory-dir` / `--ledger-path` или из политики
(`projectMemory`, `decisionLedger`; строка или `{ path }`). Каждый заданный
путь проверяется каноничным (`lstat` без симлинка, `realpath`) и
обязан лежать строго вне worktree.

### Делегирование

После валидации вызывается ровно:

```
node board_pipeline/run-isolated.mjs --execute --policy <policy> --state <state> [passthrough]
```

`--dry-run` печатает валидированный JSON-план без вызова контроллера.

## Правило «Шивы»

Одна задача/веха = один свежий чистый контекст Лида. По закрытии итог
фиксируется в Board и Project Memory, тред останавливается; на следующую
задачу стартует новый чистый Лид строго по Board, Project Memory и Owner
Decision Ledger. Вся кодовая работа — только через принятый контроллер
(`run-isolated.mjs` / `daemon.mjs`); ручной `bb thread spawn` запрещён.
