// DOM helpers for finding answer buttons and submit buttons.
// IIFE because content scripts run as classic scripts.
(function initDomAdapter(global) {
  const ANSWER_SELECTORS = [
    'button[data-functional-selector^="answer-"]',
    '[data-functional-selector^="answer-" i]',
    '[data-functional-selector*="question-choice" i]',
    '[data-functional-selector*="answer-card" i]',
    '[data-functional-selector="answer-option"]',
    '[data-functional-selector="answer"]',
    '[data-functional-selector="answer-button"]',
    'button[data-functional-selector*="answer"]',
    'button[class*="answer"]',
    'button[class*="choice__Choice"]',
  ];

  const SUBMIT_SELECTORS = [
    'button[data-functional-selector="submit-button"]',
    'button[data-functional-selector="multi-select-submit-button"]',
    'button[data-functional-selector="multi-select-submit"]',
    'button[data-functional-selector="pin-answer-submit"]',
    'button[data-functional-selector="jumble-submit-button"]',
    'button[data-functional-selector="slider-submit"]',
    'button[data-functional-selector="text-answer-submit"]',
    'button[data-functional-selector*="submit"]',
    'button[data-functional-selector="confirm"]',
    'button[type="submit"]',
  ];

  function findFirstVisible(selectors, root = document) {
    for (const selector of selectors) {
      const element = root.querySelector(selector);
      if (element && !element.disabled && element.offsetParent !== null) {
        return { element, selector };
      }
    }
    return { element: null, selector: null };
  }

  function findAnswerElements(root = document) {
    for (const selector of ANSWER_SELECTORS) {
      const elements = root.querySelectorAll(selector);
      if (elements.length > 0) return Array.from(elements);
    }
    return [];
  }

  function findSubmitButton(root = document) {
    return findFirstVisible(SUBMIT_SELECTORS, root);
  }

  function cleanButtonText(element) {
    if (!element) return '';

    const image = element.querySelector('img[aria-label]');
    if (image) {
      const label = image.getAttribute('aria-label')?.trim();
      if (label) return label.toLowerCase();
    }

    const clone = element.cloneNode(true);
    clone.querySelectorAll('.kaihoot-checkmark').forEach(checkmark => checkmark.remove());
    let text = clone.textContent.toLowerCase().trim().replace(/icon/gi, '').replace(/\s+/g, ' ').trim();

    // Kahoot sometimes duplicates the same label multiple times inside a button.
    for (const divisor of [3, 2]) {
      if (text.length >= divisor * 2) {
        const chunk = text.length / divisor;
        if (Number.isInteger(chunk)) {
          const part = text.substring(0, chunk);
          if (part.repeat(divisor) === text) {
            text = part;
            break;
          }
        }
      }
    }

    return text;
  }

  global.kAIhootDomAdapter = {
    findAnswerElements,
    findSubmitButton,
    cleanButtonText
  };
})(globalThis);
