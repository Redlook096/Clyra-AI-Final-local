/**
 * Light frosted OpenCluely bar:
 *  - Ask → expand width then chat (normal Q&A)
 *  - Auto Answer → expand + screenshot vision with initiative
 *  - X collapses back to the compact pill
 *  - Drag handle moves the whole window; opens centered at top
 */
(function () {
  const HISTORY_KEY = 'opencluely_bar_chat_v2';
  const GREETING = 'Hi, how can I help you?';
  const EXPANDED_W = 600;
  const COLLAPSED_H = 56;
  const DRAWER_H = 360;

  const shell = document.getElementById('ocShell');
  const tab = document.getElementById('commandTab');
  const drawer = document.getElementById('chatDrawer');
  const messagesEl = document.getElementById('barChatMessages');
  const inputEl = document.getElementById('barChatInput');
  const sendBtn = document.getElementById('barChatSend');
  const closeBtn = document.getElementById('ocCloseBtn');
  const askBtn = document.getElementById('ocAskBtn');
  const autoBtn = document.getElementById('ocAutoBtn');
  const controlBtn = document.getElementById('ocControlBtn');
  const stealthWrap = document.getElementById('ocStealthWrap');
  const stealthSwitch = document.getElementById('ocStealthSwitch');
  const modeLabel = document.getElementById('chatModeLabel');
  const modeHint = document.getElementById('chatModeHint');

  if (!shell || !drawer || !messagesEl) {
    console.warn('[BarChat] missing shell elements');
    return;
  }

  let open = false;
  let wide = false;
  let mode = 'ask'; // 'ask' | 'auto' | 'control'
  let history = [];
  let animating = false;
  let controlling = false;
  let taskPromptMode = false;
  let stealthOn = false;
  const STEALTH_KEY = 'opencluely_stealth_v1';

  const AUTO_PROMPT =
    "Look at what's on my screen right now. Use your initiative: if there is a question, quiz, problem, coding prompt, form field, or anything the user likely needs answered or solved, answer it directly and helpfully. If there is no clear question, briefly say what you see and the most useful next step. Read text literally; do not invent content that is not visible.";

  function loadHistory() {
    messagesEl.innerHTML = '';
    history = [];
    // One clean greeting only — never replay old spam from previous sessions.
    try {
      localStorage.removeItem('opencluely_bar_chat_v1');
      localStorage.removeItem(HISTORY_KEY);
    } catch (_) {
      /* ignore */
    }
    addMessage(GREETING, 'assistant', true);
    history = [{ type: 'assistant', text: GREETING }];
    saveHistory();
  }

  function updateCloseIcon() {
    if (!closeBtn) return;
    const collapseMode = open || taskPromptMode;
    closeBtn.classList.toggle('is-collapse', collapseMode);
    if (collapseMode) {
      closeBtn.title = 'Collapse chat';
      closeBtn.setAttribute('aria-label', 'Collapse chat');
    } else {
      closeBtn.title = 'Close';
      closeBtn.setAttribute('aria-label', 'Close');
    }
  }

  function saveHistory() {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(-80)));
    } catch (_) {
      /* ignore */
    }
  }

  function formatMarkdown(text) {
    return String(text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/`(.+?)`/g, '<code>$1</code>')
      .replace(/\n/g, '<br>');
  }

  let lastAssistantText = '';
  let lastAssistantAt = 0;

  function addMessage(text, type = 'user', skipPersist = false) {
    const t = String(text || '').trim();
    if (!t) return;
    // Drop duplicate assistant bubbles from dual IPC paths / double broadcast
    if (type === 'assistant') {
      const now = Date.now();
      if (t === lastAssistantText && now - lastAssistantAt < 5000) return;
      lastAssistantText = t;
      lastAssistantAt = now;
    }
    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${type}`;
    const timeDiv = document.createElement('div');
    timeDiv.className = 'message-time';
    timeDiv.textContent = new Date().toLocaleTimeString();
    const textDiv = document.createElement('div');
    textDiv.className = 'message-text';
    if (type === 'assistant') textDiv.innerHTML = formatMarkdown(t);
    else textDiv.textContent = t;
    messageDiv.appendChild(timeDiv);
    messageDiv.appendChild(textDiv);
    messagesEl.appendChild(messageDiv);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    if (!skipPersist) {
      history.push({ type, text: t });
      saveHistory();
    }
  }

  function showThinking() {
    hideThinking();
    const thinkingDiv = document.createElement('div');
    thinkingDiv.className = 'message assistant thinking';
    thinkingDiv.id = 'bar-thinking';
    thinkingDiv.innerHTML =
      '<div class="message-time">…</div><div class="message-text thinking-dots"><span class="dot">•</span><span class="dot">•</span><span class="dot">•</span></div>';
    messagesEl.appendChild(thinkingDiv);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function hideThinking() {
    document.getElementById('bar-thinking')?.remove();
  }

  function measureAndResize() {
    if (!window.electronAPI?.resizeWindow) return;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const rect = shell.getBoundingClientRect();
        const width = Math.max(220, Math.ceil(rect.width));
        const height = Math.max(COLLAPSED_H, Math.ceil(rect.height));
        window.electronAPI.resizeWindow(width, height);
      });
    });
  }

  /** Keep Electron window bounds in lockstep with CSS transitions. */
  function animateWindowWithShell(durationMs) {
    return new Promise((resolve) => {
      const start = performance.now();
      const tick = () => {
        measureAndResize();
        if (performance.now() - start < durationMs) {
          requestAnimationFrame(tick);
        } else {
          measureAndResize();
          resolve();
        }
      };
      requestAnimationFrame(tick);
    });
  }

  async function expandToChat(nextMode) {
    if (animating) return;
    animating = true;
    shell.classList.add('is-animating');
    setModeUI(nextMode);

    // 1) Expand width outwards first — keep pill chrome until chat opens
    wide = true;
    shell.classList.add('is-wide');
    notifyDrawer(true);
    await animateWindowWithShell(520);

    // 2) Then expand chat smoothly downward (Electron height tracks CSS max-height)
    open = true;
    shell.classList.add('is-chat-open');
    drawer.setAttribute('aria-hidden', 'false');
    updateCloseIcon();
    await animateWindowWithShell(500);
    shell.classList.remove('is-animating');
    animating = false;

    if (nextMode === 'ask') {
      setTimeout(() => inputEl?.focus(), 40);
    }
  }

  async function collapse(opts = {}) {
    const hideIfAlreadyCollapsed = Boolean(opts.hideIfAlreadyCollapsed);
    if (animating) return;
    if (!open && !wide && !taskPromptMode && !controlling) {
      if (hideIfAlreadyCollapsed) {
        try {
          await window.electronAPI?.hideAllWindows?.();
        } catch (_) {
          /* ignore */
        }
      }
      return;
    }
    animating = true;
    shell.classList.add('is-animating');
    askBtn?.classList.remove('is-active');
    autoBtn?.classList.remove('is-active');

    // Exit control compose without leaving a half-open shell
    if (taskPromptMode) {
      taskPromptMode = false;
      shell.classList.remove('is-control-compose', 'is-task-prompt');
      clearInlineControlInput();
      updateCloseIcon();
    }

    // 1) Collapse height first
    open = false;
    shell.classList.remove('is-chat-open');
    drawer.setAttribute('aria-hidden', 'true');
    updateCloseIcon();
    await animateWindowWithShell(480);

    // 2) Then shrink width back to pill
    wide = false;
    shell.classList.remove('is-wide');
    notifyDrawer(false);
    await animateWindowWithShell(520);
    if (tab && window.electronAPI?.resizeWindow) {
      const rect = tab.getBoundingClientRect();
      window.electronAPI.resizeWindow(Math.ceil(rect.width), Math.ceil(rect.height));
    } else {
      measureAndResize();
    }
    updateCloseIcon();
    shell.classList.remove('is-animating');
    animating = false;
  }

  function notifyDrawer(openState) {
    try {
      window.electronAPI?.setChatDrawerOpen?.(openState);
    } catch (_) {
      /* ignore */
    }
  }

  function setModeUI(next) {
    mode = next;
    askBtn?.classList.toggle('is-active', mode === 'ask' && open && !controlling);
    autoBtn?.classList.toggle('is-active', mode === 'auto' && open && !controlling);
    if (modeLabel) {
      modeLabel.textContent =
        mode === 'auto' ? 'Auto Answer' : mode === 'control' ? 'Take Control' : 'Ask';
    }
    if (modeHint) {
      modeHint.textContent =
        mode === 'auto'
          ? 'Reading your screen…'
          : mode === 'control'
            ? 'Describe the task for the AI…'
            : 'Type a question…';
    }
  }

  function applyStealthUI(enabled, { persist = true, notifyMain = true } = {}) {
    stealthOn = Boolean(enabled);
    document.documentElement.classList.toggle('oc-stealth', stealthOn);
    stealthWrap?.classList.toggle('is-on', stealthOn);
    if (stealthSwitch) {
      stealthSwitch.setAttribute('aria-checked', stealthOn ? 'true' : 'false');
    }
    if (persist) {
      try {
        localStorage.setItem(STEALTH_KEY, stealthOn ? '1' : '0');
      } catch (_) {
        /* ignore */
      }
    }
    if (notifyMain) {
      try {
        window.electronAPI?.setStealthMode?.(stealthOn);
      } catch (_) {
        /* ignore */
      }
    }
  }

  async function runBootAnimation() {
    // 1) Start squished + invisible (already in HTML)
    shell.classList.add('is-boot-squish');
    // Fit Electron window to thin pill first
    if (window.electronAPI?.resizeWindow) {
      window.electronAPI.resizeWindow(56, COLLAPSED_H);
    }
    await wait(60);
    // 2) Fade in while still thin / compressed
    shell.classList.add('is-boot-fade');
    await wait(360);
    // 3) Expand horizontally into full pill
    shell.classList.remove('is-boot-squish');
    shell.classList.add('is-boot-expand');
    await wait(50);
    measureAndResize();
    await wait(520);
    // 4) Reveal buttons / stealth / drag with stagger
    shell.classList.add('is-boot-reveal');
    await wait(520);
    shell.classList.remove('is-boot-fade', 'is-boot-expand');
    measureAndResize();
  }

  function setControlButtonState(isControlling) {
    controlling = Boolean(isControlling);
    shell.classList.toggle('is-controlling', controlling);
    if (!controlBtn) return;
    if (controlling) {
      controlBtn.classList.add('oc-stop');
      controlBtn.classList.remove('oc-control');
      controlBtn.title = 'Stop AI control';
      controlBtn.setAttribute('aria-label', 'Stop AI control');
      // Keep Stop visible inside the collapsed pill; hide other actions via CSS
      controlBtn.style.display = '';
    } else {
      controlBtn.classList.add('oc-control');
      controlBtn.classList.remove('oc-stop');
      controlBtn.title = 'Let OpenCluely control your machine';
      controlBtn.setAttribute('aria-label', 'Take Control');
    }
  }

  function inlineControlInput() {
    return document.getElementById('ocInlineControlInput');
  }

  function clearInlineControlInput() {
    const el = inlineControlInput();
    if (el) el.value = '';
  }

  async function enterTaskPrompt() {
    if (animating || controlling) return;
    animating = true;
    setModeUI('control');
    // Stay on the original collapsed pill — hide buttons, reveal type space.
    taskPromptMode = true;
    open = false;
    wide = false;
    shell.classList.remove('is-chat-open', 'is-wide', 'is-task-prompt', 'is-fading-out', 'is-fading-in', 'is-shaking');
    shell.classList.add('is-control-compose');
    drawer.setAttribute('aria-hidden', 'true');
    updateCloseIcon();
    const el = inlineControlInput();
    if (el) {
      el.value = '';
      el.placeholder = 'What should the AI do on your computer?';
      setTimeout(() => el.focus(), 30);
    }
    notifyDrawer(false);
    measureAndResize();
    await wait(120);
    animating = false;
  }

  async function exitTaskPromptToControl(task) {
    animating = true;
    taskPromptMode = false;
    shell.classList.remove('is-control-compose', 'is-task-prompt', 'is-fading-out', 'is-fading-in');
    // Stay collapsed — only Stop remains visible via is-controlling
    open = false;
    wide = false;
    shell.classList.remove('is-chat-open', 'is-wide');
    drawer.setAttribute('aria-hidden', 'true');
    setControlButtonState(true);
    setModeUI('control');
    updateCloseIcon();
    clearInlineControlInput();
    const status = document.getElementById('ocControlStatus');
    if (status) status.textContent = 'AI controlling…';
    measureAndResize();
    try {
      await window.electronAPI?.startDesktopControl?.(task);
    } catch (error) {
      setControlButtonState(false);
      if (status) status.textContent = '';
      shell.classList.add('is-control-compose');
      taskPromptMode = true;
      const el = inlineControlInput();
      if (el) {
        el.value = '';
        el.placeholder = `Failed: ${error.message}`;
      }
    }
    await wait(80);
    animating = false;
  }

  async function stopControlFromBar() {
    hideThinking();
    try {
      await window.electronAPI?.stopDesktopControl?.();
    } catch (_) {
      /* ignore */
    }
    setControlButtonState(false);
    const status = document.getElementById('ocControlStatus');
    if (status) status.textContent = '';
    shell.classList.remove('is-control-compose', 'is-task-prompt');
    taskPromptMode = false;
    updateCloseIcon();
    measureAndResize();
    if (modeHint) modeHint.textContent = 'Control ended';
  }

  function wait(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  async function sendCurrent() {
    const text = (inputEl?.value || '').trim();
    const inlineText = (inlineControlInput()?.value || '').trim();
    if (taskPromptMode) {
      const task = inlineText || text;
      if (!task) return;
      clearInlineControlInput();
      if (inputEl) inputEl.value = '';
      await exitTaskPromptToControl(task);
      return;
    }
    if (!text) return;
    if (!open) await expandToChat('ask');
    addMessage(text, 'user');
    inputEl.value = '';
    autoGrow();
    showThinking();
    try {
      await window.electronAPI?.sendChatMessage?.(text);
    } catch (error) {
      hideThinking();
      addMessage(`Failed to send: ${error.message}`, 'error');
    }
  }

  async function runAutoAnswer() {
    await expandToChat('auto');
    addMessage('Auto Answer — reading your screen…', 'system');
    showThinking();
    try {
      // Prefer dedicated control endpoint when available
      const res = await fetch('http://127.0.0.1:3847/auto-answer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: AUTO_PROMPT }),
      });
      if (!res.ok) {
        // Fallback: chat path that triggers screenshot vision
        await window.electronAPI?.sendChatMessage?.(AUTO_PROMPT);
      }
    } catch (_) {
      try {
        await window.electronAPI?.sendChatMessage?.(AUTO_PROMPT);
      } catch (error) {
        hideThinking();
        addMessage(`Auto Answer failed: ${error.message}`, 'error');
      }
    }
  }

  function autoGrow() {
    if (!inputEl) return;
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 96) + 'px';
  }

  // Buttons
  askBtn?.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (open && mode === 'ask') {
      inputEl?.focus();
      return;
    }
    await expandToChat('ask');
  });

  autoBtn?.addEventListener('click', async (e) => {
    e.stopPropagation();
    await runAutoAnswer();
  });

  controlBtn?.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (controlling) {
      await stopControlFromBar();
      return;
    }
    await enterTaskPrompt();
  });

  const toggleStealth = () => {
    applyStealthUI(!stealthOn);
    measureAndResize();
  };
  stealthSwitch?.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleStealth();
  });
  stealthWrap?.addEventListener('click', (e) => {
    if (e.target === stealthSwitch) return;
    e.stopPropagation();
    toggleStealth();
  });

  closeBtn?.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (taskPromptMode) {
      taskPromptMode = false;
      shell.classList.remove('is-control-compose', 'is-task-prompt', 'is-wide', 'is-fading-in', 'is-fading-out');
      open = false;
      wide = false;
      clearInlineControlInput();
      if (inputEl) inputEl.placeholder = 'Type a message… (Shift+Enter for newline)';
      notifyDrawer(false);
      updateCloseIcon();
      measureAndResize();
      return;
    }
    // Chat open → chevron collapses chat (does not hide the pill)
    if (open || wide) {
      if (controlling) await stopControlFromBar();
      await collapse({ hideIfAlreadyCollapsed: false });
      return;
    }
    if (controlling) {
      await stopControlFromBar();
      return;
    }
    // Fully collapsed X → hide overlay
    await collapse({ hideIfAlreadyCollapsed: true });
  });

  sendBtn?.addEventListener('click', () => sendCurrent());
  inputEl?.addEventListener('input', autoGrow);
  inputEl?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendCurrent();
    }
  });

  const inlineEl = inlineControlInput();
  inlineEl?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      sendCurrent();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeBtn?.click();
    }
  });
  inlineEl?.addEventListener('mousedown', (e) => e.stopPropagation());
  inlineEl?.addEventListener('pointerdown', (e) => e.stopPropagation());

  // Main-process open/close (single listener — avoid double collapse/hide)
  function onDrawerToggle(_event, payload) {
    if (payload && typeof payload.open === 'boolean') {
      if (payload.open) expandToChat(mode || 'ask');
      else collapse({ hideIfAlreadyCollapsed: false });
    }
  }
  if (window.electronAPI?.onToggleChatDrawer) {
    window.electronAPI.onToggleChatDrawer(onDrawerToggle);
  } else {
    window.electronAPI?.receive?.('toggle-chat-drawer', onDrawerToggle);
  }

  // Responses — prefer transcription-llm-response only (main also used to
  // broadcast llm-response for the same reply, which doubled bubbles).
  const api = window.electronAPI;
  if (api) {
    api.onTranscriptionLlmResponse?.((_e, data) => {
      hideThinking();
      const text = data?.response || data?.text || '';
      if (text) {
        if (!open) expandToChat(mode || 'ask');
        addMessage(text, 'assistant');
        if (modeHint && mode === 'auto') modeHint.textContent = 'Answer ready';
      }
    });
    api.onTranscriptionLlmResponseStart?.(() => {
      if (!open) expandToChat(mode || 'ask');
      showThinking();
    });
    // Fallback only when transcription channel is unavailable
    if (typeof api.onTranscriptionLlmResponse !== 'function') {
      api.onLlmResponse?.((_e, data) => {
        hideThinking();
        const text = data?.response || data?.text || '';
        if (text) {
          if (!open) expandToChat(mode || 'ask');
          addMessage(text, 'assistant');
        }
      });
    }
    api.onOcrError?.((_e, data) => {
      hideThinking();
      addMessage(data?.error || 'Screenshot failed', 'error');
    });
    api.onSessionCleared?.(() => {
      history = [];
      messagesEl.innerHTML = '';
      addMessage(GREETING, 'assistant', true);
      history = [{ type: 'assistant', text: GREETING }];
      saveHistory();
    });
    api.onControlStatus?.((_e, data) => {
      hideThinking();
      const status = document.getElementById('ocControlStatus');
      if (data?.status === 'running') {
        setControlButtonState(true);
        if (status) status.textContent = data.message || 'AI controlling…';
      } else if (data?.status === 'step' && data.message) {
        if (status) status.textContent = String(data.message).slice(0, 72);
      } else if (data?.status === 'done') {
        setControlButtonState(false);
        if (status) status.textContent = '';
      } else if (data?.status === 'stopped') {
        setControlButtonState(false);
        if (status) status.textContent = '';
      } else if (data?.status === 'error') {
        setControlButtonState(false);
        if (status) status.textContent = String(data.message || 'Control error').slice(0, 72);
      }
    });
    api.onResearchStatus?.((_e, data) => {
      if (data?.message) {
        if (!open) expandToChat(mode || 'ask');
        addMessage(data.message, 'system');
        if (data.phase === 'searching' || data.phase === 'synthesizing') showThinking();
      }
    });
    api.onStealthModeChanged?.((_e, data) => {
      if (typeof data?.stealth === 'boolean') {
        applyStealthUI(data.stealth, { persist: true, notifyMain: false });
        measureAndResize();
      }
    });
  }

  // Fit collapsed pill on load + boot animation + stealth restore
  loadHistory();
  setControlButtonState(false);
  try {
    stealthOn = localStorage.getItem(STEALTH_KEY) === '1';
  } catch (_) {
    stealthOn = false;
  }
  applyStealthUI(stealthOn, { persist: false, notifyMain: true });

  (async () => {
    await runBootAnimation();
    window.electronAPI?.setChatDrawerOpen?.(false);
    window.electronAPI?.notifyMainWindowReady?.();
    // Re-apply stealth to main once window is ready (content protection)
    if (stealthOn) applyStealthUI(true, { persist: false, notifyMain: true });
  })();

  window.barChat = {
    isOpen: () => open,
    expandToChat,
    collapse,
    runAutoAnswer,
    measureAndResize,
    enterTaskPrompt,
    stopControlFromBar,
    setStealth: applyStealthUI,
    isStealth: () => stealthOn,
  };
})();
