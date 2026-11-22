#!/usr/bin/env node
// VS-3 CLI-отчёт скоркарда моделей по приватному JSONL-журналу телеметрии.
// Читает файл журнала или каталог с telemetry.jsonl; печатает таблицу
// (role × domain × size) для владельца и CTO. --json — машиночитаемый
// агрегат. Fail-open: недоступный файл — пустой отчёт, а не сбой.

import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { readTelemetryLines } from './telemetry.mjs';
import {
  aggregateScorecard,
  formatScorecardReport,
  normalizeDomain,
  normalizeSize,
  rankCandidates,
  DEFAULT_MIN_OBSERVATIONS,
} from './model-scorecard.mjs';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    json: { type: 'boolean' },
    'no-seed': { type: 'boolean' },
    role: { type: 'string' },
    domain: { type: 'string' },
    size: { type: 'string' },
    'min-observations': { type: 'string' },
  },
});

if (!positionals.length) {
  console.error('Usage: node board_pipeline/model-scorecard-report.mjs <telemetry.jsonl|dir>... ' +
    '[--json] [--no-seed] [--role worker|critic|arbiter] [--domain D] [--size S|M|L] ' +
    '[--min-observations N]');
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
  const scorecard = aggregateScorecard(lines, { seed: values['no-seed'] ? [] : undefined });
  if (values.json) {
    console.log(JSON.stringify(scorecard, null, 2));
  } else {
    console.log(formatScorecardReport(scorecard));
    if (typeof values.role === 'string' && values.role) {
      const min = Number.parseInt(values['min-observations'] ?? '', 10);
      const normDomain = normalizeDomain(values.domain);
      const normSize = normalizeSize(values.size);
      const ranked = rankCandidates(scorecard, {
        role: values.role,
        domain: normDomain,
        size: normSize,
        minObservations: Number.isSafeInteger(min) && min >= 1 ? min : DEFAULT_MIN_OBSERVATIONS,
      });
      console.log(`Ranked ${values.role} (${normDomain}/${normSize}):`,
        ranked.length ? ranked.map(c => `${c.model.provider}/${c.model.model}`).join(', ')
          : 'no proven candidates');
    }
  }
}
