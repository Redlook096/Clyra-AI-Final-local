/* Clyra Intelligence Bar.  It is deliberately one surface: every state below
 * is driven by the native bridge and resizes the same overlay window. */
(() => {
  const $ = (id) => document.getElementById(id);
  const ui = Object.fromEntries(['shell','bar','orb','barTitle','quickInput','quickSend','screenButton','voiceButton','plusButton','closeButton','moreButton','pauseControl','stopControl','panel','controlCapsule','controlState','controlAction','controlTime','controlMenuButton','statusRow','statusText','statusDots','microWave','response','identity','responseText','quickActions','attachment','composerWrap','composer','sendButton','addButton','screenMenu','addMenu','commandMenu','controlMenu','confirm','confirmText','approveControl','cancelControl','controlPause','controlTakeover','controlContinue','controlStop','voiceView','voiceState','voiceTime','wave','muteVoice','voiceScreen','endVoice','endVoiceFooter','imageInput','fileInput'].map((id) => [id, $(id)]));
  const api = window.electronAPI;
  const State = Object.freeze({ IDLE:'IDLE', EXPANDED:'EXPANDED', CAPTURING_SCREEN:'CAPTURING_SCREEN', SELECTING_REGION:'SELECTING_REGION', LISTENING:'LISTENING', TRANSCRIBING:'TRANSCRIBING', THINKING:'THINKING', SPEAKING:'SPEAKING', REQUESTING_CONTROL:'REQUESTING_CONTROL', CONTROLLING:'CONTROLLING', WAITING_FOR_PAGE:'WAITING_FOR_PAGE', WAITING_FOR_USER:'WAITING_FOR_USER', WAITING_FOR_APPROVAL:'WAITING_FOR_APPROVAL', PAUSED:'PAUSED', USER_TAKEOVER:'USER_TAKEOVER', MINIMISING:'MINIMISING', MINIMISED:'MINIMISED', RESTORING:'RESTORING', FAILED:'FAILED', STOPPED:'STOPPED' });
  let state = State.IDLE, attachment = null, selectedText = '', pendingControlTask = '', micStream = null, audioContext = null, analyser = null, voiceFrame = 0, voiceStartedAt = 0, voiceClock = 0, muted = false, controlStartedAt = 0, controlClock = 0, streamText = '', lastAnswer = '';

  const isControl = () => [State.CONTROLLING, State.PAUSED, State.USER_TAKEOVER].includes(state);
  const show = (element, visible) => { element.hidden = !visible; };
  const formatAnswer = (value) => {
    // Responses originate in the model pipeline. Escape first, then allow a
    // deliberately tiny, safe subset of markdown so a short screen answer
    // reads like native prose instead of exposing literal ** markers.
    const escaped = String(value || '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return escaped
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\n/g, '<br>');
  };
  const barIdentity = (label = '') => { const active = Boolean(label); show(ui.barTitle, active); ui.barTitle.textContent = label; const copy = ui.quickInput.closest('.bar-copy'); if (copy) copy.hidden = active; };
  const setOrb = (next = 'idle', level = .12) => {
    ui.orb.className = `orb ${next}`;
    ui.orb.style.setProperty('--orb-level', Math.max(.06, Math.min(.95, level)).toFixed(2));
  };
  const setState = (next, detail = '') => {
    state = next; ui.shell.dataset.state = next;
    const orbState = next === State.LISTENING ? 'listening' : next === State.SPEAKING ? 'speaking' : [State.THINKING, State.CAPTURING_SCREEN, State.SELECTING_REGION].includes(next) ? 'thinking' : 'idle';
    setOrb(orbState);
    if (next === State.THINKING) status('Thinking…', 'thinking');
    if (next === State.CAPTURING_SCREEN) status(detail || 'Reading screen…', 'thinking');
    if (next === State.SELECTING_REGION) status('Select area…', 'thinking');
  };
  const status = (text = '', mode = '') => {
    const visible = Boolean(text);
    ui.statusRow.classList.toggle('show', visible);
    ui.statusText.textContent = text;
    ui.statusDots.textContent = mode === 'thinking' ? '•••' : '';
    ui.microWave.style.display = mode === 'voice' ? 'flex' : 'none';
  };
  const resize = async (height, width = 480) => {
    const h = Math.max(56, Math.min(550, Math.round(height)));
    try { await api?.resizeWindow?.(width, h, { growFromTopCenter:true }); } catch (_) {}
  };
  const closeMenus = () => [ui.screenMenu, ui.addMenu, ui.commandMenu, ui.controlMenu].forEach((menu) => menu?.classList.remove('show'));
  const composerHeight = () => Math.min(92, Math.max(19, ui.composer.scrollHeight || 19));
  const setExpanded = async (open, { height, focus = false } = {}) => {
    ui.shell.dataset.expanded = String(Boolean(open));
    ui.shell.classList.toggle('compact-control', false);
    ui.voiceView.classList.remove('show');
    if (!open) { await resize(56); return; }
    await resize(height || 170, 480);
    if (focus) requestAnimationFrame(() => ui.composer.focus());
  };
  const cleanAnswer = () => {
    streamText = ''; lastAnswer = ''; ui.responseText.textContent = ''; ui.responseText.classList.remove('streaming'); ui.identity.hidden = true;
    ui.quickActions.classList.remove('show'); ui.quickActions.replaceChildren(); status('');
  };
  const baseIdle = async () => {
    closeMenus(); stopVoiceVisuals(); cleanAnswer(); ui.controlCapsule.classList.remove('show'); ui.attachment.classList.remove('show');
    attachment = null; selectedText = ''; barIdentity(''); ui.quickInput.value = ''; ui.composer.value = ''; ui.quickInput.placeholder = 'Ask Clyra or type a task…'; show(ui.quickSend, false); show(ui.screenButton, true); show(ui.voiceButton, true); show(ui.plusButton, true); show(ui.closeButton, true); show(ui.moreButton, false); show(ui.pauseControl, false); show(ui.stopControl, false);
    setState(State.IDLE); await setExpanded(false);
  };
  const showComposer = async (placeholder = 'Ask a follow-up…', focus = true) => {
    ui.composer.placeholder = placeholder; await setExpanded(true, { height: 112, focus });
  };
  const makeAction = (label, onClick, kind = '') => { const button = document.createElement('button'); button.type = 'button'; button.className = `chip ${kind}`; button.textContent = label; button.onclick = onClick; return button; };
  const showAnswer = async (text, { streaming = false, actions = [] } = {}) => {
    barIdentity('Clyra'); show(ui.quickSend, false); show(ui.screenButton, false); show(ui.voiceButton, false); show(ui.plusButton, false); show(ui.closeButton, true); show(ui.moreButton, true);
    // The header already carries Clyra's identity; repeating another orb in
    // every answer wastes the compact vertical rhythm of the bar.
    ui.identity.hidden = true; ui.responseText.innerHTML = formatAnswer(text); ui.responseText.classList.toggle('streaming', streaming); lastAnswer = text || lastAnswer;
    ui.quickActions.replaceChildren(...actions.map(({label, onClick, kind}) => makeAction(label, onClick, kind)));
    ui.quickActions.classList.toggle('show', actions.length > 0);
    status(''); const chars = (text || '').length; const height = Math.min(510, Math.max(156, 118 + Math.min(220, Math.ceil(chars / 52) * 20) + (actions.length ? 42 : 0)));
    await setExpanded(true, { height });
  };
  const responseActions = () => [
    { label:'Copy', onClick:() => api?.copyToClipboard?.(lastAnswer) },
    { label:'Explain more', onClick:() => { ui.composer.value = 'Explain more about that.'; send(); } },
    { label:'⋯', kind:'more', onClick:() => closeMenus() },
  ];
  const transformSelectedText = async (action) => {
    if (!selectedText) return;
    await beginThinking(`${action}…`);
    try {
      const result = await api?.transformSelectedText?.({ text:selectedText, action });
      if (!result?.ok) throw new Error(result?.error || 'Clyra could not transform the selection.');
      const replacement = result.response;
      await showAnswer(replacement, { actions:[
        { label:'Replace', onClick:async () => { const replaced = await api?.replaceSelectedText?.(replacement); if (replaced?.ok === false) { await showAnswer(replaced.error, { actions:responseActions() }); setState(State.FAILED); } else { selectedText = ''; await baseIdle(); } } },
        { label:'Copy', onClick:() => api?.copyToClipboard?.(replacement) },
        { label:'Cancel', onClick:() => { selectedText = ''; baseIdle(); } },
      ] });
      setState(State.EXPANDED);
    } catch (error) { await showAnswer(error?.message || 'Clyra could not transform the selection.', { actions:responseActions() }); setState(State.FAILED); }
  };
  const showSelectedTextActions = async (text) => {
    selectedText = String(text || '').trim();
    if (!selectedText) return;
    cleanAnswer(); barIdentity('Improve selected text…'); show(ui.screenButton, false); show(ui.voiceButton, true); show(ui.plusButton, false); show(ui.closeButton, true); show(ui.moreButton, false);
    ui.quickActions.replaceChildren(...['Improve','Rewrite','Shorter','Fix grammar','Ask Clyra'].map((label) => makeAction(label, () => transformSelectedText(label))));
    ui.quickActions.classList.add('show'); setState(State.WAITING_FOR_USER); await setExpanded(true, { height:122 });
  };
  const beginThinking = async (text = 'Thinking…') => {
    cleanAnswer(); barIdentity(text); show(ui.quickSend, false); show(ui.screenButton, false); show(ui.voiceButton, false); show(ui.plusButton, false); show(ui.closeButton, true); show(ui.moreButton, false); status('', ''); setState(State.THINKING, text); await setExpanded(false);
  };
  const attach = async (data) => {
    attachment = data; ui.attachment.replaceChildren();
    if (data?.preview) { const image = new Image(); image.src = data.preview; image.alt = data?.label || 'Attached context'; ui.attachment.append(image); }
    const label = document.createElement('span'); label.innerHTML = `<b>${data?.label || 'Screen attached'}</b>`; ui.attachment.append(label);
    const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '×'; remove.setAttribute('aria-label','Remove attachment'); remove.onclick = () => { attachment = null; ui.attachment.classList.remove('show'); };
    ui.attachment.append(remove); ui.attachment.classList.add('show'); await showComposer('Ask about this screen…', true); setState(State.EXPANDED);
  };
  const send = async (value = ui.composer.value || ui.quickInput.value) => {
    let text = String(value || '').trim(); if (!text) return;
    if (isControl()) {
      ui.composer.value = ''; ui.quickInput.value = ''; ui.controlAction.textContent = `Updating task · ${text}`; setState(State.CONTROLLING);
      try { const result = await api?.steerDesktopControl?.(text); if (result?.ok === false) throw new Error(result.error || 'The active task could not be updated.'); }
      catch (error) { ui.controlAction.textContent = error?.message || 'The active task could not be updated.'; setState(State.FAILED); }
      return;
    }
    if (attachment?.kind === 'text' && attachment.text) text = `${text}\n\n[Attached file: ${attachment.name || 'document'}]\n${attachment.text.slice(0, 160000)}`;
    ui.composer.value = ''; ui.quickInput.value = ''; show(ui.quickSend, false); await beginThinking(attachment ? 'Reading screen…' : 'Thinking…');
    try { await api?.sendChatMessage?.(text); } catch (error) { await showAnswer(error?.message || 'Clyra could not send that request.', { actions: responseActions() }); setState(State.FAILED); }
  };
  const performContextAction = async (action) => {
    closeMenus();
    if (action === 'voice') return startVoice();
    if (action === 'control') return requestControl();
    if (action === 'attach-image') { await resize(56, 480); ui.imageInput.click(); return; }
    if (action === 'attach-file') { await resize(56, 480); ui.fileInput.click(); return; }
    if (action === 'search') { await showComposer('Search the web…'); ui.composer.value = '/search '; updateComposer(); return; }
    if (action === 'create-task') { await showComposer('Describe the task…'); ui.composer.value = 'Create a task to '; updateComposer(); return; }
    if (action === 'open-chat') { await showComposer('Ask Clyra anything…'); setState(State.EXPANDED); return; }
    if (action === 'area') {
      setState(State.SELECTING_REGION); await setExpanded(true, { height: 86 });
      try { const result = await api?.beginRegionSelection?.(); if (result?.ok === false) throw new Error(result.error || 'Area selection is unavailable.'); } catch (error) { await showAnswer(error?.message || 'Clyra could not start area selection.', { actions: responseActions() }); setState(State.FAILED); }
      return;
    }
    await beginThinking(action === 'window' ? 'Capturing current window…' : 'Capturing current screen…');
    try { const result = action === 'window' ? await api?.captureCurrentWindow?.() : await api?.captureCurrentScreen?.(); if (!result?.ok) throw new Error(result?.error || 'The screen could not be captured.'); await attach(result); }
    catch (error) { await showAnswer(error?.message || 'Screen capture failed.', { actions: responseActions() }); setState(State.FAILED); }
  };
  const requestControl = async () => {
    closeMenus(); const task = String(ui.composer.value || ui.quickInput.value || '').trim();
    if (!task) { await showComposer('Describe the task Clyra should complete…'); return; }
    pendingControlTask = task; ui.confirmText.textContent = `Clyra will try to complete “${task.slice(0, 140)}”. You can pause or stop it immediately.`; ui.shell.dataset.expanded = 'true'; ui.confirm.classList.add('show'); setState(State.REQUESTING_CONTROL); await resize(190, 480);
  };
  const startControlClock = () => { controlStartedAt = Date.now(); clearInterval(controlClock); controlClock = setInterval(() => { const seconds = Math.floor((Date.now() - controlStartedAt) / 1000); ui.controlTime.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2,'0')}`; }, 1000); };
  const controlSurface = async (expanded = false) => {
    // The compact control bar owns the status. When opened, the same header
    // keeps that identity while the panel adds only the observable action and
    // steering composer — never a duplicate idle input plus a second capsule.
    barIdentity(expanded ? (ui.controlState.textContent || 'Controlling · Working…') : ''); ui.controlCapsule.classList.add('show'); ui.quickInput.value = ''; ui.composer.placeholder = 'Tell Clyra what to do next…';
    show(ui.screenButton, false); show(ui.voiceButton, false); show(ui.plusButton, false); show(ui.closeButton, false); show(ui.moreButton, false); show(ui.quickSend, false); show(ui.pauseControl, true); show(ui.stopControl, true);
    ui.bar.dataset.control = ui.controlState.textContent || 'Controlling · Working…'; ui.shell.classList.toggle('compact-control', !expanded); ui.shell.dataset.expanded = String(expanded);
    await resize(expanded ? 132 : 56, 480); if (expanded) ui.composer.focus();
  };
  const approveControl = async () => {
    ui.confirm.classList.remove('show'); const task = pendingControlTask; pendingControlTask = ''; ui.composer.value = ''; ui.quickInput.value = '';
    ui.controlState.textContent = 'Controlling · Starting…'; ui.controlAction.textContent = 'Preparing an approved session…'; setState(State.CONTROLLING); startControlClock(); await controlSurface(false);
    try { const result = await api?.startDesktopControl?.(task); if (result?.ok === false) throw new Error(result.error || 'Computer control is unavailable.'); }
    catch (error) { clearInterval(controlClock); await showAnswer(error?.message || 'Computer control could not start.', { actions: responseActions() }); setState(State.FAILED); }
  };
  const stopControl = async () => { await api?.stopDesktopControl?.(); clearInterval(controlClock); ui.controlCapsule.classList.remove('show'); await showAnswer('Control stopped.', { actions: responseActions() }); setState(State.STOPPED); };
  const pauseControl = async () => {
    if (state === State.PAUSED || state === State.USER_TAKEOVER) { const result = await api?.resumeDesktopControl?.(); if (!result?.ok) return; ui.controlState.textContent = 'Controlling · Continuing…'; ui.controlAction.textContent = 'Re-observing the current screen…'; ui.pauseControl.title = 'Pause'; setState(State.CONTROLLING); await controlSurface(true); return; }
    const result = await api?.pauseDesktopControl?.(); if (result?.ok) { ui.controlState.textContent = 'Clyra paused'; ui.controlAction.textContent = 'You have control. Continue when ready.'; ui.pauseControl.title = 'Continue'; setState(State.PAUSED); await controlSurface(true); }
  };
  const makeBars = (host, count) => { host.replaceChildren(); for (let i = 0; i < count; i++) host.append(document.createElement('i')); };
  const animateVoice = () => {
    if (!analyser) return; const samples = new Uint8Array(analyser.fftSize); const bars = [...ui.wave.children], micro = [...ui.microWave.children];
    const draw = () => { analyser.getByteTimeDomainData(samples); let sum = 0; for (const sample of samples) sum += (sample - 128) ** 2; const level = Math.min(1, Math.sqrt(sum / samples.length) / 44); setOrb(state === State.SPEAKING ? 'speaking' : 'listening', level); ui.shell.style.setProperty('--audio-level', level.toFixed(3)); [...bars, ...micro].forEach((bar, index) => { const center = (index % (bars.length || 1)) / Math.max(1, bars.length - 1); const shaped = (1 - Math.abs(center - .5) * .48) * (index % 3 ? 1 : .72); bar.style.height = `${Math.max(4, 4 + level * 29 * shaped)}px`; }); voiceFrame = requestAnimationFrame(draw); }; draw();
  };
  const stopVoiceVisuals = () => { cancelAnimationFrame(voiceFrame); clearInterval(voiceClock); voiceFrame = 0; analyser = null; audioContext?.close?.().catch(() => {}); audioContext = null; micStream?.getTracks().forEach((track) => track.stop()); micStream = null; ui.voiceView.classList.remove('show'); ui.shell.style.setProperty('--audio-level', '0'); };
  const startVoice = async () => {
    closeMenus(); cleanAnswer(); makeBars(ui.wave, 35); makeBars(ui.microWave, 15); ui.voiceState.textContent = 'Listening…'; ui.voiceView.classList.add('show'); ui.shell.dataset.expanded = 'true'; ui.controlCapsule.classList.remove('show'); show(ui.screenButton, false); show(ui.voiceButton, false); show(ui.plusButton, false); show(ui.closeButton, false); await resize(158, 400); setState(State.LISTENING); voiceStartedAt = Date.now(); clearInterval(voiceClock); voiceClock = setInterval(() => { const seconds = Math.floor((Date.now() - voiceStartedAt) / 1000); ui.voiceTime.textContent = `${String(Math.floor(seconds / 60)).padStart(2,'0')}:${String(seconds % 60).padStart(2,'0')}`; }, 1000);
    try { const result = await api?.startOverlayVoiceCall?.(); if (result?.ok === false) throw new Error(result.error); micStream = await navigator.mediaDevices.getUserMedia({ audio:true }); audioContext = new AudioContext(); analyser = audioContext.createAnalyser(); analyser.fftSize = 128; audioContext.createMediaStreamSource(micStream).connect(analyser); animateVoice(); }
    catch (error) { ui.voiceState.textContent = 'Microphone unavailable'; setState(State.FAILED); }
  };
  const endVoice = async () => { await api?.endOverlayVoiceCall?.(); await baseIdle(); };
  const toggleMute = () => { muted = !muted; micStream?.getAudioTracks().forEach((track) => { track.enabled = !muted; }); ui.muteVoice.querySelector('span').textContent = muted ? 'Unmute' : 'Mute'; ui.voiceState.textContent = muted ? 'Microphone muted' : 'Listening…'; };
  const updateInput = () => { const hasText = Boolean(ui.quickInput.value.trim()); show(ui.quickSend, hasText); show(ui.screenButton, !hasText); show(ui.voiceButton, !hasText); show(ui.plusButton, !hasText); show(ui.closeButton, !hasText); show(ui.moreButton, false); if (hasText && !ui.shell.dataset.expanded) ui.shell.dataset.expanded = 'false'; };
  const updateComposer = () => { ui.composer.style.height = 'auto'; ui.composer.style.height = `${composerHeight()}px`; const value = ui.composer.value.trim(); ui.commandMenu.classList.toggle('show', value === '/' || /^\/(?:s|v|c)/i.test(value)); if (!isControl()) resize(Math.max(112, 96 + composerHeight())); };
  const fileToBase64 = async (file) => {
    const bytes = new Uint8Array(await file.arrayBuffer()); let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    return btoa(binary);
  };
  const attachImageFile = async (file) => {
    if (!file) return;
    await beginThinking('Attaching image…');
    try {
      const result = await api?.attachLocalImage?.({ name:file.name, mimeType:file.type, base64:await fileToBase64(file) });
      if (!result?.ok) throw new Error(result?.error || 'The image could not be attached.');
      await attach(result);
    } catch (error) { await showAnswer(error?.message || 'The image could not be attached.', { actions:responseActions() }); setState(State.FAILED); }
    finally { ui.imageInput.value = ''; }
  };
  const attachTextFile = async (file) => {
    if (!file) return;
    try {
      const text = await file.text();
      if (text.length > 160000) throw new Error('This file is too large. Choose a text file under 160 KB.');
      await attach({ kind:'text', name:file.name, label:file.name, text });
    } catch (error) { await showAnswer(error?.message || 'The file could not be attached.', { actions:responseActions() }); setState(State.FAILED); }
    finally { ui.fileInput.value = ''; }
  };
  const toggleMenu = async (menu) => {
    const willOpen = !menu.classList.contains('show'); closeMenus(); menu.classList.toggle('show', willOpen);
    if (willOpen) await resize(menu === ui.addMenu ? 470 : menu === ui.screenMenu ? 280 : 260, 480);
    else if (ui.shell.dataset.expanded !== 'true' && !isControl()) await resize(56, 480);
    if (willOpen) requestAnimationFrame(() => menu.querySelector('button')?.focus({ preventScroll:true }));
  };
  const handleMenuKeys = (event) => {
    const menu = event.currentTarget; const rows = [...menu.querySelectorAll('button:not([disabled])')]; const index = Math.max(0, rows.indexOf(document.activeElement));
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); rows[(index + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length]?.focus(); }
    else if (event.key === 'Home') { event.preventDefault(); rows[0]?.focus(); }
    else if (event.key === 'End') { event.preventDefault(); rows.at(-1)?.focus(); }
    else if (event.key === 'Escape') { event.preventDefault(); closeMenus(); if (ui.shell.dataset.expanded !== 'true' && !isControl()) resize(56, 480); ui.quickInput.focus(); }
  };

  ui.quickInput.addEventListener('focus', () => { if (!isControl()) setState(State.EXPANDED); });
  ui.quickInput.addEventListener('input', updateInput);
  ui.quickInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); send(ui.quickInput.value); } if (event.key === 'Escape') baseIdle(); });
  ui.quickSend.onclick = () => send(ui.quickInput.value); ui.sendButton.onclick = () => send();
  ui.composer.addEventListener('input', updateComposer); ui.composer.addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send(); } if (event.key === 'Escape') closeMenus(); });
  ui.screenButton.onclick = (event) => { event.stopPropagation(); toggleMenu(ui.screenMenu); };
  ui.voiceButton.onclick = startVoice; ui.plusButton.onclick = (event) => { event.stopPropagation(); toggleMenu(ui.addMenu); }; ui.closeButton.onclick = () => api?.quit?.(); ui.endVoice.onclick = endVoice; ui.endVoiceFooter.onclick = endVoice; ui.muteVoice.onclick = toggleMute; ui.voiceScreen.onclick = () => performContextAction('screen');
  ui.moreButton.onclick = (event) => { event.stopPropagation(); toggleMenu(ui.addMenu); };
  ui.addButton.onclick = (event) => { event.stopPropagation(); toggleMenu(ui.addMenu); };
  ui.imageInput.addEventListener('change', () => attachImageFile(ui.imageInput.files?.[0]));
  ui.fileInput.addEventListener('change', () => attachTextFile(ui.fileInput.files?.[0]));
  ui.pauseControl.onclick = pauseControl; ui.stopControl.onclick = stopControl; ui.controlMenuButton.onclick = () => ui.controlMenu.classList.toggle('show');
  ui.bar.addEventListener('click', (event) => {
    if (isControl() && !event.target.closest('button')) void controlSurface(true);
  });
  ui.controlPause.onclick = pauseControl; ui.controlTakeover.onclick = async () => { await pauseControl(); setState(State.USER_TAKEOVER); }; ui.controlContinue.onclick = pauseControl; ui.controlStop.onclick = stopControl;
  ui.approveControl.onclick = approveControl; ui.cancelControl.onclick = () => { ui.confirm.classList.remove('show'); baseIdle(); };
  document.querySelectorAll('[data-action]').forEach((button) => { button.onclick = () => performContextAction(button.dataset.action); });
  document.querySelectorAll('[data-command]').forEach((button) => { button.onclick = () => performContextAction(button.dataset.command === 'select' ? 'area' : button.dataset.command); });
  document.querySelectorAll('.menu').forEach((menu) => menu.addEventListener('keydown', handleMenuKeys));
  document.addEventListener('pointerdown', (event) => { if (!event.target.closest('.menu') && !event.target.closest('#screenButton') && !event.target.closest('#plusButton') && !event.target.closest('#moreButton') && !event.target.closest('#addButton') && !event.target.closest('#controlMenuButton')) { const hadMenu = [...document.querySelectorAll('.menu')].some((menu) => menu.classList.contains('show')); closeMenus(); if (hadMenu && ui.shell.dataset.expanded !== 'true' && !isControl()) resize(56, 480); } });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') { if (ui.confirm.classList.contains('show')) ui.confirm.classList.remove('show'); else if ([...document.querySelectorAll('.menu')].some((menu) => menu.classList.contains('show'))) closeMenus(); else if (ui.shell.dataset.expanded === 'true') baseIdle(); } });

  api?.onScreenContextAttached?.((_event, data) => { if (data?.preview || data?.label) attach(data); });
  api?.onSelectedTextContext?.((_event, data = {}) => { if (data.error) { showAnswer(data.error, { actions:[{ label:'Try again', onClick:() => baseIdle() }] }); setState(State.FAILED); } else showSelectedTextActions(data.text); });
  api?.onTranscriptionLlmResponseStart?.(() => beginThinking(attachment ? 'Reading screen…' : 'Thinking…'));
  api?.onTranscriptionLlmResponseChunk?.((_event, data) => { streamText += data?.delta || data?.chunk || data?.text || ''; showAnswer(streamText, { streaming:true }); setState(State.THINKING); });
  api?.onTranscriptionLlmResponse?.((_event, data) => { const text = data?.response || data?.text || streamText || ''; streamText = ''; attachment = null; ui.attachment.classList.remove('show'); showAnswer(text, { actions:responseActions() }); setState(State.EXPANDED); });
  api?.onLlmError?.((_event, data = {}) => { const message = String(data.error || 'Clyra could not reach the AI service.'); showAnswer(message, { actions:[{ label:'Try again', onClick:() => { ui.composer.value = 'Try that request again.'; send(); } }, { label:'Settings', onClick:() => api?.showSettings?.() }] }); setState(State.FAILED); });
  api?.onOcrError?.((_event, data) => { showAnswer(data?.error || 'Screen capture failed.', { actions:responseActions() }); setState(State.FAILED); });
  api?.onControlStatus?.((_event, data = {}) => {
    const message = String(data.message || 'Working…');
    if (['running','step','action','thinking','bash','response'].includes(data.status)) { ui.controlState.textContent = `Controlling · ${message}`; ui.controlAction.textContent = message; setState(State.CONTROLLING); if (!controlClock) startControlClock(); controlSurface(ui.shell.dataset.expanded === 'true' && !ui.shell.classList.contains('compact-control')); }
    else if (data.status === 'paused') { ui.controlState.textContent = 'Clyra paused'; ui.controlAction.textContent = message; setState(State.PAUSED); controlSurface(true); }
    else if (['done','stopped'].includes(data.status)) { clearInterval(controlClock); ui.controlCapsule.classList.remove('show'); showAnswer(message || 'Done.', { actions:responseActions() }); setState(data.status === 'done' ? State.EXPANDED : State.STOPPED); }
    else if (data.status === 'error') { clearInterval(controlClock); showAnswer(message || 'Computer control failed.', { actions:responseActions() }); setState(State.FAILED); }
  });
  api?.onVoiceCallState?.((_event, data = {}) => { if (data.state === 'thinking') { ui.voiceState.textContent = 'Thinking…'; setState(State.THINKING); } else if (data.state === 'listening') { ui.voiceState.textContent = 'Listening…'; setState(State.LISTENING); } else if (data.state === 'speaking') { ui.voiceState.textContent = 'Speaking…'; setState(State.SPEAKING); } else if (data.state === 'ended') endVoice(); });
  api?.onToggleChatDrawer?.((_event, payload) => { if (payload?.open) showComposer('Ask a follow-up…', false); else baseIdle(); });

  setOrb('idle'); baseIdle(); api?.notifyMainWindowReady?.();
  window.barChat = { isOpen: () => ui.shell.dataset.expanded === 'true', expandToChat: () => showComposer(), collapse: baseIdle, runAutoAnswer: () => performContextAction('screen'), enterTaskPrompt: requestControl, stopControlFromBar: stopControl };
})();
