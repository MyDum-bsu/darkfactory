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
  любое другое содержимое или отсутствие файла — немедленный стоп после
  текущего тика. Для pilot-маршрута по умолчанию берётся `pilot.killSwitch`.
- SIGTERM/SIGINT — graceful shutdown: активный тик завершается, слот не
  бросается в неопределённой фазе, журнал дописывается `daemon_stop`.
- Очередной маршрут: `done`/`hold` освобождают слот для следующей карточки,
  `uncertain`/`lease_lost` останавливают демон с кодом 1. Маршрут с
  закреплённой карточкой завершается на любом терминале.

## Журнал и ротация

`$STATE/daemon.jsonl` — JSONL-журнал тиков и остановов (`RotatingJournal`):
при превышении 4 MiB сдвигается в `daemon.N.jsonl`, хранятся 5 поколений.
stdout/stderr сервиса — через journald/append-файлы юнита.

## systemd user-юнит

Шаблон: `ops/local/darkfactory-daemon.service.in`. Установка — только явно,
оператором:

```sh
mkdir -p ~/.config/systemd/user "$STATE" "$(dirname "$SWITCH")" "$LOGDIR"
printf 'run\n' > "$SWITCH" && chmod 600 "$SWITCH" && chmod 700 "$(dirname "$SWITCH")"
sed -e "s|@NODE@|$(command -v node)|" -e "s|@REPO@|$PWD|" \
    -e "s|@POLICY@|$POLICY|" -e "s|@STATE@|$STATE|" \
    -e "s|@SWITCH@|$SWITCH|" -e "s|@LOGDIR@|$LOGDIR|" \
  ops/local/darkfactory-daemon.service.in > ~/.config/systemd/user/darkfactory-daemon.service
systemctl --user daemon-reload
systemctl --user enable --now darkfactory-daemon
```

Управление: `systemctl --user stop darkfactory-daemon` (graceful) или
`printf 'stop\n' > "$SWITCH"` (операторский стоп без systemd). Логи:
`journalctl --user -u darkfactory-daemon -f`.

Во время тестов и разработки юнит не устанавливается — живой runtime не трогаем.
