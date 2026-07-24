"""Retry helpers for transient provider failures."""

from __future__ import annotations

import logging
import time
from typing import Callable, Optional, TypeVar

logger = logging.getLogger("youtube_transcript_engine.retry")

T = TypeVar("T")


def is_retryable_exception(exc: BaseException) -> bool:
    name = type(exc).__name__.lower()
    message = str(exc).lower()
    retry_tokens = (
        "timeout",
        "timed out",
        "temporarily",
        "connection reset",
        "connection aborted",
        "503",
        "502",
        "504",
        "429",
        "reset by peer",
        "temporary failure",
        "network",
    )
    if any(token in name for token in ("timeout", "connection", "network")):
        return True
    return any(token in message for token in retry_tokens)


def with_retries(
    fn: Callable[[], T],
    *,
    attempts: int = 3,
    base_delay: float = 0.4,
    retryable: Callable[[BaseException], bool] = is_retryable_exception,
) -> T:
    last: Optional[BaseException] = None
    for attempt in range(1, max(1, attempts) + 1):
        try:
            return fn()
        except BaseException as exc:  # noqa: BLE001 — provider boundary
            last = exc
            if attempt >= attempts or not retryable(exc):
                raise
            delay = base_delay * (2 ** (attempt - 1))
            logger.warning("Retryable failure (attempt %s/%s): %s", attempt, attempts, exc)
            time.sleep(delay)
    assert last is not None
    raise last
