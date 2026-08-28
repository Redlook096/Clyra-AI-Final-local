# Clyra Feature Inventory

Built from direct repository traversal (two independent passes: frontend/UI surface, backend/Electron surface), not assumption. Status reflects what was actually confirmed this session — via code reading, `tsc`/build checks, or live testing — not guesses.

## Reachability legend
- **Reachable** — a real user can get to this from AppLauncher, a slash command, or a global shortcut.
- **Orphaned** — fully implemented and wired into the render tree, but no UI path leads to it.
- **Dead** — zero imports anywhere; not part of the running app at all.

---

## Primary tools (AppLauncher wheel, `src/components/AppLauncher.tsx`)

| Tool | Entry | Frontend | Backend | Status |
|---|---|---|---|---|
| Vibe Coder | Launcher + default | `src/components/clyra-code/ClyraCodeWorkspace.tsx` | `@opencode-ai/sdk` via `lib/opencode/opencode-routes.ts` (17 endpoints), real PTY (`terminal:*` IPC) | **Reachable, real.** Genuine tool-calling agent, not a wrapper. |
| Chat | Launcher | `src/App.tsx` (inline) | `/api/clyra/chat`, `/api/deepseek/chat` (same handler) | **Reachable, real.** |
| Shorts Studio | Launcher | `src/components/ShortsStudioWelcome.tsx` | `/api/clipper/*` (~19 endpoints), `/api/creator/*` | **Reachable, real** for AI Clipper (tested live this session through all 3 wizard steps; blocked by YouTube bot-check on this sandbox at the download stage — environmental, not code). Fake Text Story / Would You Rather routed through `CreatorStudioWorkspace.tsx`, not independently tested this session. |
| AI Browser | Launcher | `src/components/WebBrowserWorkspace.tsx` + `BrowserStartPage.tsx` | `electron/browser-manager.mjs` (real `WebContentsView`, 13 IPC channels) / `lib/openbrowser/browser-runtime.ts` (Playwright web fallback, ~18 HTTP endpoints) | **Reachable, real.** Extensively tested and fixed this session (navigate speed, `canGoForward`, tab create/switch/close). E2E test suite passes (`tools/openbrowser-e2e.ts`, 30 assertions, LIVE_PASS). |
| **Screen Companion** | **Was orphaned — fixed this session** | `src/components/ScreenCompanionWorkspace.tsx` | `electron/companion-manager.mjs` + `companion-preload.cjs` (11 IPC channels, correctly scoped to the overlay's own window), `/api/companion/*` (6 endpoints) | **Now reachable.** Backend confirmed genuinely working (`tools/companion-unit-tests.ts` LIVE_PASS with a real Gemini vision call). Found and fixed a real bug in the ask fallback (see Release Blockers). |

## Reachable via slash command, not the launcher wheel

| Tool | Trigger | Frontend | Backend |
|---|---|---|---|
| Study | `/study` in composer | `src/components/StudyPalWorkspace.tsx` → `StudyPalWorkspaceNew.tsx` | `/api/study/*` (5 endpoints: ask, flashcards, notes, quiz, source fetch) — confirmed source-grounded |
| Gmail/Calendar/Docs/Sheets/Slides/Drive | `/gmail`, `/calendar`, etc. | `GoogleConnectSheet` (inline in `App.tsx:1491`) | `electron/google-workspace-manager.mjs`, `google:*` IPC (5 channels) — no HTTP routes, Electron-only |
| Voice Call | Composer mic button | `src/components/voice/*` | Real Pipecat STT→LLM→TTS pipeline (`backend/voice/`), Fish Audio TTS |

## Confirmed orphaned (built, wired, unreachable)

| Item | Why it's orphaned |
|---|---|
| **Clyra Forge** (game builder) | `src/components/forge/`. Deliberately removed from `AppLauncher`'s `tools` array with an explicit code comment explaining it's "kept ready to drop straight back in." **This is a documented, intentional decision, not a bug** — correctly excluded because (see Competitor Matrix) it has no AI-generation backend of its own, only project persistence borrowed from Vibe Coder's API. Recommend: leave excluded until it's genuinely built out, per the comment's own intent. |
| ~~Screen Companion~~ | Fixed this session — see above. |

## Confirmed dead code (zero imports, safe to remove per audit rule 46)

| File(s) | Notes |
|---|---|
| `src/components/OpenCodeVibeWorkspace.tsx` | Earlier Vibe Coder iteration, superseded by `clyra-code/ClyraCodeWorkspace.tsx`. Zero imports anywhere. |
| `src/components/VibeCoderWorkspace.tsx` (top-level) | Same — distinct from the real, used `clyra-code/` version. Zero imports. |
| `src/components/study-brain/` (StudyBrainWorkspace.tsx, BrainCanvas.tsx, StudyDock.tsx, `nodes/`) | ~145KB. An earlier/alternate Study implementation, superseded by `StudyPalWorkspaceNew.tsx`. Imported only from within its own directory — never from `App.tsx` or anywhere reachable. |

**Not removed this session** — flagging rather than deleting under time pressure, per rule "do not perform huge unrelated rewrites immediately before shipping." Recommend a dedicated cleanup pass.

## Backend surface summary (grouped)

- **HTTP routes**: ~95 in `server.ts` directly + 4 `registerXRoutes()` modules (`lib/cline/`, `lib/opencode/`, `lib/iphone/`, `backend/voice/`, `backend/creator-tts/`). Total ~150+ endpoints across Clipper, AI Browser, Vibe Coder (2 implementations — legacy Cline/M1 runtime at `/api/vibe/runtime` etc., and the current OpenCode-backed one), iPhone build pipeline, Study, Screen Companion, Research, Creator/TTS, Dictation cleanup, OpenPencil proxy, chat, usage ledger, health.
- **Electron IPC**: 59 `ipcMain.handle` channels across `browser:*` (13), `companion:*` (11), `dictation:*` (9), `google:*` (5), `memory:*` (6), `terminal:*` (4), plus preview/taskview/surface/research singles. All handled channels have a matching preload exposure somewhere (main `preload.cjs` or one of three satellite preloads — `companion-preload.cjs`, `dictation-preload.cjs`, `smart-toolbar-preload.cjs`); the apparent "unexposed companion/memory channels" in the main bridge are **intentional security scoping**, not bugs (confirmed by tracing `authorizeCompanion()`).
- **Real automated tests already exist** (not written this session, discovered and run): `test:companion` (LIVE_PASS today), `test:browser` (LIVE_PASS, 30 assertions), plus `test:voice*`, `test:clipper*`, `test:forge`, `test:study-brain`, `test:iphone:*`, `test:opencluely`, `test:windows-compat` and more — a real Playwright/tsx test suite, not absent. Only `test:companion` and `test:browser` were run this session due to time; the rest are a concrete next step, not a gap to fabricate results for.
- **`lint` is `tsc --noEmit`** — no ESLint config exists in this repo. Confirmed clean this session.
- **Clipper pipeline**: real `python3` subprocess (`spawnClipperPipeline`), streams NDJSON progress over the HTTP response — not mocked.

## Known environmental constraints for this audit (not code bugs)

- **DeepSeek account: `402 Insufficient Balance`** — confirmed via live server logs during testing. This blocks LIVE testing of anything ultimately routed through `DEEPSEEK_API_KEY` (Chat reasoning, Companion's LLM path, Clipper's highlight ranking) — these fall back to their designed offline paths, which is correct behavior, but full LIVE_PASS verification of the actual model output is blocked pending credits. Labeled honestly throughout rather than hidden.
- **YouTube/Google/Bing/DuckDuckGo bot-checks** on this sandboxed network — reproduced identically across three different search engines and yt-dlp, confirming it's an IP-reputation issue tied to this specific test environment, not Clyra's code. Previously confirmed (this session's history) absent on the real Electron app on a normal residential network.
