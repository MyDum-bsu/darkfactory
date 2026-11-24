export const NEON_ISOLATION = 'docker-ro-pack+host-agy-rotools-v2';
export const NEON_CRITIC = Object.freeze({ provider: 'google', model: 'gemini-4-neon', reasoningLevel: 'medium' });
export const SOL_ARBITER = Object.freeze({ provider: 'openai', model: 'gpt-6.2-sol', reasoningLevel: 'medium' });

// Дефолтная пара без зачисленного keyring: исторический Pi/Sol-критик и
// Neon-арбитр через pi-egress (host-agy/keyring не нужен — арбитр идёт
// изолированным pi-раннером на egress generativelanguage.googleapis.com).
export const PI_SOL_CRITIC = Object.freeze({ provider: 'openai', model: 'gpt-6.2-sol', reasoningLevel: 'medium' });
export const NEON_PI_ARBITER = Object.freeze({ provider: 'google', model: 'gemini-4-neon', reasoningLevel: 'high' });

// Зачисление host-agy keyring: непустой DF_AGY_KEYRING_ITEM. Строгая форма
// пути и мост xdg-dbus-proxy проверяются самим транспортом — здесь только
// факт enrolment для выбора дефолтного профиля.
export function agyKeyringEnrolled(env = process.env) {
  return typeof env?.DF_AGY_KEYRING_ITEM === 'string' && env.DF_AGY_KEYRING_ITEM.trim() !== '';
}

// Дефолтные роли L2 (Board #1666 DF-OPS-1.5): Neon medium primary +
// Pi/Sol-арбитр — только при зачисленном keyring; без него дефолт
// остаётся Pi/Sol L2 с Neon-арбитром через pi. Явно выбранный Neon сюда
// не попадает: его fail-closed — agy_keyring_item_not_enrolled.
export function defaultReviewRoles(env = process.env) {
  return agyKeyringEnrolled(env)
    ? { critic: NEON_CRITIC, arbiter: SOL_ARBITER }
    : { critic: PI_SOL_CRITIC, arbiter: NEON_PI_ARBITER };
}

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
