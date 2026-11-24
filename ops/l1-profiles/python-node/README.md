# L1-профиль `python-node`: оффлайн Python 3.12 + Node 22

Доверенный образ локальных проверок: Python 3.12 с `pytest`, `ruff`,
`PyYAML`, `sympy`, `numpy` в `/opt/l1-venv` плюс Node 22 (`node`, `npm`,
`npx`) из pinned-базы `node:22.23.2-bookworm-slim`.

## Сборка и pinning

```sh
docker build -t df-l1-python-node ops/l1-profiles/python-node
docker image inspect --format '{{.Id}}' df-l1-python-node
# => sha256:<64 hex> — pinned-идентификатор для policy.json
```

## Использование в policy.json

```json
{ "profiles": { "default": {
  "l1Profile": "python-node",
  "checks": [{ "image": "sha256:<64 hex>", "argv": ["pytest", "-q"],
    "cwd": ".", "timeoutMs": 120000 }] } } }
```

Запуск не-root `65534:65534`, `--network=none`, `--read-only`,
read-only `/candidate`, writable tmpfs `/tmp`.
