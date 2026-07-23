# Face Tracking Audit — Selected-Person Upgrade

Audited: 2026-07-23 · Checkpoint: `89b2f4b5` · Tag: `before-selected-face-tracking`

## Current flow (before upgrade)

```text
source → download/cache → transcript moments → plate cut
      → track_faces_and_build_crops() → crop keyframes + sendcmd
      → FFmpeg vertical crop → captions → MP4
      → artifacts (plate / words / crop-plan) for refine
```

| Stage | Location | Behaviour today |
| --- | --- | --- |
| Config | `face_tracking_config()` in `clipper_face_tracking.py` | `off` / `smooth` / `responsive`; optional `selectedTrackId` |
| Detection | `_mediapipe_detector()` / `_detect_mediapipe()` | MediaPipe Tasks BlazeFace (optional); motion-heuristic fallback |
| Tracking | `SimpleIoUTracker` / optional Norfair | Ephemeral `face_01` IDs per clip only |
| Crop | `_crop_from_face()` + `build_crop_filter()` | Dead-zone + exponential smoothing → FFmpeg sendcmd |
| Shots | `detect_shot_boundaries()` in `clipper-pipeline.py` | Soft-fail; stored in `edit-plan.json`, **not** used for crop reset |
| Refine | `refine_clip()` + `POST /api/clipper/rerender` | Re-tracks plate with `selectedTrackId` |
| UI | `AIClipper.tsx` results studio | Mode segments + text pills when `available_faces.length > 1` |

## Gaps vs selected-person system

1. No stable `person_*` identity across shots (only IoU track IDs).
2. No embeddings / appearance hashing / InsightFace path.
3. No scene acceptance (70% visibility, confidence ≥ 0.72, Strict/Flexible).
4. Crop can fall back to largest face when the selected track is missing.
5. `availableFaces` lacks thumbnails and preview overlay samples.
6. Shot boundaries do not reset temporary trackers.
7. Results preview has no clickable face squares.

## Exact files to modify

| File | Change |
| --- | --- |
| `FACE_TRACKING_AUDIT.md` | This document |
| `clipper_face_tracking.py` | Person grouping, embeddings, scene filter, thumbs, lock-to-selected |
| `clipper-pipeline.py` | Pass `selectedPersonId` / `personMode` / shot boundaries; persist face assets |
| `server.ts` | Rerender body fields; serve plate + face thumbnails |
| `src/components/AIClipper.tsx` | Person picker, overlay squares, Strict/Flexible, premium copy |
| `tools/clipper-unit-tests.ts` | Assert person config, scene filter, identity helpers |

**Do not rebuild:** download, Whisper, semantic candidate core, FFmpeg encoder path.

## Cache / artifact paths

| Purpose | Path |
| --- | --- |
| Source cache | `{TMP}/clipper-cache/<fingerprint>/` |
| Face JSON cache | `{source_cache}/face-cache/<sha>.json` or `{TMP}/clipper-face-cache/` |
| Clip artifacts | `{TMP}/clipper-artifacts/<id>/` (`plate.mp4`, `crop-plan.json`, `faces/*.jpg`) |

## Library stance (8GB-safe)

| Lib | Role | Required? |
| --- | --- | --- |
| MediaPipe Tasks | Face boxes (+ keypoints when present) | Preferred, optional |
| Lightweight hist+landmark embedding | Person re-ID | Default |
| InsightFace | Stronger embeddings | Optional if installed |
| Norfair | MOT | Optional |
| PySceneDetect | Shot cuts | Optional (already soft-fail) |

Proxy analysis stays ~480p @ ~4 fps, sequential, one clip at a time.
