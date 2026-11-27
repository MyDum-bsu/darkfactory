// FinOps provider: декларативный YAML, fail-open, symlink policy,
// расчёт стоимости worker VM и фильтрация небезопасных workspace links.

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createFinopsProvider, analyzeDeadLoad, buildSpendDynamics,
  EXAMPLE_BUDGET_PATH } from './finops.mjs';

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

test('finops: monthly VM spend draws recurring credits before finite credits', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'finops-credit-draw-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const budgetPath = join(dir, 'budget.yaml');
  const workerUsagePath = join(dir, 'usage.json');
  const snapshot = createFinopsProvider({ budgetPath, workerUsagePath, now: '2026-11-24T12:00:00Z' });
  // Welcome is listed first and is already partially depleted. Both VMs cost
  // €0.60/hour, so their combined running minutes give the spend in cents.
  await writeFile(budgetPath, `cloud_credits:
  - { id: gcp_welcome, total_eur: 100, remaining_eur: 90.75 }
  - { id: gcp_ultra_monthly, monthly_eur: 10, remaining_eur: 10 }
compute_vms:
  - { id: a, metered: true, hourly_cost_eur: 0.60 }
  - { id: b, metered: true, hourly_cost_eur: 0.60 }
`);
  for (const [name, minutes, ultraUsed, ultraLeft, welcomeUsed, welcomeLeft] of [
    ['zero spend', 0, 0, 10, 0, 90.75],
    ['below monthly allowance', 321, 3.21, 6.79, 0, 90.75],
    ['exact monthly allowance', 1000, 10, 0, 0, 90.75],
    ['monthly overflow', 1123, 10, 0, 1.23, 89.52],
    ['both credits exhausted', 12000, 10, 0, 90.75, 0],
  ]) {
    await t.test(name, async () => {
      const a = Math.floor(minutes / 2);
      await writeFile(workerUsagePath, JSON.stringify({ vms: {
        a: { runningMinutesMonth: a }, b: { runningMinutesMonth: minutes - a },
      } }));
      const snap = await snapshot();
      assert.equal(snap.ok, true);
      assert.equal(snap.totals.spentMonthCostEur, minutes / 100);
      assert.deepEqual(snap.cloudCredits.map(c =>
        [c.id, c.totalEur, c.monthlyEur, c.usedMonthEur, c.remainingEur]), [
        ['gcp_welcome', 100, null, welcomeUsed, welcomeLeft],
        ['gcp_ultra_monthly', null, 10, ultraUsed, ultraLeft],
      ]);
      assert.equal(snap.totals.remainingCreditsEur, welcomeLeft + ultraLeft);
      assert.equal(snap.creditRunway.remainingCreditsEur, snap.totals.remainingCreditsEur);
    });
  }
});

test('finops: credit draw uses explicit balances (including zero) before face values', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'finops-credit-base-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const budgetPath = join(dir, 'budget.yaml');
  const workerUsagePath = join(dir, 'usage.json');
  await writeFile(budgetPath, `cloud_credits:
  - { id: finite, total_eur: 20 }
  - { id: depleted, monthly_eur: 10, remaining_eur: 0 }
  - { id: partial, monthly_eur: 10, remaining_eur: 2 }
  - { id: full, monthly_eur: 3 }
compute_vms:
  - { id: worker, metered: true, hourly_cost_eur: 6.123 }
`);
  await writeFile(workerUsagePath, JSON.stringify({ runningMinutesMonth: 60 }));
  const snap = await createFinopsProvider({ budgetPath, workerUsagePath, now: '2026-11-24T12:00:00Z' })();
  assert.equal(snap.ok, true);
  assert.equal(snap.totals.spentMonthCostEur, 6.123);
  assert.deepEqual(snap.cloudCredits.map(c => [c.id, c.usedMonthEur, c.remainingEur]), [
    ['finite', 1.12, 18.88], ['depleted', 0, 0], ['partial', 2, 0], ['full', 3, 0],
  ]);
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

test('finops: expired credits excluded and localized thousands decimals parse accurately', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'finops-credits-num-'));
  try {
    const budget = join(dir, 'budget.yaml');
    await writeFile(budget, `version: 1
monthly_budgets:
  cloud_eur: 40
cloud_credits:
  - id: active
    remaining_eur: 100
    expires: 2999-01-01
  - id: expired
    remaining_eur: 50
    expires: 2020-01-01
compute_vms: []
workspace_links: {}
`);
    const snap = await createFinopsProvider({ budgetPath: budget })();
    assert.equal(snap.ok, true);
    assert.equal(snap.totals.remainingCreditsEur, 100);
    assert.equal(snap.creditRunway.remainingCreditsEur, 100);
    assert.equal(snap.cloudCredits.length, 2);

    const localized = join(dir, 'localized.yaml');
    await writeFile(localized, `version: 1
monthly_budget_eur: "1,200"
compute_vms:
  - id: worker-a
    hourly_cost_usd: "1,006.02"
    metered: true
  - id: worker-b
    hourly_cost_usd: "1.006,02"
    metered: true
compute_price_eur_per_usd: 1
workspace_links: {}
`);
    const parsed = await createFinopsProvider({ budgetPath: localized })();
    assert.equal(parsed.ok, true);
    assert.equal(parsed.totals.monthlyBudgetEur, 1200);
    assert.equal(parsed.computeVms[0].hourlyCostUsd, 1006.02);
    assert.equal(parsed.computeVms[1].hourlyCostUsd, 1006.02);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('finops: nested usage.vms is metered, malformed numbers and negative rates are rejected', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'finops-nested-negative-'));
  try {
    const budget = join(dir, 'budget.yaml');
    const usage = join(dir, 'usage.json');
    await writeFile(budget, `version: 1
compute_vms:
  - id: metered-worker
    hourly_cost_usd: 0.10
    metered: true
  - id: nested-worker
    hourly_cost_usd: 0.20
  - id: negative-worker
    hourly_cost_usd: -0.10
    metered: true
  - id: malformed-worker
    hourly_cost_usd: "12,34,567"
    metered: true
workspace_links: {}
`);
    await writeFile(usage, JSON.stringify({ vms: {
      'metered-worker': { runningMinutesMonth: 60 },
      'nested-worker': { runningMinutesMonth: 120 },
      'negative-worker': { runningMinutesMonth: 30 },
      'malformed-worker': { runningMinutesMonth: 10 },
    } }));
    const snap = await createFinopsProvider({ budgetPath: budget, workerUsagePath: usage })();
    assert.equal(snap.ok, true);
    assert.equal(snap.computeVms.find(vm => vm.id === 'nested-worker').runningMinutesMonth, 120);
    assert.equal(snap.totals.runningMinutesMonth, 220);
    assert.equal(snap.computeVms.find(vm => vm.id === 'negative-worker').hourlyCostUsd, null);
    assert.equal(snap.computeVms.find(vm => vm.id === 'malformed-worker').hourlyCostUsd, null);
    assert.equal(snap.alerts.filter(alert => alert.code === 'invalid_config_value').length >= 2, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('finops: freshest usage journal wins and worker usage reads are capped at 256 KiB', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'finops-journal-cap-'));
  try {
    const budget = join(dir, 'budget.yaml');
    const state = join(dir, 'state.json');
    const usage = join(dir, 'usage.json');
    await writeFile(budget, `version: 1
compute_vms:
  - id: worker-a
    hourly_cost_usd: 0.10
    metered: true
workspace_links: {}
`);
    await writeFile(state, JSON.stringify({
      updatedAt: '2026-01-01T00:00:00.000Z', runningMinutesMonth: 10 }));
    await writeFile(usage, JSON.stringify({
      updatedAt: '2026-01-02T00:00:00.000Z', runningMinutesMonth: 20 }));
    const usageFresh = await createFinopsProvider({ budgetPath: budget, workerStatePath: state, workerUsagePath: usage })();
    assert.equal(usageFresh.totals.runningMinutesMonth, 20);

    await writeFile(state, JSON.stringify({
      updatedAt: '2026-01-03T00:00:00.000Z', runningMinutesMonth: 30 }));
    const stateFresh = await createFinopsProvider({ budgetPath: budget, workerStatePath: state, workerUsagePath: usage })();
    assert.equal(stateFresh.totals.runningMinutesMonth, 30);

    await writeFile(usage, `{"runningMinutesMonth":600,"padding":"${'x'.repeat(263000)}"}`);
    const capped = await createFinopsProvider({ budgetPath: budget, workerStatePath: join(dir, 'missing-state.json'), workerUsagePath: usage })();
    assert.equal(capped.totals.runningMinutesMonth, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- Spend Dynamics & Dead-Load Detector --------------------------------------

test('analyzeDeadLoad: worker RUNNING >= 20m idle с 0 задач → dead_load_detected (bad)', () => {
  const result = analyzeDeadLoad({
    vmUsage: [
      { id: 'cloud-bb-worker', pricing: 'spot', state: 'RUNNING',
        runningMinutesToday: 90, activeMinutesToday: 0 },
    ],
    activeTasks: 0,
    claimedTasks: 0,
    idleMinutesSinceLastTask: 20,
    deadLoadThresholdMinutes: 20,
  });
  assert.equal(result.deadLoadDetected, true);
  const vm = result.vms.find(v => v.id === 'cloud-bb-worker');
  assert.equal(vm.deadLoad, true);
  assert.equal(vm.activeMinutes, 0);
  assert.equal(vm.idleMinutes, 90);
  assert.equal(vm.idleWastePct, 100);
  const alert = result.alerts.find(a => a.code === 'dead_load_detected');
  assert.equal(alert.severity, 'bad');
  assert.equal(alert.resourceId, 'cloud-bb-worker');
  assert.equal(result.idleWastePct, 100);
});

test('analyzeDeadLoad: активные/взятые задачи или остановленная VM — чисто', () => {
  const runningWorker = { id: 'cloud-bb-worker', pricing: 'spot', state: 'running',
    runningMinutesToday: 120, activeMinutesToday: 30 };
  const withTasks = analyzeDeadLoad({ vmUsage: [runningWorker],
    activeTasks: 1, claimedTasks: 0, idleMinutesSinceLastTask: 60 });
  assert.equal(withTasks.deadLoadDetected, false);
  assert.equal(withTasks.alerts.length, 0);
  assert.equal(withTasks.vms[0].deadLoad, false);
  assert.equal(withTasks.vms[0].activeMinutes, 30);
  assert.equal(withTasks.vms[0].idleMinutes, 90);
  assert.equal(withTasks.vms[0].idleWastePct, 75);

  const claimedOnly = analyzeDeadLoad({ vmUsage: [runningWorker],
    activeTasks: 0, claimedTasks: 2, idleMinutesSinceLastTask: 60 });
  assert.equal(claimedOnly.deadLoadDetected, false);

  const stopped = analyzeDeadLoad({ vmUsage: [
    { ...runningWorker, state: 'stopped' }],
    activeTasks: 0, claimedTasks: 0, idleMinutesSinceLastTask: 600 });
  assert.equal(stopped.deadLoadDetected, false);
  assert.equal(stopped.alerts.length, 0);

  const belowThreshold = analyzeDeadLoad({ vmUsage: [runningWorker],
    activeTasks: 0, claimedTasks: 0, idleMinutesSinceLastTask: 19,
    deadLoadThresholdMinutes: 20 });
  assert.equal(belowThreshold.deadLoadDetected, false);

  const controlPlane = analyzeDeadLoad({ vmUsage: [
    { id: 'cloud-brain', pricing: 'Always Free', state: 'running',
      runningMinutesToday: 120 }],
    activeTasks: 0, claimedTasks: 0, idleMinutesSinceLastTask: 600 });
  assert.equal(controlPlane.deadLoadDetected, false,
    'не-worker control-plane VM не флагается даже при длинном простое');
});

test('analyzeDeadLoad: worker распознаётся по id без spot-pricing, пустой вход — чисто', () => {
  const byId = analyzeDeadLoad({
    vmUsage: [{ id: 'ephemeral-worker-3', pricing: 'on-demand', state: 'RUNNING',
      runningMinutesToday: 45 }],
    idleMinutesSinceLastTask: 30 });
  assert.equal(byId.deadLoadDetected, true);
  const empty = analyzeDeadLoad({ vmUsage: [] });
  assert.equal(empty.deadLoadDetected, false);
  assert.equal(empty.idleWastePct, 0);
  assert.deepEqual(empty.alerts, []);
});

test('buildSpendDynamics: проекция против €25 target, overTarget и тренды', () => {
  // 6 дней по €1 → проекция €30 против target €25 → overTarget.
  const over = buildSpendDynamics({
    dailyHistory: [1, 1, 1, 1, 1], todayEur: 1,
    monthlyTargetEur: 25, dayOfMonth: 6, daysInMonth: 30 });
  assert.equal(over.daily.length, 6);
  assert.equal(over.daily.at(-1).today, true);
  assert.equal(over.avgDailyEur, 1);
  assert.equal(over.projectedMonthEur, 30);
  assert.equal(over.targetEur, 25);
  assert.equal(over.overTarget, true);
  assert.equal(over.trend, 'stable');

  const under = buildSpendDynamics({
    dailyHistory: [0.5, 0.5], todayEur: 0.5,
    monthlyTargetEur: 25, dayOfMonth: 3, daysInMonth: 30 });
  assert.equal(under.projectedMonthEur, 15);
  assert.equal(under.overTarget, false);

  const rising = buildSpendDynamics({
    dailyHistory: [0.5, 0.5, 0.5], todayEur: 2,
    monthlyTargetEur: 25, dayOfMonth: 4, daysInMonth: 30 });
  assert.equal(rising.trend, 'rising');

  const falling = buildSpendDynamics({
    dailyHistory: [2, 2, 2], todayEur: 0.2,
    monthlyTargetEur: 25, dayOfMonth: 4, daysInMonth: 30 });
  assert.equal(falling.trend, 'falling');

  const stable = buildSpendDynamics({
    dailyHistory: [1, 1, 1], todayEur: 1,
    monthlyTargetEur: 25, dayOfMonth: 4, daysInMonth: 30 });
  assert.equal(stable.trend, 'stable');
});

test('buildSpendDynamics: записи {date, eur}, дефолтный target 25 и пустая история', () => {
  const result = buildSpendDynamics({
    dailyHistory: [{ date: '2026-11-01', eur: 2 }, { date: '2026-11-02', eur: '1.5' }],
    todayEur: 0.5, dayOfMonth: 3, daysInMonth: 30 });
  assert.equal(result.daily[0].date, '2026-11-01');
  assert.equal(result.daily[1].eur, 1.5);
  assert.equal(result.targetEur, 25);
  assert.equal(result.avgDailyEur, 1.3333);
  assert.equal(result.projectedMonthEur, 40);

  const empty = buildSpendDynamics({});
  assert.equal(empty.daily.length, 1); // только today-point
  assert.equal(empty.overTarget, false);
  assert.equal(empty.trend, 'stable');
  assert.equal(empty.projectedMonthEur, 0);
});

test('finops snapshot: spendDynamics и dead_load_detected проводятся в snapshot и alerts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'finops-deadload-'));
  try {
    const budget = join(dir, 'budget.yaml');
    const usage = join(dir, 'usage.json');
    await writeFile(budget, `version: 1
monthly_budget_eur: 25
compute_vms:
  - id: cloud-bb-worker
    machine_type: e2-standard-8 Spot
    hourly_cost_usd: 0.10
    pricing: spot
    metered: true
workspace_links: {}
`);
    await writeFile(usage, JSON.stringify({
      state: 'running', runningMinutesToday: 90, runningMinutesMonth: 90,
      activeMinutesToday: 0, activeTasks: 0, claimedTasks: 0,
      idleMinutesSinceLastTask: 45,
      dailySpendEur: [{ date: '2026-11-23', eur: 2 }],
      updatedAt: '2026-11-24T10:00:00Z' }));
    const snap = await createFinopsProvider({ budgetPath: budget, workerUsagePath: usage,
      now: new Date('2026-11-24T12:00:00Z') })();
    assert.equal(snap.ok, true);
    assert.equal(snap.deadLoad.deadLoadDetected, true);
    assert.equal(snap.deadLoad.vms[0].deadLoad, true);
    assert.equal(snap.deadLoad.idleMinutesSinceLastTask, 45);
    assert.equal(snap.alerts.some(a => a.code === 'dead_load_detected' &&
      a.severity === 'bad' && a.resourceId === 'cloud-bb-worker'), true);
    assert.ok(Array.isArray(snap.spendDynamics.daily));
    assert.equal(snap.spendDynamics.targetEur, 25);
    assert.equal(typeof snap.spendDynamics.projectedMonthEur, 'number');
    assert.equal(typeof snap.spendDynamics.overTarget, 'boolean');
    assert.ok(['rising', 'falling', 'stable'].includes(snap.spendDynamics.trend));
    assert.equal(snap.spendDynamics.daily[0].eur, 2);

    // Свежая задача (idle < порога) → алертов мёртвой нагрузки нет.
    await writeFile(usage, JSON.stringify({
      state: 'running', runningMinutesToday: 90, runningMinutesMonth: 90,
      activeTasks: 0, claimedTasks: 0, idleMinutesSinceLastTask: 5,
      updatedAt: '2026-11-24T10:00:00Z' }));
    const clean = await createFinopsProvider({ budgetPath: budget, workerUsagePath: usage,
      now: new Date('2026-11-24T12:00:00Z') })();
    assert.equal(clean.deadLoad.deadLoadDetected, false);
    assert.equal(clean.alerts.some(a => a.code === 'dead_load_detected'), false);
    // Активная работа: активные минуты снижают idle waste.
    await writeFile(usage, JSON.stringify({
      state: 'running', runningMinutesToday: 100, runningMinutesMonth: 100,
      activeMinutesToday: 80, activeTasks: 1, claimedTasks: 1,
      idleMinutesSinceLastTask: 0,
      updatedAt: '2026-11-24T10:00:00Z' }));
    const busy = await createFinopsProvider({ budgetPath: budget, workerUsagePath: usage,
      now: new Date('2026-11-24T12:00:00Z') })();
    assert.equal(busy.deadLoad.deadLoadDetected, false);
    assert.equal(busy.deadLoad.vms[0].activeMinutes, 80);
    assert.equal(busy.deadLoad.vms[0].idleMinutes, 20);
    assert.equal(busy.deadLoad.vms[0].idleWastePct, 20);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
