"""Game vision inspect/compare tool for /game remake fidelity.

Downloads are done via google_image_downloader; this tool analyzes reference
screenshots (and optional preview captures) with a vision LLM when configured,
or Pillow local analysis for text-only models like DeepSeek V4.
"""

from __future__ import annotations

import json
from collections.abc import Sequence

from pydantic import Field

from openhands.sdk import Action, Observation, ToolDefinition
from openhands.sdk.tool import (
    ToolAnnotations,
    ToolExecutor,
    register_tool,
)

from research.game_vision import run_game_vision


class GameVisionCompareAction(Action):
    """Inspect reference game screenshots or compare them to a remake preview."""

    mode: str = Field(
        default="inspect",
        description=(
            "'inspect' — analyze reference gameplay/UI screenshots into a build brief. "
            "'compare' — compare references to remake screenshots / preview capture."
        ),
    )
    reference_paths: list[str] = Field(
        default_factory=list,
        description=(
            "Paths or folders of reference images (e.g. public/images/cod-mw3-menu/). "
            "Required for inspect and compare."
        ),
    )
    candidate_paths: list[str] = Field(
        default_factory=list,
        description=(
            "Paths to remake screenshots for compare mode "
            "(e.g. public/images/game-preview-capture/preview.png)."
        ),
    )
    preview_url: str | None = Field(
        default=None,
        description=(
            "Optional live preview URL to screenshot with Playwright before compare "
            "(e.g. http://127.0.0.1:8080/ or workspace index.html URL)."
        ),
    )
    focus: str | None = Field(
        default=None,
        description="What to emphasize: main menu, HUD, pause, inventory, gameplay lighting, etc.",
    )
    question: str | None = Field(
        default=None,
        description="Optional custom question for inspect mode.",
    )


class GameVisionCompareObservation(Observation):
    """Structured visual brief or fidelity comparison result."""


class GameVisionCompareExecutor(
    ToolExecutor[GameVisionCompareAction, GameVisionCompareObservation]
):
    def __call__(
        self,
        action: GameVisionCompareAction,
        conversation=None,  # noqa: ARG002
    ) -> GameVisionCompareObservation:
        try:
            result = run_game_vision(
                mode=(action.mode or "inspect").strip().lower(),
                reference_paths=list(action.reference_paths or []),
                candidate_paths=list(action.candidate_paths or []),
                preview_url=action.preview_url,
                focus=action.focus,
                question=action.question,
            )
            return GameVisionCompareObservation.from_text(json.dumps(result, indent=2))
        except Exception as exc:  # noqa: BLE001
            payload = {"success": False, "error": str(exc)}
            return GameVisionCompareObservation.from_text(json.dumps(payload, indent=2))


_DESCRIPTION = """Analyze game reference screenshots and compare them to your remake for 1:1 UI/gameplay fidelity.

**Required /game remake flow:**
1. `research_tool` for the target game's UI/HUD/menu layout.
2. `google_image_downloader` for **gameplay + UI** screenshots (main menu, HUD, pause, inventory, in-game).
3. `game_vision_compare` mode=`inspect` on those folders → get a visual build brief (colors, layout, chrome).
4. Build the game matching that brief — detailed GLSL shaders + textured atlases, not flat colors.
5. Start preview, then `game_vision_compare` mode=`compare` with reference_paths + preview_url (or candidate screenshots).
6. Fix mismatches and re-compare until fidelity_score ≥ 75.

**Vision LLM:** Uses VISION_API_KEY + VISION_BASE_URL + VISION_MODEL (OpenAI-compatible multimodal), or DEEPSEEK_VISION_BASE_URL for self-hosted DeepSeek-VL. Hosted DeepSeek V4 is text-only — without a vision endpoint the tool still returns Pillow color/layout analysis the agent must follow.

Examples:
* inspect references: mode=inspect reference_paths=["public/images/call-of-duty-mw3-menu"]
* compare to preview: mode=compare reference_paths=["public/images/call-of-duty-mw3-hud"] preview_url="http://127.0.0.1:8080/" focus="HUD and crosshair"
"""


class GameVisionCompareTool(
    ToolDefinition[GameVisionCompareAction, GameVisionCompareObservation]
):
    @classmethod
    def create(
        cls,
        conv_state=None,  # noqa: ARG003
        **params,  # noqa: ARG003
    ) -> Sequence["GameVisionCompareTool"]:
        return [
            cls(
                description=_DESCRIPTION,
                action_type=GameVisionCompareAction,
                observation_type=GameVisionCompareObservation,
                executor=GameVisionCompareExecutor(),
                annotations=ToolAnnotations(
                    readOnlyHint=True,
                    destructiveHint=False,
                    idempotentHint=True,
                    openWorldHint=True,
                ),
            )
        ]


register_tool("game_vision_compare", GameVisionCompareTool)
