# Multimodal Architecture

```text
User-visible screen picker
  -> Electron capture service
  -> selected display/region image
  -> bounded local preprocessing and OCR
  -> structured visual evidence
  -> Clyra server-side provider router
  -> streamed chat/voice response
```

Every capture must carry an origin, timestamp, dimensions, permission state, and retention policy. Capture is off by default. The user must explicitly choose a display or region and can stop it at any time. Clyra must not capture or transmit frames in the background.

Voice remains:

```text
Microphone -> PCM16 -> local VAD/transcript pipeline -> Clyra server -> Async TTS -> output audio
```

The live screen preview is not treated as model context until the evidence transport is implemented and verified.
