// IIFE copy of the matching logic from core/matching.js + core/text.js.
// Content scripts can't use ES modules, so we expose everything on globalThis.
(function initMatchingScope(global) {
  function normalizeText(value) {
    let text = String(value || '')
      .normalize('NFKD')
      .toLowerCase()
      .replace(/\p{M}+/gu, '')
      .replace(/["\u201c\u201d'`]/g, '')
      .replace(/&/g, ' and ')
      .trim();

    text = text.replace(/^[-*•]+\s+/, '');
    text = text.replace(/^(?:\(?[\p{L}]\)|\d{1,2}\))\s+/iu, '');

    return text
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function fuzzyScore(a, b) {
    if (!a || !b) return 0;
    if (a === b) return 1;
    const wordsA = a.split(/\s+/).filter(Boolean);
    const wordsB = b.split(/\s+/).filter(Boolean);
    if (wordsA.length === 0 || wordsB.length === 0) return 0;
    const overlap = wordsA.filter(word => wordsB.includes(word)).length;
    const wordScore = overlap / Math.max(wordsA.length, wordsB.length);
    if (wordsA.length === 1 && wordsB.length === 1) return wordScore;
    if (a.includes(b) || b.includes(a)) return Math.max(wordScore, 0.88);
    return wordScore;
  }

  function isImagePlaceholder(value) {
    return /^image\s*\d+$/i.test(normalizeText(value));
  }

  function validateAnswerSet(currentChoices, answers, isMultiSelect) {
    if (!Array.isArray(currentChoices) || currentChoices.length === 0) return true;
    if (!Array.isArray(answers) || answers.length === 0) return false;

    const normalizedChoices = currentChoices.map(normalizeText).filter(Boolean);
    const normalizedAnswers = answers.map(normalizeText).filter(Boolean);
    if (normalizedAnswers.length === 0) return false;

    const usedChoiceIndexes = new Set();
    let matchedCount = 0;

    for (const answer of normalizedAnswers) {
      if (isImagePlaceholder(answer)) {
        const imageIdx = normalizedChoices.findIndex(
          (choice, idx) => !usedChoiceIndexes.has(idx) && /^image\s*\d+$/i.test(choice)
        );
        if (imageIdx >= 0) {
          usedChoiceIndexes.add(imageIdx);
          matchedCount += 1;
        }
        continue;
      }

      const ranked = normalizedChoices
        .map((choice, idx) => ({
          idx,
          score: fuzzyScore(answer, choice),
          exact: choice === answer,
          includes: choice.includes(answer) || answer.includes(choice)
        }))
        .filter(candidate => !usedChoiceIndexes.has(candidate.idx))
        .sort((a, b) => (Number(b.exact) - Number(a.exact)) || (b.score - a.score));

      const best = ranked[0];
      if (!best) continue;

      if (best.exact || best.score >= 0.85 || (best.includes && best.score >= 0.7)) {
        usedChoiceIndexes.add(best.idx);
        matchedCount += 1;
      }
    }

    if (isMultiSelect) return matchedCount === normalizedAnswers.length;
    return matchedCount >= 1;
  }

  function matchScore(buttonText, answer) {
    const a = normalizeText(buttonText);
    const b = normalizeText(answer);
    if (!a || !b) return 0;
    if (a === b) return 100;
    return Math.round(fuzzyScore(a, b) * 100);
  }

  function computeTileOrder(answer, tiles) {
    const answerLower = String(answer || '').toLowerCase().replace(/[\s\-]/g, '');
    const tilesLower = (tiles || []).map(tile => String(tile || '').toLowerCase().replace(/[\s\-]/g, ''));
    const used = new Set();
    const order = [];
    let pos = 0;

    while (pos < answerLower.length && order.length < tilesLower.length) {
      let found = false;
      const candidates = tilesLower.map((text, idx) => ({ text, idx, len: text.length }))
        .filter(candidate => !used.has(candidate.idx))
        .sort((a, b) => b.len - a.len);

      for (const candidate of candidates) {
        if (answerLower.startsWith(candidate.text, pos)) {
          order.push(candidate.idx);
          used.add(candidate.idx);
          pos += candidate.text.length;
          found = true;
          break;
        }
      }
      if (!found) break;
    }

    if (order.length === tilesLower.length && pos === answerLower.length) return order;
    if (tilesLower.length > 8) return null;

    function permute(remaining, current) {
      if (remaining.length === 0) return current.map(index => tilesLower[index]).join('') === answerLower ? current : null;
      for (let i = 0; i < remaining.length; i += 1) {
        const next = [...current, remaining[i]];
        if (!answerLower.startsWith(next.map(index => tilesLower[index]).join(''))) continue;
        const result = permute([...remaining.slice(0, i), ...remaining.slice(i + 1)], next);
        if (result) return result;
      }
      return null;
    }

    return permute(tilesLower.map((_, idx) => idx), []);
  }

  global.kAIhootMatching = {
    validateAnswerSet,
    matchScore,
    computeTileOrder
  };
})(globalThis);
