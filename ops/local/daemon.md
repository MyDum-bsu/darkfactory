# Фоновый контроллер Board (daemon)

`run-isolated.mjs --daemon` переводит разовый прогон контроллера в управляемый
фоновый сервис: опрос очереди с интервалом, ноль LLM-вызовов на пустых тиках
(тик — тот же `advanceWithProjection`, внешние эффекты идут только по WAL-фазам),
дисковый preflight >= 8 GiB перед каждым тиком, kill-switch и корректный стоп.

## Ручной запуск (тот же контур, что и run-isolated)

```sh
node board_pipeline/run-isolated.mjs --execute --daemon \
  --policy /path/policy.json --state /private/state/dir \
  --interval-ms 15000 --switch /private/switch/dir/daemon.switch
```

- `--interval-ms` — период опроса (мин. 250 мс, по умолчанию 3500).
- `--switch` — файл kill-switch в приватном каталоге (владелец=текущий uid,
  каталог и файл без групповых/прочих прав). Содержимое `run` — работа;
  любое другое содержимое или отсутствие файла — стоп после текущего тика.
  Для pilot-маршрута по умолчанию берётся `pilot.killSwitch`; без switch
  (ни флага, ни pilot.killSwitch) демон отказывается стартовать.
  Старт при уже остановленном switch — не ошибка: процесс пишет
  `daemon_stop`/`kill_switch` в журнал и завершается с кодом 0.
- SIGTERM/SIGINT — graceful shutdown: активный тик завершается, слот не
  бросается в неопределённой фазе, журнал дописывается `daemon_stop`.
- Очередной маршрут: `done`/`hold` освобождают слот для следующей карточки,
  `uncertain`/`lease_lost` останавливают демон с кодом 1. Маршрут с
  закреплённой карточкой завершается на любом терминале.

Карта кодов выхода:

| Исход | Код | Restart=on-failure |
| --- | --- | --- |
| SIGTERM/SIGINT (`systemctl stop`) | 0 | нет |
| kill-switch `stop`/удалён (в т.ч. уже на старте) | 0 | нет |
| Очередь: `done`/`hold` — слот освобождается, опрос продолжается | — | — |
| Очередь: `release_ready` без releasePort | 0 | нет |
| Очередь: `uncertain`/`lease_lost` | 1 | да |
| Закреплённая карточка: `done` | 0 | нет |
| Закреплённая карточка: `hold`/`uncertain`/`lease_lost` | 1 | да |
| Ошибка запуска (политика, дисковый preflight, нет switch) | 1 | да |
- `--stop-on-idle` в режиме `--daemon` игнорируется: холостой опрос —
  штатная работа фонового сервиса.

## Журнал и ротация

`$STATE/daemon.jsonl` — JSONL-журнал тиков и остановов (`RotatingJournal`):
при превышении 4 MiB сдвигается в `daemon.N.jsonl`, хранятся 5 поколений.
stdout/stderr процесса — в journald (`StandardOutput=journal`), размер
ограничен `SystemMaxUse` пользовательского journald.

## systemd user-юнит

Шаблон: `ops/local/darkfactory-daemon.service.in`. Установка — только явно,
оператором:

```sh
mkdir -p ~/.config/systemd/user "$STATE" "$(dirname "$SWITCH")"
printf 'run\n' > "$SWITCH" && chmod 600 "$SWITCH" && chmod 700 "$(dirname "$SWITCH")"
sed -e "s|@NODE@|$(command -v node)|" -e "s|@REPO@|$PWD|" \
    -e "s|@POLICY@|$POLICY|" -e "s|@STATE@|$STATE|" \
    -e "s|@SWITCH@|$SWITCH|" \
  ops/local/darkfactory-daemon.service.in > ~/.config/systemd/user/darkfactory-daemon.service
systemctl --user daemon-reload
systemctl --user enable --now darkfactory-daemon
```

Поведение юнита:

- `Restart=on-failure` + `RestartSec=15` — рестарт только после сбоя
  (код 1: `uncertain`/`lease_lost`, не-`done` терминал закреплённой
  карточки, ошибка запуска). Корректные завершения (SIGTERM от
  `systemctl stop`, kill-switch `stop`, `done`, `release_ready`) дают
  код 0 и рестарт-лупа не создают — см. карту кодов выше.
- `TimeoutStopSec=120` — бюджет на завершение активного тика при стопе;
  по его истечении systemd шлёт SIGKILL.
- `MemoryMax=2G`, `NoNewPrivileges=true` — ограничения сервиса.

Управление: `systemctl --user stop darkfactory-daemon` (graceful) или
`printf 'stop\n' > "$SWITCH"` (операторский стоп без systemd). Логи:
`journalctl --user -u darkfactory-daemon -f`.

Во время тестов и разработки юнит не устанавливается — живой runtime не трогаем.
