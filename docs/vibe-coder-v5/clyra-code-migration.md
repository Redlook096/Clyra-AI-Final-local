# Clyra Code — Vibe Coder replacement migration

New workspace: `src/components/clyra-code/` (mounted by `App.tsx` in place of
`VibeCoderWorkspace`). The OpenCode harness, all APIs, project storage and
preview backend are unchanged.

## Harness reference (unchanged, reused)

| Concern | Route |
|---|---|
| Runtime start | `POST /api/opencode/runtime/start` |
| Live events (SSE) | `GET /api/opencode/events/:projectId` |
| Session create / prompt / abort | `POST /api/opencode/sessions`, `…/prompt`, `…/abort` |
| Session history (reload restore) | `GET …/messages` |
| Diffs | `GET …/diff` → `FileDiff[]` |
| Permissions | `POST …/permissions/:permissionId` |
| Projects | `GET/POST /api/vibe/projects` |
| Preview | `POST /api/vibe/preview/start|restart`, `GET …/status/:id`, `GET …/logs/:id` |
| Model/status | `GET /api/opencode/status` (now also returns `model`) |

## Event mapping (SSE → UI)

| Harness event | UI |
|---|---|
| `message.part.updated` + `text` part | assistant work-log entry (unboxed markdown) |
| `message.part.updated` + `reasoning` part | "Thought for Ns" line |
| `message.part.updated` + `tool` part | `AgentActionRow`, updated in place by `session:message:part` id |
| tool `state.status` pending/running/completed/error | `queued → active → success/error` |
| `write`/`edit`/`delete` tool completed | diff refetch → live `+/−` counters |
| `permission.updated` / `permission.replied` | inline approval row with Allow / Always / Deny |
| `session.status busy` | Thinking indicator (existing `ShiningText` + dots) |
| `session.idle` | run complete → changed-files summary |
| `session.error` | inline failure row |

## Reused components

- `src/components/ShiningText.tsx` (`ShiningText`, `ShiningBrainIcon`,
  `ThinkingDots`) — the existing thinking animation, untouched.
- `src/components/MarkdownMessageContent.tsx` — assistant markdown.
- CSS keyframe `clyra-text-shine` — shared by the new `.cc-shimmer` masked
  text shimmer for active action targets.

## Superseded (kept until fully retired)

- `src/components/VibeCoderWorkspace.tsx` (old UI, no longer mounted)
- `src/components/OpenCodeVibeWorkspace.tsx` (alternate skin, never mounted)
- `src/hooks/useVibeCoderWorkspace.ts` (replaced by
  `src/components/clyra-code/store.ts`; still imported by the two files above)

Remove these once no other surface depends on them.

## Backend changes (minimal, additive)

- `lib/opencode/opencode-routes.ts`: `/api/opencode/status` also returns the
  configured `model` so the composer can show the real model name.
- `vite.config.ts`: watch-ignore `**/*.py`, `output/`, `tmp/`,
  `test-results/`, `playwright-report/`. Background processes rewrite these
  files and each change forced a full page reload that killed live sessions.

## State migration risks

- Old saved sessions (`vibe-coder-project-sessions` localStorage +
  `.agent/workspace-session.json`) are not read by the new UI. Sessions are
  instead restored from the OpenCode messages endpoint
  (`clyra-code:last-session` localStorage key stores project + session ids).
- Undo/revert is intentionally absent: Clyra does not expose OpenCode's
  revert routes, so no Undo button is rendered.
- `/api/vibe/start|pause|resume|approve` (legacy M1/Cline runtime) is not
  used by the new UI.
