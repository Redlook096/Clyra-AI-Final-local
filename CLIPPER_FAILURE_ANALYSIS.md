# Clyra AI Clipper — Failure Analysis

_Audited 2026-08-01. Findings are tied to the current code paths._

## 1. Tracking controls were silently disabled

**Cause:** `face_tracking_config` parsed a requested tracking mode and then
overwrote it with `mode = "off"` and `enabled = False`. Its unit test expected
the same retired behaviour.

**Impact:** Smooth, Responsive and Select Face appeared in the UI but the
worker always produced stable framing.

**Correction in this change:** The configuration honours requested mode and
explicit enablement. Start/rerender requests pass selected-person, scene mode
and zoom fields. The regression test now requires a smooth request to remain
enabled, while explicit `off` stays a fixed crop.

**Residual safety rule:** A scene with inadequate subject confidence still
degrades or rejects visibly; enabling tracking is not a claim that a path is
safe.

## 2. Face tracking is not active-speaker tracking

**Cause:** The current worker can detect/track faces but has no installed
TalkNet or equivalent audiovisual speaker worker.

**Impact:** A prominent-face choice can be wrong in multi-person footage.

**V7 fix:** Add a licence-approved active-speaker adapter combining mouth
motion, voice activity and transcript-speaker alignment. Record confidence,
dwell, backend and fallback per shot. Until then the UI must say
`prominent-face`, not `active speaker`.

## 3. Transcript context cannot prove a visual event

**Cause:** OpenCV metrics are non-semantic. The Qwen3-VL interface exists only
as an external executable protocol and is not configured in this environment.

**Impact:** “Find when they leave the zoo” cannot be proven by someone saying
they will leave.

**Current guard:** State-transition prompts require visual verification and
reject transcript-only evidence.

**V7 fix:** Retrieve candidates, inspect PTS frames before/during/after, then
verify required transition and ending state. Return **No visually verified
match** when visual proof is absent.

## 4. Identity continuity uses a limited fallback

**Cause:** Norfair is not installed. The fallback uses IoU, short velocity
prediction and RGB appearance histograms.

**Impact:** It can handle brief loss but is not a production ReID system for
crossings or long occlusion.

**V7 fix:** Add an approved detector plus ByteTrack/Norfair-style association,
camera-motion compensation and labelled long-occlusion/crossing tests. A
selected person must never switch merely because another face is larger.

## 5. Optional scene/OCR dependencies are absent

**Cause:** PySceneDetect and an OCR runtime are unavailable in the audited
worker.

**Impact:** Rapid edits, dissolves, signs and embedded captions use bounded
fallbacks or unavailable state.

**V7 fix:** Feature-gate the providers, expose coverage and test fallback.
Never show no OCR text as though a scan ran.

## 6. Proxy/source mixing is a quality risk

**Risk:** The analysis plate is intentionally lower-cost/disposable; rendering
from it would soften and re-encode the final video.

**Current guard:** The normal final render uses the retained master source.

**V7 fix:** Store `finalSource = master`, fingerprint and encoder facts in the
artifact; reject a final render whose source is a preview or analysis proxy.

## 7. VFR timing and benchmarks require formal evidence

**Risk:** Some lightweight paths derive timing from frame rate. That is not a
full variable-frame-rate PTS contract. Existing unit tests cover deterministic
logic but not labelled end-to-end V7 fixture accuracy.

**V7 fix:** Add PTS frame references to the EDL and fixture tests for VFR,
face loss, action transitions, embedded captions and preview/export alignment.

| Severity | Release gate |
| --- | --- |
| Critical | No visual query may be marked exact without visual/temporal evidence. |
| Critical | UI → API → worker tracking configuration contract test passes. |
| High | Strict selected-person mode rejects/falls back on loss or an identity conflict. |
| High | Final artifact proves master-source lineage. |
| Medium | One-heavy-worker memory/queue profile passes on an 8 GB system. |
