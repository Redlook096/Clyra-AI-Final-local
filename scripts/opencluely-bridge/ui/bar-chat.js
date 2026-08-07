/**
 * Chat drawer that expands smoothly under the centered command bar.
 * Replaces the separate Live Transcription & Chat BrowserWindow panel.
 */
(function () {
  const HISTORY_KEY = 'opencluely_bar_chat_v1';
  const shell = document.getElementById('ocShell');
  const drawer = document.getElementById('chatDrawer');
  const messagesEl = document.getElementById('barChatMessages');
  const inputEl = document.getElementById('barChatInput');
  const sendBtn = document.getElementById('barChatSend');
  const clearBtn = document.getElementById('barChatClear');
  const collapseBtn = document.getElementById('barChatCollapse');
  const toggleBtn = document.getElementById('chatToggle');

  if (!shell || !drawer || !messagesEl) {
    console.warn('[BarChat] drawer elements missing');
    return;
  }

  let open = false;
  let history = [];

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
    if (type === 'assistant') {
      textDiv.innerHTML = formatMarkdown(text);
    } else {
      textDiv.textContent = text;
    }

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
    const el = document.getElementById('bar-thinking');
    if (el) el.remove();
  }

  function resizeShell() {
    // Prefer MainWindowUI resize when available (accounts for popover too)
    if (window.mainWindowUI && typeof window.mainWindowUI.resizeWindowToContent === 'function') {
      window.mainWindowUI.resizeWindowToContent();
      return;
    }
    if (!window.electronAPI || !window.electronAPI.resizeWindow) return;
    requestAnimationFrame(() => {
      const rect = shell.getBoundingClientRect();
      const width = Math.max(60, Math.ceil(rect.width));
      const height = Math.max(28, Math.ceil(rect.height));
      window.electronAPI.resizeWindow(width, height);
    });
  }

  function setOpen(next, { focusInput = true } = {}) {
    open = Boolean(next);
    shell.classList.toggle('is-chat-open', open);
    drawer.setAttribute('aria-hidden', open ? 'false' : 'true');
    if (toggleBtn) toggleBtn.classList.toggle('is-open', open);
    // Tell main process so resize clamps / centering can adapt
    try {
      if (window.electronAPI && window.electronAPI.setChatDrawerOpen) {
        window.electronAPI.setChatDrawerOpen(open);
      }
    } catch (_) {
      /* ignore */
    }
    // Allow CSS transition to start, then size the BrowserWindow
    resizeShell();
    setTimeout(resizeShell, 60);
    setTimeout(resizeShell, 340);
    if (open && focusInput && inputEl) {
      setTimeout(() => inputEl.focus(), 280);
    }
  }

  function toggle() {
    setOpen(!open);
  }

  async function sendCurrent() {
    const text = (inputEl?.value || '').trim();
    if (!text) return;
    if (!open) setOpen(true, { focusInput: false });
    addMessage(text, 'user');
    inputEl.value = '';
    autoGrow();
    showThinking();
    try {
      if (window.electronAPI && window.electronAPI.sendChatMessage) {
        await window.electronAPI.sendChatMessage(text);
      }
    } catch (error) {
      hideThinking();
      addMessage(`Failed to send: ${error.message}`, 'error');
    }
  }

  function autoGrow() {
    if (!inputEl) return;
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 100) + 'px';
  }

  // Wire controls
  toggleBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    toggle();
  });
  collapseBtn?.addEventListener('click', () => setOpen(false));
  clearBtn?.addEventListener('click', () => {
    history = [];
    saveHistory();
    messagesEl.innerHTML = '';
    addMessage('Chat cleared.', 'system');
  });
  sendBtn?.addEventListener('click', () => sendCurrent());
  inputEl?.addEventListener('input', autoGrow);
  inputEl?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendCurrent();
    }
  });

  // Listen for main-process open/close requests (shortcut, recording, screenshot)
  if (window.electronAPI?.receive) {
    window.electronAPI.receive('toggle-chat-drawer', (_e, payload) => {
      if (payload && typeof payload.open === 'boolean') setOpen(payload.open);
      else toggle();
    });
  }
  if (window.electronAPI?.onToggleChatDrawer) {
    window.electronAPI.onToggleChatDrawer((_event, payload) => {
      if (payload && typeof payload.open === 'boolean') setOpen(payload.open);
      else toggle();
    });
  }

  // LLM / OCR responses → show in drawer (and auto-expand)
  const api = window.electronAPI;
  if (api) {
    api.onTranscriptionLlmResponse?.((_e, data) => {
      hideThinking();
      const text = data?.response || data?.text || data?.dataPreview || '';
      if (text) {
        setOpen(true, { focusInput: false });
        addMessage(text, 'assistant');
      }
    });
    api.onTranscriptionLlmResponseStart?.(() => {
      setOpen(true, { focusInput: false });
      showThinking();
    });
    api.onLlmResponse?.((_e, data) => {
      hideThinking();
      const text = data?.response || data?.text || '';
      if (text) {
        setOpen(true, { focusInput: false });
        addMessage(text, 'assistant');
      }
    });
    api.onOcrError?.((_e, data) => {
      hideThinking();
      setOpen(true, { focusInput: false });
      addMessage(data?.error || 'Screenshot failed', 'error');
    });
    api.onSpeechError?.((_e, data) => {
      setOpen(true, { focusInput: false });
      addMessage(data?.error || 'Speech error', 'error');
    });
    api.onTranscriptionReceived?.((_e, data) => {
      const text = typeof data === 'string' ? data : data?.text;
      if (text) {
        setOpen(true, { focusInput: false });
        addMessage(text, 'transcription');
        showThinking();
      }
    });
    api.onRecordingStarted?.(() => setOpen(true, { focusInput: false }));
    api.onSessionCleared?.(() => {
      history = [];
      saveHistory();
      messagesEl.innerHTML = '';
      addMessage('Session cleared.', 'system');
    });
  }

  // Also support window.api.receive for recording events
  if (window.api?.receive) {
    window.api.receive('recording-started', () => setOpen(true, { focusInput: false }));
  }

  loadHistory();
  if (history.length === 0) {
    addMessage('Chat lives under the tool bar — click the chat icon or press Ctrl/Cmd+Shift+C.', 'system');
  }

  // Expose for main-window resize integration
  window.barChat = {
    isOpen: () => open,
    setOpen,
    toggle,
    resizeShell,
  };
})();
