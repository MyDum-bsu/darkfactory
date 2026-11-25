#!/usr/bin/env bash
# Read-only host telemetry collector for the Darkfactory fleet monitor.
# Prints one JSON object, or atomically writes it with --out <path>.
set -euo pipefail
LC_ALL=C
export LC_ALL

usage() {
  printf 'usage: %s [--out PATH]\n' "${0##*/}" >&2
}

out=''
while (($#)); do
  case "$1" in
    --out)
      if (($# < 2)) || [[ -z "$2" ]]; then
        usage
        exit 2
      fi
      out="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage
      exit 2
      ;;
  esac
done

host="$(hostname)"
ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
uptime_sec="$(awk '{ printf "%.0f", $1 }' /proc/uptime)"
cpu_cores="$(nproc)"
load1m="$(awk '{ print $1 }' /proc/loadavg)"

read -r mem_total_mb mem_used_mb mem_pct <<< "$(awk '
  /MemTotal:/ { total = $2 }
  /MemAvailable:/ { available = $2 }
  END {
    used = total - available
    pct = total > 0 ? used * 100 / total : 0
    printf "%.0f %.0f %.1f", total / 1024, used / 1024, pct
  }
' /proc/meminfo)"

read -r disk_total_gb disk_used_gb disk_pct <<< "$(df -P / | awk '
  NR == 2 {
    pct = $5
    sub(/%$/, "", pct)
    printf "%.1f %.1f %.1f", $2 / 1048576, $3 / 1048576, pct
  }
')"

json_escape() {
  # Hostnames are ordinarily ASCII and control-free; still escape the JSON
  # metacharacters so the emitted object remains valid for unusual names.
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

host_json="$(json_escape "$host")"
json="$(printf '{"host":"%s","ts":"%s","uptimeSec":%s,"cpuCores":%s,"load1m":%s,"memTotalMb":%s,"memUsedMb":%s,"memPct":%s,"diskTotalGb":%s,"diskUsedGb":%s,"diskPct":%s}' \
  "$host_json" "$ts" "$uptime_sec" "$cpu_cores" "$load1m" \
  "$mem_total_mb" "$mem_used_mb" "$mem_pct" \
  "$disk_total_gb" "$disk_used_gb" "$disk_pct")"

if [[ -z "$out" ]]; then
  printf '%s\n' "$json"
  exit 0
fi

out_dir="$(dirname -- "$out")"
out_base="$(basename -- "$out")"
tmp="$(mktemp "${out_dir}/.${out_base}.tmp.XXXXXX")"
if ! printf '%s\n' "$json" > "$tmp"; then
  rm -f -- "$tmp"
  exit 1
fi
if ! mv -f -- "$tmp" "$out"; then
  rm -f -- "$tmp"
  exit 1
fi
