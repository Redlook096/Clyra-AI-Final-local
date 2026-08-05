# Clyra Vibe Coder V5 — current implementation audit

Date: 2026-08-04

## Relevant implementation inventory

### `electron/main.mjs`

Responsibility: Electron application lifecycle, BrowserWindow, local service and native managers.

Current data source: Local Clyra Express service and Electron state.

Current UI state: Creates the app window and already instantiates `ChromiumSurfaceManager`.

Connected to real OpenCode data: No.

Problems: No Clyra OpenCode runtime manager, project/session IPC bridge, or shutdown ownership.

Action: REFACTOR.

### `electron/preload.cjs`

Responsibility: Context-isolated bridges for Browser, surfaces, dictation, Google and research.

Current data source: Narrow IPC invokes.

Current UI state: Does not expose Vibe/OpenCode operations.

Connected to real OpenCode data: No.

Problems: The renderer has no secure typed OpenCode bridge.

Action: REFACTOR.

### `src/App.tsx`

Responsibility: Application shell, boot animation, top-level Chat/Vibe/Clip tabs and legacy Vibe chat flow.

Current data source: Local storage and Clyra HTTP APIs.

Current UI state: Lazily mounts `VibeCoderWorkspace`; also retains a separate legacy simulated Vibe conversation path.

Connected to real OpenCode data: The mounted Vibe workspace is indirectly connected through HTTP; the legacy flow is not a reliable OpenCode event view.

Problems: The whole workspace uses a 720ms animation and the legacy Vibe path overlaps this architecture. The top-level rail is always visible after a switch.

Action: REFACTOR.

### `src/components/VibeCoderWorkspace.tsx`

Responsibility: Current Vibe welcome, composer, basic sidebar, conversation and placeholder workbench.

Current data source: `useVibeCoderWorkspace`.

Current UI state: Optimistically appends user messages locally, but only displays user messages and a restricted action list. Code, Changes, Terminal and Plan are placeholders.

Connected to real OpenCode data: Partial / indirect.

Problems: A static three-panel shell; no assistant history, no real diffs, no terminal surface, no persistent sessions, no permissions/questions and the user bubble uses `max-w-[92%]` rather than content width.

Action: REPLACE.

### `src/hooks/useVibeCoderWorkspace.ts`

Responsibility: Starts tasks through `/api/opencode/start`, opens a task-specific EventSource and stores partial local state.

Current data source: One-shot Clyra Express OpenCode routes plus localStorage.

Current UI state: Creates a task then subscribes, updates a Cline-shaped event model.

Connected to real OpenCode data: Partial, translated from CLI JSON rows.

Problems: Event subscription begins after the prompt process starts; sessions are task IDs rather than OpenCode sessions; it drops most message parts; it has no reconnection/deduplication; persistence omits event history and session IDs.

Action: REPLACE.

### `lib/opencode/opencode-routes.ts`

Responsibility: Starts `opencode run --format json` for a Clyra-owned workspace and translates selected output to SSE.

Current data source: CLI stdout, workspace file scan and in-memory task map.

Current UI state: HTTP task creation/status/events/cancel endpoints.

Connected to real OpenCode data: Yes, but via disposable CLI processes rather than the SDK/session API.

Problems: No durable session, no SDK health/project verification, no typed SSE normalisation, no permission reply, no session history, no per-project runtime state, and file changes are only scanned on process exit.

Action: REPLACE.

### `lib/vibe-coder/preview/*`

Responsibility: Development-server discovery and HTTP preview helpers.

Current data source: Local process probes.

Current UI state: `LivePreviewPanel` can display preview state.

Connected to real OpenCode data: No.

Problems: Preview state is coupled to task flow and has no native Vibe workbench ownership.

Action: REFACTOR.

## Send-operation trace and root causes

1. Composer text is owned by `promptInput` in `VibeCoderWorkspace`.
2. Send calls `handleSubmit`, which calls `startTask(prompt, false)`.
3. The button and Enter path call the handler; form submission is not used.
4. Send can be rejected because the button is disabled for empty text, but the more common visible failure is that a request starts with no usable event rendering.
5. A project path exists only as a generated Clyra data-directory project ID, not as a selected user project path.
6. The OpenCode runtime is not long-lived; a new CLI process is launched for every request.
7. `/api/opencode/status` only probes `opencode --version`; it does not health-check a server.
8. No OpenCode session is created; Clyra task IDs are used instead.
9. The prompt is passed to the CLI process, not to a session API.
10. The EventSource is opened after `/start` launches the CLI process, so early output can race the subscription.
11. Events are only received if the CLI emits compatible line-delimited JSON.
12. Events are scoped to a task ID, not an OpenCode session ID.
13. Most message parts are discarded or reduced to short status strings.
14. `VibeCoderWorkspace` only renders user messages, thinking text and a separate limited action list.
15. The conversation remains empty because assistant text is saved to `statusUpdates`, which is not rendered as assistant content.
16. The session is labelled failed because any route/process error maps to one `failed` stage, including preview-related errors.
17. Preview build failures do not have a dedicated build state and currently lack a real error/output renderer.
18. Yes: agent state and preview state are incorrectly combined through the single `stage` field.

## Required V5 correction

Use one managed loopback OpenCode SDK server/client with a durable SDK session per selected Clyra project, subscribe before sending, normalise all relevant parts, store events by project/session/part identity, and render assistant text, tool state, diffs and errors independently from preview build status.
