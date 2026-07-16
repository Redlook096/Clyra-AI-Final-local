# Research tools

Lightweight, free web research for Agent Canvas builds. No paid APIs, no vision models, no Selenium/Playwright.

## Install

From the project root:

```bash
pip install -r requirements.txt
```

## CLI usage

```bash
# DuckDuckGo search
python tools/research/research_tool.py search "GTA VI official site" 8

# Verify a URL responds
python tools/research/research_tool.py verify https://www.rockstargames.com/VI

# Fetch readable page text
python tools/research/research_tool.py fetch https://www.rockstargames.com/VI

# Search + verify + fetch previews
python tools/research/research_tool.py research "GTA VI official site rockstargames" 5

# Scrape colors, fonts, CSS variables, structure
python tools/research/website_theme_scraper.py "https://www.rockstargames.com/VI"

# Download images into public/images/{slug}/
python tools/research/google_images.py "Grand Theft Auto VI cinematic cityscape" 6
```

Google Images uses `icrawler` first. When Google’s HTML parser breaks (common), the script automatically falls back to DDGS image search + `httpx` download into the same folder.

## Agent tools

Registered with OpenHands when `OH_EXTRA_PYTHON_PATH` includes `tools/`:

| Tool | Purpose |
|------|---------|
| `research_tool` | `search`, `verify`, `fetch`, `research` commands |
| `website_theme_scraper` | Official site theme tokens |
| `google_image_downloader` | Local images under `public/images/` |

## Rules for agents

1. Run `research_tool` before citing URLs, docs, or packages.
2. Run `website_theme_scraper` on official brand sites before picking colors/fonts.
3. Run `google_image_downloader` for hero/media images (3–8 per query).
4. Save artifacts under `project-research/` (`source-profile.json`, `design-profile.json`, `sources.md`).
5. Reference images as `/public/images/...` — never hotlink or base64.
6. Never guess brand colors, fonts, or official URLs.
7. No emoji in generated projects unless the user asks.
8. If image download fails, continue with designed placeholders.

## Copyright

Images from Google Images may be subject to copyright. Only use images the user has rights to use. Prefer official press kits and brand pages when available.
