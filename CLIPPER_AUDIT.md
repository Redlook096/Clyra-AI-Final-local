# Clyra Clipper Audit

## Current flow

`src/components/AIClipper.tsx` owns the four-step UI and starts
`POST /api/clipper/start` in `server.ts`. The route invokes
`clipper-pipeline.py` as a child process and streams JSON progress back to the
UI. The pipeline imports public YouTube sources through `pytubefix` with a
`yt-dlp` download fallback, reads platform captions where possible, and uses
`faster-whisper` or OpenAI Whisper for exact timestamps after clipping.

The pipeline currently:

1. reads captions or transcribes a local/downloaded source;
2. creates fixed-duration windows in `choose_moments`;
3. optionally asks the existing server-side DeepSeek endpoint to rank those
   windows in `rank_candidates_with_llm`;
4. extracts each crop through FFmpeg (`extract_clean_clip`);
5. transcribes the exact clip for word timings;
6. writes ASS subtitles (`write_subtitles`) and burns them with FFmpeg;
7. validates the output through the existing media probes and emits results.

## Reusable working pieces

* Public-source import and upload route: `server.ts` around `/api/clipper/*`.
* Process progress/error protocol: `clipper-pipeline.py:emit`.
* Word timing extraction: `transcribe_clip_words`.
* FFmpeg abstraction, output validation, subtitle burn and static download.
* Compact workflow, result cards and output player in `AIClipper.tsx`.

## Verified weaknesses

* Candidate selection uses windows stepped through the transcript and includes
  deterministic jitter. It does not first construct semantic sections.
* Candidates can begin/end at arbitrary word positions and can lack setup or
  resolution.
* LLM ranking tolerates malformed responses by silently falling back without a
  schema error or retry receipt.
* There are no durable source-keyed artifacts, so a failed job recomputes work.
* Crop focus is only `left`, `center`, or `right`; no scene or face-track pass
  exists.
* Captions are word-by-word rather than phrase-grouped with safe-zone checks.
* Existing tests validate only duration/candidate diversity, not semantic
  boundaries, cache reuse, or final-output quality.

## Upgrade plan

The first implementation batch keeps the stable downloader/render path and
adds source-keyed JSON artifacts, a unified word format, sentence/pause-aware
topics, boundary repair, transparent local scores, schema-safe LLM enrichment,
and candidate deduplication. Scene and face analysis remain optional adapters
until their dependency and memory budgets are accepted.
