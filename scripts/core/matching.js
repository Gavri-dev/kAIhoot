import { MIN_TEXT_MATCH_SCORE } from './constants.js';
import { fuzzyScore, normalizeText } from './text.js';

// Answer matching and parsing. Used by the service worker (via imports) and
// mirrored in content-matching.js for the content script context.
function isImagePlaceholder(value) {
  return /^image\s*\d+$/i.test(normalizeText(value));
}

// Single-select can tolerate extra model output. Multi-select cannot.
export function validateAnswerSet(currentChoices, answers, isMultiSelect = false) {
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

    if (best.exact || best.score >= MIN_TEXT_MATCH_SCORE || (best.includes && best.score >= 0.7)) {
      usedChoiceIndexes.add(best.idx);
      matchedCount += 1;
    }
  }

  if (isMultiSelect) return matchedCount === normalizedAnswers.length;
  return matchedCount >= 1;
}

export function selectBestChoice(rawAnswer, choices) {
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new Error(`No choices to match against for answer: "${rawAnswer}"`);
  }

  const cleaned = normalizeText(rawAnswer);
  if (!cleaned) return choices[0];

  const exact = choices.find(choice => normalizeText(choice) === cleaned);
  if (exact) return exact;

  const substringMatch = choices.find(choice => {
    const normalizedChoice = normalizeText(choice);
    return normalizedChoice && (normalizedChoice.includes(cleaned) || cleaned.includes(normalizedChoice));
  });
  if (substringMatch) return substringMatch;

  const scored = choices
    .map(choice => ({ choice, score: fuzzyScore(cleaned, normalizeText(choice)) }))
    .sort((a, b) => b.score - a.score);

  // Always return the best-guess — caller can decide what to do with a low-confidence answer.
  return scored[0]?.choice ?? choices[0];
}

export function parseMultiSelectResponse(raw, choices) {
  const text = String(raw || '');
  const lines = text.split('\n');

  // First preference: strict "1:YES" / "2:NO" per-line format.
  const yesNums = [];
  for (const line of lines) {
    const match = line.match(/(\d+)\s*:\s*(YES|Y)\b/i);
    if (!match) continue;
    const number = parseInt(match[1], 10);
    if (number >= 1 && number <= choices.length) yesNums.push(number);
  }

  if (yesNums.length > 0) {
    const unique = [...new Set(yesNums)].sort((a, b) => a - b);
    return unique.map(number => choices[number - 1]);
  }

  // Fallback: extract any valid option numbers from the text. Matches v3.4.0.
  const nums = [...text.matchAll(/\b\d+\b/g)].map(match => parseInt(match[0], 10));
  const validNums = [...new Set(nums.filter(number => number >= 1 && number <= choices.length))].sort((a, b) => a - b);
  if (validNums.length > 0) {
    return validNums.map(number => choices[number - 1]);
  }

  throw new Error(`Could not parse multi-select answer: "${raw}"`);
}

// Vision models sometimes leave a final note after the coordinates, so scan the
// tail of the response instead of trusting the last line only.
export function parsePinCoordinates(raw) {
  const lines = String(raw || '').trim().split(/\n+/).map(line => line.trim()).filter(Boolean);
  const finalLine = lines.at(-1) || '';
  let match = finalLine.match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);

  if (!match) {
    const coordinateLines = lines.filter(line => /^-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?$/.test(line.trim()));
    if (coordinateLines.length === 1) {
      match = coordinateLines[0].match(/(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/);
    }
  }

  if (!match) {
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 3); i -= 1) {
      match = lines[i].match(/(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/);
      if (match) break;
    }
  }

  if (!match) {
    throw new Error(`Could not parse coordinates from model output: "${raw}"`);
  }

  const x = parseFloat(match[1]);
  const y = parseFloat(match[2]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error(`Could not parse coordinates from model output: "${raw}"`);
  }

  // Only reject truly garbage values (e.g. 999,-500). Near-edge overshoots get clamped.
  if (x < -50 || x > 150 || y < -50 || y > 150) {
    throw new Error(`Pin coordinates out of range: ${x},${y}`);
  }

  return {
    x: Math.max(0, Math.min(100, x)),
    y: Math.max(0, Math.min(100, y))
  };
}

export function snapSliderValue(value, sliderConfig = {}) {
  const { min, max, step } = sliderConfig;
  let next = Number(value);
  if (!Number.isFinite(next)) throw new Error(`Invalid slider value: ${value}`);
  if (Number.isFinite(min) && Number.isFinite(step) && step > 0) {
    next = min + Math.round((next - min) / step) * step;
  }
  if (Number.isFinite(min)) next = Math.max(min, next);
  if (Number.isFinite(max)) next = Math.min(max, next);
  return Number.isInteger(next) ? next : Number(next.toFixed(6));
}

// Greedy first, brute force only for the small leftovers.
export function computeTileOrder(answer, tiles) {
  const answerLower = String(answer || '').toLowerCase().replace(/[\s\-]/g, '');
  const tilesLower = (tiles || []).map(tile => String(tile || '').toLowerCase().replace(/[\s\-]/g, ''));
  const used = new Set();
  const order = [];
  let pos = 0;

  while (pos < answerLower.length && order.length < tilesLower.length) {
    let found = false;
    const candidates = tilesLower
      .map((text, idx) => ({ text, idx, len: text.length }))
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
    if (remaining.length === 0) {
      return current.map(index => tilesLower[index]).join('') === answerLower ? current : null;
    }
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
