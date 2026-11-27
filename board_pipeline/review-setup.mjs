// Операторский допуск L2-ревью: утверждённый критик (Neon или legacy Pi/Sol),
// файлы скиллов по каноническим путям и независимость триады. Выделено из
// run-isolated, чтобы детерминированные тесты проверяли реальный путь
// политики без подъёма всего контроллера.
import { realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { agyKeyringEnrolled, defaultReviewRoles, isLegacyPiReview, isNeonArbiter, isNeonReview,
  isReviewSkillList, NEON_PI_ARBITER, SOL_ARBITER } from './review-policy.mjs';
import { l2CriticSpec } from './review-runner.mjs';
import * as workerSelector from './worker-selector.mjs';

export async function operatorReviewSetup(policy, { env = process.env } = {}) {
  const configured = policy.profiles?.[policy.route.checkProfile]?.review;
  // Дефолтный профиль (Board #1666 DF-OPS-1.5): незакреплённые поля review
  // решает зачисление DF_AGY_KEYRING_ITEM — Neon medium + Sol-арбитр при
  // зачисленном keyring, иначе Pi/Sol L2 + Neon-арбитр через pi-egress.
  // Явно закреплённые поля профиля сильнее дефолта.
  const roles = defaultReviewRoles(env);
  const critic = { ...roles.critic, ...(configured ?? {}) };
  const neon = isNeonReview(critic);
  // Явно выбранный Neon допускается профилем; его fail-closed без
  // зачисленного keyring остаётся у транспорта — agy_keyring_item_not_enrolled,
  // ослабления нет.
  if (!neon && !isLegacyPiReview(critic)) throw new Error('Review profile is not approved');
  // Арбитр по умолчанию — третье независимое семейство под фактического
  // критика: Neon-критик допускает утверждённого Sol- или Opus-арбитра
  // (Board #11994; совместимость acceptHeld для Sol сохраняется), Pi/Sol-критик —
  // Neon-арбитр через pi. Конкретный выбор ограничен строгой независимостью
  // триады: OpenAI-исполнитель под Neon требует Opus-арбитра, Sol остаётся
  // допустимым для исполнителей не-openai семейств.
  const arbiter = policy.arbiter ?? (neon ? SOL_ARBITER : NEON_PI_ARBITER);
  if (neon && (!isNeonArbiter(arbiter) || policy.route.taskId !== undefined || policy.policyDigest !== undefined)) {
    throw new Error('Neon requires a subject-bound queue route, fingerprinted policy and Sol arbiter');
  }
  // Незакреплённый список навыков Neon-критика: дефолт наследует все
  // допустимые привязки оператора (reviewSkillFiles) и фиксируется в самом
  // критике — пустой набор остаётся fail-closed 'Invalid review skill binding'.
  const bound = Object.keys(policy.reviewSkillFiles ?? {}).filter(skill => isReviewSkillList([skill]));
  if (critic.skills === undefined && neon && bound.length) critic.skills = bound;
  const skills = critic.skills;
  if ((neon || skills !== undefined) && !isReviewSkillList(skills)) throw new Error('Invalid review skill binding');
  const skillPaths = await Promise.all((skills ?? []).map(skill => {
    const path = policy.reviewSkillFiles?.[skill];
    if (!isAbsolute(path ?? '')) throw new Error(`Missing operator review skill: ${skill}`);
    return realpath(path);
  }));
  workerSelector.assertTriadIndependent({ executor: policy.bb, critic, arbiter });
  return { critic, arbiter, neon, skills: skills ?? [], skillPaths };
}

// Триада попытки поверх resolveTriad (Board #1666 DF-OPS-1.5 r2). Два
// дополнительных правила к прозрачному откату routed.selected:
// 1. Навыки Neon-критика — операторская привязка из допуска setup: спеки
//    allowlist/скоркарда их не несут, и без возврата привязки acceptHeld
//    отклонит профиль приёмки (denied / review_profile_not_approved).
// 2. Явно выбранный или выбранный роутингом Neon без зачисленного
//    DF_AGY_KEYRING_ITEM — fail-closed agy_keyring_item_not_enrolled до
//    spawn: подмена другим критиком не допускается.
export function pinAttemptTriad({ routed, reviewSetup, env = process.env } = {}) {
  if (routed?.outcome === 'rejected') return { outcome: 'rejected', reason: routed.reason };
  const critic = routed.selected.critic ?? reviewSetup.critic;
  const arbiter = routed.selected.arbiter ?? reviewSetup.arbiter;
  const neonCritic = isNeonReview(l2CriticSpec(critic,
    { defaultReasoningLevel: reviewSetup.critic?.reasoningLevel }));
  const configuredNeon = isNeonReview(l2CriticSpec(reviewSetup.critic));
  if ((neonCritic || configuredNeon) && !agyKeyringEnrolled(env)) {
    return { outcome: 'rejected', reason: 'agy_keyring_item_not_enrolled' };
  }
  const skills = reviewSetup.critic?.skills;
  const pinnedCritic = neonCritic && critic.skills === undefined && Array.isArray(skills) && skills.length
    ? { ...critic, skills } : critic;
  return { plan: routed.plan, critic: pinnedCritic, arbiter };
}
