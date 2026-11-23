// Операторский допуск L2-ревью: утверждённый критик (Neon или legacy Pi/Sol),
// файлы скиллов по каноническим путям и независимость триады. Выделено из
// run-isolated, чтобы детерминированные тесты проверяли реальный путь
// политики без подъёма всего контроллера.
import { realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { isLegacyPiReview, isNeonReview, isReviewSkillList, isSolArbiter } from './review-policy.mjs';
import * as workerSelector from './worker-selector.mjs';

export async function operatorReviewSetup(policy) {
  const critic = policy.profiles?.[policy.route.checkProfile]?.review;
  const arbiter = policy.arbiter ?? workerSelector.DEFAULT_ARBITER;
  const neon = isNeonReview(critic);
  if (!neon && !isLegacyPiReview(critic)) throw new Error('Review profile is not approved');
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
