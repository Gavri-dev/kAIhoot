import test from 'node:test';
import assert from 'node:assert/strict';
import { computeTileOrder, parseMultiSelectResponse, parsePinCoordinates, selectBestChoice, snapSliderValue, validateAnswerSet } from '../scripts/core/matching.js';
import { normalizeText, fuzzyScore } from '../scripts/core/text.js';

// These tests cover the matching behavior that tends to break when prompts,
// selectors, or normalization rules change.

test('normalizeText strips list markers but preserves initials', () => {
  assert.equal(normalizeText('A) Yes'), 'yes');
  assert.equal(normalizeText('1) The answer'), 'the answer');
  assert.equal(normalizeText('• bullet point'), 'bullet point');
  assert.equal(normalizeText('A. Einstein'), 'a einstein');
  assert.equal(normalizeText('B. F. Skinner'), 'b f skinner');
  assert.equal(normalizeText('a) yes indeed'), 'yes indeed');
  assert.equal(normalizeText('1. The answer'), '1 the answer');
});

test('normalizeText handles special characters', () => {
  assert.equal(normalizeText('Rock & Roll'), 'rock and roll');
  assert.equal(normalizeText('"Hello"'), 'hello');
  assert.equal(normalizeText('café'), 'cafe');
});

test('fuzzyScore returns 1 for identical strings', () => {
  assert.equal(fuzzyScore('hello', 'hello'), 1);
});

test('fuzzyScore returns 0 for empty strings', () => {
  assert.equal(fuzzyScore('', 'hello'), 0);
  assert.equal(fuzzyScore('hello', ''), 0);
});

test('fuzzyScore gives high score for substring containment', () => {
  const score = fuzzyScore('new york city', 'new york');
  assert.ok(score >= 0.88, `Expected >= 0.88, got ${score}`);
});

test('validateAnswerSet accepts single correct answer', () => {
  assert.equal(validateAnswerSet(['Paris', 'Rome'], ['Paris'], false), true);
});

test('validateAnswerSet accepts substring match for single-select', () => {
  assert.equal(validateAnswerSet(['New York', 'Boston'], ['York'], false), true);
});

test('validateAnswerSet accepts when AI returns multiple for single-select if at least one matches', () => {
  assert.equal(validateAnswerSet(['Paris', 'Rome'], ['Paris', 'Rome'], false), true);
});

test('validateAnswerSet requires all multi-select answers to match', () => {
  assert.equal(validateAnswerSet(['Mercury', 'Venus', 'Mars'], ['Venus', 'Mars'], true), true);
  assert.equal(validateAnswerSet(['Mercury', 'Venus', 'Mars'], ['Venus', 'Jupiter'], true), false);
});

test('selectBestChoice prefers exact normalized match', () => {
  assert.equal(selectBestChoice('new york', ['Paris', 'New York', 'Berlin']), 'New York');
});

test('selectBestChoice falls back to substring match', () => {
  assert.equal(selectBestChoice('York', ['New York', 'Newark', 'Boston']), 'New York');
});

test('selectBestChoice returns best-guess on ambiguous input', () => {
  const result = selectBestChoice('new', ['New York', 'New Jersey']);
  assert.ok(result === 'New York' || result === 'New Jersey');
});

test('parseMultiSelectResponse parses YES lines', () => {
  assert.deepEqual(parseMultiSelectResponse('1:YES\n2:NO\n3:YES', ['A', 'B', 'C']), ['A', 'C']);
});

test('parseMultiSelectResponse handles numeric fallback', () => {
  assert.deepEqual(parseMultiSelectResponse('1, 3', ['A', 'B', 'C']), ['A', 'C']);
});

test('parseMultiSelectResponse extracts numbers from prose', () => {
  assert.deepEqual(parseMultiSelectResponse("I'd pick 1 and 3", ['A', 'B', 'C']), ['A', 'C']);
});

test('parseMultiSelectResponse throws on unparseable response', () => {
  assert.throws(() => parseMultiSelectResponse('I think A and C', ['A', 'B', 'C']));
});

test('parsePinCoordinates parses final-line coordinates', () => {
  assert.deepEqual(parsePinCoordinates('reasoning\n50.5,40'), { x: 50.5, y: 40 });
});

test('parsePinCoordinates clamps near-edge values', () => {
  assert.deepEqual(parsePinCoordinates('coords: 100.5,40'), { x: 100, y: 40 });
});

test('parsePinCoordinates throws on missing coordinates', () => {
  assert.throws(() => parsePinCoordinates('50.5 40'), /Could not parse/);
});

test('parsePinCoordinates clamps moderate overshoot instead of throwing', () => {
  assert.deepEqual(parsePinCoordinates('reasoning\n120,50'), { x: 100, y: 50 });
});

test('parsePinCoordinates throws on wildly out-of-range values', () => {
  assert.throws(() => parsePinCoordinates('reasoning\n500,50'), /out of range/);
});

test('parsePinCoordinates finds coordinates in last few lines', () => {
  assert.deepEqual(parsePinCoordinates('step 1\nstep 2\n75.3,22.1\nDone.'), { x: 75.3, y: 22.1 });
});

test('snapSliderValue honors min-offset snapping', () => {
  assert.equal(snapSliderValue(14, { min: 10, max: 20, step: 3 }), 13);
  assert.equal(snapSliderValue(20, { min: 10, max: 20, step: 3 }), 19);
});

test('snapSliderValue clamps to range', () => {
  assert.equal(snapSliderValue(5, { min: 10, max: 20, step: 1 }), 10);
  assert.equal(snapSliderValue(25, { min: 10, max: 20, step: 1 }), 20);
});

test('snapSliderValue works without step', () => {
  assert.equal(snapSliderValue(15, { min: 10, max: 20 }), 15);
});

test('snapSliderValue handles negative ranges', () => {
  assert.equal(snapSliderValue(-7, { min: -10, max: 10, step: 5 }), -5);
  assert.equal(snapSliderValue(-15, { min: -10, max: 10, step: 5 }), -10);
});

test('computeTileOrder handles greedy case', () => {
  assert.deepEqual(computeTileOrder('newyork', ['new', 'york']), [0, 1]);
});

test('computeTileOrder handles permutation case', () => {
  assert.deepEqual(computeTileOrder('alphabet', ['pha', 'bet', 'al']), [2, 0, 1]);
});

test('computeTileOrder returns null when no valid order exists', () => {
  assert.equal(computeTileOrder('xyz', ['a', 'b', 'c']), null);
});
