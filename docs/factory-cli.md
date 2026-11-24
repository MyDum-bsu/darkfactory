# Фабрика: единый CLI Лида

Два тонких входа для оператора-Лида. Оба — только встроенные модули Node
и модули `board_pipeline/`, все проверки до любого эффекта, `--dry-run`
печатает план без вызова.

## Постановка задачи — `ops/factory-enqueue.mjs`

Безопасная постановка одной карточки на Board через
`vb --url URL tasks create CHANNEL TITLE --label k=v --json`.
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
Контрактные метки (`spec_digest`, `policy_digest`, `repo_id`,
`profile_id`, `finish`) резервированы: `--label` их не переопределяет.

**Дайджесты.** `--brief` → `spec_digest` = sha256 файла. `--policy` →
`policy_digest` считается ровно как закреплённый отпечаток контроллера
(`readOperatorInputs`): sha256 JSON-массива sha256-хэшей файлов маршрута
`[policyFile, brief, reviewPrompt, reviewGate, routes.json, ...skillPaths]`.
Только так метка карточки сходится с отпечатком приёмки — иначе seal
завершится `policy_digest_drift` после всех проверок.

**Проверки путей** до эффекта: `lstat` на конечном пути (симлинк — отказ),
сверка буквального и resolved пути с `--worktree` — вход внутри worktree
(включая через симлинк-предок `wt/link/...`) отклоняется до чтения файла.

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
  (`profiles[route.checkProfile].review`), `policy.arbiter` **и каждому
  кандидату `policy.routing.allowlist.{worker,critic,arbiter}`** —
  активный роутинг закрепляет кандидата скоркардом, поэтому запрет
  действует до запуска. Плюс `opencodeGoPolicyViolation` и
  `retiredProviderViolation` из `board_pipeline/worker-selector.mjs`.

### NTFS `core.fileMode false` guard

Worktree берётся из `policy.route.worktree`; `--worktree` может только
подтвердить тот же канонический путь — несовпадающий override отклоняется
(`worktree_mismatch`), иначе guard менял бы конфиг чужого репозитория.
До запуска проверяется `git rev-parse --is-inside-work-tree`, затем
локально `git -C <worktree> config --local core.fileMode false`.

### Чистый старт с Project Memory и Owner Decision Ledger

Проверяется тот путь, что реально использует контроллер:
`--ledger-path`/`--memory-dir` > `policy.decisionLedger`/`policy.projectMemory`
(строка или `{path}`/`{storeDir|dir|path}`) > `DF_DECISION_LEDGER_PATH`/
`DF_PROJECT_MEMORY_DIR`. CLI-флаг против закреплённого в политике пути —
`*_mismatch`, отказ. CLI-override без конфликта передаётся контроллеру
через соответствующий env. Каждый путь — абсолютный, каноничный (не
симлинк) и строго вне worktree как буквально, так и после `realpath` —
симлинк-предок `wt/link -> наружу` отсекается до запуска.

### Делегирование

После валидации запускается ровно:

```
node board_pipeline/run-isolated.mjs --execute --policy <policy> --state <state> [passthrough]
```

через `spawn` со `stdio:'inherit'` — вывод контроллера виден по мере
работы, буферизованный `execFile` убивал бы долгий демон по maxBuffer.
Путь контроллера и запускаемый бинарник флагами не переопределяются.
`--dry-run` печатает валидированный JSON-план без вызова; в план входят
только env-переопределения, унаследованное окружение не сериализуется.

## Правило «Шивы»

Одна задача/веха = один свежий чистый контекст Лида. По закрытии итог
фиксируется в Board и Project Memory, тред останавливается; на следующую
задачу стартует новый чистый Лид строго по Board, Project Memory и Owner
Decision Ledger. Вся кодовая работа — только через принятый контроллер
(`run-isolated.mjs` / `daemon.mjs`); ручной `bb thread spawn` запрещён.
