import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { hostAgyTransport } from './agy-transport.mjs';
import { defaultReviewRoles, NEON_CRITIC, NEON_PI_ARBITER, PI_SOL_CRITIC,
  SOL_ARBITER } from './review-policy.mjs';
import { operatorReviewSetup } from './review-setup.mjs';

const KEYRING = '/org/freedesktop/secrets/collection/login/0';
const BB = { provider: 'acp-devin', model: 'swe-2-high' };
const NEON = { provider: 'google', model: 'gemini-4-neon', reasoningLevel: 'medium', skills: ['logika'] };
const PI_SOL = { provider: 'openai', model: 'gpt-6.2-sol', reasoningLevel: 'medium' };

const policyOf = (review, extra = {}) => ({
  bb: BB,
  profiles: { code: review === undefined ? {} : { review } },
  route: { checkProfile: 'code' },
  ...extra,
});

async function skillFiles(t) {
  const dir = await mkdtemp(join(tmpdir(), 'review-setup-skills-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'logika.md');
  await writeFile(path, 'review skill\n');
  return path;
}

// Board #1666 DF-OPS-1.5: дефолтный профиль (модель не закреплена) выбирает
// Neon medium + Sol-арбитр только при зачисленном DF_AGY_KEYRING_ITEM.
test('дефолтный профиль: keyring зачислен — Neon medium primary + Sol-арбитр', async t => {
  const skillPath = await skillFiles(t);
  const env = { DF_AGY_KEYRING_ITEM: KEYRING };
  assert.deepEqual(defaultReviewRoles(env), { critic: NEON_CRITIC, arbiter: SOL_ARBITER });
  // Профиль без review: дефолт выбирает Neon и наследует допустимую
  // операторскую привязку навыка из reviewSkillFiles.
  const setup = await operatorReviewSetup(
    policyOf(undefined, { reviewSkillFiles: { logika: skillPath } }), { env });
  assert.equal(setup.neon, true);
  assert.deepEqual(setup.critic, { ...NEON_CRITIC, skills: ['logika'] });
  assert.deepEqual(setup.arbiter, SOL_ARBITER);
  assert.deepEqual(setup.skillPaths, [skillPath]);
  // Явный список навыков в review сильнее дефолта.
  const pinned = await operatorReviewSetup(policyOf({ skills: ['logika'] },
    { reviewSkillFiles: { logika: skillPath } }), { env });
  assert.equal(pinned.neon, true);
  assert.deepEqual(pinned.skillPaths, [skillPath]);
  // Без допустимых операторских привязок — прежний fail-closed.
  await assert.rejects(operatorReviewSetup(policyOf(), { env }),
    /Invalid review skill binding/);
});

// Без keyring тот же дефолтный профиль остаётся Pi/Sol L2 с Neon-арбитром
// через pi-egress — ослабления или молчаливого Neon нет.
test('дефолтный профиль: keyring не зачислен — Pi/Sol L2 + Neon pi-арбитр', async t => {
  const skillPath = await skillFiles(t);
  for (const env of [{}, { DF_AGY_KEYRING_ITEM: '' }, { DF_AGY_KEYRING_ITEM: '   ' }]) {
    assert.deepEqual(defaultReviewRoles(env), { critic: PI_SOL_CRITIC, arbiter: NEON_PI_ARBITER });
    const policy = policyOf({ skills: ['logika'] }, { reviewSkillFiles: { logika: skillPath } });
    const setup = await operatorReviewSetup(policy, { env });
    assert.equal(setup.neon, false);
    assert.deepEqual(setup.critic, { ...PI_SOL_CRITIC, skills: ['logika'] });
    assert.deepEqual(setup.arbiter, NEON_PI_ARBITER);
  }
  // Профиль вообще без review — тот же Pi/Sol дефолт.
  const setup = await operatorReviewSetup(policyOf(), { env: {} });
  assert.equal(setup.neon, false);
  assert.deepEqual(setup.critic, PI_SOL_CRITIC);
  assert.deepEqual(setup.arbiter, NEON_PI_ARBITER);
});

// Явно выбранный Neon без keyring: профиль допускается, но транспорт
// остаётся строгим fail-closed agy_keyring_item_not_enrolled — без ослабления.
test('явный Neon без keyring — fail-closed agy_keyring_item_not_enrolled', async t => {
  const skillPath = await skillFiles(t);
  const policy = policyOf(NEON, { reviewSkillFiles: { logika: skillPath } });
  const setup = await operatorReviewSetup(policy, { env: {} });
  assert.equal(setup.neon, true);
  const dir = await mkdtemp(join(tmpdir(), 'review-setup-agy-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const binary = join(dir, 'agy');
  const scope = join(dir, 'scope');
  const snapshot = join(dir, 'snap');
  await writeFile(binary, '', { mode: 0o500 });
  await writeFile(scope, 'synthetic-provider-label', { mode: 0o600 });
  await mkdir(snapshot, { mode: 0o500 });
  try {
    await assert.rejects(hostAgyTransport({ snapshot, prompt: 'x',
      publishSnapshot: async () => {},
      env: { DF_AGY_BINARY: binary, DF_AGY_SCOPE_FILE: scope,
        DBUS_SESSION_BUS_ADDRESS: 'unix:path=/nonexistent-session-bus' } }),
      e => e.reason === 'agy_keyring_item_not_enrolled');
  } finally {
    await chmod(snapshot, 0o700);
  }
});

// Явный legacy Pi/Sol без keyring — прежний допуск без изменений; арбитр
// по умолчанию — третье семейство (Neon через pi), не конфликтный Sol.
test('явный Pi/Sol без keyring допускается', async () => {
  const setup = await operatorReviewSetup(policyOf(PI_SOL), { env: {} });
  assert.equal(setup.neon, false);
  assert.deepEqual(setup.critic, PI_SOL);
  assert.deepEqual(setup.arbiter, NEON_PI_ARBITER);
});
