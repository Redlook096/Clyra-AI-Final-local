# WhimprFlow Integration Audit

## Donor

- Repository: `https://github.com/Blueturboguy07/WhimprFlow`
- Audited commit: `0a05fda915571aa5c9204eea69621dc1c33cde6d`
- Clone location: `vendor-src/WhimprFlow` (development reference only; it is not launched or packaged as a second app).

## Source inspected

| Concern | WhimprFlow source | Clyra destination |
| --- | --- | --- |
| Pure dictation lifecycle | `crates/whimpr-core/src/state/{machine,events,actions}.rs` | `electron/dictation-manager.mjs`, `src/components/DictationController.tsx` |
| Audio lifecycle and RMS design | `crates/whimpr-audio/src/lib.rs` | Existing `src/lib/voicePcmCapture.ts`; reused by `DictationController` |
| macOS global hotkey and lifecycle | `src-tauri/src/hotkey.rs` | `electron/dictation-manager.mjs` |
| Clipboard / safe paste model | `src-tauri/src/paste.rs` | `electron/dictation-manager.mjs` |
| Cleanup levels and prompts | `crates/whimpr-core/src/cleanup/{levels,prompts}.rs` | `server.ts` `/api/dictation/cleanup` and `/api/dictation/optimise` |
| Personal dictionary | `crates/whimpr-core/src/dictionary/mod.rs` | `clyra-dictation-dictionary` local setting consumed by cleanup |
| Local history and stats pattern | `crates/whimpr-core/src/stats.rs` | bounded `clyra-dictation-history` local record |
| Floating flow-bar interaction | `ui/src/overlay/{FlowBar,main}.tsx` | `electron/dictation-pill.html` + `electron/dictation-preload.cjs` |
| Platform and permission notes | `docs/research/{macos-architecture,win-insertion,hotkeys-interaction,cleanup-prompting}.md` | architecture and platform notes below |

## State and event flow

```text
Cmd+Shift+K / Ctrl+Shift+K
  -> Electron globalShortcut (one registration)
  -> explicit frontmost-app and selected-text inspection
  -> native light pill
  -> renderer DictationController
  -> existing /voice/session with mode=dictation
  -> existing PCM capture + existing streaming STT pipeline
  -> transcript-only websocket result
  -> existing server-side Clyra model cleanup or rewrite
  -> target-app verification
  -> clipboard snapshot -> native paste -> full snapshot restoration
  -> bounded local undo/history record
```

`Escape` is registered only while a dictation state is active and cancels capture, processing, preview, and insertion. It is unregistered when the pill returns to idle. The main shortcut is registered once at startup and released on app shutdown.

## Ported and rewritten

- **Ported conceptually:** a deterministic idle/listening/finalising lifecycle; a compact lower-screen pill; explicit cancellation; conservative cleanup defaults; app-target capture; clipboard-before-paste restoration; dictionary and bounded history.
- **Rewritten:** all native shell glue for Electron 43, Clyra’s one streaming STT route, Clyra’s existing server-side DeepSeek-compatible LLM configuration, and a light Clyra visual treatment.
- **Rejected:** WhimprFlow's `whisper.cpp`, CPAL audio process, local cleanup models, OpenAI/Anthropic clients, local model installers, Tauri windows, and automatic learned-dictionary observation. These would duplicate Clyra’s services, consume unnecessary memory, or capture text beyond a deliberately activated interaction.

## Privacy and safety boundaries

- No selected text is inspected until the user presses the global shortcut.
- Normal dictation sends audio only to the configured Clyra STT service. Selected text is sent to the LLM only after the user chooses **Optimise**.
- A selection is read through macOS Accessibility first. The fallback uses a controlled Cmd+C only after activation, snapshots clipboard formats through Electron, and restores them immediately.
- Insertion rechecks the frontmost app before paste. If focus changed while transcription or cleanup was running, Clyra does not paste.
- Native insertion snapshots all clipboard formats Electron exposes through `availableFormats` / `readBuffer`, then restores each buffer after the target has consumed the paste.
- The feature keeps one active microphone capture and one STT request. It has no local Whisper, llama.cpp, PyTorch, persistent worker, or duplicate model/API client.

## Platform status

- **macOS:** Cmd+Shift+K is registered by Electron. Text selection and paste use System Events/Accessibility only after explicit activation. Users must grant macOS Accessibility and microphone permissions; a denied permission produces an error state and leaves selected text unchanged.
- **Windows:** Ctrl+Shift+K registration is implemented. Native target selection and `SendInput` replacement are intentionally not claimed until a signed Windows helper is added and tested against elevated applications.
- **Linux:** no external-app insertion is exposed.

## Remaining work before broad packaged distribution

1. Add a signed macOS accessibility helper for direct AX insertion where an app exposes a writable control, retaining clipboard paste as fallback.
2. Add the Windows UI Automation / `SendInput` helper and packaged smoke test.
3. Add a user-facing settings panel for dictionary editing, cleanup level, spoken confirmation, and local history export/deletion. The persisted keys are already bounded and compatible with that UI.
4. Run packaged macOS permission tests in Notes, Mail, Safari, Chrome, Slack, and a code editor after signing/notarisation.
