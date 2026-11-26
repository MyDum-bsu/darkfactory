// Тесты операторского CLI реестра моделей ops/df-models.mjs: команда check
// обязана fail-closed отклонять конфигурацию без L2-исполняемого reviewer
// или arbiter третьего семейства, а не сообщать ok: true. Фикстуры —
// минимальные валидные catalog/policy без дат until: результат не зависит
// от текущей даты. Временные каталоги удаляются в finally.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const OPS_DIR = dirname(fileURLToPath(import.meta.url));
const MODELS_CLI = join(OPS_DIR, 'df-models.mjs');

async function runCli(args) {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ['--no-warnings', MODELS_CLI, ...args],
      { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
    );
    return { code: 0, stdout, stderr };
  } catch (error) {
    return {
      code: typeof error.code === 'number' ? error.code : 1,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
    };
  }
}

const MODELS = `
  - id: coder-cog
    provider: acp-devin
    model: swe-test
    family: cognition
    status: active
    cost_tier: free
    capabilities: [code, reasoning]
    quota_source: manual
    notes: test coder
  - id: rev-google
    provider: google
    model: gemini-test
    family: google
    status: active
    cost_tier: subscription
    capabilities: [code, reasoning, vision, review]
    quota_source: manual
    notes: L2-runnable reviewer
  - id: arb-openai
    provider: openai
    model: gpt-test
    family: openai
    status: active
    cost_tier: subscription
    capabilities: [code, reasoning, review]
    quota_source: manual
    notes: L2-runnable arbiter
  - id: rev-acp
    provider: acp-antigravity-acp
    model: gemini-acp
    family: google
    status: active
    cost_tier: subscription
    capabilities: [code, reasoning, vision, review]
    quota_source: manual
    notes: ACP harness reviewer, not runnable by the L2 runner
  - id: arb-acp
    provider: acp-devin
    model: claude-test
    family: anthropic
    status: active
    cost_tier: subscription
    capabilities: [code, reasoning, review]
    quota_source: manual
    notes: ACP harness arbiter, not runnable by the L2 runner
`;

function catalogYaml() {
  return `version: 1\nmodels:${MODELS}`;
}

function policyYaml({ reviewer, arbiter }) {
  const mode = `    cost_tiers: [free, subscription]
    status_priority: [promo_free, active, standby]
    candidates:
      lead: [coder-cog]
      coder_default: [coder-cog]
      coder_heavy: [coder-cog]
      reviewer: [${reviewer}]
      arbiter: [${arbiter}]
      ux_critic: [rev-google]`;
  return `version: 1
mode: balanced

roles:
  lead:
    required_capabilities: [code, reasoning]
    must_differ_family_from: []
  coder_default:
    required_capabilities: [code]
    must_differ_family_from: []
  coder_heavy:
    required_capabilities: [code, reasoning]
    must_differ_family_from: []
  reviewer:
    required_capabilities: [code, review]
    must_differ_family_from: [coder]
  arbiter:
    required_capabilities: [code, reasoning]
    must_differ_family_from: [coder, reviewer]
  ux_critic:
    required_capabilities: [vision]
    must_differ_family_from: []

modes:
  economy:
${mode}
  balanced:
${mode}
  sprint:
${mode}
`;
}

async function writeConfig(dir, candidates) {
  await writeFile(join(dir, 'models-catalog.yaml'), catalogYaml(), 'utf8');
  await writeFile(join(dir, 'routing-policy.yaml'), policyYaml(candidates), 'utf8');
}

test('df-models check: полная L2-исполняемая тройка даёт ok: true с арбитром', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'df-models-test-'));
  try {
    await writeConfig(dir, { reviewer: 'rev-google', arbiter: 'arb-openai' });
    const result = await runCli(['check', '--config-dir', dir]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, '');
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.coder, 'coder-cog');
    assert.equal(report.reviewer, 'rev-google');
    assert.equal(report.arbiter, 'arb-openai');
    assert.equal(report.coderFamily, 'cognition');
    assert.equal(report.reviewerFamily, 'google');
    assert.equal(report.arbiterFamily, 'openai');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('df-models check: reviewer только ACP-харнесса не проходит strictL2 и не даёт ok: true', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'df-models-test-'));
  try {
    // rev-acp формально подходит по семейству и статусу, но его provider
    // (acp-antigravity-acp) read-only L2 раннером не исполняется: без
    // strictL2 проверка ложно сообщала бы ok: true.
    await writeConfig(dir, { reviewer: 'rev-acp', arbiter: 'arb-openai' });
    const result = await runCli(['check', '--config-dir', dir]);
    assert.equal(result.code, 1);
    const report = JSON.parse(result.stderr);
    assert.equal(report.ok, false);
    assert.ok(report.problems.includes('no eligible reviewer model from a different family'),
      `unexpected problems: ${JSON.stringify(report.problems)}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('df-models check: arbiter третьего семейства без L2-исполняемого провайдера отклоняется', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'df-models-test-'));
  try {
    // arb-acp — единственный кандидат арбитра третьего семейства, но
    // provider acp-devin в L2 не запускается: тройка неполна, check
    // обязан это сообщать, а не умалчивать арбитра.
    await writeConfig(dir, { reviewer: 'rev-google', arbiter: 'arb-acp' });
    const result = await runCli(['check', '--config-dir', dir]);
    assert.equal(result.code, 1);
    const report = JSON.parse(result.stderr);
    assert.equal(report.ok, false);
    assert.ok(report.problems.includes('no eligible arbiter model from a third family'),
      `unexpected problems: ${JSON.stringify(report.problems)}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('df-models check: половинчатая установка конфигурации — fail-closed без ok: true', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'df-models-test-'));
  try {
    // Только catalog без парного policy: половинчатая установка не
    // смешивается с example, а отклоняется — check не сообщает ok: true.
    await writeFile(join(dir, 'models-catalog.yaml'), catalogYaml(), 'utf8');
    const result = await runCli(['check', '--config-dir', dir]);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    const report = JSON.parse(result.stderr);
    assert.equal(report.ok, false);
    assert.match(report.error, /model_registry_file_missing/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('df-models check: example-конфиг с самовосстанавливающейся паузой Sol валиден в устоявшемся состоянии', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'df-models-test-'));
  try {
    // Канонический example: единственные L2-исполняемые кандидаты —
    // deepseek-v4.1-flash (active) и gpt-6.2-sol (quota_paused с until).
    // Пауза с until самовосстанавливается по расписанию и не является
    // дефектом конфигурации: strictL2-тройка в устоявшемся состоянии
    // полная, check обязан пройти независимо от текущей даты.
    for (const file of ['models-catalog.example.yaml', 'routing-policy.example.yaml']) {
      const target = file.replace('.example', '');
      await writeFile(join(dir, target),
        await readFile(join(OPS_DIR, 'local', file), 'utf8'), 'utf8');
    }
    const result = await runCli(['check', '--config-dir', dir]);
    assert.equal(result.code, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, true);
    assert.ok(report.arbiter, 'arbiter must be present in the report');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('df-models check: бессрочная quota_paused арбитра — структурная деградация, а не транзиент', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'df-models-test-'));
  try {
    // quota_paused БЕЗ until не истекает: arbiter третьего семейства
    // отсутствует структурно — check обязан отказать даже в устоявшемся
    // состоянии, а не ждать самовосстановления, которого нет в расписании.
    const paused = `
  - id: arb-paused
    provider: openai
    model: gpt-paused
    family: openai
    status: quota_paused
    cost_tier: subscription
    capabilities: [code, reasoning, review]
    quota_source: manual
    notes: indefinitely paused arbiter
`;
    await writeFile(join(dir, 'models-catalog.yaml'), `${catalogYaml().trimEnd()}\n${paused}`, 'utf8');
    await writeFile(join(dir, 'routing-policy.yaml'),
      policyYaml({ reviewer: 'rev-google', arbiter: 'arb-paused' }), 'utf8');
    const result = await runCli(['check', '--config-dir', dir]);
    assert.equal(result.code, 1);
    const report = JSON.parse(result.stderr);
    assert.equal(report.ok, false);
    assert.ok(report.problems.includes('no eligible arbiter model from a third family'),
      `unexpected problems: ${JSON.stringify(report.problems)}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('df-models check: quota_paused с будущим until самовосстанавливается и не блокирует check', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'df-models-test-'));
  try {
    // Пауза с будущим until — заявленное расписание возврата: в устоявшемся
    // состоянии запись active, strictL2-тройка полная, check проходит.
    const healing = `
  - id: arb-healing
    provider: openai
    model: gpt-healing
    family: openai
    status: quota_paused
    cost_tier: subscription
    until: "2099-01-01"
    capabilities: [code, reasoning, review]
    quota_source: manual
    notes: self-healing paused arbiter
`;
    await writeFile(join(dir, 'models-catalog.yaml'), `${catalogYaml().trimEnd()}\n${healing}`, 'utf8');
    await writeFile(join(dir, 'routing-policy.yaml'),
      policyYaml({ reviewer: 'rev-google', arbiter: 'arb-healing' }), 'utf8');
    const result = await runCli(['check', '--config-dir', dir]);
    assert.equal(result.code, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.arbiter, 'arb-healing');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
