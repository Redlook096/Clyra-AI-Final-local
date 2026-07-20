# Vivid voice implementation

The live call uses a server-held Async Voice session. Browser clients receive
only PCM audio packets and transcription events; the Async credential remains in
the server environment (`ASYNC_API_KEY`) and must never be exposed as a Vite
variable.

## Runtime flow

1. The browser captures mono PCM microphone audio and sends it to the existing
   authenticated local call socket.
2. The server opens a short-lived Async STT stream per utterance and forwards
   partial and final English transcripts to the client.
3. The response stream is segmented into semantic phrases and appended to a
   single warm Async TTS context using the configured Max voice.
4. Async PCM output is wrapped in the existing response/generation packet so
   playback, cancellation, and barge-in stay deterministic.

Creator narration uses the same Async voice through a server-side HTTP route.
The preview player awaits each audio element's `ended` event, so a fake text
story cannot advance to its next message before the current narration finishes.
Would You Rather awaits the first option before it reveals and narrates the
second option.

## Media controls

Voice calls have permission-gated camera and display capture controls. They are
local previews for the current call; tracks are stopped on call close, stop, or
the browser's screen-share-ended event. They do not claim to send video to an
AI model because this project currently has no configured vision-analysis
provider.

## Verification boundaries

TypeScript, creator, and voice unit tests are run in the repository. Camera,
microphone, screen-share permissions, and real upstream voice latency require a
user browser with device access and are intentionally not represented as fake
automated success results.
