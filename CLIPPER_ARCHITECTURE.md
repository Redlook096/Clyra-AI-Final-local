# Intelligent Clipper Architecture

```text
validated source
  -> source-metadata.json
  -> transcript-words.json
  -> speech-regions.json
  -> topic-segments.json          (from sentence_boundaries)
  -> shot-boundaries.json         (optional PySceneDetect; soft-fail)
  -> clip-candidates-*.json       (semantic + boundary repair + local score)
  -> ranked-clips.json            (optional LLM enrich + overlap dedupe)
  -> edit-plan.json               (canonical render instructions)
  -> FFmpeg extract / Whisper word timing / ASS burn
  -> clip_result SSE events + complete payload
```

## Artifact cache

Artifacts are keyed by `source_fingerprint(source)` under
`tmp/clipper-cache/<fingerprint>/`. Writes are atomic (`.tmp` then replace) so a
cancelled job cannot poison the cache.

## Selection quality path

1. `sentence_boundaries` — punctuation + pause aware spans
2. `topic_segments` — group sentences toward the target duration
3. `semantic_candidates` — build windows from complete sentences
4. `repair_clip_boundaries` — snap in/out points; refuse endings on
   `and` / `but` / `because` / similar connectives
5. `local_clip_score` — transparent Clip Potential Score `1–100` + reason string
6. `rank_candidates_with_llm` — optional enrichment when `DEEPSEEK_API_KEY` exists
7. `dedupe_by_overlap` — keep diverse top clips
8. `build_edit_plan` — hand off to the existing crop/subtitle renderer

## UI contract

Each rendered clip emits `score` / `clip_potential_score` (0–100) and `reason`.
`AIClipper` surfaces these as **Clip Potential** on result cards and the
selected-clip panel.

## Optional hooks (not required this pass)

* Silero VAD — refine `speech-regions.json`
* MediaPipe face tracks — crop keyframes inside `edit-plan.json`
* Light-ASD — multi-speaker crop evidence
* Full Whisper reinstall — only when word timestamps are unavailable

The pipeline stays sequential on low-memory hardware and preserves the current
FFmpeg renderer.
