# Clyra AI Clipper — OpusClip Feature-Parity Matrix

_Research and implementation audit: 2026-08-01. “Parity” means a tested,
user-visible capability—not a similarly named setting._

Opus publicly describes multimodal ClipAnything search, ReframeAnything
layouts, editable captions and manual reframe controls. These are comparison
sources, not implementation sources: [ClipAnything](https://help.opus.pro/docs/article/9947095-clip-anything),
[layouts/reframing](https://help.opus.pro/docs/article/layout-and-reframing),
[captions](https://help.opus.pro/docs/article/change-captions), and
[plans](https://www.opus.pro/pricing).

| Capability | Clyra status | Verified evidence / V7 requirement |
| --- | --- | --- |
| Public URL/YouTube and local import | Partial | Existing importer/upload; needs per-provider resume tests. |
| Master versus analysis proxy | Partial | Final path is master-source; add lineage conformance test. |
| 1080×1920 premium output | Complete | Existing high-quality profile; add measured output QA. |
| Automatic candidates | Partial | Sentence/timeline scoring and dedupe are real; add multimodal retrieval. |
| Spoken-topic search | Partial | Transcript/direct-section path exists; standardise evidence cards. |
| Exact visual search | Unavailable | Requires configured Qwen verifier; fail closed until it exists. |
| Audio event search | Partial | Energy/silence only; add VAD/audio-event model. |
| Frame/scene semantic retrieval | Planned | Add OpenCLIP/InternVideo/FAISS behind licence gates. |
| Before/during/after proof | Partial | Contract/gate exists; needs actual VLM worker + fixtures. |
| Active-speaker reframe | Planned | Add approved audiovisual speaker adapter. |
| Selected-person tracking | Partial | MediaPipe path and timestamped crop plan; add robust ReID tests. |
| Multi-person tracking | Partial | Lightweight profile/IoU fallback only; add association tracker. |
| Face-loss safety | Partial | Hold/fallback logic; add long-occlusion fixtures. |
| Dynamic layouts | Planned | Add fill/fit/split/screen-share/gameplay decisions. |
| Manual crop keyframes | Partial | Keyframes persist; finish editing UX and local EDL patches. |
| Word captions | Complete | Existing word timestamp renderer. |
| Multiword active highlight | Complete | Existing phrase-highlight renderer; add fast-speech export tests. |
| Caption style/position | Partial | Controls exist; add safe-zone policy. |
| Existing-caption collision | Partial | Detection/handling path exists when evidence is available; add OCR fixtures. |
| Silence/filler editing | Partial | Existing controls/word timing; add VAD-backed reviewed edits. |
| Licensed footage/publishing | Partial | Foundations exist; official adapters and provider approval gate action. |
| Deterministic preview/export | Partial | Crop keyframes persist; add EDL migration and PTS conformance suite. |
| 8 GB operation | Partial | Sequential/proxy/cache design; add measured RSS/queue test. |

Until those planned rows pass their acceptance fixtures, Clyra must not claim
equivalence in active-speaker intelligence, exact visual event finding or
automatic layout selection. A no-match is preferable to a false visual match.
