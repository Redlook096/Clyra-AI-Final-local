# Clyra AI Suite Integration Audit

## Scope and baseline

This audit records the desktop architecture as it exists before the broader
assistant-suite work. Clyra is an Electron desktop application, not a Tauri
application: `electron/main.mjs` owns the native window, `electron/browser-manager.mjs`
owns persistent Chromium `WebContentsView` instances, and the React UI talks to
the local Express service in `server.ts`.

The packaged service uses the app-bundled Node runtime. `electron/main.mjs`
now disables eager Vibe M1 warm-up for packaged builds because that warm-up can
race macOS process cleanup and terminate the local service before the UI is
reachable. M1 still starts on demand through `/api/vibe/m1-launch` while the
existing Vibe welcome view remains visible.

## Confirmed integration points

| Capability | Existing implementation | Integration direction |
| --- | --- | --- |
| Chat and workspace routing | `src/App.tsx`, `src/components/AppLauncher.tsx` | Preserve current routes and transition shell. |
| Vibe Coder M1 / OpenHands | `src/components/VibeCoderWorkspace.tsx`, `/api/vibe/m1-launch` in `server.ts` | Keep the welcome screen, then attach the real M1 conversation only after launch returns a valid URL. |
| Browser | `src/components/WebBrowserWorkspace.tsx`, `electron/browser-manager.mjs`, `lib/openbrowser/browser-runtime.ts` | Retain one persistent native Chromium view per tab and observe with CDP at agent checkpoints. |
| Voice | `src/components/voice/VoiceCallOverlay.tsx`, `src/hooks/useVoiceCall.ts`, `backend/voice` | Keep the existing STT/TTS provider path; share recording/VAD state rather than creating another microphone service. |
| Screen share | `VoiceCallOverlay.tsx` uses `getDisplayMedia` | Keep user-approved capture only. A Cluely-style analysis assistant must be an explicit, visible session, not an always-on recorder. |
| Study | `src/components/StudyPalWorkspace.tsx` | Upgrade in place through source-grounded artifacts and local indexing. Do not create a duplicate public product. |

## Provider and security findings

Provider calls are currently distributed across `server.ts`, `backend/voice`,
and feature-specific helpers. Existing DeepSeek environment variables are used
server-side. No verified Qwen key, model identifier, or compatible endpoint was
found during this audit, so a Qwen path must not be enabled until it is configured
server-side and exercised with a real health check. Provider keys, browser
cookies, desktop capture frames, and local project paths must never be sent to
the renderer.

The next safe architectural increment is a server-only typed provider router
with explicit model selection, timeout, cancellation, usage receipts, and a
failure state. It should be adopted behind feature flags rather than replacing
working chat, voice, or M1 calls in one migration.

## Reference projects reviewed

The reference clones live outside the repository in `/tmp/clyra-ai-references`:

| Project | Revision | Licence | Allowed use in Clyra |
| --- | --- | --- | --- |
| browser-use | `2be09b6c5eb702a9287684b42b27e7042a1aba29` | MIT | CDP/DOM-first observation and action-loop reference. |
| OpenCluely | `dffdf1a8f7ccefe895fb8de928b177167df11d58` | Apache-2.0 | Visible screen-capture/session architecture reference only. |
| Skill-Anything | `4c83b8e73dccd897db6cecc1d5e6bbd987baf80a` | MIT | Skill lifecycle and explicit capability declaration reference. |
| UI-TARS-desktop | `c2ad42e3eb9b27830db41a3e6f51ca7179d9b168` | Apache-2.0 | Desktop action planning and structured observation reference. |

No reference-project source has been copied into Clyra. OpenCluely stealth,
interview-assistance, hidden recording, and provider installers remain excluded.

## Implementation sequence

1. Stabilise desktop service lifecycle and Vibe M1 on-demand launch.
2. Strengthen the existing browser action loop with evidence, retries, and
   explicit confirmation gates for consequential actions.
3. Upgrade Study Pal in place with source citations and local artifacts.
4. Add a provider router and typed tool registry behind feature flags.
5. Add reusable computer/screen-assistant primitives only after browser and
   permission flows have passing tests.

## Current limitations

* The existing browser agent can fail before a task starts; it needs a clear
  capability/connection receipt rather than a generic failure message.
* Vibe M1 startup is intentionally deferred in packaged mode, so its first
  launch is on-demand rather than pre-warmed.
* Screen capture is user initiated but has not yet been converted into a
  durable, permissioned artifact pipeline.
* There is no verified Qwen provider configuration in the current checkout.
