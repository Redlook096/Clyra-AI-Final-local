# Agent Controller Architecture

## Purpose

The agent controller drives live, same-origin Clyra workspaces through a small semantic bridge. It is deliberately separate from rendered chat status so a completion claim requires observable workspace evidence.

## Control Loop

1. Persist a task, plan, action records, and current state in local storage.
2. Inspect `window.__CLYRA_AGENT_BRIDGE__` for route, workspace state, errors, and semantic controls.
3. Resolve a stable control id, scroll it into view, move the visible cursor to its mapped iframe position, and perform the real DOM action.
4. Wait for a semantic state transition, then record verification before advancing the plan.
5. On missing controls, timeouts, or workspace errors, stop with a recoverable error rather than reporting success.

## Bridge Contract

Workspaces expose `window.__CLYRA_AGENT_BRIDGE__.snapshot()`. The snapshot includes workspace and build state, visible controls, notifications, errors, and scroll position. Controls use stable `data-agent-id` values where a controller needs deterministic access. Password values are redacted in semantic snapshots.

## Vibe Coder Flow

The Vibe controller waits for the request textarea, types into it character by character, sends the request, waits for design approval, clicks the real approval control, and monitors the actual build bridge. It completes only when the workspace reports a ready preview or completed build. Pause, take-control, return-control, stop, retry, fullscreen, and collapsible activity are all task-state operations, not visual-only controls.

## Recovery and Limits

Tasks persist by chat-message and app-agent id. Returning control re-inspects the current workspace before continuing. Vibe M1 startup has a strict 45-second server deadline; stale M1 launcher parents are stopped before a fresh paired stack starts. A timeout is surfaced to the controller and user as a failure requiring retry, never as a completed build.

## Verification

`npm run lint` checks the TypeScript surface. `CLYRA_URL=http://127.0.0.1:3003 npm run test:browser` verifies the browser action runtime against a local interactive fixture. The Vibe flow should additionally be exercised in the live app after M1 reports ready from `/api/vibe/m1-status`.
