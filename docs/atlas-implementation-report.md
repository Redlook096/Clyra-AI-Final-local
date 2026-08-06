# Atlas-style Clyra Browser — implementation report

## Architecture

- **UI shell:** `src/components/WebBrowserWorkspace.tsx` (Atlas chrome + Ask Clyra panel)
- **Tokens:** `--atlas-*` in `src/index.css`
- **Browser host:** Electron `WebContentsView` when available; Playwright Chromium persistent context otherwise (same visible tab / frame)
- **Agent:** existing `/api/openbrowser/assist` SSE + control APIs (pause / take_control / stop)

Independent of Atlas binaries/services (Atlas EOL 9 Aug 2026).

## Visual acceptance (measured @ 1440×900)

| Criterion | Status |
| --- | --- |
| Titlebar 30px + toolbar 32px = 62px | **Complete** |
| Sidebar ~26.5–27% / page ~73% | **Complete** |
| Quiet resting domain omnibox | **Complete** |
| Compact Ask Clyra | **Complete** |
| Minimal sidebar header | **Complete** |
| Pale user bubble / unboxed assistant | **Complete** |
| Compact progress disclosure | **Complete** |
| Black Take control / Stop bar | **Complete** (live when agent busy; also `?browserDemo=agent`) |
| Dark cursor + black tooltip | **Complete** (same) |
| No blue cursor glow / oversized composer | **Complete** |

## Functional acceptance

| Criterion | Status |
| --- | --- |
| Real Chromium page (not iframe mock) | **Complete** |
| Same-tab agent control path | **Complete** (backend preserved) |
| Woolworths live agent e2e | **Blocked** — `DEEPSEEK_API_KEY` in env is invalid (`sk-test…`) |
| Tab groups / tab search / vertical tabs | **Unsupported** (phase 2) |
| Logged-out agent partition | **Partial / blocked** |
| BrowserOS as foundation | **Unsupported** (AGPL — reference only) |

Visual overlay QA without a valid LLM key: `/?embedTool=browser&browserDemo=agent` (real page + Atlas overlays; not a substitute for live agent auth).

## Screenshots

- `/opt/cursor/artifacts/screenshots/atlas/compare-agent-overlays-1440.png`
- `/opt/cursor/artifacts/screenshots/atlas/compare-idle-chrome.png`
- `/opt/cursor/artifacts/screenshots/atlas/after-sidebar-1440.png`
