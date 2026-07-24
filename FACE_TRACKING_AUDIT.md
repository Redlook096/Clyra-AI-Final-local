# Face tracking audit — selected-person upgrade

Checkpoint: `89b2f4b5` · Tag: `before-selected-face-tracking`

## Current flow (pre-upgrade)

```text
source → download/cache → transcript moments → plate cut
      → track_faces_and_build_crops() → crop keyframes + sendcmd
      → FFmpeg vertical crop → captions → MP4
      → artifacts (plate / words / crop-plan) for refine
```

1. User enables Face tracking in AI Clipper (`off` / `smooth` / `responsive`).
2. Pipeline calls `clipper_face_tracking.track_faces_and_build_crops` per clip range.
3. Proxy frames (~480p @ ~4 fps) are extracted with FFmpeg.
4. MediaPipe Tasks BlazeFace detects faces; Norfair or SimpleIoU assigns ephemeral `face_*` IDs.
5. Crop follows selected track (or largest face) with dead-zone + exponential smoothing.
6. Crop keyframes drive FFmpeg `sendcmd` crop x/y during render.
7. Studio UI can re-select a track ID and `POST /api/clipper/rerender`.

| Stage | Location | Behaviour today |
| --- | --- | --- |
| Config | `face_tracking_config()` | `off` / `smooth` / `responsive`; optional `selectedTrackId` |
| Detection | `_mediapipe_detector()` | MediaPipe Tasks BlazeFace (optional); motion-heuristic fallback |
| Tracking | `SimpleIoUTracker` / Norfair | Clip-local IDs only |
| Crop | `_crop_from_face()` + `build_crop_filter()` | Dead-zone + smoothing → sendcmd |
| Shots | `detect_shot_boundaries()` | Soft-fail; **not** used for crop reset |
| Refine | `refine_clip()` + `/api/clipper/rerender` | Re-tracks plate with track ID |

## Gaps vs selected-person spec

| Requirement | Status |
|---|---|
| Recurring `person_*` grouping | Missing — IDs are clip-local IoU tracks |
| Person picker with thumbnails | Partial — text pills, no thumbs / overlays |
| Scene detection + tracker reset | Missing at crop layer |
| Strict / Flexible acceptance | Missing |
| Identity embeddings (periodic) | Missing |
| Reject scenes without selected person | Missing |
| Face squares on subtitle preview | Missing |
| Named caches (`detected-people.json`, …) | Partial — hashed JSON only |
| Never switch crop to unselected face | Partial — falls back to largest face |
| 8GB-safe sequential analysis | Mostly OK (proxy, one clip) |

## Exact files to modify

| File | Change |
| --- | --- |
| `FACE_TRACKING_AUDIT.md` | This document |
| `clipper_face_tracking.py` | Person grouping, embeddings, scene filter, thumbs, lock-to-selected |
| `clipper-pipeline.py` | Pass `selectedPersonId` / `personMode` / shot boundaries; persist face assets |
| `server.ts` | Rerender body fields; serve face thumbnails from artifacts |
| `src/components/AIClipper.tsx` | Person picker, overlay squares, Strict/Flexible, FakeText-style copy |
| `tools/clipper-unit-tests.ts` | Assert person config, scene filter, identity helpers |

**Do not rebuild:** download, Whisper, semantic candidate core, FFmpeg encoder path.

## Cache / artifact paths

Under `{TMP}/clipper-cache/<source_fingerprint>/`:

```text
detected-scenes.json
detected-people.json
selected-person.json
face-tracks.json
accepted-face-scenes.json
crop-keyframes.json
face-cache/<sha>.json
faces/person_001.jpg …
```

Per-clip artifacts: `{TMP}/clipper-artifacts/<id>/` (`plate.mp4`, `crop-plan.json`, `faces/*.jpg`).

## Library stance (8GB-safe)

| Lib | Role | Required? |
| --- | --- | --- |
| MediaPipe Tasks | Face boxes (+ keypoints when present) | Preferred, optional |
| Lightweight hist+landmark embedding | Person re-ID | Default |
| InsightFace / ONNX | Stronger embeddings | Optional if installed |
| Norfair | MOT | Optional |
| PySceneDetect | Shot cuts | Optional (already soft-fail) |

Proxy analysis stays ~480p @ ~4 fps, sequential, one clip at a time.
References cloned under `/tmp/clyra-face-tracking-references` (not vendored).
