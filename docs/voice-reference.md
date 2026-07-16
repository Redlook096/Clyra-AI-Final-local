# Voice Reference Preparation

Clyra uses Chatterbox-Turbo as its primary English conversational voice. The
model is loaded once by the persistent worker and reused across calls.

Use only a recording made by a speaker who has consented to voice cloning.
Record 8-12 seconds of one person speaking naturally in the target accent. It
must contain no music, other speakers, clipping, long silence, strong room
reverb, heavy denoising, or aggressive compression. Never use output from the
old synthetic voice as a reference.

Prepare the selected reference once:

```bash
ffmpeg -i reference-source.wav -ac 1 -ar 24000 -c:a pcm_s16le backend/voice-reference/selected.wav
```

Configure production with:

```bash
VOICE_TTS_REFERENCE=backend/voice-reference/selected.wav
VOICE_TTS_ENGINE=chatterbox-turbo
VOICE_HARDWARE_PROFILE=quality-balanced
```

Keep at least three legal candidates for a blind listening test. Use the same
test set for every candidate and score naturalness, warmth, pronunciation,
pacing, consistency, and long-session comfort. Do not select on identity
similarity alone.

On CPU-only machines, leave `VOICE_HARDWARE_PROFILE=auto`. `/health` reports
the active engine, profile, degradation reason, load time, synthesis time,
audio duration, and real-time factor. A fallback is never reported as the
quality engine.
