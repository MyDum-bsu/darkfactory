# Resource Steward — документация оператора (VS-3)

Автономный сторож диска и RAM: детерминированный Node-скрипт `board_pipeline/resource-steward.mjs`
без вызовов LLM на штатном ходе. LLM-агент Steward просыпается **только** через хук эскалации,
когда после уборки Тира 1 свободное место всё ещё ниже критического порога.

> **НЕ УСТАНАВЛИВАТЬ в живую систему во время испытаний фабрики.** Шаблоны юнитов ниже —
> для ручной установки владельцем после согласования. Проверка — только `--dry-run` и тесты.

## Что делает один тик

1. **Измерение.** Свободное место на `/` и `/media/mydum/Data` (`statfs`), `MemAvailable`
   из `/proc/meminfo`. Ошибка измерения одного монта — ошибка в журнале, а не ноль байт.
2. **Уборка Тира 1** — только если где-то **< 5 GiB**. Строго фиксированный allowlist:
   - Docker build cache: `docker builder prune -f`;
   - висячие образы: `docker image prune -f` (только dangling, ни `-a`, ни volumes);
   - просроченные `/tmp/df-*` и каталоги `/tmp/pytest-of-*` старше N дней (`--tmp-days`, дефолт 7);
   - содержимое кэшей pip (`$XDG_CACHE_HOME/pip`), uv (`$XDG_CACHE_HOME/uv`),
     npm (`~/.npm/_cacache`) — пофайлово старше N дней (`--cache-days`, дефолт 7).
3. **Повторное измерение.** Если после Тира 1 **< 2 GiB** → событие `alarm` в журнале и
   **ровно одна** эскалация за тик (по худшему монту) с одним вопросом владельцу.
4. **RAM.** Если `MemAvailable < 1.5 GiB` → стоп **только однозначно idle** BB-тредов:
   `status === 'idle'`, без закрепления (`pinnedAt`), без очереди, без интеракции и фоновой
   активности. Активные, закреплённые, свой тред (`BB_THREAD_ID`) и всё двусмысленное —
   не останавливаются, причина пишется в журнал.

## Чего сторож не делает никогда

- Не трогает worktree, `.bb`, проекты и любые пользовательские файлы — путь вне allowlist
  не классифицируется как удаляемый (классификатор отказывает по причине и пишет отказ в журнал).
- Не удаляет символические ссылки и специальные файлы (fifo/socket/device).
- Не запускает LLM сам: единственная точка пробуждения — хук эскалации, и только по тревоге.

## Журнал

JSONL, по одной записи на событие; каталог `0700`, файл `0600`, fsync после каждой записи.
По умолчанию — вне репозитория: `~/.local/state/resource-steward/journal.jsonl`.
События: `tick_start`, `measurement`, `tier1_start/tier1_done`, `tmp_delete/tmp_refuse`,
`cache_prune/cache_refuse`, `docker/docker_error`, `alarm`, `escalation/escalation_skipped`,
`ram_measurement`, `ram_low`, `ram_plan`, `ram_stop/ram_stop_error`, `tick_end`.

## Проверка без установки

```sh
node board_pipeline/resource-steward.mjs --dry-run
```

`--dry-run` не производит ни одного эффекта: ни удаления, ни docker prune, ни остановки
тредов, ни вызова хука, ни записи в журнал — только план в stdout. Код выхода `0` — штатно,
`2` — тревога (планируемая), `1` — ошибка.

## Установка (вручную, по отдельному решению владельца)

```sh
mkdir -p ~/.local/state/resource-steward
# bb должен быть стабильным путём в PATH (AppImage монтируется непостоянно):
ln -sf "$(command -v bb)" ~/.local/bin/bb
cp ops/local/resource-steward.service ops/local/resource-steward.timer \
   ~/.config/systemd/user/
edit ~/.config/systemd/user/resource-steward.service   # пути к репозиторию и node
systemctl --user daemon-reload
systemctl --user enable --now resource-steward.timer
```

Проверка работы: `systemctl --user list-timers resource-steward.timer`,
`journalctl --user -u resource-steward.service`, разовый прогон:
`systemctl --user start resource-steward.service`.

**Node:** репозиторию нужен node ≥ 22.18 (см. `engines` в package.json). Системный
`/usr/bin/node` на этой машине v18 — в шаблоне юнита указан node из nvm; сверь путь
с `command -v node` и `node --version` перед установкой.

Удаление: `systemctl --user disable --now resource-steward.timer` и удалить юниты из
`~/.config/systemd/user/`.

## Флаги CLI

| Флаг | Значение |
|---|---|
| `--dry-run` | план без эффектов (см. выше) |
| `--journal <path>` | путь JSONL-журнала (по умолчанию `~/.local/state/resource-steward/journal.jsonl`) |
| `--mount <path>` | дополнительный/заменяющий монт (повторяемый; по умолчанию `/` и `/media/mydum/Data`) |
| `--tmp-days <n>` | возраст просрочки `/tmp/df-*` (дефолт 7) |
| `--cache-days <n>` | возраст просрочки кэшей pip/npm/uv (дефолт 7) |
| `--escalate-cmd <exec>` | хук эскалации: payload JSON на stdin, без shell, таймаут 120 с |
| `--no-docker` | не вызывать docker prune (например, на машине без docker) |
| `--bb <path>` | путь к bb CLI (дефолт `bb` из PATH) |

## Хук эскалации LLM

`--escalate-cmd` — путь к исполняемому файлу; сторож передаёт ему JSON на stdin:

```json
{
  "reason": "disk_alarm",
  "mount": "/",
  "thresholdGiB": 2,
  "availableGiB": 1.4,
  "afterTier1": true,
  "journalPath": "/home/you/.local/state/resource-steward/journal.jsonl",
  "question": "Свободное место на «/» после уборки Тира 1 ниже 2 GiB. Запустить read-only расследование LLM-агента Steward для выявления нетипичного потребителя?"
}
```

Хук сам решает, как разбудить агента (сообщение на Board, письмо владельцу и т.п.) —
сторож не содержит токенов и не знает о каналах. Без `--escalate-cmd` тревога честно
пишется в журнал с событием `escalation_skipped` (reason `no_hook_configured`).
Расследование агента — строго read-only: потребитель ищется, но ничего не удаляется
вне согласованного allowlist без нового решения владельца.

## Границы

- Один сторож-процесс на тик; юнит — `oneshot`, таймер не запускает второй экземпляр параллельно.
- Реальные данные и журнал — вне репозитория; в Git попадают только шаблон юнитов и эта инструкция.
- Никаких systemd-установок из тестов: тесты работают в собственных песочницах (`mkdtemp`).
