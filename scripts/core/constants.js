// Shared defaults and thresholds. Popup and service worker both import these.

export const DEFAULT_MODEL = 'gpt-5-mini';
export const DEFAULT_VISION_MODEL = 'gpt-4.1';
export const DEPRECATED_MODELS = new Set([
  'gpt-4o-mini', 'gpt-4o', 'gpt-3.5-turbo', 'gpt-4-turbo',
  'gpt-4', 'gpt-4-1106-preview', 'gpt-4-0125-preview',
  'gpt-4.5-preview', 'o1', 'o1-mini', 'o1-preview', 'o3-mini'
]);
export const MIN_TEXT_MATCH_SCORE = 0.85;
