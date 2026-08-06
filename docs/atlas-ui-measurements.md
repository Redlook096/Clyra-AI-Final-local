# Atlas UI measurements (target for Clyra)

Reference viewport: 1440 × 900 (also verify 1200 × 675).

| Region | Target |
| --- | --- |
| Titlebar / tab strip | 30px |
| Toolbar | 32px |
| Combined chrome | 62px (±2px) |
| Active tab height | 27px |
| Active tab width | 145–180px preferred |
| Tab favicon | 12–13px |
| Tab title | 11–11.5px |
| Nav icon hit | 24–27px |
| Resting address text | 10.5–11px secondary grey, domain only, centred |
| Ask Clyra button | 24–26px tall, ~78–96px wide, radius ~7px |
| Sidebar width | `clamp(300px, 27.2vw, 410px)` (~26–28%) |
| Sidebar header | 31–36px |
| User bubble | 11–12px, radius 8–10px, pale `#f1f1ef` |
| Assistant text | 11–12px, unboxed |
| Progress row | 20–24px |
| Composer empty height | 72–90px |
| Send button | 23–26px black circle |
| Agent bar | 28–31px tall, black, centred over webpage, 14–18px from bottom |
| Cursor | dark arrow 16–19px |
| Cursor tooltip | 21–24px, black, 9.5–10.5px white text |

Tokens live in `src/index.css` under `--atlas-*`.
