"""OpenHands tool: semantic codebase search over workspace files."""

from __future__ import annotations

import json
import re
from collections.abc import Sequence
from pathlib import Path

from pydantic import Field

from openhands.sdk import Action, Observation, ToolDefinition
from openhands.sdk.tool import ToolAnnotations, ToolExecutor, register_tool

SKIP_DIRS = {
    ".git",
    "node_modules",
    ".venv",
    "venv",
    "dist",
    "build",
    ".next",
    ".cache",
    "__pycache__",
    "target",
}

SOURCE_EXTENSIONS = {
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".vue",
    ".svelte",
    ".py",
    ".go",
    ".rs",
    ".java",
    ".css",
    ".scss",
    ".html",
    ".md",
    ".json",
}


def _tokenize(text: str) -> list[str]:
    return [t for t in re.split(r"[^a-zA-Z0-9]+", text.lower()) if len(t) > 1]


def _score_path(path: str, tokens: list[str]) -> int:
    if not tokens:
        return 0
    lower = path.lower()
    parts = re.split(r"[^a-zA-Z0-9]+", lower)
    score = 0
    for token in tokens:
        if token in lower:
            score += 3
        if token in parts:
            score += 5
        if any(p.startswith(token) for p in parts):
            score += 2
    depth = len([p for p in path.split("/") if p])
    score -= max(0, depth - 4)
    return score


def _iter_files(root: Path, max_files: int = 2500) -> list[Path]:
    results: list[Path] = []
    for path in root.rglob("*"):
        if len(results) >= max_files:
            break
        if not path.is_file():
            continue
        if any(part in SKIP_DIRS for part in path.parts):
            continue
        if path.suffix.lower() not in SOURCE_EXTENSIONS and path.name not in {
            "package.json",
            "Dockerfile",
            "Makefile",
        }:
            continue
        results.append(path)
    return results


def _extract_imports(text: str) -> list[str]:
    imports: list[str] = []
    for match in re.finditer(
        r"(?:import|from)\s+['\"]([^'\"]+)['\"]|require\(['\"]([^'\"]+)['\"]\)",
        text,
    ):
        path = match.group(1) or match.group(2)
        if path:
            imports.append(path)
    return imports[:20]


class CodebaseSearchAction(Action):
    """Search the workspace for relevant files."""

    query: str = Field(description="Natural language search query.")
    max_results: int = Field(default=15, ge=1, le=30)


class CodebaseSearchObservation(Observation):
    """Ranked file search results."""


class CodebaseSearchExecutor(
    ToolExecutor[CodebaseSearchAction, CodebaseSearchObservation]
):
    def __call__(
        self,
        action: CodebaseSearchAction,
        conversation=None,
    ) -> CodebaseSearchObservation:
        root = Path.cwd()
        tokens = _tokenize(action.query)
        ranked: list[dict[str, object]] = []

        try:
            for file_path in _iter_files(root):
                rel = file_path.relative_to(root).as_posix()
                score = _score_path(rel, tokens)
                if score <= 0:
                    continue
                entry: dict[str, object] = {"path": rel, "score": score}
                try:
                    text = file_path.read_text(encoding="utf-8", errors="ignore")
                    entry["imports"] = _extract_imports(text)
                except OSError:
                    entry["imports"] = []
                ranked.append(entry)

            ranked.sort(key=lambda item: int(item["score"]), reverse=True)
            payload = {
                "query": action.query,
                "results": ranked[: action.max_results],
                "total_scanned": len(_iter_files(root)),
            }
            return CodebaseSearchObservation.from_text(json.dumps(payload, indent=2))
        except Exception as exc:  # noqa: BLE001
            return CodebaseSearchObservation.from_text(
                json.dumps({"success": False, "error": str(exc)}, indent=2)
            )


_DESCRIPTION = """Semantic codebase search — find relevant workspace files by query.

Input: natural language query (e.g. "auth login form", "dashboard layout").
Output: ranked file paths with relevance scores and import hints.

Use BEFORE editing to discover existing architecture. Prefer this over guessing paths."""


class CodebaseSearchTool(
    ToolDefinition[CodebaseSearchAction, CodebaseSearchObservation]
):
    @classmethod
    def create(
        cls,
        conv_state=None,  # noqa: ARG003
        **params,  # noqa: ARG003
    ) -> Sequence["CodebaseSearchTool"]:
        return [
            cls(
                description=_DESCRIPTION,
                action_type=CodebaseSearchAction,
                observation_type=CodebaseSearchObservation,
                executor=CodebaseSearchExecutor(),
                annotations=ToolAnnotations(
                    readOnlyHint=True,
                    destructiveHint=False,
                    idempotentHint=True,
                    openWorldHint=False,
                ),
            )
        ]


register_tool("codebase_search", CodebaseSearchTool)
