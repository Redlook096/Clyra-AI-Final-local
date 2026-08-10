# Third-party notices

This file records reference projects inspected for planned Clyra integrations.
No source code or model weights from these projects have been copied into the
application in this change.

| Component | Revision | Licence | Intended reference use |
| --- | --- | --- | --- |
| browser-use | `40717057a3f46c403df360206c2784c840da3345` | MIT | Browser agent observation, planning, verification, and chat-card patterns. |
| PageLM (CaviraOSS) | `736f22b9b1b194fc50d90b29337d04d99ba81172` | PageLM Community License (non-commercial without written permission) | Study-suite capability and prompt reference only; no source copied. Clyra Study Pal is a native rewrite. |
| OpenCluely | `dffdf1a8f7ccefe895fb8de928b177167df11d58` | Apache-2.0 | Explicit screen-assistant/session design. |
| suitedaces/computer-agent (Taskhomie) | `b5bf31fa8041461675782dae2c7ec155b323224c` | Apache-2.0 | Computer Use tool contract and agent-loop architecture reference. Clyra uses its own Electron adapter and does not bundle Taskhomie or its Tauri runtime. |
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

## Clipper V8 reference audit (2026-07-30)

The following projects were audited as design and integration references for
the Clipper V8 foundation. They are **not bundled, linked, copied, or executed
by Clyra** in this change. Any future adapter must be pinned to the stated
revision, reviewed again at adoption time, and kept behind a Clyra-owned
interface. Model-weight licences are separate from source licences and must be
approved independently before distribution.

| Reference | Revision | Licence | Clyra decision |
| --- | --- | --- | --- |
| OpenGVLab/InternVideo | `3965eef16e2dadd0ea6c8d0cc29c8a3039df52e3` | Apache-2.0 | Candidate worker adapter only. Exclude `InternVideo1/.../libMR` and every non-commercial or patent-restricted model/checkpoint. |
| mlfoundations/open_clip | `a3c2605ab3adab2eea5dc387ac02ed2ea0a8ef87` | MIT | Candidate adapter only. Use a separate commercial weight allow-list; do not ship MetaCLIP or NLLB-CLIP CC-BY-NC weights. |
| google-ai-edge/mediapipe | `a1ff14c8397a20b656ea9d639e1a288b00e8279d` | Apache-2.0 | Candidate local tracking adapter only; vet each downloaded task model. |
| TaoRuijie/TalkNet-ASD | `6d6821479af485e251c4991487e40573b42181b4` | MIT | Code is reference-only until a commercially permitted model-weight path is confirmed. |
| FoundationVision/ByteTrack | `d1bf0191adff59bc8fcfeaa0b33d3d1642552a99` | MIT | Candidate tracking adapter only; independently vet detector and ReID weights. |
| Breakthrough/PySceneDetect | `bba97f59ff082875cf1c41b8ce2cb52a34ed2020` | BSD-3-Clause | Candidate shot-boundary adapter; retain notice if adopted. |
| PaddlePaddle/PaddleOCR | `2661c7c0ef5c613e8f93c6e93b2e052399f0f854` | Apache-2.0 | Candidate OCR adapter only. Exclude `ppstructure/kie` (CC-BY-NC-SA) and vet model downloads. |
| snakers4/silero-vad | `76e3dc408eb2a5c655c34e230d2d5459b4439daa` | MIT | Candidate VAD adapter. Do not bundle its CC-BY-NC-SA dataset. |
| facebookresearch/sam2 | `2b90b9f5ceec907a1c18123530e92e794ad901a4` | Apache-2.0 | Candidate opt-in segmentation adapter; retain upstream third-party notices if adopted. |
| FFmpeg/FFmpeg | `b57a3d028dbefc95f5f4bb70f2b2f5f8debb9a0c` | LGPL-2.1+ default | Existing renderer dependency. Use OS-provided or LGPL-compliant dynamic builds only; never enable GPL/non-free components without legal review. |
| pexels/pexels-javascript | `6c5f579077e564fc0cab24e10167073f3fed32df` | MIT | Candidate licensed-footage client only. Requires API key, terms compliance, provenance and attribution handling. |
| immich-app/immich | `0293414abd9f82c7a4847c9bacb313a1d978773b` | AGPL-3.0 | Architecture reference only. Do not link, embed, copy, or ship. |
| googleapis/google-api-nodejs-client | `cd333de532ab22207790c28590e11390c37d08ef` | Apache-2.0 | Candidate official YouTube client only; separate OAuth scopes/API policy review required. |
| facebook/facebook-nodejs-business-sdk | `584ba8d7414574744abe2f3bf0f2390937c916d5` | Meta Platform License | Reference only until a compliant Meta-approved integration is reviewed. |
| bluesky-social/atproto | `84781a9958357e1f208ff0100cee050c5b42298b` | MIT or Apache-2.0 | Candidate official OAuth client only; never use account passwords. |
| taskforcesh/bullmq | `93649b8694a155a7c6fcd596f772e43b86285f1f` | MIT | Candidate immediate/resumable job queue only; exclude BullMQ Pro and all scheduled-job features. |

The current Clyra change adds no provider SDK, model, model checkpoint, stock
asset, or social-network browser automation. Its publishing registry reports
an unavailable or needs-connection state until an approved official adapter is
registered in the backend.

## Head-tracking reference audit (2026-07-30)

| Reference | Revision | Licence | Clyra decision |
| --- | --- | --- | --- |
| google-ai-edge/mediapipe | `a1ff14c8397a20b656ea9d639e1a288b00e8279d` | Apache-2.0 | Existing optional backend adapter remains behind Clyra interfaces; MediaPipe task-model licensing must be checked separately. |
| tryolabs/norfair | `e517b4236f6b67a6ecf342f5df1fccb7788dbc54` | BSD-3-Clause | Optional local persistent-track adapter; not bundled when unavailable. |
| casiez/OneEuroFilter | `b9926841e20557eb689d40e26d9fee9edbc69b8b` | BSD-3-Clause (Python reference) | Algorithmic reference for incremental preview only. Clyra’s final prerecorded-video path uses its own offline zero-phase optimiser. |

The current tracking change does not copy upstream demo code. It records a
Clyra-owned timestamped crop trajectory, uses future samples for final export,
and falls back safely when optional face-tracking dependencies are unavailable.

## Auto-reframe reference audit (2026-08-01)

| Reference | Revision | Licence | Clyra decision |
| --- | --- | --- | --- |
| google-ai-edge/mediapipe | `bdddcbd09ea1588825d35fe7b715d1a14789a85a` | Apache-2.0 | Existing optional timestamped Face Landmarker adapter. Clyra owns the face-anchor, subject-selection, and crop-planning code. Task-model provenance and licence remain a separate deployment gate. |
| google/mediapipe legacy reference | `bdddcbd09ea1588825d35fe7b715d1a14789a85a` | Apache-2.0 | AutoFlip documentation and examples inspected for saliency, shot segmentation, and kinematic planning concepts only; no source copied. |
| FoundationVision/ByteTrack | `d1bf0191adff59bc8fcfeaa0b33d3d1642552a99` | MIT | Candidate future adapter only. It is not bundled or imported; a detector and ReID weight licence must be approved before enabling it. |
| ultralytics/ultralytics | `ee3fe3eabf36bbe024e8a5da9a80880fb6964841` | AGPL-3.0 | **Not integrated or shipped.** Clyra’s distributed commercial product must obtain a suitable commercial licence or select a permissive person detector before any YOLO adapter is enabled. |

The active local implementation does not claim YOLO, ByteTrack, TalkNet, or a
split-screen compositor where they are unavailable. It uses MediaPipe's
timestamped **Face Landmarker and Pose Landmarker** tasks, OpenCV's local
pyramidal Lucas–Kanade optical flow, a Clyra-owned persistent association
tracker, mouth-motion plus the existing FFmpeg audio-energy evidence for
conservative active-subject choice, and a stable fixed crop fallback when
confidence is inadequate. The Face/Pose task-model provenance and commercial
licence remain separate deployment gates; neither model is committed to this
repository or silently shipped in an Electron bundle.

## Optional AutoClip local-runner adapter (2026-08-01)

| Reference | Revision | Licence | Clyra decision |
| --- | --- | --- | --- |
| artbyjazi/autoclip | `5d0eac36fa615b79dd2104083bf273a96f8d68bb` | MIT | Optional, separately-running local service. Clyra owns the HTTP adapter and review mapping; no AutoClip source, UI, dependencies, model weights, or credentials are bundled. |

The integration is disabled unless `CLYRA_AUTOCLIP_URL` points to a running
loopback AutoClip service. It is never selected for Clyra Vision by default:
AutoClip documents a transcript-only highlight path, while Clyra Vision remains
responsible for visual-event verification. Any distribution that vendors
AutoClip itself must include its full MIT licence and copyright notice.

## Optional video-understanding-local verifier audit (2026-08-02)

| Reference | Revision | Licence | Clyra decision |
| --- | --- | --- | --- |
| Grigorij-Dudnik/video-understanding-local | `9f0fe77479bbefc3d83b23dfe3c0abf41bfcca53` | **MIT is asserted only in `pyproject.toml`; the pinned tree has no `LICENSE` file** | Not bundled, copied, linked, or installed by Clyra. Clyra owns a narrow JSON subprocess adapter for a separately provisioned candidate-window verifier only. Upstream licence clarification is required before any redistribution. |

The inspected upstream implementation downloads and loads Whisper base,
`HuggingFaceTB/SmolVLM2-2.2B-Instruct`, and `Qwen/Qwen2.5-7B-Instruct`.
Its README documents roughly 25 GB of storage and a CUDA GPU with at least 8 GB
VRAM. Those model-weight licences are separate from the repository declaration
and have **not** been approved, bundled, or automatically downloaded by Clyra.
Accordingly, this provider is disabled by default and cannot run in Clyra's
standard 8 GB CPU profile. It may be enabled only in an isolated, pre-provisioned
high-memory worker, with offline model loading, a pinned upstream checkout, and
independent model-weight and commercial-use review. Unstructured prose from the
upstream worker is rejected as visual proof; exact visual matches require an
explicit before/during/after JSON verdict.

## Auto-reframe V2 reference audit (2026-08-02)

The following exact, shallow reference clones are isolated under
`third_party/` and ignored by Git. Clyra does not copy or bundle their source;
the project-level decisions below are separate from every detector, ReID and
pose model-weight licence.

| Reference | Revision | Source licence | Clyra decision |
| --- | --- | --- | --- |
| Tau-J/rtmlib | `2a18a092848552e6a57128f08ca1ad9f61246452` | Apache-2.0 | Reference for an optional ONNX whole-body adapter. RTMW model weights remain disabled pending their own release gate. |
| google-ai-edge/mediapipe | `bdddcbd09ea1588825d35fe7b715d1a14789a85a` | Apache-2.0 | Existing Face/Pose task adapter; Clyra owns all anchor and trajectory logic. |
| NirAharon/BoT-SORT | `251985436d6712aaf682aaaf5f71edb4987224bd` | MIT | Adapter candidate only. Its bundled YOLOv7 subtree is GPL-3.0 and is excluded. ReID/detector weights need independent commercial approval. |
| FoundationVision/ByteTrack | `d1bf0191adff59bc8fcfeaa0b33d3d1642552a99` | MIT | Low-power adapter candidate only; detector/ReID weights are a separate gate. |
| opencv/opencv | `e35ad60e4e1db55be854df5770f706af65803690` | Apache-2.0 | Existing OpenCV runtime supports Clyra-owned Lucas–Kanade and affine camera-motion calculations. |
| opencv/opencv_contrib | `a8e9acd62cabd30419dba83007f2ac0d07de5e2c` | Apache-2.0 | Reference-only. No contrib module is bundled. |
| open-mmlab/mmpose | `759b39c13fea6ba094afc1fa932f51dc1b11cbf9` | Apache-2.0 | RTMW architecture/configuration reference only. Model weights remain disabled. |

See `DEPENDENCY_COMMITS.lock` for clone pins and `MODEL_LICENSES.md` for the
mandatory model-weight release gate.

## Optional OpenCode Vibe runtime (2026-08-02)

| Reference | Revision | Source licence | Clyra decision |
| --- | --- | --- | --- |
| anomalyco/opencode | `1882c33827cf0ce5c948b69ab5a87ed8f6790cf8` | MIT | Clyra owns a narrow subprocess/SSE adapter to OpenCode's documented `run --format json` interface. The OpenCode source, UI, configuration, models, provider credentials, and plugins are not copied or bundled. |

The Vibe Coder surface runs only against a Clyra-managed project workspace and
does not accept a browser-supplied filesystem path. It does not silently enable
OpenCode's `--auto` permission flag; deployments may opt in with
`CLYRA_OPENCODE_AUTO_APPROVE=true` after their own security review. A configured
OpenCode provider/model is required for execution. OpenCode is a third-party
runtime and Clyra is not affiliated with its authors.

## Clyra Code V5 technical references (2026-08-04)

The following repositories are shallow, local-only technical references under
`.references/`. They are ignored by Git and are neither bundled nor copied
into Clyra. Clyra uses its own UI and integration code.

| Reference | Revision | Source licence | Intended reference use |
| --- | --- | --- | --- |
| anomalyco/opencode | `6c32991` | MIT | SDK types, events, sessions, permissions and diffs. |
| ItsWendell/palot | `fd63a75` | MIT (verify before reuse) | OpenCode GUI lifecycle and reconnect patterns. |
| microsoft/vscode | `cc2c3484` | MIT | Workbench density and interaction concepts only. |
| microsoft/monaco-editor | shallow local checkout | MIT | Editor API reference; Clyra uses the published package. |
| xtermjs/xterm.js | shallow local checkout | MIT | Terminal API reference; Clyra uses the published package. |

No source sections from these repositories were adapted in this change.
