# Clyra AI Clipper — Current State Audit

_Audited 2026-08-01. This is a code-and-environment audit, not a claim that optional models are installed._

## Verified request and render path

```text
AIClipper.tsx
  -> POST /api/clipper/upload (local source, optional)
  -> POST /api/clipper/start (URL or upload ID + configuration)
  -> server.ts spawnClipperPipeline + SSE JSON
  -> clipper-pipeline.py
       source master import / source-quality audit
       analysis plate/proxy + transcript recovery
       audio / visual / OCR evidence where available
       timeline graph + candidate selection/verification
       crop/subtitle plan + final master-source render
  -> MP4 + artifacts + edit-plan payload -> editor
```

`server.ts` owns the API boundary. `POST /api/clipper/start` validates a public
HTTP(S) URL or upload ID and starts `clipper-pipeline.py`; `POST
/api/clipper/rerender` reuses a saved artifact; `POST /api/clipper/scan-people`
uses the lightweight face-scan path. The normal final renderer calls
`render_final_from_master`; analysis plates are disposable, not the intended
final source.

## Worker responsibilities

| Module | Verified responsibility | Limitation |
| --- | --- | --- |
| `clipper-pipeline.py` | Import, quality audit, candidate selection, edit-plan artifacts, final FFmpeg render and SSE events. | Some media metadata falls back to FFmpeg when `ffprobe` is unavailable. |
| `clipper_intelligence.py` | Audio energy/silence, adaptive OpenCV signals, optional OCR, timeline graph and visual-transition verification gate. | OpenCV signals are not semantic video understanding. |
| `clipper_face_tracking.py` | MediaPipe VIDEO-mode adapter, conservative persistent fallback, face-landmark anchor, mouth-motion + existing audio-energy active-subject selector, dynamic zoom crop plan and scene fallback. | It is a conservative local heuristic, not a TalkNet-grade audiovisual speech model or body/ReID tracker. |
| `AIClipper.tsx` | Source/import/editor UI, tracking/caption controls and rerender contract. | It has no model logic and must not fabricate evidence. |

Evidence is persisted as `available`, `unavailable`, `degraded` or `rejected`.
An unavailable provider is never interpreted as negative visual/audio evidence.

## Audited local capability snapshot

| Capability | Status | Behaviour |
| --- | --- | --- |
| FFmpeg | Available | Import inspection, proxies and final render. |
| OpenCV | Available | Motion, scene-like change, brightness and sharpness signals. |
| MediaPipe Tasks | Available | Optional timestamped face-landmarker adapter; task model is worker-cached. |
| NumPy / Pillow | Available | Lightweight image/numeric work. |
| Whisper | Available | Clip-local word timing recovery when source words are unavailable. |
| yt-dlp / pytubefix | Available | Existing public-source importer/fallback. |
| Norfair | Not installed | Clyra IoU/profile fallback is used; do not call this Norfair. |
| PySceneDetect | Not installed | Histogram/frame-difference fallback is used. |
| PaddleOCR / Tesseract | Not installed in audited worker | OCR is reported unavailable. |
| TalkNet / active-speaker worker | Not integrated | Clyra uses a disclosed mouth-motion plus source-audio-energy heuristic; it is not labelled TalkNet or a deep ASD model. |
| ByteTrack / re-identification worker | Not integrated | No ByteTrack/ReID claim. |
| YAMNet | Not integrated | Energy/silence is not audio-event classification. |
| Deep visual verifier | No configured isolated worker | Visual-exact prompts fail closed rather than using a transcript-only substitute. Qwen3-VL remains supported when configured; the optional `video-understanding-local` bridge is disabled in the normal 8 GB profile. |
| OpenCLIP / InternVideo / FAISS | Not integrated | No semantic frame/vector retrieval worker. |

## Tracking and output state

The UI now sends tracking mode, selected person, scene mode and zoom intent to
both start and rerender endpoints. `face_tracking_config` honours `off`,
`smooth` and `responsive`; it no longer overwrites every request to `off`.
The worker builds a timestamped crop path, applies a comfort zone and short
loss hold, and degrades/rejects when confidence is inadequate. Preview overlays,
FFmpeg crop keyframes and export use persisted keyframes rather than an
independent CSS animation.

Automatic selection is a conservative, dwell-gated active-subject heuristic:
MediaPipe mouth aperture changes are corroborated by the existing source-audio
energy evidence, then a challenger must remain stronger for 650 ms before the
crop changes. A selected face remains an authoritative identity lock. The
offline path has a comfort zone, no-wander loss hold, and bounded per-frame
scale expression for mild digital zoom; `keep all` / split-screen still fall
back to a stable single crop because a split-screen compositor is not yet
implemented. The portrait default is `1080 × 1920`; premium/master FFmpeg
profiles use the retained master source and a final high-detail encode. Word
and phrase captions are supported and render at final resolution.

## Storage and blockers

Artifacts/caches are disk-backed and source/artifact keyed; writes are atomic.
There is no database migration in this change. Visual requests now add a
bounded, diverse set of timeline-derived candidate windows (motion, cuts and
OCR changes) alongside transcript candidates. Those windows are not semantic
claims: an isolated temporal verifier must explicitly prove before/during/after
states before Clyra labels a match exact. The optional
`video-understanding-local` bridge is a candidate-window provider only; it
does not import, download or package upstream models, and it is resource-gated
away from 8 GB CPU machines. Clyra still needs commercially approved
active-speaker and ReID adapters, a production deep verifier with approved
weights, semantic frame/vector retrieval models, formal EDL migrations and
preview/export PTS conformance fixtures before those features can be claimed.
