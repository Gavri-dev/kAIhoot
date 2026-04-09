// Shared text helpers. Keep in sync with the copy in content-matching.js.

export function normalizeText(value) {
  let text = String(value || '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/\p{M}+/gu, '')
    .replace(/["\u201c\u201d'`]/g, '')
    .replace(/&/g, ' and ')
    .trim();

  // Strip the obvious quiz-style prefixes, but leave initials alone.
  text = text.replace(/^[-*•]+\s+/, '');
  text = text.replace(/^(?:\(?[\p{L}]\)|\d{1,2}\))\s+/iu, '');

  return text
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function shortText(value, max = 60) {
  const text = String(value || '');
  return text.length > max ? `${text.slice(0, Math.max(0, max - 3))}...` : text;
}

export function fuzzyScore(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;

  const wordsA = a.split(/\s+/).filter(Boolean);
  const wordsB = b.split(/\s+/).filter(Boolean);
  if (wordsA.length === 0 || wordsB.length === 0) return 0;

  const overlap = wordsA.filter(word => wordsB.includes(word)).length;
  const wordScore = overlap / Math.max(wordsA.length, wordsB.length);

  // A single word that only partially overlaps is usually too risky to trust.
  if (wordsA.length === 1 && wordsB.length === 1) return wordScore;

  if (a.includes(b) || b.includes(a)) return Math.max(wordScore, 0.88);
  return wordScore;
}
