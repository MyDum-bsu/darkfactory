#!/usr/bin/env bash
# df-watch-task.sh — multi-slot live monitor for the Darkfactory hc runtime.
#
# Scans the daemon state root for `daemon-state*/attempt.json` snapshots and
# `daemon*.log` controller logs across slots S1..S4, then streams the live
# worker session for each active attempt via `hc read <threadId>`.
#
# Read-only: the script never writes into state directories, never signals
# workers, and never mutates the board. JSON extraction uses the host Node
# runtime (Node >= 22 is a factory host requirement), so no extra tooling is
# needed beyond bash, coreutils and the hc CLI.
#
# Usage:
#   df-watch-task.sh [--state-root DIR] [--slot N] [--lines N]
#                    [--interval SEC] [--once|--watch] [--no-stream]
#
# Options:
#   --state-root DIR   daemon state root (default: $DF_STATE_ROOT or
#                      ${XDG_STATE_HOME:-~/.local/state}/darkfactory)
#   --slot N           show only slot N (1..4); default shows all slots
#   --lines N          lines of log / live output per slot (default: 20)
#   --interval SEC     refresh delay in watch mode (default: 5)
#   --once             render once and exit (default)
#   --watch            re-render in a loop, clearing the screen each pass
#   --no-stream        skip `hc read` live streaming (state + logs only)

set -euo pipefail
LC_ALL=C
export LC_ALL

state_root=''
slot_filter=''
lines=20
interval=5
watch_mode=false
stream=true

usage() {
  sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//' >&2
}

while (($#)); do
  case "$1" in
    --state-root)
      if (($# < 2)) || [[ -z "$2" ]]; then usage; exit 2; fi
      state_root="$2"; shift 2 ;;
    --slot)
      if (($# < 2)) || [[ -z "$2" ]]; then usage; exit 2; fi
      slot_filter="$2"; shift 2 ;;
    --lines)
      if (($# < 2)) || [[ -z "$2" ]]; then usage; exit 2; fi
      lines="$2"; shift 2 ;;
    --interval)
      if (($# < 2)) || [[ -z "$2" ]]; then usage; exit 2; fi
      interval="$2"; shift 2 ;;
    --once) watch_mode=false; shift ;;
    --watch) watch_mode=true; shift ;;
    --no-stream) stream=false; shift ;;
    # Bare `exit` propagates the status of the usage printout itself.
    -h|--help) usage; exit ;;
    *) usage; exit 2 ;;
  esac
done

if [[ -z "$state_root" ]]; then
  if [[ -n "${DF_STATE_ROOT:-}" ]]; then
    state_root="$DF_STATE_ROOT"
  else
    state_root="${XDG_STATE_HOME:-$HOME/.local/state}/darkfactory"
  fi
fi

if [[ -n "$slot_filter" && ! "$slot_filter" =~ ^[1-4]$ ]]; then
  printf 'df-watch-task: --slot must be 1..4, got %s\n' "$slot_filter" >&2
  exit 2
fi

# --lines and --interval are interpolated into tail/sleep invocations, so
# they must be plain positive integers: anything else is a usage error
# (exit 2) instead of a half-broken render loop.
if [[ ! "$lines" =~ ^0*[1-9][0-9]*$ ]]; then
  printf 'df-watch-task: --lines must be a positive integer >= 1, got %s\n' "$lines" >&2
  exit 2
fi
if [[ ! "$interval" =~ ^0*[1-9][0-9]*$ ]]; then
  printf 'df-watch-task: --interval must be a positive integer >= 1, got %s\n' "$interval" >&2
  exit 2
fi

# Extract selected fields from an attempt.json snapshot. Prints exactly six
# lines in fixed order: task_id, attempt_id, epoch, phase, thread_id,
# worktree. Missing keys yield empty lines. Values are machine-generated ids
# and paths (single-line by construction); embedded newlines are flattened
# defensively so the line protocol cannot shift.
read_attempt_fields() {
  node --input-type=module -e '
    import { readFile } from "node:fs/promises";
    const file = process.argv[1];
    let parsed = null;
    try { parsed = JSON.parse(await readFile(file, "utf8")); } catch {}
    const object = parsed !== null && typeof parsed === "object" ? parsed : {};
    const pick = (...keys) => {
      for (const key of keys) {
        const value = object[key];
        if (typeof value === "string" && value) return value;
        if (typeof value === "number" && Number.isFinite(value)) return String(value);
      }
      return "";
    };
    const flat = value => value.replace(/[\r\n]+/g, " ");
    const fields = [
      pick("task_id", "taskId"),
      pick("attempt_id", "attemptId"),
      pick("epoch"),
      pick("phase", "status", "state"),
      pick("thread_id", "threadId", "worker_thread_id", "hc_thread_id", "runtime_id", "runtimeId"),
      pick("worktree", "cwd"),
    ];
    process.stdout.write(fields.map(flat).join("\n") + "\n");
  ' "$1" 2>/dev/null
}

# Slot digit carried by a file or directory name; empty when absent.
# Only the dedicated slot suffix counts: `-s<N>$` or `slot-?<N>$` on the
# extensionless stem (so daemon-slot2.log and daemon-state-slot3 both
# resolve). Digits anywhere else — dates, pids, serial numbers embedded in
# the middle of a rotated log name — must NOT steer slot assignment.
slot_digit() {
  local name stem digit=''
  name="$(basename -- "$1")"
  stem="${name%.log}"
  if [[ "$stem" =~ -s([0-9]+)$ ]]; then
    digit="${BASH_REMATCH[1]}"
  elif [[ "$stem" =~ slot-?([0-9]+)$ ]]; then
    digit="${BASH_REMATCH[1]}"
  fi
  printf '%s' "$digit"
}

# Strip terminal control sequences from untrusted stream output before it
# is printed: CSI sequences (ESC [ ... final), OSC sequences (ESC ] ...
# terminated by BEL or ST), remaining one-shot ESC sequences, and C0
# control bytes except tab. Without this a worker session could redraw or
# inject into the operator's terminal.
strip_control() {
  sed -e 's/\x1b\[[0-?]*[ -/]*[@-~]//g' \
      -e 's/\x1b\][^\x07\x1b]*\(\x07\|\x1b\\\)\?//g' \
      -e 's/\x1b[@-Z\\-_]//g' \
      -e 's/[\x00-\x08\x0b-\x1f\x7f]//g'
}

print_rule() {
  printf '%s\n' '------------------------------------------------------------'
}

render_once() {
  local found=false slot digit dir attempt log
  for slot in 1 2 3 4; do
    if [[ -n "$slot_filter" && "$slot" != "$slot_filter" ]]; then continue; fi
    print_rule
    printf 'S%s  (state root: %s)\n' "$slot" "$state_root"
    print_rule

    # Locate the newest attempt.json across daemon-state* directories whose
    # name carries this slot digit. A digit-less daemon-state directory is
    # the legacy single-writer layout and belongs to S1.
    attempt=''
    for dir in "$state_root"/daemon-state*/; do
      [[ -d "$dir" ]] || continue
      digit="$(slot_digit "$dir")"
      if [[ -z "$digit" ]]; then digit=1; fi
      if [[ "$digit" != "$slot" ]]; then continue; fi
      if [[ -f "${dir}attempt.json" ]]; then
        if [[ -z "$attempt" || "${dir}attempt.json" -nt "$attempt" ]]; then
          attempt="${dir}attempt.json"
        fi
      fi
    done

    if [[ -z "$attempt" ]]; then
      printf '  no daemon-state*/attempt.json for this slot\n'
    else
      found=true
      # mapfile yields an empty array (status zero) when the extractor
      # produced nothing, so missing fields degrade to empty strings via
      # the `:-` default instead of masking a failure.
      local -a fields=()
      mapfile -t fields < <(read_attempt_fields "$attempt")
      local task_id="${fields[0]:-}" attempt_id="${fields[1]:-}" \
        epoch="${fields[2]:-}" phase="${fields[3]:-}" \
        thread_id="${fields[4]:-}" worktree="${fields[5]:-}"
      printf '  attempt:  %s\n' "$attempt"
      printf '  task:     %s\n' "${task_id:-—}"
      printf '  phase:    %s\n' "${phase:-—}"
      printf '  thread:   %s\n' "${thread_id:-—}"
      printf '  worktree: %s\n' "${worktree:-—}"

      if [[ "$stream" == true && -n "$thread_id" ]]; then
        printf '%s\n' '  --- live session (hc read) ---'
        # The thread id is machine-generated but still untrusted input to a
        # shell pipeline: whitelist the id alphabet and pass it after `--`
        # so a leading dash can never become an hc option.
        if [[ ! "$thread_id" =~ ^[A-Za-z0-9._:-]+$ ]]; then
          printf '  (invalid thread id — stream skipped)\n'
        elif command -v hc >/dev/null 2>&1; then
          timeout 10 hc read -- "$thread_id" 2>&1 | strip_control | tail -n "$lines" | sed 's/^/  /' || \
            printf '  (hc read unavailable or timed out)\n'
        else
          printf '  (hc CLI not found in PATH)\n'
        fi
      fi
    fi

    # Newest controller log whose name carries this slot digit (digit-less
    # daemon.log belongs to S1, same legacy rule as above).
    log=''
    local candidate
    for candidate in "$state_root"/daemon*.log; do
      [[ -f "$candidate" ]] || continue
      digit="$(slot_digit "$candidate")"
      if [[ -z "$digit" ]]; then digit=1; fi
      if [[ "$digit" != "$slot" ]]; then continue; fi
      if [[ -z "$log" || "$candidate" -nt "$log" ]]; then log="$candidate"; fi
    done
    if [[ -n "$log" ]]; then
      printf '%s\n' "  --- controller log: ${log##*/} (tail $lines) ---"
      if ! tail -n "$lines" -- "$log" 2>/dev/null | sed 's/^/  /'; then
        printf '  (log unreadable)\n'
      fi
    fi
    printf '\n'
  done
  if [[ "$found" == false && -n "$slot_filter" ]]; then
    printf 'df-watch-task: slot S%s has no active attempt snapshot\n' "$slot_filter" >&2
  fi
}

if [[ "$watch_mode" == true ]]; then
  while true; do
    clear 2>/dev/null || printf '\033[2J\033[H'
    printf 'df-watch-task — %s (refresh %ss, Ctrl-C to exit)\n\n' \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$interval"
    render_once
    sleep "$interval"
  done
else
  render_once
fi
