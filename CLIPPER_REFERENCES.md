# Clipper Reference Review

Reference clones are in `/tmp/clyra-clipper-references`; they are deliberately
outside Clyra's source tree.

| Reference | Revision | Practical takeaway | Decision |
| --- | --- | --- | --- |
| PySceneDetect | `d40629d` | Shot boundaries are evidence for crop resets and safe cuts. | Optional adapter; never sole clip selector. |
| faster-whisper | `ed9a06c` | CPU INT8 and word timestamps are suitable low-memory defaults. | Use only when existing timing is unavailable. |
| Silero VAD | `76e3dc4` | Speech/silence regions can protect consonants and dead-air edits. | Optional lazy adapter. |
| MediaPipe | `0ad5a71` | Low-resolution face tracks can drive crop keyframes. | Candidate-only, lazy, 2–5 fps. |
| Light-ASD | `ed38c23` | Active-speaker evidence can improve multi-person crops. | Research-only until licensing/model/runtime review. |
| auto-editor | `6dbeba8` | Pacing classifications are useful, but Clyra must own its edit plan. | Heuristic reference only. |
| libass | `f9fd3d2` | ASS supports word highlighting and safe caption styling. | Continue through existing FFmpeg/libass output. |
| FFmpeg | `2cf3f4d64de0efa5ccb4021f7245e93b041dbd9e` | A canonical filter graph makes rendering reproducible. | Keep existing binary path, audit distribution flags. |

No model weights, Python packages, or reference code were copied or installed
as part of this audit.
