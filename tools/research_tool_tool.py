"""OpenHands tool: web research (search, verify, fetch, research_topic)."""

from __future__ import annotations

import json
from collections.abc import Sequence

from pydantic import Field

from openhands.sdk import Action, Observation, ToolDefinition
from openhands.sdk.tool import ToolAnnotations, ToolExecutor, register_tool

from research.research_tool import fetch_url, research_topic, search_web, verify_url


class ResearchToolAction(Action):
    """Run a lightweight research command."""

    command: str = Field(
        description="One of: search, verify, fetch, research",
    )
    query: str = Field(
        description="Search query, URL to verify/fetch, or research topic text.",
    )
    max_results: int = Field(
        default=5,
        ge=1,
        le=20,
        description="Max search/research results (search/research commands).",
    )


class ResearchToolObservation(Observation):
    """JSON research output."""


class ResearchToolExecutor(ToolExecutor[ResearchToolAction, ResearchToolObservation]):
    def __call__(
        self,
        action: ResearchToolAction,
        conversation=None,  # noqa: ARG002
    ) -> ResearchToolObservation:
        command = action.command.strip().lower()
        try:
            if command == "search":
                payload = {"results": search_web(action.query, action.max_results)}
            elif command == "verify":
                payload = verify_url(action.query)
            elif command == "fetch":
                payload = fetch_url(action.query)
            elif command == "research":
                payload = research_topic(action.query, action.max_results)
            else:
                payload = {
                    "success": False,
                    "error": f"Unknown command: {action.command}",
                }
            return ResearchToolObservation.from_text(json.dumps(payload, indent=2))
        except Exception as exc:  # noqa: BLE001
            return ResearchToolObservation.from_text(
                json.dumps({"success": False, "error": str(exc)}, indent=2)
            )


_RESEARCH_TOOL_DESCRIPTION = """Lightweight web research before citing URLs, docs, or packages.

Commands (set `command` + `query`):
* `search` — DuckDuckGo text search (returns title, url, snippet)
* `verify` — Check a URL is reachable (status, content-type)
* `fetch` — Download readable page text (trafilatura + HTML fallback)
* `research` — Search + verify + fetch previews for top hits

Rules:
* Use BEFORE picking brand colors, fonts, official URLs, or package docs.
* For real brands (GTA → rockstargames.com), run `research` then `website_theme_scraper`.
* Save findings under `project-research/` (`source-profile.json`, `design-profile.json`, `sources.md`).
* Never guess hex colors, fonts, or official URLs from memory.
* No paid APIs, no vision models."""


class ResearchTool(ToolDefinition[ResearchToolAction, ResearchToolObservation]):
    @classmethod
    def create(
        cls,
        conv_state=None,  # noqa: ARG003
        **params,  # noqa: ARG003
    ) -> Sequence["ResearchTool"]:
        return [
            cls(
                description=_RESEARCH_TOOL_DESCRIPTION,
                action_type=ResearchToolAction,
                observation_type=ResearchToolObservation,
                executor=ResearchToolExecutor(),
                annotations=ToolAnnotations(
                    readOnlyHint=True,
                    destructiveHint=False,
                    idempotentHint=True,
                    openWorldHint=True,
                ),
            )
        ]


register_tool("research_tool", ResearchTool)
