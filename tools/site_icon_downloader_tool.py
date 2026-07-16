"""Site icon downloader tool for the OpenHands agent."""

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

from icon_downloader.download_site_icon import download_site_icon


class SiteIconDownloaderAction(Action):
    """Download a website favicon/logo into public/icons/."""

    url: str = Field(
        description="Website URL to extract favicon/logo from, e.g. https://www.ubisoft.com",
    )


class SiteIconDownloaderObservation(Observation):
    """Result of a site icon download attempt."""


class SiteIconDownloaderExecutor(
    ToolExecutor[SiteIconDownloaderAction, SiteIconDownloaderObservation]
):
    def __call__(
        self,
        action: SiteIconDownloaderAction,
        conversation=None,  # noqa: ARG002
    ) -> SiteIconDownloaderObservation:
        try:
            result = download_site_icon(action.url)
            return SiteIconDownloaderObservation.from_text(
                json.dumps(result, indent=2)
            )
        except Exception as exc:  # noqa: BLE001
            payload = {
                "success": False,
                "source_url": action.url,
                "error": str(exc),
            }
            return SiteIconDownloaderObservation.from_text(
                json.dumps(payload, indent=2)
            )


_SITE_ICON_DOWNLOADER_DESCRIPTION = """Download a website logo, wordmark, or favicon into public/icons/ for local UI references.

Given a website URL, automatically find and download the site's logo, wordmark, favicon, or app icon. Do not ask the user to find icons manually.

Detects icons from:
* `<link rel="icon">`, shortcut icon, apple-touch-icon, mask-icon
* `<meta property="og:image">`
* fallback `/favicon.ico`
 * probable logo images / inline SVGs in nav and header areas

Rules:
* Prefer real logo/wordmark assets from the page when available.
* Only use assets found in HTML or verified `/favicon.ico` — never guess logo URLs.
* Reference downloaded files with local paths like `/public/icons/example-com-icon.png`.
* Use before building brand UIs so nav, hero, and support sections can show the official brand mark.
* If download fails, continue with a domain favicon fallback in CSS or follow up with `google_image_downloader` — do not block the build."""


class SiteIconDownloaderTool(
    ToolDefinition[SiteIconDownloaderAction, SiteIconDownloaderObservation]
):
    """Download website favicons into public/icons/."""

    @classmethod
    def create(
        cls,
        conv_state=None,  # noqa: ARG003
        **params,  # noqa: ARG003
    ) -> Sequence["SiteIconDownloaderTool"]:
        return [
            cls(
                description=_SITE_ICON_DOWNLOADER_DESCRIPTION,
                action_type=SiteIconDownloaderAction,
                observation_type=SiteIconDownloaderObservation,
                executor=SiteIconDownloaderExecutor(),
                annotations=ToolAnnotations(
                    readOnlyHint=False,
                    destructiveHint=False,
                    idempotentHint=True,
                    openWorldHint=True,
                ),
            )
        ]


register_tool("site_icon_downloader", SiteIconDownloaderTool)
