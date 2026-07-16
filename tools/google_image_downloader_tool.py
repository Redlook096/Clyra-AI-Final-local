"""Google Images downloader tool for the OpenHands agent.

Downloads a small set of royalty-free-style stock images into
``public/images/{slugified-query}/`` so generated UIs can reference local
paths like ``/public/images/...`` without hotlinking or paid APIs.
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

from research.google_images import download_google_images


class GoogleImageDownloaderAction(Action):
    """Search Google Images and download files into the workspace."""

    query: str = Field(
        description=(
            "Specific image search query, e.g. 'cozy modern cafe interior' "
            "or 'modern SaaS dashboard laptop mockup'."
        ),
    )
    max_images: int = Field(
        default=6,
        ge=1,
        le=12,
        description="Number of images to download (3–8 recommended).",
    )


class GoogleImageDownloaderObservation(Observation):
    """Result of a Google Images download attempt."""


class GoogleImageDownloaderExecutor(
    ToolExecutor[GoogleImageDownloaderAction, GoogleImageDownloaderObservation]
):
    def __call__(
        self,
        action: GoogleImageDownloaderAction,
        conversation=None,  # noqa: ARG002
    ) -> GoogleImageDownloaderObservation:
        try:
            result = download_google_images(
                query=action.query,
                max_images=action.max_images,
            )
            if result["count"] == 0:
                result = {
                    "success": False,
                    "query": action.query,
                    "error": (
                        "No images were downloaded. Use placeholder images "
                        "in the UI and try a different search query."
                    ),
                    "count": 0,
                    "files": [],
                }
            return GoogleImageDownloaderObservation.from_text(
                json.dumps(result, indent=2)
            )
        except Exception as exc:  # noqa: BLE001
            payload = {
                "success": False,
                "query": action.query,
                "error": str(exc),
                "count": 0,
                "files": [],
            }
            return GoogleImageDownloaderObservation.from_text(
                json.dumps(payload, indent=2)
            )


_GOOGLE_IMAGE_DOWNLOADER_DESCRIPTION = """Download real images from Google Images into the workspace for landing pages, marketing sites, and other UIs that need photos.

When the user asks you to build something that needs images (websites, apps, decks), call this tool with a specific search query before writing HTML/CSS/React. Generate queries that match the project:

* Cafe website → "cozy modern cafe interior"
* Fitness app → "fitness app hero workout gym"
* Real estate site → "modern house exterior real estate"
* SaaS landing page → "modern SaaS dashboard laptop mockup"
* Travel site → "luxury beach resort aerial"

**Official logos and brand marks (required):** When the user asks for real/official logos — platform badges (Xbox, PlayStation, PC/Windows), company logos, or product marks — **always use this tool first**. Do **not** hand-draw SVG paths, curl logo URLs, or scrape SVG from Wikipedia/logo sites.

* Xbox logo → `google_image_downloader` query="Xbox logo official white transparent" max_images=2
* PlayStation logo → query="PlayStation logo official white transparent" max_images=2
* PC / Windows gaming → query="PC gaming logo white transparent" or "Windows logo white" max_images=2
* Company navbar logo → prefer `download_site_icon`; use this tool for larger brand artwork

After download, reference the local file in `<img src="/public/images/...">`. Only fall back to simplified SVG if every download attempt returns zero images.

Rules:
* Download 3–8 images per request (default 6); use 1–2 for single logos.
* Reference downloaded files with local paths like `/public/images/my-query-slug/000001.jpg`.
* Never hotlink remote image URLs.
* Never embed base64 images.
* Never call paid image APIs or vision models.
* If download fails or returns zero images, continue with clean placeholder blocks (e.g. gray boxes with alt text) instead of blocking the build.

Images are saved under `public/images/{slugified-query}/`. If Google icrawler returns no results (common when Google changes HTML), the tool automatically falls back to DDGS image search + httpx download. Results may be subject to copyright — only use images the user has rights to use."""


class GoogleImageDownloaderTool(
    ToolDefinition[GoogleImageDownloaderAction, GoogleImageDownloaderObservation]
):
    """Download Google Images into public/images for local UI references."""

    @classmethod
    def create(
        cls,
        conv_state=None,  # noqa: ARG003
        **params,  # noqa: ARG003
    ) -> Sequence["GoogleImageDownloaderTool"]:
        return [
            cls(
                description=_GOOGLE_IMAGE_DOWNLOADER_DESCRIPTION,
                action_type=GoogleImageDownloaderAction,
                observation_type=GoogleImageDownloaderObservation,
                executor=GoogleImageDownloaderExecutor(),
                annotations=ToolAnnotations(
                    readOnlyHint=False,
                    destructiveHint=False,
                    idempotentHint=False,
                    openWorldHint=True,
                ),
            )
        ]


register_tool("google_image_downloader", GoogleImageDownloaderTool)
