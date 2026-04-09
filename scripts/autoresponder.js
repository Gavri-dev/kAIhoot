// kAIhoot service worker. Receives questions from content.js, calls OpenAI,
// and sends the answer back.

import { DEFAULT_MODEL, DEFAULT_VISION_MODEL, DEPRECATED_MODELS } from './core/constants.js';
import { shortText } from './core/text.js';
import { getApiKey } from './core/storage.js';
import { answerJumbleQuestion, answerMultiSelect, answerOpenEndedQuestion, answerPinQuestion, answerQuestion, answerSliderQuestion } from './openai.js';

const TAG = '[kAIhoot]';
const STYLE = 'color:#10b981;font-weight:bold';
const log = (...args) => console.log(`%c${TAG}`, STYLE, ...args);
const err = (...args) => console.error(`%c${TAG}`, STYLE, ...args);

// Clean up old model names once at startup so the popup and the worker agree.
(async () => {
  try {
    const { openaiModel, openaiVisionModel } = await chrome.storage.sync.get(['openaiModel', 'openaiVisionModel']);
    const current = (openaiModel || '').trim().toLowerCase();
    const currentVision = (openaiVisionModel || '').trim().toLowerCase();
    const next = {};
    if (!current || DEPRECATED_MODELS.has(current)) next.openaiModel = DEFAULT_MODEL;
    if (!currentVision || DEPRECATED_MODELS.has(currentVision)) next.openaiVisionModel = DEFAULT_VISION_MODEL;
    if (Object.keys(next).length) {
      await chrome.storage.sync.set(next);
      log(`Migrated model settings`, next);
    }
  } catch (error) {
    err('Model migration failed:', error);
  }
})();

chrome.commands.onCommand.addListener((command) => {
  if (command !== 'manual-answer') return;
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]?.id) chrome.tabs.sendMessage(tabs[0].id, { action: 'manualAnswer' }).catch(() => {});
  });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'processQuestion') {
    handleQuestion(msg.question, sender.tab?.id, sender.frameId)
      .then(() => sendResponse({ ok: true }))
      .catch(error => sendResponse({ error: error.message }));
    return true;
  }
});

// Resolve the question's image URL from WebSocket data or DOM fallback.
async function getQuestionImage(question, tabId, frameId) {
  if (question.imageUrl) return question.imageUrl;
  const response = await sendToTabAsync(tabId, frameId, 'getQuestionImageUrl');
  return response?.imageUrl || null;
}

// Route each question type to the right OpenAI call and send the result back.
async function handleQuestion(question, tabId, frameId) {
  if (!question?.title || !tabId) return;
  const t0 = performance.now();
  const ms = () => `${Math.round(performance.now() - t0)}ms`;

  log(`Question: "${shortText(question.title, 120)}" | Type: ${question.type} | Choices: [${(question.choices || []).join(', ')}]`);

  try {
    const openaiApiKey = await getApiKey();
    if (!openaiApiKey) {
      sendToTab(tabId, frameId, 'showError', { message: 'No API key set. Click the kAIhoot icon to configure.' });
      return;
    }

    const settings = await chrome.storage.sync.get([
      'highlightOption',
      'autoClickOption',
      'pinHighlightOption',
      'pinAutoClickOption',
      'answerDelay',
      'silentMode'
    ]);

    const opts = {
      highlight: settings.highlightOption !== false,
      autoClick: settings.autoClickOption !== false,
      answerDelay: settings.answerDelay ?? 0,
      silentMode: !!settings.silentMode
    };

    if (question.type === 'pin_it') {
      opts.highlight = settings.pinHighlightOption !== false;
      opts.autoClick = !!settings.pinAutoClickOption;
    }

    switch (question.type) {
      case 'pin_it': {
        let imageUrl = question.imageUrl;
        let imageSource = imageUrl ? 'websocket' : null;
        if (!imageUrl) {
          const response = await sendToTabAsync(tabId, frameId, 'getPinImageUrl');
          imageUrl = response?.imageUrl;
          imageSource = imageUrl ? 'dom' : null;
        }
        if (!imageUrl) throw new Error('No image found for pin question');
        log(`Pin image (${imageSource}): ${imageUrl.slice(0, 100)}${imageUrl.length > 100 ? '...' : ''}`);
        const coords = await answerPinQuestion(question.title, imageUrl);
        log(`Pin: ${coords.x.toFixed(1)}%, ${coords.y.toFixed(1)}% (${ms()})`);
        sendToTab(tabId, frameId, 'placePin', { coords, options: opts, elapsed: ms() });
        break;
      }

      case 'jumble': {
        const answerWord = await answerJumbleQuestion(question.title, question.choices);
        log(`Jumble: "${answerWord}" (${ms()})`);
        sendToTab(tabId, frameId, 'reorderJumble', { answerWord, options: opts, elapsed: ms() });
        break;
      }

      case 'slider': {
        const imageUrl = await getQuestionImage(question, tabId, frameId);
        const value = await answerSliderQuestion(question.title, question.sliderConfig || {}, imageUrl);
        log(`Slider: ${value} (${ms()})`);
        sendToTab(tabId, frameId, 'setSlider', { value, options: opts, elapsed: ms() });
        break;
      }

      case 'open_ended': {
        const imageUrl = await getQuestionImage(question, tabId, frameId);
        const answer = await answerOpenEndedQuestion(question.title, imageUrl);
        log(`Open-ended: "${answer}" (${ms()})`);
        sendToTab(tabId, frameId, 'typeOpenEnded', { answer, options: opts, elapsed: ms() });
        break;
      }

      default: {
        const imageUrl = await getQuestionImage(question, tabId, frameId);
        const isMultiSelect = question.type === 'multiple_select_quiz';
        let answers;
        if (isMultiSelect) {
          answers = await answerMultiSelect(question.title, question.choices, imageUrl);
        } else {
          const answer = await answerQuestion(question.title, question.choices, imageUrl);
          answers = [answer];
        }
        log(`Answer: [${answers.join(', ')}] (${ms()})`);
        sendToTab(tabId, frameId, 'highlightAnswer', { answers, isMultiSelect, options: opts, elapsed: ms() });
      }
    }
  } catch (error) {
    err(`Failed (${ms()}):`, error);
    sendToTab(tabId, frameId, 'showError', { message: error.message || 'Unknown error' });
  }
}

function sendToTab(tabId, frameId, action, data = {}) {
  const options = Number.isInteger(frameId) && frameId >= 0 ? { frameId } : undefined;
  chrome.tabs.sendMessage(tabId, { action, ...data }, options).catch(() => {});
}

function sendToTabAsync(tabId, frameId, action, data = {}) {
  const options = Number.isInteger(frameId) && frameId >= 0 ? { frameId } : undefined;
  return new Promise(resolve => {
    chrome.tabs.sendMessage(tabId, { action, ...data }, options, response => {
      if (chrome.runtime.lastError) {
        resolve(null);
        return;
      }
      resolve(response);
    });
  });
}
