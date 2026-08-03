#!/usr/bin/env python3
"""Local, capability-aware intelligence primitives for Clyra AI Clipper.

This module deliberately keeps the heavy-model boundary explicit.  It creates
useful evidence with the local tools that are available today (FFmpeg, optional
OpenCV and optional Tesseract), records exactly which signals were available,
and never fabricates a visual or audio conclusion when a provider is missing.

The pipeline owns orchestration and persistence; this module is intentionally
pure-ish and JSON-oriented so individual providers can later be replaced with
stronger vision, OCR, speaker, or audio models without changing the timeline
or ranking contracts.
"""

from __future__ import annotations

from array import array
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from clipper_video_understanding import (
    capability_report as video_understanding_capability_report,
    verify_event_candidate as verify_with_video_understanding,
)


TIMELINE_SCHEMA_VERSION = "clyra.timeline-knowledge-graph.v1"
INTELLIGENCE_SCHEMA_VERSION = "clyra.clipper-intelligence.v1"
MOMENT_QUERY_SCHEMA_VERSION = "clyra.moment-query.v2"
DEFAULT_MAX_ANALYSIS_SECONDS = 1_800.0
DEFAULT_MAX_BASE_SAMPLES = 900
DEFAULT_MAX_TOTAL_SAMPLES = 1_800
DEFAULT_AUDIO_SAMPLE_RATE = 8_000


def _read_json(path: str, fallback: Any = None) -> Any:
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, TypeError, ValueError):
        return fallback


def _write_json_atomic(path: str, payload: Dict[str, Any]) -> None:
    """Persist a tiny cache manifest without ever exposing the media URL."""
    directory = os.path.dirname(path)
    os.makedirs(directory, exist_ok=True)
    descriptor, staging = tempfile.mkstemp(prefix=f".{os.path.basename(path)}.", suffix=".tmp", dir=directory, text=True)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, sort_keys=True)
        os.replace(staging, path)
    finally:
        try:
            os.unlink(staging)
        except FileNotFoundError:
            pass


def _clamp(value: Any, minimum: float = 0.0, maximum: float = 1.0) -> float:
    try:
        return max(minimum, min(maximum, float(value)))
    except (TypeError, ValueError):
        return minimum


def _number(value: Any, fallback: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return fallback


def _safe_int(value: Any, fallback: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return fallback


def _is_local_media(source: str) -> bool:
    try:
        return bool(source) and Path(source).is_file()
    except OSError:
        return False


def _ffmpeg_available(binary: Optional[str]) -> bool:
    if not binary:
        return False
    if os.path.isabs(binary) or os.path.sep in binary:
        return os.path.isfile(binary) and os.access(binary, os.X_OK)
    return shutil.which(binary) is not None


def _bounded_duration(duration_seconds: Any, maximum_seconds: Any) -> float:
    maximum = max(1.0, _number(maximum_seconds, DEFAULT_MAX_ANALYSIS_SECONDS))
    duration = _number(duration_seconds, 0.0)
    if duration <= 0:
        return maximum
    return min(duration, maximum)


def _read_env_limit(name: str, fallback: float) -> float:
    return max(1.0, _number(os.environ.get(name), fallback))


def capability_report(ffmpeg_binary: Optional[str] = None) -> Dict[str, Any]:
    """Return installed provider facts without importing expensive models eagerly."""
    opencv = False
    pytesseract = False
    tesseract_binary = shutil.which("tesseract") is not None
    try:
        import cv2  # noqa: F401

        opencv = True
    except Exception:
        opencv = False
    if tesseract_binary:
        try:
            import pytesseract  # noqa: F401

            pytesseract = True
        except Exception:
            pytesseract = False
    deep_verifier = {
        "available": bool(
            str(os.environ.get("CLYRA_QWEN3_VL_VERIFIER", "")).strip()
            and os.path.isfile(str(os.environ.get("CLYRA_QWEN3_VL_VERIFIER", "")).strip())
            and os.access(str(os.environ.get("CLYRA_QWEN3_VL_VERIFIER", "")).strip(), os.X_OK)
        ),
        "mode": "isolated-worker",
    }
    # This reports the optional external adapter without importing its model
    # stack.  The normal 8 GB profile intentionally leaves it unavailable;
    # a deployment may opt into a separately provisioned deep worker.
    video_understanding = video_understanding_capability_report("8gb_cpu")
    return {
        "schemaVersion": INTELLIGENCE_SCHEMA_VERSION,
        "ffmpeg": _ffmpeg_available(ffmpeg_binary),
        "opencv": opencv,
        "tesseract": bool(tesseract_binary and pytesseract),
        "audioEnergy": _ffmpeg_available(ffmpeg_binary),
        "adaptiveVisualSampling": opencv,
        "ocr": bool(opencv and tesseract_binary and pytesseract),
        "qwen3VL": deep_verifier,
        "videoUnderstandingLocal": video_understanding,
        "notes": {
            "vision": "OpenCV scene, motion, brightness and sharpness evidence" if opencv else "OpenCV is unavailable",
            "ocr": "Tesseract OCR on selected visual samples" if opencv and tesseract_binary and pytesseract else "OCR provider is unavailable",
            "deepVerification": (
                "Deep visual verification is opt-in and runs only in an isolated, high-memory worker. "
                "The 8 GB local path stays bounded and never downloads model weights."
            ),
        },
    }


def prepare_visual_source(
    source: str,
    cache_dir: str,
    ffmpeg_binary: Optional[str],
    duration_seconds: Any,
    *,
    max_seconds: Optional[float] = None,
) -> Dict[str, Any]:
    """Return a timestamp-matched visual analysis source.

    Long local masters are also converted to a small, video-only proxy once.
    Repeated random seeks through an H.264 1080p/4K source make the adaptive
    sampler look hung and consume needless CPU.  The master itself stays
    untouched for the final render. Failure is represented as evidence
    unavailability rather than a fatal clip failure.
    """
    limit = _bounded_duration(
        duration_seconds,
        max_seconds or _read_env_limit("CLIPPER_INTELLIGENCE_MAX_SECONDS", DEFAULT_MAX_ANALYSIS_SECONDS),
    )
    try:
        direct_source_limit = max(5.0, float(os.environ.get("CLIPPER_DIRECT_VISUAL_SOURCE_MAX_SECONDS", "120")))
    except (TypeError, ValueError):
        direct_source_limit = 120.0
    is_local_source = _is_local_media(source)
    if is_local_source and limit <= direct_source_limit:
        return {
            "available": True,
            "path": source,
            "kind": "source",
            "coverageEndMs": int(round(limit * 1000)),
            "truncated": _number(duration_seconds) > limit,
        }
    if not source or not _ffmpeg_available(ffmpeg_binary):
        return {
            "available": False,
            "kind": "unavailable",
            "reason": "no_local_visual_source" if source else "missing_source",
            "coverageEndMs": 0,
        }

    # Direct media streams and longer local masters can be decoded by FFmpeg.
    # We do not persist original public URLs in any artifact.
    proxy_path = os.path.join(cache_dir, "intelligence-visual-proxy.mp4")
    proxy_manifest_path = os.path.join(cache_dir, "intelligence-visual-proxy.json")
    required_coverage_ms = int(round(limit * 1000))
    try:
        manifest = _read_json(proxy_manifest_path, {})
        cached_coverage_ms = _safe_int(manifest.get("coverageEndMs")) if isinstance(manifest, dict) else 0
        if (
            os.path.isfile(proxy_path)
            and os.path.getsize(proxy_path) > 8_192
            and isinstance(manifest, dict)
            and manifest.get("schemaVersion") == INTELLIGENCE_SCHEMA_VERSION
            and cached_coverage_ms >= max(0, required_coverage_ms - 1_000)
        ):
            return {
                "available": True,
                "path": proxy_path,
                "kind": "proxy-cache",
                "coverageEndMs": min(cached_coverage_ms, required_coverage_ms),
                "truncated": _number(duration_seconds) > limit,
            }
        os.makedirs(cache_dir, exist_ok=True)
        temporary = f"{proxy_path}.tmp.mp4"
        command = [
            str(ffmpeg_binary),
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-nostdin",
            "-i",
            source,
            "-t",
            f"{limit:.3f}",
            "-an",
            "-vf",
            "scale=-2:360:flags=bicubic,fps=2",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "30",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
            temporary,
        ]
        subprocess.run(
            command,
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            timeout=max(45.0, min(900.0, limit * 1.5 + 30.0)),
        )
        if not os.path.isfile(temporary) or os.path.getsize(temporary) <= 8_192:
            raise RuntimeError("empty_proxy")
        os.replace(temporary, proxy_path)
        _write_json_atomic(
            proxy_manifest_path,
            {
                "schemaVersion": INTELLIGENCE_SCHEMA_VERSION,
                "coverageEndMs": required_coverage_ms,
                "kind": "visual-analysis-proxy",
            },
        )
        return {
            "available": True,
            "path": proxy_path,
            "kind": "proxy",
            "coverageEndMs": required_coverage_ms,
            "truncated": _number(duration_seconds) > limit,
        }
    except Exception as exc:
        try:
            os.remove(f"{proxy_path}.tmp.mp4")
        except OSError:
            pass
        return {
            "available": False,
            "kind": "unavailable",
            "reason": "visual_proxy_failed",
            "errorCode": type(exc).__name__,
            "coverageEndMs": 0,
        }


def analyze_audio_evidence(
    source: str,
    duration_seconds: Any,
    ffmpeg_binary: Optional[str],
    *,
    max_seconds: Optional[float] = None,
    sample_rate: int = DEFAULT_AUDIO_SAMPLE_RATE,
) -> Dict[str, Any]:
    """Measure real one-second audio energy/silence with FFmpeg PCM output."""
    caps = capability_report(ffmpeg_binary)
    if not source or not caps["ffmpeg"]:
        return {
            "schemaVersion": INTELLIGENCE_SCHEMA_VERSION,
            "available": False,
            "reason": "ffmpeg_unavailable" if not caps["ffmpeg"] else "missing_source",
            "seconds": [],
            "coverageEndMs": 0,
        }
    limit = _bounded_duration(
        duration_seconds,
        max_seconds or _read_env_limit("CLIPPER_INTELLIGENCE_MAX_SECONDS", DEFAULT_MAX_ANALYSIS_SECONDS),
    )
    command = [
        str(ffmpeg_binary),
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-i",
        source,
        "-t",
        f"{limit:.3f}",
        "-vn",
        "-ac",
        "1",
        "-ar",
        str(sample_rate),
        "-f",
        "s16le",
        "-",
    ]
    try:
        process = subprocess.run(
            command,
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=max(35.0, min(900.0, limit * 1.25 + 25.0)),
        )
        raw = process.stdout or b""
        bytes_per_second = max(2, int(sample_rate) * 2)
        rows: List[Dict[str, Any]] = []
        for index, offset in enumerate(range(0, len(raw), bytes_per_second)):
            chunk = raw[offset:offset + bytes_per_second]
            if len(chunk) < 160:
                continue
            values = array("h")
            values.frombytes(chunk[: len(chunk) - (len(chunk) % 2)])
            if sys.byteorder != "little":
                values.byteswap()
            if not values:
                continue
            rms = math.sqrt(sum(float(sample) * float(sample) for sample in values) / len(values))
            dbfs = -96.0 if rms <= 1 else 20.0 * math.log10(rms / 32768.0)
            energy = _clamp(rms / 5_500.0)
            rows.append(
                {
                    "second": index,
                    "startMs": index * 1000,
                    "endMs": (index + 1) * 1000,
                    "rms": round(rms, 2),
                    "dbfs": round(max(-96.0, dbfs), 2),
                    "energy": round(energy, 4),
                    "silence": bool(dbfs <= -42.0),
                }
            )
        return {
            "schemaVersion": INTELLIGENCE_SCHEMA_VERSION,
            "available": bool(rows),
            "source": "ffmpeg_pcm",
            "sampleRate": sample_rate,
            "seconds": rows,
            "coverageEndMs": rows[-1]["endMs"] if rows else 0,
            "truncated": _number(duration_seconds) > limit,
            "analysisDurationMs": int(round(limit * 1000)),
        }
    except subprocess.TimeoutExpired:
        return {
            "schemaVersion": INTELLIGENCE_SCHEMA_VERSION,
            "available": False,
            "reason": "audio_timeout",
            "seconds": [],
            "coverageEndMs": 0,
        }
    except Exception as exc:
        return {
            "schemaVersion": INTELLIGENCE_SCHEMA_VERSION,
            "available": False,
            "reason": "audio_analysis_failed",
            "errorCode": type(exc).__name__,
            "seconds": [],
            "coverageEndMs": 0,
        }


def _opencv_module():
    try:
        import cv2  # type: ignore

        return cv2
    except Exception:
        return None


def _frame_metrics(cv2, frame, previous_gray=None, previous_hist=None) -> Tuple[Dict[str, float], Any, Any]:
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    height, width = gray.shape[:2]
    target_width = min(192, max(48, width))
    target_height = max(36, int(round(height * target_width / max(1, width))))
    small = cv2.resize(gray, (target_width, target_height))
    histogram = cv2.calcHist([small], [0], None, [32], [0, 256])
    cv2.normalize(histogram, histogram)
    brightness = float(small.mean()) / 255.0
    sharpness = _clamp(float(cv2.Laplacian(small, cv2.CV_64F).var()) / 550.0)
    motion = 0.0
    scene = 0.0
    if previous_gray is not None:
        motion = _clamp(float(cv2.absdiff(small, previous_gray).mean()) / 52.0)
    if previous_hist is not None:
        correlation = float(cv2.compareHist(previous_hist, histogram, cv2.HISTCMP_CORREL))
        scene = _clamp((1.0 - correlation) / 0.75)
    importance = _clamp(motion * 0.46 + scene * 0.34 + sharpness * 0.20)
    return {
        "brightness": round(brightness, 4),
        "sharpness": round(sharpness, 4),
        "motion": round(motion, 4),
        "sceneChange": round(scene, 4),
        "visualImportance": round(importance, 4),
    }, small, histogram


def _read_frame_at(cv2, capture, time_seconds: float):
    capture.set(cv2.CAP_PROP_POS_MSEC, max(0.0, time_seconds) * 1000.0)
    ok, frame = capture.read()
    return frame if ok else None


def _iter_frames_at_times(cv2, capture, times: Sequence[float]):
    """Yield requested frames in one forward decode pass.

    OpenCV's seek-to-time call usually decodes from a nearby keyframe. Calling
    it hundreds of times on a long H.264 master turns a lightweight adaptive
    pass into thousands of redundant decodes. The analysis proxy is low fps,
    so sequential decoding is both faster and bounded in memory.
    """
    ordered = sorted({max(0.0, float(value)) for value in times})
    if not ordered:
        return
    frame_rate = max(0.01, _number(capture.get(cv2.CAP_PROP_FPS), 0.0))
    capture.set(cv2.CAP_PROP_POS_FRAMES, 0)
    target_index = 0
    while target_index < len(ordered):
        ok, frame = capture.read()
        if not ok:
            break
        current_frame = max(0, int(round(_number(capture.get(cv2.CAP_PROP_POS_FRAMES), 1.0))) - 1)
        current_time = current_frame / frame_rate
        # A current frame can satisfy more than one rounded target. This is
        # rare for the 2fps proxy but guarantees monotonic, deterministic data.
        while target_index < len(ordered) and current_time + (0.5 / frame_rate) >= ordered[target_index]:
            yield ordered[target_index], frame
            target_index += 1


def _timestamps(duration: float, interval: float) -> List[float]:
    values = [0.0]
    position = interval
    while position < duration - 0.02:
        values.append(round(position, 3))
        position += interval
    if duration > 0.1:
        values.append(round(max(0.0, duration - 0.05), 3))
    return sorted(set(values))


def adaptive_visual_evidence(
    source: str,
    duration_seconds: Any,
    *,
    max_seconds: Optional[float] = None,
    max_base_samples: int = DEFAULT_MAX_BASE_SAMPLES,
    max_total_samples: int = DEFAULT_MAX_TOTAL_SAMPLES,
) -> Dict[str, Any]:
    """Analyse a local video using coarse frames plus dense samples near events.

    OpenCV is used only when present.  This is deliberately a local signal pass
    rather than a claim of semantic object/video understanding.
    """
    cv2 = _opencv_module()
    if cv2 is None:
        return {
            "schemaVersion": INTELLIGENCE_SCHEMA_VERSION,
            "available": False,
            "reason": "opencv_unavailable",
            "samples": [],
            "events": [],
            "coverageEndMs": 0,
        }
    if not _is_local_media(source):
        return {
            "schemaVersion": INTELLIGENCE_SCHEMA_VERSION,
            "available": False,
            "reason": "no_local_visual_source",
            "samples": [],
            "events": [],
            "coverageEndMs": 0,
        }

    limit = _bounded_duration(
        duration_seconds,
        max_seconds or _read_env_limit("CLIPPER_INTELLIGENCE_MAX_SECONDS", DEFAULT_MAX_ANALYSIS_SECONDS),
    )
    capture = cv2.VideoCapture(source)
    if not capture.isOpened():
        return {
            "schemaVersion": INTELLIGENCE_SCHEMA_VERSION,
            "available": False,
            "reason": "video_open_failed",
            "samples": [],
            "events": [],
            "coverageEndMs": 0,
        }
    try:
        frame_rate = _number(capture.get(cv2.CAP_PROP_FPS), 0.0)
        frame_count = _number(capture.get(cv2.CAP_PROP_FRAME_COUNT), 0.0)
        native_duration = frame_count / frame_rate if frame_rate > 0 else 0.0
        analysis_duration = min(limit, native_duration) if native_duration > 0 else limit
        if analysis_duration <= 0.05:
            raise RuntimeError("empty_video")

        # Coarse cadence adapts to long media.  A second dense pass is scheduled
        # only around genuinely high-motion / scene-change observations.
        interval = max(2.0, analysis_duration / max(1, int(max_base_samples)))
        coarse_times = _timestamps(analysis_duration, interval)
        coarse: List[Dict[str, Any]] = []
        previous_gray = previous_hist = None
        for time_seconds, frame in _iter_frames_at_times(cv2, capture, coarse_times):
            metrics, previous_gray, previous_hist = _frame_metrics(cv2, frame, previous_gray, previous_hist)
            coarse.append({"timeMs": int(round(time_seconds * 1000)), "sampleType": "coarse", **metrics})

        dense_times = set()
        for sample in coarse:
            if sample["sceneChange"] >= 0.28 or sample["motion"] >= 0.30:
                center = _number(sample["timeMs"]) / 1000.0
                for offset in (-0.80, -0.40, 0.40, 0.80):
                    value = round(center + offset, 3)
                    if 0.0 <= value <= analysis_duration:
                        dense_times.add(value)
        remaining = max(0, int(max_total_samples) - len(coarse_times))
        dense_ordered = sorted(dense_times)[:remaining]
        all_times = sorted(set(coarse_times + dense_ordered))

        samples: List[Dict[str, Any]] = []
        previous_gray = previous_hist = None
        coarse_set = {round(value, 3) for value in coarse_times}
        for time_seconds, frame in _iter_frames_at_times(cv2, capture, all_times):
            metrics, previous_gray, previous_hist = _frame_metrics(cv2, frame, previous_gray, previous_hist)
            samples.append(
                {
                    "timeMs": int(round(time_seconds * 1000)),
                    "sampleType": "coarse" if round(time_seconds, 3) in coarse_set else "dense",
                    **metrics,
                }
            )
        events: List[Dict[str, Any]] = []
        for sample in samples:
            if sample["sceneChange"] >= 0.30:
                events.append({"type": "scene_change", "timeMs": sample["timeMs"], "confidence": sample["sceneChange"]})
            elif sample["motion"] >= 0.36:
                events.append({"type": "high_motion", "timeMs": sample["timeMs"], "confidence": sample["motion"]})
        return {
            "schemaVersion": INTELLIGENCE_SCHEMA_VERSION,
            "available": bool(samples),
            "source": "opencv",
            "sampling": {
                "adaptive": True,
                "baseIntervalSeconds": round(interval, 3),
                "coarseSamples": len(coarse_times),
                "denseSamples": max(0, len(all_times) - len(coarse_times)),
                "totalSamples": len(samples),
            },
            "samples": samples,
            "events": events,
            "coverageEndMs": int(round(analysis_duration * 1000)),
            "truncated": _number(duration_seconds) > analysis_duration,
            "native": {"frameRate": round(frame_rate, 3), "frameCount": int(frame_count)},
        }
    except Exception as exc:
        return {
            "schemaVersion": INTELLIGENCE_SCHEMA_VERSION,
            "available": False,
            "reason": "visual_analysis_failed",
            "errorCode": type(exc).__name__,
            "samples": [],
            "events": [],
            "coverageEndMs": 0,
        }
    finally:
        capture.release()


def analyze_ocr_evidence(
    source: str,
    visual_evidence: Dict[str, Any],
    *,
    max_samples: int = 72,
) -> Dict[str, Any]:
    """Run OCR only on informative visual samples; keep output compact and factual."""
    cv2 = _opencv_module()
    if cv2 is None:
        return {"schemaVersion": INTELLIGENCE_SCHEMA_VERSION, "available": False, "reason": "opencv_unavailable", "samples": [], "coverageEndMs": 0}
    try:
        import pytesseract  # type: ignore

        if shutil.which("tesseract") is None:
            raise RuntimeError("tesseract_unavailable")
    except Exception as exc:
        return {
            "schemaVersion": INTELLIGENCE_SCHEMA_VERSION,
            "available": False,
            "reason": "ocr_unavailable",
            "errorCode": type(exc).__name__,
            "samples": [],
            "coverageEndMs": 0,
        }
    if not _is_local_media(source) or not visual_evidence.get("available"):
        return {"schemaVersion": INTELLIGENCE_SCHEMA_VERSION, "available": False, "reason": "no_visual_evidence", "samples": [], "coverageEndMs": 0}

    ranked = sorted(
        visual_evidence.get("samples") or [],
        key=lambda item: (_number(item.get("sceneChange")) * 0.58 + _number(item.get("motion")) * 0.30 + _number(item.get("sharpness")) * 0.12),
        reverse=True,
    )
    # A visually static document can still have useful OCR; include evenly
    # spaced samples once high-motion candidates have been selected.
    chosen: Dict[int, Dict[str, Any]] = {}
    for item in ranked[: max(1, max_samples // 2)]:
        chosen[_safe_int(item.get("timeMs"))] = item
    all_samples = visual_evidence.get("samples") or []
    stride = max(1, len(all_samples) // max(1, max_samples // 2))
    for item in all_samples[::stride]:
        if len(chosen) >= max_samples:
            break
        chosen[_safe_int(item.get("timeMs"))] = item

    capture = cv2.VideoCapture(source)
    if not capture.isOpened():
        return {"schemaVersion": INTELLIGENCE_SCHEMA_VERSION, "available": False, "reason": "video_open_failed", "samples": [], "coverageEndMs": 0}
    rows: List[Dict[str, Any]] = []
    try:
        for time_ms in sorted(chosen.keys()):
            frame = _read_frame_at(cv2, capture, time_ms / 1000.0)
            if frame is None:
                continue
            try:
                gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
                gray = cv2.resize(gray, None, fx=1.35, fy=1.35, interpolation=cv2.INTER_CUBIC)
                data = pytesseract.image_to_data(
                    gray,
                    output_type=pytesseract.Output.DICT,
                    config="--psm 6",
                    timeout=4,
                )
                tokens = []
                confidences = []
                for index, token in enumerate(data.get("text", [])):
                    clean = " ".join(str(token or "").split())
                    confidence = _number((data.get("conf") or [0])[index], -1)
                    if clean and confidence >= 38:
                        tokens.append(clean[:80])
                        confidences.append(confidence)
                text = " ".join(tokens).strip()
                if text:
                    rows.append(
                        {
                            "timeMs": time_ms,
                            "text": text[:420],
                            "wordCount": len(tokens),
                            "confidence": round(sum(confidences) / max(1, len(confidences)) / 100.0, 3),
                        }
                    )
            except Exception:
                # OCR can fail on a particular frame without invalidating the
                # rest of the visual analysis.
                continue
    finally:
        capture.release()
    return {
        "schemaVersion": INTELLIGENCE_SCHEMA_VERSION,
        "available": bool(rows),
        "source": "tesseract",
        "samples": rows,
        "coverageEndMs": max((item["timeMs"] for item in rows), default=0),
    }


def _normalise_words(words: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
    output: List[Dict[str, Any]] = []
    for raw in words or []:
        token = str(raw.get("word", raw.get("text", "")) or "").strip()
        if not token:
            continue
        start = max(0.0, _number(raw.get("start", raw.get("startMs", 0))) / (1000.0 if raw.get("startMs") is not None and raw.get("start") is None else 1.0))
        end_raw = raw.get("end", raw.get("endMs", start + 0.2))
        end = _number(end_raw)
        if raw.get("endMs") is not None and raw.get("end") is None:
            end /= 1000.0
        end = max(start + 0.04, end)
        output.append({"word": token[:100], "start": start, "end": end, "confidence": raw.get("confidence")})
    return sorted(output, key=lambda item: (item["start"], item["end"]))


def _mean(values: Sequence[Optional[float]]) -> Optional[float]:
    filtered = [float(value) for value in values if value is not None]
    return round(sum(filtered) / len(filtered), 4) if filtered else None


def _second_map(rows: Iterable[Dict[str, Any]], key: str = "second") -> Dict[int, List[Dict[str, Any]]]:
    mapped: Dict[int, List[Dict[str, Any]]] = {}
    for row in rows or []:
        second = _safe_int(row.get(key, _number(row.get("timeMs")) // 1000))
        mapped.setdefault(max(0, second), []).append(row)
    return mapped


def build_timeline_knowledge_graph(
    duration_seconds: Any,
    words: Iterable[Dict[str, Any]],
    *,
    audio_evidence: Optional[Dict[str, Any]] = None,
    visual_evidence: Optional[Dict[str, Any]] = None,
    ocr_evidence: Optional[Dict[str, Any]] = None,
    capabilities: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Build a durable, per-second cross-modal timeline graph.

    The graph preserves evidence provenance and exposes `None` for unavailable
    signals rather than converting missing providers into artificial zeroes.
    """
    normalised = _normalise_words(words)
    inferred_duration = max((item["end"] for item in normalised), default=0.0)
    duration = max(_number(duration_seconds), inferred_duration, 1.0)
    second_count = max(1, int(math.ceil(duration)))
    audio_evidence = audio_evidence or {}
    visual_evidence = visual_evidence or {}
    ocr_evidence = ocr_evidence or {}
    by_audio = _second_map(audio_evidence.get("seconds") or [])
    by_visual = _second_map(visual_evidence.get("samples") or [])
    by_ocr = _second_map(ocr_evidence.get("samples") or [])
    by_words: Dict[int, List[Dict[str, Any]]] = {index: [] for index in range(second_count)}
    for word in normalised:
        first = max(0, int(math.floor(word["start"])))
        last = min(second_count - 1, int(math.floor(max(word["start"], word["end"] - 0.001))))
        for index in range(first, last + 1):
            by_words.setdefault(index, []).append(word)

    segments: List[Dict[str, Any]] = []
    for second in range(second_count):
        word_rows = by_words.get(second, [])
        audio_rows = by_audio.get(second, []) if audio_evidence.get("available") else []
        visual_rows = by_visual.get(second, []) if visual_evidence.get("available") else []
        ocr_rows = by_ocr.get(second, []) if ocr_evidence.get("available") else []
        transcript = " ".join(row["word"] for row in word_rows).strip()
        word_count = len(word_rows)
        transcript_confidence = _mean([_number(row.get("confidence")) if row.get("confidence") is not None else None for row in word_rows])
        energy = _mean([_number(row.get("energy")) for row in audio_rows])
        silence = bool(audio_rows) and all(bool(row.get("silence")) for row in audio_rows)
        motion = _mean([_number(row.get("motion")) for row in visual_rows])
        scene_change = _mean([_number(row.get("sceneChange")) for row in visual_rows])
        sharpness = _mean([_number(row.get("sharpness")) for row in visual_rows])
        brightness = _mean([_number(row.get("brightness")) for row in visual_rows])
        visual_importance = _mean([_number(row.get("visualImportance")) for row in visual_rows])
        ocr_text = " ".join(str(row.get("text") or "") for row in ocr_rows).strip()[:600]
        ocr_confidence = _mean([_number(row.get("confidence")) for row in ocr_rows])

        text_signal = _clamp(word_count / 16.0)
        punctuation_signal = 0.16 if ("?" in transcript or "!" in transcript) else 0.0
        visual_signal = visual_importance if visual_importance is not None else 0.0
        audio_signal = energy if energy is not None else 0.0
        ocr_signal = _clamp(len(ocr_text.split()) / 10.0) if ocr_text else 0.0
        hook = _clamp(text_signal * 0.50 + punctuation_signal + visual_signal * 0.22 + audio_signal * 0.12 + ocr_signal * 0.08)
        retention = _clamp(text_signal * 0.42 + visual_signal * 0.30 + audio_signal * 0.18 + ocr_signal * 0.10)
        quality = _clamp((sharpness or 0.0) * 0.55 + (0.30 if not silence else 0.0) + (0.15 if word_count else 0.0))
        importance = _clamp(hook * 0.45 + retention * 0.35 + quality * 0.20)
        segments.append(
            {
                "second": second,
                "startMs": second * 1000,
                "endMs": (second + 1) * 1000,
                "transcript": {
                    "text": transcript,
                    "wordCount": word_count,
                    "speech": bool(word_count),
                    "confidence": transcript_confidence,
                },
                "audio": {
                    "available": bool(audio_rows),
                    "energy": energy,
                    "silence": silence if audio_rows else None,
                },
                "visual": {
                    "available": bool(visual_rows),
                    "motion": motion,
                    "sceneChange": scene_change,
                    "sharpness": sharpness,
                    "brightness": brightness,
                    "importance": visual_importance,
                },
                "ocr": {
                    "available": bool(ocr_rows),
                    "text": ocr_text,
                    "confidence": ocr_confidence,
                },
                "scores": {
                    "hook": round(hook * 100.0, 1),
                    "retention": round(retention * 100.0, 1),
                    "quality": round(quality * 100.0, 1),
                    "importance": round(importance * 100.0, 1),
                },
            }
        )

    events: List[Dict[str, Any]] = []
    for event in visual_evidence.get("events") or []:
        events.append({"modality": "vision", **event})
    for row in ocr_evidence.get("samples") or []:
        events.append({"modality": "ocr", "type": "detected_text", "timeMs": _safe_int(row.get("timeMs")), "confidence": _number(row.get("confidence")), "text": str(row.get("text") or "")[:180]})
    for row in audio_evidence.get("seconds") or []:
        if _number(row.get("energy")) >= 0.78:
            events.append({"modality": "audio", "type": "high_energy", "timeMs": _safe_int(row.get("startMs")), "confidence": _number(row.get("energy"))})
    events.sort(key=lambda item: (_safe_int(item.get("timeMs")), str(item.get("type"))))

    return {
        "schemaVersion": TIMELINE_SCHEMA_VERSION,
        "intelligenceSchemaVersion": INTELLIGENCE_SCHEMA_VERSION,
        "granularityMs": 1000,
        "durationMs": int(round(duration * 1000)),
        "modalities": {
            "transcript": {"available": bool(normalised), "wordCount": len(normalised)},
            "audio": {"available": bool(audio_evidence.get("available")), "coverageEndMs": _safe_int(audio_evidence.get("coverageEndMs"))},
            "vision": {"available": bool(visual_evidence.get("available")), "coverageEndMs": _safe_int(visual_evidence.get("coverageEndMs"))},
            "ocr": {"available": bool(ocr_evidence.get("available")), "coverageEndMs": _safe_int(ocr_evidence.get("coverageEndMs"))},
        },
        "capabilities": capabilities or {},
        "segments": segments,
        "events": events,
        "summary": {
            "segmentCount": len(segments),
            "eventCount": len(events),
            "highImportanceSeconds": sum(1 for item in segments if _number(item["scores"].get("importance")) >= 65.0),
        },
    }


def enrich_candidates_with_timeline(
    candidates: Iterable[Dict[str, Any]],
    timeline: Optional[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    """Conservatively enrich existing transcript rankings with real evidence.

    It never penalises a candidate merely because a local provider was not
    installed or a remote source could not be decoded.
    """
    output: List[Dict[str, Any]] = []
    if not isinstance(timeline, dict):
        return [dict(candidate) for candidate in candidates or []]
    segments = timeline.get("segments") or []
    modality = timeline.get("modalities") or {}
    evidence_available = bool(modality.get("audio", {}).get("available") or modality.get("vision", {}).get("available") or modality.get("ocr", {}).get("available"))
    if not evidence_available:
        return [dict(candidate) for candidate in candidates or []]

    for candidate in candidates or []:
        item = dict(candidate)
        start_ms = max(0, int(round(_number(item.get("start")) * 1000)))
        end_ms = max(start_ms + 1, int(round(_number(item.get("end")) * 1000)))
        relevant = [row for row in segments if _safe_int(row.get("endMs")) > start_ms and _safe_int(row.get("startMs")) < end_ms]
        if not relevant:
            output.append(item)
            continue
        visual_values = [row.get("visual", {}).get("importance") for row in relevant if row.get("visual", {}).get("available")]
        audio_values = [row.get("audio", {}).get("energy") for row in relevant if row.get("audio", {}).get("available")]
        ocr_values = [1.0 if row.get("ocr", {}).get("text") else 0.0 for row in relevant if row.get("ocr", {}).get("available")]
        hook_values = [_number(row.get("scores", {}).get("hook")) / 100.0 for row in relevant]
        retention_values = [_number(row.get("scores", {}).get("retention")) / 100.0 for row in relevant]
        parts: List[Tuple[float, float]] = []
        if visual_values:
            parts.append((0.42, _mean(visual_values) or 0.0))
        if audio_values:
            parts.append((0.22, _mean(audio_values) or 0.0))
        if ocr_values:
            parts.append((0.08, _mean(ocr_values) or 0.0))
        # Hook/retention scores are derived from the same per-second graph,
        # and only participate when at least one independent modality exists.
        if parts:
            parts.extend(((0.15, _mean(hook_values) or 0.0), (0.13, _mean(retention_values) or 0.0)))
        if not parts:
            output.append(item)
            continue
        weight_total = sum(weight for weight, _value in parts)
        multimodal = _clamp(sum(weight * value for weight, value in parts) / max(weight_total, 0.001)) * 100.0
        baseline = _number(item.get("score"), 50.0)
        final_score = int(round(_clamp(baseline, 1.0, 100.0) * 0.76 + multimodal * 0.24))
        evidence = {
            "visualScore": round((_mean(visual_values) or 0.0) * 100.0, 1) if visual_values else None,
            "audioScore": round((_mean(audio_values) or 0.0) * 100.0, 1) if audio_values else None,
            "ocrCoverage": round((_mean(ocr_values) or 0.0) * 100.0, 1) if ocr_values else None,
            "hookScore": round((_mean(hook_values) or 0.0) * 100.0, 1),
            "retentionScore": round((_mean(retention_values) or 0.0) * 100.0, 1),
            "multimodalScore": round(multimodal, 1),
            "evidenceSeconds": len(relevant),
        }
        item["multimodal_evidence"] = evidence
        item["score"] = max(1, min(100, final_score))
        source = str(item.get("score_source") or "local")
        item["score_source"] = f"{source}+timeline" if "timeline" not in source else source
        existing_reason = str(item.get("reason") or "").strip()
        evidence_bits = []
        if visual_values:
            evidence_bits.append("visual activity")
        if audio_values:
            evidence_bits.append("audio energy")
        if ocr_values:
            evidence_bits.append("on-screen text")
        suffix = f" Timeline evidence: {', '.join(evidence_bits)}." if evidence_bits else ""
        item["reason"] = f"{existing_reason}{suffix}".strip()[:220]
        output.append(item)
    return sorted(output, key=lambda item: _number(item.get("score")), reverse=True)


def retrieve_visual_candidate_windows(
    timeline: Optional[Dict[str, Any]],
    duration_seconds: Any,
    target_duration_seconds: Any,
    *,
    limit: int = 10,
) -> List[Dict[str, Any]]:
    """Provide diverse *windows to verify*, not unearned semantic matches.

    The bounded local pass can tell us where visual activity, cuts, OCR, or
    changes occur, but it cannot name an action.  We use it only to give a
    provisioned temporal model a broad, diverse set of short candidate windows
    to inspect.  Each returned window is explicitly labelled as retrieval
    evidence, and only the downstream verifier may call it an exact match.
    """
    if not isinstance(timeline, dict):
        return []
    modalities = timeline.get("modalities") or {}
    if not bool((modalities.get("vision") or {}).get("available")):
        return []
    segments = [row for row in (timeline.get("segments") or []) if isinstance(row, dict)]
    if not segments:
        return []
    duration = max(1.0, _number(duration_seconds, _number(timeline.get("durationMs"), 1_000.0) / 1_000.0))
    window = max(5.0, min(duration, _number(target_duration_seconds, 20.0)))
    maximum = max(2, min(16, _safe_int(limit, 10)))
    # Score timestamps using only measured local evidence.  OCR changes and
    # shot transitions are intentionally considered because a requested item
    # commonly enters at one of those boundaries.
    ranked_seconds: List[Tuple[float, int]] = []
    for row in segments:
        visual = row.get("visual") or {}
        score = (
            _number(visual.get("importance")) * 0.48
            + _number(visual.get("motion")) * 0.24
            + _number(visual.get("sceneChange")) * 0.20
            + (0.08 if str((row.get("ocr") or {}).get("text") or "").strip() else 0.0)
        )
        ranked_seconds.append((score, _safe_int(row.get("startMs")) // 1000))
    ranked_seconds.sort(key=lambda item: (-item[0], item[1]))

    seed_seconds: List[int] = []
    separation = max(3, int(round(window * 0.60)))
    for _score, second in ranked_seconds:
        if all(abs(second - existing) >= separation for existing in seed_seconds):
            seed_seconds.append(second)
        if len(seed_seconds) >= maximum:
            break
    # A visual event can be calm (for example, a product first appearing).
    # Fill unrepresented temporal regions so the verifier sees broad coverage
    # instead of only fast cuts and high motion.
    uniform_count = max(2, min(maximum, int(math.ceil(duration / max(window * 5.0, 1.0)))))
    for index in range(uniform_count):
        second = int(round(((index + 0.5) / uniform_count) * duration))
        if all(abs(second - existing) >= separation for existing in seed_seconds):
            seed_seconds.append(second)
        if len(seed_seconds) >= maximum:
            break

    results: List[Dict[str, Any]] = []
    for index, second in enumerate(sorted(seed_seconds)):
        start = max(0.0, min(max(0.0, duration - window), second - window * 0.35))
        end = min(duration, start + window)
        relevant = [
            row for row in segments
            if _safe_int(row.get("endMs")) > int(round(start * 1000))
            and _safe_int(row.get("startMs")) < int(round(end * 1000))
        ]
        transcript = " ".join(str((row.get("transcript") or {}).get("text") or "") for row in relevant).strip()
        evidence_score = max(
            [_number((row.get("scores") or {}).get("importance")) for row in relevant] or [0.0]
        )
        results.append({
            "id": f"visual-window-{index + 1}",
            "start": round(start, 3),
            "end": round(end, 3),
            "score": int(max(1, min(100, round(42.0 + evidence_score * 0.45)))),
            "title": "Visually verified moment candidate",
            "transcript": transcript[:1_000],
            "reason": "Visual temporal search window — requires deep verification before selection.",
            "score_source": "visual-retrieval-window",
            "visual_retrieval": {
                "candidateOnly": True,
                "windowCoverage": "adaptive visual events plus temporal diversity",
                "localEvidenceScore": round(evidence_score, 1),
            },
        })
    return results


def intelligence_summary(
    audio_evidence: Dict[str, Any],
    visual_evidence: Dict[str, Any],
    ocr_evidence: Dict[str, Any],
    timeline: Dict[str, Any],
) -> Dict[str, Any]:
    """Small renderer-safe progress payload; raw evidence remains in artifacts."""
    return {
        "audio": {"available": bool(audio_evidence.get("available")), "seconds": len(audio_evidence.get("seconds") or [])},
        "vision": {"available": bool(visual_evidence.get("available")), "samples": len(visual_evidence.get("samples") or []), "events": len(visual_evidence.get("events") or [])},
        "ocr": {"available": bool(ocr_evidence.get("available")), "samples": len(ocr_evidence.get("samples") or [])},
        "timeline": {"segments": len(timeline.get("segments") or []), "events": len(timeline.get("events") or [])},
    }


def parse_moment_query(request: Any) -> Dict[str, Any]:
    """Translate a user request into evidence requirements, not timestamps.

    This is intentionally conservative: language can plan a search but cannot
    turn a transcript mention into proof that a visual event occurred.
    """
    original = " ".join(str(request or "").split())
    text = original.lower()
    spoken_markers = ("say", "says", "said", "talk", "talks", "mention", "mentions", "explain", "explains", "discuss", "discussion", "pricing", "quote")
    visual_patterns = (
        r"\b(?:laugh|laughs|laughing|leave|leaves|leaving|exit|exits|exiting|enter|enters|entering|walk|walks|walking|run|runs|running|bend|bends|bending|appear|appears|appearing|crash|crashes|crashing|cross|crosses|crossing|finish|finishes|finishing|jump|jumps|jumping|fall|falls|falling|boost|boosts|boosting)\b",
        r"\b(?:point|points|pointing)\s+(?:at|to)\b",
        r"\b(?:show|shows|showing)\s+(?:the|a|an|me|us)\b",
        r"\b(?:see|sees|seeing|look|looks|looking)\b",
        r"\b(?:animal|car|product|object|screen)\b",
    )
    transition_markers = ("leave", "exit", "enter", "appear", "first appears", "after", "before", "starts", "begins", "crash", "collision", "cross", "finish", "jump", "fall", "boost")
    physical_action = any(re.search(pattern, text) for pattern in visual_patterns)
    temporal_language = bool(re.search(r"\b(?:when|after|before|then)\b", text))
    # “when he explains…” still has a semantic transcript answer.  Temporal
    # language becomes visual-only only when it is coupled to a physical event.
    needs_visual = physical_action or (temporal_language and not any(marker in text for marker in spoken_markers))
    needs_temporal = needs_visual and any(marker in text for marker in transition_markers)
    needs_transcript = any(marker in text for marker in spoken_markers) or not needs_visual
    requested_duration = None
    duration_match = re.search(r"\b(?:under|less than|about|around)?\s*(\d{1,3})\s*(?:s|sec|secs|second|seconds)\b", text)
    if duration_match:
        requested_duration = int(duration_match.group(1)) * 1000
    actions = [
        token for token in (
            "laugh", "leave", "exit", "enter", "walk", "run", "bend", "appear", "crash", "cross", "finish", "jump", "fall", "boost"
        ) if re.search(rf"\b{token}(?:es|s|ing|ed)?\b", text)
    ]
    if re.search(r"\b(?:point|points|pointing)\s+(?:at|to)\b", text):
        actions.append("point")
    if re.search(r"\b(?:show|shows|showing)\s+(?:the|a|an|me|us)\b", text):
        actions.append("show")
    # Keep an explicitly requested spoken phrase separate from the general
    # planner prompt.  It becomes a deterministic evidence requirement below;
    # a transcript query cannot be treated as satisfied merely because a clip
    # contains *some* speech.
    spoken_terms: List[str] = []
    spoken_match = re.search(
        r"\b(?:say|says|said|mention|mentions|mentioned|explain|explains|explained|discuss|discusses|discussed|talk|talks|talked)\b\s+[\"'“”]?(.+)",
        original,
        flags=re.IGNORECASE,
    )
    if spoken_match:
        phrase = re.split(r"\b(?:then|and then|while|but)\b|[.!?]", spoken_match.group(1), maxsplit=1, flags=re.IGNORECASE)[0]
        phrase = phrase.strip(" \t\n\r,;:\"'“”")
        phrase_tokens = re.findall(r"[A-Za-z0-9]+", phrase.lower())
        # One generic filler term (for example "something") is not useful
        # evidence.  Preserve actual phrases and keywords instead.
        if phrase_tokens and not (len(phrase_tokens) == 1 and phrase_tokens[0] in {"something", "it", "that", "this"}):
            spoken_terms = phrase_tokens[:12]
    return {
        "schemaVersion": MOMENT_QUERY_SCHEMA_VERSION,
        "originalQuery": original,
        "actions": actions,
        "requires": {
            "transcript": needs_transcript,
            "visual": needs_visual,
            "temporal": needs_temporal,
            "audio": any(token in text for token in ("laugh", "shout", "quiet", "silence", "music")),
        },
        "requiredBeforeState": ["context immediately before the requested event"] if needs_temporal else [],
        "requiredEventState": actions if needs_visual else [],
        "requiredAfterState": ["requested event completes or resolves"] if needs_temporal else [],
        "spokenTerms": spoken_terms,
        "desiredDurationMs": requested_duration,
    }


def deep_verifier_capability(resource_profile: Any = "8gb_cpu") -> Dict[str, Any]:
    """Describe an optional temporal verifier without downloading model weights.

    A model is deliberately opt-in.  Downloading multi-gigabyte weights in an
    Electron request would violate the memory and predictability guarantees of
    the local clipper.  A configured worker receives structured candidate
    evidence and returns a strict, machine-verifiable decision.
    """
    worker = str(os.environ.get("CLYRA_QWEN3_VL_VERIFIER", "")).strip()
    qwen = {
        "provider": "qwen3-vl",
        "available": bool(worker and os.path.isfile(worker) and os.access(worker, os.X_OK)),
        "workerConfigured": bool(worker),
        "mode": "isolated-worker",
        "reason": None if worker and os.path.isfile(worker) and os.access(worker, os.X_OK) else "qwen3_vl_worker_not_configured",
    }
    if qwen["available"]:
        return qwen
    # The requested video-understanding-local integration deliberately runs
    # only after Clyra's efficient index has narrowed the request to a small
    # candidate window.  In the ordinary 8 GB profile it stays disabled and
    # visual exact-match requests still fail closed rather than guessing.
    return video_understanding_capability_report(resource_profile)


def verify_event_candidate(
    request_plan: Dict[str, Any],
    candidate: Dict[str, Any],
    timeline: Optional[Dict[str, Any]],
    *,
    source_path: Optional[str] = None,
    resource_profile: Any = "8gb_cpu",
) -> Dict[str, Any]:
    """Require a configured temporal visual verifier for visual exact matches.

    The worker protocol is intentionally narrow: its output must contain a
    before/during/after verdict.  Unavailable or malformed results are a safe
    non-match, never a guessed clip.
    """
    requires = (request_plan or {}).get("requires") or {}
    candidate_bounds = {
        "startMs": int(round(_number(candidate.get("start")) * 1000)),
        "endMs": int(round(_number(candidate.get("end")) * 1000)),
    }
    if not requires.get("visual"):
        terms = [str(token).lower() for token in (request_plan or {}).get("spokenTerms") or [] if str(token).strip()]
        if terms:
            start_ms, end_ms = candidate_bounds["startMs"], candidate_bounds["endMs"]
            rows = [
                row for row in ((timeline or {}).get("segments") or [])
                if _safe_int(row.get("endMs")) > start_ms and _safe_int(row.get("startMs")) < end_ms
            ]
            transcript = " ".join(str((row.get("transcript") or {}).get("text") or "") for row in rows).lower()
            transcript_tokens = re.findall(r"[a-z0-9]+", transcript)
            # Phrase order matters for a quoted or specific spoken request;
            # use a subsequence rather than a loose topic bag.
            cursor = 0
            for token in transcript_tokens:
                if cursor < len(terms) and token == terms[cursor]:
                    cursor += 1
            exact = cursor == len(terms)
            return {
                "exactMatch": exact,
                "verificationLevel": "transcript",
                "candidate": candidate_bounds,
                "constraintsSatisfied": ["spoken phrase matched in the candidate transcript"] if exact else [],
                "reason": None if exact else "spoken_phrase_not_present_in_candidate",
                "transcriptEvidence": transcript[:600],
                "warnings": [] if exact else ["The requested spoken phrase was not found in this candidate transcript."],
            }
        return {
            "exactMatch": True,
            "verificationLevel": "transcript-or-audio",
            "candidate": candidate_bounds,
            "constraintsSatisfied": ["request does not require visual state verification"],
            "warnings": [],
        }
    capability = deep_verifier_capability(resource_profile)
    if not capability["available"]:
        return {
            "exactMatch": False,
            "verificationLevel": "unavailable",
            "candidate": candidate_bounds,
            "reason": capability["reason"],
            "constraintsSatisfied": [],
            "warnings": [
                "This request needs temporal visual verification; no configured isolated verifier is available for this resource profile."
            ],
        }
    if capability.get("provider") == "video-understanding-local":
        provider_result = verify_with_video_understanding(
            request_plan,
            candidate,
            source_path=source_path,
            resource_profile=resource_profile,
        )
        response = provider_result.get("verdict") or {}
        if not provider_result.get("available"):
            return {
                "exactMatch": False,
                "verificationLevel": "unavailable",
                "candidate": candidate_bounds,
                "reason": provider_result.get("reason", "video_understanding_local_unavailable"),
                "constraintsSatisfied": [],
                "warnings": list(response.get("warnings") or []) + [
                    "Temporal visual verification did not return usable structured evidence."
                ],
            }
        required = ("event_present", "before_state_verified", "transition_verified", "after_state_verified")
        exact = bool(response.get("structured")) and all(bool(response.get(key)) for key in required)
        return {
            "exactMatch": exact,
            "verificationLevel": "video-understanding-local",
            "candidate": candidate_bounds,
            "reason": "verified" if exact else "visual_state_unverified",
            "constraintsSatisfied": list(response.get("constraintsSatisfied") or []),
            "warnings": list(response.get("warnings") or []),
            "visualEvidence": list(response.get("visual_evidence") or [])[:8],
            "audioEvidence": list(response.get("audio_evidence") or [])[:8],
            "ocrEvidence": list(response.get("ocr_evidence") or [])[:8],
            "confidence": _clamp(response.get("confidence")),
        }
    payload = {
        "schemaVersion": MOMENT_QUERY_SCHEMA_VERSION,
        "request": request_plan,
        "candidate": candidate_bounds,
        "sourcePath": source_path or "",
        "timeline": timeline or {},
    }
    try:
        process = subprocess.run(
            [str(os.environ["CLYRA_QWEN3_VL_VERIFIER"])],
            input=json.dumps(payload),
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=120,
            check=True,
        )
        response = json.loads(process.stdout)
    except Exception as exc:
        return {
            "exactMatch": False,
            "verificationLevel": "failed",
            "candidate": candidate_bounds,
            "reason": f"verifier_{type(exc).__name__.lower()}",
            "constraintsSatisfied": [],
            "warnings": ["Temporal visual verification did not return a valid result."],
        }
    required = ("event_present", "before_state_verified", "transition_verified", "after_state_verified")
    exact = all(bool(response.get(key)) for key in required)
    return {
        "exactMatch": exact,
        "verificationLevel": "qwen3-vl",
        "candidate": candidate_bounds,
        "reason": "verified" if exact else "visual_state_unverified",
        "constraintsSatisfied": list(response.get("constraintsSatisfied") or []),
        "warnings": list(response.get("warnings") or []),
        "visualEvidence": list(response.get("visual_evidence") or [])[:8],
        "audioEvidence": list(response.get("audio_evidence") or [])[:8],
        "confidence": _clamp(response.get("confidence")),
    }
