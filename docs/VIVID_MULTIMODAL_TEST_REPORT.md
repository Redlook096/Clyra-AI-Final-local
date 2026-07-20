# Vivid multimodal test report

## Automated checks

| Test | Result |
| --- | --- |
| `npm run lint` | Passed |
| `npm run test:creator` | Passed: 60 assertions |
| `npm run test:voice` | Passed: 15 assertions |
| Creator Async health endpoint | Passed |
| Live Async Flash narration request | Passed: 44.1 kHz mono PCM WAV, 1,280 ms audio; server synthesis measurement 2,808 ms |

## Validation limits

The in-app browser test surface became unavailable while attempting local UI inspection, and this environment cannot grant microphone, camera, or screen-share permissions. Therefore, no device permission, visual FPS, interruption latency, memory, or ten-minute-session claim is made here.
