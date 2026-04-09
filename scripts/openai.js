// kAIhoot - OpenAI integration

import { DEFAULT_MODEL, DEFAULT_VISION_MODEL } from './core/constants.js';
import { parseMultiSelectResponse, parsePinCoordinates, selectBestChoice, snapSliderValue } from './core/matching.js';
import { getApiKey } from './core/storage.js';

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const API_TIMEOUT_MS = 15000;
const MAX_RETRIES = 2;

const NEED_IMAGE = 'NEED_IMAGE';
const VISION_TIMEOUT_MS = 25000;

const STYLE = 'color:#6ee7b7;font-weight:bold';
const log = (...args) => console.log('%c[OpenAI]', STYLE, ...args);
const warn = (...args) => console.warn('%c[OpenAI]', STYLE, ...args);

async function getOpenAISettings() {
  const sync = await chrome.storage.sync.get(['openaiModel', 'openaiVisionModel']);
  const apiKey = await getApiKey();
  return {
    apiKey,
    model: (sync.openaiModel || DEFAULT_MODEL).trim() || DEFAULT_MODEL,
    visionModel: (sync.openaiVisionModel || DEFAULT_VISION_MODEL).trim() || DEFAULT_VISION_MODEL
  };
}

// --- Single-answer questions ---

export async function answerQuestion(title, choices, imageUrl) {
  const { apiKey, model, visionModel } = await getOpenAISettings();
  if (!apiKey) throw new Error('No OpenAI API key configured.');
  if (!Array.isArray(choices) || choices.length === 0) throw new Error('No answer choices provided.');

  const numbered = choices.map((c, i) => `${i + 1}) ${c}`).join('\n');
  const prompt = `Question: ${title}\n\n${numbered}\n\nThink about what the question is really asking, then reply with ONLY the number (1-${choices.length}) of the correct answer.`;

  const needImageHint = imageUrl
    ? '\nIMPORTANT: You are NOT seeing any image. If the question refers to visual content (code, diagram, graph, photo, equation, table) that you cannot see and that is essential to determine the answer, respond with ONLY: NEED_IMAGE. Do NOT guess when the answer depends on unseen visual content.'
    : '';

  const data = await callOpenAI(apiKey, model, prompt, {
    systemPrompt: 'You are a quiz-answering engine with strong general knowledge. Read the question carefully. Watch out for trick wording, negatives, and "best" qualifiers. Respond with ONLY a single number. No words, no punctuation.' + needImageHint,
    maxTokens: 16,
    stop: ['\n'],
    reasoningEffort: 'minimal'
  });

  const raw = (data?.choices?.[0]?.message?.content || '').trim();

  if (imageUrl && raw.toUpperCase().includes(NEED_IMAGE)) {
    log('Model requested image context — retrying with vision model');
    try {
      return await answerQuestionWithVision(title, choices, imageUrl, apiKey, visionModel);
    } catch (visionErr) {
      warn(`Vision fallback failed: ${visionErr.message} — guessing from text`);
      return await answerTextFallback(title, choices, apiKey, model);
    }
  }

  const match = raw.match(/\d+/);
  const idx = match ? parseInt(match[0], 10) : NaN;

  if (Number.isFinite(idx) && idx >= 1 && idx <= choices.length) {
    log(`Parsed choice #${idx} -> "${choices[idx - 1]}"`);
    return choices[idx - 1];
  }

  warn(`Number parse failed, raw: "${raw}" - text fallback`);
  return await answerTextFallback(title, choices, apiKey, model);
}

// --- Multi-select questions ---

export async function answerMultiSelect(title, choices, imageUrl) {
  const { apiKey, model, visionModel } = await getOpenAISettings();
  if (!apiKey) throw new Error('No OpenAI API key configured.');
  if (!Array.isArray(choices) || choices.length === 0) throw new Error('No answer choices provided.');

  const numbered = choices.map((c, i) => `${i + 1}) ${c}`).join('\n');
  const prompt = `Question: ${title}\n\n${numbered}\n\nThis is a multi-select quiz - there are MULTIPLE correct answers.\nFor EACH option, evaluate whether it DIRECTLY and CORRECTLY answers the question.\nMark YES only if the option is a correct answer. Mark NO if it is wrong, only partly true, or not what the question asks for.\nRespond with one line per option: NUMBER:YES or NUMBER:NO`;

  const needImageHint = imageUrl
    ? '\nIMPORTANT: You are NOT seeing any image. If the question refers to visual content (code, diagram, graph, photo, equation, table) that you cannot see and that is essential to evaluate the answers, respond with ONLY: NEED_IMAGE. Do NOT guess when the answers depend on unseen visual content.'
    : '';

  const data = await callOpenAI(apiKey, model, prompt, {
    systemPrompt: 'You are a quiz-answering engine with strong general knowledge. For multi-select questions, evaluate EACH option independently. Mark YES only for options that directly and correctly answer the question. An option that is real but not relevant to what the question asks should be marked NO. Format: NUMBER:YES or NUMBER:NO, one per line.' + needImageHint,
    maxTokens: 120,
    reasoningEffort: 'low'
  });

  const raw = (data?.choices?.[0]?.message?.content || '').trim();
  log(`Multi-select raw: "${raw}"`);

  if (imageUrl && raw.toUpperCase().includes(NEED_IMAGE)) {
    log('Model requested image context for multi-select — retrying with vision');
    try {
      return await answerMultiSelectWithVision(title, choices, imageUrl, apiKey, visionModel);
    } catch (visionErr) {
      warn(`Vision multi-select failed: ${visionErr.message} — guessing from text`);
      const single = await answerTextFallback(title, choices, apiKey, model);
      return [single];
    }
  }

  try {
    const result = parseMultiSelectResponse(raw, choices);
    log(`Multi-select parsed -> ${JSON.stringify(result)}`);
    return result;
  } catch (parseErr) {
    warn(`Multi-select parse failed: ${parseErr.message} - single answer fallback`);
    const single = await answerTextFallback(title, choices, apiKey, model);
    return [single];
  }
}

// --- Pin-it questions ---

export async function answerPinQuestion(title, imageUrl) {
  const { apiKey, visionModel } = await getOpenAISettings();
  if (!apiKey) throw new Error('No OpenAI API key configured.');
  if (!imageUrl) throw new Error('No image URL for pin question.');

  const prompt = `You must place a pin on this image to answer a quiz question:
"${title}"

COORDINATE SYSTEM:
- X=0 is the LEFT edge, X=100 is the RIGHT edge
- Y=0 is the TOP edge, Y=100 is the BOTTOM edge
- The center of the image is X=50, Y=50

STEP BY STEP:
1. Describe what you see (world map? regional map? photo? diagram? chart?).
2. Figure out what the question wants you to find.
3. If it's a MAP: look at the actual coastlines, borders, and labels visible in THIS specific image. Different maps use different projections and crops, so do NOT assume fixed positions. Instead, find recognizable landmarks in the image (continent shapes, labeled countries, visible borders) and estimate your target relative to those.
4. If it's NOT a map: find the exact visible feature the question asks about. Place the pin on the object itself, not on empty space around it.
5. Pick a visible reference point near your target and estimate its coordinates.
6. Estimate your target's coordinates relative to that reference point.
7. Sanity check EACH coordinate:
   - If you said "about 1/3 from the left", X should be near 33. If you said "about 1/4", X should be near 25. Actually do the division.
   - If you said "about 2/5 from the top", Y should be near 40. NOT 58. Convert your fraction to a number.
   - Is the target left/right of center? Then X should be below/above 50.
   - Is the target above/below center? Then Y should be below/above 50.

COMMON MISTAKES TO AVOID:
- MATH ERRORS: "2/5 from the top" = Y=40, NOT Y=58. "1/4 from the left" = X=25, NOT X=35. Always convert fractions to percentages correctly.
- On maps: don't guess from memory where a country "should" be. Look at where it actually appears in THIS image.
- Don't place pins on margins, labels, captions, legends, or whitespace.
- Don't place pins in the ocean when the question asks about land.
- For "base/bottom/foot" targets, place on the visible structure, not blank space below it.

Show your reasoning, then on the FINAL line output ONLY: X,Y
Example: 65.0,40.0`;

  log(`Pin question - vision model: ${visionModel}, image: ${imageUrl?.slice(0, 80)}...`);

  const isGPT5Vision = /^gpt-5/i.test(visionModel.trim());
  const body = {
    model: visionModel,
    messages: [
      { role: isGPT5Vision ? 'developer' : 'system', content: 'You are a spatial reasoning expert. You will be shown an image and asked to place a pin at a specific location. Look carefully at the actual image content - maps can be any projection, any crop, any style. Reason step by step from what you see, then output coordinates. Your final line must be ONLY X,Y (0-100 scale).' },
      { role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: imageUrl, detail: 'high' } }] }
    ],
    temperature: 0.1
  };
  if (isGPT5Vision) {
    body.max_completion_tokens = 800;
  } else {
    body.max_tokens = 800;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  let resp;
  try {
    resp = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') throw new Error('OpenAI Vision request timed out (30s)');
    throw err;
  }
  clearTimeout(timeout);

  if (!resp.ok) {
    let errMsg;
    try {
      const e = await resp.json();
      errMsg = e?.error?.message || `HTTP ${resp.status}`;
    } catch {
      errMsg = `HTTP ${resp.status}`;
    }
    throw new Error(`OpenAI Vision: ${errMsg}`);
  }

  const data = await resp.json();
  const raw = (data?.choices?.[0]?.message?.content || '').trim();
  log(`Vision response:\n${raw}`);

  return parsePinCoordinates(raw);
}

// --- Open-ended (type answer) questions ---

export async function answerOpenEndedQuestion(title, imageUrl) {
  const { apiKey, model, visionModel } = await getOpenAISettings();
  if (!apiKey) throw new Error('No OpenAI API key configured.');

  const prompt = `Quiz question: "${title}"\n\nThis is a fill-in-the-blank or short answer quiz question. Give the most likely intended answer.\nIf it's a fill-in-the-blank (contains ___ or a gap), give the word or short phrase that best completes the sentence.\nThink about what a teacher or quiz creator would expect as the correct answer.\nRespond with ONLY the answer - max 20 characters, no explanation.`;

  const needImageHint = imageUrl
    ? '\nIMPORTANT: You are NOT seeing any image. If the question refers to visual content (code, diagram, graph, photo, equation, table) that you cannot see and that is essential to determine the answer, respond with ONLY: NEED_IMAGE. Do NOT guess when the answer depends on unseen visual content.'
    : '';

  const data = await callOpenAI(apiKey, model, prompt, {
    systemPrompt: 'You answer quiz questions with short, precise answers. Your answer must be 20 characters or fewer. For fill-in-the-blank questions, give the single most expected word or phrase that completes the sentence. Think like a student answering a classroom quiz. Give only the answer - no explanation.' + needImageHint,
    maxTokens: 24,
    reasoningEffort: 'medium'
  });

  let answer = (data?.choices?.[0]?.message?.content || '').trim();

  if (imageUrl && answer.toUpperCase().includes(NEED_IMAGE)) {
    log('Model requested image context for open-ended — retrying with vision');
    return await answerOpenEndedWithVision(title, imageUrl, apiKey, visionModel);
  }

  // Strip quotes, markdown bold/italic/code, trailing punctuation, common prefixes
  answer = answer.replace(/^["'`*_]+|["'`*_]+$/g, '');
  answer = answer.replace(/^(?:the answer is|answer:|it'?s)\s*/i, '');
  answer = answer.replace(/[.!]$/, '');
  answer = answer.trim();
  if (answer.length > 20) answer = answer.substring(0, 20);
  if (!answer) throw new Error('Empty answer from AI');
  log(`Open-ended answer: "${answer}" (${answer.length} chars)`);
  return answer;
}

// --- Slider questions ---

export async function answerSliderQuestion(title, sliderConfig, imageUrl) {
  const { apiKey, model, visionModel } = await getOpenAISettings();
  if (!apiKey) throw new Error('No OpenAI API key configured.');

  const { min, max, step, unit } = sliderConfig;
  const hasRange = min != null && max != null;

  let rangeInfo = '';
  let snapHint = '';
  if (hasRange) {
    rangeInfo = `\nRange: ${min} to ${max} (step: ${step || 'unknown'})${unit ? ` (unit: ${unit})` : ''}`;
    if (step) {
      const numSteps = Math.round((max - min) / step);
      if (numSteps <= 30) {
        const points = [];
        for (let i = 0; i <= numSteps; i++) points.push(min + i * step);
        snapHint = `\nValid values: ${points.join(', ')}`;
      } else {
        snapHint = `\nThe answer MUST be exactly: ${min} + (N x ${step}) for some integer N.`;
      }
    }
  } else {
    if (unit) rangeInfo = `\nUnit: ${unit}`;
    if (step) rangeInfo += `${rangeInfo ? ', ' : '\n'}Step size: ${step}`;
  }

  const prompt = `Question: ${title}\n\nThis is a slider question on a quiz. You need to pick the correct numeric value.${rangeInfo}${snapHint}\n\nIMPORTANT: Think carefully about the factual answer to this question first. This is a knowledge/trivia question - use your real-world knowledge to determine the correct answer${hasRange ? ', then pick the closest valid value in the range' : ''}.\n\nReply with ONLY a single number. No words, no units, no punctuation - just the number.`;

  const needImageHint = imageUrl
    ? '\nIMPORTANT: You are NOT seeing any image. If the question refers to visual content (code, diagram, graph, photo, equation, table) that you cannot see and that is essential to determine the answer, respond with ONLY: NEED_IMAGE.'
    : '';

  const data = await callOpenAI(apiKey, model, prompt, {
    systemPrompt: 'You are a quiz-answering engine with strong general knowledge. For slider questions, think about the real-world factual answer first, then pick the closest valid value on the slider. Respond with ONLY a single number. No explanation, no units - just the number.' + needImageHint,
    maxTokens: 32,
    reasoningEffort: 'low'
  });

  const raw = (data?.choices?.[0]?.message?.content || '').trim();

  if (imageUrl && raw.toUpperCase().includes(NEED_IMAGE)) {
    log('Model requested image context for slider — retrying with vision');
    return await answerSliderWithVision(title, sliderConfig, imageUrl, apiKey, visionModel);
  }

  const cleaned = raw.replace(/[\s,]/g, '');
  const numMatch = cleaned.match(/-?[\d.]+/);
  if (!numMatch) throw new Error(`Could not parse slider answer: "${raw}"`);

  const value = parseFloat(numMatch[0]);
  if (isNaN(value)) throw new Error(`Could not parse slider answer: "${raw}"`);
  const snapped = snapSliderValue(value, sliderConfig);
  log(`Slider answer: ${value} -> snapped ${snapped} (raw: "${raw}")`);
  return snapped;
}

// --- Jumble ---

export async function answerJumbleQuestion(title, tiles) {
  const { apiKey, model } = await getOpenAISettings();
  if (!apiKey) throw new Error('No OpenAI API key configured.');
  if (!tiles || tiles.length === 0) throw new Error('No jumble tiles provided.');

  const tileList = tiles.map(t => `"${t}"`).join(', ');
  const prompt = `Question: ${title}\n\nThe answer is formed by arranging these tiles in the correct order: ${tileList}\n\nYou must use ALL tiles exactly once. What word or phrase do these tiles spell when arranged correctly to answer the question?\nReply with ONLY the answer word/phrase. Nothing else.`;
  const useModel = model.includes('nano') ? DEFAULT_MODEL : model;

  const data = await callOpenAI(apiKey, useModel, prompt, {
    systemPrompt: 'You are a quiz expert. Given shuffled tiles that form a word/phrase, determine the correct answer. Reply with ONLY the answer word or phrase. No explanation, no quotes.',
    maxTokens: 50
  });

  const raw = (data?.choices?.[0]?.message?.content || '').trim().replace(/^["']|["']$/g, '');
  log(`Jumble answer: "${raw}"`);
  return raw;
}

// --- Text fallback ---

async function answerTextFallback(title, choices, apiKey, model) {
  const numbered = choices.map((c, i) => `${i + 1}) ${c}`).join('\n');
  const prompt = `Question: ${title}\n\n${numbered}\n\nReply with the EXACT text of the correct option. Nothing else.`;

  const data = await callOpenAI(apiKey, model, prompt, {
    systemPrompt: 'You solve multiple-choice questions. Reply with ONLY the exact text of the correct option. No explanation, no numbering.',
    maxTokens: 80
  });

  const raw = (data?.choices?.[0]?.message?.content || '').trim();
  return selectBestChoice(raw, choices);
}

// --- Raw API call with timeout + retry ---

async function callOpenAI(apiKey, model, userPrompt, opts = {}) {
  const {
    systemPrompt = 'You answer multiple-choice questions.',
    maxTokens = 40,
    stop = undefined,
    reasoningEffort = 'minimal'
  } = opts;
  const isGPT5 = /^gpt-5/i.test(model.trim());

  const body = {
    model,
    messages: [
      { role: isGPT5 ? 'developer' : 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ]
  };

  if (isGPT5) {
    const reasoningPads = { minimal: 200, low: 500, medium: 1200, high: 2500 };
    const reasoningPad = reasoningPads[reasoningEffort] ?? 500;
    body.max_completion_tokens = maxTokens + reasoningPad;
    body.reasoning_effort = reasoningEffort;
  } else {
    body.max_tokens = maxTokens;
    body.temperature = 0;
    if (stop) body.stop = stop;
  }

  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) log('Retry attempt', attempt);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
    try {
      const resp = await fetch(OPENAI_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      clearTimeout(timeout);

      if (resp.ok) {
        const data = await resp.json();
        log(`Response: "${(data?.choices?.[0]?.message?.content || '').trim()}"`);
        return data;
      }

      if ((resp.status === 429 || resp.status >= 500) && attempt < MAX_RETRIES) {
        const backoff = Math.min(1000 * 2 ** attempt, 4000) * (0.5 + Math.random() * 0.5);
        await new Promise(r => setTimeout(r, backoff));
        continue;
      }

      let errMsg;
      try {
        const e = await resp.json();
        errMsg = e?.error?.message || `HTTP ${resp.status}`;
      } catch {
        errMsg = `HTTP ${resp.status}`;
      }
      throw new Error(`OpenAI: ${errMsg}`);
    } catch (err) {
      clearTimeout(timeout);
      lastError = err.name === 'AbortError' ? new Error('OpenAI request timed out') : err;
      if (attempt < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, Math.min(1000 * 2 ** attempt, 4000) * (0.5 + Math.random() * 0.5)));
        continue;
      }
      throw lastError;
    }
  }

  throw lastError ?? new Error('OpenAI call failed after all retries');
}

// --- Vision helpers (NEED_IMAGE fallback) ---

async function callVision(apiKey, visionModel, systemPrompt, textPrompt, imageUrl, opts = {}) {
  const { maxTokens = 500, timeoutMs = VISION_TIMEOUT_MS } = opts;
  const isGPT5 = /^gpt-5/i.test(visionModel.trim());

  const body = {
    model: visionModel,
    messages: [
      { role: isGPT5 ? 'developer' : 'system', content: systemPrompt },
      { role: 'user', content: [
        { type: 'text', text: textPrompt },
        { type: 'image_url', image_url: { url: imageUrl, detail: 'high' } }
      ]}
    ],
    temperature: 0.1
  };
  if (isGPT5) {
    body.max_completion_tokens = maxTokens;
  } else {
    body.max_tokens = maxTokens;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let resp;
  try {
    resp = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') throw new Error('Vision request timed out');
    throw err;
  }
  clearTimeout(timer);

  if (!resp.ok) {
    let errMsg;
    try { const e = await resp.json(); errMsg = e?.error?.message || `HTTP ${resp.status}`; }
    catch { errMsg = `HTTP ${resp.status}`; }
    throw new Error(`OpenAI Vision: ${errMsg}`);
  }

  const data = await resp.json();
  return (data?.choices?.[0]?.message?.content || '').trim();
}

async function answerQuestionWithVision(title, choices, imageUrl, apiKey, visionModel) {
  const numbered = choices.map((c, i) => `${i + 1}) ${c}`).join('\n');
  const prompt = `Question: ${title}\n\n${numbered}\n\nThe image contains information needed to answer this question. Look at it carefully.\nReply with ONLY the number (1-${choices.length}) of the correct answer.`;

  const raw = await callVision(apiKey, visionModel,
    'You are a quiz-answering engine with vision. The image contains critical information (code, diagram, equation, table, etc). Analyze the image carefully, then respond with ONLY a single number for the correct answer.',
    prompt, imageUrl);

  log(`Vision MCQ raw: "${raw}"`);

  // Vision models may reason before answering — extract the last valid choice number
  const numbers = [...raw.matchAll(/\b(\d+)\b/g)]
    .map(m => parseInt(m[1], 10))
    .filter(n => n >= 1 && n <= choices.length);

  if (numbers.length > 0) {
    const idx = numbers[numbers.length - 1];
    log(`Vision choice #${idx} -> "${choices[idx - 1]}"`);
    return choices[idx - 1];
  }

  warn('Vision number parse failed, trying text match');
  return selectBestChoice(raw, choices);
}

async function answerMultiSelectWithVision(title, choices, imageUrl, apiKey, visionModel) {
  const numbered = choices.map((c, i) => `${i + 1}) ${c}`).join('\n');
  const prompt = `Question: ${title}\n\n${numbered}\n\nThe image contains information needed to answer this question. Look at it carefully.\nThis is a multi-select quiz — there are MULTIPLE correct answers.\nFor EACH option, evaluate whether it is correct based on the question AND the image.\nRespond with one line per option: NUMBER:YES or NUMBER:NO`;

  const raw = await callVision(apiKey, visionModel,
    'You are a quiz-answering engine with vision. The image contains critical information. For multi-select questions, evaluate EACH option against the image content. Format: NUMBER:YES or NUMBER:NO, one per line.',
    prompt, imageUrl);

  log(`Vision multi-select raw: "${raw}"`);

  try {
    const result = parseMultiSelectResponse(raw, choices);
    log(`Vision multi-select -> ${JSON.stringify(result)}`);
    return result;
  } catch (parseErr) {
    // Extract any mentioned choice numbers as fallback
    const numbers = [...new Set(
      [...raw.matchAll(/\b(\d+)\b/g)]
        .map(m => parseInt(m[1], 10))
        .filter(n => n >= 1 && n <= choices.length)
    )];
    if (numbers.length > 0) {
      const answers = numbers.map(n => choices[n - 1]);
      log(`Vision multi-select number fallback -> ${JSON.stringify(answers)}`);
      return answers;
    }
    warn(`Vision multi-select parse failed: ${parseErr.message}`);
    return [selectBestChoice(raw, choices)];
  }
}

async function answerOpenEndedWithVision(title, imageUrl, apiKey, visionModel) {
  const prompt = `Quiz question: "${title}"\n\nThe image contains information needed to answer this question. Look at it carefully.\nThis is a short-answer quiz question. Give the most likely intended answer.\nRespond with ONLY the answer — max 20 characters, no explanation.`;

  const raw = await callVision(apiKey, visionModel,
    'You answer quiz questions with short, precise answers based on image content. Your answer must be 20 characters or fewer. Give only the answer — no explanation.',
    prompt, imageUrl, { maxTokens: 300 });

  log(`Vision open-ended raw: "${raw}"`);
  let answer = raw.replace(/^["'`*_]+|["'`*_]+$/g, '');
  answer = answer.replace(/^(?:the answer is|answer:|it'?s)\s*/i, '');
  answer = answer.replace(/[.!]$/, '');
  answer = answer.trim();
  // Vision model may include reasoning — grab the last short line
  if (answer.length > 20) {
    const lines = answer.split('\n').map(l => l.trim()).filter(Boolean);
    const lastShort = lines.reverse().find(l => l.length <= 20);
    if (lastShort) answer = lastShort;
    else answer = answer.substring(0, 20);
  }
  if (!answer) throw new Error('Empty answer from vision AI');
  log(`Vision open-ended answer: "${answer}" (${answer.length} chars)`);
  return answer;
}

async function answerSliderWithVision(title, sliderConfig, imageUrl, apiKey, visionModel) {
  const { min, max, step, unit } = sliderConfig;
  const hasRange = min != null && max != null;
  let rangeInfo = '';
  if (hasRange) {
    rangeInfo = `\nRange: ${min} to ${max}${step ? ` (step: ${step})` : ''}${unit ? ` (unit: ${unit})` : ''}`;
  }

  const prompt = `Question: ${title}\n\nThe image contains information needed to answer this question. Look at it carefully.\nThis is a slider question — pick the correct numeric value.${rangeInfo}\nReply with ONLY a single number.`;

  const raw = await callVision(apiKey, visionModel,
    'You are a quiz-answering engine with vision. Analyze the image to determine the correct numeric answer. Respond with ONLY a single number.',
    prompt, imageUrl, { maxTokens: 300 });

  log(`Vision slider raw: "${raw}"`);
  // Vision models may reason before answering — take the last number
  const allNumbers = [...raw.matchAll(/-?[\d.]+/g)];
  if (allNumbers.length === 0) throw new Error(`Could not parse vision slider answer: "${raw}"`);
  const value = parseFloat(allNumbers[allNumbers.length - 1][0]);
  if (isNaN(value)) throw new Error(`Could not parse vision slider answer: "${raw}"`);
  const snapped = snapSliderValue(value, sliderConfig);
  log(`Vision slider: ${value} -> snapped ${snapped}`);
  return snapped;
}
