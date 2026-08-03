# Clyra AI Clipper V7 — Implementation and Validation Plan

_Stages below are completion gates, not promises that models already work._

## Stage 0 — baseline and configuration contract

- [x] Trace UI → API → worker → artifact → render.
- [x] Remove the worker override that forced requested tracking off.
- [x] Add a regression assertion that a requested Smooth crop remains enabled.
- [ ] Add permissioned, local fixture manifest with event windows, identity and
  caption ground truth.
- [ ] Record source/encoder/crop-path diagnostics for each fixture.

**Gate:** build and clipper tests pass; strict selected-person scenes degrade or
reject with an explicit reason.

## Stage 1 — EDL and presentation-time correctness

1. Add `clyra.clipper.edl.v1` schema, migration reader and cache version.
2. Store PTS/duration frame references, including variable-frame-rate assets.
3. Make preview and FFmpeg evaluate the same EDL values by media time.
4. Emit source-master lineage/fingerprint/encoder metadata; reject proxy final
   inputs.
5. Compare preview/export frames at known timestamps.

**Gate:** crop and caption values agree within one source pixel after scaling;
direct seek and frame rendering reconstruct the same state.

## Stage 2 — lightweight perception under capability gates

1. Licence-review and pin decoder, VAD, scene, OCR and MediaPipe model paths.
2. Add bounded PTS frame decoder and independent caches for every evidence type.
3. Report coverage with `available`, `unavailable`, `degraded` and `rejected`.
4. Add no-provider fallback tests.

**Gate:** a missing component never crashes a job or silently becomes negative
evidence.

## Stage 3 — retrieval and exact video verification

1. Add OpenCLIP retrieval + disk-backed vector index after approved weight
   review.
2. Add small InternVideo temporal retrieval for shortlisted windows only.
3. Add typed Qwen3-VL local/remote verifier protocol.
4. Enforce planner flow: retrieve → inspect → verify → optimise boundaries.
5. Add positive and negative action/location transition fixtures.

**Gate:** exact visual requests contain before/event/after visual proof;
unavailable verifier yields no exact match, never a guess.

## Stage 4 — active speaker and robust subject tracking

1. Approve/pin detector, active-speaker and ReID model weights; update notices.
2. Add Clyra-owned active-speaker and association adapters.
3. Add camera motion, per-shot reset, dwell, selected-person lock and loss
   handling.
4. Optimise full prerecorded trajectory offline using velocity, acceleration,
   jerk, headroom and comfort-zone constraints.
5. Add manual local crop-keyframe patches.

**Gate:** zero ID switches on labelled continuous shots; ≥99% safe-region
coverage on confident frames; no wandering on long loss or interpolation over
cuts.

## Stage 5 — editing and quality release

1. Add stable fill/fit/split/screen-share/gameplay layout decisions.
2. Use face/OCR/HUD occupancy for subtitle placement and collision choices.
3. Validate word and phrase captions at 30/60 FPS and after edits.
4. Profile RSS, queue length, model unload and cache reuse on an 8 GB machine.
5. Test cancellation, retry, network loss, unavailable provider and master
source lineage.

**Gate:** client remains responsive, one heavy model is active at once and
final 1080p output is sourced from master media.

## Rollout rule

Every model adapter is behind an off-by-default capability flag, for example
`CLYRA_V7_VISUAL_RETRIEVAL`, `CLYRA_V7_QWEN_VERIFIER`,
`CLYRA_V7_ACTIVE_SPEAKER` and `CLYRA_V7_EDL_RENDERER`. Before enabling a flag:
pin commit/version, check code and weight licences, update
`THIRD_PARTY_NOTICES.md`, test unavailable fallback, then pass its fixture gate.
