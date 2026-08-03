# Clyra Auto-Reframe V2

The AI Clipper uses a two-pass, timestamped virtual-camera pipeline for
selected clips. It does not crop an analysis proxy into the delivery video.

```text
source master
  -> bounded low-resolution analysis stream
  -> MediaPipe Face/Pose video-mode observations
  -> Clyra identity association + forward/backward LK optical flow
  -> face/body anchor fusion + scene-aware offline trajectory optimisation
  -> one CropFrame per output timestamp
  -> original-resolution per-frame crop + final subtitle composite
  -> one H.264/AAC delivery encode
```

## Profiles

`quality` / `high_quality`

- Face and Pose landmark refresh on every decoded analysis frame.
- Forward/backward LK still supplies diagnostics and validates movement.
- Intended for the final export; it favours visual quality over throughput.

`balanced` (default)

- Refreshes landmarks every frame when motion is meaningful or flow is weak.
- Uses one FB-validated optical-flow intermediate at most when stable.
- Keeps memory bounded to the current and prior grayscale proxy frames.

`low_power` / `low_memory`

- Refreshes detections every two frames and propagates a locked target with
  FB-validated LK on the intermediate frame.
- Immediately redetects on a scene cut, low valid-point ratio, high round-trip
  error, confidence loss, or a large movement estimate.

All profiles retain real source observations at their native cadence. Delivery
is at least 30fps: a 24fps source therefore keeps its 41.667ms observations,
but Clyra evaluates the stored crop interpolation on every 33.333ms delivery
frame without speeding up video or audio. A 30fps master has 33.333ms source
and delivery cadence, while 60fps retains 16.667ms cadence. Clyra does not
invent source observations that do not exist.

## Composition and tracking

- Face anchors use stable upper-face geometry and eye line, never mouth motion
  or a raw face-box centre.
- Where pose is available, facial position is fused with shoulder/torso
  geometry. Face geometry remains authoritative for eye-line placement.
- The selected identity is held through brief occlusion; confidence loss freezes
  a safe crop rather than wandering into background scenery.
- LK uses forward/backward error validation. Background features provide a
  camera-motion estimate so a source pan does not become a false identity move.
- Each hard scene boundary is optimised independently; no crop interpolates
  across an unrelated shot.
- Export uses a future-aware, zero-phase trajectory path with velocity and
  acceleration limits. Preview and export evaluate the stored crop keyframes,
  and subtitles are composited after cropping at fixed 1080×1920 coordinates.

## Model and licence gate

The V2 reference clones are isolated in `third_party/` (git-ignored) and pinned
in `DEPENDENCY_COMMITS.lock`. `THIRD_PARTY_NOTICES.md` and
`MODEL_LICENSES.md` record their status.

RTMW/RTMPose, BoT-SORT ReID and ByteTrack detector weights are deliberately
disabled until the exact weight, model-card and commercial terms are approved.
The active worker therefore uses Clyra-owned association logic plus optional
MediaPipe and OpenCV adapters. It must not claim that gated weights are active.

## Debug artifacts

Every tracked job writes these cache artifacts:

- `crop-keyframes.json` — stored per-frame camera path.
- `tracking-diagnostics.json` — raw/smoothed anchors, velocity, confidence,
  source, forward/backward flow health and camera-motion estimate.
- `face-tracks.json` — per-frame face/body observations and persistent track IDs.
- `detected-scenes.json` — scene boundaries that reset optimisation.

The production renderer reads `crop-keyframes.json`; it does not use a separate
CSS or FFmpeg smoothing rule. The developer-only debug overlay renderer reads
the same stored path and writes `tracking_debug.mp4`, without changing the
normal delivery path.

## Local validation

```bash
python3 -m py_compile clipper_face_tracking.py clipper-pipeline.py
npm run test:clipper
npm run build
```

For a rendered backend validation, submit a normal AI Clipper job with
`face_tracking.trackingQuality` set to `quality` and inspect the resulting
`tracking-diagnostics.json` with the final 1080×1920 output. The pipeline falls
back to a stable fixed crop if the optional tracking adapters are unavailable;
the render job must never fail solely because a model is gated or absent.
