# Darkfactory

**Darkfactory** — автономная фабрика разработки на **Board + Herdr (`--runtime hc`)**, без зависимости от BB. Board хранит очередь задач, зависимости и квитанции; `hc` (Herdr Core) исполняет изолированных воркеров (`devin`, `pi`, `agy`) в отдельных git-worktree; точный Git SHA и детерминированные гейты — L1-проверки в hardened Docker, Tamper Gate, Scope Fence, кросс-семейный L2 Critic + Arbiter — подтверждают результат до приёмки. Подтверждённый статус и граница проверенного — в [docs/STATUS.md](docs/STATUS.md).

## Архитектура

Три облачных узла:

| Узел | Роль |
|---|---|
| `cloud-brain` | Board (очередь, метки, квитанции) и Control Room — read-only агрегатор событий, телеметрии и FinOps |
| `cloud-hub` | CTO/Lead-контур и телеметрия: intake, спеки, вопросы владельцу, проектная память |
| `cloud-worker` | Spot VM с параллельными изолированными слотами `--runtime hc` и Docker-песочницами проверок |

Конвейер одной задачи: готовая карточка Board → изолированный слот и feature-worktree → воркер сдаёт точный чистый SHA → L1-гейты на чистом снимке в Docker → независимое кросс-семейное L2-ревью того же SHA → квитанция `verified`; для `finish=deployed` — отдельно допущенный выпуск. Crash-Resumable Worker возобновляет прерванную попытку по детерминированному runtime id без потери контекста исполнения.

## Быстрый старт и проверка

```bash
npm ci --ignore-scripts
npm test            # детерминированный регрессионный набор Darkfactory v1.0+;
                    # запускать на worker/dev-хосте с достаточной RAM,
                    # не на малом control-plane
npm run test:tla    # инварианты протокола контроллера (нужен TLC и TLA_TOOLS_JAR)
npm run doctor      # read-only диагностика хоста: рантаймы, обвязка, доступность
```

Постановка задачи на Board и запуск фабрики:

```bash
node ops/factory-enqueue.mjs \
  --board-url URL --channel CH --title T \
  --repo-id R --profile P --finish verified \
  --spec-digest HEX64 --policy-digest HEX64 \
  --label allowed_paths=path/one,path/two

node ops/factory-run.mjs \
  --provider P --model M --policy FILE --state DIR \
  --runtime hc --daemon
```

`factory-enqueue` фиксирует входы: `--spec-digest` связывает карточку с проверенной спекой, а метка `allowed_paths` задаёт Scope Fence — жёсткий список путей, которые воркер вправе менять. `factory-run` — единственный допустимый вход исполнения; `--runtime hc` поднимает portable-воркеров Herdr Core в изолированных слотах.

Нужны Node 22.18+ и rootless Docker с образами L1-профилей. Тестовый стенд создаёт временные данные: он не меняет установленную Board, не подключает рабочий маршрут и не запускает сетевые модельные прогоны. `doctor` — отдельная read-only сверка установленной среды, не команда установки.

## Карта репозитория

| Путь | Что это |
|---|---|
| [`board_pipeline/`](board_pipeline/) | Принятый контроллер (`run-isolated.mjs`, `daemon.mjs`), worker runtime `hc`, сдача по SHA, гейты приёмки (L1, Tamper Gate, Scope Fence), кросс-семейное L2-ревью, телеметрия |
| [`ops/control-room/`](ops/control-room/) | Control Room: read-only агрегатор (HTTP/SSE + веб-пульт), терминальный пульт `df-herd`, FinOps, net-health, origin-guard |
| [`ops/local/`](ops/local/) | Исходники операторской обвязки, systemd-шаблоны, cmd-guard-хук, инструкции по явному подключению |
| [`ops/l1-profiles/`](ops/l1-profiles/) | Доверенные Docker-образы L1-профилей проверок (`node`, `python-node`) |
| [`docs/`](docs/) | [Стандарт intake лида](docs/lead-intake.md), [план реализации](docs/implementation-plan.md), [статус и границы](docs/STATUS.md) |
| [`.agents/skills/`](.agents/skills/) | Проектные skills: feature-blueprint, owner-decisions, model-prompting-guides |
| [`specs/tla/`](specs/tla/) | TLA+-модель протокола контроллера, инварианты и пять парных мутантов |

Сборка репозитория не меняет живой режим: слоты, daemon, модельные проверки и право выпуска включаются отдельно по допуску владельца. Рабочие данные Board, токены, сессии исполнителей, профили браузера и build-артефакты остаются вне Git; в репозитории есть только [пример маршрутов](ops/local/routes.example.json).
