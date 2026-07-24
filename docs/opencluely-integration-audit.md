# OpenCluely Integration Audit

Date: 2026-07-21

## Baseline

Clyra runs a React/Vite frontend with an Express/Bun-compatible local service and an Electron 43 desktop shell. The desktop shell uses a `BrowserWindow` for Clyra UI and native `WebContentsView` instances for browser and Vibe preview surfaces. Provider credentials remain in the local service environment and are not passed into React.

Confirmed Clyra paths: `electron/main.mjs`, `electron/browser-manager.mjs`, `electron/surface-manager.mjs`, `server.ts`, `backend/voice/websocket/voice-stream-handler.ts`, `backend/creator-tts/service.ts`, `src/components/voice/VoiceCallOverlay.tsx`, and `src/hooks/useVoiceCall.ts`.

## Donor Audit

OpenCluely was cloned as an external, ignored source donor at `vendor-src/OpenCluely`, commit `dffdf1a8f7ccefe895fb8de928b177167df11d58` on `main`. It is an Electron application with capture in `src/services/capture.service.js`, session history in `src/managers/session.manager.js`, window management in `src/managers/window.manager.js`, and speech in `src/services/speech.service.js`.

The donor includes interview-cheating and concealment-oriented code paths, an Azure/Gemini-focused LLM stack, and Python/Whisper setup hooks. Those are explicitly excluded. Clyra will not import its process disguise, screen-share invisibility, hidden/always-on-top interview overlay behavior, onboarding, credential handling, or Whisper installer.

## Selective Port Direction

- Reuse the architectural pattern of a main-process capture service, but implement a Clyra-owned, user-visible capture permission flow.
- Reuse bounded session-history ideas, but preserve Clyra’s existing chat persistence and provider routing.
- Reuse neither donor UI nor branding.
- Keep Clyra’s Async TTS and local voice pipeline until a replacement has repeatable accuracy and latency evidence.
- Add no Python, PyTorch, Gemini, Azure, or donor dependencies as part of the port.

## Current Gaps

Screen sharing currently invokes the platform picker and displays a local preview. It intentionally does not claim model analysis because no verified visual-evidence transport exists yet. The existing voice fallback remains a local Python service, so the requested Python-free final voice pipeline is a future migration item, not a completed claim.
