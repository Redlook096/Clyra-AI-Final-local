"""OpenHands tool: scrape official website theme tokens."""

from __future__ import annotations

import json
from collections.abc import Sequence

from pydantic import Field

from openhands.sdk import Action, Observation, ToolDefinition
from openhands.sdk.tool import ToolAnnotations, ToolExecutor, register_tool

from research.website_theme_scraper import scrape_website_theme


class WebsiteThemeScraperAction(Action):
    """Scrape colors, fonts, CSS variables, and layout from a URL."""

    url: str = Field(
        description="Official brand or product URL, e.g. https://www.rockstargames.com/VI",
    )


class WebsiteThemeScraperObservation(Observation):
    """JSON theme scrape output."""


class WebsiteThemeScraperExecutor(
    ToolExecutor[WebsiteThemeScraperAction, WebsiteThemeScraperObservation]
):
    def __call__(
        self,
        action: WebsiteThemeScraperAction,
        conversation=None,  # noqa: ARG002
    ) -> WebsiteThemeScraperObservation:
        try:
            result = scrape_website_theme(action.url)
            return WebsiteThemeScraperObservation.from_text(json.dumps(result, indent=2))
        except Exception as exc:  # noqa: BLE001
            payload = {"success": False, "url": action.url, "error": str(exc)}
            return WebsiteThemeScraperObservation.from_text(json.dumps(payload, indent=2))


_WEBSITE_THEME_DESCRIPTION = """Scrape an official website for design tokens before building branded UIs.

Returns JSON with:
* `colors` — frequent hex/rgb values from CSS/HTML
* `css_variables` — `--token: value` pairs when present
* `fonts` — font-family stacks and Google Fonts links
* `structure` — nav links, headings, buttons, sections, dark/light hint
* `theme_color` — meta theme-color when present

Rules:
* Call AFTER `research_tool` finds the official domain.
* Use for real brands (GTA VI → rockstargames.com) — never guess palette or fonts from memory.
* Write results to `project-research/design-profile.json` and cite `sources.md`.
* No paid APIs, no vision models, no Selenium/Playwright."""


class WebsiteThemeScraperTool(
    ToolDefinition[WebsiteThemeScraperAction, WebsiteThemeScraperObservation]
):
    @classmethod
    def create(
        cls,
        conv_state=None,  # noqa: ARG003
        **params,  # noqa: ARG003
    ) -> Sequence["WebsiteThemeScraperTool"]:
        return [
            cls(
                description=_WEBSITE_THEME_DESCRIPTION,
                action_type=WebsiteThemeScraperAction,
                observation_type=WebsiteThemeScraperObservation,
                executor=WebsiteThemeScraperExecutor(),
                annotations=ToolAnnotations(
                    readOnlyHint=True,
                    destructiveHint=False,
                    idempotentHint=True,
                    openWorldHint=True,
                ),
            )
        ]


register_tool("website_theme_scraper", WebsiteThemeScraperTool)
