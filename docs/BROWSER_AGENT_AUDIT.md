# Browser Agent Audit

Audited: 2026-07-23, before the advanced browser agent integration on
`feature/advanced-browser-agent`.

## Reference

- Browser Use repository: `https://github.com/browser-use/browser-use`
- Inspected commit: `40717057a3f46c403df360206c2784c840da3345`
- Local reference checkout: `/tmp/clyra-refs/browser-use` (not vendored)

## Existing Clyra browser system

| Piece | Location |
| --- | --- |
| Browser workspace UI | `src/components/WebBrowserWorkspace.tsx` |
| Agent runtime loop | `lib/openbrowser/browser-runtime.ts` |
| Native Chromium tabs | `electron/browser-manager.mjs` (WebContentsView per tab) |
| Auxiliary surfaces | `electron/surface-manager.mjs` |
| HTTP bridge + CDP | `electron/main.mjs` (bridge port 9224, CDP 9223) |
| Server route | `POST /api/openbrowser/assist` (SSE) in `server.ts` |

The runtime already controls the visible Electron browser through Playwright
`connectOverCDP` plus the authenticated HTTP bridge (`USE_ELECTRON_BROWSER`),
with a Playwright persistent-context fallback for non-Electron development.
The right-side chat panel owns the task input; progress arrives as SSE
`progress` / `complete` / `error` events.

## Why the agent could underperform before this work

1. **Single-action planning.** Each LLM call produced one action, so long
   tasks burned steps and stalled after the first navigation.
2. **No structured self-evaluation.** Steps did not carry an
   `evaluation_previous_goal` verdict, so failures were not recognised and
   the loop could report success after merely opening a page.
3. **Weak loop handling.** Repeated identical actions (for example a Google
   CAPTCHA interstitial) were not detected as loops; the task looked active
   forever.
4. **Completion without evidence.** `done` carried a model statement, not
   verified URL/title/check evidence.
5. **Cursor was decorative in places.** The overlay cursor moved from emitted
   cursor events, but there was no shared-event guarantee rendered in chat,
   and no action label or preview glow to make agent control visible.

## Integration decisions

Ported from Browser Use (as patterns, no Python source copied):

- Structured step output (`evaluation_previous_goal`, `memory`, `next_goal`,
  bounded multi-action batch).
- Batch termination guards (page/URL change, error, terminating actions).
- Consecutive-failure budget with a forced final `done(success=false)`.
- Action-repeat and page-stagnation loop nudges.
- Evidence-based completion (`url`, `title`, observed checks).
- Chat presentation: task goal card, collapsing plan checklist, per-step
  reasoning cards, one-line tool-call rows with expandable details, recovery
  cards, permission cards, completion summary card.

Rejected:

- Browser Use's Python runtime, DOM serializer, and LangChain-style stack
  (Clyra already has an equivalent TypeScript observation pipeline).
- Its user input bar and full demo UI (Clyra keeps its own input bar and
  design system).
- A second/hidden browser session (the agent must keep controlling the
  visible WebContentsView tabs).
