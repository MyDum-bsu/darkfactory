#!/usr/bin/env node
// VS-3 CLI-сводка по приватному JSONL-журналу телеметрии попыток.
// Читает файл журнала или каталог с telemetry.jsonl; печатает
// человекочитаемый отчёт (--json — машиночитаемый агрегат).
// Fail-open: недоступный файл — пустой отчёт, а не сбой.

import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { aggregateTelemetry, formatTelemetryReport, readTelemetryLines } from './telemetry.mjs';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    json: { type: 'boolean' },
    task: { type: 'string' },
    since: { type: 'string' },
    open: { type: 'boolean' },
    closed: { type: 'boolean' },
  },
});

if (!positionals.length) {
  console.error('Usage: node board_pipeline/telemetry-report.mjs <telemetry.jsonl|dir>... ' +
    '[--json] [--task ID] [--since ISO] [--open|--closed]');
  process.exitCode = 1;
} else {
  const files = [];
  for (const target of positionals) {
    const stats = await lstat(target).catch(() => null);
    files.push(stats?.isDirectory() ? join(target, 'telemetry.jsonl') : target);
  }
  const lines = [];
  for (const file of files) {
    lines.push(...await readTelemetryLines(file).catch(() => []));
  }
  const since = typeof values.since === 'string' && values.since ? Date.parse(values.since) : null;
  const open = values.open === true ? true : values.closed === true ? false : null;
  const aggregate = aggregateTelemetry(lines, {
    task: values.task ?? null,
    since: Number.isFinite(since) ? since : null,
    open,
  });
  if (values.json) console.log(JSON.stringify(aggregate, null, 2));
  else console.log(formatTelemetryReport(aggregate));
}
