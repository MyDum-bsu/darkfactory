#!/usr/bin/env bash
set -euo pipefail
base="$(cd "$(dirname -- "$0")" && pwd)"
root="$HOME/.bb/plugins/environment-git-worktree/host-data/worktrees"
for arg in "$@"; do
  case "$arg" in
    --new-environment|--new-environment=*|--environment|--environment=*|--environment-provider|--environment-provider=*|--machine|--machine=*|--host|--host=*|--new-machine|--new-machine=*)
      echo "This path only creates local BB worktrees through the disk gate: $arg" >&2
      exit 2
      ;;
  esac
done
node "$base/check-workspace-space.mjs" worktree "$root" >&2
exec bb thread spawn --machine host_h4xuevuhm4 --new-environment worktree "$@"
