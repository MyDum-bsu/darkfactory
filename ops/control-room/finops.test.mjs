// FinOps provider: декларативный YAML, fail-open, symlink policy,
// расчёт стоимости worker VM и фильтрация небезопасных workspace links.

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createFinopsProvider, EXAMPLE_BUDGET_PATH } from './finops.mjs';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

const budgetYaml = `version: 1
currency: EUR
usd_to_eur: 0.5
monthly_budget_eur: 10
cloud_credits:
  - id: credit
    total_eur: 100
    remaining_eur: 90
compute_vms:
  - id: cloud-bb-worker
    machine_type: spot
    hourly_cost_usd: 0.10
    metered: true
compute_quotas:
  - id: colab_pro_plus
    unit: CU
    total_units: 1006.02
    used_units: 0
    utilization_pct: 0
    status: underutilized
workspace_links:
  safe:
    title: Safe
    url: https://example.ts.net/control
  evil:
    title: Evil
    url: javascript:alert(1)
`;

test('finops: example YAML загружается, содержит ресурсы и workspace map', async () => {
  const provider = createFinopsProvider({ budgetPath: EXAMPLE_BUDGET_PATH,
    now: new Date('2026-11-24T12:00:00Z') });
  const snap = await provider();
  assert.equal(snap.ok, true);
  assert.equal(snap.cloudCredits.some(c => c.id === 'gcp_welcome' && c.remainingEur === 269.10), true);
  assert.equal(snap.computeVms.some(v => v.id === 'cloud-bb-worker'), true);
  assert.equal(snap.computeQuotas.some(q => q.id === 'colab_pro_plus'), true);
  assert.equal(snap.aiSubscriptions.some(s => s.id === 'devin_pro'), true);
  assert.ok(snap.workspaceLinks.length >= 5);
  assert.equal(JSON.stringify(snap).includes('javascript:'), false);
});

test('finops: битый YAML fail-open и не роняет caller', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'finops-bad-'));
  try {
    const path = join(dir, 'budget.yaml');
    await writeFile(path, 'cloud_credits: [broken\n');
    const snap = await createFinopsProvider({ budgetPath: path })();
    assert.equal(snap.ok, false);
    assert.match(snap.error, /finops_budget_yaml_invalid/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('finops: symlink самого файла отклоняется, symlink родителя допускается', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'finops-link-'));
  try {
    const realDir = join(dir, 'real');
    const real = join(realDir, 'budget.yaml');
    await mkdir(realDir);
    await writeFile(real, budgetYaml);
    const fileLink = join(dir, 'file-link.yaml');
    await symlink(real, fileLink);
    const rejected = await createFinopsProvider({ budgetPath: fileLink })();
    assert.equal(rejected.ok, false);
    assert.match(rejected.error, /symlink_rejected/);

    const parentLink = join(dir, 'parent-link');
    await symlink(realDir, parentLink);
    const accepted = await createFinopsProvider({ budgetPath: join(parentLink, 'budget.yaml') })();
    assert.equal(accepted.ok, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('finops: estimatedMonthCostEur считается из worker usage minutes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'finops-usage-'));
  try {
    const budget = join(dir, 'budget.yaml');
    const usage = join(dir, 'cloud-worker-usage.json');
    const state = join(dir, 'cloud-worker-state.json');
    await writeFile(budget, budgetYaml);
    await writeFile(state, JSON.stringify({ status: 'running', updatedAt: Date.parse('2026-11-24T10:00:00Z') }));
    await writeFile(usage, JSON.stringify({
      runningMinutesToday: 60, runningMinutesMonth: 1200, wakesMonth: 3,
      updatedAt: '2026-11-24T10:00:00Z' }));
    const snap = await createFinopsProvider({ budgetPath: budget, workerUsagePath: usage, workerStatePath: state,
      now: new Date('2026-11-24T12:00:00Z') })();
    assert.equal(snap.ok, true);
    // 1200min = 20h × $0.10/h × 0.5 €/$ = €1.00.
    assert.equal(snap.estimatedMonthCostEur, 1);
    assert.equal(snap.totals.estimatedMonthCostEur, 1);
    assert.equal(snap.totals.runningHoursMonth, 20);
    const vm = snap.computeVms.find(v => v.id === 'cloud-bb-worker');
    assert.equal(vm.costMonthEur, 1);
    assert.equal(vm.wakesMonth, 3);
    assert.equal(vm.state, 'running');
    assert.equal(snap.creditRunway.days > 0, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('finops: underutilized Colab quota становится явным alert', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'finops-alert-'));
  try {
    const budget = join(dir, 'budget.yaml');
    await writeFile(budget, budgetYaml);
    const snap = await createFinopsProvider({ budgetPath: budget,
      now: new Date('2026-11-24T12:00:00Z') })();
    const quota = snap.computeQuotas.find(q => q.id === 'colab_pro_plus');
    assert.equal(quota.status, 'underutilized');
    assert.equal(snap.alerts.some(a => a.code === 'underutilized_resource' &&
      a.resourceId === 'colab_pro_plus'), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('finops: javascript: workspace link отбрасывается и виден как alert', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'finops-js-'));
  try {
    const budget = join(dir, 'budget.yaml');
    await writeFile(budget, budgetYaml);
    const snap = await createFinopsProvider({ budgetPath: budget })();
    assert.equal(snap.ok, true);
    assert.equal(snap.workspaceLinks.some(l => l.id === 'safe' && l.url === 'https://example.ts.net/control'), true);
    const evil = snap.workspaceLinks.find(l => l.id === 'evil');
    assert.equal(evil.url, null);
    assert.equal(JSON.stringify(snap.workspaceLinks).includes('javascript:'), false);
    assert.equal(snap.alerts.some(a => a.code === 'workspace_link_rejected'), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
