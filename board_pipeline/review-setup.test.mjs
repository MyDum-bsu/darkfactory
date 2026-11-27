import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { hostAgyTransport } from './agy-transport.mjs';
import { defaultReviewRoles, NEON_CRITIC, NEON_PI_ARBITER, OPUS_ARBITER, PI_SOL_CRITIC,
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

// Board #1666 DF-OPS-1.5 r2: pinAttemptTriad — триада попытки поверх
// resolveTriad. Дефолтный Neon medium доходит до L2 с привязкой навыка
// (спеки allowlist её не несут), а явный Neon без keyring — fail-closed до
// spawn, без подмены другим критиком.
import { pinAttemptTriad } from './review-setup.mjs';

const DEEPSEEK = { provider: 'acp-antigravity-acp', model: 'deepseek-reasoner', reasoningLevel: 'medium' };
const ALLOWLIST_NEON = { provider: 'acp-antigravity-acp', model: 'gemini-4-neon' };

test('pinAttemptTriad: выбранный роутингом Neon наследует навыки допуска', () => {
  const routed = { outcome: 'routed', plan: [BB],
    selected: { worker: BB, critic: ALLOWLIST_NEON, arbiter: SOL_ARBITER } };
  const pinned = pinAttemptTriad({ routed, reviewSetup: { critic: { ...NEON_CRITIC, skills: ['logika'] }, arbiter: SOL_ARBITER },
    env: { DF_AGY_KEYRING_ITEM: KEYRING } });
  assert.deepEqual(pinned.critic, { ...ALLOWLIST_NEON, skills: ['logika'] });
  assert.deepEqual(pinned.arbiter, SOL_ARBITER);
  assert.deepEqual(pinned.plan, [BB]);
  // Собственный список навыков у выбранного критика сильнее привязки setup.
  const own = { ...ALLOWLIST_NEON, skills: ['logika'] };
  assert.deepEqual(pinAttemptTriad({ routed: { ...routed, selected: { worker: BB, critic: own, arbiter: SOL_ARBITER } },
    reviewSetup: { critic: { ...NEON_CRITIC, skills: ['chukovsky'] }, arbiter: SOL_ARBITER },
    env: { DF_AGY_KEYRING_ITEM: KEYRING } }).critic, own);
});

test('pinAttemptTriad: явный Neon без keyring — fail-closed до spawn', () => {
  // Скоркард выбирает DeepSeek, но подмена явно закреплённого Neon без
  // зачисленного DF_AGY_KEYRING_ITEM не допускается.
  const routed = { outcome: 'routed', plan: [BB],
    selected: { worker: BB, critic: DEEPSEEK, arbiter: SOL_ARBITER } };
  const reviewSetup = { critic: { ...NEON_CRITIC, skills: ['logika'] }, arbiter: SOL_ARBITER };
  assert.deepEqual(pinAttemptTriad({ routed, reviewSetup, env: {} }),
    { outcome: 'rejected', reason: 'agy_keyring_item_not_enrolled' });
  // Выбранный роутингом Neon без keyring — тот же отказ до spawn.
  assert.deepEqual(pinAttemptTriad({ routed: { ...routed, selected: { worker: BB, critic: ALLOWLIST_NEON, arbiter: SOL_ARBITER } },
    reviewSetup, env: { DF_AGY_KEYRING_ITEM: '' } }),
    { outcome: 'rejected', reason: 'agy_keyring_item_not_enrolled' });
  // С keyring явный Neon допускается; незачисленный Neon не блокирует
  // legacy Pi/Sol-маршрут.
  const piSetup = { critic: PI_SOL, arbiter: NEON_PI_ARBITER };
  assert.equal(pinAttemptTriad({ routed: { outcome: 'routed', plan: [BB],
      selected: { worker: BB, critic: PI_SOL, arbiter: NEON_PI_ARBITER } },
    reviewSetup: piSetup, env: {} }).critic.provider, 'openai');
  assert.equal(pinAttemptTriad({ routed: { outcome: 'rejected', reason: 'x' }, reviewSetup: piSetup, env: {} }).outcome, 'rejected');
});

test('headless DF_AGY_OAUTH_TOKEN_FILE enrolls Neon, enforces 0600, and revokes staged token on sealBootstrap', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'df-agy-token-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const binary = join(dir, 'agy');
  const token = join(dir, 'antigravity-oauth-token');
  const snapshot = join(dir, 'snapshot');
  await writeFile(binary, '#!/bin/sh\n', { mode: 0o700 });
  await writeFile(token, '{"access_token":"synthetic"}\n', { mode: 0o600 });
  await mkdir(snapshot, { mode: 0o500 });
  t.after(() => chmod(snapshot, 0o700).catch(() => {}));

  const skillPath = await skillFiles(t);
  const setup = await operatorReviewSetup(
    policyOf(undefined, { reviewSkillFiles: { logika: skillPath } }),
    { env: { DF_AGY_OAUTH_TOKEN_FILE: token } },
  );
  assert.equal(setup.neon, true);
  assert.deepEqual(setup.critic, { ...NEON_CRITIC, skills: ['logika'] });

  let stagedExistsBefore = false;
  let stagedExistsAfter = true;
  let dbusEnv = 'unset';
  await hostAgyTransport({
    snapshot,
    publishSnapshot: async () => {},
    prompt: 'synthetic',
    env: { DF_AGY_BINARY: binary, DF_AGY_OAUTH_TOKEN_FILE: token, DF_MODEL_PROXY_DIRECT: '1' },
    launch: async req => {
      dbusEnv = req.env.DBUS_SESSION_BUS_ADDRESS;
      const stagedPath = join(req.env.HOME, '.gemini', 'antigravity-cli', 'antigravity-oauth-token');
      stagedExistsBefore = await lstat(stagedPath).then(() => true, () => false);
      await req.sealBootstrap();
      stagedExistsAfter = await lstat(stagedPath).then(() => true, () => false);
      return { stdout: '{}', stderr: '', code: 0 };
    },
  });
  assert.equal(dbusEnv, undefined);
  assert.equal(stagedExistsBefore, true);
  assert.equal(stagedExistsAfter, false);

  await chmod(token, 0o644);
  await assert.rejects(
    hostAgyTransport({
      snapshot,
      publishSnapshot: async () => {},
      prompt: 'synthetic',
      env: { DF_AGY_BINARY: binary, DF_AGY_OAUTH_TOKEN_FILE: token, DF_MODEL_PROXY_DIRECT: '1' },
      launch: async () => assert.fail('must not launch with group/world readable token'),
    }),
    err => err?.reason === 'agy_oauth_token_not_enrolled',
  );
});

// Board #11994: first-class OpenAI-воркер (pi + openai/gpt-6.2-astra) на
// Neon-reviewed маршруте. Sol-арбитр (openai) конфликтует с исполнителем по
// семейству, поэтому утверждён Opus-арбитр (agy/claude-opus-5.5, anthropic) —
// триада openai/google/anthropic остаётся строго независимой.
const PI_ASTRA = { provider: 'pi', model: 'openai/gpt-6.2-astra' };

test('OpenAI-воркер + Neon-критик + Opus-арбитр допускается (строгая триада)', async t => {
  const skillPath = await skillFiles(t);
  const env = { DF_AGY_KEYRING_ITEM: KEYRING };
  for (const reasoningLevel of ['medium', 'high']) {
    const arbiter = { provider: 'agy', model: 'claude-opus-5.5', reasoningLevel };
    const policy = policyOf(NEON, { bb: PI_ASTRA, arbiter, reviewSkillFiles: { logika: skillPath } });
    const setup = await operatorReviewSetup(policy, { env });
    assert.equal(setup.neon, true);
    assert.deepEqual(setup.arbiter, arbiter);
    assert.deepEqual(setup.critic, NEON);
    assert.deepEqual(setup.skillPaths, [skillPath]);
  }
  // Экспортируемая константа OPUS_ARBITER (medium) — тот же допуск.
  const setup = await operatorReviewSetup(
    policyOf(NEON, { bb: PI_ASTRA, arbiter: OPUS_ARBITER, reviewSkillFiles: { logika: skillPath } }), { env });
  assert.deepEqual(setup.arbiter, OPUS_ARBITER);
  // Opus-арбитр не привязан к openai-исполнителю: cognition-воркер под Neon
  // с Opus — тоже строгая триада (cognition/google/anthropic).
  const cognition = await operatorReviewSetup(
    policyOf(NEON, { arbiter: OPUS_ARBITER, reviewSkillFiles: { logika: skillPath } }), { env });
  assert.equal(cognition.neon, true);
  assert.deepEqual(cognition.arbiter, OPUS_ARBITER);
  // Прежнее поведение сохраняется: cognition-воркер + Neon + Sol проходит.
  const legacy = await operatorReviewSetup(
    policyOf(NEON, { arbiter: SOL_ARBITER, reviewSkillFiles: { logika: skillPath } }), { env });
  assert.deepEqual(legacy.arbiter, SOL_ARBITER);
});

test('OpenAI-воркер + Neon-критик + Sol-арбитр отклоняется: arbiter_family_not_independent', async t => {
  const skillPath = await skillFiles(t);
  const env = { DF_AGY_KEYRING_ITEM: KEYRING };
  // Явно закреплённый Sol-арбитр — тот же отказ, что и до допуска Opus:
  // семейство openai совпадает с семейством исполнителя.
  for (const arbiter of [SOL_ARBITER, { provider: 'openai', model: 'gpt-6.2-sol', reasoningLevel: 'high' }]) {
    const policy = policyOf(NEON, { bb: PI_ASTRA, arbiter, reviewSkillFiles: { logika: skillPath } });
    await assert.rejects(operatorReviewSetup(policy, { env }),
      e => e.reason === 'arbiter_family_not_independent');
  }
  // Дефолтный (незакреплённый) арбитр Neon-маршрута — Sol: для OpenAI-воркера
  // он отклоняется той же независимостью триады, молчаливого ослабления нет.
  const unpinned = policyOf(NEON, { bb: PI_ASTRA, reviewSkillFiles: { logika: skillPath } });
  await assert.rejects(operatorReviewSetup(unpinned, { env }),
    e => e.reason === 'arbiter_family_not_independent');
});

test('Neon-маршрут: неутверждённый арбитр отклоняется прежней ошибкой допуска', async t => {
  const skillPath = await skillFiles(t);
  const env = { DF_AGY_KEYRING_ITEM: KEYRING };
  const unapproved = [
    // Формально независимое семейство, но не Sol и не Opus — допуска нет.
    { provider: 'acp-devin', model: 'swe-2-high', reasoningLevel: 'medium' },
    { provider: 'deepseek', model: 'deepseek-v4', reasoningLevel: 'medium' },
    // Opus-модель вне agy-провайдера или с неподходящим reasoningLevel.
    { provider: 'pi', model: 'agy/claude-opus-5.5', reasoningLevel: 'medium' },
    { provider: 'agy', model: 'claude-opus-5.5', reasoningLevel: 'low' },
    { provider: 'agy', model: 'claude-opus-5.5' },
    // Прочие формы: Astra, сам Neon, произвольный и пустой спеки.
    { provider: 'openai', model: 'gpt-6.2-astra', reasoningLevel: 'medium' },
    NEON_PI_ARBITER,
    { provider: 'unknown', model: 'mystery', reasoningLevel: 'medium' },
    {},
  ];
  for (const arbiter of unapproved) {
    for (const bb of [BB, PI_ASTRA]) {
      const policy = policyOf(NEON, { bb, arbiter, reviewSkillFiles: { logika: skillPath } });
      await assert.rejects(operatorReviewSetup(policy, { env }),
        /Neon requires a subject-bound queue route, fingerprinted policy and Sol arbiter/);
    }
  }
});
