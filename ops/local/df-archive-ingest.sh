#!/usr/bin/env bash
# Ingest the last 24 hours of transcripts; overlapping scans are idempotent.
set -euo pipefail
umask 077

dry_run=false
case $#:${1-} in
  0:) ;;
  1:--dry-run) dry_run=true ;;
  *) echo "usage: ${0##*/} [--dry-run]" >&2; exit 2 ;;
esac

repo=${DF_REPO:-$HOME/projects/darkfactory}
db=${DF_ARCHIVE_DB:-$HOME/.local/state/darkfactory/session-archive.db}
host=${DF_ARCHIVE_HOST:-$(hostname)}
project=${DF_ARCHIVE_PROJECT:-darkfactory}
if ! $dry_run; then mkdir -p -- "$(dirname -- "$db")"; fi

scan() {
  local harness=$1 dir file
  local -a dirs
  IFS=: read -ra dirs <<< "$2"
  for dir in "${dirs[@]}"; do
    [[ -d $dir ]] || continue
    find "$dir" -type f -name '*.jsonl' -mtime -1 -print0 |
      while IFS= read -r -d '' file; do
        if $dry_run; then
          printf 'Would ingest %s %q\n' "$harness" "$file"
        elif ! node "$repo/ops/df-archive.mjs" ingest --db "$db" --harness "$harness" \
          --file "$file" --host "$host" --project "$project"; then
          printf 'Skipping failed %s transcript: %q\n' "$harness" "$file" >&2
        fi
      done
  done
}

# Explicitly empty directory lists disable a harness.
scan agy "${DF_ARCHIVE_AGY_DIRS-$HOME/.gemini/antigravity/brain}"
scan pi "${DF_ARCHIVE_PI_DIRS-$HOME/.pi/agent/sessions}"

if ! $dry_run && [[ ${DF_ARCHIVE_SKIP_EMBED:-0} != 1 ]]; then
  # Drain pending messages (including previous runs), but bound each scheduled run.
  max_batches=${DF_ARCHIVE_EMBED_MAX_BATCHES:-4}
  if [[ ! $max_batches =~ ^[0-9]+$ ]]; then
    echo 'Skipping embeddings: DF_ARCHIVE_EMBED_MAX_BATCHES must be a non-negative integer' >&2
    max_batches=0
  fi
  for ((batch=0; batch < 10#$max_batches; batch++)); do
    if ! result=$(node "$repo/ops/df-archive.mjs" embed --db "$db" --best-effort --json); then
      echo 'Stopping embeddings: embed command failed' >&2
      break
    fi
    # Continue only on confirmed progress. Bad JSON must not fail FTS ingest.
    if ! node -e '
      const { embedded, skipped } = JSON.parse(process.argv[1]);
      process.exitCode = Number.isInteger(embedded) && embedded > 0 && skipped !== true ? 0 : 1;
    ' -- "$result"; then
      break
    fi
  done
fi
