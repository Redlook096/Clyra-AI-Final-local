# Browser Agent Architecture

## Loop

```
USER TASK (existing chat input)
→ UNDERSTAND GOAL + SUCCESS CRITERIA
→ OBSERVE VISIBLE PAGE (tabs, URL, title, DOM, interactive map)
→ LLM DECISION: evaluation + memory + next_goal + actions[1..5]
→ EXECUTE BATCH IN VISIBLE BROWSER (abort on nav/error/terminating action)
→ VERIFY EACH ACTION → EMIT SSE PROGRESS
→ RECOVER / REPLAN on failure or loop detection
→ CONTINUE UNTIL done(success, evidence)
→ SHOW COMPLETION CARD WITH URL / TITLE / CHECKS
```

## Ownership

| Concern | Owner |
| --- | --- |
| Visible Chromium tabs | `electron/browser-manager.mjs` |
| CDP + authenticated bridge | `electron/main.mjs` |
| Agent loop + observation | `lib/openbrowser/browser-runtime.ts` |
| SSE assist route | `POST /api/openbrowser/assist` in `server.ts` |
| Chat cards + glowing cursor | `src/components/WebBrowserWorkspace.tsx` |
| User input bar | Unchanged composer at the bottom of the aside |

## Event contract (additive)

Progress events may include:

- `kind`: `reasoning` | `recovery` | `strategy` | action phases
- `evaluation`, `memory`, `nextGoal`
- `actionIndex`, `actionCount`
- `success`, `evidence: { url, title, checks[] }`

## Safety

Pause, Resume, Stop, and Take Control remain live controls that cancel
pending input, stop cursor motion, and hand the page back to the user.
Permission-sensitive actions continue to pause through `ask_user`.
