# Browser Agent Permissions

## Requires confirmation (`ask_user`)

- File upload / download
- Sending personal information or messages
- Publishing, purchases, payments, subscriptions
- Account changes and irreversible deletes

When confirmation is required the agent pauses, shows a compact permission
card in chat, and resumes only after the user replies through the existing
reply path.

## Never exposed

- Passwords, auth tokens, recovery codes, private keys
- Browser password-store contents

Users enter sensitive authentication manually after Take Control.

## Controls

| Control | Behaviour |
| --- | --- |
| Pause | Stops the loop, preserves task state |
| Resume | Continues from the last verified step |
| Stop | Cancels the task |
| Take Control | Cancels pending input events, stops cursor/typing, returns mouse and keyboard immediately |
