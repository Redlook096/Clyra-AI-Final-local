# Clipper Reference Review

Reference clones live in `/tmp/clyra-clipper-references` (outside the Clyra tree).
They are for architecture/licence review only — nothing was vendored or installed
into the product dependency graph for this pass.

| Reference | Revision | Licence | Practical takeaway | Decision |
| --- | --- | --- | --- | --- |
| PySceneDetect | `bba97f5` | BSD-3-Clause | Shot boundaries are evidence for crop resets and safe cuts. | Optional soft-fail adapter (`detect_shot_boundaries`). |
| faster-whisper | `ed9a06c` | MIT | CPU INT8 + word timestamps suit low-memory defaults. | Keep existing optional path when caption words are missing. |
| Silero VAD | `76e3dc4` | MIT | Speech/silence regions protect consonants and dead-air edits. | Optional lazy adapter later; transcript gaps already approximate regions. |
| MediaPipe | `0ad5a71` | Apache-2.0 | Low-res face tracks can drive crop keyframes. | Candidate-only, lazy, 2–5 fps in a future pass. |
| Light-ASD | `ed38c23` | MIT | Active-speaker evidence improves multi-person crops. | Research-only until model/runtime/memory review. |
| auto-editor | `93325be` | Unlicense (public domain) | Pacing classifications are useful, but Clyra owns the edit plan. | Heuristic reference only. |
| libass | `f9fd3d2` | ISC | ASS supports word highlighting and safe caption styling. | Continue through existing FFmpeg/libass burn path. |
| FFmpeg | `80eb9e9` | LGPL-2.1+ (GPL optional parts) | Canonical filter graphs keep rendering reproducible. | Keep existing binary path; audit distribution flags separately. |

## Memory / sequencing notes

* Never load transcription, active-speaker analysis, and final rendering together.
* Prefer caption/transcript selection first — the largest quality gap versus
  OpusClip is moment selection, not another ASR install.
* Optional visual adapters must feature-detect, bound work to selected ranges,
  and release memory before final encode.

No model weights, Python packages, or reference source were copied into the repo.
