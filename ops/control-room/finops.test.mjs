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


test('finops: user config broken symlink не откатывается тихо на example', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'finops-user-link-'));
  const previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = dir;
  try {
    const configDir = join(dir, 'darkfactory');
    await mkdir(configDir, { recursive: true });
    await symlink(join(dir, 'missing-target.yaml'), join(configDir, 'resources-budget.yaml'));
    const snap = await createFinopsProvider()();
    assert.equal(snap.ok, false);
    assert.match(snap.error, /finops_budget_symlink_rejected/);
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test('finops: YAML ограничен 256 KiB и alias resolution disabled', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'finops-limits-'));
  try {
    const large = join(dir, 'large.yaml');
    await writeFile(large, `#${'x'.repeat(257 * 1024)}\nversion: 1\n`);
    const largeSnap = await createFinopsProvider({ budgetPath: large })();
    assert.equal(largeSnap.ok, false);
    assert.match(largeSnap.error, /finops_budget_too_large/);

    const aliased = join(dir, 'aliased.yaml');
    await writeFile(aliased, 'version: 1\nbase: &base\n  x: 1\ncloud_credits:\n  - <<: *base\n');
    const aliasSnap = await createFinopsProvider({ budgetPath: aliased })();
    assert.equal(aliasSnap.ok, false);
    assert.match(aliasSnap.error, /finops_budget_yaml_invalid/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('finops: плоский root usage не дублируется на несколько metered VM', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'finops-multi-vm-'));
  try {
    const budget = join(dir, 'budget.yaml');
    const usage = join(dir, 'usage.json');
    await writeFile(budget, `version: 1
compute_vms:
  - id: worker-a
    hourly_cost_usd: 0.10
    metered: true
  - id: worker-b
    hourly_cost_usd: 0.10
    metered: true
workspace_links: {}
`);
    await writeFile(usage, JSON.stringify({ runningMinutesMonth: 600 }));
    const snap = await createFinopsProvider({ budgetPath: budget, workerUsagePath: usage })();
    assert.equal(snap.ok, true);
    assert.equal(snap.totals.runningMinutesMonth, 0);
    assert.equal(snap.estimatedMonthCostEur, 0);

    await writeFile(usage, JSON.stringify({ vmId: 'worker-b', runningMinutesMonth: 600 }));
    const pinned = await createFinopsProvider({ budgetPath: budget, workerUsagePath: usage })();
    assert.equal(pinned.computeVms.find(v => v.id === 'worker-a').runningMinutesMonth, 0);
    assert.equal(pinned.computeVms.find(v => v.id === 'worker-b').runningMinutesMonth, 600);
    assert.equal(pinned.totals.runningMinutesMonth, 600);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
