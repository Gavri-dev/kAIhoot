// Shared defaults and thresholds. Popup and service worker both import these.

export const DEFAULT_MODEL = 'gpt-6-luna';
export const DEFAULT_VISION_MODEL = 'gpt-6.1-terra';
export const DEPRECATED_MODELS = new Set([
  // Legacy models retired before the GPT-6 era.
  'gpt-4o-mini', 'gpt-4o', 'gpt-3.5-turbo', 'gpt-4-turbo',
  'gpt-4', 'gpt-4-1106-preview', 'gpt-4-0125-preview',
  'gpt-4.5-preview', 'o1', 'o1-mini', 'o1-preview', 'o3-mini',
  // GPT-5 / GPT-4.1 lines retired or retiring; anyone still on these
  // auto-migrates to DEFAULT_MODEL / DEFAULT_VISION_MODEL.
  'gpt-5', 'gpt-5-mini', 'gpt-5-nano',
  'gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano',
  'gpt-5.1'
]);
export const MIN_TEXT_MATCH_SCORE = 0.85;

// A "classic" (non-reasoning) model takes temperature + max_tokens + a system
// role. Everything else — gpt-5*, gpt-6*, the o-series, and anything newer — is
// a reasoning model: developer role, max_completion_tokens, reasoning_effort,
// and NO temperature/top_p (the API 400s on sampling params when effort != none).
// We allow-list the known classic families so brand-new model ids default to
// modern reasoning behavior instead of silently breaking.
const CLASSIC_MODEL_PREFIX = /^(?:gpt-4|gpt-3|text-|davinci|babbage|curie|ada)/i;

export function isReasoningModel(model) {
  const name = String(model || '').trim();
  if (!name) return true;
  return !CLASSIC_MODEL_PREFIX.test(name);
}

// Reasoning-effort support differs across reasoning models: the GPT-5 family
// accepts 'minimal', but GPT-6 and newer start at 'low'. Clamp 'minimal' to the
// universally-supported 'low' for anything outside the GPT-5 family so requests
// don't 400 on an unsupported effort value.
export function normalizeReasoningEffort(model, effort) {
  const name = String(model || '').trim().toLowerCase();
  if (effort === 'minimal' && !/^gpt-5/.test(name)) return 'low';
  return effort;
}
