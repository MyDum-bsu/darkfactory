#!/usr/bin/env bash
set -euo pipefail
systemctl --user start vercel-board.service
url='http://127.0.0.1:44100/tasks'
for _ in $(seq 1 30); do
  if curl -fsS --max-time 1 -o /dev/null "$url" 2>/dev/null; then
    export CHROME_DEVEL_SANDBOX=/opt/google/chrome/chrome-sandbox
    exec "$HOME/.local/share/vercel-board/electron-runtime/electron" "$HOME/.local/share/vercel-board/electron-app"
  fi
  sleep .5
done
printf 'Vercel Board did not start on 127.0.0.1:44100\n' >&2
exit 1
