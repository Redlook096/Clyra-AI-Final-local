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
  // Keep in sync with --oc-dur-w / --oc-dur-h in index.html — light drawer motion
  const DUR_W = 260;
  const DUR_H = 240;

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

  // Sync light/dark with OS (and stealth) so chat bubbles/composer match Clyra.
  function syncThemeClass() {
    try {
      const dark =
        typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
      document.documentElement.classList.toggle('oc-dark', Boolean(dark) || stealthOn);
      document.documentElement.classList.toggle('oc-force-light', !dark && !stealthOn);
    } catch (_) {
      /* ignore */
    }
  }

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
  /** SoftStream-style paint cursor for live LLM chunks */
  let streamState = null;

  const THINKING_HTML =
    '<div class="oc-thinking-status" aria-live="polite">' +
    '<span class="oc-thinking-icon" aria-hidden="true">' +
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/>' +
    '<path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/>' +
    '<path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4"/>' +
    '<path d="M17.599 6.5a3 3 0 0 0 .399-1.375"/>' +
    '<path d="M6.003 5.125A3 3 0 0 0 6.401 6.5"/>' +
    '<path d="M3.023 10.125a4 4 0 0 0 2.477 1.375"/><path d="M18.5 11.5a4 4 0 0 0 2.477-1.375"/>' +
    '<path d="M8.5 17.5a3 3 0 0 0 2.5 1"/><path d="M13 18.5a3 3 0 0 0 2.5-1"/>' +
    '</svg></span>' +
    '<span class="oc-thinking-wave">Thinking</span>' +
    '<span class="oc-thinking-dots" aria-hidden="true"><i></i><i></i><i></i></span>' +
    '</div>';

  function stopStreamPaint() {
    if (streamState?.raf != null) {
      cancelAnimationFrame(streamState.raf);
      streamState.raf = null;
    }
  }

  function clearStreamMessage({ keepDom = false } = {}) {
    stopStreamPaint();
    if (!keepDom && streamState?.el?.isConnected) {
      streamState.el.remove();
    }
    streamState = null;
  }

  function scheduleStreamPaint() {
    if (!streamState || streamState.raf != null) return;
    streamState.raf = requestAnimationFrame(() => {
      if (!streamState) return;
      streamState.raf = null;
      const target = streamState.target;
      let current = streamState.shown;
      if (current.length > target.length) {
        current = target;
      } else if (current.length < target.length) {
        let steps = target.length - current.length > 64 ? 4 : 2;
        while (steps-- > 0 && current.length < target.length) {
          const rem = target.slice(current.length);
          const match = rem.match(/^(?:\s*\S{1,18}|\s+|[\s\S]{1,12})/);
          current += match?.[0] ?? rem.slice(0, 8);
        }
      }
      streamState.shown = current;
      if (streamState.textEl) {
        streamState.textEl.textContent = current;
      }
      messagesEl.scrollTop = messagesEl.scrollHeight;
      if (streamState.finalizing && current.length >= target.length) {
        finalizeStreamMessage(target);
        return;
      }
      if (current.length < target.length) scheduleStreamPaint();
    });
  }

  function ensureStreamMessage(messageId) {
    hideThinking();
    if (streamState?.el?.isConnected) {
      if (messageId && !streamState.messageId) streamState.messageId = messageId;
      return streamState;
    }
    const messageDiv = document.createElement('div');
    messageDiv.className = 'message assistant oc-print is-streaming oc-msg-rise oc-msg-rise--assistant';
    messageDiv.id = 'bar-streaming';
    const paint = document.createElement('div');
    paint.className = 'message-text oc-stream-paint';
    const body = document.createElement('span');
    body.className = 'oc-stream-paint__body';
    const caret = document.createElement('span');
    caret.className = 'oc-stream-paint__caret';
    caret.setAttribute('aria-hidden', 'true');
    paint.appendChild(body);
    paint.appendChild(caret);
    messageDiv.appendChild(paint);
    messagesEl.appendChild(messageDiv);
    streamState = {
      el: messageDiv,
      textEl: body,
      caret,
      target: '',
      shown: '',
      raf: null,
      messageId: messageId || null,
      finalizing: false,
    };
    return streamState;
  }

  function appendStreamChunk(delta, messageId) {
    const chunk = String(delta || '');
    if (!chunk) return;
    const state = ensureStreamMessage(messageId);
    state.target += chunk;
    scheduleStreamPaint();
  }

  function finalizeStreamMessage(fullText) {
    const t = String(fullText || streamState?.target || '').trim();
    stopStreamPaint();
    if (!t) {
      clearStreamMessage();
      return;
    }
    const now = Date.now();
    if (t === lastAssistantText && now - lastAssistantAt < 5000) {
      clearStreamMessage();
      return;
    }
    lastAssistantText = t;
    lastAssistantAt = now;

    const el = streamState?.el;
    if (el?.isConnected) {
      el.classList.remove('is-streaming');
      const textDiv = el.querySelector('.message-text') || document.createElement('div');
      textDiv.className = 'message-text';
      textDiv.innerHTML = formatMarkdown(t);
      el.innerHTML = '';
      el.appendChild(textDiv);
      streamState?.caret?.remove();
    } else {
      addMessage(t, 'assistant');
      streamState = null;
      return;
    }
    history.push({ type: 'assistant', text: t });
    saveHistory();
    streamState = null;
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function addMessage(text, type = 'user', skipPersist = false) {
    const t = String(text || '').trim();
    if (!t) return;
    // Drop duplicate assistant bubbles from dual IPC paths / double broadcast
    if (type === 'assistant') {
      const now = Date.now();
      if (t === lastAssistantText && now - lastAssistantAt < 5000) return;
      lastAssistantText = t;
      lastAssistantAt = now;
      // Prefer finalizing an in-flight stream instead of a second bubble
      if (streamState?.el?.isConnected) {
        streamState.target = t;
        streamState.finalizing = true;
        scheduleStreamPaint();
        return;
      }
    }
    const messageDiv = document.createElement('div');
    // Assistant: plain print (no bubble) like Clyra chat tool.
    // User: App Launcher / Clyra chat bubble (#aec7f1) + move-up entry.
    if (type === 'assistant') {
      messageDiv.className = 'message assistant oc-print oc-msg-rise oc-msg-rise--assistant';
    } else if (type === 'user') {
      messageDiv.className = 'message user oc-user-bubble oc-msg-rise';
      if (!messagesEl.querySelector('.message.user')) {
        messageDiv.classList.add('oc-user-bubble--first');
      }
    } else {
      messageDiv.className = `message ${type} oc-msg-rise oc-msg-rise--assistant`;
    }
    const textDiv = document.createElement('div');
    textDiv.className = 'message-text';
    if (type === 'assistant' || type === 'system') textDiv.innerHTML = formatMarkdown(t);
    else textDiv.textContent = t;
    messageDiv.appendChild(textDiv);
    messagesEl.appendChild(messageDiv);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    if (!skipPersist) {
      history.push({ type, text: t });
      saveHistory();
    }
  }

  function showThinking() {
    // Dots + shimmer only while the model is thinking (before first token).
    if (streamState?.el?.isConnected) return;
    hideThinking();
    shell.classList.add('is-thinking');
    const thinkingDiv = document.createElement('div');
    thinkingDiv.className = 'message assistant oc-print thinking';
    thinkingDiv.id = 'bar-thinking';
    thinkingDiv.innerHTML = THINKING_HTML;
    messagesEl.appendChild(thinkingDiv);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function hideThinking() {
    document.getElementById('bar-thinking')?.remove();
    shell.classList.remove('is-thinking');
  }

  function measureShell() {
    const rect = shell.getBoundingClientRect();
    return {
      width: Math.max(220, Math.ceil(rect.width)),
      height: Math.max(COLLAPSED_H, Math.ceil(rect.height)),
    };
  }

  let lastResize = { w: 0, h: 0 };
  let resizeChain = Promise.resolve();
  let queuedResize = null;

  // Match CSS --oc-ease so Electron bounds and drawer height stay locked.
  function cubicBezierEase(t, p1x = 0.22, p1y = 1, p2x = 0.36, p2y = 1) {
    const x = Math.max(0, Math.min(1, t));
    // Solve Bézier x(u)=x for u via Newton, then evaluate y(u).
    let u = x;
    for (let i = 0; i < 6; i++) {
      const u2 = u * u;
      const u3 = u2 * u;
      const cx = 3 * p1x;
      const bx = 3 * (p2x - p1x) - cx;
      const ax = 1 - cx - bx;
      const xu = ax * u3 + bx * u2 + cx * u;
      const dx = 3 * ax * u2 + 2 * bx * u + cx;
      if (Math.abs(dx) < 1e-6) break;
      u -= (xu - x) / dx;
      u = Math.max(0, Math.min(1, u));
    }
    const u2 = u * u;
    const u3 = u2 * u;
    const cy = 3 * p1y;
    const by = 3 * (p2y - p1y) - cy;
    const ay = 1 - cy - by;
    return ay * u3 + by * u2 + cy * u;
  }

  function resizeWindowNow(width, height, { recenter = false, growFromTopCenter = false } = {}) {
    if (!window.electronAPI?.resizeWindow) return Promise.resolve();
    const w = Math.max(60, Math.round(width));
    const h = Math.max(28, Math.round(height));
    // Coalesce: keep only the latest size so rAF never waits on a backlog of IPC.
    queuedResize = { w, h, recenter, growFromTopCenter };
    resizeChain = resizeChain
      .catch(() => {})
      .then(async () => {
        while (queuedResize) {
          const job = queuedResize;
          queuedResize = null;
          if (
            Math.abs(job.w - lastResize.w) < 1 &&
            Math.abs(job.h - lastResize.h) < 1 &&
            job.recenter !== true &&
            job.recenter !== 'x' &&
            !job.growFromTopCenter
          ) {
            continue;
          }
          lastResize = { w: job.w, h: job.h };
          await window.electronAPI.resizeWindow(job.w, job.h, {
            recenter: job.recenter,
            growFromTopCenter: job.growFromTopCenter,
          });
        }
      });
    return resizeChain;
  }

  async function measureAndResize({ recenter = false } = {}) {
    await new Promise((r) => requestAnimationFrame(r));
    const { width, height } = measureShell();
    await resizeWindowNow(width, height, { recenter });
  }

  /**
   * Drive Electron window bounds in lockstep with CSS (single rAF, awaited IPC).
   * recenter: false | 'x' (keep Y, center horizontally) | true (center at top)
   */
  async function animateBounds(fromW, fromH, toW, toH, durationMs, { growFromTopCenter = true } = {}) {
    const start = performance.now();
    const dw = Math.abs(toW - fromW);
    const dh = Math.abs(toH - fromH);
    // Prefer reduced motion or no-op deltas: snap once.
    const reduce =
      typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce || durationMs <= 0 || (dw < 2 && dh < 2)) {
      await resizeWindowNow(toW, toH, { growFromTopCenter });
      return;
    }
    // Grow from top-center every frame: width L/R equally, height only downward.
    while (true) {
      const t = Math.min(1, (performance.now() - start) / durationMs);
      const e = cubicBezierEase(t);
      const w = Math.round(fromW + (toW - fromW) * e);
      const h = Math.round(fromH + (toH - fromH) * e);
      void resizeWindowNow(w, h, { growFromTopCenter: true });
      if (t >= 1) break;
      await new Promise((r) => requestAnimationFrame(r));
    }
    await resizeWindowNow(toW, toH, { growFromTopCenter: true });
  }

  async function expandToChat(nextMode) {
    if (animating) return;
    animating = true;
    shell.classList.add('is-animating');
    mode = nextMode;

    try {
      const from = measureShell();

      // 1) Expand width from center — keep pill chrome until chat opens
      wide = true;
      shell.classList.add('is-wide');
      notifyDrawer(true, { recenter: false });
      await animateBounds(from.width, from.height, EXPANDED_W, COLLAPSED_H, DUR_W, {
        growFromTopCenter: true,
      });

      // 2) Expand chat downward only (Y locked via growFromTopCenter)
      open = true;
      shell.classList.add('is-chat-open');
      drawer.setAttribute('aria-hidden', 'false');
      setModeUI(nextMode);
      updateCloseIcon();
      // No delay — fade/height start immediately with the bounds anim
      await animateBounds(EXPANDED_W, COLLAPSED_H, EXPANDED_W, COLLAPSED_H + DRAWER_H, DUR_H, {
        growFromTopCenter: true,
      });
    } finally {
      shell.classList.remove('is-animating');
      animating = false;
    }

    if (nextMode === 'ask') {
      requestAnimationFrame(() => inputEl?.focus());
    }
  }

  async function collapse(opts = {}) {
    const hideIfAlreadyCollapsed = Boolean(opts.hideIfAlreadyCollapsed);
    // Wait briefly if an expand is mid-flight so close isn't dropped
    if (animating) {
      const start = performance.now();
      while (animating && performance.now() - start < 900) {
        await wait(24);
      }
    }
    // Force through even if a stuck expand left animating=true
    if (animating) animating = false;
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

    try {
      // Exit control compose without leaving a half-open shell
      if (taskPromptMode) {
        taskPromptMode = false;
        shell.classList.remove('is-control-compose', 'is-task-prompt');
        clearInlineControlInput();
        updateCloseIcon();
      }

      const from = measureShell();

      // 1) Collapse height first — drop is-chat-open so CSS height eases with the window
      open = false;
      shell.classList.remove('is-chat-open');
      drawer.setAttribute('aria-hidden', 'true');
      updateCloseIcon();
      await animateBounds(from.width, from.height, EXPANDED_W, COLLAPSED_H, DUR_H, {
        growFromTopCenter: true,
      });

      // 2) Then shrink width back to pill (symmetric L/R)
      wide = false;
      shell.classList.remove('is-wide');
      notifyDrawer(false, { recenter: false });
      // Measure pill target after width class removed
      await new Promise((r) => requestAnimationFrame(r));
      const pill = tab ? tab.getBoundingClientRect() : measureShell();
      const pillW = Math.max(220, Math.ceil(pill.width || 320));
      await animateBounds(EXPANDED_W, COLLAPSED_H, pillW, COLLAPSED_H, DUR_W, {
        growFromTopCenter: true,
      });
      await resizeWindowNow(pillW, COLLAPSED_H, { growFromTopCenter: true });
      updateCloseIcon();
    } finally {
      shell.classList.remove('is-animating');
      animating = false;
    }
  }

  function notifyDrawer(openState, opts = {}) {
    try {
      window.electronAPI?.setChatDrawerOpen?.(openState, opts);
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
    syncThemeClass();
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

  /** Instant show — no expand/squish boot; drawer expand stays smooth. */
  async function snapShow() {
    shell.classList.remove('is-boot-squish', 'is-boot-fade', 'is-boot-expand');
    for (const el of shell.querySelectorAll('.oc-boot-hide, .oc-stealth-wrap, .oc-actions, .oc-close')) {
      try {
        el.style.opacity = '';
        el.style.transform = '';
        el.style.pointerEvents = 'auto';
      } catch (_) {
        /* ignore */
      }
    }
    await measureAndResize({ recenter: true });
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
    if (controlling) return;
    if (animating) {
      const start = performance.now();
      while (animating && performance.now() - start < 1600) {
        await wait(32);
      }
    }
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
    let placeholder = 'What should the AI do on your computer?';
    try {
      const status = await window.electronAPI?.getDesktopControlStatus?.();
      if (status && status.driver === 'none') {
        placeholder =
          status.platform === 'linux'
            ? 'Install xdotool to enable Take Control on Linux'
            : status.platform === 'darwin'
              ? 'Enable Accessibility for OpenCluely in System Settings'
              : 'Desktop control driver unavailable on this system';
      }
    } catch (_) {
      /* ignore */
    }
    if (el) {
      el.value = '';
      el.placeholder = placeholder;
      setTimeout(() => el.focus(), 30);
    }
    notifyDrawer(false, { recenter: false });
    await measureAndResize({ recenter: false });
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
    clearStreamMessage();
    addMessage(text, 'user');
    inputEl.value = '';
    autoGrow();
    showThinking();
    try {
      await window.electronAPI?.sendChatMessage?.(text);
    } catch (error) {
      hideThinking();
      clearStreamMessage();
      addMessage(`Failed to send: ${error.message}`, 'error');
    }
  }

  async function runAutoAnswer() {
    await expandToChat('auto');
    clearStreamMessage();
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
    // Immediate expand-down — no artificial delay
    void expandToChat('ask');
  });

  autoBtn?.addEventListener('click', async (e) => {
    e.stopPropagation();
    void runAutoAnswer();
  });

  controlBtn?.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (controlling) {
      await stopControlFromBar();
      return;
    }
    await enterTaskPrompt();
  });

  const toggleStealth = (e) => {
    try {
      e?.preventDefault?.();
      e?.stopPropagation?.();
    } catch (_) {
      /* ignore */
    }
    // Ignore non-primary buttons; avoid double-toggle from nested bubble.
    if (e?.button != null && e.button !== 0) return;
    applyStealthUI(!stealthOn);
    measureAndResize();
  };
  // Single pointerup on the wrap only — pointerdown+click on wrap+switch
  // was double-firing and cancelling the toggle (looked "broken").
  stealthWrap?.addEventListener('pointerup', toggleStealth);
  try {
    if (stealthWrap) {
      stealthWrap.style.pointerEvents = 'auto';
      stealthWrap.style.webkitAppRegion = 'no-drag';
    }
    if (stealthSwitch) {
      stealthSwitch.style.pointerEvents = 'auto';
      stealthSwitch.style.webkitAppRegion = 'no-drag';
    }
  } catch (_) {
    /* ignore */
  }
  // Force interactive hit-targets (legacy boot classes must never block clicks).
  for (const el of shell.querySelectorAll('.oc-boot-hide, .oc-stealth-wrap, .oc-actions, .oc-close')) {
    try {
      el.style.pointerEvents = 'auto';
    } catch (_) {
      /* ignore */
    }
  }

  async function handleCloseClick(e) {
    try {
      e?.preventDefault?.();
      e?.stopPropagation?.();
    } catch (_) {
      /* ignore */
    }
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
  }
  // pointerup only — click + pointerup double-fires and can cancel collapse.
  closeBtn?.addEventListener('pointerup', handleCloseClick);

  sendBtn?.addEventListener('click', () => sendCurrent());
  inputEl?.addEventListener('input', autoGrow);
  inputEl?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendCurrent();
    }
  });
  // Ensure Electron window can receive keystrokes when clicking the composer.
  const focusComposer = () => {
    try {
      window.electronAPI?.enableWindowInteraction?.();
    } catch (_) {
      /* ignore */
    }
    try {
      window.electronAPI?.focusMainWindow?.();
    } catch (_) {
      /* ignore */
    }
    // Focus after main process activates the BrowserWindow.
    setTimeout(() => {
      try {
        inputEl?.focus({ preventScroll: true });
      } catch (_) {
        inputEl?.focus();
      }
    }, 30);
  };
  inputEl?.addEventListener('pointerdown', focusComposer);
  document.querySelector('.oc-composer')?.addEventListener('pointerdown', focusComposer);

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
      if (payload.open) {
        // Already expanded — do not re-run expand animation (race with showLLMLoading).
        if (open && wide) {
          setModeUI(mode || 'ask');
          return;
        }
        void expandToChat(mode || 'ask');
      } else {
        void collapse({ hideIfAlreadyCollapsed: false });
      }
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
    api.onTranscriptionLlmResponseStart?.((_e, data) => {
      if (!open) expandToChat(mode || 'ask');
      clearStreamMessage();
      showThinking();
    });
    api.onTranscriptionLlmResponseChunk?.((_e, data) => {
      if (!open) expandToChat(mode || 'ask');
      appendStreamChunk(data?.delta || data?.chunk || data?.text || '', data?.messageId);
    });
    api.onTranscriptionLlmResponse?.((_e, data) => {
      hideThinking();
      const text = data?.response || data?.text || '';
      if (text) {
        if (!open) expandToChat(mode || 'ask');
        if (streamState?.el?.isConnected || (streamState?.target && streamState.target.length)) {
          ensureStreamMessage(data?.messageId);
          streamState.target = text;
          streamState.finalizing = true;
          scheduleStreamPaint();
        } else {
          addMessage(text, 'assistant');
        }
        if (modeHint && mode === 'auto') modeHint.textContent = 'Answer ready';
      } else {
        clearStreamMessage();
      }
    });
    // Fallback only when transcription channel is unavailable
    if (typeof api.onTranscriptionLlmResponse !== 'function') {
      api.onLlmResponse?.((_e, data) => {
        hideThinking();
        clearStreamMessage();
        const text = data?.response || data?.text || '';
        if (text) {
          if (!open) expandToChat(mode || 'ask');
          addMessage(text, 'assistant');
        }
      });
    }
    api.onOcrError?.((_e, data) => {
      hideThinking();
      clearStreamMessage();
      addMessage(data?.error || 'Screenshot failed', 'error');
    });
    api.onSessionCleared?.(() => {
      clearStreamMessage();
      hideThinking();
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
        else hideThinking();
      }
    });
    api.onStealthModeChanged?.((_e, data) => {
      if (typeof data?.stealth === 'boolean') {
        applyStealthUI(data.stealth, { persist: true, notifyMain: false });
        measureAndResize();
      }
    });
  }

  // Fit collapsed pill on load — snap show (no expand boot) + stealth restore
  loadHistory();
  setControlButtonState(false);
  try {
    stealthOn = localStorage.getItem(STEALTH_KEY) === '1';
  } catch (_) {
    stealthOn = false;
  }
  applyStealthUI(stealthOn, { persist: false, notifyMain: true });
  try {
    matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', syncThemeClass);
  } catch (_) {
    /* ignore */
  }

  (async () => {
    await snapShow();
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
