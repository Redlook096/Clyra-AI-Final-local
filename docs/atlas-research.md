# Atlas research (Clyra independent rebuild)

Sources consulted (official OpenAI Help / product posts, Aug 2026):

- https://openai.com/index/introducing-chatgpt-atlas/
- https://openai.com/index/building-chatgpt-atlas/
- https://help.openai.com/en/articles/12628199-using-ask-chatgpt-sidebar-and-chatgpt-agent-on-atlas
- https://help.openai.com/en/articles/12628371-browsing-the-web-with-chatgpt-atlas
- https://help.openai.com/en/articles/12591856-chatgpt-atlas-release-notes
- https://help.openai.com/en/articles/20001371-evolving-atlas-into-chatgpt-for-browser-based-agentic-work

Atlas stops working **9 Aug 2026**. Clyra Browser must be independent — no Atlas binaries, trademarks, or proprietary assets.

## Window structure

- Thin light chrome (~60–64px total): tab strip ~30px + toolbar ~32px
- Webpage ~72–74% width; Ask panel ~26–28%
- 1px vertical divider
- No Chrome-tall omnibox at rest; domain-only, centred, quiet grey
- Ask control top-right of toolbar (compact pale-blue pill)
- Floating black Take control / Stop bar over webpage (not sidebar)
- Dark AI cursor + tiny black action tooltip on the live page

## Ask panel

- Minimal header: collapse/back left, menu right — no large brand header
- User: pale right-aligned bubble; assistant: unboxed text
- Progress: one compact expandable status row (not a numbered card checklist)
- Composer: integrated bottom strip; black circular send; Agent / Sources text

## Agent

- Agent Mode acts in the **visible** browsing session (or isolated logged-out session)
- Text-only LLM → accessibility / DOM / geometry (Playwright MCP pattern)
- Page visibility + browser memories (controllable)
- Takeover / Pause / Stop / Approvals

## OWL note

Atlas OWL separated native UI from Chromium via IPC and shared compositing.
Clyra maps this to: React shell ↔ Electron `WebContentsView` / CDP ↔ Playwright on the **same** visible tab.
