# Clyra Clipper Audit

## Current flow

`src/components/AIClipper.tsx` owns the four-step UI and starts
`POST /api/clipper/start` in `server.ts`. The route invokes
`clipper-pipeline.py` as a child process and streams JSON progress / clip
results back to the UI. The pipeline imports public YouTube sources through
`pytubefix` with a `yt-dlp` download fallback, reads platform captions where
possible, and uses `faster-whisper` or OpenAI Whisper for exact timestamps
**after** each clip is cut.

The upgraded analysis path is sequential and cache-backed:

1. resolve source + metadata → `source-metadata.json`
2. normalise caption/transcript words → `transcript-words.json`
3. derive speech regions → `speech-regions.json`
4. sentence boundaries → topic segments → `topic-segments.json`
5. optional PySceneDetect shot list → `shot-boundaries.json` (soft-fail)
6. sentence-aligned semantic candidates + boundary repair → `clip-candidates-*.json`
7. local Clip Potential Score, optional LLM enrichment, overlap dedupe → `ranked-clips.json`
8. canonical render plan → `edit-plan.json`
9. FFmpeg crop/extract, per-clip Whisper word timing, ASS burn, validate MP4

Artifacts live under `tmp/clipper-cache/<source-fingerprint>/` so an interrupted
job can reuse completed analysis without reloading heavy models.

## Reusable working pieces

* Public-source import and upload route: `server.ts` `/api/clipper/*`
* Process progress/error protocol: `clipper-pipeline.py:emit`
* Word timing extraction: `transcribe_clip_words`
* FFmpeg abstraction, output validation, subtitle burn, static download
* Compact workflow, result cards, Clip Potential Score display in `AIClipper.tsx`
* Semantic helpers: `source_fingerprint`, `normalise_words`, `sentence_boundaries`,
  `speech_regions`, `topic_segments`, `repair_clip_boundaries`, `local_clip_score`,
  `semantic_candidates`, `dedupe_by_overlap`

## Verified weaknesses (pre-upgrade)

* Candidate selection used fixed windows with deterministic jitter instead of
  semantic sections.
* Candidates could begin/end mid-sentence or hang on connectives (`and` / `but` /
  `because`).
* LLM ranking could silently fall back without a durable local score.
* No durable source-keyed artifacts for interrupted jobs.
* Crop focus was only left/center/right with no optional scene evidence.
* Tests covered duration/diversity more than boundaries, repair, scoring, dedupe.

## Upgrade plan (this pass)

Practical for ~8GB RAM: sequential stages, cached JSON, no new heavy ML stacks.

| Stage | Status |
| --- | --- |
| Transcript-first semantic candidates | Done |
| Boundary repair (sentence snap, no connective endings) | Done |
| Transparent local 0–100 Clip Potential + reason | Done |
| LLM enrichment when `DEEPSEEK_API_KEY` is set | Done |
| Overlap dedupe + ranked / edit-plan artifacts | Done |
| Optional PySceneDetect soft-fail | Done (adapter only) |
| Silero VAD / MediaPipe / Light-ASD | Documented hooks only — not required |
| Full Whisper reinstall | Not required when captions already provide words |

Biggest remaining OpusClip-style gap after this pass is visual crop intelligence
(face / active-speaker tracks), not selection quality.
