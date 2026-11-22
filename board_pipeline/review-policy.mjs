export const NEON_ISOLATION = 'docker-ro-pack+host-agy-notool-v1';
export const NEON_CRITIC = Object.freeze({ provider: 'google', model: 'gemini-4-neon', reasoningLevel: 'medium' });
export const SOL_ARBITER = Object.freeze({ provider: 'openai', model: 'gpt-6.2-sol', reasoningLevel: 'medium' });

const SKILLS = new Set(['logika', 'humanizer']);
const LEGACY_PI_MODELS = new Set(['gpt-6.2-sol', 'gpt-6.2-astra']);

export function isLegacyPiReview(review) {
  return review?.provider === 'openai' && review.reasoningLevel === 'medium' && LEGACY_PI_MODELS.has(review.model);
}

export function isNeonReview(review) {
  return Object.entries(NEON_CRITIC).every(([key, value]) => review?.[key] === value);
}

export function isSolArbiter(arbiter) {
  return arbiter?.provider === SOL_ARBITER.provider && arbiter.model === SOL_ARBITER.model &&
    ['medium', 'high'].includes(arbiter.reasoningLevel);
}

export function isReviewSkillList(skills) {
  return Array.isArray(skills) && skills.length > 0 && new Set(skills).size === skills.length &&
    skills.every(skill => SKILLS.has(skill));
}
