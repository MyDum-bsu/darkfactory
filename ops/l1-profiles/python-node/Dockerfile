# Доверенный оффлайн L1-образ: Python 3.12 + Node 22.
# Сборка локальная, без сети на этапе запуска: контроллер поднимает
# контейнер со строгим --network=none, --read-only, --cap-drop=ALL,
# --security-opt=no-new-privileges, --user=65534:65534, read-only
# /candidate и writable tmpfs /tmp.
FROM node:22.23.2-bookworm-slim AS node_base

FROM python:3.12-slim-bookworm

# Бинарники и модули Node 22 из pinned-базы: node, npm и npx в /usr/local.
COPY --from=node_base /usr/local/bin/node /usr/local/bin/node
COPY --from=node_base /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

# Инструменты проверки — в отдельный venv, доступный не-root пользователю.
COPY requirements.txt /tmp/l1-requirements.txt
RUN python -m venv /opt/l1-venv \
    && /opt/l1-venv/bin/pip install --no-cache-dir -r /tmp/l1-requirements.txt \
    && rm /tmp/l1-requirements.txt \
    && chmod -R a+rX /opt/l1-venv

# Кэши только в tmpfs /tmp: корневая ФС контейнера read-only.
ENV PATH="/opt/l1-venv/bin:/usr/local/bin:/usr/bin:/bin" \
    PYTHONDONTWRITEBYTECODE=1 \
    RUFF_CACHE_DIR=/tmp/.ruff_cache \
    PYTEST_ADDOPTS="-o cache_dir=/tmp/.pytest_cache"

USER 65534:65534
WORKDIR /candidate
