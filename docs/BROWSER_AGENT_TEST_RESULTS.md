# Browser Agent Test Results

Date: 2026-07-23

## Automated

| Check | Result |
| --- | --- |
| `npx tsc --noEmit` | Pass |
| Clipper unit tests (`npm run test:clipper`) | Pass (60 assertions) |
| Browser e2e (`npm run test:browser`) | Skipped (needs live Chromium + keys); covered by manual localhost smoke |

## Manual smoke (localhost + Electron)

| Surface | Result |
| --- | --- |
| Boot overlay progress (Vibe warmup stages) | Pass — Preparing workspace → coding engine → Almost ready; M1 warmup ready in logs |
| Chat composer expand (top fixed) | Pass |
| App Launcher lighter intro | Pass — opens via Apps / Ctrl-K path |
| Study Pal Sources / Quiz | Pass — light theme; quiz topic form generates via `/api/study/quiz` |
| AI Browser workspace | Pass — address bar, tabs, Show assistant present |
| AI Clipper wizard + YouTube | Pass — URL `https://youtu.be/nowcsh1wDzE` accepted; pipeline produced 3× ~32s 9:16 MP4s with Clip Potential Score |
| Vibe Coder send | Pass — warm M1; live Agent Canvas opens with Running state (Clyra checklist removed; M1 canvas has its own task list) |

## Clipper YouTube run

- Source: We Created Australia’s Most Viral Cookie (~17:30)
- After duration clamp: clips `32s / 32s / 32s` at 720×1280 with scores 54 / 53 / 49 and reason strings
- Outputs: `output/clip-858660-*.mp4`

## Platforms

| Platform | Status |
| --- | --- |
| macOS (this machine) | Smoke tested |
| Windows | Shared TypeScript surface; not exercised in this session |

## Known limitations

- Full Browser Use Python runtime is intentionally not shipped.
- PageLM is capability reference only (Community License); Study Pal is a native rewrite.
- Optional MediaPipe / Light-ASD / Silero VAD remain feature-detected hooks, not default on 8GB.
- Embedded M1 Agent Canvas may still show its own task checklist (external product UI).
