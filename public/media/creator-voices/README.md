# Creator voice previews

Place one WAV per voice here so the Creator Studio preview button does not regenerate TTS every time:

- `Ryan.wav`
- `Aiden.wav`
- `Aaron.wav`
- …matching each id in `CREATOR_VOICES`

Line spoken: **Hi, let's make a fake text story**

If a file is missing, the app falls back to `/api/creator/tts` and caches the result in memory for the session.
