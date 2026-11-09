// kAIhoot popup

import { migrateApiKeyToLocal } from './core/storage.js';
import { DEFAULT_MODEL, DEFAULT_VISION_MODEL, DEPRECATED_MODELS } from './core/constants.js';

const versionLabel    = document.getElementById('versionLabel');
const apiStatus       = document.getElementById('apiStatus');
const liveSection     = document.getElementById('liveSection');
const questionText    = document.getElementById('questionText');
const answerText      = document.getElementById('answerText');
const highlightCb     = document.getElementById('highlight');
const autoclickCb     = document.getElementById('autoclick');
const pinHighlightCb  = document.getElementById('pinHighlight');
const pinAutoclickCb  = document.getElementById('pinAutoclick');
const silentCb        = document.getElementById('silent');
const delaySlider     = document.getElementById('answerDelay');
const delayValue      = document.getElementById('delayValue');
const toggleOpenAI    = document.getElementById('toggleOpenAI');
const openaiSection   = document.getElementById('openaiSection');
const collapseArrow   = document.getElementById('collapseArrow');
const apiKeyInput     = document.getElementById('openaiApiKey');
const modelSelect     = document.getElementById('openaiModel');
const visionSelect    = document.getElementById('openaiVisionModel');
const saveBtn         = document.getElementById('saveApi');
const clearBtn        = document.getElementById('clearApi');


const TYPE_LABELS = {
  quiz: 'MCQ', true_false: 'T/F', multiple_select_quiz: 'Multi',
  pin_it: 'Pin', jumble: 'Jumble', slider: 'Slider', open_ended: 'Open'
};

// --- Live tracking ---

function showQuestion(title, type) {
  if (!title) return;
  liveSection?.classList.remove('hidden');
  const badge = type && TYPE_LABELS[type] ? `[${TYPE_LABELS[type]}] ` : '';
  if (questionText) {
    questionText.textContent = badge + title;
    questionText.classList.add('active');
  }
}

function showAnswer(answer) {
  if (!answer) return;
  liveSection?.classList.remove('hidden');
  if (answerText) {
    answerText.textContent = answer;
    answerText.classList.remove('thinking');
    answerText.classList.add('active');
  }
}

function setThinking() {
  if (answerText) {
    answerText.textContent = 'Thinking...';
    answerText.classList.add('thinking');
    answerText.classList.remove('active');
  }
}

async function pollCurrentQuestion() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    const resp = await chrome.tabs.sendMessage(tab.id, { action: 'getQuestion' });
    if (resp?.question) {
      showQuestion(resp.question.title, resp.question.type);
      if (resp.answer) showAnswer(resp.answer);
    }
  } catch (_) {}
}

chrome.runtime.onMessage.addListener((request) => {
  if (request.action === 'updateQuestion' && request.question) {
    showQuestion(request.question.title, request.question.type);
    setThinking();
  }
  if (request.action === 'updateAnswer' && request.answer) {
    showAnswer(request.answer);
  }
});

// --- Status ---

function setApiStatus(state) {
  if (!apiStatus) return;
  const map = {
    connected: ['Connected', 'ok'],
    invalid:   ['Invalid key', 'missing'],
    checking:  ['Checking…', ''],
    set:       ['Key set', ''],
    none:      ['No key', 'missing']
  };
  const [text, cls] = map[state] || map.none;
  apiStatus.textContent = text;
  apiStatus.className = `api-pill ${cls}`.trim();
}

// Lightweight check so the pill reflects whether the key actually works, rather
// than showing "Connected" for any non-empty string.
async function validateApiKey(key) {
  try {
    const resp = await fetch('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${key}` } });
    if (resp.ok) return 'connected';
    if (resp.status === 401 || resp.status === 403) return 'invalid';
    return 'set'; // other error (e.g. rate limit) — key is plausibly fine, just unconfirmed
  } catch {
    return 'set'; // network error — can't verify; don't claim Connected or Invalid
  }
}

async function refreshApiStatus(key) {
  if (!key) { setApiStatus('none'); return; }
  setApiStatus('checking');
  setApiStatus(await validateApiKey(key));
}

function updateDelayLabel(value) {
  if (delayValue) delayValue.textContent = value > 0 ? `${value}s` : 'Off';
}

// --- Settings ---

async function loadSettings() {
  const settings = await chrome.storage.sync.get([
    'highlightOption', 'autoClickOption', 'pinHighlightOption', 'pinAutoClickOption',
    'silentMode', 'answerDelay', 'openaiModel', 'openaiVisionModel'
  ]);
  const migratedKey = await migrateApiKeyToLocal();

  if (highlightCb) highlightCb.checked = settings.highlightOption !== false;
  if (autoclickCb) autoclickCb.checked = settings.autoClickOption !== false;
  if (pinHighlightCb) pinHighlightCb.checked = settings.pinHighlightOption !== false;
  if (pinAutoclickCb) pinAutoclickCb.checked = !!settings.pinAutoClickOption;
  if (silentCb) silentCb.checked = !!settings.silentMode;

  const delay = settings.answerDelay ?? 0;
  if (delaySlider) delaySlider.value = delay;
  updateDelayLabel(delay);

  if (apiKeyInput) apiKeyInput.value = migratedKey || '';

  // Set model dropdowns, migrating deprecated models to defaults
  let model = (settings.openaiModel || DEFAULT_MODEL).trim();
  if (DEPRECATED_MODELS.has(model.toLowerCase())) model = DEFAULT_MODEL;
  setSelectValue(modelSelect, model, DEFAULT_MODEL);

  let visionModel = (settings.openaiVisionModel || DEFAULT_VISION_MODEL).trim();
  if (DEPRECATED_MODELS.has(visionModel.toLowerCase())) visionModel = DEFAULT_VISION_MODEL;
  setSelectValue(visionSelect, visionModel, DEFAULT_VISION_MODEL);

  refreshApiStatus(migratedKey);
  return !!migratedKey;
}

// Pick the matching option, or fall back to the default
function setSelectValue(select, value, fallback) {
  if (!select) return;
  const options = [...select.options].map(o => o.value);
  select.value = options.includes(value) ? value : fallback;
}

function wireSettings() {
  highlightCb?.addEventListener('change', () => chrome.storage.sync.set({ highlightOption: highlightCb.checked }));
  autoclickCb?.addEventListener('change', () => chrome.storage.sync.set({ autoClickOption: autoclickCb.checked }));
  pinHighlightCb?.addEventListener('change', () => chrome.storage.sync.set({ pinHighlightOption: pinHighlightCb.checked }));
  pinAutoclickCb?.addEventListener('change', () => chrome.storage.sync.set({ pinAutoClickOption: pinAutoclickCb.checked }));
  silentCb?.addEventListener('change', () => chrome.storage.sync.set({ silentMode: silentCb.checked }));

  let delayDebounce = null;
  delaySlider?.addEventListener('input', () => {
    const v = parseFloat(delaySlider.value);
    updateDelayLabel(v);
    clearTimeout(delayDebounce);
    delayDebounce = setTimeout(() => chrome.storage.sync.set({ answerDelay: v }), 250);
  });

  toggleOpenAI?.addEventListener('click', () => {
    const isHidden = openaiSection.classList.toggle('hidden');
    collapseArrow.textContent = isHidden ? '▸' : '▾';
  });

  saveBtn?.addEventListener('click', async () => {
    const key = apiKeyInput?.value.trim() || '';
    const model = modelSelect?.value || DEFAULT_MODEL;
    const visionModel = visionSelect?.value || DEFAULT_VISION_MODEL;
    await chrome.storage.local.set({ openaiApiKey: key });
    await chrome.storage.sync.set({ openaiModel: model, openaiVisionModel: visionModel });
    await chrome.storage.sync.remove(['openaiApiKey']);
    refreshApiStatus(key);
    // Flash "Saved!", THEN collapse — otherwise the panel hides the confirmation
    // in the same tick it is shown.
    if (saveBtn) {
      const orig = saveBtn.textContent;
      saveBtn.textContent = 'Saved!';
      saveBtn.classList.add('saved');
      setTimeout(() => {
        saveBtn.textContent = orig;
        saveBtn.classList.remove('saved');
        if (key) { openaiSection?.classList.add('hidden'); collapseArrow.textContent = '▸'; }
      }, 1200);
    } else if (key) {
      openaiSection?.classList.add('hidden'); collapseArrow.textContent = '▸';
    }
  });

  clearBtn?.addEventListener('click', async () => {
    await chrome.storage.local.remove(['openaiApiKey']);
    await chrome.storage.sync.remove(['openaiApiKey', 'openaiModel', 'openaiVisionModel']);
    if (apiKeyInput) apiKeyInput.value = '';
    setSelectValue(modelSelect, DEFAULT_MODEL, DEFAULT_MODEL);
    setSelectValue(visionSelect, DEFAULT_VISION_MODEL, DEFAULT_VISION_MODEL);
    setApiStatus('none');
  });
}

// --- Init ---

(async function init() {
  if (versionLabel) versionLabel.textContent = `v${chrome.runtime.getManifest().version}`;
  const hasKey = await loadSettings();
  wireSettings();
  pollCurrentQuestion();
  if (!hasKey) {
    openaiSection?.classList.remove('hidden');
    if (collapseArrow) collapseArrow.textContent = '▾';
  }
})();
