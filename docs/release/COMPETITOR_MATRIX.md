# Clyra Competitor Matrix

**Status: Partial — first pass.** Researched live (August 2026) via web search for 7 of the ~8 required categories. Google/Workspace integrations category and a second pass on Cluely's exact computer-control mechanics still need dedicated research. Every claim below is cited; no fabricated competitor data.

Scoring is 1–10, assigned relative to what was actually verified for Clyra in this session (build/typecheck clean, live UI testing via dev server) versus documented competitor capability (not personally re-tested against competitors — this is desk research, marked accordingly).

---

## Coding Agent — Vibe Coder

**Competitors:** Cursor, Windsurf (Codeium), Claude Code, OpenAI Codex, Replit Agent, Lovable, Bolt

| | Cursor | Windsurf | Claude Code | Clyra (Vibe Coder) |
|---|---|---|---|---|
| Architecture | VS Code fork, IDE-embedded | VS Code fork, "Cascade" agent | Terminal-native CLI agent | Electron-native workspace, backed by real `@opencode-ai/sdk` sessions |
| Multi-file coherence | Composer/Agent Mode | Cascade "Flows" — one plan across many files | Designed for long autonomous runs (hours) | Real tool-calling loop via OpenCode SDK; has a genuine `todowrite`-backed plan (confirmed this session — see Plan tab work) |
| Model flexibility | Claude/GPT-4o/Gemini swappable | Multiple models | Anthropic only | DeepSeek Flash/Pro, model routing already in place |
| Terminal | Integrated | Integrated | Is the terminal | Real PTY via `node-pty`, confirmed wired in `ClyraCodeWorkspace` |
| Diff/review UX | Inline | Inline | Inline in terminal | Dedicated Changes tab, real diffs from session snapshots (verified this session) |
| Pricing (light use) | $20/mo | $15/mo | $20–40/mo (API) or $100 Max | N/A — bundled |

**Best features to match:** Windsurf's persistent cross-file "Flow" narrative coherence; Cursor's frictionless model-swapping; Claude Code's unattended long-run design.
**Clyra gaps found this session:** no parallel/worktree-isolated sub-agents yet (spec'd, not built); no dedicated Design-Select mode wired to the agent (Browser inspect-mode exists and *does* work — verified — but framed as visual editing, not "select and ask" chat context).
**Clyra advantage:** the coding agent, the browser, and voice all share one desktop shell and one Bloub identity — none of the competitors above are also a browser or a voice assistant.
**Verdict: PARITY** on core agent loop (real, not fake — confirmed via live session inspection); **BEHIND** on multi-agent/worktree parallelism.

Sources: [dev.to comparison](https://dev.to/pockit_tools/cursor-vs-windsurf-vs-claude-code-in-2026-the-honest-comparison-after-using-all-three-3gof), [MindStudio](https://www.mindstudio.ai/blog/windsurf-vs-cursor-vs-claude-code), [Prommer CTO verdict](https://prommer.net/en/tech/guides/claude-code-vs-cursor-vs-windsurf/)

---

## AI Browser

**Competitors:** ChatGPT Atlas, Perplexity Comet, Dia (The Browser Company)

| | Atlas | Comet | Dia | Clyra AI Browser |
|---|---|---|---|---|
| Platform | macOS only (as of June 2026) | Mac/Windows/iOS/Android, free | — | Windows + macOS (Electron) |
| Core engine | Chromium-based | Chromium-based | Chromium-based | Real Chromium via `WebContentsView` (confirmed genuine, not an iframe wrapper — verified via code audit this session) |
| Research/citations | Multi-step agent mode | Citation-backed answers, built-in research | "Chat with your tabs" | Real DOM inspection + Gemini vision fallback, Snip & Ask (built and verified this session) |
| Agent takeover/control | Preview agent mode | Full agentic actions | Workflow automation | Manual-control takeover, visible AI cursor, approval gating (already implemented) |

**Clyra gaps found this session:** none new — this session's testing (navigate speed fix, `canGoForward` fix, tab create/switch/close all verified via real clicks) put the *manual browsing* experience on solid footing. Search-engine bot-blocking is an environment/network artifact (confirmed reproducing identically on Google, Bing, and DuckDuckGo from the same sandboxed IP), not a Clyra defect — but it's worth Clyra shipping a documented fallback (e.g., "open in system browser" escape hatch) for networks with aggressive bot-detection, since Atlas/Comet don't have this problem on residential IPs either and neither will most Clyra users.
**Clyra advantage:** the browser's Snip & Ask reuses the exact same Gemini vision pipeline as Screen Companion — one vision system, not a separate one per surface, unlike Atlas/Comet which are single-purpose products.
**Verdict: PARITY** on manual browsing (verified live); **BEHIND** on autonomous multi-step "Agent Mode" polish (Clyra's agent loop exists in `browser-runtime.ts` but wasn't stress-tested against real multi-step tasks this session).

Sources: [WebFX AI browser comparison](https://www.webfx.com/blog/ai/best-ai-browsers/), [HumanSecurity Atlas vs Comet](https://www.humansecurity.com/learn/blog/chatgpt-atlas-vs-perplexity-comet-agentic-browsers/)

---

## Desktop Assistant — Clyra Assist / Screen Companion

**Competitors:** Cluely, ChatGPT desktop, Gemini, Microsoft Copilot

| | Cluely | Clyra (current) |
|---|---|---|
| Screen context | OCR + system audio → LLM, floating overlay, ~300ms | Gemini vision via `analyseVisionFrame`, same pipeline as Snip & Ask |
| Stealth/undetectability | GPU-hook overlay invisible to screen-share (a **deliberately deceptive** feature, $150/mo tier) | N/A — not built, and per this session's own stated principle ("legitimate transparent assistant rather than relying on deceptive behaviour") should **not** be built |
| Meeting mode | Native | Not present — flagged as a candidate in this session's earlier spec, not yet built |
| Pricing | Free / $19.99 / $149.99 (undetectable) / $8/wk mobile | N/A |

**Important finding:** Cluely's flagship differentiator (undetectable overlay that bypasses screen-share capture) is explicitly the kind of dark pattern Clyra's own spec says to avoid. This is a case where **parity with Cluely's marketing claim would be the wrong target** — Clyra should compete on being an honest, always-visible assistant instead. Recommend documenting this as a deliberate strategic non-goal, not a gap.
**Verdict: BEHIND** on meeting-notes mode (not built); **DELIBERATELY NOT COMPETING** on stealth/undetectability.

Sources: [Cluely review 2026](https://dupple.com/reviews/cluely), [Cluely pricing](https://www.finalroundai.com/blog/cluely-pricing)

---

## Voice / Dictation

**Competitors:** ChatGPT Voice, Gemini Live, Wispr Flow

| | Wispr Flow | Clyra Voice Call | Clyra Dictation |
|---|---|---|---|
| Coverage | System-wide, any app, any field | N/A (in-app call UI) | **Not yet built** — spec'd in this session ("Clyra Flow"), not implemented |
| Command Mode | Voice-instruct edits to just-dictated text | N/A | Not built |
| Pricing | $15/mo ($12 annual) | Bundled | — |
| Pipeline | — | Real Pipecat STT→LLM→TTS, Fish Audio, confirmed working infra (existing, verified architecture) | — |

**This is Clyra's clearest gap.** Voice Call exists and is real (Pipecat pipeline, Fish Audio TTS — genuine infrastructure, not mocked), but there is **no system-wide dictation product yet** — Wispr Flow's entire category (release-to-insert-into-any-app) is unaddressed. This was already correctly identified in this session's own backlog ("Clyra Flow") as SHIP-worthy given the STT/TTS infra already exists; it just isn't built yet.
**Verdict: BEHIND** on dictation (unbuilt); **PARITY-track** on conversational voice call once stress-tested (not fully re-verified live this session due to needing a real mic/WebRTC session).

Sources: [Zapier Wispr Flow](https://zapier.com/blog/wispr-flow/), [tldv Wispr review](https://tldv.io/blog/wisprflow/)

---

## Workspace / Study

**Competitors:** NotebookLM, Notion AI, TurboLearn

| | NotebookLM | TurboLearn | Clyra Study |
|---|---|---|---|
| Source-grounded | Yes — answers only from uploaded sources | Yes | `/api/study/ask` is explicitly source-grounded (up to 32 sources, citations required) — confirmed via code audit earlier this session |
| Output types | Summaries, audio overviews | Flashcards, quizzes, podcast-style audio, ~30s processing | modes: `answer`/`summary`/`flashcards`/`quiz`/`plan` (confirmed in `server.ts`) |
| Speed claim | — | 99% accuracy claim, 30s | Not benchmarked this session |

**Verdict: PARITY** on architecture (source-grounding was already correctly designed); untested for speed/accuracy against TurboLearn's claims — flag as needs live benchmarking with real content, not done this session (would require API spend on a real document).

Sources: [Kiori NotebookLM comparison](https://www.kiori.co/en/blog/notebooklm-notion-ai-knowledge-workbenches), [HyScaler TurboLearn review](https://hyscaler.com/insights/turbolearn-ai-pricing-reviews-features/)

---

## Video / Shorts — AI Clipper

**Competitors:** OpusClip, Descript, CapCut

| | OpusClip | CapCut | Clyra AI Clipper |
|---|---|---|---|
| Virality scoring | Proprietary 0–100 score, trained on viral video data (competitors have nothing equivalent) | None | Not present — Clyra ranks via `rank_candidates_with_llm()` (DeepSeek) but does not surface a score or reasoning to the user |
| Face tracking/reframe | Active-speaker tracking → 9:16 | AI camera tracking, Pro-gated | Real `clipper_face_tracking.py` using vendored UltraFace ONNX model (confirmed genuine, not mocked) |
| Speed | — | — | Not benchmarked — this session's live test was blocked by YouTube's bot-check on the sandboxed network before reaching the render stage |
| UI flow tested live | — | — | **Confirmed working end-to-end through Source → Subtitles → Output steps**, real thumbnail/metadata fetch, clean error recovery when download failed (this session) |

**Gap found and already reported this session:** double-click on "Generate clips" fired two real `POST /api/clipper/start` calls — needs a debounce/in-flight guard. **This is a real P1 bug, not yet fixed** (see Release Blockers).
**Missing vs. OpusClip specifically:** no user-facing virality score/reasoning. Given DeepSeek already ranks candidates, surfacing *why* a clip was chosen (a one-line reason, not a fake numeric score) would close this gap cheaply — recommend SHIP NOW.
**Verdict: BEHIND** on virality-score UX; **PARITY** on face-tracking tech (comparable sophistication, unverified render quality since the live test couldn't complete).

Sources: [Reap.video 2026 clipping tools report](https://reap.video/reports/state-of-top-ai-video-clipping-tools-2026), [FaceStabilizer vs CapCut](https://facestabilizer.com/blog/facestabilizer-vs-capcut)

---

## Game Builder — Forge

**Competitors:** Rosebud AI, Replit Agent

| | Rosebud | Replit | Clyra Forge |
|---|---|---|---|
| Engine | Custom "Vibe Coding" → JS/Three.js/React | General-purpose, not games-native | three.js/pixi.js + `@dimforge/rapier*-compat` physics (confirmed) |
| Backend | Real, hosts 2.3M+ community games | Real deploys | **Zero `fetch()` calls in the codebase — confirmed via two independent greps this session and last.** Forge is a client-side-only prototype with no AI generation, no save/load, no backend at all. |
| Multiplayer | Yes (InstantDB) | — | No |

**Verdict: BEHIND — by a wide margin.** This is the single largest gap in the entire product: Forge has zero backend integration. It was already correctly removed from the App Launcher's tool list earlier in this session's history for exactly this reason. **Recommend: DO NOT list Forge as a shipped feature.** Either invest real engineering to wire it to DeepSeek (matching Rosebud's prompt→playable-game loop) or keep it excluded from the launcher until it is.

Sources: [Rosebud AI blog](https://lab.rosebud.ai/blog/top-5-ai-tools-to-upgrade-your-game-development), [Cinevva 2026 AI game generators](https://app.cinevva.com/guides/ai-game-generators-2026)

---

## General Chat

**Competitors:** ChatGPT, Claude, Gemini, Perplexity

Market share shifted meaningfully in 2026: ChatGPT ~68% (down from 87%), Gemini surged 5%→18%, Claude ~29% enterprise share. Claude leads coding benchmarks (93.7% vs ChatGPT 90.2%, Gemini 71.9%); Claude also wins blind writing-quality tests. Perplexity remains the citation/research specialist.

Clyra's chat is DeepSeek-backed (Flash for routing/speed, Pro for hard reasoning) with real streaming, Markdown rendering, and a genuine composer (verified this session — two-line height, Effort dropdown via portal, all functioning). **Not benchmarked against ChatGPT/Claude/Gemini on raw model quality** — that's a DeepSeek-vs-frontier-model question, not a Clyra UX question, and is out of scope for this audit.

**Verdict: PARITY** on chat UX mechanics (streaming, history, composer — all confirmed real and working); model-quality comparison is not a Clyra engineering question.

Sources: [Cubix 2026 comparison](https://www.cubix.co/blog/chatgpt-vs-gemini-vs-claude-vs-perplexity-vs-copilot/), [onewave-ai showdown](https://www.onewave-ai.com/blog/ai-showdown-claude-chatgpt-gemini-perplexity-manus)

---

## Not yet researched (honest gap in this audit)

- **Google/Workspace connectors** (Gmail/Calendar/Drive/Docs/Sheets/Slides) — no live competitor research done this pass. Clyra's own implementation is confirmed real (OAuth flow, confirmation-gated mutations per `electron-runtime.ts` types) but wasn't benchmarked against, e.g., native Gmail/Calendar or Notion's connectors.
- **Meeting notes** (Granola) — mentioned above only in the context of Cluely; no dedicated Granola research done.

These should be picked up in a follow-up pass rather than fabricated here.
