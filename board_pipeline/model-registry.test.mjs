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
  loadModelRegistry,
  registrySnapshot,
  resolveRoleChain,
  resolveTriad,
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
