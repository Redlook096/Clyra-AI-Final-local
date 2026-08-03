#!/usr/bin/env python3
"""Guarded adapter for the optional ``video-understanding-local`` worker.

The upstream project is useful for *candidate-window* video descriptions, but
its default models are far too large for Clyra's normal 8 GB local profile.
This module therefore never imports its ML packages, downloads weights, or
starts a model in the Electron process.  It exposes an explicit subprocess
protocol that can be enabled only in a separately provisioned high-memory
worker.  Clyra's own timeline remains the retrieval index; the optional worker
is a final before/during/after evidence gate for visually-specific requests.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, Mapping, Optional


PROVIDER = "video-understanding-local"
UPSTREAM_REPOSITORY = "https://github.com/Grigorij-Dudnik/video-understanding-local.git"
UPSTREAM_REVISION = "9f0fe77479bbefc3d83b23dfe3c0abf41bfcca53"
DEFAULT_MIN_MEMORY_GB = 24.0
DEFAULT_MIN_DISK_GB = 28.0


def _truthy(value: Any) -> bool:
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


def _number(value: Any, fallback: float) -> float:
    try:
        number = float(value)
        return number if number > 0 else fallback
    except (TypeError, ValueError):
        return fallback


def _environment(overrides: Optional[Mapping[str, Any]] = None) -> Dict[str, str]:
    result = dict(os.environ)
    if overrides:
        result.update({str(key): str(value) for key, value in overrides.items() if value is not None})
    return result


def _physical_memory_gb() -> float:
    try:
        if sys.platform == "darwin":
            completed = subprocess.run(
                ["sysctl", "-n", "hw.memsize"],
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                text=True,
                timeout=2,
                check=True,
            )
            return int(completed.stdout.strip()) / (1024 ** 3)
        pages = int(os.sysconf("SC_PHYS_PAGES"))
        page_size = int(os.sysconf("SC_PAGE_SIZE"))
        return pages * page_size / (1024 ** 3)
    except (OSError, ValueError, subprocess.SubprocessError):
        return 0.0


def _free_disk_gb() -> float:
    try:
        return shutil.disk_usage(Path.home()).free / (1024 ** 3)
    except OSError:
        return 0.0


def _normalise_profile(profile: Any) -> str:
    value = str(profile or "8gb_cpu").strip().lower().replace("-", "_")
    if value in {"high_quality", "high", "deep", "deep_verification", "gpu", "remote"}:
        return "deep_verification"
    return "8gb_cpu"


def _default_runner() -> Path:
    return Path(__file__).resolve().parent / "tools" / "video-understanding-local-runner.py"


def capability_report(
    resource_profile: Any = "8gb_cpu",
    *,
    environ: Optional[Mapping[str, Any]] = None,
    physical_memory_gb: Optional[float] = None,
    free_disk_gb: Optional[float] = None,
) -> Dict[str, Any]:
    """Describe the provider without loading an upstream package or model.

    The values can be injected by deterministic tests.  The normal path reads
    the actual host only to make a conservative resource decision.
    """
    env = _environment(environ)
    profile = _normalise_profile(resource_profile)
    minimum_memory = _number(env.get("CLYRA_VIDEO_UNDERSTANDING_MIN_RAM_GB"), DEFAULT_MIN_MEMORY_GB)
    minimum_disk = _number(env.get("CLYRA_VIDEO_UNDERSTANDING_MIN_DISK_GB"), DEFAULT_MIN_DISK_GB)
    memory = _physical_memory_gb() if physical_memory_gb is None else max(0.0, float(physical_memory_gb))
    disk = _free_disk_gb() if free_disk_gb is None else max(0.0, float(free_disk_gb))
    runner = Path(str(env.get("CLYRA_VIDEO_UNDERSTANDING_RUNNER") or _default_runner())).expanduser()
    python_binary = str(env.get("CLYRA_VIDEO_UNDERSTANDING_PYTHON") or sys.executable).strip()
    enabled = _truthy(env.get("CLYRA_VIDEO_UNDERSTANDING_ENABLED"))
    worker_configured = bool(python_binary and runner.is_file())
    upstream_root_value = str(env.get("CLYRA_VIDEO_UNDERSTANDING_UPSTREAM_ROOT") or "").strip()
    upstream_root = Path(upstream_root_value).expanduser() if upstream_root_value else None
    upstream_configured = bool(
        (upstream_root and (upstream_root / "src" / "video_understanding").is_dir())
        or _truthy(env.get("CLYRA_VIDEO_UNDERSTANDING_UPSTREAM_INSTALLED"))
    )

    reason: Optional[str] = None
    if not enabled:
        reason = "video_understanding_local_disabled_by_default"
    elif profile != "deep_verification":
        reason = "reserved_for_isolated_high_memory_verification_profile"
    elif memory < minimum_memory:
        reason = "insufficient_host_memory_for_upstream_models"
    elif disk < minimum_disk:
        reason = "insufficient_free_disk_for_upstream_models"
    elif not worker_configured:
        reason = "video_understanding_local_runner_not_configured"
    elif not upstream_configured:
        reason = "video_understanding_local_upstream_not_configured"

    return {
        "provider": PROVIDER,
        "available": reason is None,
        "enabled": enabled,
        "workerConfigured": worker_configured,
        "upstreamConfigured": upstream_configured,
        "mode": "isolated-high-memory-worker",
        "resourceProfile": profile,
        "reason": reason,
        "runner": str(runner) if runner.is_file() else None,
        "upstreamRoot": str(upstream_root) if upstream_root and (upstream_root / "src").is_dir() else None,
        "python": python_binary or None,
        "resourceGate": {
            "hostMemoryGb": round(memory, 2),
            "freeDiskGb": round(disk, 2),
            "minimumMemoryGb": minimum_memory,
            "minimumDiskGb": minimum_disk,
            "default8GbBehaviour": "disabled; use Clyra's bounded visual index and optional remote/deep verifier",
        },
        "upstream": {
            "repository": UPSTREAM_REPOSITORY,
            "revision": UPSTREAM_REVISION,
            "integration": "external adapter only; upstream source and model weights are not bundled",
            "licenseStatus": "MIT asserted by pyproject.toml; pinned tree has no LICENSE file, so distribution requires upstream clarification",
            "models": ["Whisper base", "HuggingFaceTB/SmolVLM2-2.2B-Instruct", "Qwen/Qwen2.5-7B-Instruct"],
        },
    }


def _strings(value: Any, maximum: int = 8) -> list[str]:
    if not isinstance(value, (list, tuple)):
        return []
    result: list[str] = []
    for item in value:
        text = str(item or "").strip()
        if text:
            result.append(text[:500])
        if len(result) >= maximum:
            break
    return result


def normalise_temporal_verdict(value: Any) -> Dict[str, Any]:
    """Make an upstream answer safe to use as a strict visual proof.

    A prose summary cannot become an exact match.  It must explicitly affirm
    all temporal predicates, so malformed or partial answers fail closed.
    """
    raw = value if isinstance(value, dict) else {}
    required = ("event_present", "before_state_verified", "transition_verified", "after_state_verified")
    explicit = all(key in raw and isinstance(raw.get(key), bool) for key in required)
    return {
        "structured": explicit,
        "event_present": bool(raw.get("event_present")) if explicit else False,
        "before_state_verified": bool(raw.get("before_state_verified")) if explicit else False,
        "transition_verified": bool(raw.get("transition_verified")) if explicit else False,
        "after_state_verified": bool(raw.get("after_state_verified")) if explicit else False,
        "constraintsSatisfied": _strings(raw.get("constraintsSatisfied")),
        "visual_evidence": _strings(raw.get("visual_evidence")),
        "audio_evidence": _strings(raw.get("audio_evidence")),
        "ocr_evidence": _strings(raw.get("ocr_evidence")),
        "warnings": _strings(raw.get("warnings")),
        "confidence": max(0.0, min(1.0, _number(raw.get("confidence"), 0.0))),
    }


def verify_event_candidate(
    request_plan: Dict[str, Any],
    candidate: Dict[str, Any],
    *,
    source_path: Optional[str],
    resource_profile: Any = "8gb_cpu",
    environ: Optional[Mapping[str, Any]] = None,
    physical_memory_gb: Optional[float] = None,
    free_disk_gb: Optional[float] = None,
) -> Dict[str, Any]:
    """Run a provisioned provider against a short candidate window only."""
    capability = capability_report(
        resource_profile,
        environ=environ,
        physical_memory_gb=physical_memory_gb,
        free_disk_gb=free_disk_gb,
    )
    if not capability["available"]:
        return {
            "available": False,
            "provider": PROVIDER,
            "reason": capability["reason"],
            "capability": capability,
            "verdict": normalise_temporal_verdict(None),
        }
    if not source_path or not Path(source_path).is_file():
        return {
            "available": False,
            "provider": PROVIDER,
            "reason": "local_source_required_for_visual_verification",
            "capability": capability,
            "verdict": normalise_temporal_verdict(None),
        }

    env = _environment(environ)
    start_ms = max(0, int(round(float(candidate.get("start", 0)) * 1000)))
    end_ms = max(start_ms + 1, int(round(float(candidate.get("end", 0)) * 1000)))
    payload = {
        "schemaVersion": "clyra.video-understanding-local.v1",
        "request": request_plan,
        "candidate": {"startMs": start_ms, "endMs": end_ms},
        "sourcePath": str(source_path),
        # The runner limits analysis to this context; it never analyses an
        # unrelated full video just to answer a single user question.
        "context": {"beforeMs": 3_000, "afterMs": 4_000},
    }
    timeout = int(max(30, min(900, _number(env.get("CLYRA_VIDEO_UNDERSTANDING_TIMEOUT_SECONDS"), 420))))
    child_env = dict(env)
    child_env.update({
        "HF_HUB_OFFLINE": "1",
        "TRANSFORMERS_OFFLINE": "1",
        "CLYRA_VIDEO_UNDERSTANDING_ALLOW_HIGH_MEMORY": "1",
    })
    try:
        process = subprocess.run(
            [str(capability["python"]), str(capability["runner"])],
            input=json.dumps(payload),
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
            check=False,
            env=child_env,
        )
        response = json.loads(process.stdout or "{}")
    except (OSError, ValueError, subprocess.SubprocessError) as exc:
        return {
            "available": False,
            "provider": PROVIDER,
            "reason": f"provider_{type(exc).__name__.lower()}",
            "capability": capability,
            "verdict": normalise_temporal_verdict(None),
        }

    verdict = normalise_temporal_verdict(response.get("verdict") if isinstance(response, dict) else None)
    if process.returncode != 0 or not bool(response.get("available")):
        return {
            "available": False,
            "provider": PROVIDER,
            "reason": str(response.get("reason") or "provider_failed")[:160] if isinstance(response, dict) else "provider_failed",
            "capability": capability,
            "verdict": verdict,
        }
    if not verdict["structured"]:
        verdict["warnings"].append("The provider returned an unstructured summary, not verifiable temporal evidence.")
    return {
        "available": True,
        "provider": PROVIDER,
        "reason": None,
        "capability": capability,
        "verdict": verdict,
    }
