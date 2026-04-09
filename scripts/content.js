// Main content script. It watches the page, keeps a little bit of state, and
// delegates the raw WebSocket work to injected.js.

'use strict';

// Let the script run inside embedded Kahoot iframes too, but avoid double init
// if the browser reinjects the same frame.
if (window.__kAIhootContentLoaded) {
  console.log('%c[kAIhoot]', 'color:#10b981;font-weight:bold', 'Content script already loaded in this frame');
} else {
  window.__kAIhootContentLoaded = true;

// Inject the page-context script before Kahoot starts talking over WebSocket.
const script = document.createElement('script');
script.src = chrome.runtime.getURL('scripts/injected.js');
script.onload = () => script.remove();
(document.head || document.documentElement).appendChild(script);

// Local state is small on purpose. The content script gets torn down often.
const TAG = '[kAIhoot]';
const STYLE = 'color:#10b981;font-weight:bold';
const log = (...args) => console.log(`%c${TAG}`, STYLE, ...args);
const warn = (...args) => console.warn(`%c${TAG}`, STYLE, ...args);

let currentQuestion = null;
let currentAnswer = null;
let lastSentHash = null;
let lastSentTitle = null;
let loadingEndsAt = 0;
let pendingRetryHash = null;
let hasRetried = false;
let statusEl = null;
let activeToasts = [];
let submitNonce = 0;

let cachedSettings = {
  highlightOption: true,
  autoClickOption: true,
  pinHighlightOption: true,
  pinAutoClickOption: false,
  answerDelay: 0,
  silentMode: false
};

const matching = globalThis.kAIhootMatching;
const domAdapter = globalThis.kAIhootDomAdapter;

// Keep the latest settings in memory so the UI handlers do not keep hitting storage.
function refreshSettings() {
  return new Promise(resolve => {
    chrome.storage.sync.get(
      ['highlightOption', 'autoClickOption', 'pinHighlightOption', 'pinAutoClickOption', 'answerDelay', 'silentMode'],
      s => {
        cachedSettings = {
          highlightOption: s.highlightOption !== false,
          autoClickOption: s.autoClickOption !== false,
          pinHighlightOption: s.pinHighlightOption !== false,
          pinAutoClickOption: !!s.pinAutoClickOption,
          answerDelay: s.answerDelay ?? 0,
          silentMode: !!s.silentMode
        };
        resolve(cachedSettings);
      }
    );
  });
}

chrome.storage.onChanged.addListener((changes, ns) => {
  if (ns !== 'sync') return;
  if ('highlightOption' in changes) cachedSettings.highlightOption = changes.highlightOption.newValue !== false;
  if ('autoClickOption' in changes) cachedSettings.autoClickOption = changes.autoClickOption.newValue !== false;
  if ('pinHighlightOption' in changes) cachedSettings.pinHighlightOption = changes.pinHighlightOption.newValue !== false;
  if ('pinAutoClickOption' in changes) cachedSettings.pinAutoClickOption = !!changes.pinAutoClickOption.newValue;
  if ('answerDelay' in changes) cachedSettings.answerDelay = changes.answerDelay.newValue ?? 0;
  if ('silentMode' in changes) cachedSettings.silentMode = !!changes.silentMode.newValue;
  if (changes.silentMode?.newValue) {
    removeStatusIndicator();
    removeTimerOverlay();
  }
});

// Small status chip in the corner so the user can see what the bot is doing.
function createStatusIndicator() {
  if (statusEl || cachedSettings.silentMode) return;
  statusEl = document.createElement('div');
  statusEl.id = 'kaihoot-status';
  statusEl.style.cssText = `
    position:fixed; top:10px; right:10px;
    background:rgba(20,20,20,.88); color:#fff;
    padding:8px 14px; border-radius:10px; z-index:10000;
    font:600 12px/1.4 system-ui,sans-serif;
    max-width:320px; word-wrap:break-word;
    pointer-events:none; transition:opacity .3s;
    backdrop-filter:blur(8px);
    border:1px solid rgba(16,185,129,.3);
    box-shadow:0 4px 12px rgba(0,0,0,.4);
  `;
  statusEl.innerHTML = '<div id="kaihoot-status-main" style="display:flex;align-items:center;gap:6px">kAIhoot: Ready</div><div id="kaihoot-status-detail" style="font-weight:400;font-size:11px;opacity:.7;margin-top:3px;display:none"></div>';
  document.body?.appendChild(statusEl);
}

let thinkingDot = null;
function setThinking(on) {
  if (!statusEl) return;
  if (on && !thinkingDot) {
    thinkingDot = document.createElement('span');
    thinkingDot.style.cssText = 'width:6px;height:6px;border-radius:50%;background:#10b981;display:inline-block;animation:kaihoot-pulse 1s ease-in-out infinite;flex-shrink:0';
    statusEl.querySelector('#kaihoot-status-main')?.appendChild(thinkingDot);
  } else if (!on && thinkingDot) {
    thinkingDot.remove();
    thinkingDot = null;
  }
}

function updateStatus(msg, detail) {
  if (cachedSettings.silentMode) return;
  if (!statusEl) createStatusIndicator();
  if (!statusEl) return;
  const mainEl = statusEl.querySelector('#kaihoot-status-main');
  const detailEl = statusEl.querySelector('#kaihoot-status-detail');
  if (mainEl) mainEl.textContent = `kAIhoot: ${msg}`;
  // Pulse while waiting, stop when answer arrives
  const isWaiting = msg.includes('Sending') || msg.includes('Retrying');
  setThinking(isWaiting);
  if (detailEl) {
    if (detail) { detailEl.textContent = detail; detailEl.style.display = 'block'; }
    else detailEl.style.display = 'none';
  }
}

function removeStatusIndicator() { statusEl?.remove(); statusEl = null; thinkingDot = null; }

// Toasts are only for actionable failures. Normal progress stays in the status chip.
function showErrorToast(message) {
  if (cachedSettings.silentMode) return;
  while (activeToasts.length >= 3) { const old = activeToasts.shift(); old?.remove(); }
  const toast = document.createElement('div');
  toast.style.cssText = `
    position:fixed; top:${20 + activeToasts.length * 55}px; right:20px;
    background:#e74c3c; color:#fff;
    padding:12px 16px; border-radius:8px; z-index:9999;
    font:600 13px/1.3 system-ui,sans-serif;
    max-width:300px; box-shadow:0 4px 12px rgba(0,0,0,.3);
    animation: kaihoot-fadein .25s ease-out;
  `;
  toast.textContent = message;
  document.body?.appendChild(toast);
  activeToasts.push(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity .3s';
    setTimeout(() => { toast.remove(); activeToasts = activeToasts.filter(t => t !== toast); }, 300);
  }, 4500);
}

// Hash question title and choices together so retries do not double-send the same prompt.
function questionHash(q) { return JSON.stringify({ t: q.title, c: q.choices }); }

function broadcastToPopup(action, data = {}) {
  try { chrome.runtime.sendMessage({ action, ...data }).catch(() => {}); } catch (_) {}
}

// The background worker owns the OpenAI request. The content script only sends context.
function sendQuestionToBackend(question) {
  lastSentHash = questionHash(question);
  const shortQ = question.title.length > 60 ? question.title.slice(0, 57) + '...' : question.title;
  updateStatus('Sending to AI...', shortQ);
  broadcastToPopup('updateQuestion', { question: { title: question.title, type: question.type, choices: question.choices || [] } });
  chrome.runtime.sendMessage({ action: 'processQuestion', question }, () => {
    if (chrome.runtime.lastError) {
      updateStatus('Error: ' + chrome.runtime.lastError.message);
      lastSentHash = null; lastSentTitle = null;
    }
  });
}

// Most tab-side actions come back through this single message handler.
chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  switch (request.action) {
    case 'highlightAnswer': {
      hasRetried = false;
      pendingRetryHash = null;
      if (currentQuestion) lastSentHash = questionHash(currentQuestion);

      const answersFromAI = request.answers || [];

      const currentChoices = currentQuestion?.choices || [];
      if (currentChoices.length > 0 && answersFromAI.length > 0) {
        const validAnswerSet = matching.validateAnswerSet(currentChoices, answersFromAI, !!request.isMultiSelect);
        if (!validAnswerSet) {
          warn('Stale or ambiguous answer rejected:', answersFromAI, 'vs choices:', currentChoices);
          sendResponse({ success: false });
          break;
        }
      }

      currentAnswer = answersFromAI.join(', ');
      const shortA = currentAnswer.length > 60 ? currentAnswer.slice(0, 57) + '...' : currentAnswer;
      const timing = request.elapsed ? ` (${request.elapsed})` : '';
      updateStatus(`Answer received ✅${timing}`, shortA);
      broadcastToPopup('updateAnswer', { answer: currentAnswer });
      cleanupOverlays();
      log('Answers from AI:', JSON.stringify(answersFromAI), 'multiSelect:', request.isMultiSelect);
      highlightAnswers(answersFromAI, request.isMultiSelect, request.options);
      sendResponse({ success: true });
      break;
    }

    case 'getQuestion':
      sendResponse({ question: currentQuestion, answer: currentAnswer });
      break;

    case 'showError':
      updateStatus('Error ❌', request.message);
      showErrorToast(request.message);
      sendResponse({ success: true });
      if (currentQuestion && !hasRetried && !request.message?.includes('API key')) {
        hasRetried = true;
        pendingRetryHash = questionHash(currentQuestion);
        lastSentHash = pendingRetryHash;
        updateStatus('Retrying in 2s...');
        setTimeout(() => {
          if (currentQuestion && pendingRetryHash === questionHash(currentQuestion)) sendQuestionToBackend(currentQuestion);
          pendingRetryHash = null;
        }, 2000);
      } else {
        lastSentHash = null; lastSentTitle = null;
      }
      break;

    case 'manualAnswer':
      if (!currentQuestion) {
        updateStatus('No active question');
        sendResponse({ success: false, message: 'No active question' });
        break;
      }
      pendingRetryHash = null;
      hasRetried = false;
      lastSentHash = null;
      updateStatus('Manual retry...', currentQuestion.title);
      sendQuestionToBackend(currentQuestion);
      sendResponse({ success: true });
      break;

    case 'getPinImageUrl':
      sendResponse({ imageUrl: extractPinImageUrl() });
      break;

    case 'getQuestionImageUrl':
      sendResponse({ imageUrl: extractQuestionImageUrl() });
      break;

    case 'placePin': {
      hasRetried = false;
      pendingRetryHash = null;
      if (currentQuestion) lastSentHash = questionHash(currentQuestion);
      currentAnswer = `📍 ${request.coords.x.toFixed(1)}%, ${request.coords.y.toFixed(1)}%`;
      updateStatus(`Pin answer ✅${request.elapsed ? ` (${request.elapsed})` : ''}`, currentAnswer);
      broadcastToPopup('updateAnswer', { answer: currentAnswer });
      placePinOnSvg(request.coords, request.options);
      sendResponse({ success: true });
      break;
    }

    case 'reorderJumble': {
      hasRetried = false;
      pendingRetryHash = null;
      if (currentQuestion) lastSentHash = questionHash(currentQuestion);
      currentAnswer = `🧩 ${request.answerWord}`;
      updateStatus(`Jumble answer ✅${request.elapsed ? ` (${request.elapsed})` : ''}`, currentAnswer);
      broadcastToPopup('updateAnswer', { answer: currentAnswer });
      solveJumbleFromDOM(request.answerWord, request.options);
      sendResponse({ success: true });
      break;
    }

    case 'setSlider': {
      hasRetried = false;
      pendingRetryHash = null;
      if (currentQuestion) lastSentHash = questionHash(currentQuestion);
      currentAnswer = `🎚️ ${request.value}`;
      updateStatus(`Slider answer ✅${request.elapsed ? ` (${request.elapsed})` : ''}`, currentAnswer);
      broadcastToPopup('updateAnswer', { answer: currentAnswer });
      solveSliderFromDOM(request.value, request.options);
      sendResponse({ success: true });
      break;
    }

    case 'typeOpenEnded': {
      hasRetried = false;
      pendingRetryHash = null;
      if (currentQuestion) lastSentHash = questionHash(currentQuestion);
      currentAnswer = `✏️ ${request.answer}`;
      updateStatus(`Open-ended answer ✅${request.elapsed ? ` (${request.elapsed})` : ''}`, currentAnswer);
      broadcastToPopup('updateAnswer', { answer: currentAnswer });
      dispatchOpenEndedAnswer(request.answer, request.options);
      sendResponse({ success: true });
      break;
    }
  }
  return true;
});

window.addEventListener('kahootGameReset', () => {
  log('Game reset - clearing state');
  currentQuestion = null;
  currentAnswer = null;
  lastSentHash = null; lastSentTitle = null;
  pendingRetryHash = null;
  hasRetried = false;
  submitNonce++;
  cleanupOverlays();
  removeStatusIndicator();
});

window.addEventListener('kahootNonScoredQuestion', (event) => {
  log(`Non-scored question (${event.detail?.type}) - clearing status`);
  removeStatusIndicator();
  cleanupOverlays();
});

(function watchNavigation() {
  const GAME_PATHS = ['/gameblock', '/getready', '/start'];
  let lastPath = location.pathname;

  setInterval(() => {
    const path = location.pathname;
    if (path === lastPath) return;
    lastPath = path;
    const inGame = GAME_PATHS.some(p => path.includes(p));
    if (!inGame && statusEl) {
      log(`Left game screen (${path}) - clearing status`);
      removeStatusIndicator();
      cleanupOverlays();
    }
  }, 2000);
})();

window.addEventListener('kahootQuestionParsed', async (event) => {
  const q = event.detail;
  if (!q?.title) return;

  const isPin = q.type === 'pin_it';
  const isJumble = q.type === 'jumble';
  const isSlider = q.type === 'slider';
  const isOpenEnded = q.type === 'open_ended';

  if (!isPin && !isJumble && !isSlider && !isOpenEnded && (!Array.isArray(q.choices) || q.choices.length === 0)) return;

  const incomingHash = questionHash({ title: q.title, choices: q.choices || [] });
  if (lastSentHash === incomingHash) {
    log('Dedup: skipping duplicate WS event for "' + q.title.slice(0, 40) + '"');
    return;
  }

  if (lastSentTitle === q.title) {
    log('Dedup: already polling for "' + q.title.slice(0, 40) + '"');
    return;
  }
  lastSentTitle = q.title;

  loadingEndsAt = 0;
  for (let i = 0; i < 10; i++) {
    const loadBar = document.querySelector('[data-functional-selector="loading-bar-progress"]');
    if (loadBar) {
      const cs = getComputedStyle(loadBar);
      const dur = parseFloat(cs.getPropertyValue('--animation-duration')) || 0;
      const del = parseFloat(cs.getPropertyValue('--animation-delay')) || 0;
      if (dur + del > 0) {

        const introBuffer = 1500;
        loadingEndsAt = Date.now() + dur + del + introBuffer;
        log(`Loading bar found: ${dur}+${del}+${introBuffer}ms buffer = ${dur + del + introBuffer}ms total`);
        break;
      }
    }
    await new Promise(r => setTimeout(r, 50));
  }

  cleanupOverlays();

  if (isJumble) {
    const domTiles = await pollForJumbleTiles();
    if (domTiles.length > 0) {
      q.choices = domTiles;
      log('Jumble tiles from DOM:', domTiles);
    } else if (!q.choices?.length) {
      warn('No jumble tiles found');
      return;
    }
  }

  if (isSlider) {
    const domSliderConfig = await probeSliderConfigFast();
    q.sliderConfig = {
      min: q.sliderConfig?.min ?? domSliderConfig?.min ?? null,
      max: q.sliderConfig?.max ?? domSliderConfig?.max ?? null,
      step: q.sliderConfig?.step ?? domSliderConfig?.step ?? null,
      unit: q.sliderConfig?.unit || domSliderConfig?.unit || ''
    };
    log('Slider config merged:', q.sliderConfig);
  }

  await refreshSettings();

  if (!isPin && !isJumble && !isSlider && !isOpenEnded && q.choices.some(c => !c || /^Image \d+$/.test(c))) {
    const labels = await pollForImageLabels(q.choices.length);
    if (labels.length === q.choices.length && labels.some(l => l && !/^Image \d+$/i.test(l))) {
      q.choices = labels;
      log('Image choices resolved:', labels);
    } else {
      log('Image labels not resolved, using placeholders:', q.choices);
    }
  }

  const postPollHash = questionHash({ title: q.title, choices: q.choices || [] });
  if (lastSentHash === postPollHash) {
    log('Dedup: post-poll duplicate, skipping');
    return;
  }

  currentQuestion = { title: q.title, choices: q.choices || [], type: q.type, imageUrl: q.imageUrl, ...(q.sliderConfig ? { sliderConfig: q.sliderConfig } : {}) };
  submitNonce++;
  currentAnswer = null;
  hasRetried = false;
  pendingRetryHash = null;

  sendQuestionToBackend(q);
});

// Clear anything we drew for the previous question before the next one starts.
function cleanupOverlays() {
  document.querySelectorAll('.kaihoot-pin-crosshair, .kaihoot-jumble-badge, .kaihoot-checkmark').forEach(el => el.remove());
  for (const el of domAdapter.findAnswerElements()) {
    el.style.border = '';
    el.style.boxShadow = '';
    el.style.borderRadius = '';
    el.style.transition = '';
  }
}

// Image answers usually show up later than text answers, so poll a bit before giving up.
function pollForImageLabels(expectedCount, attempt = 0) {

  return new Promise(resolve => {
    const tryExtract = () => {
      const elements = domAdapter.findAnswerElements();
      if (elements.length >= expectedCount) {
        const labels = elements.slice(0, expectedCount).map(el => domAdapter.cleanButtonText(el));
        const hasReal = labels.some(l => l.length > 0 && !/^image\s*\d+$/i.test(l));
        if (hasReal) { resolve(labels); return; }
      }
      if (attempt < 40) {
        setTimeout(() => pollForImageLabels(expectedCount, attempt + 1).then(resolve), 250);
      } else {

        const els = domAdapter.findAnswerElements();
        resolve(els.length > 0
          ? els.slice(0, expectedCount).map(el => domAdapter.cleanButtonText(el))
          : Array.from({ length: expectedCount }, (_, i) => `Image ${i + 1}`)
        );
      }
    };
    tryExtract();
  });
}

// WS slider data is not always complete. Read the DOM when it is already there.
function readSliderConfigFromDOM() {
  const input = document.querySelector('input[data-functional-selector="slider-scale"]');
  if (!input) return null;

  const rawMin = parseFloat(input.min);
  const rawMax = parseFloat(input.max);
  const rawStep = parseFloat(input.step);
  return {
    min: Number.isFinite(rawMin) ? rawMin : null,
    max: Number.isFinite(rawMax) ? rawMax : null,
    step: Number.isFinite(rawStep) ? rawStep : null,
    unit: input.getAttribute('aria-label') || ''
  };
}

// Keep this probe short. Speed matters more than perfect slider metadata.
async function probeSliderConfigFast() {
  const immediate = readSliderConfigFromDOM();
  if (immediate) return immediate;

  await new Promise(resolve => setTimeout(resolve, 40));
  const retry1 = readSliderConfigFromDOM();
  if (retry1) return retry1;

  await new Promise(resolve => setTimeout(resolve, 60));
  return readSliderConfigFromDOM();
}

// Jumble tiles can lag behind the question event, especially on slower devices.
function pollForJumbleTiles(attempt = 0) {
  return new Promise(resolve => {
    const tryExtract = () => {
      const tiles = [];
      let i = 0;
      while (true) {
        const el = document.querySelector(`[data-functional-selector="question-choice-text-${i}"]`);
        if (!el) break;
        tiles.push(el.textContent?.trim() || '');
        i++;
      }
      if (tiles.length === 0) {
        const cards = document.querySelectorAll('[data-functional-selector^="draggable-jumble-card-"]');
        for (const card of cards) tiles.push(card.getAttribute('aria-label') || card.textContent?.trim() || '');
      }
      if (tiles.length > 0 && tiles.some(t => t.length > 0)) resolve(tiles);
      else if (attempt < 15) setTimeout(() => pollForJumbleTiles(attempt + 1).then(resolve), 150);
      else resolve(tiles);
    };
    tryExtract();
  });
}

function pollForJumbleTextEls(attempt = 0) {
  return new Promise(resolve => {
    const tryExtract = () => {
      const els = [];
      let i = 0;
      while (true) {
        const el = document.querySelector(`[data-functional-selector="question-choice-text-${i}"]`);
        if (!el) break;
        els.push(el);
        i++;
      }
      if (els.length > 0) {
        log(`Found ${els.length} jumble text elements after ${attempt} polls`);
        resolve(els);
      } else if (attempt < 20) {
        setTimeout(() => pollForJumbleTextEls(attempt + 1).then(resolve), 150);
      } else {
        resolve(els);
      }
    };
    tryExtract();
  });
}

// This is the main answer path for quiz and multi-select questions.
async function highlightAnswers(answers, isMultiSelect, options) {
  const myNonce = submitNonce;
  const remaining = (loadingEndsAt > 0) ? Math.max(loadingEndsAt - Date.now(), 0) : 0;
  const maxWait = Math.max(remaining + 8000, 12000);
  const start = Date.now();
  const interval = 150;

  if (remaining > 0) {
    log(`Loading bar: ${remaining}ms remaining, polling until buttons appear`);
  }

  while (Date.now() - start < maxWait) {
    if (submitNonce !== myNonce) return;
    const elements = domAdapter.findAnswerElements();
    if (elements.length > 0) {
      applyHighlights(elements, answers, isMultiSelect, options);
      return;
    }
    await new Promise(r => setTimeout(r, interval));
  }
  updateStatus('No answer buttons found');
}

// Match the model output against the live buttons, then decide whether auto-click is safe.
function applyHighlights(elements, answers, isMultiSelect, options) {
  const matchedElements = [];

  log('Button texts:', elements.map(el => domAdapter.cleanButtonText(el)));

  for (const answer of answers) {
    let bestEl = null, bestScore = 0, secondBestScore = 0, indexFallback = null;

    const imageMatch = answer.match(/^Image\s*(\d+)$/i);
    if (imageMatch) {
      const idx = parseInt(imageMatch[1]) - 1;
      if (idx >= 0 && idx < elements.length && !matchedElements.some(m => m.el === elements[idx])) {
        matchedElements.push({ el: elements[idx], answer, score: 100, autoClickSafe: true });
        continue;
      }
    }

    const numMatch = answer.match(/^(?:Answer|Option|Choice)?\s*(\d+)$/i);
    if (numMatch) {
      const idx = parseInt(numMatch[1]) - 1;
      if (idx >= 0 && idx < elements.length) indexFallback = elements[idx];
    }

    for (const el of elements) {
      if (matchedElements.some(m => m.el === el)) continue;
      const text = domAdapter.cleanButtonText(el);
      const score = matching.matchScore(text, answer);
      if (score === 100) { bestEl = el; bestScore = 100; secondBestScore = 0; break; }
      if (score > bestScore) { secondBestScore = bestScore; bestScore = score; bestEl = el; }
      else if (score > secondBestScore) { secondBestScore = score; }
    }

    if (bestEl && bestScore >= 55) {
      const autoClickSafe = bestScore >= 85 && (bestScore - secondBestScore >= 8 || bestScore === 100);
      log(`Matched "${answer}" → "${domAdapter.cleanButtonText(bestEl)}" (score=${bestScore}, second=${secondBestScore}, autoClickSafe=${autoClickSafe})`);
      matchedElements.push({ el: bestEl, answer, score: bestScore, autoClickSafe });
    } else if (indexFallback && !matchedElements.some(m => m.el === indexFallback)) {
      log(`Index fallback for "${answer}"`);
      matchedElements.push({ el: indexFallback, answer, score: 50, autoClickSafe: false });
    } else {
      warn(`No match for "${answer}" (best score: ${bestScore})`);
    }
  }

  if (matchedElements.length === 0) { updateStatus('Could not match answers'); return; }

  if (options.highlight !== false && !options.silentMode) {
    for (const { el } of matchedElements) {
      el.style.border = '3px solid #00c853';
      el.style.boxShadow = '0 0 16px 4px rgba(0,200,83,.7)';
      el.style.borderRadius = '10px';
      el.style.transition = 'all .3s ease';
      el.animate([
        { transform: 'scale(1)', boxShadow: '0 0 12px 3px rgba(0,200,83,.5)' },
        { transform: 'scale(1.04)', boxShadow: '0 0 20px 5px rgba(0,200,83,.8)' },
        { transform: 'scale(1)', boxShadow: '0 0 12px 3px rgba(0,200,83,.5)' }
      ], { duration: 800, iterations: 3 });

      const hasImage = el.querySelector('img[data-functional-selector="image-answer"]');
      if (hasImage) {
        if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
        const badge = document.createElement('div');
        badge.className = 'kaihoot-checkmark';
        badge.textContent = '✅';
        badge.style.cssText = `
          position:absolute; top:50%; left:50%; transform:translate(-50%,-50%);
          font-size:3rem; z-index:10000; pointer-events:none;
          filter:drop-shadow(0 2px 8px rgba(0,0,0,0.7));
          animation:kaihoot-fadein .3s ease-out;
        `;
        el.appendChild(badge);
      } else {
        const check = document.createElement('span');
        check.textContent = ' ✅';
        check.style.cssText = 'font-size:1.2em; margin-left:6px; vertical-align:middle;';
        check.className = 'kaihoot-checkmark';
        el.appendChild(check);
      }
    }
  }

  if (options.autoClick !== false) {
    const matchedIndices = matchedElements.map(m => elements.indexOf(m.el)).filter(i => i >= 0);
    if (matchedElements.some(m => !m.autoClickSafe)) {
      warn('Auto-clicking despite at least one ambiguous match');
    }
    if (isMultiSelect && matchedIndices.length > 0) {
      waitForClickable(matchedElements[0].el, () => fireMultiClick(matchedIndices, elements), options);
    } else if (matchedIndices.length > 0) {
      waitForClickable(matchedElements[0].el, () => fireClick(matchedIndices[0]), options);
    }
  }
}

// Buttons can render before they are really clickable, so wait for the disabled state to clear.
function waitForClickable(element, callback, options, retries = 15) {
  if (!element) return;
  if (!element.disabled && element.offsetParent !== null) {
    const delay = options.answerDelay ?? 0;
    if (delay > 0) {
      if (!options.silentMode) showTimerOverlay(delay, callback);
      else setTimeout(callback, delay * 1000);
    } else {
      callback();
    }
  } else if (retries > 0) {
    setTimeout(() => waitForClickable(element, callback, options, retries - 1), 500);
  } else {
    updateStatus('Button never became clickable');
  }
}

// Submit over WebSocket first, then mirror the click in the DOM so the UI stays in sync.
function fireClick(index) {
  window.dispatchEvent(new CustomEvent('autoClickAnswer', { detail: index }));
  const shortA = currentAnswer?.length > 60 ? currentAnswer.slice(0, 57) + '...' : currentAnswer;
  updateStatus('Answered ✅', shortA);
}

function fireMultiClick(indices, allElements) {

  window.dispatchEvent(new CustomEvent('autoClickMultiSelect', { detail: indices }));

  for (const idx of indices) {
    if (allElements[idx]) {
      try { allElements[idx].click(); } catch (_) {}
    }
  }

  setTimeout(() => clickSubmitButton('multi-select'), 600);
  const shortA = currentAnswer?.length > 60 ? currentAnswer.slice(0, 57) + '...' : currentAnswer;
  updateStatus('Answered ✅', shortA);
}

// Submit button behavior changes between Kahoot layouts, so keep the fallback finder broad.
function clickSubmitButton(context = 'generic', attempt = 0, nonce = submitNonce) {
  if (nonce !== submitNonce) return;

  const { element: btn, selector } = domAdapter.findSubmitButton();
  if (btn && !btn.disabled) {
    log(`Clicking ${context} submit via: ${selector}`);
    btn.click();
    updateStatus('Answered ✅', currentAnswer?.length > 60 ? currentAnswer.slice(0, 57) + '...' : currentAnswer);
    return;
  }

  for (const btn of document.querySelectorAll('button')) {
    const text = btn.textContent.trim().toLowerCase();
    if (['submit', 'confirm', 'done', 'check'].includes(text) && !btn.disabled && btn.offsetParent !== null) {
      log(`Clicking ${context} submit via text: "${text}"`);
      btn.click();
      updateStatus('Answered ✅', currentAnswer?.length > 60 ? currentAnswer.slice(0, 57) + '...' : currentAnswer);
      return;
    }
  }

  if (attempt < 12) {
    setTimeout(() => clickSubmitButton(context, attempt + 1, nonce), 400);
  } else {
    log(`No ${context} submit button found after 12 attempts (WS likely already submitted)`);
    updateStatus('Answered ✅', currentAnswer?.length > 60 ? currentAnswer.slice(0, 57) + '...' : currentAnswer);
  }
}

function removeTimerOverlay() { document.getElementById('kaihoot-timer')?.remove(); }

// Optional countdown overlay for delayed answers.
function showTimerOverlay(duration, callback) {
  removeTimerOverlay();
  if (!document.getElementById('kaihoot-timer-css')) {
    const css = document.createElement('style');
    css.id = 'kaihoot-timer-css';
    css.textContent = `
      @keyframes kaihoot-slide-in  { from { transform:translateX(120%); opacity:0 } to { transform:translateX(0); opacity:1 } }
      @keyframes kaihoot-slide-out { from { transform:translateX(0); opacity:1 } to { transform:translateX(120%); opacity:0 } }
    `;
    document.head?.appendChild(css);
  }

  const overlay = document.createElement('div');
  overlay.id = 'kaihoot-timer';
  overlay.style.cssText = `
    position:fixed; top:20px; right:20px;
    background:linear-gradient(135deg,rgba(5,150,105,.92),rgba(52,211,153,.92));
    color:#fff; padding:14px 18px; border-radius:12px;
    z-index:10001; font:600 14px/1.3 system-ui,sans-serif;
    box-shadow:0 6px 20px rgba(0,0,0,.35); min-width:180px;
    animation:kaihoot-slide-in .25s ease-out;
    backdrop-filter:blur(8px);
  `;

  const label = document.createElement('div');
  label.textContent = `Answering in ${duration}s…`;
  label.style.cssText = 'margin-bottom:8px; font-size:13px;';

  const track = document.createElement('div');
  track.style.cssText = 'width:100%; height:6px; border-radius:3px; background:rgba(255,255,255,.2); overflow:hidden;';
  const fill = document.createElement('div');
  fill.style.cssText = `width:100%; height:100%; border-radius:3px; background:#fff; transition:width ${duration}s linear;`;
  track.appendChild(fill);

  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = 'Skip wait';
  cancelBtn.style.cssText = 'margin-top:8px; background:rgba(255,255,255,.2); border:none; color:#fff; padding:4px 12px; border-radius:4px; cursor:pointer; font-size:11px; font-weight:600;';

  overlay.append(label, track, cancelBtn);
  (document.body || document.documentElement).appendChild(overlay);
  requestAnimationFrame(() => { fill.style.width = '0%'; });

  let fired = false;
  const fire = () => { if (fired) return; fired = true; slideOutAndRemove(overlay, callback); };

  const timer = setTimeout(fire, duration * 1000);
  cancelBtn.addEventListener('click', () => { clearTimeout(timer); fire(); });
  fill.addEventListener('transitionend', () => { if (!fired) { clearTimeout(timer); fire(); } }, { once: true });
}

function slideOutAndRemove(el, afterRemove) {
  el.style.animation = 'kaihoot-slide-out .25s ease-in forwards';
  setTimeout(() => { el.remove(); afterRemove?.(); }, 260);
}

// Pin questions sometimes hide the image URL in different places. This helper keeps that lookup in one spot.
function extractPinImageUrl() {
  const svgEl = document.querySelector('[data-functional-selector="pin-input-svg"]');
  if (svgEl) {
    const imgEl = svgEl.querySelector('image[href], image[xlink\\:href]');
    if (imgEl) {
      const url = imgEl.getAttribute('href') || imgEl.getAttribute('xlink:href');
      if (url) { log('Pin image from SVG:', url.slice(0, 80)); return url; }
    }
  }
  const scaledImg = document.querySelector('[data-functional-selector="media-container__media-image"]');
  if (scaledImg) {
    const url = scaledImg.getAttribute('href') || scaledImg.getAttribute('src');
    if (url) { log('Pin image from media-container:', url.slice(0, 80)); return url; }
  }
  log('Pin image: no image found in DOM');
  return null;
}

// Extract the question's media image URL from the DOM (non-pin questions).
function extractQuestionImageUrl() {
  const img = document.querySelector('img[data-functional-selector="media-container__media-image"]');
  if (img) {
    const url = img.getAttribute('src');
    if (url) { log('Question image from DOM:', url.slice(0, 80)); return url; }
  }
  return null;
}

// For Pin, the content script only draws the suggestion and hands the actual placement to injected.js.
async function placePinOnSvg(coords, options = {}) {

  const deadline = (loadingEndsAt > 0 ? loadingEndsAt : Date.now()) + 5000;
  let svgEl = null;

  for (let attempt = 0; attempt < 80; attempt++) {
    svgEl = document.querySelector('[data-functional-selector="pin-input-svg"]');
    if (svgEl) {
      const rect = svgEl.getBoundingClientRect();
      const isVisible = rect.width > 50 && rect.height > 50;
      const noLoadingOverlay = !document.querySelector('[data-functional-selector="loading-bar-progress"]');
      if (isVisible && noLoadingOverlay) {

        await new Promise(r => setTimeout(r, 100));
        log(`Pin: SVG visible, overlay clear (attempt ${attempt}, ${Date.now()})`);
        break;
      }
    }
    svgEl = null;
    if (Date.now() > deadline) break;
    await new Promise(r => setTimeout(r, 100));
  }

  if (!svgEl) {
    svgEl = document.querySelector('[data-functional-selector="pin-input-svg"]');
    if (!svgEl) { updateStatus('Pin SVG not found'); return; }
    warn('Pin: proceeding despite overlay check');
  }

  log(`Pin: placing at ${coords.x.toFixed(1)}%, ${coords.y.toFixed(1)}%`);

  const doPlace = () => {
    window.dispatchEvent(new CustomEvent('autoPinAnswer', { detail: { x: coords.x, y: coords.y } }));
  };

  if (options.autoClick !== false) {
    const delay = options.answerDelay ?? 0;
    if (delay > 0) {
      if (!options.silentMode) showTimerOverlay(delay, doPlace);
      else setTimeout(doPlace, delay * 1000);
    } else {
      doPlace();
    }
  } else {
    if (options.highlight !== false && !options.silentMode) showPinCrosshair(svgEl, coords);
    updateStatus('Pin here 📍', `${coords.x.toFixed(1)}%, ${coords.y.toFixed(1)}%`);
  }
}

// Draw a lightweight crosshair so suggest-only mode still feels useful.
function showPinCrosshair(svgEl, coords) {
  document.querySelectorAll('.kaihoot-pin-crosshair').forEach(el => el.remove());

  const imgEl = svgEl.querySelector('[data-functional-selector="media-container__media-image"]')
    || svgEl.querySelector('image[href], image[xlink\\:href]')
    || svgEl.querySelector('image');
  const viewBox = String(svgEl.getAttribute('viewBox') || '').trim();
  const vb = viewBox ? viewBox.split(/[\s,]+/).map(Number) : [0, 0, 0, 0];
  const hasViewBox = vb.length === 4 && vb.every(Number.isFinite);
  const imgX = parseFloat(imgEl?.getAttribute('x') || String((hasViewBox ? vb[0] : 0) || 0));
  const imgY = parseFloat(imgEl?.getAttribute('y') || String((hasViewBox ? vb[1] : 0) || 0));
  const imgWidth = parseFloat(imgEl?.getAttribute('width') || String((hasViewBox ? vb[2] : 0) || 0));
  const imgHeight = parseFloat(imgEl?.getAttribute('height') || String((hasViewBox ? vb[3] : 0) || 0));
  const vbX = hasViewBox ? vb[0] : imgX;
  const vbY = hasViewBox ? vb[1] : imgY;
  const vbWidth = (hasViewBox ? vb[2] : imgWidth) || 1;
  const vbHeight = (hasViewBox ? vb[3] : imgHeight) || 1;

  const svgTargetX = imgX + (coords.x / 100) * (imgWidth || vbWidth);
  const svgTargetY = imgY + (coords.y / 100) * (imgHeight || vbHeight);

  let screenX, screenY;
  const ctm = svgEl.getScreenCTM();
  if (ctm) {
    const pt = svgEl.createSVGPoint();
    pt.x = svgTargetX; pt.y = svgTargetY;
    const sp = pt.matrixTransform(ctm);
    screenX = sp.x; screenY = sp.y;
  } else {
    const rect = svgEl.getBoundingClientRect();
    screenX = rect.left + ((svgTargetX - vbX) / vbWidth) * rect.width;
    screenY = rect.top + ((svgTargetY - vbY) / vbHeight) * rect.height;
  }

  const crosshair = document.createElement('div');
  crosshair.className = 'kaihoot-pin-crosshair';
  crosshair.style.cssText = `position:fixed; left:${screenX}px; top:${screenY}px; transform:translate(-50%,-50%); z-index:9999; pointer-events:none; width:0; height:0;`;

  const ring = document.createElement('div');
  ring.style.cssText = 'position:absolute; left:50%; top:50%; transform:translate(-50%,-50%); width:40px; height:40px; border:3px solid #ff3333; border-radius:50%; animation:kaihoot-pulse 1.2s ease-in-out infinite;';
  const dot = document.createElement('div');
  dot.style.cssText = 'position:absolute; left:50%; top:50%; transform:translate(-50%,-50%); width:12px; height:12px; background:#ff3333; border-radius:50%; box-shadow:0 0 6px rgba(255,51,51,0.6);';
  const hLine = document.createElement('div');
  hLine.style.cssText = 'position:absolute; left:50%; top:50%; transform:translate(-50%,-50%); width:60px; height:2px; background:rgba(255,51,51,0.7);';
  const vLine = document.createElement('div');
  vLine.style.cssText = 'position:absolute; left:50%; top:50%; transform:translate(-50%,-50%); width:2px; height:60px; background:rgba(255,51,51,0.7);';
  const labelEl = document.createElement('div');
  labelEl.style.cssText = 'position:absolute; left:calc(50% + 16px); top:calc(50% + 16px); background:rgba(0,0,0,0.85); color:#fff; padding:3px 8px; border-radius:4px; font:600 11px/1.3 monospace; white-space:nowrap;';
  labelEl.textContent = `📍 ${coords.x.toFixed(0)}%, ${coords.y.toFixed(0)}%`;

  if (!document.getElementById('kaihoot-pulse-style')) {
    const style = document.createElement('style');
    style.id = 'kaihoot-pulse-style';
    style.textContent = '@keyframes kaihoot-pulse { 0%,100% { width:40px; height:40px; opacity:.9 } 50% { width:56px; height:56px; opacity:.4 } }';
    document.head.appendChild(style);
  }

  crosshair.append(ring, dot, hLine, vLine, labelEl);
  (document.body || document.documentElement).appendChild(crosshair);

  let rafId;
  function updatePosition() {
    if (!crosshair.isConnected) return;
    const newCtm = svgEl.getScreenCTM();
    if (newCtm) {
      const pt2 = svgEl.createSVGPoint();
      pt2.x = svgTargetX; pt2.y = svgTargetY;
      const sp2 = pt2.matrixTransform(newCtm);
      crosshair.style.left = sp2.x + 'px';
      crosshair.style.top = sp2.y + 'px';
    }
    rafId = requestAnimationFrame(updatePosition);
  }
  rafId = requestAnimationFrame(updatePosition);

  const observer = new MutationObserver(() => {
    if (!crosshair.isConnected || !svgEl.isConnected || !document.querySelector('[data-functional-selector="pin-input-svg"]')) {
      crosshair.remove(); cancelAnimationFrame(rafId); observer.disconnect();
    }
  });
  observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
  setTimeout(() => { if (crosshair.isConnected) { crosshair.remove(); cancelAnimationFrame(rafId); observer.disconnect(); } }, 60000);
}

// Jumble is handled in the page context when possible, with a DOM fallback here if needed.
async function solveJumbleFromDOM(answerWord, options) {

  if (loadingEndsAt > 0) {
    const remaining = loadingEndsAt - Date.now();
    if (remaining > 0) {
      log(`Jumble: waiting ${remaining}ms for loading to finish`);
      await new Promise(r => setTimeout(r, remaining));
    }
  }

  for (let i = 0; i < 30; i++) {
    if (document.querySelector('[class*="arranger__Container"]')) break;
    await new Promise(r => setTimeout(r, 200));
  }

  let injectedHandled = false;
  const onHandled = () => { injectedHandled = true; };
  window.addEventListener('kaihootJumbleHandled', onHandled, { once: true });

  window.dispatchEvent(new CustomEvent('autoJumbleAnswer', { detail: { answerWord, autoClick: options.autoClick !== false } }));

  await new Promise(r => setTimeout(r, 1500));
  window.removeEventListener('kaihootJumbleHandled', onHandled);

  if (injectedHandled) {
    log('Jumble handled by injected.js (React state)');
    updateStatus('Answered ✅ (jumble)', answerWord);
    return;
  }

  log('Injected.js did not handle jumble, trying DOM clicks');

  const textEls = await pollForJumbleTextEls();
  if (textEls.length === 0) { updateStatus('Jumble tiles not found'); return; }

  const labels = textEls.map(el => el.textContent?.trim() || '');
  log('Jumble tile labels:', labels);

  const order = matching.computeTileOrder(answerWord, labels);
  if (!order) { updateStatus(`Can't map answer to tiles`); return; }
  log(`Tile order: [${order}] → "${order.map(i => labels[i]).join('')}"`);

  if (options.highlight !== false && !options.silentMode) showJumbleBadges(textEls, order);

  if (options.autoClick === false) {
    updateStatus('Jumble order shown', answerWord);
    return;
  }

  const doClick = () => {
    clickJumbleTilesSequence(textEls, order, () => {
      setTimeout(() => clickSubmitButton('jumble'), 500);
    });
  };

  const delay = options.answerDelay ?? 0;
  if (delay > 0) {
    if (!options.silentMode) showTimerOverlay(delay, doClick);
    else setTimeout(doClick, delay * 1000);
  } else {
    doClick();
  }
}

// Open-ended answers need to wait for the input to exist, but not for the whole intro animation.
async function dispatchOpenEndedAnswer(answer, options = {}) {
  const myNonce = submitNonce;
  const { autoClick = true, answerDelay = 0 } = options;

  const deadline = (loadingEndsAt > 0 ? loadingEndsAt : Date.now()) + 5000;
  let inputReady = false;

  for (let attempt = 0; attempt < 80; attempt++) {
    const input = document.querySelector('input[data-functional-selector="text-answer-input"]');
    if (input && !input.disabled) {
      const noOverlay = !document.querySelector('[data-functional-selector="loading-bar-progress"]');
      if (noOverlay) {
        log(`Open-ended: input found, overlay clear (attempt ${attempt})`);
        inputReady = true;
        break;
      }
    }
    if (Date.now() > deadline) break;
    if (submitNonce !== myNonce) return;
    await new Promise(r => setTimeout(r, 100));
  }

  if (!inputReady) {

    const input = document.querySelector('input[data-functional-selector="text-answer-input"]');
    if (!input) { updateStatus('✏️ Input not found'); return; }
    warn('Open-ended: proceeding despite overlay check');
  }

  if (submitNonce !== myNonce) return;

  if (answerDelay > 0) {
    log(`Open-ended: waiting ${answerDelay}s delay`);
    await new Promise(r => setTimeout(r, answerDelay * 1000));
    if (submitNonce !== myNonce) return;
  }

  window.dispatchEvent(new CustomEvent('autoTypeAnswer', {
    detail: { answer, autoClick }
  }));
  log(`Open-ended: dispatched "${answer}" to injected.js`);
  updateStatus('Answered ✅ (open-ended)', `✏️ ${answer}`);
}

// Slider answers are sent early, then mirrored into the UI once the control is ready.
async function solveSliderFromDOM(value, options) {
  const myNonce = submitNonce;

  const earlyInput = document.querySelector('input[data-functional-selector="slider-scale"]');
  if (earlyInput && options.autoClick !== false) {
    const rawMin = parseFloat(earlyInput.min), rawMax = parseFloat(earlyInput.max), rawStep = parseFloat(earlyInput.step);
    const min = isNaN(rawMin) ? 0 : rawMin, max = isNaN(rawMax) ? 100 : rawMax, step = isNaN(rawStep) ? 1 : rawStep;
    const snapped = Math.max(min, Math.min(max, min + Math.round((value - min) / step) * step));
    window.dispatchEvent(new CustomEvent('sliderWSSend', { detail: { value: snapped } }));
    log(`Slider: early WS sent with snapped value ${snapped}`);
  }

  const deadline = (loadingEndsAt > 0 ? loadingEndsAt : Date.now()) + 5000;
  let rangeInput = null;

  for (let attempt = 0; attempt < 80; attempt++) {
    rangeInput = document.querySelector('input[data-functional-selector="slider-scale"]');
    if (rangeInput) {
      const noLoadingOverlay = !document.querySelector('[data-functional-selector="loading-bar-progress"]');
      if (noLoadingOverlay) {
        await new Promise(r => setTimeout(r, 100));
        log(`Slider: range input found, overlay clear (attempt ${attempt})`);
        break;
      }
    }
    rangeInput = null;
    if (Date.now() > deadline) break;
    if (submitNonce !== myNonce) return;
    await new Promise(r => setTimeout(r, 100));
  }

  if (!rangeInput) {

    rangeInput = document.querySelector('input[data-functional-selector="slider-scale"]');
    if (!rangeInput) { updateStatus('🎚️ Slider not found'); return; }
    warn('Slider: proceeding despite overlay check');
  }

  const rawMin = parseFloat(rangeInput.min);
  const rawMax = parseFloat(rangeInput.max);
  const rawStep = parseFloat(rangeInput.step);
  const min = isNaN(rawMin) ? 0 : rawMin;
  const max = isNaN(rawMax) ? 100 : rawMax;
  const step = isNaN(rawStep) ? 1 : rawStep;
  const unit = rangeInput.getAttribute('aria-label') || '';
  log(`Slider: value=${value}, range=${min}-${max}, step=${step}, unit="${unit}"`);

  if (options.highlight !== false && !options.silentMode) {
    highlightSliderMarker(value);
  }

  if (options.autoClick === false) {
    updateStatus('Slider answer shown', `🎚️ ${value} ${unit}`);
    return;
  }

  const doSlider = () => {

    window.dispatchEvent(new CustomEvent('autoSliderAnswer', {
      detail: { value, autoClick: true, skipWS: true }
    }));
    updateStatus('Answered ✅ (slider)', `🎚️ ${value} ${unit}`);
  };

  const delay = options.answerDelay ?? 0;
  if (delay > 0) {
    if (!options.silentMode) showTimerOverlay(delay, doSlider);
    else setTimeout(doSlider, delay * 1000);
  } else {
    doSlider();
  }
}

// Mark the closest visible slider tick so suggest-only mode has something concrete to show.
function highlightSliderMarker(targetValue) {

  const markers = document.querySelectorAll('.spectrum__MarkerContainer-sc-1q4py3v-1, [data-functional-selector*="marker-container"]');
  let bestMarker = null, bestDiff = Infinity;

  for (const m of markers) {
    const label = m.querySelector('[class*="NumberIndicator"]');
    if (!label) continue;
    const numText = label.textContent.replace(/\s/g, '').replace(/\u00a0/g, '');
    const num = parseFloat(numText);
    if (isNaN(num)) continue;
    const diff = Math.abs(num - targetValue);
    if (diff < bestDiff) { bestDiff = diff; bestMarker = m; }
  }

  if (bestMarker) {
    const dot = bestMarker.querySelector('[class*="Marker-sc"], [data-functional-selector*="marker"]');
    if (dot) {
      dot.style.border = '3px solid #00ff00';
      dot.style.boxShadow = '0 0 12px #00ff00';
      dot.style.borderRadius = '50%';
      dot.style.transition = 'all 0.3s ease';
    }
  }
}

// Click the jumble tiles in sequence when we have to fall back to DOM interaction.
function clickJumbleTilesSequence(textEls, order, onComplete, idx = 0) {
  if (idx >= order.length) {
    log('All jumble tiles clicked');
    if (onComplete) onComplete();
    return;
  }

  const originalLabels = textEls.map(el => el.textContent?.trim() || '');
  const targetLabel = originalLabels[order[idx]];

  let currentTextEl = null;
  for (let i = 0; ; i++) {
    const el = document.querySelector(`[data-functional-selector="question-choice-text-${i}"]`);
    if (!el) break;
    if (el.textContent?.trim() === targetLabel) { currentTextEl = el; break; }
  }

  if (!currentTextEl) {
    currentTextEl = textEls[order[idx]];
    if (!currentTextEl?.isConnected) {
      warn(`Tile "${targetLabel}" gone, skipping`);
      clickJumbleTilesSequence(textEls, order, onComplete, idx + 1);
      return;
    }
  }

  const rect = currentTextEl.getBoundingClientRect();
  const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;

  const interactive = currentTextEl.closest('[draggable="true"]')
    || currentTextEl.closest('button')
    || currentTextEl.closest('[role="button"]')
    || currentTextEl.closest('[data-functional-selector*="card"]');
  const targets = [...new Set([interactive, currentTextEl].filter(Boolean))];

  const evtBase = { bubbles: true, cancelable: true, composed: true, view: window, clientX: cx, clientY: cy, button: 0, buttons: 1 };

  for (const t of targets) {
    t.dispatchEvent(new PointerEvent('pointerdown', { ...evtBase, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
    t.dispatchEvent(new MouseEvent('mousedown', evtBase));
  }

  setTimeout(() => {
    for (const t of targets) {
      t.dispatchEvent(new PointerEvent('pointerup', { ...evtBase, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
      t.dispatchEvent(new MouseEvent('mouseup', evtBase));
      t.dispatchEvent(new MouseEvent('click', evtBase));
      t.click();
    }
    setTimeout(() => clickJumbleTilesSequence(textEls, order, onComplete, idx + 1), 500);
  }, 80);
}

// Number badges make the intended tile order obvious in highlight mode.
function showJumbleBadges(textEls, order) {
  document.querySelectorAll('.kaihoot-jumble-badge').forEach(el => el.remove());

  for (let pos = 0; pos < order.length; pos++) {
    const textEl = textEls[order[pos]];
    if (!textEl) continue;

    const container = textEl.closest('[draggable="true"]')
      || textEl.closest('[data-functional-selector*="card"]')
      || textEl.closest('[data-functional-selector*="choice"]')
      || textEl.parentElement?.parentElement
      || textEl.parentElement;
    if (!container) continue;

    if (getComputedStyle(container).position === 'static') {
      container.style.position = 'relative';
    }

    const badge = document.createElement('div');
    badge.className = 'kaihoot-jumble-badge';
    badge.textContent = String(pos + 1);
    badge.style.cssText = `
      position:absolute; top:-8px; right:-8px;
      width:24px; height:24px; background:#ff3333; color:#fff; border-radius:50%;
      display:flex; align-items:center; justify-content:center;
      font:bold 14px sans-serif; z-index:10000;
      box-shadow:0 2px 8px rgba(0,0,0,0.5); pointer-events:none;
      animation:kaihoot-fadein .3s ease ${pos * 0.1}s both;
    `;
    container.appendChild(badge);
  }

  const cleanup = () => { document.querySelectorAll('.kaihoot-jumble-badge').forEach(el => el.remove()); observer.disconnect(); };
  setTimeout(cleanup, 15000);
  const observer = new MutationObserver(() => {
    if (!document.querySelector('[data-functional-selector="question-choice-text-0"]')) { cleanup(); }
  });
  observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
}

// One style block keeps the overlays self-contained and easy to remove later.
function injectGlobalStyles() {
  if (document.getElementById('kaihoot-global-css')) return;
  const s = document.createElement('style');
  s.id = 'kaihoot-global-css';
  s.textContent = '@keyframes kaihoot-fadein { from { opacity:0; transform:translateY(-8px) } to { opacity:1; transform:translateY(0) } }';
  if (document.head) document.head.appendChild(s);
  else document.addEventListener('DOMContentLoaded', () => document.head?.appendChild(s));
}
injectGlobalStyles();

}
