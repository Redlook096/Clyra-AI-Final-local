# Dependency / licence review (browser rebuild)

| Dependency | Licence | Use |
| --- | --- | --- |
| Playwright (runtime already in project) | Apache-2.0 | Production control API |
| Chromium via Electron | BSD-style / Chromium | Production engine |
| BrowserOS | **AGPL-3.0** | **Reference only** — not product foundation until commercial licence review |
| Playwright MCP | Apache-2.0 | Architecture reference for a11y snapshots |
| browser-use / Stagehand | MIT (verify pin) | Reference patterns only |
| Readability | Apache-2.0 | Optional extract |
| PaddleOCR | Apache-2.0 | Optional local OCR fallback only |

Decision: Clyra Browser remains on Electron + Playwright CDP. BrowserOS is not vendored into production source in this rebuild.
