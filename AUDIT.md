# Clyra Architecture And Ecosystem Audit

Date: 2026-07-21
Branch: `codex/vibe-runtime-rebuild`
Baseline checkpoint: `096fd9f0 checkpoint: preserve web app before Tauri migration`

## Executive summary

Clyra is a real multi-workspace application, not a static demonstration. Chat, Vibe Coder, Browser, Clip, Study Pal, Creator Studio, and Voice all have working execution paths. The repository nevertheless behaves like several products sharing one React shell: provider calls, storage, retries, permissions, progress, and long-running jobs are implemented separately in each workspace.

The desktop shell has now moved from the previous Tauri/WebView experiment to Electron. The application UI runs in one sandboxed `WebContentsView`; each browser tab and Vibe preview runs in a persistent native Chromium `WebContentsView`. The visible browser is the page controlled through Electron's CDP debugger, so there is no iframe, screenshot stream, off-screen renderer, or second hidden browser in the Electron browser path.

The next structural work should not begin by adding Flow, Skills, or Memory screens. It should first establish a shared server-side runtime for providers, tools, permissions, durable jobs, artifacts, and receipts. Feature flags and storage migrations must keep the current workspaces usable while that foundation is introduced.

## Audit scope and method

The audit covered the application shell, workspace components, Express routes, Electron process, Vibe agent adapters, native preview lifecycle, browser runtime, creator and media workers, voice pipeline, local persistence, model configuration, scripts, and tests.

Repository indicators at this checkpoint:

- About 380 source/configuration files discovered by `rg --files`.
- About 209 TypeScript/TSX files and 41 Python files.
- About 55,830 lines across the primary frontend, backend, tool, and type directories.
- The largest ownership risks are [src/App.tsx](src/App.tsx), [src/components/VibeCoderWorkspace.tsx](src/components/VibeCoderWorkspace.tsx), [src/components/CreatorStudioWorkspace.tsx](src/components/CreatorStudioWorkspace.tsx), [src/components/StudyPalWorkspace.tsx](src/components/StudyPalWorkspace.tsx), and [lib/openbrowser/browser-runtime.ts](lib/openbrowser/browser-runtime.ts).

This report distinguishes confirmed code paths from conclusions. A visible control is not counted as functional unless its event path reaches a real operation and returns observable state.

## Current architecture

```text
Electron BaseWindow
├── sandboxed UI WebContentsView
│   └── React/Vite application
│       ├── Chat and launcher shell
│       ├── Vibe Coder
│       ├── AI Browser chrome
│       ├── AI Clip
│       ├── Study Pal
│       ├── Creator Studio
│       └── Voice UI
├── persistent browser WebContentsViews (persist:browser)
├── persistent Vibe preview WebContentsViews
└── local Clyra service sidecar
    ├── Express API and WebSocket server
    ├── provider calls
    ├── Vibe agent adapters and project filesystem
    ├── Playwright/CDP browser agent bridge
    ├── Python voice worker
    └── Python/FFmpeg clip pipeline
```

The desktop entry point is [electron/main.mjs](electron/main.mjs). It creates a `BaseWindow`, adds the UI view, starts the local service, registers an authenticated IPC surface, and owns native browser/preview surfaces. [electron/preload.cjs](electron/preload.cjs) exposes a narrow asynchronous API. Remote webpages use `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`, and the isolated `persist:browser` session.

[electron/browser-manager.mjs](electron/browser-manager.mjs) owns persistent tabs, history, downloads, cookies, permissions, zoom, find, crash recovery, native shortcuts, CDP inspection, real input dispatch, the AI cursor, and the active-agent border. Tabs are hidden and shown rather than recreated. [electron/surface-manager.mjs](electron/surface-manager.mjs) applies the same native-surface model to Vibe previews.

[server.ts](server.ts) is the central local service and route composition root. It also contains provider calls and business logic that should ultimately move into focused services. [src/App.tsx](src/App.tsx) is the frontend composition root and currently owns substantial chat, navigation, settings, startup, and persistence behavior.

## Workspace map

### Chat

- Main state and message flow: [src/App.tsx](src/App.tsx).
- Voice/session integration: [src/hooks/useVoiceCall.ts](src/hooks/useVoiceCall.ts), [backend/voice](backend/voice).
- Chat API: `handleClyraChat` and `/api/clyra/chat` in [server.ts](server.ts).
- Conversation history, drafts, feedback, and several settings are stored in browser `localStorage`.
- Web and YouTube commands call real research endpoints, but tool routing is not yet a shared registry.

### Vibe Coder

- Main interface: [src/components/VibeCoderWorkspace.tsx](src/components/VibeCoderWorkspace.tsx).
- App-shell integration and recent projects: [src/App.tsx](src/App.tsx), [src/hooks/useVibeCoderWorkspace.ts](src/hooks/useVibeCoderWorkspace.ts).
- Runtime and checkpoints: [lib/vibe-runtime/runtime.ts](lib/vibe-runtime/runtime.ts).
- Planning and code orchestration: [lib/agent/plan-mode-orchestrator.ts](lib/agent/plan-mode-orchestrator.ts), [lib/agent/code-mode-orchestrator.ts](lib/agent/code-mode-orchestrator.ts), [lib/agent/tool-router.ts](lib/agent/tool-router.ts).
- M1/OpenHands path: [lib/openhands/m1-launch.ts](lib/openhands/m1-launch.ts), [lib/openhands/m1-stack.ts](lib/openhands/m1-stack.ts), [lib/openhands/openhands-process.ts](lib/openhands/openhands-process.ts).
- Cline compatibility path: [lib/cline](lib/cline).
- Preview management: [lib/vibe-coder/preview/preview-runner.ts](lib/vibe-coder/preview/preview-runner.ts), [src/components/vibe/VibeLivePreviewPanel.tsx](src/components/vibe/VibeLivePreviewPanel.tsx).
- Projects and generated files are stored under the Clyra data root by [lib/runtime-paths.ts](lib/runtime-paths.ts); chat/session metadata is split between files and `localStorage`.

The runtime can inspect, create, edit, execute, validate, checkpoint, and reopen projects. It also still contains overlapping OpenHands, Cline, local fallback, and scripted presentation paths. Those paths need one explicit routing policy before adding parallel agents.

### AI Browser

- Browser UI: [src/components/WebBrowserWorkspace.tsx](src/components/WebBrowserWorkspace.tsx).
- Electron native browser: [electron/browser-manager.mjs](electron/browser-manager.mjs).
- Server-side observation/planning/verification: [lib/openbrowser/browser-runtime.ts](lib/openbrowser/browser-runtime.ts).
- React/native bridge: [src/components/ElectronWebContentsSurface.tsx](src/components/ElectronWebContentsSurface.tsx), [src/lib/electron-runtime.ts](src/lib/electron-runtime.ts).

In Electron, a page is rendered directly by Chromium in a persistent `WebContentsView`. CDP inspection and input target that same visible renderer. Routine screenshots are disabled; screenshots remain an explicit fallback for canvas or visual-only content. Agent input is verified after meaningful actions. The active border is injected into the native page and removed outside active states, so it neither captures input nor drives React animation frames.

### AI Clip

- Interface: [src/components/AIClipper.tsx](src/components/AIClipper.tsx).
- Upload/start/download routes: [server.ts](server.ts).
- Pipeline: [clipper-pipeline.py](clipper-pipeline.py).
- Drafts/results use `localStorage`; rendered media uses the Clyra data directory.

The pipeline performs real file work. The requested WhisperX, scene detection, tracking, candidate-cache reuse, and evidence-based scoring are not all present as a single verified production pipeline yet.

### Study Pal

- Main workspace and local persistence: [src/components/StudyPalWorkspace.tsx](src/components/StudyPalWorkspace.tsx).
- Source retrieval and grounded answers: `/api/study/fetch` and `/api/study/ask` in [server.ts](server.ts).
- YouTube/web helpers: [lib/research/research-handlers.ts](lib/research/research-handlers.ts).

Study Pal has real node interactions and grounded answer routes. Its source ingestion is narrower than the requested MarkItDown-based document system, and shared citations/artifacts are not yet available across all workspaces.

### Creator Studio

- Main workspace: [src/components/CreatorStudioWorkspace.tsx](src/components/CreatorStudioWorkspace.tsx).
- Project state: [src/lib/creatorProject.ts](src/lib/creatorProject.ts).
- Generation/transcode routes: [server.ts](server.ts).
- TTS service: [backend/creator-tts/service.ts](backend/creator-tts/service.ts).

Message Story, Would You Rather, and story creation are real modes. They do not yet share the complete timeline/editor and verified render pipeline described in the roadmap.

### Voice

- Frontend session control: [src/hooks/useVoiceCall.ts](src/hooks/useVoiceCall.ts).
- Node session manager and WebSocket flow: [backend/voice](backend/voice).
- Local Python STT/TTS/VAD worker: [backend/voice-pipeline](backend/voice-pipeline).
- Async TTS integration: [backend/voice/async/async-voice-session.ts](backend/voice/async/async-voice-session.ts).

Voice has real media and provider paths. Heavy workers currently participate in normal development startup more eagerly than is desirable for an 8 GB machine.

## Request and execution flows

### Normal chat

```text
composer -> App chat state -> POST /api/clyra/chat
-> DeepSeek-compatible provider request -> streamed/parsed response
-> chat state/localStorage -> assistant reveal and actions
```

### Vibe Coder

```text
welcome prompt -> create/open project -> choose M1/Cline/local route
-> gather project context -> optional plan.md -> agent tool actions
-> write files / execute commands -> validate -> start preview
-> native preview WebContentsView -> browser observation/QA -> session persistence
```

The intended think/act/observe loop exists in the M1/OpenHands and agent orchestrator paths, but fallback builders and presentation timing can still make some runs look more agentic than their underlying action depth.

### AI Browser

```text
browser prompt -> /api/openbrowser/assist -> inspect visible Electron tab through CDP
-> model-generated typed plan -> stable target resolution
-> CDP/native input on same visible tab -> re-observe -> verify/retry
-> evidence and final browser session receipt
```

## Provider inventory

Provider routing is currently duplicated.

- Creator, Study, Chat, OpenPencil compatibility, and Vibe planning call DeepSeek-compatible APIs directly in [server.ts](server.ts).
- Browser planning has its own OpenAI-compatible client in [lib/openbrowser/browser-runtime.ts](lib/openbrowser/browser-runtime.ts).
- Voice has separate configuration and streaming clients in [backend/voice/config.ts](backend/voice/config.ts) and [backend/voice/websocket/voice-stream-handler.ts](backend/voice/websocket/voice-stream-handler.ts).
- OpenHands and Cline each select providers independently in [lib/openhands](lib/openhands) and [lib/cline](lib/cline).
- Async Flash is used for TTS and optional STT.
- No confirmed production Gemini multimodal/grounded-search router was found.

Hard-coded or legacy model defaults include `deepseek-reasoner`, `gpt-4.1-mini`, `gpt-4o-mini`, and an older Claude identifier. Model names and availability need configuration validation rather than silent fallback.

Provider keys are kept server-side, which is correct. The shared `ProviderRouter` must preserve that boundary, record model/cost/latency/retries, support cancellation and circuit breakers, and never silently upgrade to a more expensive model.

## Persistence and memory

Persistence is fragmented:

- Chat history, drafts, feedback, launcher state, and settings: browser `localStorage` in [src/App.tsx](src/App.tsx).
- Vibe projects, generated files, plans, checkpoints, and metadata: filesystem under `clyraDataPath(...)`.
- Study Pal workspaces: `localStorage` in [src/components/StudyPalWorkspace.tsx](src/components/StudyPalWorkspace.tsx).
- Clip drafts/results: `localStorage` in [src/components/AIClipper.tsx](src/components/AIClipper.tsx).
- Creator projects: `localStorage` in [src/lib/creatorProject.ts](src/lib/creatorProject.ts).
- Browser profile: Electron user-data JSON plus Chromium's persistent session.
- Voice sessions: primarily in memory.

There is no shared SQLite source of truth, FTS5 index, semantic retrieval layer, durable cross-workspace job engine, artifact bus, or user-editable memory system yet. Those capabilities must be introduced with migrations; replacing all existing storage in one pass would risk data loss.

## Real, partial, and simulated behavior

Confirmed real:

- Native Chromium navigation, typing, scrolling, tabs, cookies, downloads, history, zoom, permissions, inspection, and same-visible-tab agent control.
- Vibe project creation, filesystem edits, terminal execution, checkpoints, validation, preview startup, and project reopening.
- Study source fetch/answer calls and research endpoints.
- Creator generation/transcode/TTS calls.
- Clip upload and local pipeline execution.
- Voice WebSocket sessions and local/provider media paths.

Partial or duplicated:

- Vibe has multiple agent backends and fallback builders without one authoritative capability contract.
- Browser permission and sensitive-action checks exist but are not a product-wide `PermissionService`.
- Workspace progress/event streams are real in places but use different schemas and lifecycle rules.
- Browser evidence is structured, but a common final receipt format is absent.
- Cross-workspace handoff is mostly direct UI/API wiring rather than typed artifacts.

Presentation-only or potentially misleading:

- [lib/vibe-coder/harness/scripted-feel-detector.ts](lib/vibe-coder/harness/scripted-feel-detector.ts) deliberately adds timing intended to simulate thinking/writing. Presentation pacing must never be reported as work and should ultimately be removed or driven only by real events.
- Several orchestrators and UI components contain fixed delays. Some are legitimate transition timing; others need an honest-state review.
- Local fallback templates can produce repetitive small projects even when the UI presents a general coding agent.
- A timer completing a progress state is not proof of build, render, browser action, or validation.

## Security findings

### High priority

1. The local Express service currently exposes powerful routes from one process. Desktop production should bind only to loopback and require a random per-launch capability token for all state-changing routes, not only the Electron browser bridge.
2. Electron CDP listens on a predictable loopback port. The internal browser bridge has a random bearer token, but raw CDP should use an ephemeral port or a restricted connection mechanism to reduce local-process exposure.
3. Study URL checks reject obvious private hosts but do not fully resolve DNS and revalidate every redirect. That leaves DNS rebinding and redirect-based SSRF risk.
4. Vibe terminal execution uses shell-capable paths. Commands need a workspace boundary, explicit permission class, timeout, output limit, and confirmation for consequential operations.

### Medium priority

- Browser/project/profile data is plaintext; sensitive records should use OS-keychain-backed encryption.
- Skills do not yet have process isolation, network/filesystem scopes, signatures, or install-time review.
- No shared secret-redaction and activity-log service covers every workspace.
- Large ignored local caches, generated projects, virtual environments, profiles, and a nested repository increase disk and accidental-scan risk even though they are not shipped as tracked source.

### Dependency status

`npm audit` currently reports 23 advisories: 5 low, 17 moderate, 1 high, 0 critical. The high advisory is in the Vite 6 development server range; several moderate advisories arrive through Cline/OpenTelemetry and Monaco/DOMPurify dependency chains. Remediation must be targeted and tested. A forced audit upgrade is not acceptable because it could downgrade or break the coding-agent stack.

## Performance findings

The Electron native browser removed the major frame-transfer and remount costs of the prior WebView/screenshot experiments.

Measured development samples on this machine:

- Same-visible-tab typed browser action plus observation: about 0.88 seconds before routine screenshot removal.
- Native tab switch after screenshot removal: about 0.38 seconds.
- New external tab load plus observation: about 1.11 seconds.
- The old routine screenshot path could block an action for about 10 seconds.
- Local service health was reachable about 0.12 seconds after the measured development launch interval began.
- Development-process RSS after seven seconds was about 812 MiB, dominated by the TSX development service at about 521 MiB. Electron main/GPU/utility processes accounted for roughly 172 MiB combined; the voice Python worker was about 54 MiB.

These are development samples, not production cold-start claims. A signed packaged build must be measured separately. The most immediate 8 GB improvements are:

- Lazy-start and idle-unload voice, transcription, tracking, and media workers.
- Keep one Chromium runtime and bound inactive tabs.
- Avoid eager simultaneous M1 and media warmup.
- Move chat history and workspace retrieval away from large in-memory/localStorage blobs.
- Split large React ownership units and prevent whole-shell rerenders.
- Add Low resource, Balanced, and Maximum quality policies with measurable worker limits.

## UI and desktop findings

- The app launcher now uses transform/opacity transitions without scaling the entire desktop shell. Native browser surfaces are hidden while the launcher is open so they cannot occlude the overlay.
- The boot screen starts from zero, advances through real startup milestones, reaches a complete bar with `Clyra is ready`, then fades to an already-rendered Chat screen.
- The Clyra orb retains its front blur and blue ring edge. This remains CSS/DOM rendering in the trusted application view, not a browser-page modification.
- Browser Google color preference is forced to light before navigation through CDP media emulation. The secure indicator uses the same grey icon language as the browser chrome.
- The native active-agent edge uses compositor-only transforms, respects reduced motion, and is present only during real active browser-agent states.

## Test baseline

Passing at this checkpoint:

- TypeScript: `npm run lint`.
- Production frontend/server build: `npm run build`.
- Agent controller: 5 assertions.
- Vibe runtime: 9 assertions.
- Browser end-to-end suite: 30 assertions when the local service is running.
- Creator: 60 assertions.
- Clip: 34 assertions.
- Voice: 15 assertions.

Important gaps:

- No automated Electron `WebContentsView` integration suite for persistence, crash recovery, permissions, downloads, and same-visible-tab CDP.
- No full Chat behavior/visual regression suite.
- No Study Pal source-citation/export suite.
- No restart/resume and idempotency suite for long-running jobs.
- No Flow, Skills, Memory, or Computer Agent tests because those systems do not yet exist.
- No packaged-build memory, startup, resize-latency, or frame-rate budget in CI.

## Migration plan

### Batch 1: finish and checkpoint the Electron desktop foundation

- Validate the production package and sidecar.
- Keep all native browser and preview surfaces persistent.
- Add Electron integration tests and production performance measurements.
- Remove remaining inactive Tauri artifacts and document rollback to `096fd9f0`.

### Batch 2: shared runtime contracts behind feature flags

- Add typed `ProviderRouter`, `ToolRegistry`, `PermissionService`, `AgentRun`, artifact schemas, evidence, and receipts.
- Route one low-risk flow at a time through the new runtime while preserving existing APIs.
- Add telemetry with redaction and cancellation.
- Introduce a versioned SQLite database and migration runner.

### Batch 3: durable jobs and local memory

- Implement a bounded SQLite job engine with idempotency keys and restart recovery.
- Add FTS5 lexical retrieval first.
- Add optional `sqlite-vec` only after platform packaging and license validation.
- Migrate conversation/project metadata incrementally; retain import/rollback paths.
- Add OS-keychain-backed encryption for sensitive local records.

### Batch 4: Clyra Flow

- Build typed sequential flows first: Website Repair, Research to Study Pack, and Idea to Working App.
- Reuse existing real workspace operations and artifacts.
- Add pause, retry, skip, edit remaining steps, approval gates, and final receipts.
- Add bounded parallelism only after restart, cancellation, and idempotency tests pass.

### Batch 5: Clyra Skills

- Adopt the official MCP TypeScript SDK and registry-compatible manifests.
- Add isolated workers, brokered APIs, permission scopes, dependency/license scans, signatures, rollback, and activity history.
- Keep OpenPencil internal; expose design assistance as Vibe Design Mode rather than a public standalone workspace.

### Batch 6: workspace upgrades

- Chat: shared runtime, citations, attachment ingestion, memory controls, verified `Do it` runs.
- Vibe: one authoritative agent policy, Tree-sitter project map, impact graph, mandatory validation/review, browser repair loop.
- Browser: expand integration tests and permission receipts; retain the native same-visible-tab Chromium architecture.
- Clip: cached transcript/scene/tracking pipeline and verified FFmpeg outputs.
- Study Pal: sandboxed MarkItDown ingestion, evidence-level citations, source viewer, and exports.
- Creator Studio: shared timeline and verified render pipeline.
- Voice: lazy worker lifecycle, interruption, chunk completion, cleanup, and provider-failure tests.

### Batch 7: Computer Agent

- Begin only after Browser reliability and the product-wide permission service are complete.
- Use macOS AX, Windows UI Automation, and Linux AT-SPI before OCR.
- Require per-app permissions, sensitive-action confirmation, emergency stop, step budgets, and receipts.

## Ten files to understand first

1. [src/App.tsx](src/App.tsx)
2. [server.ts](server.ts)
3. [electron/main.mjs](electron/main.mjs)
4. [electron/browser-manager.mjs](electron/browser-manager.mjs)
5. [lib/openbrowser/browser-runtime.ts](lib/openbrowser/browser-runtime.ts)
6. [src/components/VibeCoderWorkspace.tsx](src/components/VibeCoderWorkspace.tsx)
7. [lib/vibe-runtime/runtime.ts](lib/vibe-runtime/runtime.ts)
8. [lib/agent/code-mode-orchestrator.ts](lib/agent/code-mode-orchestrator.ts)
9. [lib/openhands/m1-launch.ts](lib/openhands/m1-launch.ts)
10. [backend/voice/session/voice-session-manager.ts](backend/voice/session/voice-session-manager.ts)

## Highest-priority actions

1. Secure the local service and CDP boundary with loopback-only binding and per-launch capabilities.
2. Package and benchmark the Electron sidecar; add native-surface integration tests.
3. Create shared runtime contracts and telemetry before implementing Flow UI.
4. Add versioned SQLite persistence and durable jobs with restart/idempotency tests.
5. Remove simulated agent pacing and consolidate Vibe's overlapping execution paths.

## Rollback

The web application immediately before the desktop structural work is preserved at commit `096fd9f0`. The Electron migration should receive its own checkpoint after package validation. Feature-flagged shared-runtime work must start only after that checkpoint so it can be reverted independently without discarding the native-browser improvements.

## Unanswered questions

- Distribution signing identities, update channel, and supported minimum OS versions are not defined in the repository.
- Production provider entitlements for the requested DeepSeek V4 and Gemini model names cannot be inferred from source alone.
- The intended retention policy for conversations, browser history, recordings, and generated media is not documented.
- Performance acceptance thresholds beyond the general 8 GB target need explicit numeric budgets for packaged builds.
- Public skill registry moderation, signing authority, and commercial licensing policy need product decisions before community installation is enabled.
