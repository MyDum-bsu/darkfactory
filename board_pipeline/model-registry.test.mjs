// Model Registry: строгая схема YAML, deterministic until/квоты, режимы,
// кросс-семейная триада, CLI df-models в изолированном config-dir.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { promisify } from 'node:util';
import { parse, stringify } from 'yaml';
import {
  EXAMPLE_CATALOG_PATH,
  EXAMPLE_POLICY_PATH,
  effectiveStatus,
  isL2RunnableEntry,
  L2_RUNNABLE_PROVIDERS,
  loadModelRegistry,
  MODEL_FAMILIES,
  registrySnapshot,
  resolveRoleChain,
  resolveTriad,
  toPipelineAllowlist,
} from './model-registry.mjs';

const execFileAsync = promisify(execFile);
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(MODULE_DIR, '..');
const CLI = join(ROOT, 'ops', 'df-models.mjs');
const NOW = '2026-11-24T12:00:00Z';

async function fixture(dir, mutateCatalog = null, mutatePolicy = null) {
  const catalog = parse(await readFile(EXAMPLE_CATALOG_PATH, 'utf8'));
  const policy = parse(await readFile(EXAMPLE_POLICY_PATH, 'utf8'));
  mutateCatalog?.(catalog);
  mutatePolicy?.(policy);
  const catalogPath = join(dir, 'models-catalog.yaml');
  const policyPath = join(dir, 'routing-policy.yaml');
  await writeFile(catalogPath, stringify(catalog));
  await writeFile(policyPath, stringify(policy));
  return { catalogPath, policyPath };
}

async function loadFixture(dir, mutateCatalog = null, mutatePolicy = null, now = NOW) {
  const paths = await fixture(dir, mutateCatalog, mutatePolicy);
  return loadModelRegistry({ ...paths, now });
}

async function tmp(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'df-model-reg-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function runCli(args, env = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...args], {
      cwd: ROOT,
      env: { ...process.env, ...env },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

test('example registry загружается: 9 моделей, строгая схема, balanced mode', async () => {
  await tmp(async dir => {
    const registry = await loadFixture(dir);
    assert.equal(registry.catalog.models.length, 9);
    assert.equal(registry.policy.mode, 'balanced');
    const gpt = registry.modelById.get('gpt-6.2-sol');
    assert.equal(gpt.family, 'openai');
    assert.equal(gpt.status, 'quota_paused');
    assert.equal(gpt.until, '2026-11-27');
    const neon = registry.modelById.get('gemini-4-neon');
    assert.deepEqual(neon.capabilities, ['code', 'reasoning', 'vision', 'review']);
  });
});

test('config discovery: user pair имеет приоритет, половинчатая пара fail-closed', async () => {
  await tmp(async dir => {
    const paths = await fixture(dir);
    const registry = await loadModelRegistry({ configDir: dir, now: NOW });
    assert.equal(registry.catalogPath, paths.catalogPath);
    assert.equal(registry.policyPath, paths.policyPath);
    assert.equal(registry.catalog.models.length, 9);

    await rm(paths.policyPath);
    await assert.rejects(loadModelRegistry({ configDir: dir, now: NOW }),
      /model_registry_file_missing/);
  });

  await tmp(async dir => {
    const empty = join(dir, 'empty');
    const registry = await loadModelRegistry({ configDir: empty, now: NOW });
    assert.equal(registry.catalogPath, EXAMPLE_CATALOG_PATH);
    assert.equal(registry.policyPath, EXAMPLE_POLICY_PATH);
  });
});

test('catalog validation fail-closed: неизвестное семейство, статус, пустые provider/model', async () => {
  await tmp(async dir => {
    for (const mutate of [
      catalog => { catalog.models[0].family = 'unknown'; },
      catalog => { catalog.models[0].status = 'sometimes'; },
      catalog => { catalog.models[0].provider = ''; },
      catalog => { catalog.models[0].model = ' '; },
      catalog => { catalog.models[0].cost_tier = 'sponsored'; },
      catalog => { catalog.models[0].until = '2026-02-30'; },
      catalog => { catalog.models[0].until = '2026-02-30T00:00:00Z'; },
      catalog => { catalog.models[0].until = '11/27/2026'; },
      catalog => { catalog.models[0].id = 12345; },
      catalog => { catalog.models[0].id = true; },
    ]) {
      const paths = await fixture(dir, mutate);
      await assert.rejects(loadModelRegistry({ ...paths, now: NOW }), /model_catalog_invalid/);
    }
  });
});

test('broken YAML и нарушенная policy fail-closed', async () => {
  await tmp(async dir => {
    const paths = await fixture(dir);
    await writeFile(paths.catalogPath, 'models: [broken\n');
    await assert.rejects(loadModelRegistry({ ...paths, now: NOW }), /model_registry_yaml_invalid/);

    const badCandidate = await fixture(dir, null, policy => {
      policy.modes.balanced.candidates.reviewer[0] = 'missing-model';
    });
    await assert.rejects(loadModelRegistry({ ...badCandidate, now: NOW }), /model_policy_invalid/);

    const badInvariant = await fixture(dir, null, policy => {
      policy.roles.reviewer.must_differ_family_from = [];
    });
    await assert.rejects(loadModelRegistry({ ...badInvariant, now: NOW }), /cross-family/);
  });
});

test('effectiveStatus: promo/quota_paused истекают по until, quotaPct >= 95 паузит', async () => {
  await tmp(async dir => {
    const registry = await loadFixture(dir);
    const swe = registry.modelById.get('swe-2-1-medium');
    const sol = registry.modelById.get('gpt-6.2-sol');
    assert.equal(effectiveStatus(swe, '2026-12-08T23:59:59.999Z'), 'promo_free');
    assert.equal(effectiveStatus(swe, '2026-12-09T00:00:00Z'), 'standby');
    assert.equal(effectiveStatus(sol, '2026-11-27T23:59:59.999Z'), 'quota_paused');
    assert.equal(effectiveStatus(sol, '2026-11-28T00:00:00Z'), 'active');
    assert.equal(effectiveStatus(swe, NOW, 95), 'quota_paused');
    assert.equal(effectiveStatus(swe, NOW, { quotaPct: 94.9 }), 'promo_free');
  });
});

test('resolveRoleChain: quota/disabled/cost_tier механически исключаются', async () => {
  await tmp(async dir => {
    const registry = await loadFixture(dir, catalog => {
      catalog.models.push({
        id: 'paid-reviewer', provider: 'api', model: 'paid-model', family: 'openai',
        status: 'active', cost_tier: 'paid_api', capabilities: ['code', 'review'],
        quota_source: 'manual', notes: 'paid test',
      });
    }, policy => {
      for (const mode of Object.values(policy.modes)) {
        mode.candidates.reviewer.unshift('paid-reviewer');
      }
    });
    const economy = resolveRoleChain(registry, 'reviewer', { mode: 'economy', now: NOW });
    assert.equal(economy.some(entry => entry.id === 'paid-reviewer'), false);
    const sprint = resolveRoleChain(registry, 'reviewer', { mode: 'sprint', now: NOW });
    assert.equal(sprint.some(entry => entry.id === 'paid-reviewer'), true);

    const quotaChain = resolveRoleChain(registry, 'coder_default', {
      mode: 'balanced', now: NOW, quotas: { 'swe-2-1-medium': { quotaPct: 95 } } });
    assert.equal(quotaChain.some(entry => entry.id === 'swe-2-1-medium'), false);
    assert.equal(quotaChain[0].id, 'swe-2-1-high');
    const keyedQuota = resolveRoleChain(registry, 'coder_default', {
      mode: 'balanced', now: NOW, quotas: { 'acp-devin/swe-2-1-medium': 95 } });
    assert.equal(keyedQuota.some(entry => entry.id === 'swe-2-1-medium'), false);

    const disabledChain = resolveRoleChain(registry, 'coder_default', {
      mode: 'balanced', now: '2026-11-28T00:00:00Z' });
    assert.equal(disabledChain.some(entry => entry.id === 'gpt-6.2-sol'), false,
      'gpt не входит в кандидаты coder; отдельно проверяется ниже через reviewer');
  });
});

test('expiry-aware routing: после конца promo и quota паузы тройка перестраивается', async () => {
  await tmp(async dir => {
    const registry = await loadFixture(dir);
    const before = resolveTriad(registry, { mode: 'balanced', now: NOW });
    assert.equal(before.coder.family, 'cognition');
    assert.equal(before.arbiter.family, 'deepseek');

    const after = resolveTriad(registry, { mode: 'balanced', now: '2026-12-10T00:00:00Z' });
    assert.equal(after.coder.family, 'deepseek');
    assert.equal(after.reviewer.family, 'google');
    assert.equal(after.arbiter.family, 'openai');
    assert.equal(new Set([after.coder.family, after.reviewer.family, after.arbiter.family]).size, 3);
    const reviewers = resolveRoleChain(registry, 'reviewer', { mode: 'balanced', now: '2026-12-10T00:00:00Z' });
    assert.equal(reviewers.some(entry => entry.id === 'gpt-6.2-sol'), true);
  });
});

test('resolveRoleChain: excludeFamilies и required vision механически соблюдаются', async () => {
  await tmp(async dir => {
    const registry = await loadFixture(dir, null, policy => {
      policy.modes.balanced.candidates.ux_critic.unshift('swe-2-1-medium');
    });
    const noCognition = resolveRoleChain(registry, 'coder_default', {
      mode: 'balanced', now: NOW, excludeFamilies: ['cognition'] });
    assert.equal(noCognition.some(entry => entry.family === 'cognition'), false);
    assert.equal(noCognition[0].id, 'deepseek-v4.1-flash');

    const ux = resolveRoleChain(registry, 'ux_critic', { mode: 'balanced', now: NOW });
    assert.deepEqual(ux.map(entry => entry.id), ['gemini-4-neon']);
    assert.ok(ux[0].capabilities.includes('vision'));
  });
});

test('resolveTriad: coder/reviewer/arbiter разных семейств даже при попытке конфликта', async () => {
  await tmp(async dir => {
    const registry = await loadFixture(dir);
    const triad = resolveTriad(registry, { mode: 'balanced', now: NOW });
    assert.equal(triad.coder.family, 'cognition');
    assert.equal(triad.reviewer.family, 'google');
    assert.equal(triad.arbiter.family, 'deepseek');
    assert.notEqual(triad.coder.family, triad.reviewer.family);
    assert.notEqual(triad.arbiter.family, triad.coder.family);
    assert.notEqual(triad.arbiter.family, triad.reviewer.family);

    // В policy подсовывают reviewer той же cognition-семьи: механический фильтр
    // не даёт выбрать её против cognition coder, даже though candidates валидны.
    const conflict = await loadFixture(dir, null, policy => {
      for (const mode of Object.values(policy.modes)) {
        mode.candidates.reviewer = ['swe-2-1-high'];
      }
    });
    const bad = resolveTriad(conflict, { mode: 'balanced', now: NOW });
    assert.equal(bad.coder.family, 'cognition');
    assert.equal(bad.reviewer, null);
  });
});

test('resolveTriad backtracking: следующий coder/reviewer подбирается для полной тройки', async () => {
  await tmp(async dir => {
    const registry = await loadFixture(dir, null, policy => {
      const balanced = policy.modes.balanced.candidates;
      // Первый coder google не оставляет reviewer другого семейства; resolver
      // обязан перейти к deepseek coder, а не вернуть reviewer=null.
      balanced.coder_default = ['gemini-4-neon', 'deepseek-v4.1-flash'];
      balanced.reviewer = ['gemini-4-neon'];
    });
    const triad = resolveTriad(registry, { mode: 'balanced', now: NOW });
    assert.equal(triad.coder.id, 'deepseek-v4.1-flash');
    assert.equal(triad.reviewer.id, 'gemini-4-neon');
    assert.notEqual(triad.coder.family, triad.reviewer.family);
  });

  await tmp(async dir => {
    const registry = await loadFixture(dir, null, policy => {
      const balanced = policy.modes.balanced.candidates;
      // Первый reviewer google блокирует единственного arbiter (тоже google).
      // Полная тройка возможна только со вторым reviewer deepseek, и resolver
      // обязан выбрать её вместо частной тройки с первым reviewer.
      balanced.coder_default = ['swe-2-1-medium'];
      balanced.reviewer = ['gemini-4-neon', 'deepseek-v4.1-flash'];
      balanced.arbiter = ['gemini-4-neon'];
    });
    const triad = resolveTriad(registry, { mode: 'balanced', now: NOW });
    assert.equal(triad.reviewer.id, 'deepseek-v4.1-flash');
    assert.equal(triad.arbiter.id, 'gemini-4-neon');
    assert.equal(new Set([triad.coder.family, triad.reviewer.family, triad.arbiter.family]).size, 3);
  });
});

test('registrySnapshot: компактный срез моделей, contextual chains и triad', async () => {
  await tmp(async dir => {
    const registry = await loadFixture(dir);
    const snapshot = registrySnapshot(registry, { now: NOW });
    assert.equal(snapshot.mode, 'balanced');
    assert.equal(snapshot.models.length, 9);
    assert.equal(snapshot.models.find(m => m.id === 'gpt-6.2-sol').effectiveStatus, 'quota_paused');
    assert.ok(Array.isArray(snapshot.roles.coder_default));
    assert.equal(snapshot.triad.coder.family, 'cognition');
    assert.equal(snapshot.triad.reviewer.family, 'google');
    assert.equal(snapshot.roles.coder_default[0].id, snapshot.triad.coder.id);
    assert.equal(snapshot.roles.reviewer[0].id, snapshot.triad.reviewer.id);
    assert.equal(snapshot.roles.arbiter[0].id, snapshot.triad.arbiter.id);
    assert.equal(snapshot.roles.arbiter.some(entry => entry.family === snapshot.triad.reviewer.family), false);

    const conflict = await loadFixture(dir, null, policy => {
      for (const mode of Object.values(policy.modes)) {
        mode.candidates.reviewer = ['swe-2-1-high'];
      }
    });
    const conflictSnapshot = registrySnapshot(conflict, { now: NOW });
    assert.equal(conflictSnapshot.triad.reviewer, null);
    assert.deepEqual(conflictSnapshot.roles.reviewer, []);
  });
});

test('CLI list/effective --json работают без инициализации user config', async () => {
  await tmp(async dir => {
    const configDir = join(dir, 'config');
    const list = await runCli(['list', '--json', '--config-dir', configDir]);
    assert.equal(list.code, 0, list.stderr);
    assert.equal(JSON.parse(list.stdout).models.length, 9);

    const effective = await runCli(['effective', '--mode', 'economy', '--json', '--config-dir', configDir]);
    assert.equal(effective.code, 0, effective.stderr);
    const snap = JSON.parse(effective.stdout);
    assert.equal(snap.mode, 'economy');
    assert.equal(snap.triad.coder.family, 'cognition');
    assert.notEqual(snap.triad.coder.family, snap.triad.reviewer.family);
  });
});

test('CLI set/mode/add атомарно обновляют изолированный user config с mode 0600', async () => {
  await tmp(async dir => {
    const configDir = join(dir, 'config');
    const set = await runCli(['set', 'gemini-4-neon', 'standby', '--until', '2026-12-01',
      '--config-dir', configDir]);
    assert.equal(set.code, 0, set.stderr);
    const catalogPath = join(configDir, 'models-catalog.yaml');
    assert.equal((await stat(catalogPath)).mode & 0o777, 0o600);
    const catalog = parse(await readFile(catalogPath, 'utf8'));
    const neon = catalog.models.find(entry => entry.id === 'gemini-4-neon');
    assert.equal(neon.status, 'standby');
    assert.equal(neon.until, '2026-12-01');

    const mode = await runCli(['mode', 'sprint', '--config-dir', configDir]);
    assert.equal(mode.code, 0, mode.stderr);
    const policy = parse(await readFile(join(configDir, 'routing-policy.yaml'), 'utf8'));
    assert.equal(policy.mode, 'sprint');

    const add = await runCli(['add', '--id', 'test-model', '--provider', 'pi',
      '--model', 'vendor/test-model', '--family', 'openai', '--status', 'active',
      '--cost', 'subscription', '--capabilities', 'code,review', '--config-dir', configDir]);
    assert.equal(add.code, 0, add.stderr);
    const after = parse(await readFile(catalogPath, 'utf8'));
    assert.equal(after.models.some(entry => entry.id === 'test-model'), true);

    const duplicate = await runCli(['add', '--id', 'test-model', '--provider', 'pi',
      '--model', 'vendor/other', '--family', 'openai', '--config-dir', configDir]);
    assert.equal(duplicate.code, 1);
    assert.match(duplicate.stderr, /duplicate model id/);

    const invalid = await runCli(['add', '--id', '-bad', '--provider', 'pi',
      '--model', 'vendor/bad', '--family', 'openai', '--config-dir', configDir]);
    assert.equal(invalid.code, 1);
    const stillValid = await runCli(['check', '--config-dir', configDir]);
    assert.equal(stillValid.code, 0, stillValid.stderr);
  });
});

test('CLI check: 0 на валидном конфиге, 1 на битом или без cross-family reviewer', async () => {
  await tmp(async dir => {
    const configDir = join(dir, 'config');
    const init = await runCli(['mode', 'balanced', '--config-dir', configDir]);
    assert.equal(init.code, 0, init.stderr);
    const ok = await runCli(['check', '--config-dir', configDir]);
    assert.equal(ok.code, 0, ok.stderr);
    assert.equal(JSON.parse(ok.stdout).ok, true);

    await writeFile(join(configDir, 'models-catalog.yaml'), 'models: [broken\n');
    const bad = await runCli(['check', '--config-dir', configDir]);
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /model_registry_yaml_invalid/);
  });

  await tmp(async dir => {
    const paths = await fixture(dir, null, policy => {
      for (const mode of Object.values(policy.modes)) {
        mode.candidates.reviewer = ['swe-2-1-high'];
      }
    });
    const bad = await runCli(['check', '--config-dir', dir]);
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /no eligible reviewer/);
    assert.ok(paths.catalogPath.endsWith('models-catalog.yaml'));
  });
});


test('P1: не-строковый id отклоняется строгой схемой', async () => {
  await tmp(async dir => {
    for (const badId of [12345, true]) {
      const paths = await fixture(dir, catalog => { catalog.models[0].id = badId; });
      await assert.rejects(loadModelRegistry({ ...paths, now: NOW }), /model_catalog_invalid/);
    }
  });
});

test('P1: failed set на пустом configDir не создаёт файлы', async () => {
  await tmp(async dir => {
    const configDir = join(dir, 'config');
    const result = await runCli(['set', 'nonexistent', 'active', '--config-dir', configDir]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /unknown model id/);
    assert.deepEqual(await readdir(configDir), []);
  });
});

test('P1: половинчатый configDir fail-closed и не восстанавливается молча', async () => {
  await tmp(async dir => {
    const configDir = join(dir, 'config');
    await mkdir(configDir, { recursive: true });
    const paths = await fixture(configDir);
    const before = await readFile(paths.catalogPath, 'utf8');
    await rm(paths.policyPath);
    const result = await runCli(['set', 'gemini-4-neon', 'active', '--config-dir', configDir]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /model config incomplete/);
    assert.equal(await readFile(paths.catalogPath, 'utf8'), before);
    assert.deepEqual(await readdir(configDir), ['models-catalog.yaml']);
  });
});

test('P1: validation failure в staging не изменяет существующий живой конфиг', async () => {
  await tmp(async dir => {
    const paths = await fixture(dir, catalog => {
      for (let i = 0; catalog.models.length < 256; i += 1) {
        catalog.models.push({
          id: `extra-${i}`, provider: 'pi', model: `vendor/extra-${i}`, family: 'deepseek',
          status: 'active', cost_tier: 'subscription', capabilities: ['code'],
          quota_source: 'manual', notes: 'bulk fixture',
        });
      }
    });
    const before = await readFile(paths.catalogPath, 'utf8');
    const result = await runCli(['add', '--id', 'overflow-model', '--provider', 'pi',
      '--model', 'vendor/overflow', '--family', 'deepseek', '--config-dir', dir]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /model_catalog_invalid/);
    assert.equal(await readFile(paths.catalogPath, 'utf8'), before);
    assert.equal((await readdir(dir)).filter(name => name.includes('.tmp-')).length, 0);
  });

  await tmp(async dir => {
    const paths = await fixture(dir, catalog => {
      const targetSize = 256 * 1024 - 100;
      let low = 0;
      let high = 300000;
      let best = 0;
      while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        catalog.models[0].notes = 'x'.repeat(mid);
        const size = Buffer.byteLength(stringify(catalog), 'utf8');
        if (size <= targetSize) {
          best = mid;
          low = mid + 1;
        } else {
          high = mid - 1;
        }
      }
      catalog.models[0].notes = 'x'.repeat(best);
    });
    const before = await readFile(paths.catalogPath, 'utf8');
    assert.ok(Buffer.byteLength(before) < 256 * 1024, `fixture size ${Buffer.byteLength(before)}`);
    const result = await runCli(['add', '--id', 'huge-model', '--provider', 'pi',
      '--model', 'vendor/huge', '--family', 'deepseek', '--config-dir', dir]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /model_registry_file_invalid|model_catalog_invalid/);
    assert.equal(await readFile(paths.catalogPath, 'utf8'), before);
    assert.equal((await readdir(dir)).filter(name => name.includes('.tmp-')).length, 0);
  });

  await tmp(async dir => {
    const paths = await fixture(dir);
    const before = await readFile(paths.catalogPath, 'utf8');
    const result = await runCli(['add', '--id', 'bad-family', '--provider', 'pi',
      '--model', 'vendor/bad', '--family', 'martian', '--config-dir', dir]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /unknown family/);
    assert.equal(await readFile(paths.catalogPath, 'utf8'), before);
    assert.equal((await readdir(dir)).filter(name => name.includes('.tmp-')).length, 0);
  });
});

test('P2: неизвестный CLI flag отклоняется ненулевым exit без записи конфига', async () => {
  await tmp(async dir => {
    const configDir = join(dir, 'config');
    const result = await runCli(['set', 'gemini-4-neon', 'standby', '--untill', '2026-12-01',
      '--config-dir', configDir]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /unknown option --untill/);
    assert.equal((await readdir(dir)).includes('config'), false);
  });
});

test('P2: symlink родительского config dir допустим, symlink файла отклоняется', async () => {
  await tmp(async dir => {
    const real = join(dir, 'real-config');
    await mkdir(real, { recursive: true });
    const paths = await fixture(real);
    const linked = join(dir, 'linked-config');
    await symlink(real, linked, 'dir');
    const registry = await loadModelRegistry({ configDir: linked, now: NOW });
    assert.equal(registry.catalog.models.length, 9);

    const target = join(dir, 'catalog-target.yaml');
    await writeFile(target, await readFile(paths.catalogPath, 'utf8'));
    await rm(paths.catalogPath);
    await symlink(target, paths.catalogPath);
    await assert.rejects(loadModelRegistry({ configDir: linked, now: NOW }),
      /model_registry_file_invalid/);
  });
});

// Записи с прямыми L2-исполняемыми провайдерами: в example-каталоге
// google/anthropic модели идут через ACP-харнессы, а мост strictL2
// проверяется на прямой форме, реально запускаемой read-only раннером.
const L2_DIRECT_ENTRIES = [
  { id: 'neon-direct', provider: 'google', model: 'gemini-4-neon', family: 'google',
    status: 'active', cost_tier: 'subscription',
    capabilities: ['code', 'reasoning', 'vision', 'review'],
    quota_source: 'manual', notes: 'direct google neon fixture' },
  { id: 'sol-direct', provider: 'openai', model: 'gpt-6.2-sol', family: 'openai',
    status: 'active', cost_tier: 'subscription',
    capabilities: ['code', 'reasoning', 'review'],
    quota_source: 'manual', notes: 'direct openai sol fixture' },
  { id: 'glm-direct', provider: 'glm', model: 'glm-5.3-flash', family: 'glm',
    status: 'active', cost_tier: 'subscription',
    capabilities: ['code', 'reasoning', 'review'],
    quota_source: 'manual', notes: 'direct glm fixture' },
  // Сырой 'anthropic' — каноничная форма P1-дефекта: у L2-раннера нет egress
  // anthropic, запись неисполняема и обязана отфильтровываться мостом.
  { id: 'claude-direct', provider: 'anthropic', model: 'claude-opus-5.5', family: 'anthropic',
    status: 'active', cost_tier: 'subscription',
    capabilities: ['code', 'reasoning', 'review'],
    quota_source: 'manual', notes: 'direct anthropic claude fixture' },
];

test('isL2RunnableEntry: ключи PROVIDER_EGRESS, ACP-харнессы и сырой anthropic исключены', () => {
  // Позитивный список — точное зеркало ключей PROVIDER_EGRESS review-runner.
  assert.deepEqual([...L2_RUNNABLE_PROVIDERS],
    ['openai', 'google', 'deepseek', 'glm', 'cognition', 'opencode-go']);
  assert.ok(MODEL_FAMILIES.includes('glm'));
  for (const provider of ['openai', 'google', 'deepseek', 'glm', 'cognition', 'opencode-go']) {
    assert.equal(isL2RunnableEntry({ provider, model: 'm' }), true, provider);
  }
  // Сырой 'anthropic' неисполняем: у раннера нет egress anthropic — эмиссия
  // такого провайдера в routing.allowlist отклоняется route_critic_not_runnable.
  // Harness 'pi' без вложения и ACP-харнессы неисполняемы.
  for (const provider of ['anthropic', 'pi', 'acp-devin', 'acp-zcode-start', 'codex-acp', 'bb',
    'acp-antigravity-acp', 'agy', '', 'Google']) {
    assert.equal(isL2RunnableEntry({ provider, model: 'm' }), false, provider);
  }
  // pi-харнессы: исполняемость определяет вложение 'provider/model'.
  for (const model of ['openai/gpt-6.2-sol', 'opencode-go/deepseek-v4.1-flash',
    'google/gemini-4-neon', 'glm/glm-5.3-flash', 'OpenAI/gpt-6.2-sol']) {
    assert.equal(isL2RunnableEntry({ provider: 'pi', model }), true, model);
  }
  for (const model of ['anthropic/claude-opus-5.5', 'm', '/gpt-6.2-sol', '', 42, null]) {
    assert.equal(isL2RunnableEntry({ provider: 'pi', model }), false, String(model));
  }
  // Не-объект, пустой объект и нестроковый provider — неисполняемы.
  for (const bad of [null, undefined, {}, [], 'google', 42,
    { provider: 42 }, { model: 'm' }, { provider: null }]) {
    assert.equal(isL2RunnableEntry(bad), false, JSON.stringify(bad));
  }
  // Форма публичной записи цепочки (provider/model/family/...) — та же проверка.
  assert.equal(isL2RunnableEntry({ provider: 'pi', model: 'openai/gpt-6.2-sol',
    family: 'openai', status: 'active' }), true);
  // Запись glm-семейства валидна схемой каталога и исполняема напрямую.
  assert.equal(isL2RunnableEntry({ provider: 'glm', model: 'glm-5.3-flash',
    family: 'glm', status: 'active' }), true);
});

test('resolveTriad strictL2: ACP-харнессы отфильтрованы, Neon поднимает Sol арбитром', async () => {
  await tmp(async dir => {
    const registry = await loadFixture(dir, catalog => {
      catalog.models.push(...L2_DIRECT_ENTRIES.map(entry => ({ ...entry })));
      catalog.models.find(entry => entry.id === 'claude-opus-5.5').status = 'active';
    }, policy => {
      for (const mode of Object.values(policy.modes)) {
        mode.candidates.coder_default = ['deepseek-v4.1-flash'];
        mode.candidates.reviewer = ['claude-opus-5.5', 'neon-direct', 'claude-direct'];
        mode.candidates.arbiter = ['claude-opus-5.5', 'glm-direct', 'claude-direct', 'sol-direct'];
      }
    });
    // Дефолт strictL2=false — прежний контракт: reviewer ACP-харнесса
    // допустим резолвом (аудит-дефект воспроизводится и документируется).
    const loose = resolveTriad(registry, { mode: 'balanced', now: NOW });
    assert.equal(loose.reviewer.id, 'claude-opus-5.5');
    assert.equal(loose.reviewer.provider, 'acp-devin');

    const strict = resolveTriad(registry, { mode: 'balanced', now: NOW, strictL2: true });
    assert.equal(strict.coder.id, 'deepseek-v4.1-flash');
    // acp-devin кандидат отфильтрован: reviewer — первый L2-исполняемый.
    assert.equal(strict.reviewer.id, 'neon-direct');
    assert.ok(strict.reviewer.chain.every(isL2RunnableEntry));
    assert.ok(!strict.reviewer.chain.some(entry => entry.provider === 'acp-devin'));
    assert.ok(strict.arbiter.chain.every(isL2RunnableEntry));
    // Сырой anthropic неисполняем L2-раннером: claude-direct отфильтрован
    // механически, несмотря на активный статус и подходящее семейство.
    assert.ok(!strict.reviewer.chain.some(entry => entry.provider === 'anthropic'));
    assert.ok(!strict.arbiter.chain.some(entry => entry.provider === 'anthropic'));
    // При reviewer Neon арбитр Sol идёт первым, хотя общий порядок
    // кандидатов ставил glm-direct раньше.
    assert.equal(strict.arbiter.id, 'sol-direct');
    assert.deepEqual(strict.arbiter.chain.map(entry => entry.id),
      ['sol-direct', 'glm-direct']);

    // Sol на паузе по квоте — не допустим, приоритизация не действует:
    // арбитром остаётся следующий L2-исполняемый кандидат.
    const paused = resolveTriad(registry, { mode: 'balanced', now: NOW, strictL2: true,
      quotas: { 'sol-direct': 96 } });
    assert.equal(paused.reviewer.id, 'neon-direct');
    assert.equal(paused.arbiter.id, 'glm-direct');
  });
});

test('resolveTriad strictL2: без reviewer Neon порядок арбитра не переставляется', async () => {
  await tmp(async dir => {
    const registry = await loadFixture(dir, catalog => {
      catalog.models.push(...L2_DIRECT_ENTRIES.map(entry => ({ ...entry })));
    }, policy => {
      for (const mode of Object.values(policy.modes)) {
        mode.candidates.coder_default = ['deepseek-v4.1-flash'];
        mode.candidates.reviewer = ['glm-direct', 'neon-direct'];
        mode.candidates.arbiter = ['neon-direct', 'sol-direct', 'claude-direct'];
      }
    });
    const strict = resolveTriad(registry, { mode: 'balanced', now: NOW, strictL2: true });
    assert.equal(strict.reviewer.id, 'glm-direct');
    // Reviewer не Neon: кандидатный порядок режима сохраняется, Sol
    // искусственно не поднимается — первый допустимый arbiter Neon.
    // claude-direct (сырой anthropic) отфильтрован механически.
    assert.equal(strict.arbiter.id, 'neon-direct');
    assert.deepEqual(strict.arbiter.chain.map(entry => entry.id),
      ['neon-direct', 'sol-direct']);
  });
});

test('resolveTriad strictL2: reviewer=null при отсутствии L2-исполняемых кандидатов', async () => {
  await tmp(async dir => {
    const registry = await loadFixture(dir, null, policy => {
      for (const mode of Object.values(policy.modes)) {
        mode.candidates.coder_default = ['deepseek-v4.1-flash'];
        // Все кандидаты reviewer/arbiter — ACP-харнессы: strictL2 не
        // выдумывает исполняемость, тройка деградирует fail-closed.
        mode.candidates.reviewer = ['gemini-4-neon', 'claude-opus-5.5'];
        mode.candidates.arbiter = ['gemini-4-neon', 'claude-opus-5.5'];
      }
    });
    const strict = resolveTriad(registry, { mode: 'balanced', now: NOW, strictL2: true });
    assert.equal(strict.reviewer, null);
    // Без strictL2 те же кандидаты резолвятся — фильтр строго опционален.
    const loose = resolveTriad(registry, { mode: 'balanced', now: NOW });
    assert.notEqual(loose.reviewer, null);
  });
});

test('toPipelineAllowlist: worker без фильтра, critic/arbiter только L2-исполняемые', async () => {
  await tmp(async dir => {
    const registry = await loadFixture(dir, catalog => {
      catalog.models.push(...L2_DIRECT_ENTRIES.map(entry => ({ ...entry })));
    }, policy => {
      for (const mode of Object.values(policy.modes)) {
        mode.candidates.reviewer.push('neon-direct', 'glm-direct', 'claude-direct', 'sol-direct');
        mode.candidates.arbiter.push('neon-direct', 'glm-direct', 'claude-direct', 'sol-direct');
      }
    });
    const allowlist = toPipelineAllowlist(registry, { mode: 'balanced', now: NOW });
    assert.deepEqual(Object.keys(allowlist).sort(), ['arbiter', 'critic', 'worker']);
    // Каноническая форма спеки: ровно { provider, model }.
    for (const role of ['worker', 'critic', 'arbiter']) {
      assert.ok(Array.isArray(allowlist[role]), role);
      for (const spec of allowlist[role]) {
        assert.deepEqual(Object.keys(spec).sort(), ['model', 'provider'], role);
      }
    }
    // worker — полный харнесс: ACP-исполнители остаются; critic/arbiter —
    // только L2 read-only провайдеры.
    assert.ok(allowlist.worker.some(spec => spec.provider === 'acp-devin'));
    assert.deepEqual(allowlist.worker[0], { provider: 'acp-devin', model: 'swe-2-1-medium' });
    for (const role of ['critic', 'arbiter']) {
      assert.ok(!allowlist[role].some(spec => spec.provider.startsWith('acp-')), role);
      assert.ok(!allowlist[role].some(spec => spec.provider === 'bb'), role);
    }
    // gpt-6.2-sol example-записи на квота-паузе до 2026-11-27 и в пул не
    // входит; прямая sol-direct active — входит. Порядок — кандидатный
    // внутри status_priority. Сырой anthropic (claude-direct) в пул не
    // эмитируется: раннер отклонил бы его route_critic_not_runnable и
    // сломал всю политику роутинга — P1-дефект эмиссии устранён на мосту.
    assert.deepEqual(allowlist.critic, [
      { provider: 'pi', model: 'opencode-go/deepseek-v4.1-flash' },
      { provider: 'google', model: 'gemini-4-neon' },
      { provider: 'glm', model: 'glm-5.3-flash' },
      { provider: 'openai', model: 'gpt-6.2-sol' },
    ]);
    assert.ok(!allowlist.critic.some(spec => spec.provider === 'anthropic'));
    assert.ok(!allowlist.arbiter.some(spec => spec.provider === 'anthropic'));
    // Детерминизм повторного вызова и изоляция результатов.
    const again = toPipelineAllowlist(registry, { mode: 'balanced', now: NOW });
    assert.deepEqual(again, allowlist);
    // Квота механически убирает кандидата из пула.
    const paused = toPipelineAllowlist(registry, { mode: 'balanced', now: NOW,
      quotas: { 'deepseek-v4.1-flash': 96 } });
    assert.ok(!paused.critic.some(spec => spec.model.includes('deepseek')));
    assert.ok(paused.critic.some(spec => spec.provider === 'google'));
  });
});

test('toPipelineAllowlist: пустой пул при отсутствии L2-исполняемых кандидатов', async () => {
  await tmp(async dir => {
    const registry = await loadFixture(dir, null, policy => {
      for (const mode of Object.values(policy.modes)) {
        mode.candidates.reviewer = ['gemini-4-neon', 'claude-opus-5.5'];
        mode.candidates.arbiter = ['gemini-4-neon', 'claude-opus-5.5'];
      }
    });
    const allowlist = toPipelineAllowlist(registry, { mode: 'balanced', now: NOW });
    // Все кандидаты — ACP-харнессы: пулы критика и арбитра пусты fail-closed,
    // worker-пул при этом не затронут.
    assert.deepEqual(allowlist.critic, []);
    assert.deepEqual(allowlist.arbiter, []);
    assert.ok(allowlist.worker.length > 0);
  });

  await tmp(async dir => {
    // Вызов без опциональных параметров: дефолтный режим политики и
    // собственное время — детерминированная структура результата.
    const registry = await loadFixture(dir);
    const allowlist = toPipelineAllowlist(registry);
    assert.deepEqual(Object.keys(allowlist).sort(), ['arbiter', 'critic', 'worker']);
    assert.ok(Array.isArray(allowlist.worker));
  });
});
