// Операторский допуск L2-ревью: утверждённый критик (Neon или legacy Pi/Sol),
// файлы скиллов по каноническим путям и независимость триады. Выделено из
// run-isolated, чтобы детерминированные тесты проверяли реальный путь
// политики без подъёма всего контроллера.
import { realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { defaultReviewRoles, isLegacyPiReview, isNeonReview, isReviewSkillList,
  isSolArbiter, NEON_PI_ARBITER, SOL_ARBITER } from './review-policy.mjs';
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
  // критика: Neon-критик требует Sol-арбитра (совместимость acceptHeld),
  // Pi/Sol-критик — Neon-арбитр через pi.
  const arbiter = policy.arbiter ?? (neon ? SOL_ARBITER : NEON_PI_ARBITER);
  if (neon && (!isSolArbiter(arbiter) || policy.route.taskId !== undefined || policy.policyDigest !== undefined)) {
    throw new Error('Neon requires a subject-bound queue route, fingerprinted policy and Sol arbiter');
  }
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
