# Third-party notices

This file records reference projects inspected for planned Clyra integrations.
No source code or model weights from these projects have been copied into the
application in this change.

| Component | Revision | Licence | Intended reference use |
| --- | --- | --- | --- |
| browser-use | `40717057a3f46c403df360206c2784c840da3345` | MIT | Browser agent observation, planning, verification, and chat-card patterns. |
| PageLM (CaviraOSS) | `736f22b9b1b194fc50d90b29337d04d99ba81172` | PageLM Community License (non-commercial without written permission) | Study-suite capability and prompt reference only; no source copied. Clyra Study Pal is a native rewrite. |
| OpenCluely | `dffdf1a8f7ccefe895fb8de928b177167df11d58` | Apache-2.0 | Explicit screen-assistant/session design. |
| Skill-Anything | `4c83b8e73dccd897db6cecc1d5e6bbd987baf80a` | MIT | Permissioned skill lifecycle. |
| UI-TARS-desktop | `c2ad42e3eb9b27830db41a3e6f51ca7179d9b168` | Apache-2.0 | Desktop action planner design. |
| PySceneDetect | `d40629d` | BSD-3-Clause (verify before distribution) | Optional shot-boundary adapter. |
| faster-whisper | `ed9a06c` | MIT (verify before distribution) | Optional CPU INT8 word-timestamp adapter. |
| silero-vad | `76e3dc4` | MIT (verify before distribution) | Optional VAD adapter. |
| MediaPipe | `0ad5a71` | Apache-2.0 (verify before distribution) | Optional low-resolution face tracking. |
| Light-ASD | `ed38c23` | Research dependency review required | Candidate-only active-speaker research. |
| auto-editor | `6dbeba8` | Licence review required | Pacing heuristics reference only. |
| libass | `f9fd3d2` | ISC | Caption renderer reference. |
| FFmpeg | `2cf3f4d64de0efa5ccb4021f7245e93b041dbd9e` | LGPL/GPL variants | Existing renderer dependency; distribution build options must be audited. |

The exact upstream licence texts remain in the clones under `/tmp`; any future
redistribution must add the applicable notices and satisfy the selected FFmpeg
configuration's obligations.
