# Browser Use Integration

## Source

- Repository: `https://github.com/browser-use/browser-use`
- Commit inspected: `40717057a3f46c403df360206c2784c840da3345`
- Local reference: `/tmp/clyra-refs/browser-use` (not vendored into Clyra)

## Extracted

- Structured step schema (`evaluation_previous_goal`, `memory`, `next_goal`, action batch)
- Multi-action execution with sequence-terminating guards
- Consecutive-failure budget and forced final `done(success=false)`
- Action-repeat and page-stagnation loop nudges
- Evidence-based completion
- Compact chat presentation patterns (goal, plan, reasoning, tool rows, recovery, completion)

## Rejected

- Python runtime / LangChain stack
- Full demo UI and Browser Use input bar
- Hidden second browser session
- Shipping their DOM serializer wholesale (Clyra already observes via CDP/Playwright)

## Mapped into Clyra

| Browser Use idea | Clyra home |
| --- | --- |
| `Agent.run` / `multi_act` | `lib/openbrowser/browser-runtime.ts` |
| Demo side-panel cards | `AgentRunSection` in `WebBrowserWorkspace.tsx` |
| `done` + evidence | SSE `complete` payload (`success`, `evidence`) |
| Takeover / stop | Existing `/api/openbrowser/control` + UI controls |
