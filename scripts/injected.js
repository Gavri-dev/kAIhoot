// This file runs in the page context so it can talk to Kahoot's real
// WebSocket and React tree.

(function () {
  'use strict';

  // Styled logs so kAIhoot stands out in DevTools among Kahoot's own noise.
  const TAG = '[kAIhoot]';
  const STYLE = 'color:#10b981;font-weight:bold';
  const log = (...args) => console.log(`%c${TAG}`, STYLE, ...args);
  const warn = (...args) => console.warn(`%c${TAG}`, STYLE, ...args);
  const OldWebSocket = window.WebSocket;

  window.__kahootWS = null;
  window.kahootClientId = null;
  window.kahootGameId = null;
  window.kahootQuestionIndex = 0;
  window.kahootMessageId = 0;
  window.kahootDataId = 45;
  window.kahootWSTiles = [];

  const ANSWERABLE_TYPES = new Set(['quiz', 'true_false', 'multiple_select_quiz', 'pin_it', 'jumble', 'slider', 'open_ended']);
  const PIN_TYPES = new Set(['pin_it']);
  const JUMBLE_TYPES = new Set(['jumble']);
  const SLIDER_TYPES = new Set(['slider']);
  const OPEN_ENDED_TYPES = new Set(['open_ended']);

  // Wrap the native WebSocket so we can watch incoming questions and send answers back through the same channel.
  window.WebSocket = function (url, protocols) {
    const ws = protocols ? new OldWebSocket(url, protocols) : new OldWebSocket(url);
    window.__kahootWS = ws;

    ws.addEventListener('message', function (event) {
      try {
        if (typeof event.data !== 'string') return;
        const data = JSON.parse(event.data);
        const items = Array.isArray(data) ? data : [data];
        for (const item of items) {
          if (item.clientId && !window.kahootClientId) window.kahootClientId = item.clientId;
          if (item.data?.gameid && window.kahootGameId !== item.data.gameid) {
            window.kahootGameId = item.data.gameid;
            window.kahootQuestionIndex = 0;
            log('Game joined:', window.kahootGameId);
          }
          if (item.id) {
            const msgId = parseInt(item.id, 10);
            if (!isNaN(msgId) && msgId > window.kahootMessageId) window.kahootMessageId = msgId;
          }
          if (item.data?.content) parseQuestionContent(item.data.content);
        }
      } catch (e) { console.debug(TAG, 'WS parse error:', e.message); }
    });

    ws.addEventListener('open', () => log('WS connected'));

    const origSend = ws.send.bind(ws);
    ws.send = function (data) {
      try {
        const parsed = JSON.parse(data);
        const items = Array.isArray(parsed) ? parsed : [parsed];
        for (const item of items) {
          if (item.data?.content) {
            const content = typeof item.data.content === 'string' ? JSON.parse(item.data.content) : item.data.content;
            if (content.type) log('WS OUT:', content.type, JSON.stringify(content).slice(0, 200));
          }
        }
      } catch (e) { console.debug(TAG, 'WS send parse error:', e.message); }
      return origSend(data);
    };

    ws.addEventListener('close', () => {
      log('WS closed');
      window.__kahootWS = null;
      window.kahootClientId = null;
      window.kahootGameId = null;
      window.kahootQuestionIndex = 0;
      window.kahootMessageId = 0;
      window.dispatchEvent(new CustomEvent('kahootGameReset'));
    });

    return ws;
  };

  window.WebSocket.prototype = OldWebSocket.prototype;
  Object.defineProperties(window.WebSocket, {
    CONNECTING: { value: 0 }, OPEN: { value: 1 }, CLOSING: { value: 2 }, CLOSED: { value: 3 }
  });

  const _decodeEl = document.createElement('textarea');

  // Kahoot mixes plain text with HTML-encoded strings. Normalize them once here.
  function decodeEntities(str) {
    if (typeof str !== 'string') return String(str ?? '');
    _decodeEl.innerHTML = str;
    return _decodeEl.value.replace(/<[^>]*>/g, '');
  }

  const NON_SCORED_TYPES = new Set(['survey', 'word_cloud', 'poll']);

  // Convert Kahoot's payload into the simpler question shape the rest of the extension expects.
  function parseQuestionContent(raw) {
    try {
      const content = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (!content.title && !content.question) return;

      if (NON_SCORED_TYPES.has(content.type)) {
        window.dispatchEvent(new CustomEvent('kahootNonScoredQuestion', { detail: { type: content.type } }));
        return;
      }

      if (!ANSWERABLE_TYPES.has(content.type)) return;

      const isPin = PIN_TYPES.has(content.type);
      const isJumble = JUMBLE_TYPES.has(content.type);
      const isSlider = SLIDER_TYPES.has(content.type);
      const isOpenEnded = OPEN_ENDED_TYPES.has(content.type);

      let choices = [];
      let sliderConfig = null;

      if (isSlider) {

        const range = content.range || content.slider || {};
        sliderConfig = {
          min: range.min ?? content.min ?? null,
          max: range.max ?? content.max ?? null,
          step: range.step ?? content.step ?? null,
          unit: range.unit ?? content.unit ?? ''
        };
        log('Slider config from WS:', JSON.stringify(sliderConfig));

      } else if (isJumble) {
        const rawChoices = content.choices || [];
        choices = rawChoices.map(c => {
          if (typeof c === 'string') return decodeEntities(c);
          return decodeEntities(c.answer || c.text || c.label || String(c));
        });

        if (choices.length === 0 || choices.every(c => !c)) {
          let i = 0;
          while (true) {
            const el = document.querySelector(`[data-functional-selector="question-choice-text-${i}"]`);
            if (!el) break;
            choices.push(el.textContent?.trim() || '');
            i++;
          }
        }
        log('Jumble tiles:', choices);
        window.kahootWSTiles = [...choices];
        if (choices.length === 0) return;

      } else if (!isPin && !isSlider && !isOpenEnded) {
        const rawChoices = content.choices || [];
        choices = rawChoices.map(c => {
          if (typeof c === 'string') return decodeEntities(c);
          let text = c.answer || c.text || c.label || '';
          if (typeof text === 'string' && text.trim()) return decodeEntities(text);
          const alt = c.imageMetadata?.altText || c.alt || c.description || '';
          if (alt) return decodeEntities(alt);
          return '';
        });

        const hasImages = choices.some(c => c === '') &&
          rawChoices.some(c => typeof c === 'object' && (c.image || c.imageUrl || c.media?.image || c.media?.url));
        if (hasImages) {
          choices = choices.map((c, i) => c || `Image ${i + 1}`);
        }
        if (choices.length === 0) return;
      }

      let imageUrl = content.image || content.media?.image || content.media?.url || null;
      if (isPin) log('Pin image from WS:', imageUrl || '(none, will try DOM)');

      const question = {
        title: decodeEntities(content.title || content.question),
        choices: (isPin || isSlider || isOpenEnded) ? [] : choices,
        type: content.type,
        questionIndex: content.questionIndex ?? window.kahootQuestionIndex,
        imageUrl,
        ...(isSlider && sliderConfig ? { sliderConfig } : {})
      };

      window.kahootQuestionIndex = question.questionIndex;
      window.dispatchEvent(new CustomEvent('kahootQuestionParsed', { detail: question }));
    } catch (e) { console.debug(TAG, 'Question parse error:', e.message); }
  }

  // Build answer packets that match Kahoot's own controller messages closely enough to be accepted.
  function makePayload(contentObj) {
    const { kahootGameId: gameid, kahootClientId: clientId } = window;
    window.kahootMessageId++;
    return [{
      id: String(window.kahootMessageId),
      channel: '/service/controller',
      data: {
        gameid, type: 'message', host: 'kahoot.it',
        id: window.kahootDataId,
        content: JSON.stringify(contentObj)
      },
      clientId, ext: {}
    }];
  }

  // Bail if the socket isn't ready. Better to skip than send junk.
  function wsSend(payload) {
    const ws = window.__kahootWS;
    if (!ws || ws.readyState !== OldWebSocket.OPEN || !window.kahootGameId || !window.kahootClientId) {
      warn('Cannot send - WS not ready');
      return false;
    }
    ws.send(JSON.stringify(payload));
    return true;
  }

  // These helpers keep the quiz and multi-select answer packets tiny.
  window.sendAutoClickMessage = function (choice) {
    wsSend(makePayload({ type: 'quiz', choice, questionIndex: window.kahootQuestionIndex }));
  };

  window.sendMultiSelectMessage = function (choices) {
    wsSend(makePayload({ type: 'multiple_select_quiz', choice: choices, questionIndex: window.kahootQuestionIndex }));
  };

  // Pin placement has to respect the SVG viewBox, not just the rendered pixel box.
  function getPinSvgPlacement(svgEl, x, y) {
    const imgEl = svgEl.querySelector('[data-functional-selector="media-container__media-image"]') || svgEl.querySelector('image');
    const viewBoxValues = String(svgEl.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
    const hasViewBox = viewBoxValues.length === 4 && viewBoxValues.every(Number.isFinite);
    const [minX, minY, vbWidth, vbHeight] = hasViewBox ? viewBoxValues : [0, 0, svgEl.viewBox?.baseVal?.width || 0, svgEl.viewBox?.baseVal?.height || 0];
    const imgX = parseFloat(imgEl?.getAttribute('x') || String(minX || 0));
    const imgY = parseFloat(imgEl?.getAttribute('y') || String(minY || 0));
    const imgWidth = parseFloat(imgEl?.getAttribute('width') || String(vbWidth || 0));
    const imgHeight = parseFloat(imgEl?.getAttribute('height') || String(vbHeight || 0));

    const svgX = imgX + (Math.max(0, Math.min(100, x)) / 100) * (imgWidth || vbWidth || 1);
    const svgY = imgY + (Math.max(0, Math.min(100, y)) / 100) * (imgHeight || vbHeight || 1);

    let clientX, clientY;
    const ctm = svgEl.getScreenCTM();
    if (ctm && typeof svgEl.createSVGPoint === 'function') {
      const pt = svgEl.createSVGPoint();
      pt.x = svgX;
      pt.y = svgY;
      const sp = pt.matrixTransform(ctm);
      clientX = sp.x;
      clientY = sp.y;
    } else {
      const rect = svgEl.getBoundingClientRect();
      const screenBaseX = hasViewBox ? minX : imgX;
      const screenBaseY = hasViewBox ? minY : imgY;
      const screenW = (hasViewBox ? vbWidth : imgWidth) || rect.width || 1;
      const screenH = (hasViewBox ? vbHeight : imgHeight) || rect.height || 1;
      clientX = rect.left + ((svgX - screenBaseX) / screenW) * rect.width;
      clientY = rect.top + ((svgY - screenBaseY) / screenH) * rect.height;
    }

    return {
      normalizedX: Math.max(0, Math.min(1, x / 100)),
      normalizedY: Math.max(0, Math.min(1, y / 100)),
      svgX,
      svgY,
      clientX,
      clientY,
    };
  }

  // React state updates are the cleanest path when Kahoot exposes the right internals.
  function applyPinViaReact(svgEl, placement) {
    const fiberKey = Object.keys(svgEl).find(k => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
    if (!fiberKey) return false;

    let fiber = svgEl[fiberKey];
    let depth = 0;
    while (fiber && depth < 40) {
      if (fiber.memoizedProps?.setPinValue) {
        fiber.memoizedProps.setPinValue({ x: placement.normalizedX, y: placement.normalizedY });
        log('setPinValue called at depth', depth);
        return true;
      }
      if (fiber.stateNode?.setPinValue) {
        fiber.stateNode.setPinValue({ x: placement.normalizedX, y: placement.normalizedY });
        return true;
      }
      fiber = fiber.return;
      depth++;
    }

    fiber = svgEl[fiberKey];
    depth = 0;
    while (fiber && depth < 40) {
      let hook = fiber.memoizedState;
      while (hook) {
        const val = hook.memoizedState;
        if (val && typeof val === 'object' && ('x' in val || 'pinX' in val) && hook.queue?.dispatch) {
          if ('pinX' in val) hook.queue.dispatch({ pinX: placement.normalizedX, pinY: placement.normalizedY });
          else hook.queue.dispatch({ x: placement.normalizedX, y: placement.normalizedY });
          return true;
        }
        hook = hook.next;
      }
      fiber = fiber.return;
      depth++;
    }

    return false;
  }

  // Pointer events stay as a fallback for layouts where the React shortcut is missing.
  function applyPinViaPointer(svgEl, placement) {
    const { clientX, clientY } = placement;
    const propsKey = Object.keys(svgEl).find(k => k.startsWith('__reactProps$'));
    if (propsKey) {
      const props = svgEl[propsKey];
      const fakeEvt = {
        clientX, clientY, pageX: clientX + window.scrollX, pageY: clientY + window.scrollY,
        button: 0, buttons: 1, preventDefault() {}, stopPropagation() {}, persist() {},
        target: svgEl, currentTarget: svgEl,
        nativeEvent: new MouseEvent('mousedown', { clientX, clientY, bubbles: true }),
        type: 'mousedown'
      };
      if (props.onMouseDown) props.onMouseDown(fakeEvt);
      if (props.onMouseUp) { fakeEvt.type = 'mouseup'; props.onMouseUp(fakeEvt); }
    }

    const evtInit = { bubbles: true, cancelable: true, view: window, clientX, clientY, button: 0, buttons: 1 };
    svgEl.dispatchEvent(new MouseEvent('mousedown', evtInit));
    svgEl.dispatchEvent(new MouseEvent('mouseup', evtInit));
    svgEl.dispatchEvent(new MouseEvent('click', evtInit));
  }

  // Content.js sends this event after it decides whether Pin should auto-place or just highlight.
  window.addEventListener('autoPinAnswer', function (event) {
    const { x, y } = event.detail;
    log('Pin:', x + '%,', y + '%');

    const svgEl = document.querySelector('[data-functional-selector="pin-input-svg"]');
    if (!svgEl) { warn('Pin SVG not found'); return; }

    const placement = getPinSvgPlacement(svgEl, x, y);
    let pinSet = applyPinViaReact(svgEl, placement);

    if (!pinSet) {
      applyPinViaPointer(svgEl, placement);
      pinSet = true;
      log('Pin fallback: pointer placement used');
    }

    wsSend(makePayload({
      type: 'pin_it', pinX: placement.normalizedX, pinY: placement.normalizedY,
      questionIndex: window.kahootQuestionIndex
    }));

    log('Pin complete, setPinValue=' + pinSet + `, svg=(${placement.svgX.toFixed(2)}, ${placement.svgY.toFixed(2)})`);

    setTimeout(() => {
      const btn = document.querySelector('button[data-functional-selector="pin-answer-submit"]')
                || document.querySelector('button[data-functional-selector*="submit"]');
      if (btn) {
        btn.click();
        log('Pin submit clicked');
      } else {
        log('Pin submit button not found');
      }
    }, pinSet ? 220 : 320);
  });

  // Single-answer auto-click path.
  window.addEventListener('autoClickAnswer', e => window.sendAutoClickMessage(e.detail));

  // Multi-select auto-click path.
  window.addEventListener('autoClickMultiSelect', e => window.sendMultiSelectMessage(e.detail));

  // Try WebSocket submission first for speed, then mirror the reorder in React so the UI stays honest.
  window.addEventListener('autoJumbleAnswer', async function (event) {
    const { answerWord, autoClick } = event.detail;
    log('Jumble answer:', answerWord, 'autoClick:', autoClick);

    if (!autoClick) {
      log('AutoClick off - skipping WS and React for jumble');
      return;
    }

    const wsTiles = window.kahootWSTiles || [];
    log('WS tiles:', wsTiles);
    if (wsTiles.length === 0 || !answerWord) return;

    const wsOrder = computeTileOrder(answerWord, wsTiles);
    if (wsOrder) {
      log('WS order:', wsOrder, '→', wsOrder.map(i => wsTiles[i]).join(''));
      wsSend(makePayload({ type: 'jumble', choice: wsOrder, answer: wsOrder, sequence: wsOrder, questionIndex: window.kahootQuestionIndex }));

      window.dispatchEvent(new CustomEvent('kaihootJumbleHandled'));
    }

    let arrangerEl = document.querySelector('[class*="arranger__Container"]');
    if (!arrangerEl) {

      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 200));
        arrangerEl = document.querySelector('[class*="arranger__Container"]');
        if (arrangerEl) break;
      }
    }
    if (!arrangerEl) {
      log('No arranger container found - relying on WS submission only');
      return;
    }

    const domLabels = [];
    let i = 0;
    while (true) {
      const el = document.querySelector(`[data-functional-selector="question-choice-text-${i}"]`);
      if (!el) break;
      domLabels.push(el.textContent?.trim() || '');
      i++;
    }

    const domOrder = computeTileOrder(answerWord, domLabels);
    if (!domOrder) { warn('Could not compute DOM order'); return; }
    log('DOM labels:', domLabels, 'DOM order:', domOrder);

    let reactReordered = false;
    const fk = Object.keys(arrangerEl).find(k => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
    if (fk) {
      let f = arrangerEl[fk], depth = 0;
      while (f && depth < 30) {
        if (f.memoizedProps?.setOrder) {
          try { f.memoizedProps.setOrder(domOrder); reactReordered = true; } catch (_) {}
        }
        let hook = f.memoizedState, hi = 0;
        while (hook) {
          const val = hook.memoizedState;
          if (Array.isArray(val) && val.length === domLabels.length && val.every(v => typeof v === 'number')) {
            if (hook.queue?.dispatch) {
              hook.queue.dispatch(domOrder);
              reactReordered = true;
            }
          }
          hook = hook.next; hi++;
        }
        if (reactReordered) break;
        f = f.return; depth++;
      }
    }

    if (reactReordered) {
      log('React state reordered');
      let attempts = 0;
      function trySubmit() {
        attempts++;
        const btn = findSubmitButton();
        if (btn) {
          btn.click();
          const pk = Object.keys(btn).find(k => k.startsWith('__reactProps$'));
          if (pk && btn[pk]?.onClick) {
            try { btn[pk].onClick({ preventDefault() {}, stopPropagation() {}, persist() {}, target: btn, currentTarget: btn, type: 'click', nativeEvent: new MouseEvent('click') }); } catch (_) {}
          }
        } else if (attempts < 15) {
          setTimeout(trySubmit, 500);
        }
      }
      setTimeout(trySubmit, 600);
      window.dispatchEvent(new CustomEvent('kaihootJumbleHandled'));
    }
  });

  // Send the slider answer as soon as we know it. UI updates can happen a moment later.
  window.addEventListener('sliderWSSend', function (event) {
    const { value } = event.detail;
    log('Slider early WS:', value);
    wsSend(makePayload({
      type: 'slider',
      choice: value,
      questionIndex: window.kahootQuestionIndex
    }));
  });

  // Slider inputs need a value write plus the events React listens for.
  window.addEventListener('autoSliderAnswer', function (event) {
    const { value, autoClick, skipWS } = event.detail;
    log('Slider answer:', value, 'autoClick:', autoClick, 'skipWS:', !!skipWS);

    const rangeInput = document.querySelector('input[data-functional-selector="slider-scale"]');
    if (!rangeInput) {
      warn('Slider range input not found');
      return;
    }

    const rawMin = parseFloat(rangeInput.min);
    const rawMax = parseFloat(rangeInput.max);
    const rawStep = parseFloat(rangeInput.step);
    const min = isNaN(rawMin) ? 0 : rawMin;
    const max = isNaN(rawMax) ? 100 : rawMax;
    const step = isNaN(rawStep) ? 1 : rawStep;
    const snapped = min + Math.round((value - min) / step) * step;
    const clamped = Math.max(min, Math.min(max, snapped));
    log(`Slider: target=${value}, snapped=${clamped} (min=${min}, max=${max}, step=${step})`);

    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (nativeSetter) {
      nativeSetter.call(rangeInput, clamped);
    } else {
      rangeInput.value = clamped;
    }

    rangeInput.dispatchEvent(new Event('input', { bubbles: true }));
    rangeInput.dispatchEvent(new Event('change', { bubbles: true }));

    if (!autoClick) {
      log('AutoClick off - slider value set but not submitting');
      return;
    }

    if (!skipWS) {
      wsSend(makePayload({
        type: 'slider',
        choice: clamped,
        questionIndex: window.kahootQuestionIndex
      }));
      log('WS OUT: slider', JSON.stringify({ type: 'slider', choice: clamped }));
    }

    setTimeout(() => {
      const btn = document.querySelector('button[data-functional-selector="slider-submit"]')
                || findSubmitButton();
      if (btn) {
        btn.click();
        log('Slider submit clicked');
      } else {
        log('Slider submit button not found');
      }
    }, 300);
  });

  // Submit button selectors drift between Kahoot builds, so keep this finder broad.
  function findSubmitButton() {
    for (const sel of [
      '[data-functional-selector="submit-button"]',
      '[data-functional-selector="multi-select-submit-button"]',
      '[data-functional-selector="multi-select-submit"]',
      '[data-functional-selector="jumble-submit-button"]',
      '[data-functional-selector="slider-submit"]',
      '[data-functional-selector="text-answer-submit"]',
      '[data-functional-selector="pin-answer-submit"]',
      '[data-functional-selector="confirm"]',
      '[data-functional-selector*="submit"]',
      'button[type="submit"]'
    ]) {
      const btn = document.querySelector(sel);
      if (btn && !btn.disabled && btn.offsetParent !== null) return btn;
    }
    for (const btn of document.querySelectorAll('button')) {
      const text = btn.textContent.trim().toLowerCase();
      if (['submit', 'confirm', 'done', 'check'].includes(text) && !btn.disabled && btn.offsetParent !== null) return btn;
    }
    return null;
  }

  // Same tile-order logic as the shared helper, duplicated here because the page context is not a module.
  function computeTileOrder(answer, tiles) {
    const answerLower = answer.toLowerCase().replace(/[\s\-]/g, '');
    const tilesLower = tiles.map(t => t.toLowerCase().replace(/[\s\-]/g, ''));
    const used = new Set(), order = [];
    let pos = 0;

    while (pos < answerLower.length && order.length < tiles.length) {
      let found = false;
      const candidates = tilesLower.map((t, i) => ({ text: t, idx: i, len: t.length }))
        .filter(c => !used.has(c.idx)).sort((a, b) => b.len - a.len);
      for (const c of candidates) {
        if (answerLower.startsWith(c.text, pos)) {
          order.push(c.idx); used.add(c.idx); pos += c.text.length; found = true; break;
        }
      }
      if (!found) break;
    }
    if (order.length === tiles.length && pos === answerLower.length) return order;

    if (tiles.length > 8) return null;
    function permute(remaining, current) {
      if (remaining.length === 0) return current.map(i => tilesLower[i]).join('') === answerLower ? current : null;
      for (let j = 0; j < remaining.length; j++) {
        const next = [...current, remaining[j]];
        if (!answerLower.startsWith(next.map(i => tilesLower[i]).join(''))) continue;
        const result = permute([...remaining.slice(0, j), ...remaining.slice(j + 1)], next);
        if (result) return result;
      }
      return null;
    }
    return permute(tilesLower.map((_, i) => i), []);
  }

  // Type open-ended answers character by character so controlled inputs do not drop updates.
  window.addEventListener('autoTypeAnswer', async function (event) {
    const { answer, autoClick } = event.detail;
    log('Open-ended answer:', answer, 'autoClick:', autoClick);

    const input = document.querySelector('input[data-functional-selector="text-answer-input"]');
    if (!input) {
      warn('Open-ended input not found');
      return;
    }

    const rawMaxLen = parseInt(input.getAttribute('maxlength'), 10);
    const maxLen = (rawMaxLen > 0) ? rawMaxLen : 20;
    const trimmed = answer.slice(0, maxLen);

    input.focus();

    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;

    for (let i = 0; i < trimmed.length; i++) {
      const char = trimmed[i];
      const currentVal = trimmed.slice(0, i + 1);

      if (nativeSetter) {
        nativeSetter.call(input, currentVal);
      } else {
        input.value = currentVal;
      }

      input.dispatchEvent(new KeyboardEvent('keydown', { key: char, bubbles: true }));
      input.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        cancelable: true,
        inputType: 'insertText',
        data: char
      }));
      input.dispatchEvent(new KeyboardEvent('keyup', { key: char, bubbles: true }));

      if (i < trimmed.length - 1) await new Promise(r => setTimeout(r, 12));
    }

    log('Open-ended typed:', input.value, '(expected:', trimmed + ')');

    // Some React inputs need a change event or blur to validate the value.
    input.dispatchEvent(new Event('change', { bubbles: true }));

    if (!autoClick) {
      log('AutoClick off - answer typed but not submitting');
      return;
    }

    for (let i = 0; i < 20; i++) {
      const btn = document.querySelector('button[data-functional-selector="text-answer-submit"]')
                || findSubmitButton();
      if (btn && !btn.disabled) {
        btn.click();
        log('Open-ended submit clicked');
        return;
      }
      await new Promise(r => setTimeout(r, 150));
    }
    log('Open-ended submit button not found/enabled after polling');
  });

  // If you see this log, the page hook is live.
  log('Injected - listening');
})();
