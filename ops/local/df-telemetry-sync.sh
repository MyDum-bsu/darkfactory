#!/usr/bin/env bash
# Merge in C-locale slot directory order; keep the first copy of each line.
set -euo pipefail
export LC_ALL=C
shopt -s nullglob

out=''
dry_run=false
while (($#)); do
  case $1 in
    --out) [[ -n ${2:-} && $2 != --* ]] || { echo 'expected --out PATH' >&2; exit 2; }
           out=$2; shift 2 ;;
    --dry-run) dry_run=true; shift ;;
    *) echo "usage: ${0##*/} [--out PATH] [--dry-run]" >&2; exit 2 ;;
  esac
done

root=${DF_STATE_ROOT:-$HOME/.local/state/darkfactory}
remote=${DF_TELEMETRY_REMOTE:-gdrive:darkfactory-telemetry/telemetry-worker-all.jsonl}
files=()
for slot in "$root"/daemon-state*; do
  if [[ -f $slot/telemetry.jsonl ]]; then files+=("$slot/telemetry.jsonl"); fi
done
if $dry_run; then
  printf 'Would merge %d slot logs to %s\n' "${#files[@]}" "${out:-$remote}"
elif [[ -z $out && ${#files[@]} == 0 ]]; then
  echo 'No slot logs; leaving remote unchanged.' >&2
else
  tmp=$(mktemp -- "${out:-${TMPDIR:-/tmp}/df-telemetry}.XXXXXX")
  trap 'rm -f -- "$tmp"' EXIT
  if ((${#files[@]})); then
    awk 'NF && !seen[$0]++' "${files[@]}" > "$tmp"
  fi
  if [[ -n $out ]]; then
    mv -fT -- "$tmp" "$out"
  else
    rclone copyto --checksum "$tmp" "$remote"
  fi
fi
