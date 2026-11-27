(() => {
  let lastProcessedQuestion = "";
  let candidateQueue = [];
  let retryTimer = null;
  let isProcessing = false;

  const DEFAULT_PROMPT_SELECTORS = [
    ".ds-card .prompt", // krillion.io
    ".kr-prompt", // playdaily.org/krillion
    ".prompt"
  ];

  const DEFAULT_INPUT_SELECTORS = [
    "input.ds-input:not([disabled])",
    "input.kr-input:not([disabled])",
    "input[type='text']:not([disabled])",
    "input:not([type]):not([disabled])",
    "textarea:not([disabled])"
  ];

  function findVisibleElement(selectors) {
    for (const sel of selectors) {
      if (!sel) continue;
      const elements = document.querySelectorAll(sel);
      for (const el of elements) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          return el;
        }
      }
    }
    return null;
  }

  function extractPromptText(customSelector) {
    const selectors = customSelector
      ? [customSelector, ...DEFAULT_PROMPT_SELECTORS]
      : DEFAULT_PROMPT_SELECTORS;

    for (const sel of selectors) {
      const elements = document.querySelectorAll(sel);
      for (const el of elements) {
        const rect = el.getBoundingClientRect();
        const text = (el.innerText || el.textContent || "").trim();
        // Filter out site titles/headers and require prompt-like length
        if (
          rect.width > 0 &&
          rect.height > 0 &&
          text.length >= 8 &&
          text.length <= 240 &&
          !/^(krillion|daily dive|how to play|leaderboard)/i.test(text)
        ) {
          return text;
        }
      }
    }
    return null;
  }

  function setNativeInputValue(inputEl, value) {
    const prototype = Object.getPrototypeOf(inputEl);
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
    if (descriptor && descriptor.set) {
      descriptor.set.call(inputEl, value);
    } else {
      inputEl.value = value;
    }
    inputEl.dispatchEvent(new Event("input", { bubbles: true }));
    inputEl.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function submitAnswer(inputEl) {
    const enterOptions = {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true
    };
    inputEl.dispatchEvent(new KeyboardEvent("keydown", enterOptions));
    inputEl.dispatchEvent(new KeyboardEvent("keypress", enterOptions));
    inputEl.dispatchEvent(new KeyboardEvent("keyup", enterOptions));

    const form = inputEl.closest("form");
    if (form) {
      form.requestSubmit ? form.requestSubmit() : form.submit();
      return;
    }

    // Fallback: click visible "Dive" or submit button near the input
    const buttons = Array.from(document.querySelectorAll("button"));
    const diveBtn = document.querySelector(".ds-dive-btn:not([disabled]), .kr-send:not([disabled])") || buttons.find((btn) => {
      const label = (btn.innerText || "").trim();
      return !btn.disabled && /^(dive|submit|go|send)$/i.test(label);
    });
    if (diveBtn) diveBtn.click();
  }

  async function typeAndSubmitNextCandidate(inputEl, autoSubmit) {
    if (candidateQueue.length === 0) return;
    const nextAnswer = candidateQueue.shift();

    inputEl.focus();
    setNativeInputValue(inputEl, nextAnswer);

    if (autoSubmit) {
      await new Promise((r) => setTimeout(r, 120));
      submitAnswer(inputEl);

      // If the game refuses the answer, the input stays visible and cleared/active.
      // Automatically try the next obscure candidate after 1.3s.
      clearTimeout(retryTimer);
      retryTimer = setTimeout(() => {
        const stillActiveInput = document.body.contains(inputEl) && !inputEl.disabled;
        if (stillActiveInput && candidateQueue.length > 0) {
          typeAndSubmitNextCandidate(inputEl, autoSubmit);
        }
      }, 1300);
    }
  }

  async function evaluatePage() {
    if (isProcessing) return;

    // After the extension is reloaded this orphaned script must stop quietly.
    if (!chrome.runtime?.id) {
      observer.disconnect();
      clearInterval(pollTimer);
      return;
    }

    const settings = await chrome.storage.local.get([
      "enabled",
      "autoSubmit",
      "promptSelector",
      "inputSelector"
    ]);

    if (settings.enabled === false) return;

    // Between prompts the game shows a DESCEND button; click it to continue.
    if (settings.autoSubmit !== false) {
      const nextBtn = document.querySelector(".ds-next-btn:not([disabled]), .kr-next:not([disabled])");
      if (nextBtn && nextBtn.getBoundingClientRect().width > 0) {
        candidateQueue = [];
        clearTimeout(retryTimer);
        setTimeout(() => nextBtn.click(), 800);
        return;
      }
    }

    const inputSelectors = settings.inputSelector
      ? [settings.inputSelector, ...DEFAULT_INPUT_SELECTORS]
      : DEFAULT_INPUT_SELECTORS;

    const inputEl = findVisibleElement(inputSelectors);
    if (!inputEl) return;

    const question = extractPromptText(settings.promptSelector);
    if (!question || question === lastProcessedQuestion) return;

    lastProcessedQuestion = question;
    console.log("[Krillion Gemini Helper] question:", question);
    isProcessing = true;
    clearTimeout(retryTimer);

    try {
      const response = await chrome.runtime.sendMessage({
        type: "GET_KRILLION_ANSWERS",
        question
      });

      if (response?.ok && Array.isArray(response.answers)) {
        candidateQueue = [...response.answers];
        await typeAndSubmitNextCandidate(inputEl, settings.autoSubmit !== false);
      } else {
        console.warn("[Krillion Gemini Helper]", response?.error);
        // Allow a retry later instead of permanently skipping this question
        setTimeout(() => { lastProcessedQuestion = ""; }, 8000);
      }
    } catch (err) {
      console.warn("[Krillion Gemini Helper] message failed:", err);
      setTimeout(() => { lastProcessedQuestion = ""; }, 8000);
    } finally {
      isProcessing = false;
    }
  }

  const observer = new MutationObserver(() => {
    evaluatePage().catch(() => {});
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true
  });

  const pollTimer = setInterval(() => evaluatePage().catch(() => {}), 600);
})();