# Chat UI Architecture

## Scope

The chat experience remains in `src/App.tsx` so it can share the existing message, command, attachment, voice, and persistence flows. Chat-only visual rules live at the end of `src/index.css` beneath `.clyra-chat-page`; embedded workspaces and agent previews are intentionally outside that scope.

## State Ownership

- `chats` stores persistent conversation metadata and messages in `localStorage`.
- `currentChatId` and `messages` represent the active thread.
- `chatDrafts` persists a separate unsent composer value for each conversation plus a `new` draft.
- Composer state continues to own active tools, attachments, focus, and command-picker visibility.
- Scroll state is represented by near-bottom and user-intent refs, with `showScrollToLatest` exposed only when the user has moved away from the newest content.

## Layout

The chat shell retains the existing sidebar and product navigation. Chat uses a centred, constrained content column, a slim conversation header, a message thread, and a bottom composer. Assistant messages receive a compact Clyra mark; user bubbles stay within the same readable column.

## Streaming and Scroll

The existing streaming renderer remains the source of truth. It follows new content only while the reader is near the bottom. Manual upward scroll reveals the `Latest` control, which restores follow mode without forcing readers away from earlier content.

## Accessibility

Controls use semantic buttons and labels. Icon-only actions include accessible names and titles. The chat-scoped CSS preserves focus treatment and disables decorative motion under `prefers-reduced-motion`.

## Verification

Run:

```bash
npm run lint
npm run test:agent-controller
CLYRA_URL=http://127.0.0.1:3003 npm run test:browser
```

Manual chat checks: create a new chat, send and stream a message, open a previous chat with a saved draft, use copy/read-aloud actions, open the Apps picker, attach and remove a file, and scroll above a streaming response to verify the `Latest` control.

## Known Limitations

Server-backed chat streaming and attachment transport remain governed by the existing provider and API configuration. The UI preserves their error states rather than inventing a completion state when a backend is unavailable.
