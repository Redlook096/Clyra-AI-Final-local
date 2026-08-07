/**
 * Light frosted OpenCluely bar:
 *  - Ask → expand width then chat (normal Q&A)
 *  - Auto Answer → expand + screenshot vision with initiative
 *  - X collapses back to the compact pill
 *  - Drag handle moves the whole window; opens centered at top
 */
(function () {
  const HISTORY_KEY = 'opencluely_bar_chat_v1';
  const EXPANDED_W = 400;
  const COLLAPSED_H = 52;
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

  const AUTO_PROMPT =
    "Look at what's on my screen right now. Use your initiative: if there is a question, quiz, problem, coding prompt, form field, or anything the user likely needs answered or solved, answer it directly and helpfully. If there is no clear question, briefly say what you see and the most useful next step. Read text literally; do not invent content that is not visible.";

  function loadHistory() {
    try {
      history = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
      if (!Array.isArray(history)) history = [];
    } catch (_) {
      history = [];
    }
    messagesEl.innerHTML = '';
    history.forEach((item) => addMessage(item.text, item.type, true));
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

  function addMessage(text, type = 'user', skipPersist = false) {
    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${type}`;
    const timeDiv = document.createElement('div');
    timeDiv.className = 'message-time';
    timeDiv.textContent = new Date().toLocaleTimeString();
    const textDiv = document.createElement('div');
    textDiv.className = 'message-text';
    if (type === 'assistant') textDiv.innerHTML = formatMarkdown(text);
    else textDiv.textContent = text;
    messageDiv.appendChild(timeDiv);
    messageDiv.appendChild(textDiv);
    messagesEl.appendChild(messageDiv);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    if (!skipPersist) {
      history.push({ type, text: String(text || '') });
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
      const rect = shell.getBoundingClientRect();
      const width = Math.max(220, Math.ceil(rect.width));
      const height = Math.max(COLLAPSED_H, Math.ceil(rect.height));
      window.electronAPI.resizeWindow(width, height);
    });
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

  function setControlButtonState(isControlling) {
    controlling = Boolean(isControlling);
    if (!controlBtn) return;
    if (controlling) {
      controlBtn.textContent = 'Stop';
      controlBtn.classList.add('oc-stop');
      controlBtn.classList.remove('oc-control');
      controlBtn.title = 'Stop AI control';
    } else {
      controlBtn.textContent = 'Take Control';
      controlBtn.classList.add('oc-control');
      controlBtn.classList.remove('oc-stop');
      controlBtn.title = 'Let OpenCluely control your machine';
    }
  }

  async function enterTaskPrompt() {
    if (animating || controlling) return;
    animating = true;
    setModeUI('control');
    shell.classList.add('is-shaking');
    await wait(480);
    shell.classList.remove('is-shaking');
    shell.classList.add('is-fading-out');
    await wait(300);
    // Compact task prompt bar
    taskPromptMode = true;
    open = true;
    wide = true;
    shell.classList.remove('is-chat-open');
    shell.classList.add('is-wide', 'is-task-prompt', 'is-fading-in');
    shell.classList.remove('is-fading-out');
    drawer.setAttribute('aria-hidden', 'false');
    if (modeLabel) modeLabel.textContent = 'Take Control';
    if (modeHint) modeHint.textContent = 'What should the AI do on your computer?';
    if (inputEl) {
      inputEl.value = '';
      inputEl.placeholder = 'e.g. Open Chrome and go to example.com…';
      inputEl.focus();
    }
    notifyDrawer(true);
    measureAndResize();
    await wait(280);
    animating = false;
  }

  async function exitTaskPromptToControl(task) {
    animating = true;
    shell.classList.add('is-fading-out');
    await wait(280);
    taskPromptMode = false;
    shell.classList.remove('is-task-prompt', 'is-fading-out');
    shell.classList.add('is-wide', 'is-chat-open', 'is-fading-in');
    open = true;
    wide = true;
    setControlButtonState(true);
    setModeUI('control');
    if (inputEl) inputEl.placeholder = 'Type a message… (Shift+Enter for newline)';
    drawer.setAttribute('aria-hidden', 'false');
    measureAndResize();
    addMessage(`Take Control: ${task}`, 'user');
    addMessage('AI is controlling your machine… blue glow means control is active. Press Stop anytime.', 'system');
    showThinking();
    try {
      await window.electronAPI?.startDesktopControl?.(task);
    } catch (error) {
      hideThinking();
      addMessage(`Control failed: ${error.message}`, 'error');
      setControlButtonState(false);
    }
    await wait(260);
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
    addMessage('Control stopped.', 'system');
    if (modeHint) modeHint.textContent = 'Control ended';
  }

  async function expandToChat(nextMode) {
    if (animating) return;
    animating = true;
    setModeUI(nextMode);

    // 1) Expand width outwards first (fade glass to chat transparency)
    wide = true;
    shell.classList.add('is-wide');
    notifyDrawer(true);
    measureAndResize();
    await wait(300);

    // 2) Then expand chat downward
    open = true;
    shell.classList.add('is-chat-open');
    drawer.setAttribute('aria-hidden', 'false');
    measureAndResize();
    await wait(360);
    measureAndResize();
    animating = false;

    if (nextMode === 'ask') {
      setTimeout(() => inputEl?.focus(), 40);
    }
  }

  async function collapse(opts = {}) {
    const hideIfAlreadyCollapsed = Boolean(opts.hideIfAlreadyCollapsed);
    if (animating) return;
    if (!open && !wide) {
      // Fully collapsed — only the explicit X click should hide the overlay.
      // Drawer sync from main must NOT hide, or /show(["main"]) races itself away.
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
    askBtn?.classList.remove('is-active');
    autoBtn?.classList.remove('is-active');

    // 1) Collapse height first
    open = false;
    shell.classList.remove('is-chat-open');
    drawer.setAttribute('aria-hidden', 'true');
    measureAndResize();
    await wait(320);

    // 2) Then shrink width back to pill
    wide = false;
    shell.classList.remove('is-wide');
    notifyDrawer(false);
    measureAndResize();
    await wait(360);
    // Fit to compact pill content size
    if (tab && window.electronAPI?.resizeWindow) {
      const rect = tab.getBoundingClientRect();
      window.electronAPI.resizeWindow(Math.ceil(rect.width), Math.ceil(rect.height));
    } else {
      measureAndResize();
    }
    animating = false;
  }

  function wait(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  async function sendCurrent() {
    const text = (inputEl?.value || '').trim();
    if (!text) return;
    if (taskPromptMode) {
      inputEl.value = '';
      await exitTaskPromptToControl(text);
      return;
    }
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

  closeBtn?.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (taskPromptMode) {
      taskPromptMode = false;
      shell.classList.remove('is-task-prompt', 'is-wide', 'is-fading-in', 'is-fading-out');
      open = false;
      wide = false;
      if (inputEl) inputEl.placeholder = 'Type a message… (Shift+Enter for newline)';
      notifyDrawer(false);
      measureAndResize();
      return;
    }
    if (controlling) await stopControlFromBar();
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

  // Responses
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
    api.onLlmResponse?.((_e, data) => {
      hideThinking();
      const text = data?.response || data?.text || '';
      if (text) {
        if (!open) expandToChat(mode || 'ask');
        addMessage(text, 'assistant');
      }
    });
    api.onOcrError?.((_e, data) => {
      hideThinking();
      addMessage(data?.error || 'Screenshot failed', 'error');
    });
    api.onSessionCleared?.(() => {
      history = [];
      saveHistory();
      messagesEl.innerHTML = '';
    });
    api.onControlStatus?.((_e, data) => {
      hideThinking();
      if (data?.status === 'running') {
        setControlButtonState(true);
        if (data.message) addMessage(data.message, 'system');
      } else if (data?.status === 'step' && data.message) {
        addMessage(data.message, 'assistant');
      } else if (data?.status === 'done') {
        setControlButtonState(false);
        addMessage(data.message || 'Task complete.', 'assistant');
      } else if (data?.status === 'stopped') {
        setControlButtonState(false);
        addMessage(data.message || 'Control stopped.', 'system');
      } else if (data?.status === 'error') {
        setControlButtonState(false);
        addMessage(data.message || 'Control error', 'error');
      }
    });
  }

  // Fit collapsed pill on load + tell main process we're ready for centering
  loadHistory();
  setControlButtonState(false);
  setTimeout(() => {
    if (tab && window.electronAPI?.resizeWindow) {
      const rect = tab.getBoundingClientRect();
      window.electronAPI.resizeWindow(Math.ceil(rect.width), Math.ceil(rect.height));
    }
    window.electronAPI?.setChatDrawerOpen?.(false);
    window.electronAPI?.notifyMainWindowReady?.();
  }, 80);

  window.barChat = {
    isOpen: () => open,
    expandToChat,
    collapse,
    runAutoAnswer,
    measureAndResize,
    enterTaskPrompt,
    stopControlFromBar,
  };
})();
