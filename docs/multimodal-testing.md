# Multimodal Testing

## Completed

- Voice PCM streaming with the supplied M4A converted to 16 kHz mono produced the verified transcript: `Hi, how are you?`.
- Async TTS returned a valid PCM WAV response.
- Desktop native Chromium opened Google in light mode, accepted actual text input, submitted a search, and returned a semantic observation from the visible tab.
- `npm run lint`, `npm run test:voice`, `npm run test:agent-controller`, `npm run test:vibe-runtime`, and `npm run build` passed for the desktop baseline.

## Required Before Visual Analysis Is Declared Ready

- Capture a user-selected display and region.
- Produce an evidence receipt with OCR/vision result and no hidden frame loop.
- Verify capture stop/revoke behavior.
- Test macOS, Windows, Linux, and multiple monitors.
- Measure idle and active RAM on an 8 GB device.
