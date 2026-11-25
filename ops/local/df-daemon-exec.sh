#!/usr/bin/env bash
set -euo pipefail

CONFIG_PATH='/api/v1/system/config'

if (($# == 0)); then
  echo 'df-daemon-exec: usage: df-daemon-exec.sh COMMAND [ARG...]' >&2
  exit 64
fi

if ! command -v curl >/dev/null 2>&1; then
  echo 'df-daemon-exec: curl is required to verify the live BB daemon endpoint' >&2
  exit 69
fi

config_ok() {
  local base="${1%/}"
  local code
  [[ -n "$base" ]] || return 1
  code=$(curl -sS -o /dev/null -w '%{http_code}' --connect-timeout 1 --max-time 2 \
    "$base$CONFIG_PATH" 2>/dev/null) || return 1
  [[ "$code" == '200' ]]
}

pid_is_bb_host_daemon() {
  local pid="$1"
  local cmdline
  [[ -r "/proc/$pid/cmdline" ]] || return 1
  cmdline=$(tr '\0' ' ' < "/proc/$pid/cmdline") || return 1
  [[ "$cmdline" == *'bb-app'*'host-daemon'* ]]
}

bb_host_daemon_ports() {
  if command -v ss >/dev/null 2>&1; then
    ss -ltnpH 2>/dev/null | while IFS= read -r line; do
      [[ "$line" =~ 127\.0\.0\.1:([0-9]+) ]] || continue
      local port="${BASH_REMATCH[1]}"
      [[ "$line" =~ pid=([0-9]+) ]] || continue
      local pid="${BASH_REMATCH[1]}"
      if pid_is_bb_host_daemon "$pid"; then
        printf '%s\n' "$port"
      fi
    done
  elif command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | while IFS= read -r line; do
      [[ "$line" =~ ^[^[:space:]]+[[:space:]]+([0-9]+) ]] || continue
      local pid="${BASH_REMATCH[1]}"
      [[ "$line" =~ 127\.0\.0\.1:([0-9]+) ]] || continue
      local port="${BASH_REMATCH[1]}"
      if pid_is_bb_host_daemon "$pid"; then
        printf '%s\n' "$port"
      fi
    done
  fi
}

if [[ -n "${BB_SERVER_URL:-}" ]] && config_ok "$BB_SERVER_URL"; then
  export BB_SERVER_URL
  exec "$@"
fi

while IFS= read -r port; do
  candidate="http://127.0.0.1:$port"
  if config_ok "$candidate"; then
    export BB_SERVER_URL="$candidate"
    exec "$@"
  fi
done < <(bb_host_daemon_ports | sort -n -u)

echo 'df-daemon-exec: no live bb-app host-daemon listening on 127.0.0.1 returned HTTP 200 for /api/v1/system/config' >&2
exit 1
