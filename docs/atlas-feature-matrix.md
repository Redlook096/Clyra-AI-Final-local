# Atlas → Clyra feature matrix

| Atlas capability | Clyra status | Notes |
| --- | --- | --- |
| Compact tab strip + toolbar | Rebuild | Pixel target in measurements doc |
| Quiet resting omnibox (domain only) | Rebuild | Focus expands to full URL |
| Ask sidebar 26–28% | Rebuild | Renamed Ask Clyra |
| Agent Mode on visible tab | Existing | `/api/openbrowser/assist` + Electron CDP |
| Floating Take control / Stop | Rebuild | Move off large sidebar buttons |
| Dark AI cursor + tooltip | Rebuild | Remove blue halo |
| Compact progress disclosure | Rebuild | Replace PlanChecklistCard default |
| Chat vs Agent composer modes | Partial | Agent default for tasks; chat for Q&A |
| Logged-out agent session | Partial / blocked | Needs isolated partition work |
| Page visibility | Partial | Settings exist; harden blocks |
| Browser memories | Partial | History exists; memory UI TBD |
| Tab groups / tab search / vertical tabs | Unsupported (phase 2) | Scaffold later |
| Extensions / DevTools / passkeys | Partial | Electron Chromium where available |
| Playwright MCP-style a11y snapshots | Existing direction | browser-runtime observe path |
| BrowserOS foundation | Reference only | AGPL — see licence review |

Classification key: Complete / Partial / Unsupported / Blocked.
