# Current Clyra browser audit (pre-Atlas rebuild)

## Entry

- UI: `src/components/WebBrowserWorkspace.tsx` (~2100 lines monolith)
- Engine: Electron `WebContentsView` (`electron/browser-manager.mjs`) or Playwright screenshot fallback
- Agent: `lib/openbrowser/browser-runtime.ts` via SSE `/api/openbrowser/assist`
- Product hide: `App.tsx` redirects `embedTool=browser|browse` → chat

## Visual problems vs Atlas

| Current | Problem |
| --- | --- |
| Tab strip `h-10` (40px) + toolbar `h-9` (36px) + status `h-7` | Chrome ≈104px+ (≈2× too tall) |
| Pill omnibox with lock/search always | Chrome-like resting address |
| Sidebar header “Clyra” + large page card | Oversized branded header |
| Plan checklist card + Pause/Stop/Takeover in panel | Dominates Ask panel |
| Sky/blue cursor glow + ripple | Wrong cursor language |
| White floating control bar with 3 buttons | Should be black Take control / Stop over page |
| Large welcome card / composer padding | Dashboard feel |

## Backend to preserve

- Tab / navigate / action APIs
- Assist SSE progress (`phase`, `cursor`, `plan`, `kind`)
- Control: pause / resume / take_control / return_control / stop
- Electron surface bound to visible preview host

## Event → new UI mapping

| Backend | New UI |
| --- | --- |
| task start / planning | Floating black bar + compact progress disclosure |
| cursor payload | Dark cursor + black tooltip at live coords |
| executing / verifying | Status sentence under disclosure |
| manualControl | Bar: You have control \| Return \| End |
| complete / fail / cancel | Sidebar summary; bar fades |
