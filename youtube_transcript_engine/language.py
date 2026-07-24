"""Language preference resolution."""

from __future__ import annotations

from typing import Iterable, List, Optional, Sequence


def resolve_language_order(
    available: Iterable[str],
    *,
    preferred: Optional[Sequence[str]] = None,
    original: Optional[str] = None,
) -> List[str]:
    """Priority: user preferred → English → original → first available."""
    langs = [str(code).strip() for code in available if str(code).strip()]
    if not langs:
        return []

    ordered: List[str] = []
    seen = set()

    def add(code: Optional[str]) -> None:
        if not code:
            return
        code = code.strip()
        if not code or code in seen:
            return
        # Prefer exact match; also try base language (en-US → en).
        candidates = [code]
        if "-" in code:
            candidates.append(code.split("-", 1)[0])
        for candidate in candidates:
            for lang in langs:
                if lang.lower() == candidate.lower() or lang.lower().startswith(candidate.lower() + "-"):
                    if lang not in seen:
                        ordered.append(lang)
                        seen.add(lang)
                    return

    for pref in preferred or []:
        add(pref)
    add("en")
    add(original)
    for lang in langs:
        add(lang)
    return ordered
