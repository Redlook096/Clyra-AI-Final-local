# PLAN — Clyra Atlas-style AI Browser

## Goal

Independent light Atlas-density browser UI on Clyra’s existing Chromium/agent stack.
No Atlas binaries or trademarks. Text-only agent via DOM/a11y/geometry.

## Engine strategy

**Priority 1 (chosen):** Keep Electron `WebContentsView` + CDP/Playwright on the visible tab.
Do not introduce BrowserOS as product foundation (AGPL) without commercial review.

## Implementation phases

1. Research + audit docs ✅
2. CSS tokens `--atlas-*`
3. Rebuild chrome: 30px tabs, 32px toolbar, quiet omnibox, Ask Clyra
4. Rebuild Ask panel: minimal header, bubbles, disclosure, composer
5. Rebuild overlays: dark cursor, tooltip, black agent bar
6. Re-enable `embedTool=browser` for QA
7. Visual regression screenshots vs reference proportions
8. Woolworths live agent smoke (when network allows)
9. Phase-2: tab groups, tab search, vertical tabs, memories UI, logged-out partition

## Acceptance (this PR)

- Chrome height ~62px
- Sidebar ~27%
- No large checklist / avatar / blue cursor by default
- Floating black Take control / Stop
- Real page still driven by openbrowser runtime
