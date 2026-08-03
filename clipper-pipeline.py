#!/usr/bin/env python3
"""AI clipper pipeline with word-accurate subtitles.

Captions are used for fast moment selection only. Subtitle timing comes from
Whisper word timestamps generated from the exact clipped audio/video file, then
burned onto that same file so words line up with the final MP4.
"""

import hashlib
import html
import json
import math
import os
import re
import signal
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET

from clipper_face_tracking import (
    annotate_scenes,
    build_crop_filter,
    capability_report as face_capability_report,
    build_smart_reframe_keyframes,
    face_tracking_config,
    filter_candidates_by_scenes,
    probe_video_size,
    scan_people,
    track_faces_and_build_crops,
)
from clipper_intelligence import (
    INTELLIGENCE_SCHEMA_VERSION,
    TIMELINE_SCHEMA_VERSION,
    adaptive_visual_evidence,
    analyze_audio_evidence,
    analyze_ocr_evidence,
    build_timeline_knowledge_graph,
    capability_report as intelligence_capability_report,
    deep_verifier_capability,
    enrich_candidates_with_timeline,
    intelligence_summary,
    parse_moment_query,
    prepare_visual_source,
    retrieve_visual_candidate_windows,
    verify_event_candidate,
)


TMP_ROOT = "./tmp"
ARTIFACT_CACHE_DIR = "clipper-cache"
CLIP_ARTIFACT_DIR = "clipper-artifacts"


def resolve_output_dir():
    """Prefer the Electron/data root so renders land where Express serves them."""
    explicit = (os.environ.get("CLYRA_OUTPUT_DIR") or "").strip()
    if explicit:
        return explicit
    data_root = (os.environ.get("CLYRA_DATA_ROOT") or "").strip()
    if data_root:
        return os.path.join(data_root, "output")
    return "./output"


OUTPUT_DIR = resolve_output_dir()
OUTPUT_WIDTH = 1080
OUTPUT_HEIGHT = 1920
OUTPUT_FPS = 30
MAX_CLIP_LENGTH = 60.0
# Clyra's automatic clips are complete, reviewable scenes rather than the
# 6–15 second fragments used by the old picker. A directed whole-section
# request remains allowed to end at the next real section boundary instead of
# quietly spilling into a different method.
MIN_AUTOMATIC_CLIP_LENGTH = 30.0
# Final renders deliberately use a considerably higher quality target than the
# small, disposable analysis plate.  Keep this as one named contract so the
# first render and any later caption refinement cannot quietly diverge.
RENDER_QUALITY_PROFILES = {
    # Premium is the normal delivery default.  It deliberately leaves more
    # detail for a social platform's *next* encode instead of targeting the
    # low 1–2 Mbps files produced by the former clip path.
    "premium": {"crf": "10", "preset": "veryslow", "audio_bitrate": "320k"},
    "balanced": {"crf": "16", "preset": "slow", "audio_bitrate": "256k"},
    "master": {"crf": "8", "preset": "veryslow", "audio_bitrate": "320k"},
}
_FASTER_WHISPER_MODEL = None
_OPENAI_WHISPER_MODEL = None
_CANCEL_REQUESTED = False


class PipelineCancelled(KeyboardInterrupt):
    """Raised for a client-initiated stop without treating it as a failure.

    This intentionally inherits from ``KeyboardInterrupt`` rather than
    ``Exception``.  Several optional intelligence providers soft-fail ordinary
    exceptions into an "unavailable" evidence artifact; a cancellation must
    propagate through those providers so the job finally block can clean up
    transient render files instead of caching a false negative.
    """


def _request_cancel(_signal_number, _frame):
    global _CANCEL_REQUESTED
    _CANCEL_REQUESTED = True
    raise PipelineCancelled("Cancelled by client")


def install_cancellation_handlers():
    """Make SIGTERM from a disconnected SSE client run Python cleanup."""
    for signal_name in ("SIGTERM", "SIGINT"):
        candidate = getattr(signal, signal_name, None)
        if candidate is not None:
            signal.signal(candidate, _request_cancel)


def check_cancelled():
    if _CANCEL_REQUESTED:
        raise PipelineCancelled("Cancelled by client")


def emit(step, status, **data):
    print(json.dumps({"type": "progress", "step": step, "status": status, **data}), flush=True)


def fail(message):
    print(json.dumps({"type": "error", "message": message}), flush=True)
    sys.exit(1)


def resolve_ffmpeg():
    candidates = [
        os.environ.get("FFMPEG_BINARY"),
        os.path.join(os.path.expanduser("~"), "bin", "ffmpeg"),
        shutil.which("ffmpeg"),
    ]
    for candidate in candidates:
        if candidate and os.path.exists(candidate):
            return candidate
    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return "ffmpeg"


FFMPEG = resolve_ffmpeg()


def resolve_ffprobe():
    candidates = [
        os.environ.get("FFPROBE_BINARY"),
        shutil.which("ffprobe"),
    ]
    if FFMPEG and FFMPEG != "ffmpeg":
        candidates.insert(1, os.path.join(os.path.dirname(os.path.abspath(FFMPEG)), "ffprobe"))
    for candidate in candidates:
        if candidate and os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    return None


FFPROBE = resolve_ffprobe()


def expose_ffmpeg_to_subprocesses():
    if not FFMPEG or FFMPEG == "ffmpeg":
        return
    ffmpeg_dir = os.path.dirname(os.path.abspath(FFMPEG))
    path_parts = os.environ.get("PATH", "").split(os.pathsep)
    if ffmpeg_dir not in path_parts:
        os.environ["PATH"] = os.pathsep.join([ffmpeg_dir, *path_parts])


def clean_name(value):
    name = re.sub(r"[^\w\s-]", "", value or "clip").strip()
    name = re.sub(r"\s+", "-", name).lower()[:50]
    return name or "clip"


def source_fingerprint(source):
    """Use a stable source identity so analysis survives an interrupted render."""
    try:
        if os.path.isfile(source):
            stat = os.stat(source)
            source = f"{os.path.abspath(source)}:{stat.st_size}:{int(stat.st_mtime)}"
    except OSError:
        pass
    return hashlib.sha256(str(source).encode("utf-8")).hexdigest()[:24]


def read_json(path, fallback=None):
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError, TypeError):
        return fallback


def write_json(path, payload):
    """Write an artifact atomically without cross-job staging-file collisions."""
    directory = os.path.dirname(path)
    os.makedirs(directory, exist_ok=True)
    descriptor, staging = tempfile.mkstemp(prefix=f".{os.path.basename(path)}.", suffix=".tmp", dir=directory, text=True)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
        os.replace(staging, path)
    finally:
        try:
            os.unlink(staging)
        except FileNotFoundError:
            pass


def intelligence_cache_valid(payload, schema_version, *, minimum_coverage_ms=None):
    """Return true only for a compatible, sufficiently covered artifact.

    A cache from a deliberately short analysis pass must not masquerade as a
    full pass when the user later increases the analysis cap.  Unavailable
    providers remain cacheable: callers already retry them when the provider
    becomes available.
    """
    if not isinstance(payload, dict) or payload.get("schemaVersion") != schema_version:
        return False
    if not payload.get("available") or minimum_coverage_ms is None:
        return True
    try:
        coverage = int(payload.get("coverageEndMs") or 0)
        required = max(0, int(minimum_coverage_ms))
    except (TypeError, ValueError):
        return False
    # Frame/audio evidence can finish a fraction short of the nominal duration
    # because a source ends between sampling boundaries.
    return coverage >= max(0, required - 1_000)


def analysis_coverage_ms(duration_seconds, limit_seconds):
    try:
        duration = max(0.0, float(duration_seconds))
        limit = max(1.0, float(limit_seconds))
    except (TypeError, ValueError):
        return 0
    return int(round(min(duration, limit) * 1_000))


def normalise_words(words):
    """Normalise captions and Whisper output into one timestamp representation."""
    output = []
    for raw in words or []:
        token = str(raw.get("word", raw.get("text", ""))).strip()
        if not token:
            continue
        try:
            start = max(0.0, float(raw.get("start", raw.get("startMs", 0)) or 0))
            end = max(start + 0.04, float(raw.get("end", raw.get("endMs", start + 0.2)) or start + 0.2))
        except (TypeError, ValueError):
            continue
        output.append({
            "word": token[:80],
            "start": round(start, 3),
            "end": round(end, 3),
            "confidence": raw.get("confidence"),
            "speakerId": raw.get("speakerId"),
        })
    return sorted(output, key=lambda word: (word["start"], word["end"]))


def fmt_time(seconds):
    minutes = int(seconds // 60)
    return f"{minutes}:{int(seconds % 60):02d}"


def parse_duration(value, default=MAX_CLIP_LENGTH):
    try:
        return min(MAX_CLIP_LENGTH, max(MIN_AUTOMATIC_CLIP_LENGTH, float(value)))
    except (TypeError, ValueError):
        return min(MAX_CLIP_LENGTH, max(MIN_AUTOMATIC_CLIP_LENGTH, float(default)))


def _available_clip_duration(video_duration):
    """Return a finite source length suitable for clip-boundary math."""
    try:
        return max(0.5, float(video_duration))
    except (TypeError, ValueError):
        return 0.5


def minimum_automatic_duration(video_duration):
    """Use 30 seconds unless the actual source is genuinely shorter."""
    return min(MIN_AUTOMATIC_CLIP_LENGTH, _available_clip_duration(video_duration))


def enforce_minimum_candidate_duration(candidate, video_duration):
    """Expand an automatic candidate around its evidence to the 30s floor.

    Sentence repair can correctly locate a five-second hook, but an automatic
    result should retain enough surrounding scene for a user to review and
    edit. Extend right first (preserving the hook's setup), then left only if
    the source end prevents a complete 30-second plate. The source itself is
    never exceeded.
    """
    item = dict(candidate)
    source_duration = _available_clip_duration(video_duration)
    required = minimum_automatic_duration(source_duration)
    start = max(0.0, min(source_duration, float(item.get("start", 0.0))))
    end = max(start, min(source_duration, float(item.get("end", start))))
    if end - start + 0.001 >= required:
        item["start"] = round(start, 2)
        item["end"] = round(end, 2)
        return item
    original_start, original_end = start, end
    end = min(source_duration, start + required)
    if end - start + 0.001 < required:
        start = max(0.0, end - required)
    item["start"] = round(start, 2)
    item["end"] = round(end, 2)
    item["minimum_duration_extended"] = True
    item["minimum_duration_context"] = {
        "fromStart": round(original_start, 2),
        "fromEnd": round(original_end, 2),
        "minimumSeconds": round(required, 2),
    }
    return item


def _config_seconds(cfg, snake_key, camel_key):
    """Read an optional finite duration from a JSON job config.

    Keep the validation here rather than letting FFmpeg interpret arbitrary
    strings.  It makes user-directed ranges safe for both Electron IPC and
    direct worker invocations.
    """
    value = cfg.get(snake_key)
    if value is None:
        value = cfg.get(camel_key)
    if value is None or (isinstance(value, str) and not value.strip()):
        return None
    if isinstance(value, bool):
        raise ValueError(f"{snake_key} must be a finite number")
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{snake_key} must be a finite number") from exc
    if not math.isfinite(number):
        raise ValueError(f"{snake_key} must be a finite number")
    return number


def resolve_source_range(cfg, source_duration, default_duration):
    """Validate and clamp an optional user-directed portion of a source.

    ``source_start_seconds`` + ``source_duration_seconds`` are deliberately
    source-relative, never output-relative.  With no values, callers retain
    normal autonomous candidate selection.  A start by itself is bounded by
    the requested clip duration so a typo cannot accidentally analyse a
    multi-hour remainder of a video.
    """
    requested_start = _config_seconds(cfg, "source_start_seconds", "sourceStartSeconds")
    requested_duration = _config_seconds(cfg, "source_duration_seconds", "sourceDurationSeconds")
    if requested_start is None and requested_duration is None:
        return None

    try:
        total = float(source_duration)
    except (TypeError, ValueError) as exc:
        raise ValueError("The source duration is unavailable; cannot apply a source range") from exc
    if not math.isfinite(total) or total <= 0:
        raise ValueError("The source duration is unavailable; cannot apply a source range")

    start = 0.0 if requested_start is None else requested_start
    if start < 0:
        raise ValueError("source_start_seconds must be greater than or equal to zero")
    if start >= total:
        raise ValueError("source_start_seconds must be inside the source duration")

    available = total - start
    requested = requested_duration
    if requested is None:
        requested = min(float(default_duration), available)
    if requested <= 0:
        raise ValueError("source_duration_seconds must be greater than zero")
    resolved = min(requested, available)
    # The renderer's shortest safe plate is six seconds.  Rejecting smaller
    # ranges is clearer than silently extending beyond the user-selected end.
    if resolved < 6.0:
        raise ValueError("The selected source range must contain at least six seconds of media")

    end = start + resolved
    return {
        "mode": "user-directed-range",
        "requestedStartSeconds": round(start, 3),
        "requestedDurationSeconds": round(requested, 3),
        "startSeconds": round(start, 3),
        "endSeconds": round(end, 3),
        "durationSeconds": round(resolved, 3),
        "sourceDurationSeconds": round(total, 3),
        "clamped": bool(resolved < requested),
    }


def rebase_words_to_source_range(words, start, end):
    """Keep source captions useful after cutting a user-directed range."""
    rebased = []
    for word in normalise_words(words):
        if float(word["end"]) <= start or float(word["start"]) >= end:
            continue
        item = dict(word)
        item["start"] = round(max(0.0, float(word["start"]) - start), 3)
        item["end"] = round(max(item["start"] + 0.04, min(end, float(word["end"])) - start), 3)
        rebased.append(item)
    return rebased


def user_directed_candidate(words, video_duration, target_duration):
    """Pin a requested source range to its first frame rather than re-rank it."""
    end = min(float(video_duration), float(target_duration))
    window = [word for word in words if 0.0 <= float(word["start"]) <= end]
    return {
        "id": "candidate-1",
        "start": 0.0,
        "end": round(end, 3),
        "transcript": " ".join(str(word["word"]) for word in window)[:900],
        "needs_context": False,
        "user_directed": True,
        "reason": "User-directed source range",
    }


def parse_captions(caption_track):
    words = []
    root = ET.fromstring(caption_track.xml_captions)
    for element in root.iter():
        if element.tag != "text":
            continue
        raw_text = html.unescape(element.text or "")
        text = re.sub(r"\s+", " ", raw_text).strip()
        if not text:
            continue
        try:
            start = float(element.get("start", "0"))
            duration = max(0.2, float(element.get("dur", "1")))
        except ValueError:
            continue
        tokens = [token for token in re.findall(r"[A-Za-z0-9']+", text.upper()) if token]
        if not tokens:
            continue
        word_duration = duration / len(tokens)
        for index, token in enumerate(tokens):
            word_start = start + index * word_duration
            words.append(
                {
                    "word": token[:28],
                    "start": word_start,
                    "end": min(start + duration, word_start + word_duration),
                }
            )
    return words


def load_caption_words(yt):
    captions = yt.captions
    if not captions:
        return []

    preferred_keys = ("a.en", "en", "en-US", "a.en-US")
    tracks = []
    for key in preferred_keys:
        try:
            track = captions.get(key)
        except Exception:
            track = None
        if track:
            tracks.append(track)

    try:
        tracks.extend(list(captions.values()))
    except Exception:
        pass

    seen = set()
    for track in tracks:
        track_id = id(track)
        if track_id in seen:
            continue
        seen.add(track_id)
        try:
            words = parse_captions(track)
        except Exception:
            words = []
        if len(words) >= 20:
            return words
    return []


def keyword_set(moment_type):
    base = {
        "viral": "wow reveal shocked insane best secret never crazy huge amazing",
        "funny": "laugh funny hilarious joke awkward silly ridiculous",
        "sad": "sad cry cried tears goodbye lost alone death died dead",
        "angry": "angry mad yelling shouting fight argument drama wrong",
        "dramatic": "problem danger mistake wrong serious impossible finally",
        "inspirational": "dream build believe learn changed future possible",
        "inspiring": "dream build believe learn changed future possible",
        "shocking": "suddenly surprise shocked unexpected reveal secret actually",
        "surprising": "suddenly surprise shocked unexpected reveal secret actually",
        "action": "go move run hit jump fight fast start now",
        "reaction": "reaction shocked laugh cry angry face wow wait",
    }
    custom = re.findall(r"[a-z0-9']+", (moment_type or "").lower())
    if custom and moment_type not in base:
        semantic = {
            "dies": "dies died dead killed death falls collapse funeral goodbye",
            "laughing": "laugh laughing laughed funny haha giggle smile",
            "angry": "angry mad yelling shouting argument fight drama",
            "falls": "fall falls fell trip trips crash down",
            "shocked": "shocked surprise surprised wow unbelievable",
        }
        expanded = set(custom)
        for token in custom:
            expanded.update(semantic.get(token, "").split())
        return expanded
    return set(base.get(moment_type, base["viral"]).split())


def choose_moment(words, video_duration, moment_type, target_duration, clip_name, url):
    if video_duration <= 0:
        return 0.0, target_duration, "Selected the strongest available transcript window"

    target = min(max(MIN_AUTOMATIC_CLIP_LENGTH, target_duration), _available_clip_duration(video_duration))
    max_start = max(0.0, video_duration - target)
    keywords = keyword_set(moment_type)
    seed_hex = hashlib.sha1(f"{url}|{clip_name}|{moment_type}|{time.time_ns()}".encode()).hexdigest()
    seed = int(seed_hex[:8], 16)

    if not words:
        start = min(max_start, video_duration * (0.18 + (seed % 22) / 100))
        return round(start, 1), round(min(video_duration, start + target), 1), "Selected a stable middle section"

    candidates = [0.0]
    candidates.extend(word["start"] for index, word in enumerate(words) if index % 18 == 0)
    candidates.extend([video_duration * 0.18, video_duration * 0.34, video_duration * 0.52, video_duration * 0.68])

    best = (float("-inf"), 0.0, "Selected the densest transcript section")
    for raw_start in candidates:
        start = min(max(0.0, raw_start), max_start)
        end = min(video_duration, start + target)
        window = [word for word in words if start <= word["start"] <= end]
        if not window:
            continue
        density = len(window) / max(target, 1.0)
        matches = sum(1 for word in window if word["word"].lower() in keywords)
        unique_ratio = len({word["word"] for word in window}) / max(len(window), 1)
        punctuation_energy = sum(1 for word in window if len(word["word"]) >= 8)
        position_bonus = 0.25 if video_duration * 0.08 <= start <= video_duration * 0.82 else 0
        jitter = ((seed + int(start * 10)) % 17) / 100
        score = density * 3.2 + matches * 0.9 + unique_ratio * 1.4 + punctuation_energy * 0.025 + position_bonus + jitter
        if score > best[0]:
            reason = "Matched the prompt with a dense, high-energy caption window"
            best = (score, start, reason)

    start = best[1]
    return round(start, 1), round(min(video_duration, start + target), 1), best[2]


def choose_moments(words, video_duration, moment_type, target_duration, count, url):
    """Return diverse candidate windows, ranked without guessing raw timestamps in the LLM."""
    if video_duration <= 0:
        return [{
            "id": "candidate-1",
            "start": 0.0,
            "end": target_duration,
            "score": 5.0,
            "reason": "Selected the strongest available source window",
            "transcript": "",
        }]

    target = min(max(MIN_AUTOMATIC_CLIP_LENGTH, target_duration), _available_clip_duration(video_duration))
    max_start = max(0.0, video_duration - target)
    keywords = keyword_set(moment_type)
    seed = int(hashlib.sha1(f"{url}|{moment_type}|{target}".encode()).hexdigest()[:8], 16)
    starts = {0.0, max_start}
    step = max(6.0, target * 0.38)
    cursor = 0.0
    while cursor <= max_start:
        starts.add(round(cursor, 2))
        cursor += step
    starts.update(min(max_start, word["start"]) for index, word in enumerate(words) if index % 16 == 0)

    ranked = []
    for raw_start in starts:
        start = min(max(0.0, float(raw_start)), max_start)
        end = min(video_duration, start + target)
        window = [word for word in words if start <= word["start"] <= end]
        transcript = " ".join(word["word"] for word in window)
        density = len(window) / max(target, 1.0)
        matches = sum(1 for word in window if word["word"].lower() in keywords)
        unique_ratio = len({word["word"] for word in window}) / max(len(window), 1)
        long_words = sum(1 for word in window if len(word["word"]) >= 8)
        position_bonus = 0.25 if video_duration * 0.06 <= start <= video_duration * 0.86 else 0
        jitter = ((seed + int(start * 10)) % 13) / 100
        score = density * 3.2 + matches * 0.9 + unique_ratio * 1.4 + long_words * 0.025 + position_bonus + jitter
        ranked.append({
            "start": start,
            "end": end,
            "score": score,
            "reason": "Dense, self-contained transcript window with strong prompt relevance" if window else "Stable visual source window",
            "transcript": transcript[:700],
        })

    selected = []
    for candidate in sorted(ranked, key=lambda item: item["score"], reverse=True):
        overlap = False
        for existing in selected:
            intersection = max(0.0, min(candidate["end"], existing["end"]) - max(candidate["start"], existing["start"]))
            if intersection / max(1.0, target) > 0.42:
                overlap = True
                break
        if overlap:
            continue
        selected.append(candidate)
        if len(selected) >= count:
            break

    if len(selected) < count:
        for candidate in sorted(ranked, key=lambda item: item["score"], reverse=True):
            if candidate not in selected:
                selected.append(candidate)
            if len(selected) >= count:
                break
    for index, candidate in enumerate(selected):
        candidate["id"] = f"candidate-{index + 1}"
        candidate["start"] = round(candidate["start"], 2)
        candidate["end"] = round(candidate["end"], 2)
    return selected


def rank_candidates_with_llm(candidates, moment_type):
    """Use the existing OpenAI-compatible server credential for transcript ranking."""
    api_key = os.environ.get("DEEPSEEK_API_KEY", "").strip()
    if not api_key or len(candidates) < 2:
        return candidates
    compact = [
        {
            "id": item["id"],
            "duration": round(item["end"] - item["start"], 1),
            "transcript": item["transcript"],
        }
        for item in candidates
    ]
    system = (
        "Rank short-video transcript candidates. Return JSON only as "
        "{\"ranked\":[{\"id\":\"candidate-1\",\"score\":84,\"title\":\"short title\","
        "\"reason\":\"one sentence\"}]}. Score hook strength, standalone clarity, information density, "
        "emotional payoff, and shareability. Never invent facts or timestamps."
    )
    payload = json.dumps({
        "model": os.environ.get("DEEPSEEK_MODEL", "deepseek-chat"),
        "temperature": 0.2,
        "max_tokens": 1000,
        "response_format": {"type": "json_object"},
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": json.dumps({"objective": moment_type, "candidates": compact})},
        ],
    }).encode("utf-8")
    base_url = os.environ.get("DEEPSEEK_BASE_URL", "https://api.deepseek.com").rstrip("/")
    request = urllib.request.Request(
        f"{base_url}/chat/completions",
        data=payload,
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=35) as response:
            body = json.loads(response.read().decode("utf-8"))
        raw = str(body.get("choices", [{}])[0].get("message", {}).get("content", ""))
        start = raw.find("{")
        end = raw.rfind("}")
        ranked_payload = json.loads(raw[start:end + 1] if start >= 0 and end > start else raw)
        rows = ranked_payload.get("ranked", [])
        by_id = {item["id"]: item for item in candidates}
        output = []
        for row in rows:
            item = by_id.get(str(row.get("id", "")))
            if not item or item in output:
                continue
            llm_score = max(1, min(100, int(row.get("score", 50))))
            item["llm_score"] = llm_score
            item["score"] = llm_score
            item["score_source"] = "llm"
            item["title"] = str(row.get("title", "Strong moment"))[:80]
            reason = str(row.get("reason", item.get("reason", "Strong standalone moment")))[:180]
            item["reason"] = f"{llm_score} — {reason}"[:220]
            output.append(item)
        output.extend(item for item in candidates if item not in output)
        return sorted(output, key=lambda item: item.get("llm_score", 0), reverse=True)
    except (urllib.error.URLError, TimeoutError, ValueError, KeyError, TypeError, json.JSONDecodeError):
        return candidates


TRAILING_CONNECTIVES = {
    "and", "but", "because", "so", "then", "with", "to", "or", "if", "when",
    "while", "although", "though", "as", "than", "of", "for", "from", "into",
}


def sentence_boundaries(words, max_gap=1.15):
    """Build conservative sentence-like spans without inventing transcript text."""
    sentences, current = [], []
    normalised = normalise_words(words)
    for index, word in enumerate(normalised):
        if current and word["start"] - current[-1]["end"] > max_gap:
            sentences.append(current)
            current = []
        current.append(word)
        token = word["word"]
        next_word = normalised[index + 1] if index + 1 < len(normalised) else None
        ends_sentence = bool(re.search(r"[.!?][\"')\]]*$", token))
        if not ends_sentence and next_word:
            try:
                ends_sentence = float(next_word.get("start", 0)) - word["end"] > max_gap
            except (TypeError, ValueError):
                pass
        if ends_sentence:
            sentences.append(current)
            current = []
    if current:
        sentences.append(current)
    return [
        {
            "start": group[0]["start"],
            "end": group[-1]["end"],
            "text": " ".join(item["word"] for item in group).strip(),
            "words": group,
        }
        for group in sentences if group
    ]


def speech_regions(words, max_gap=0.72):
    regions, current = [], []
    for word in normalise_words(words):
        if current and word["start"] - current[-1]["end"] > max_gap:
            regions.append({"startMs": round(current[0]["start"] * 1000), "endMs": round(current[-1]["end"] * 1000)})
            current = []
        current.append(word)
    if current:
        regions.append({"startMs": round(current[0]["start"] * 1000), "endMs": round(current[-1]["end"] * 1000)})
    return regions


def topic_segments(sentences, target_duration):
    """Group complete sentences into candidate-sized semantic sections."""
    if not sentences:
        return []
    target = max(15.0, float(target_duration))
    segments, current = [], []
    for sentence in sentences:
        prospective_start = current[0]["start"] if current else sentence["start"]
        if current and sentence["end"] - prospective_start > target * 1.35:
            segments.append(current)
            current = []
        current.append(sentence)
    if current:
        segments.append(current)
    output = []
    for index, group in enumerate(segments):
        transcript = " ".join(item["text"] for item in group).strip()
        output.append({
            "id": f"topic_{index + 1:03d}",
            "startMs": round(group[0]["start"] * 1000),
            "endMs": round(group[-1]["end"] * 1000),
            "title": transcript[:72] or f"Topic {index + 1}",
            "summary": transcript[:500],
            "contentType": "explanation",
            "requiredPreviousContext": bool(re.match(r"^(he|she|they|this|that|it)\b", transcript, re.I)),
            "importantSentenceIds": list(range(len(group))),
            "possibleHooks": [group[0]["text"][:180]],
        })
    return output


def _last_token(text):
    tokens = re.findall(r"[A-Za-z0-9']+", (text or "").lower())
    return tokens[-1] if tokens else ""


def ends_on_connective(text):
    return _last_token(text) in TRAILING_CONNECTIVES


def repair_clip_boundaries(candidate, sentences, video_duration, target_duration):
    """Snap cuts to sentence edges and avoid hanging on and/but/because endings."""
    if not sentences:
        return clamp_candidate_duration(candidate, target_duration, video_duration)

    start = float(candidate["start"])
    end = float(candidate["end"])
    target = min(max(MIN_AUTOMATIC_CLIP_LENGTH, float(target_duration)), _available_clip_duration(video_duration))

    # Prefer the first sentence that overlaps the window as the in-point.
    start_sentence = next((item for item in sentences if item["end"] > start), sentences[0])
    # Prefer the last complete sentence fully inside the window as the out-point.
    end_candidates = [item for item in sentences if item["start"] < end and item["end"] <= end + 0.35]
    end_sentence = end_candidates[-1] if end_candidates else next(
        (item for item in reversed(sentences) if item["start"] >= start_sentence["start"]),
        start_sentence,
    )

    matching = [item for item in sentences if item["start"] >= start_sentence["start"] and item["end"] <= end_sentence["end"]]
    if not matching:
        matching = [start_sentence]

    while len(matching) > 1 and matching[-1]["end"] - matching[0]["start"] > target * 1.08:
        # Drop leading setup first so the ending payoff survives.
        matching.pop(0)
    while len(matching) > 1 and ends_on_connective(matching[-1]["text"]):
        matching.pop()
    # If still connective-ended (single sentence), extend one sentence when possible.
    if ends_on_connective(matching[-1]["text"]):
        next_index = next((index for index, item in enumerate(sentences) if item is matching[-1] or (
            item["start"] == matching[-1]["start"] and item["end"] == matching[-1]["end"]
        )), None)
        if next_index is not None and next_index + 1 < len(sentences):
            extension = sentences[next_index + 1]
            if extension["end"] - matching[0]["start"] <= target * 1.12:
                matching.append(extension)

    transcript = " ".join(item["text"] for item in matching).strip()
    repaired = dict(candidate)
    repaired["start"] = round(max(0.0, matching[0]["start"]), 2)
    repaired["end"] = round(min(float(video_duration), matching[-1]["end"] + 0.12), 2)
    repaired["transcript"] = transcript[:900]
    repaired["boundary_repaired"] = True
    return clamp_candidate_duration(repaired, target, video_duration)


def clamp_candidate_duration(candidate, target_duration, video_duration):
    """Hard-cap clip length so a long caption sentence cannot produce a 2+ minute short."""
    item = dict(candidate)
    start = max(0.0, float(item.get("start", 0)))
    end = max(start + 0.5, float(item.get("end", start + 1)))
    target = min(max(MIN_AUTOMATIC_CLIP_LENGTH, float(target_duration)), _available_clip_duration(video_duration))
    max_end = start + target * 1.08
    if end > max_end:
        end = max_end
        item["duration_clamped"] = True
    end = min(float(video_duration), end)
    item["start"] = round(start, 2)
    item["end"] = round(end, 2)
    return item


def dedupe_by_overlap(candidates, max_overlap=0.42, limit=None):
    """Keep highest-scoring clips that do not heavily overlap."""
    selected = []
    for candidate in sorted(candidates, key=lambda item: item.get("score", 0), reverse=True):
        duration = max(1.0, float(candidate["end"]) - float(candidate["start"]))
        if any(
            max(0.0, min(candidate["end"], chosen["end"]) - max(candidate["start"], chosen["start"])) / duration > max_overlap
            for chosen in selected
        ):
            continue
        selected.append(candidate)
        if limit is not None and len(selected) >= limit:
            break
    return selected


def local_clip_score(candidate, moment_type):
    """Transparent 0–100 Clip Potential Score used when LLM ranking is unavailable."""
    text = candidate.get("transcript", "")
    words = re.findall(r"[A-Za-z0-9']+", text.lower())
    duration = max(0.1, float(candidate["end"]) - float(candidate["start"]))
    keyword_matches = sum(1 for word in words if word in keyword_set(moment_type))
    complete = bool(text) and not ends_on_connective(text) and bool(re.search(r"[.!?]$", text.strip()))
    hook = min(22, 8 + keyword_matches * 3 + (5 if "?" in text[:160] else 0) + (3 if "!" in text[:160] else 0))
    standalone = 20 if complete and not candidate.get("needs_context") else (12 if complete else 6)
    density = min(16, int(len(words) / 6))
    clarity = min(12, 4 + int(len(set(words)) / max(1, len(words)) * 10))
    pacing = min(8, int(len(words) / duration * 2.0))
    relevance = min(14, keyword_matches * 3)
    total = max(1, min(100, hook + standalone + density + clarity + pacing + relevance))
    hook_label = "Strong hook" if hook >= 16 else "Solid setup"
    finish_label = "complete thought" if complete else "needs cleaner ending"
    reason = f"{total} — {hook_label}, {finish_label}, and prompt-relevant pacing."
    return {"score": int(total), "reason": reason[:220]}


def apply_clip_scores(candidates, moment_type, use_llm=True):
    """Attach Clip Potential Score locally, then optionally enrich with LLM ranks."""
    scored = []
    for index, candidate in enumerate(candidates):
        item = dict(candidate)
        item["id"] = item.get("id") or f"candidate-{index + 1}"
        local = local_clip_score(item, moment_type)
        item["score"] = int(local["score"])
        item["reason"] = local["reason"]
        item["score_source"] = "local"
        scored.append(item)

    if use_llm:
        ranked = rank_candidates_with_llm(scored, moment_type)
        for item in ranked:
            if "llm_score" in item:
                item["score"] = int(item["llm_score"])
                item["score_source"] = "llm"
                if item.get("reason") and "—" not in str(item["reason"]):
                    item["reason"] = f"{item['score']} — {item['reason']}"[:220]
        return ranked
    return sorted(scored, key=lambda item: item["score"], reverse=True)


def detect_shot_boundaries(video_path):
    """Optional PySceneDetect adapter. Soft-fails when the package is missing."""
    if not video_path or not os.path.isfile(video_path):
        return []
    try:
        from scenedetect import SceneManager, open_video  # type: ignore
        from scenedetect.detectors import ContentDetector  # type: ignore
    except Exception:
        return []
    try:
        video = open_video(video_path)
        manager = SceneManager()
        manager.add_detector(ContentDetector(threshold=27.0))
        manager.detect_scenes(video, show_progress=False)
        scenes = manager.get_scene_list()
        return [
            {
                "index": index,
                "startMs": round(start.get_seconds() * 1000),
                "endMs": round(end.get_seconds() * 1000),
            }
            for index, (start, end) in enumerate(scenes)
        ]
    except Exception:
        return []


def build_edit_plan(ranked_clips, shot_boundaries=None, face_cfg=None, crop_plans=None):
    """Canonical render plan consumed by the existing FFmpeg crop/subtitle path."""
    face_cfg = face_cfg or {
        "enabled": False,
        "mode": "off",
        "selectedTrackId": None,
        "selectedPersonId": None,
        "personMode": "strict",
        "sceneMode": "strict",
        "allowZoom": False,
    }
    crop_plans = crop_plans or {}
    clips = []
    for item in ranked_clips:
        plan = crop_plans.get(item["id"], {})
        face = plan.get("faceTracking") or {
            "enabled": bool(face_cfg.get("enabled", False)),
            "mode": face_cfg.get("mode", "off"),
            "selectedTrackId": face_cfg.get("selectedPersonId") or face_cfg.get("selectedTrackId"),
            "selectedPersonId": face_cfg.get("selectedPersonId") or face_cfg.get("selectedTrackId"),
            "personMode": face_cfg.get("personMode") or face_cfg.get("sceneMode", "strict"),
            "sceneMode": face_cfg.get("sceneMode") or face_cfg.get("personMode", "strict"),
            "allowZoom": bool(face_cfg.get("allowZoom", True)),
        }
        clips.append(
            {
                "id": item["id"],
                "startMs": round(float(item["start"]) * 1000),
                "endMs": round(float(item["end"]) * 1000),
                "score": int(item.get("score", 0)),
                "reason": item.get("reason", ""),
                "title": item.get("title"),
                "cropFocus": item.get("cropFocus", "center"),
                "captions": True,
                "faceTracking": face,
                "cropKeyframes": plan.get("cropKeyframes") or [],
                "availableFaces": plan.get("availableFaces") or [],
                "scenes": plan.get("scenes") or [],
                "faceOverlay": plan.get("faceOverlay") or [],
            }
        )
    return {
        "version": 3,
        "clips": clips,
        "shotBoundaries": shot_boundaries or [],
        "faceCapabilities": face_capability_report(),
        "sceneMode": face_cfg.get("sceneMode") or face_cfg.get("personMode", "strict"),
        "personMode": face_cfg.get("personMode") or face_cfg.get("sceneMode", "strict"),
        "selectedPersonId": face_cfg.get("selectedPersonId"),
        "notes": [
            "Sentence-aligned candidate boundaries are enriched and re-ranked with available audio, visual, OCR, and timeline evidence.",
            "Unavailable visual or OCR providers are disclosed as unavailable rather than treated as negative evidence.",
            "Selected-person identity uses lightweight appearance histograms (InsightFace optional later).",
            "Strict/Flexible sceneMode filters scenes without the selected person when possible.",
            "Changing faceTracking / selectedPersonId regenerates crop keyframes only — not download/transcription.",
        ],
    }


def semantic_candidates(words, video_duration, moment_type, target_duration, count):
    """Generate sentence-aligned clips, repair boundaries, score, then dedupe."""
    sentences = sentence_boundaries(words)
    if not sentences:
        fallback = choose_moments(words, video_duration, moment_type, target_duration, count, "semantic-fallback")
        return apply_clip_scores(fallback, moment_type, use_llm=False)

    topics = topic_segments(sentences, target_duration)
    candidates = []
    target = min(max(MIN_AUTOMATIC_CLIP_LENGTH, target_duration), _available_clip_duration(video_duration))
    for topic in topics:
        start, end = topic["startMs"] / 1000.0, topic["endMs"] / 1000.0
        matching = [item for item in sentences if item["start"] >= start - 0.05 and item["end"] <= end + 0.05]
        if not matching:
            matching = [item for item in sentences if item["end"] > start and item["start"] < end]
        if not matching:
            continue
        while len(matching) > 1 and matching[-1]["end"] - matching[0]["start"] > target:
            # Drop leading setup first so the ending payoff survives.
            matching.pop(0)
        draft = {
            "id": f"candidate-{len(candidates) + 1}",
            "start": matching[0]["start"],
            "end": matching[-1]["end"],
            "transcript": " ".join(item["text"] for item in matching).strip()[:900],
            "needs_context": topic["requiredPreviousContext"],
            "topic_id": topic["id"],
        }
        repaired = repair_clip_boundaries(draft, sentences, video_duration, target)
        candidates.append(repaired)

    if not candidates:
        fallback = choose_moments(words, video_duration, moment_type, target_duration, count, "semantic-fallback")
        return apply_clip_scores(fallback, moment_type, use_llm=False)

    # Automatic captions can arrive without sentence punctuation (or with one
    # very long cue).  Treating that as one giant "sentence" used to collapse
    # every autonomous search to the opening seconds—even though the audio and
    # visual timeline contained evidence for the entire source.  In that case
    # seed diverse timestamp windows and let the multimodal ranking stage
    # examine them.  They remain a retrieval pool, not final guessed clips.
    exploration_target = max(int(count or 1), 6)
    if len(candidates) < exploration_target:
        exploratory = choose_moments(
            words,
            video_duration,
            moment_type,
            target_duration,
            exploration_target,
            "semantic-exploration",
        )
        for row in exploratory:
            candidate = dict(row)
            if len(sentences) > 1:
                candidate = repair_clip_boundaries(candidate, sentences, video_duration, target_duration)
            else:
                candidate = clamp_candidate_duration(candidate, target_duration, video_duration)
                candidate["boundary_repaired"] = False
                candidate["boundary_warning"] = "Source captions lack reliable sentence punctuation; selected from a timed evidence window."
            candidates.append(candidate)

    scored = apply_clip_scores(candidates, moment_type, use_llm=False)
    selected = dedupe_by_overlap(scored, max_overlap=0.42, limit=count)
    if len(selected) < count:
        for candidate in scored:
            if candidate in selected:
                continue
            selected.append(candidate)
            if len(selected) >= count:
                break
    for index, candidate in enumerate(selected):
        candidate["id"] = f"candidate-{index + 1}"
        selected[index] = clamp_candidate_duration(candidate, target, video_duration)
    return selected


def _ordinal_query_target(request):
    """Return an ordinal method/way target from a plain-language request."""
    text = " ".join(str(request or "").lower().split())
    values = {
        1: ("1", "1st", "first", "one"),
        2: ("2", "2nd", "second", "two"),
        3: ("3", "3rd", "third", "three"),
        4: ("4", "4th", "fourth", "four"),
        5: ("5", "5th", "fifth", "five"),
        6: ("6", "6th", "sixth", "six"),
        7: ("7", "7th", "seventh", "seven"),
        8: ("8", "8th", "eighth", "eight"),
        9: ("9", "9th", "ninth", "nine"),
        10: ("10", "10th", "tenth", "ten"),
    }
    for value, variants in values.items():
        if any(re.search(rf"\b{re.escape(variant)}\b", text) for variant in variants):
            if re.search(r"\b(?:method|way|step|idea|side\s*hustle|strategy)\b", text):
                return value
    return None


def _sentence_has_ordinal_section(text, ordinal):
    """Recognise both 'third method' and 'method number three' wording."""
    variants = {
        1: ("1", "1st", "first", "one"), 2: ("2", "2nd", "second", "two"),
        3: ("3", "3rd", "third", "three"), 4: ("4", "4th", "fourth", "four"),
        5: ("5", "5th", "fifth", "five"), 6: ("6", "6th", "sixth", "six"),
        7: ("7", "7th", "seventh", "seven"), 8: ("8", "8th", "eighth", "eight"),
        9: ("9", "9th", "ninth", "nine"), 10: ("10", "10th", "tenth", "ten"),
    }.get(ordinal, ())
    normalised = " ".join(re.findall(r"[a-z0-9]+", str(text or "").lower()))
    section_kind = r"(?:method|way|step|idea|strategy|side hustle)"
    for variant in variants:
        token = re.escape(variant)
        if re.search(rf"\b{token}\b(?:\s+(?:best|next|main|great|way|method|step|idea|strategy|side hustle|to|for|of|is))*\s+{section_kind}\b", normalised):
            return True
        if re.search(rf"\b{section_kind}\b(?:\s+(?:number|no|the|is|three|two|one|four|five|six|seven|eight|nine|ten|{token}))*\s+\b{token}\b", normalised):
            return True
    return False


def _caption_token(raw):
    return re.sub(r"[^a-z0-9]", "", str(raw.get("word", raw.get("text", "")) or "").lower())


def _ordinal_from_caption_token(token):
    variants = {
        "1": 1, "1st": 1, "first": 1, "one": 1,
        "2": 2, "2nd": 2, "second": 2, "two": 2,
        "3": 3, "3rd": 3, "third": 3, "three": 3,
        "4": 4, "4th": 4, "fourth": 4, "four": 4,
        "5": 5, "5th": 5, "fifth": 5, "five": 5,
        "6": 6, "6th": 6, "sixth": 6, "six": 6,
        "7": 7, "7th": 7, "seventh": 7, "seven": 7,
        "8": 8, "8th": 8, "eighth": 8, "eight": 8,
        "9": 9, "9th": 9, "ninth": 9, "nine": 9,
        "10": 10, "10th": 10, "tenth": 10, "ten": 10,
    }
    return variants.get(token)


def _caption_section_headings(words):
    """Recover ordered list sections from auto-caption structure.

    Auto captions often say “side hustle number one”, “number two”, then use
    a natural transition such as “now moving on, let's talk about AI Clipping”
    rather than literally saying “number three”.  Keep the captions' original
    sequence order (not their overlapping display timestamps) to recover those
    implicit list entries reliably.
    """
    rows = list(words or [])
    tokens = [_caption_token(row) for row in rows]
    candidates = []
    for index, token in enumerate(tokens):
        window = tokens[index:index + 18]
        explicit = None
        if token == "side" and len(window) >= 3 and window[1] == "hustle":
            try:
                number_index = window.index("number")
            except ValueError:
                number_index = -1
            if 0 <= number_index < len(window) - 1:
                explicit = _ordinal_from_caption_token(window[number_index + 1])
            elif len(window) >= 3:
                explicit = _ordinal_from_caption_token(window[2])
        if explicit is None:
            direct_ordinal = _ordinal_from_caption_token(token)
            if direct_ordinal and any(part in {"method", "way", "step", "idea", "strategy"} for part in window[1:5]):
                explicit = direct_ordinal
            elif token in {"method", "way", "step", "idea", "strategy"}:
                for prior in tokens[max(0, index - 4):index]:
                    direct_ordinal = _ordinal_from_caption_token(prior)
                    if direct_ordinal:
                        explicit = direct_ordinal
                        break
        joined = " ".join(window)
        generic_transition = (
            (token == "moving" and "on" in window[:4])
            or joined.startswith("lets talk about")
            or joined.startswith("now lets talk about")
            or "that brings us on" in joined
            or "brings us on to" in joined
        )
        if explicit is None and not generic_transition:
            continue
        try:
            time_seconds = max(0.0, float(rows[index].get("start", 0.0)))
        except (TypeError, ValueError):
            continue
        candidates.append({"index": index, "time": time_seconds, "explicit": explicit})

    # De-duplicate several cue phrases describing the same entry, then assign
    # inferred ordinals between explicit labels.
    compact = []
    for item in candidates:
        if compact and (
            item["index"] - compact[-1]["index"] < 34
            and abs(float(item["time"]) - float(compact[-1]["time"])) < 8.0
        ):
            if item.get("explicit") and not compact[-1].get("explicit"):
                compact[-1] = item
            continue
        compact.append(item)
    expected = 1
    headings = []
    for item in compact:
        explicit = item.get("explicit")
        ordinal = int(explicit) if explicit and int(explicit) >= expected else expected
        headings.append({**item, "ordinal": ordinal})
        expected = ordinal + 1
    return headings


def query_directed_candidates(words, video_duration, request, target_duration, count=1):
    """Find an explicitly numbered spoken section before generic ranking.

    A request such as “the whole third method to make money” has an exact
    transcript structure.  Treating it as a generic viral prompt makes the
    ranker choose a punchier but wrong sentence.  This deterministic retrieval
    anchors the start at the spoken section marker and ends at the next section
    marker (or a safe duration cap when the source has no following marker).
    """
    ordinal = _ordinal_query_target(request)
    caption_rows = list(words or [])
    if ordinal is None or not caption_rows:
        return []
    headings = _caption_section_headings(caption_rows)
    headers = [item for item in headings if item.get("ordinal") == ordinal]
    if not headers:
        return []
    whole_section = bool(re.search(r"\b(?:whole|entire|full|all)\b", str(request or "").lower()))
    # “Whole section” is allowed to span the natural interval to the next
    # heading (up to 90 seconds). A generic short remains bounded by its UI
    # duration target.
    target = min(max(MIN_AUTOMATIC_CLIP_LENGTH, float(target_duration), 90.0 if whole_section else 0.0), _available_clip_duration(video_duration))
    candidates = []
    for heading in headers:
        header_index = int(heading["index"])
        start = max(0.0, float(heading["time"]) - (1.4 if whole_section else 0.45))
        end = min(float(video_duration), start + target)
        # A later numbered section is a clean, semantic boundary.  Keep the
        # entire requested section, but never cross into the following method.
        for later in headings:
            if int(later["index"]) <= header_index:
                continue
            if int(later.get("ordinal") or 0) > ordinal:
                end = min(end, max(float(later["time"]) - 0.18, start + 6.0))
                break
        end_index = next((int(later["index"]) for later in headings if int(later["index"]) > header_index and int(later.get("ordinal") or 0) > ordinal), len(caption_rows))
        window = caption_rows[max(0, header_index - 5):end_index]
        transcript = " ".join(str(row.get("word", row.get("text", "")) or "") for row in window).strip()
        candidates.append({
            "id": f"directed-section-{ordinal}-{len(candidates) + 1}",
            "start": round(start, 3),
            "end": round(max(start + 0.5, end), 3),
            "score": 96,
            "reason": f"Directly matched the spoken {ordinal}{'rd' if ordinal == 3 else 'th'} method section and kept its complete context.",
            "transcript": transcript[:900],
            "query_directed": True,
            "section_ordinal": ordinal,
            "whole_section": whole_section,
        })
    return candidates[:max(1, int(count or 1))]


def select_progressive_stream(yt):
    streams = list(yt.streams.filter(progressive=True, file_extension="mp4"))
    if not streams:
        fail("No browser-friendly MP4 stream is available for this video")

    def height(stream):
        match = re.search(r"(\d+)", stream.resolution or "")
        return int(match.group(1)) if match else 9999

    # Never cap the source master at 720p.  Progressive streams contain audio
    # and are the portable fallback; choose their highest legal source quality.
    return max(streams, key=height)


def _stream_height(stream):
    match = re.search(r"(\d+)", str(getattr(stream, "resolution", "") or ""))
    return int(match.group(1)) if match else 0


def _stream_audio_bitrate(stream):
    match = re.search(r"(\d+(?:\.\d+)?)", str(getattr(stream, "abr", "") or ""))
    return float(match.group(1)) if match else 0.0


def select_adaptive_video_stream(yt, max_height=1080):
    """Choose the best practical MP4 video stream for the master source.

    A YouTube progressive stream is commonly 360p.  It is useful as a
    last-resort portable fallback but must never be mistaken for a premium
    source when a separate adaptive 1080p video stream is available.
    """
    streams = [
        stream for stream in yt.streams.filter(only_video=True, file_extension="mp4")
        if _stream_height(stream) > 0
    ]
    if not streams:
        return None
    bounded = [stream for stream in streams if _stream_height(stream) <= max_height]
    return max(bounded or streams, key=_stream_height)


def select_adaptive_audio_stream(yt):
    streams = list(yt.streams.filter(only_audio=True, file_extension="mp4"))
    return max(streams, key=_stream_audio_bitrate) if streams else None


def download_adaptive_youtube_master(yt, job_dir):
    """Download and mux the highest available adaptive video/audio master.

    This is the quality-preserving fallback when yt-dlp cannot obtain a
    YouTube GVS token.  It relies on the existing public pytubefix importer,
    downloads only the requested source, and performs a stream-copy mux so no
    additional lossy encode happens before final rendering.
    """
    try:
        configured_max = int(os.environ.get("CLYRA_SOURCE_MAX_HEIGHT", "1080"))
    except (TypeError, ValueError):
        configured_max = 1080
    max_height = max(360, min(2160, configured_max))
    video_stream = select_adaptive_video_stream(yt, max_height=max_height)
    audio_stream = select_adaptive_audio_stream(yt)
    if video_stream is None or audio_stream is None:
        raise RuntimeError("youtube_adaptive_stream_unavailable")

    video_path = video_stream.download(job_dir, filename="source-video.mp4")
    audio_path = audio_stream.download(job_dir, filename="source-audio.m4a")
    master_path = os.path.join(job_dir, "source-master.mp4")
    if not (video_path and audio_path and os.path.isfile(video_path) and os.path.isfile(audio_path)):
        raise RuntimeError("youtube_adaptive_stream_download_failed")
    try:
        run_ffmpeg([
            "-i", video_path,
            "-i", audio_path,
            "-map", "0:v:0", "-map", "1:a:0",
            "-c", "copy", "-movflags", "+faststart",
            master_path,
        ], timeout=240)
    except Exception as exc:
        raise RuntimeError("youtube_adaptive_stream_mux_failed") from exc
    if not os.path.isfile(master_path) or os.path.getsize(master_path) <= 8_192:
        raise RuntimeError("youtube_adaptive_master_empty")
    return master_path


def download_progressive_youtube_master(yt, job_dir):
    """Use the already-resolved public YouTube stream when yt-dlp is blocked.

    YouTube increasingly requires a GVS proof-of-origin token for adaptive
    streams.  We still prefer yt-dlp for the best separate audio/video master,
    but an accessible progressive MP4 is a legitimate, timestamped fallback.
    It lets Clyra analyse the real video instead of silently dropping to a
    transcript-only result.  The source-quality audit remains responsible for
    warning when that public fallback is lower resolution.
    """
    stream = select_progressive_stream(yt)
    path = stream.download(job_dir, filename="source-master.mp4")
    if not path or not os.path.isfile(path) or os.path.getsize(path) <= 8_192:
        raise RuntimeError("youtube_progressive_stream_download_failed")
    return path


def download_public_source_master(url, job_dir):
    """Download the legal, highest available public source once for the job.

    Analysis proxies and expiring CDN stream URLs are never valid final-render
    masters.  The existing yt-dlp integration gives the renderer a stable local
    source, preserves retry behaviour, and keeps all later seeks timestamped.
    """
    from yt_dlp import YoutubeDL

    template = os.path.join(job_dir, "source-master.%(ext)s")
    options = {
        "format": "bestvideo[height<=1080]+bestaudio/best[height<=1080]/best",
        "merge_output_format": "mp4",
        "outtmpl": template,
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "retries": 4,
        "fragment_retries": 4,
        "extractor_retries": 3,
    }
    # An authenticated source can be supplied explicitly by the desktop
    # integration after the user consents. Never read browser cookies
    # implicitly: YouTube session data is private user data.
    cookies_file = str(os.environ.get("CLYRA_YTDLP_COOKIES_FILE", "")).strip()
    if cookies_file and os.path.isfile(cookies_file):
        options["cookiefile"] = cookies_file
    po_token = str(os.environ.get("CLYRA_YTDLP_PO_TOKEN", "")).strip()
    if po_token:
        options["extractor_args"] = {"youtube": {"po_token": [po_token]}}
    with YoutubeDL(options) as downloader:
        downloader.extract_info(url, download=True)
    candidates = [
        os.path.join(job_dir, name)
        for name in os.listdir(job_dir)
        if name.startswith("source-master.") and not name.endswith((".part", ".ytdl"))
    ]
    candidates = [path for path in candidates if os.path.isfile(path) and os.path.getsize(path) > 8_192]
    if not candidates:
        raise RuntimeError("public_source_master_download_failed")
    return max(candidates, key=os.path.getsize)


def ass_color(hex_color):
    value = (hex_color or "#FFFFFF").lstrip("#")
    if not re.fullmatch(r"[0-9a-fA-F]{6}", value):
        value = "FFFFFF"
    return f"&H00{value[4:6]}{value[2:4]}{value[0:2]}"


def ass_time_cs(total_cs):
    total_cs = max(0, int(total_cs))
    minutes = total_cs // 6000
    seconds = (total_cs // 100) % 60
    centiseconds = total_cs % 100
    return f"0:{minutes:02d}:{seconds:02d}.{centiseconds:02d}"


def ass_text(value):
    return re.sub(r"[{}\\]", "", value)


def normalise_render_quality(value):
    requested = str(value or "premium").strip().lower().replace("_", "-")
    return requested if requested in RENDER_QUALITY_PROFILES else "premium"


def render_encoding_args(render_quality="premium"):
    """Return the single final-encode settings used by all delivery paths."""
    quality = normalise_render_quality(render_quality)
    profile = RENDER_QUALITY_PROFILES[quality]
    return [
        "-c:v", "libx264",
        "-preset", profile["preset"],
        "-crf", profile["crf"],
        "-profile:v", "high", "-level", "4.2", "-pix_fmt", "yuv420p",
        # Regular keyframes improve seeking/social processing without imposing
        # a lossy bitrate ceiling on the source-master encode.
        "-g", "120", "-keyint_min", "24", "-sc_threshold", "0",
        "-c:a", "aac", "-b:a", profile["audio_bitrate"], "-ar", "48000", "-ac", "2",
        "-movflags", "+faststart",
    ]


def render_quality_label(render_quality="premium"):
    quality = normalise_render_quality(render_quality)
    profile = RENDER_QUALITY_PROFILES[quality]
    return f"H.264 High CRF {profile['crf']} AAC {profile['audio_bitrate']} ({quality})"


def subtitle_override(position, caption_x=None, caption_y=None):
    """Return a precise ASS anchor from a named safe zone plus user offsets.

    x/y are percentages on Clyra's logical output canvas. Keeping this in ASS
    coordinates makes preview settings deterministic in the final master render
    rather than depending on the browser video's scaled size.
    """
    anchors = {
        "top": (8, 220),
        "top-centre": (8, 220),
        "center": (5, 640),
        "centre": (5, 640),
        "bottom": (2, 1050),
        "bottom-centre": (2, 1050),
    }
    alignment, y = anchors.get(position, anchors["bottom"])
    try:
        x = round(OUTPUT_WIDTH * max(0.12, min(0.88, float(caption_x) / 100.0))) if caption_x is not None else OUTPUT_WIDTH // 2
    except (TypeError, ValueError):
        x = OUTPUT_WIDTH // 2
    try:
        y = round(OUTPUT_HEIGHT * max(0.08, min(0.92, float(caption_y) / 100.0))) if caption_y is not None else y
    except (TypeError, ValueError):
        pass
    return alignment, f"{{\\an{alignment}\\pos({x},{y})\\q2\\bord6\\shad1}}"


def has_manual_caption_placement(cfg, caption_x, caption_y):
    """Distinguish the UI's default sliders from a deliberate user override.

    The studio always submits 50/78 for its default centred/bottom caption
    position. Treating those values as user-authored previously prevented the
    collision detector from moving captions away from burnt-in source text.
    """
    if bool((cfg or {}).get("caption_position_custom") or (cfg or {}).get("captionPositionCustom")):
        return True
    try:
        x = float(caption_x)
        y = float(caption_y)
    except (TypeError, ValueError):
        return False
    return abs(x - 50.0) > 0.01 or abs(y - 78.0) > 0.01


def normalise_caption_words(words, clip_start, clip_end):
    """Return one bounded, non-overlapping timing record per rendered word.

    Both subtitle styles must consume the exact same timestamps.  Whisper (and
    imported captions) occasionally leave a word with an implausibly long end
    time when speech resumes after a pause.  Rendering that raw interval makes
    the one-word style linger and leaves the active word in a phrase highlighted
    for seconds after it was spoken.  A caption word is therefore capped at the
    next word or 1.2 seconds, whichever comes first; natural shorter timings are
    always preserved.
    """
    ordered = sorted(
        [word for word in words if float(word.get("end", 0)) > clip_start and float(word.get("start", 0)) < clip_end],
        key=lambda word: (float(word.get("start", 0)), float(word.get("end", 0)), str(word.get("word", ""))),
    )
    normalised = []
    previous_end = clip_start
    for index, raw in enumerate(ordered):
        token = ass_text(str(raw.get("word") or "").strip())
        if not token:
            continue
        start = max(clip_start, min(clip_end, float(raw.get("start", clip_start))))
        natural_end = max(start + 0.05, float(raw.get("end", start + 0.35)))
        next_start = clip_end
        for later in ordered[index + 1:]:
            possible = float(later.get("start", clip_end))
            if possible > start + 0.005:
                next_start = possible
                break
        # Adjacent caption states meet at the same frame.  The previous
        # implementation intentionally left a 20 ms hand-off, which becomes a
        # visible flash after FFmpeg rounds ASS centiseconds to video frames.
        # The renderer replaces the state atomically at `next_start`, so there
        # is no overlap and no black/empty subtitle frame between spoken words.
        end = min(natural_end, start + 1.20, next_start, clip_end)
        if end <= start + 0.02:
            end = min(clip_end, max(start + 0.08, min(natural_end, start + 0.35)))
        if start < previous_end - 0.01:
            start = previous_end
        if end <= start + 0.02:
            continue
        normalised.append({"word": token, "start": start, "end": end})
        previous_end = end
    return normalised


def subtitle_beats(words, clip_start, clip_end):
    clip_length = max(0.1, clip_end - clip_start)
    clip_length_cs = int(clip_length * 100)
    clip_words = normalise_caption_words(words, clip_start, clip_end)
    if not clip_words:
        clip_words = [{"word": "CLIP", "start": clip_start, "end": clip_start + 0.8}]

    beats = []
    # Do not reserve a blank hand-off frame.  ASS events are end-exclusive, so
    # equal boundaries transition cleanly without two words occupying a frame.
    gap_cs = 0
    min_duration_cs = 5
    max_duration_cs = 72

    for index, word in enumerate(clip_words):
        start_cs = max(0, min(clip_length_cs - 1, int(round((word["start"] - clip_start) * 100))))
        if start_cs >= clip_length_cs - 1:
            break

        natural_end_cs = max(start_cs + min_duration_cs, int(round((word["end"] - clip_start) * 100)))
        next_start_cs = clip_length_cs + 1
        if index + 1 < len(clip_words):
            next_start_cs = max(start_cs + 1, int(round((clip_words[index + 1]["start"] - clip_start) * 100)))

        hard_end_cs = min(clip_length_cs, start_cs + max_duration_cs, next_start_cs - gap_cs)
        if hard_end_cs <= start_cs:
            continue

        end_cs = min(max(natural_end_cs, start_cs + min_duration_cs), hard_end_cs)
        if end_cs <= start_cs:
            continue

        beats.append((start_cs, end_cs, ass_text(word["word"])))

    return beats


def phrase_highlight_beats(words, clip_start, clip_end, active_color="#FFD54A"):
    """Three/four-word phrase captions with the current word highlighted.

    This is deliberately a separate mode from the legacy word-at-a-time look:
    phrase boundaries remain stable while only the active word advances.
    """
    clip_words = normalise_caption_words(words, clip_start, clip_end)
    beats = []
    for group_start in range(0, len(clip_words), 4):
        group = clip_words[group_start:group_start + 4]
        if not group:
            continue
        phrase = [ass_text(str(item.get("word") or "")) for item in group]
        for index, item in enumerate(group):
            start = max(0, int(round((float(item["start"]) - clip_start) * 100)))
            # Each active state ends exactly at the next spoken word.  This
            # keeps the phrase continuously visible without allowing two words
            # to be highlighted at the same timestamp.
            next_word = clip_words[group_start + index + 1] if group_start + index + 1 < len(clip_words) else None
            natural_end = int(round((float(item["end"]) - clip_start) * 100))
            next_start = int(round((float(next_word["start"]) - clip_start) * 100)) if next_word else int(round((clip_end - clip_start) * 100))
            next_start = max(start + 1, next_start)
            end = min(max(start + 1, natural_end), next_start)
            if end <= start:
                end = start + 1
            text = " ".join(
                f"{{\\c{ass_color(active_color)}}}{token}{{\\c{ass_color('#FFFFFF')}}}" if word_index == index else token
                for word_index, token in enumerate(phrase)
            )
            beats.append((start, end, text))
            # During a genuine pause, retain the phrase in a neutral state.
            # This avoids a flickering disappear/reappear while ensuring no
            # word is falsely highlighted after it has finished being spoken.
            if end < next_start:
                beats.append((end, next_start, " ".join(phrase)))
    return beats


def write_subtitles(path, words, clip_start, clip_end, font, font_size, color, position, style="word", caption_x=None, caption_y=None):
    alignment, override = subtitle_override(position, caption_x, caption_y)
    style = str(style or "word").strip().lower()
    beats = phrase_highlight_beats(words, clip_start, clip_end) if style in {"phrase", "phrase-highlight", "active-phrase"} else subtitle_beats(words, clip_start, clip_end)

    with open(path, "w", encoding="utf-8") as handle:
        handle.write("[Script Info]\n")
        handle.write(
            f"ScriptType: v4.00+\nPlayResX: {OUTPUT_WIDTH}\nPlayResY: {OUTPUT_HEIGHT}\nWrapStyle: 2\nScaledBorderAndShadow: yes\n"
        )
        handle.write("\n[V4+ Styles]\n")
        handle.write(
            "Format: Name,Fontname,Fontsize,PrimaryColour,OutlineColour,BackColour,Bold,Alignment,MarginL,MarginR,MarginV,Outline,Shadow,Encoding\n"
        )
        handle.write(
            f"Style: Word,{font},{font_size},{ass_color(color)},&H00000000,&H80000000,1,{alignment},36,36,44,6,1,1\n"
        )
        handle.write("\n[Events]\n")
        handle.write("Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text\n")
        for start_cs, end_cs, word in beats:
            handle.write(f"Dialogue: 0,{ass_time_cs(start_cs)},{ass_time_cs(end_cs)},Word,,0,0,0,,{override}{word}\n")
    return len(beats)


def run_ffmpeg(args, timeout=90):
    subprocess.run([FFMPEG, "-hide_banner", "-loglevel", "error", "-y", *args], check=True, capture_output=True, timeout=timeout)


def probe_duration(path_value):
    if FFPROBE:
        result = subprocess.run(
            [FFPROBE, "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", path_value],
            check=True,
            capture_output=True,
            text=True,
            timeout=20,
        )
        return max(0.0, float(result.stdout.strip()))

    result = subprocess.run(
        [FFMPEG, "-hide_banner", "-i", path_value],
        check=False,
        capture_output=True,
        text=True,
        timeout=20,
    )
    match = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", result.stderr)
    if not match:
        raise RuntimeError("Unable to read source duration with ffmpeg")
    hours, minutes, seconds = match.groups()
    return max(0.0, (int(hours) * 3600) + (int(minutes) * 60) + float(seconds))


def source_quality_report(path_value):
    """Small, deterministic source audit used to prevent proxy-quality exports."""
    report = {
        "width": 0, "height": 0, "frameRate": 0.0, "variableFrameRate": False,
        # Coded dimensions are not always the presentation dimensions. Some
        # YouTube progressive streams carry a non-square sample aspect ratio,
        # so deciding whether to letterbox from width / height alone can put a
        # portrait source through the landscape treatment (or vice versa).
        "displayAspectRatio": 0.0,
        "videoCodec": "unknown", "videoBitrate": 0, "audioCodec": None, "audioBitrate": 0,
        "effectiveVerticalCrop": {"width": 0, "height": 0},
        "recommendedOutput": {"width": OUTPUT_WIDTH, "height": OUTPUT_HEIGHT, "frameRate": OUTPUT_FPS},
        "sourceLimited": False, "warnings": [],
    }
    if not path_value:
        report["warnings"].append("No readable source was available for the quality audit")
        return report
    if not FFPROBE:
        # Electron's bundled FFmpeg distribution may not ship ffprobe.  Keep
        # the audit useful instead of reporting an empty quality object.
        try:
            width, height = probe_video_size(None, FFMPEG, str(path_value))
            report["width"], report["height"] = width, height
            result = subprocess.run([FFMPEG, "-hide_banner", "-i", str(path_value)], check=False, capture_output=True, text=True, timeout=30)
            video_line = next((line for line in result.stderr.splitlines() if " Video: " in line), "")
            audio_line = next((line for line in result.stderr.splitlines() if " Audio: " in line), "")
            rate_match = re.search(r"(\d+(?:\.\d+)?)\s*fps", video_line)
            bitrate_match = re.search(r"bitrate:\s*(\d+)\s*kb/s", result.stderr)
            report["frameRate"] = float(rate_match.group(1)) if rate_match else 0.0
            report["videoCodec"] = (video_line.split("Video:", 1)[-1].split("(", 1)[0].strip() or "unknown")
            report["audioCodec"] = (audio_line.split("Audio:", 1)[-1].split("(", 1)[0].strip() or None)
            report["videoBitrate"] = int(bitrate_match.group(1)) * 1000 if bitrate_match else 0
            report["recommendedOutput"]["frameRate"] = round(report["frameRate"]) or OUTPUT_FPS
            sar_match = re.search(r"\[SAR\s+(\d+):(\d+)\s+DAR\s+(\d+):(\d+)\]", video_line)
            if sar_match:
                dar_width, dar_height = float(sar_match.group(3)), float(sar_match.group(4))
                report["displayAspectRatio"] = dar_width / max(1.0, dar_height)
            else:
                report["displayAspectRatio"] = width / max(1.0, height)
        except Exception:
            report["warnings"].append("ffprobe unavailable; source-quality measurements are limited")
            return report
        _apply_vertical_crop_quality_warning(report)
        return report
    try:
        result = subprocess.run(
            [FFPROBE, "-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height,sample_aspect_ratio,display_aspect_ratio,avg_frame_rate,r_frame_rate,bit_rate:format=bit_rate", "-of", "json", str(path_value)],
            check=True, capture_output=True, text=True, timeout=20,
        )
        data = json.loads(result.stdout)
        streams = data.get("streams") or []
        video = next((item for item in streams if item.get("codec_type") == "video"), {})
        audio = next((item for item in streams if item.get("codec_type") == "audio"), {})
        report.update({
            "width": int(video.get("width") or 0),
            "height": int(video.get("height") or 0),
            "videoCodec": str(video.get("codec_name") or "unknown"),
            "videoBitrate": int(video.get("bit_rate") or data.get("format", {}).get("bit_rate") or 0),
            "audioCodec": audio.get("codec_name"),
            "audioBitrate": int(audio.get("bit_rate") or 0),
        })
        display_ratio = str(video.get("display_aspect_ratio") or "")
        try:
            display_width, display_height = display_ratio.split(":", 1)
            report["displayAspectRatio"] = float(display_width) / max(1.0, float(display_height))
        except (TypeError, ValueError):
            report["displayAspectRatio"] = report["width"] / max(1.0, report["height"])
        def fps(value):
            numerator, denominator = str(value or "0/1").split("/", 1)
            return float(numerator) / max(1.0, float(denominator))
        report["frameRate"] = round(fps(video.get("avg_frame_rate")), 3)
        report["variableFrameRate"] = abs(fps(video.get("avg_frame_rate")) - fps(video.get("r_frame_rate"))) > 0.25
        _apply_vertical_crop_quality_warning(report)
        if report["videoBitrate"] and report["videoBitrate"] < 2_000_000:
            report["warnings"].append("Source video bitrate is low; preserve the master and avoid additional transcodes")
        if report["frameRate"] > 0:
            report["recommendedOutput"]["frameRate"] = round(report["frameRate"])
    except Exception as exc:
        report["warnings"].append(f"Source audit could not read all streams: {type(exc).__name__}")
    return report


def _apply_vertical_crop_quality_warning(report):
    """Report the usable source pixels for Clyra's 9:16 master render.

    A 1920x1080 landscape source can be high resolution in general while its
    centre 9:16 crop is only 608 pixels wide.  That distinction matters more
    than the shortest coded side when warning users about a 1080x1920 export.
    """
    width = float(report.get("width") or 0)
    height = float(report.get("height") or 0)
    display_ratio = float(report.get("displayAspectRatio") or 0)
    if width <= 0 or height <= 0:
        return
    source_ratio = display_ratio or width / height
    target_ratio = OUTPUT_WIDTH / OUTPUT_HEIGHT
    if source_ratio >= target_ratio:
        crop_height = height
        crop_width = height * target_ratio
    else:
        crop_width = width
        crop_height = width / target_ratio
    report["effectiveVerticalCrop"] = {
        "width": round(crop_width),
        "height": round(crop_height),
    }
    if crop_width < OUTPUT_WIDTH or crop_height < OUTPUT_HEIGHT:
        report["sourceLimited"] = True
        warning = "Vertical crop source detail is below 1080x1920; upscaling cannot restore missing detail"
        if warning not in report["warnings"]:
            report["warnings"].append(warning)


def source_needs_full_frame_fill(source_quality):
    """Return whether the source must be centre-cropped to fill the output.

    Clyra uses the requested delivery aspect ratio as a real full-frame video,
    never a sharp panel laid over a blurred duplicate of the source.
    """
    if not isinstance(source_quality, dict):
        return False
    try:
        source_ratio = float(source_quality.get("displayAspectRatio") or 0)
    except (TypeError, ValueError):
        source_ratio = 0.0
    if source_ratio <= 0:
        source_ratio = float(source_quality.get("width") or 0) / max(1.0, float(source_quality.get("height") or 1))
    output_ratio = OUTPUT_WIDTH / max(1.0, OUTPUT_HEIGHT)
    return source_ratio > output_ratio + 0.02


def output_frame_rate(source_quality):
    """Return a smooth delivery cadence without fabricating source observations.

    Clyra's virtual-camera path is evaluated at every *delivery* frame.  A
    24fps master still has 24 real image observations each second, but a
    30fps MP4 makes the stored, interpolated crop movement substantially
    smoother in social players.  The renderer duplicates only the necessary
    source images; it never speeds up the video or claims that the source was
    recorded at 30fps.
    """
    if not isinstance(source_quality, dict) or source_quality.get("variableFrameRate"):
        return max(30, OUTPUT_FPS)
    source_rate = float(source_quality.get("frameRate") or 0.0)
    if 23.0 <= source_rate <= 60.5:
        return max(30, int(round(source_rate)))
    return max(30, OUTPUT_FPS)


def tracking_source_frame_rate(source_quality):
    """Return the real source cadence for detector/flow sampling only.

    This deliberately differs from :func:`output_frame_rate`: a 24fps master
    may be delivered at 30fps, but asking the analysis proxy for 30 input
    frames would duplicate JPEGs and corrupt its timestamp mapping.
    """
    if not isinstance(source_quality, dict):
        return None
    try:
        source_rate = float(source_quality.get("frameRate") or 0.0)
    except (TypeError, ValueError):
        return None
    return source_rate if 1.0 <= source_rate <= 120.0 else None


def detect_embedded_caption_risk(input_path, sample_dir):
    """Detect a recurring lower-third subtitle band without reading it as a transcript.

    Detection is intentionally conservative: it tells the compositor that the
    lower third is occupied.  It must *not* silently remove a user's requested
    Clyra captions.  The caller chooses whether to relocate them to a safe
    position, keep only the source captions, or explicitly allow overlap.
    """
    result = {
        "detected": False,
        "samples": 0,
        "matches": 0,
        "yellowMatches": 0,
        "outlinedLightMatches": 0,
        "reason": "not_checked",
    }
    try:
        from PIL import Image
        import numpy as np
    except Exception:
        result["reason"] = "image_analysis_unavailable"
        return result
    duration = probe_duration(input_path)
    # One-word burned captions often occupy a frame for just a few hundred
    # milliseconds. Three evenly spaced samples were therefore prone to
    # miss real caption tracks entirely (and Clyra would then draw a second
    # caption layer over them). Sample across the spoken clip; these are tiny
    # analysis frames, not a decoded full-video buffer.
    sample_times = [max(0.12, duration * factor) for factor in (0.07, 0.18, 0.30, 0.42, 0.54, 0.66, 0.78, 0.90)]
    os.makedirs(sample_dir, exist_ok=True)
    for index, sample_time in enumerate(sample_times):
        frame_path = os.path.join(sample_dir, f"caption-risk-{index}.jpg")
        try:
            run_ffmpeg(["-ss", str(sample_time), "-i", input_path, "-frames:v", "1", "-q:v", "3", frame_path], timeout=25)
            image = np.asarray(Image.open(frame_path).convert("RGB"))
            lower = image[int(image.shape[0] * 0.54):]
            red, green, blue = lower[..., 0], lower[..., 1], lower[..., 2]
            yellow = (red > 145) & (green > 120) & (blue < 135) & ((red.astype(int) - blue.astype(int)) > 55)
            area = lower.shape[0] * lower.shape[1]
            yellow_hit = int(yellow.sum()) > max(90, int(area * 0.00055))

            # Many social sources use white captions with a black outline,
            # not the original yellow treatment.  Bright scenery alone is
            # deliberately insufficient: require near-neutral white pixels
            # adjacent to a dark outline across the lower caption region.
            # Two-pixel adjacency tolerates antialiasing around bold glyphs.
            channel_max = np.maximum.reduce((red, green, blue))
            channel_min = np.minimum.reduce((red, green, blue))
            white = (red > 210) & (green > 210) & (blue > 210) & ((channel_max.astype(int) - channel_min.astype(int)) < 35)
            dark = channel_max < 80
            dark_neighbour = np.zeros_like(dark)
            for axis in (0, 1):
                for shift in (-2, -1, 1, 2):
                    dark_neighbour |= np.roll(dark, shift, axis=axis)
            outlined_light = white & dark_neighbour
            outlined_light_hit = int(outlined_light.sum()) > max(180, int(area * 0.0007))

            # Require a meaningful amount of caption-coloured pixels, not a
            # single light, window edge, or white UI glyph.
            if yellow_hit or outlined_light_hit:
                result["matches"] += 1
            if yellow_hit:
                result["yellowMatches"] += 1
            if outlined_light_hit:
                result["outlinedLightMatches"] += 1
            result["samples"] += 1
        except Exception:
            continue
    result["detected"] = result["matches"] >= 2
    result["reason"] = "recurring_caption_lower_third" if result["detected"] else "no_recurring_caption_band"
    return result


def visual_transition_spec(request):
    """Turn only state-transition requests into a strict verification contract."""
    text = " ".join(str(request or "").lower().split())
    if re.search(r"\b(?:leave|leaving|left|exit|exiting|outside)\b.{0,28}\bzoo\b|\bzoo\b.{0,28}\b(?:leave|leaving|left|exit|exiting|outside)\b", text):
        return {
            "request": request,
            "requiresVisualProof": True,
            "before": "inside or clearly at the zoo",
            "transition": "departure through an exit or away from the zoo",
            "after": "outside or clearly no longer inside the zoo",
        }
    if "zoo" in text:
        return {
            "request": request,
            "requiresVisualProof": True,
            "before": "the requested zoo context is visually present",
            "transition": "the requested moment happens in that visual context",
            "after": "the result remains visually consistent with the requested context",
        }
    return {"request": request, "requiresVisualProof": False}


def verify_visual_transition_candidate(candidate, timeline, spec):
    """Reject transcript-only claims for requests whose outcome must be visible.

    The installed lightweight timeline has motion/scene signals, but no licensed
    temporal location-state model.  It therefore cannot honestly prove a zoo
    departure; returning no exact match is safer than inventing one.
    """
    if not spec.get("requiresVisualProof"):
        return {"exactMatch": True, "warnings": [], "constraintsSatisfied": []}
    return {
        "exactMatch": False,
        "warnings": ["No verified visual before/after state evidence is available for this candidate."],
        "constraintsSatisfied": [],
        "reason": "visual_state_unverified",
        "required": {key: value for key, value in spec.items() if key in {"before", "transition", "after"}},
    }


def extract_plate_clip(input_url, local_fallback_path, plate_path, clip_start, clip_duration, analysis_only=True):
    """Create a disposable analysis plate without ever lowering final quality.

    Caption timing, caption-collision checks and optional face scans do not
    need an expensive 1080p slow encode. The plate is never the first final
    render source, so a lightweight 540p proxy prevents long source clips from
    timing out while the retained master is used for delivery pixels.
    """
    base = [
        "-ss",
        str(clip_start),
        "-i",
        input_url,
        "-t",
        str(clip_duration),
        "-vf",
        "scale=-2:540:flags=fast_bilinear" if analysis_only else "null",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast" if analysis_only else "slow",
        "-crf",
        "23" if analysis_only else "17",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "128k" if analysis_only else "192k",
        "-ar",
        "48000",
        "-ac",
        "2",
        "-movflags",
        "+faststart",
        plate_path,
    ]
    try:
        run_ffmpeg(base, timeout=max(90, int(float(clip_duration) * (2.5 if analysis_only else 8) + 30)))
        return
    except subprocess.CalledProcessError:
        if not local_fallback_path:
            raise
    fallback = base.copy()
    fallback[fallback.index(input_url)] = local_fallback_path
    run_ffmpeg(fallback, timeout=max(90, int(float(clip_duration) * (2.5 if analysis_only else 8) + 30)))


def extract_clean_clip(
    input_url,
    local_fallback_path,
    clip_path,
    clip_start,
    clip_duration,
    crop_focus="center",
    crop_keyframes=None,
    sendcmd_path=None,
):
    crop_part = build_crop_filter(
        OUTPUT_WIDTH,
        OUTPUT_HEIGHT,
        keyframes=crop_keyframes,
        crop_focus=crop_focus,
        sendcmd_path=sendcmd_path,
    )
    video_filter = f"{crop_part},fps={OUTPUT_FPS}"
    base = [
        "-ss",
        str(clip_start),
        "-i",
        input_url,
        "-t",
        str(clip_duration),
        "-vf",
        video_filter,
        "-r",
        str(OUTPUT_FPS),
        "-c:v",
        "libx264",
        "-preset",
        "slower",
        "-crf",
        "15",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "256k",
        "-ar",
        "48000",
        "-ac",
        "2",
        "-movflags",
        "+faststart",
        clip_path,
    ]
    try:
        run_ffmpeg(base, timeout=90)
        return
    except subprocess.CalledProcessError:
        if not local_fallback_path:
            raise

    fallback = base.copy()
    input_index = fallback.index(input_url)
    fallback[input_index] = local_fallback_path
    run_ffmpeg(fallback, timeout=90)


def _escape_ass_path(path_value):
    """Escape a local ASS path for the FFmpeg filtergraph, not a shell."""
    return os.path.abspath(path_value).replace("\\", "/").replace(":", "\\:").replace("'", "\\'")


def _evaluate_crop_keyframe(keyframes, timestamp_ms, cursor=0):
    """Evaluate Clyra's stored offline crop path at one video timestamp.

    The tracker writes a dense native-frame path.  Interpolation is used only
    when the source has an irregular presentation timestamp, so the preview
    and the full-resolution renderer resolve the same crop position.
    """
    if not keyframes:
        return {}, 0
    while cursor + 1 < len(keyframes) and float(keyframes[cursor + 1].get("timeMs", 0) or 0) <= timestamp_ms:
        cursor += 1
    left = keyframes[cursor]
    if cursor + 1 >= len(keyframes):
        return dict(left), cursor
    right = keyframes[cursor + 1]
    left_ms = float(left.get("timeMs", 0) or 0)
    right_ms = float(right.get("timeMs", left_ms) or left_ms)
    if right_ms <= left_ms:
        return dict(left), cursor
    amount = max(0.0, min(1.0, (timestamp_ms - left_ms) / (right_ms - left_ms)))
    result = dict(left)
    for field in ("x", "y", "width", "height", "zoom", "scaledWidth", "scaledHeight"):
        try:
            start = float(left.get(field, 0) or 0)
            end = float(right.get(field, start) or start)
            result[field] = start + ((end - start) * amount)
        except (TypeError, ValueError):
            continue
    return result, cursor


def render_per_frame_crop_from_master(
    input_path,
    output_path,
    clip_start,
    clip_duration,
    crop_keyframes,
    subtitle_path=None,
    output_fps=OUTPUT_FPS,
    render_quality="premium",
):
    """Render an animated crop path from the master in bounded memory.

    FFmpeg's crop filter evaluates expressions per frame, but it neither
    accepts live crop-coordinate commands nor handles a long path expression
    reliably.  This decoder therefore streams exactly one source frame at a
    time through OpenCV, evaluates Clyra's persisted trajectory at the media
    timestamp, then feeds the cropped BGR frame to FFmpeg for the sole final
    H.264/AAC encode.  It never retains the source video, proxy, or frame queue
    in memory and leaves subtitle compositing at the final delivery resolution.
    """
    if not input_path or not os.path.isfile(input_path) or len(crop_keyframes or []) < 2:
        return False
    try:
        import cv2
    except Exception:
        return False

    ordered = sorted(
        (dict(row) for row in crop_keyframes if isinstance(row, dict)),
        key=lambda row: float(row.get("timeMs", 0) or 0),
    )
    if len(ordered) < 2:
        return False
    capture = cv2.VideoCapture(input_path)
    if not capture.isOpened():
        return False
    source_width = int(round(capture.get(cv2.CAP_PROP_FRAME_WIDTH) or 0))
    source_height = int(round(capture.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0))
    source_fps = float(capture.get(cv2.CAP_PROP_FPS) or 0.0)
    # Delivery is at least 30fps.  On a 24/25fps master this creates a
    # constant-rate stream by reusing the nearest decoded source image while
    # still evaluating the crop path at each 30fps delivery timestamp.
    fps = max(30, min(60, int(round(float(output_fps or source_fps or OUTPUT_FPS)))))
    if source_width < 2 or source_height < 2:
        capture.release()
        return False

    # A single seek is followed by sequential reads; random per-frame seeking
    # would re-decode long GOPs, use more RAM/CPU, and introduce visible drift.
    capture.set(cv2.CAP_PROP_POS_MSEC, max(0.0, float(clip_start)) * 1000.0)
    frame_limit = max(1, int(math.ceil(max(0.01, float(clip_duration)) * fps)))
    base_scale = max(OUTPUT_WIDTH / source_width, OUTPUT_HEIGHT / source_height)
    command = [
        FFMPEG, "-hide_banner", "-loglevel", "error", "-y",
        "-f", "rawvideo", "-pix_fmt", "bgr24",
        "-s:v", f"{OUTPUT_WIDTH}x{OUTPUT_HEIGHT}", "-r", str(fps), "-i", "pipe:0",
        "-ss", str(clip_start), "-i", input_path,
        "-map", "0:v:0", "-map", "1:a?",
        "-t", str(clip_duration), "-r", str(fps),
    ]
    if subtitle_path and os.path.isfile(subtitle_path):
        command += ["-vf", f"ass='{_escape_ass_path(subtitle_path)}'"]
    command += [*render_encoding_args(render_quality), output_path]
    process = None
    rendered = 0
    cursor = 0
    last_frame = None
    source_frame_index = -1
    try:
        process = subprocess.Popen(command, stdin=subprocess.PIPE, stderr=subprocess.PIPE)
        for frame_index in range(frame_limit):
            check_cancelled()
            # Read only as many source frames as the output timestamp needs.
            # The previous implementation consumed one source frame for every
            # delivery frame; rendering a 24fps source at 30fps then sped up
            # the picture and desynchronised audio.  This cadence mapper holds
            # the current source image when no new source frame exists yet,
            # while the stored crop path is still evaluated at every output
            # frame.  It is bounded-memory and works for 24→30, 25→30 and
            # 60→30 delivery without synthetic wall-clock timing.
            target_source_index = int(math.floor((frame_index * max(1.0, source_fps)) / fps + 1e-7))
            while source_frame_index < target_source_index:
                ok, decoded = capture.read()
                if not ok:
                    break
                last_frame = decoded
                source_frame_index += 1
            if last_frame is None:
                break
            frame = last_frame
            timestamp_ms = (frame_index * 1000.0) / fps
            keyframe, cursor = _evaluate_crop_keyframe(ordered, timestamp_ms, cursor)
            zoom = max(1.0, min(1.6, float(keyframe.get("zoom", 1.0) or 1.0)))
            scale = base_scale * zoom
            scaled_width = max(OUTPUT_WIDTH, int(round(source_width * scale)))
            scaled_height = max(OUTPUT_HEIGHT, int(round(source_height * scale)))
            resized = cv2.resize(frame, (scaled_width, scaled_height), interpolation=cv2.INTER_LANCZOS4)

            reference_width = max(1.0, float(keyframe.get("scaledWidth", scaled_width) or scaled_width))
            reference_height = max(1.0, float(keyframe.get("scaledHeight", scaled_height) or scaled_height))
            crop_x = int(round(float(keyframe.get("x", 0) or 0) * (scaled_width / reference_width)))
            crop_y = int(round(float(keyframe.get("y", 0) or 0) * (scaled_height / reference_height)))
            crop_x = max(0, min(scaled_width - OUTPUT_WIDTH, crop_x))
            crop_y = max(0, min(scaled_height - OUTPUT_HEIGHT, crop_y))
            cropped = resized[crop_y:crop_y + OUTPUT_HEIGHT, crop_x:crop_x + OUTPUT_WIDTH]
            if cropped.shape[0] != OUTPUT_HEIGHT or cropped.shape[1] != OUTPUT_WIDTH:
                raise RuntimeError("Per-frame crop escaped the source bounds")
            process.stdin.write(cropped.tobytes())
            rendered += 1
        process.stdin.close()
        stderr = process.stderr.read().decode("utf-8", "replace")
        result = process.wait()
        if result != 0 or rendered <= 0:
            raise RuntimeError(stderr[-1600:] or "per-frame crop encoder failed")
        if not os.path.isfile(output_path) or os.path.getsize(output_path) <= 1024:
            raise RuntimeError("per-frame crop encoder did not create an output")
        return True
    except Exception:
        try:
            if process and process.stdin and not process.stdin.closed:
                process.stdin.close()
            if process:
                process.kill()
                process.wait(timeout=5)
        except Exception:
            pass
        if os.path.isfile(output_path):
            try:
                os.remove(output_path)
            except OSError:
                pass
        return False
    finally:
        capture.release()


def render_tracking_debug_overlay(
    input_path,
    output_path,
    clip_start,
    clip_duration,
    crop_keyframes,
    tracking_diagnostics=None,
    output_fps=None,
):
    """Render a developer-only crop/anchor diagnostic without changing delivery.

    The normal final render never calls this function.  When explicitly
    enabled, it writes a compact source-space debug MP4 showing the stored crop
    rectangle, raw anchor, final composition point, identity, confidence and
    per-frame source.  It reads the exact same saved crop path as preview and
    export, which makes regressions inspectable without adding a second tracker
    or a UI-time smoothing layer.
    """
    if not input_path or not os.path.isfile(input_path) or not crop_keyframes:
        return False
    try:
        import cv2
    except Exception:
        return False
    capture = cv2.VideoCapture(input_path)
    if not capture.isOpened():
        return False
    width = int(round(capture.get(cv2.CAP_PROP_FRAME_WIDTH) or 0))
    height = int(round(capture.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0))
    source_fps = float(capture.get(cv2.CAP_PROP_FPS) or 0.0)
    fps = max(1, min(60, int(round(float(output_fps or source_fps or OUTPUT_FPS)))))
    if width < 2 or height < 2:
        capture.release()
        return False
    ordered = sorted((dict(row) for row in crop_keyframes if isinstance(row, dict)), key=lambda row: float(row.get("timeMs", 0) or 0))
    diagnostics_by_ms = {
        int(round(float(row.get("timeMs", 0) or 0))): row
        for row in (tracking_diagnostics or []) if isinstance(row, dict)
    }
    capture.set(cv2.CAP_PROP_POS_MSEC, max(0.0, float(clip_start)) * 1000.0)
    command = [
        FFMPEG, "-hide_banner", "-loglevel", "error", "-y",
        "-f", "rawvideo", "-pix_fmt", "bgr24", "-s:v", f"{width}x{height}", "-r", str(fps), "-i", "pipe:0",
        "-an", "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", output_path,
    ]
    process = None
    frame_limit = max(1, int(math.ceil(max(0.01, float(clip_duration)) * fps)))
    cursor = 0
    rendered = 0
    try:
        process = subprocess.Popen(command, stdin=subprocess.PIPE, stderr=subprocess.PIPE)
        for frame_index in range(frame_limit):
            ok, frame = capture.read()
            if not ok:
                break
            timestamp_ms = (frame_index * 1000.0) / fps
            keyframe, cursor = _evaluate_crop_keyframe(ordered, timestamp_ms, cursor)
            nearest_ms = int(round(timestamp_ms / max(1.0, 1000.0 / fps)) * (1000.0 / fps))
            diagnostic = diagnostics_by_ms.get(nearest_ms, {})
            scaled_width = max(1.0, float(keyframe.get("scaledWidth", width) or width))
            scaled_height = max(1.0, float(keyframe.get("scaledHeight", height) or height))
            scale_x = scaled_width / max(1.0, width)
            scale_y = scaled_height / max(1.0, height)
            crop_x = int(round(float(keyframe.get("x", 0) or 0) / scale_x))
            crop_y = int(round(float(keyframe.get("y", 0) or 0) / scale_y))
            crop_w = int(round(float(keyframe.get("width", OUTPUT_WIDTH) or OUTPUT_WIDTH) / scale_x))
            crop_h = int(round(float(keyframe.get("height", OUTPUT_HEIGHT) or OUTPUT_HEIGHT) / scale_y))
            cv2.rectangle(frame, (max(0, crop_x), max(0, crop_y)), (min(width - 1, crop_x + crop_w), min(height - 1, crop_y + crop_h)), (0, 220, 0), 2)
            raw_x = diagnostic.get("rawAnchorX", diagnostic.get("rawHeadX"))
            raw_y = diagnostic.get("rawAnchorY", diagnostic.get("rawHeadY"))
            if isinstance(raw_x, (int, float)) and isinstance(raw_y, (int, float)):
                cv2.drawMarker(frame, (int(float(raw_x) * width), int(float(raw_y) * height)), (0, 0, 255), cv2.MARKER_CROSS, 18, 2)
            smooth_x = diagnostic.get("smoothedAnchorX")
            smooth_y = diagnostic.get("smoothedAnchorY")
            if isinstance(smooth_x, (int, float)) and isinstance(smooth_y, (int, float)):
                cv2.circle(frame, (int(float(smooth_x) * width), int(float(smooth_y) * height)), 8, (255, 210, 0), 2)
            label = (
                f"id={diagnostic.get('trackId') or keyframe.get('trackId') or 'none'} "
                f"source={diagnostic.get('source') or keyframe.get('source') or 'unknown'} "
                f"confidence={float(diagnostic.get('confidence', keyframe.get('confidence', 0.0)) or 0.0):.2f}"
            )
            cv2.putText(frame, label, (18, 34), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 255, 255), 2, cv2.LINE_AA)
            process.stdin.write(frame.tobytes())
            rendered += 1
        process.stdin.close()
        stderr = process.stderr.read().decode("utf-8", "replace")
        if process.wait() != 0 or rendered <= 0:
            raise RuntimeError(stderr[-1200:] or "debug overlay encoder failed")
        return os.path.isfile(output_path) and os.path.getsize(output_path) > 1024
    except Exception:
        try:
            if process and process.stdin and not process.stdin.closed:
                process.stdin.close()
            if process:
                process.kill()
                process.wait(timeout=5)
        except Exception:
            pass
        return False
    finally:
        capture.release()


def render_final_from_master(
    input_url,
    local_fallback_path,
    output_path,
    clip_start,
    clip_duration,
    crop_focus="center",
    crop_keyframes=None,
    sendcmd_path=None,
    subtitle_path=None,
    output_fps=OUTPUT_FPS,
    fit_source=False,
    preserve_source=False,
    render_quality="premium",
):
    """Create the final file directly from the source master in one encode.

    Plates and responsive proxies are intentionally excluded from this path:
    they are analysis artifacts only.  This avoids the historic
    source -> plate -> crop -> subtitle double-lossy pipeline.
    """
    fps = max(30, min(60, int(round(float(output_fps or OUTPUT_FPS)))))
    if crop_keyframes and len(crop_keyframes) >= 2 and os.path.isfile(str(input_url or "")):
        if render_per_frame_crop_from_master(
            input_url,
            output_path,
            clip_start,
            clip_duration,
            crop_keyframes,
            subtitle_path=subtitle_path,
            output_fps=fps,
            render_quality=render_quality,
        ):
            return "source-master-per-frame-crop"
    base = ["-ss", str(clip_start), "-i", input_url, "-t", str(clip_duration)]
    if preserve_source:
        # A scene with no verified face is not a tracking failure to hide by
        # inventing a centre crop. Preserve the source composition exactly,
        # fitting it inside the delivery canvas with neutral letterboxing.
        # This is intentionally different from `fit_source`, which fills a
        # vertical canvas by centre-cropping a landscape source.
        filters = [
            f"scale={OUTPUT_WIDTH}:{OUTPUT_HEIGHT}:force_original_aspect_ratio=decrease:flags=lanczos",
            f"pad={OUTPUT_WIDTH}:{OUTPUT_HEIGHT}:(ow-iw)/2:(oh-ih):color=black",
            f"fps={fps}",
        ]
        if subtitle_path and os.path.isfile(subtitle_path):
            filters.append(f"ass='{_escape_ass_path(subtitle_path)}'")
        base += ["-vf", ",".join(filters), "-r", str(fps)]
    elif fit_source:
        # Fill the requested delivery frame with the master source itself. For
        # a landscape source this is an intentional centre crop, not a blurred
        # background plus a smaller foreground video.
        filters = [
            f"scale={OUTPUT_WIDTH}:{OUTPUT_HEIGHT}:force_original_aspect_ratio=increase",
            f"crop={OUTPUT_WIDTH}:{OUTPUT_HEIGHT}",
            f"fps={fps}",
        ]
        if subtitle_path and os.path.isfile(subtitle_path):
            filters.append(f"ass='{_escape_ass_path(subtitle_path)}'")
        base += ["-vf", ",".join(filters), "-r", str(fps)]
    else:
        crop_part = build_crop_filter(
            OUTPUT_WIDTH,
            OUTPUT_HEIGHT,
            keyframes=crop_keyframes,
            crop_focus=crop_focus,
            sendcmd_path=sendcmd_path,
        )
        # Crop first, then composite ASS onto the final 1080x1920 delivery
        # canvas.  Captions therefore use fixed output coordinates and never
        # inherit subject/crop-path movement.
        filters = [crop_part, f"fps={fps}"]
        if subtitle_path and os.path.isfile(subtitle_path):
            filters.append(f"ass='{_escape_ass_path(subtitle_path)}'")
        base += ["-vf", ",".join(filters), "-r", str(fps)]
    # This is the sole final encode from the source master. It intentionally
    # never uses the 360/480 analysis stream or a subtitle-burned preview.
    base += [*render_encoding_args(render_quality), output_path]
    # A premium 1080×1920 / 60 fps source-master encode can legitimately take
    # longer than twelve times the clip duration on a CPU-only 8 GB machine.
    # In particular, x264's `veryslow` preset should not be killed midway and
    # leave a partial MP4 simply because it is preserving the requested quality.
    render_timeout = max(
        900 if render_quality == "premium" else 480,
        int(clip_duration * (30 if render_quality == "premium" else 16)),
    )
    try:
        run_ffmpeg(base, timeout=render_timeout)
        return "source-master"
    except subprocess.CalledProcessError:
        if not local_fallback_path or local_fallback_path == input_url:
            raise
    fallback = base.copy()
    fallback[fallback.index(input_url)] = local_fallback_path
    run_ffmpeg(fallback, timeout=render_timeout)
    return "downloaded-source-master"


def render_from_plate(
    plate_path,
    clip_path,
    crop_focus="center",
    crop_keyframes=None,
    sendcmd_path=None,
    fit_source=False,
    preserve_source=False,
    render_quality="premium",
    subtitle_path=None,
    output_fps=None,
):
    """Re-render a saved plate without replacing a dynamic crop by its first keyframe.

    A refine operation has only the stored plate available, but it still owns
    the exact crop trajectory generated by the tracker.  The old legacy path
    handed that trajectory to FFmpeg's static crop fallback, which quietly
    discarded movement whenever a user edited subtitles or toggled tracking.
    Keep the bounded per-frame renderer here too, then composite ASS in that
    same final encode so captions stay fixed to the delivery canvas.
    """
    fps = max(30, min(60, int(round(float(output_fps or output_frame_rate(source_quality_report(plate_path)) or OUTPUT_FPS)))))
    if not fit_source and crop_keyframes and len(crop_keyframes) >= 2:
        if render_per_frame_crop_from_master(
            plate_path,
            clip_path,
            0.0,
            probe_duration(plate_path),
            crop_keyframes,
            subtitle_path=subtitle_path if subtitle_path and os.path.isfile(subtitle_path) else None,
            output_fps=fps,
            render_quality=render_quality,
        ):
            return
    if preserve_source:
        filter_complex = (
            f"[0:v]scale={OUTPUT_WIDTH}:{OUTPUT_HEIGHT}:force_original_aspect_ratio=decrease:flags=lanczos,"
            f"pad={OUTPUT_WIDTH}:{OUTPUT_HEIGHT}:(ow-iw)/2:(oh-ih):color=black,fps={fps}[v]"
        )
        if subtitle_path and os.path.isfile(subtitle_path):
            filter_complex = filter_complex.replace("[v]", f",ass='{_escape_ass_path(subtitle_path)}'[v]")
        run_ffmpeg([
            "-i", plate_path,
            "-filter_complex", filter_complex,
            "-map", "[v]", "-map", "0:a?", "-r", str(fps),
            *render_encoding_args(render_quality),
            clip_path,
        ], timeout=90)
        return
    if fit_source:
        filter_complex = (
            f"[0:v]scale={OUTPUT_WIDTH}:{OUTPUT_HEIGHT}:force_original_aspect_ratio=increase,"
            f"crop={OUTPUT_WIDTH}:{OUTPUT_HEIGHT},fps={fps}[v]"
        )
        if subtitle_path and os.path.isfile(subtitle_path):
            # ASS is deliberately last: crop/layout decisions operate on clean
            # video pixels and captions use stable 1080p canvas coordinates.
            filter_complex = filter_complex.replace("[v]", f",ass='{_escape_ass_path(subtitle_path)}'[v]")
        run_ffmpeg([
            "-i", plate_path,
            "-filter_complex", filter_complex,
            "-map", "[v]", "-map", "0:a?", "-r", str(fps),
            # This is only used by the legacy refine path. Keep its encode
            # profile aligned with direct master renders.
            *render_encoding_args(render_quality),
            clip_path,
        ], timeout=90)
        return
    crop_part = build_crop_filter(
        OUTPUT_WIDTH,
        OUTPUT_HEIGHT,
        keyframes=crop_keyframes,
        crop_focus=crop_focus,
        sendcmd_path=sendcmd_path,
    )
    video_filter = f"{crop_part},fps={fps}"
    if subtitle_path and os.path.isfile(subtitle_path):
        video_filter += f",ass='{_escape_ass_path(subtitle_path)}'"
    run_ffmpeg(
        [
            "-i",
            plate_path,
            "-vf",
            video_filter,
            "-r",
            str(fps),
            *render_encoding_args(render_quality),
            clip_path,
        ],
        timeout=90,
    )


def artifact_dir_for(output_name):
    root = os.path.join(TMP_ROOT, CLIP_ARTIFACT_DIR)
    os.makedirs(root, exist_ok=True)
    base = os.path.splitext(os.path.basename(output_name))[0]
    path = os.path.join(root, base)
    os.makedirs(path, exist_ok=True)
    return path


def _faces_with_urls(artifact_id, faces):
    out = []
    for face in faces or []:
        item = dict(face)
        url = item.get("thumbnailUrl")
        thumb = item.get("thumbnailPath") or item.get("thumbnail")
        if url and str(url).startswith("/"):
            item["thumbnailUrl"] = url
        elif url:
            item["thumbnailUrl"] = f"/api/clipper/artifact/{artifact_id}/{url}"
        elif thumb and isinstance(thumb, str) and thumb.startswith("/"):
            item["thumbnailUrl"] = thumb
        elif item.get("id"):
            item["thumbnailUrl"] = f"/api/clipper/artifact/{artifact_id}/faces/{item['id']}.jpg"
        # Normalize bbox for the studio overlay from sampleBbox / bboxSamples.
        if not item.get("bbox") and item.get("sampleBbox"):
            box = item["sampleBbox"]
            if isinstance(box, (list, tuple)) and len(box) >= 4:
                item["bbox"] = {
                    "x": float(box[0]),
                    "y": float(box[1]),
                    "width": float(box[2] - box[0]),
                    "height": float(box[3] - box[1]),
                }
            elif isinstance(box, dict):
                item["bbox"] = box
        out.append(item)
    return out


def _relocate_face_thumbs(artifact_dir, crop_plan):
    """Copy person thumbnails into the artifact and rewrite paths for the API."""
    if not isinstance(crop_plan, dict):
        return crop_plan
    faces_dir = os.path.join(artifact_dir, "faces")
    os.makedirs(faces_dir, exist_ok=True)
    available = []
    for face in crop_plan.get("availableFaces") or crop_plan.get("people") or []:
        item = dict(face)
        src = item.get("thumbnailPath") or item.get("thumbnail")
        if src and os.path.isfile(str(src)):
            dest_name = f"{item.get('id') or 'person'}.jpg"
            dest = os.path.join(faces_dir, dest_name)
            try:
                if os.path.abspath(src) != os.path.abspath(dest):
                    shutil.copy2(src, dest)
                item["thumbnailPath"] = dest
                item["thumbnail"] = dest
                item["thumbnailUrl"] = f"faces/{dest_name}"
            except Exception:
                pass
        available.append(item)
    crop_plan = dict(crop_plan)
    crop_plan["availableFaces"] = available
    if crop_plan.get("selectedPerson") and isinstance(crop_plan["selectedPerson"], dict):
        selected = dict(crop_plan["selectedPerson"])
        match = next((face for face in available if face.get("id") == selected.get("id")), None)
        if match:
            selected["thumbnailPath"] = match.get("thumbnailPath")
            selected["thumbnailUrl"] = match.get("thumbnailUrl")
        crop_plan["selectedPerson"] = selected
    write_json(os.path.join(artifact_dir, "detected-people.json"), available)
    scenes = crop_plan.get("scenes") or crop_plan.get("acceptedScenes") or []
    write_json(os.path.join(artifact_dir, "accepted-face-scenes.json"), [s for s in scenes if s.get("accepted")])
    write_json(os.path.join(artifact_dir, "crop-keyframes.json"), crop_plan.get("cropKeyframes") or [])
    if crop_plan.get("selectedPerson") or crop_plan.get("faceTracking"):
        write_json(
            os.path.join(artifact_dir, "selected-person.json"),
            crop_plan.get("selectedPerson")
            or {
                "personId": (crop_plan.get("faceTracking") or {}).get("selectedPersonId"),
                "sceneMode": (crop_plan.get("faceTracking") or {}).get("sceneMode"),
            },
        )
    return crop_plan


def persist_clip_artifacts(artifact_dir, *, words, meta, plate_path=None, subtitle_path=None, crop_plan=None):
    write_json(os.path.join(artifact_dir, "words.json"), words)
    write_json(os.path.join(artifact_dir, "meta.json"), meta)
    if crop_plan is not None:
        crop_plan = _relocate_face_thumbs(artifact_dir, crop_plan)
        write_json(os.path.join(artifact_dir, "crop-plan.json"), crop_plan)
    if plate_path and os.path.isfile(plate_path):
        dest = os.path.join(artifact_dir, "plate.mp4")
        if os.path.abspath(plate_path) != os.path.abspath(dest):
            shutil.copy2(plate_path, dest)
    if subtitle_path and os.path.isfile(subtitle_path):
        dest = os.path.join(artifact_dir, "captions.ass")
        if os.path.abspath(subtitle_path) != os.path.abspath(dest):
            shutil.copy2(subtitle_path, dest)
    return crop_plan


def transcribe_clip_words(clip_path):
    global _FASTER_WHISPER_MODEL, _OPENAI_WHISPER_MODEL
    expose_ffmpeg_to_subprocesses()

    words = []
    try:
        from faster_whisper import WhisperModel

        model_name = os.environ.get("CLIPPER_WHISPER_MODEL", "base.en")
        compute_type = os.environ.get("WHISPER_COMPUTE_TYPE", "int8")
        if _FASTER_WHISPER_MODEL is None:
            _FASTER_WHISPER_MODEL = WhisperModel(model_name, device="cpu", compute_type=compute_type)
        segments, _info = _FASTER_WHISPER_MODEL.transcribe(
            clip_path,
            word_timestamps=True,
            vad_filter=True,
            beam_size=3,
            language="en",
            condition_on_previous_text=False,
        )
        for segment in segments:
            for item in segment.words or []:
                token = re.sub(r"[^A-Za-z0-9']+", "", str(item.word or "").strip()).upper()
                if not token:
                    continue
                start = max(0.0, float(item.start or 0.0))
                end = max(start + 0.05, float(item.end or start + 0.2))
                words.append({"word": token[:28], "start": start, "end": end})
        if words:
            return words
    except Exception:
        words = []

    import whisper

    model_name = os.environ.get("CLIPPER_WHISPER_MODEL", "base.en")
    if _OPENAI_WHISPER_MODEL is None:
        _OPENAI_WHISPER_MODEL = whisper.load_model(model_name)
    result = _OPENAI_WHISPER_MODEL.transcribe(
        clip_path,
        word_timestamps=True,
        language="en",
        fp16=False,
        temperature=0,
        condition_on_previous_text=False,
        verbose=False,
    )

    for segment in result.get("segments", []):
        for item in segment.get("words", []) or []:
            token = re.sub(r"[^A-Za-z0-9']+", "", str(item.get("word", "")).strip()).upper()
            if not token:
                continue
            try:
                start = max(0.0, float(item.get("start", 0.0)))
                end = max(start + 0.05, float(item.get("end", start + 0.2)))
            except (TypeError, ValueError):
                continue
            words.append({"word": token[:28], "start": start, "end": end})
    return words


def caption_words_relative(words, clip_start, clip_end):
    return [
        {"word": word["word"], "start": max(0.0, word["start"] - clip_start), "end": max(0.05, word["end"] - clip_start)}
        for word in words
        if clip_start <= word["start"] <= clip_end
    ]


def burn_subtitles(source_clip_path, output_path, subtitle_path, render_quality="premium", output_fps=OUTPUT_FPS):
    subtitle_filter = f"ass={subtitle_path}"
    run_ffmpeg(
        [
            "-i",
            source_clip_path,
            "-vf",
            subtitle_filter,
            "-r",
            str(output_fps),
            *render_encoding_args(render_quality),
            output_path,
        ],
        timeout=90,
    )


def refine_clip(cfg):
    """Re-crop + subtitle burn from persisted plate/words without re-download/ASR."""
    global OUTPUT_WIDTH, OUTPUT_HEIGHT
    artifact_id = str(cfg.get("artifact_id") or cfg.get("clip_id") or "").strip()
    if not artifact_id:
        fail("refine requires artifact_id")
    artifact_dir = os.path.join(TMP_ROOT, CLIP_ARTIFACT_DIR, os.path.basename(artifact_id))
    # Allow either basename of output or explicit artifact folder name.
    if not os.path.isdir(artifact_dir):
        artifact_dir = os.path.join(TMP_ROOT, CLIP_ARTIFACT_DIR, os.path.splitext(os.path.basename(artifact_id))[0])
    if not os.path.isdir(artifact_dir):
        fail(f"Clip artifacts not found for {artifact_id}")

    meta = read_json(os.path.join(artifact_dir, "meta.json"), {})
    words = read_json(os.path.join(artifact_dir, "words.json"), [])
    plate_path = os.path.join(artifact_dir, "plate.mp4")
    if not os.path.isfile(plate_path):
        fail("Plate clip missing; cannot refine face tracking without re-download")

    aspect = str(cfg.get("aspect_ratio") or meta.get("aspect_ratio") or "9:16")
    OUTPUT_WIDTH, OUTPUT_HEIGHT = {
        "1:1": (1080, 1080),
        "16:9": (1920, 1080),
    }.get(aspect, (1080, 1920))
    crop_focus = str(cfg.get("crop_focus") or meta.get("crop_focus") or "center")
    face_cfg = face_tracking_config(cfg)
    font = str(cfg.get("font") or meta.get("font") or "Impact")
    font_size = min(92, max(44, int(cfg.get("font_size") or meta.get("font_size") or 74)))
    text_color = str(cfg.get("text_colour") or meta.get("text_colour") or "#FFFFFF")
    position = str(cfg.get("position") or meta.get("position") or "bottom")
    caption_x = cfg.get("caption_x", cfg.get("captionX", meta.get("caption_x", meta.get("captionX"))))
    caption_y = cfg.get("caption_y", cfg.get("captionY", meta.get("caption_y", meta.get("captionY"))))
    subtitle_style = str(cfg.get("subtitle_style") or cfg.get("subtitleStyle") or meta.get("subtitle_style") or "word")
    captions_enabled = bool(cfg.get("captions_enabled", meta.get("captions_enabled", True)))
    collision_mode = str(cfg.get("caption_collision_mode") or cfg.get("captionCollisionMode") or meta.get("caption_collision_mode") or "keep-existing").lower()
    render_quality = normalise_render_quality(cfg.get("render_quality") or cfg.get("renderQuality") or meta.get("render_quality") or "premium")

    edited_words = cfg.get("words")
    if isinstance(edited_words, list) and edited_words:
        words = edited_words
    ass_override = cfg.get("ass")
    clip_duration = float(meta.get("clip_duration") or probe_duration(plate_path))
    shot_boundaries = read_json(os.path.join(artifact_dir, "shot-boundaries.json"), [])
    if not isinstance(shot_boundaries, list):
        shot_boundaries = []

    emit("clip", "running", message="Planning timestamped subject framing for saved clip...")
    frame_w, frame_h = probe_video_size(FFPROBE, FFMPEG, plate_path)
    plate_quality = source_quality_report(plate_path)
    faces_dir = os.path.join(artifact_dir, "faces")
    crop_plan = track_faces_and_build_crops(
        FFMPEG,
        plate_path,
        0.0,
        clip_duration,
        OUTPUT_WIDTH,
        OUTPUT_HEIGHT,
        mode=face_cfg["mode"] if face_cfg["enabled"] else "smooth",
        selected_track_id=face_cfg.get("selectedPersonId") or face_cfg.get("selectedTrackId"),
        selected_person_id=face_cfg.get("selectedPersonId") or face_cfg.get("selectedTrackId"),
        person_mode=face_cfg.get("personMode") or face_cfg.get("sceneMode", "strict"),
        scene_mode=face_cfg.get("sceneMode") or face_cfg.get("personMode", "strict"),
        allow_zoom=face_cfg.get("allowZoom", True),
        crop_focus=crop_focus,
        cache_root=os.path.join(TMP_ROOT, "clipper-face-cache"),
        frame_w=frame_w,
        frame_h=frame_h,
        shot_boundaries=shot_boundaries,
        scene_rules=face_cfg.get("sceneRules"),
        thumb_dir=faces_dir,
        reframe_mode=face_cfg.get("reframeMode", "auto"),
        speaker_mode=face_cfg.get("speakerMode", "auto"),
        tracking_quality=face_cfg.get("trackingQuality", "balanced"),
        split_screen_requested=face_cfg.get("splitScreenRequested", False),
        source_fps=tracking_source_frame_rate(plate_quality),
    )
    if not face_cfg["enabled"] and face_cfg.get("smartReframe", True):
        crop_plan = build_smart_reframe_keyframes(crop_plan)
    selected_id = face_cfg.get("selectedPersonId") or face_cfg.get("selectedTrackId")
    if selected_id:
        crop_plan["faceTracking"]["selectedTrackId"] = selected_id
        crop_plan["faceTracking"]["selectedPersonId"] = selected_id
    mode_value = face_cfg.get("personMode") or face_cfg.get("sceneMode", "strict")
    crop_plan["faceTracking"]["personMode"] = mode_value
    crop_plan["faceTracking"]["sceneMode"] = mode_value

    if face_cfg.get("enableDebugOverlay"):
        debug_path = os.path.join(artifact_dir, "tracking_debug.mp4")
        if render_tracking_debug_overlay(
            plate_path,
            debug_path,
            0.0,
            clip_duration,
            crop_plan.get("cropKeyframes") or [],
            crop_plan.get("trackingDiagnostics") or [],
            output_fps=output_frame_rate(plate_quality),
        ):
            crop_plan["debugOutput"] = debug_path

    caption_collision = detect_embedded_caption_risk(plate_path, os.path.join(artifact_dir, "caption-audit"))
    effective_caption_position = position
    custom_caption_position = has_manual_caption_placement(cfg, caption_x, caption_y)
    effective_captions_enabled = captions_enabled
    if captions_enabled and caption_collision.get("detected"):
        if collision_mode == "keep-existing":
            effective_captions_enabled = False
            caption_collision["action"] = "kept-existing"
        elif collision_mode != "allow-overlap" and not custom_caption_position and position in {"bottom", "bottom-centre"}:
            effective_caption_position = "top"
            caption_collision["action"] = "relocated"
            caption_collision["placement"] = "top"
        else:
            caption_collision["action"] = "preserved"
            caption_collision["placement"] = position

    render_caption_x = caption_x
    render_caption_y = caption_y
    if caption_collision.get("action") == "relocated":
        # The default bottom slider's y=78 must not override the automatic
        # top safe-zone anchor chosen by collision avoidance.
        render_caption_x = None
        render_caption_y = None

    subtitle_path = os.path.join(artifact_dir, "captions.ass")
    if isinstance(ass_override, str) and ass_override.strip():
        with open(subtitle_path, "w", encoding="utf-8") as handle:
            handle.write(ass_override)
        subtitle_count = ass_override.count("Dialogue:")
    else:
        subtitle_count = write_subtitles(
            subtitle_path,
            words,
            0.0,
            clip_duration,
            font,
            font_size,
            text_color,
            effective_caption_position,
            subtitle_style,
            render_caption_x,
            render_caption_y,
        )

    output_name = str(cfg.get("output_name") or meta.get("output_name") or f"{os.path.basename(artifact_dir)}-refined.mp4")
    if not output_name.endswith(".mp4"):
        output_name += ".mp4"
    output_path = os.path.join(OUTPUT_DIR, output_name)
    emit("render", "running", message="Re-encoding refined clip...")
    clean_clip_path = os.path.join(artifact_dir, "clean-refined.mp4")
    sendcmd_path = os.path.join(artifact_dir, "crop.sendcmd")
    render_from_plate(
        plate_path,
        clean_clip_path,
        crop_focus=crop_focus,
        crop_keyframes=(
            crop_plan.get("cropKeyframes")
            if face_cfg["enabled"] or (crop_plan.get("faceTracking") or {}).get("smartReframe")
            else None
        ),
        sendcmd_path=(
            sendcmd_path
            if face_cfg["enabled"] or (crop_plan.get("faceTracking") or {}).get("smartReframe")
            else None
        ),
        preserve_source=bool((crop_plan.get("faceTracking") or {}).get("preserveSource")),
        fit_source=(
            not bool((crop_plan.get("faceTracking") or {}).get("enabled"))
            and not bool((crop_plan.get("faceTracking") or {}).get("smartReframe"))
            and (frame_w / max(1, frame_h)) > (OUTPUT_WIDTH / max(1, OUTPUT_HEIGHT)) + 0.02
        ),
        render_quality=render_quality,
        subtitle_path=subtitle_path if effective_captions_enabled and subtitle_count > 0 else None,
        output_fps=output_frame_rate(plate_quality),
    )
    # `render_from_plate` composes captions after the crop in its only final
    # encode. Copy the finished artifact rather than adding a second lossy
    # subtitle pass that could make captions appear soft or move with a crop.
    shutil.copy2(clean_clip_path, output_path)

    crop_plan = persist_clip_artifacts(
        artifact_dir,
        words=words,
        meta={
            **meta,
            "face_tracking": crop_plan.get("faceTracking"),
            "aspect_ratio": aspect,
            "crop_focus": crop_focus,
            "caption_collision": caption_collision,
            "caption_collision_mode": collision_mode,
            "captions_enabled": effective_captions_enabled,
            "caption_position": effective_caption_position,
            "caption_x": caption_x,
            "caption_y": caption_y,
            "render_quality": render_quality,
        },
        plate_path=plate_path,
        subtitle_path=subtitle_path,
        crop_plan=crop_plan,
    ) or crop_plan
    write_json(os.path.join(artifact_dir, "edit-plan-clip.json"), {
        "faceTracking": crop_plan.get("faceTracking"),
        "cropKeyframes": crop_plan.get("cropKeyframes"),
        "scenes": crop_plan.get("scenes") or [],
        "faceOverlay": crop_plan.get("faceOverlay") or [],
    })

    result = {
        "id": meta.get("clip_id") or "candidate-1",
        "rank": int(meta.get("rank") or 1),
        "output": f"./output/{output_name}",
        "title": meta.get("title") or "Refined clip",
        "source_title": meta.get("source_title"),
        "source_start": meta.get("source_start"),
        "source_end": meta.get("source_end"),
        "clip_duration": f"{round(clip_duration)}s",
        "reason": meta.get("reason") or "Refined crop / captions",
        "caption": " ".join(w.get("word", "") for w in words if len(w.get("word", "")) > 2)[:220],
        "words": words,
        "hashtags": meta.get("hashtags") or "#shorts",
        "virality_score": meta.get("virality_score") or 7.0,
        "score": int(meta.get("score") or 70),
        "clip_potential_score": int(meta.get("score") or 70),
        "file_size": os.path.getsize(output_path),
        "timing_source": "refine",
        "word_count": subtitle_count if effective_captions_enabled else 0,
        "caption_collision": caption_collision,
        "captions_enabled": effective_captions_enabled,
        "caption_position": effective_caption_position,
        "output_quality": f"{OUTPUT_WIDTH}x{OUTPUT_HEIGHT} {aspect} {render_quality_label(render_quality)} legacy-plate-refine",
        "artifact_id": os.path.basename(artifact_dir),
        "face_tracking": crop_plan.get("faceTracking"),
        "available_faces": _faces_with_urls(os.path.basename(artifact_dir), crop_plan.get("availableFaces") or []),
        "crop_keyframes": crop_plan.get("cropKeyframes") or [],
        "face_overlay": crop_plan.get("faceOverlay") or [],
        "face_scenes": crop_plan.get("scenes") or [],
        "plate_url": f"/api/clipper/artifact/{os.path.basename(artifact_dir)}/plate.mp4",
    }
    emit("render", "complete", message="Refined clip ready")
    emit("complete", "complete", message="Refine complete", results=[result], output=result["output"], **{k: result[k] for k in ("title", "clip_duration", "reason", "caption", "file_size")})
    print(json.dumps({"type": "clip_result", "step": "result", "status": "complete", "message": "Refined clip ready", "result": result}), flush=True)


def _public_face_thumb(job_id, thumb_path):
    """Map an on-disk face thumb to the Express face-cache URL the UI can load."""
    if not thumb_path or not job_id:
        return ""
    name = os.path.basename(str(thumb_path))
    if not name or ".." in name:
        return ""
    return f"/api/clipper/face-cache/{job_id}/thumbs/{name}"


def scan_people_cli(cfg):
    """Scan a local video for recurring people (picker helper for the create wizard)."""
    source = str(cfg.get("source") or cfg.get("path") or "").strip()
    if not source or not os.path.isfile(source):
        fail("scan-people requires a local video path in config.source")
    start = float(cfg.get("start") or 0.0)
    duration = cfg.get("duration")
    duration = float(duration) if duration is not None else None
    cache_root = os.path.join(TMP_ROOT, "clipper-face-cache")
    emit("analyze", "running", message="Scanning people for face picker...")
    payload = scan_people(
        FFMPEG,
        source,
        start=start,
        duration=duration,
        cache_root=cache_root,
        job_id=str(cfg.get("job_id") or cfg.get("jobId") or "") or None,
        max_people=int(cfg.get("max_people") or cfg.get("maxPeople") or 8),
    )
    job_id = str(payload.get("jobId") or "")
    people = []
    for person in payload.get("people") or []:
        row = dict(person)
        thumb = row.get("thumbnail") or row.get("thumbnailPath") or ""
        public = _public_face_thumb(job_id, thumb)
        if public:
            row["thumbnailUrl"] = public
            row["thumbnail"] = public
        row["personId"] = row.get("personId") or row.get("id")
        people.append(row)
    payload["people"] = people
    emit(
        "complete",
        "complete",
        message=f"Found {len(people)} people",
        people=people,
        scenes=payload.get("scenes") or [],
        jobId=job_id,
        cacheDir=payload.get("cacheDir"),
        capabilities=payload.get("capabilities"),
        selectedPersonId=(people[0].get("id") if people else None),
    )
    print(
        json.dumps(
            {
                "type": "people_scan",
                "status": "complete",
                **payload,
                "selectedPersonId": (people[0].get("id") if people else None),
            }
        ),
        flush=True,
    )


def main():
    global OUTPUT_WIDTH, OUTPUT_HEIGHT, TMP_ROOT, OUTPUT_DIR
    if len(sys.argv) < 2:
        fail("Usage: clipper-pipeline.py <url-or-file|--refine|--scan-people> [config]")

    install_cancellation_handlers()

    # Allow CLYRA_TMP_DIR / CLYRA_OUTPUT_DIR overrides set by Electron/Express.
    env_tmp = (os.environ.get("CLYRA_TMP_DIR") or "").strip()
    if env_tmp:
        TMP_ROOT = env_tmp
    OUTPUT_DIR = resolve_output_dir()

    if sys.argv[1].strip() in {"--refine", "refine"}:
        cfg = json.loads(sys.argv[2]) if len(sys.argv) > 2 else {}
        try:
            refine_clip(cfg)
        except PipelineCancelled:
            emit("cancelled", "cancelled", message="Refine cancelled; saved clip artifacts were left intact")
        except SystemExit:
            raise
        except Exception as exc:
            fail(f"{type(exc).__name__}: {exc}")
        return

    if sys.argv[1].strip() in {"--scan-people", "scan-people"}:
        cfg = json.loads(sys.argv[2]) if len(sys.argv) > 2 else {}
        try:
            scan_people_cli(cfg)
        except PipelineCancelled:
            emit("cancelled", "cancelled", message="People scan cancelled; partial scan data was discarded")
        except SystemExit:
            raise
        except Exception as exc:
            fail(f"{type(exc).__name__}: {exc}")
        return

    source = sys.argv[1].strip()
    # Preserve the public import identity before `source` becomes a temporary
    # downloaded filename. This lets the durable analysis cache survive a
    # fresh downloader job for the same public video.
    requested_source_identity = source
    cfg = json.loads(sys.argv[2]) if len(sys.argv) > 2 else {}
    font = str(cfg.get("font", "Impact"))
    font_size = min(92, max(44, int(cfg.get("font_size", 74))))
    text_color = str(cfg.get("text_colour", "#FFFFFF"))
    position = str(cfg.get("position", "bottom"))
    caption_x = cfg.get("caption_x", cfg.get("captionX"))
    caption_y = cfg.get("caption_y", cfg.get("captionY"))
    subtitle_style = str(cfg.get("subtitle_style") or cfg.get("subtitleStyle") or "word")
    moment_type = str(cfg.get("moment_type", "viral"))
    requested_duration = parse_duration(cfg.get("clip_duration", MAX_CLIP_LENGTH))
    aspect = str(cfg.get("aspect_ratio", "9:16"))
    crop_focus = str(cfg.get("crop_focus", "center"))
    captions_enabled = bool(cfg.get("captions_enabled", True))
    remove_fillers = bool(cfg.get("remove_fillers", True))
    render_quality = normalise_render_quality(cfg.get("render_quality") or cfg.get("renderQuality") or "premium")
    clip_count = min(8, max(1, int(cfg.get("clip_count", 3))))
    face_cfg = face_tracking_config(cfg)
    OUTPUT_WIDTH, OUTPUT_HEIGHT = {
        "1:1": (1080, 1080),
        "16:9": (1920, 1080),
    }.get(aspect, (1080, 1920))
    base_name = clean_name(str(cfg.get("clip_name", "clip")))
    job_id = f"{base_name}-{int(time.time() * 1000) % 1000000}"

    os.makedirs(TMP_ROOT, exist_ok=True)
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    job_tmp = os.path.join(TMP_ROOT, job_id)
    os.makedirs(job_tmp, exist_ok=True)
    started = time.time()

    try:
        check_cancelled()
        emit("captions", "running", message="Reading captions and video metadata...")
        local_source = os.path.isfile(source)
        imported_source_kind = "local-file" if local_source else "public-url"
        yt = None
        stream_url = source
        fallback_path = source if local_source else ""
        if local_source:
            title = os.path.splitext(os.path.basename(source))[0].replace("-", " ").replace("_", " ").strip() or "Uploaded video"
            duration = probe_duration(source)
            words = transcribe_clip_words(source)
        else:
            try:
                from pytubefix import YouTube

                yt = YouTube(source)
                title = yt.title or "YouTube video"
                duration = float(yt.length or requested_duration)
                words = load_caption_words(yt)
                stream_url = select_progressive_stream(yt).url
                emit("captions", "running", message="Retaining a local source master for analysis and final rendering...")
                try:
                    source = download_public_source_master(source, job_tmp)
                except Exception:
                    # The adaptive fallback keeps a 1080p source master when
                    # yt-dlp is blocked by YouTube's proof-of-origin gate.
                    # Only fall all the way back to progressive 360p when the
                    # separate audio/video adaptive streams truly cannot load.
                    emit("captions", "running", message="Retaining the best available adaptive YouTube video and audio streams...")
                    try:
                        source = download_adaptive_youtube_master(yt, job_tmp)
                    except Exception:
                        emit("captions", "running", message="Using the accessible progressive YouTube stream fallback for real video analysis...")
                        source = download_progressive_youtube_master(yt, job_tmp)
                stream_url = source
                fallback_path = source
                local_source = True
            except Exception:
                emit("captions", "running", message="Preparing the public video source...")
                try:
                    source = download_public_source_master(source, job_tmp)
                except Exception as exc:
                    fail(f"Clyra could not retain a local source master for final rendering ({type(exc).__name__}).")
                stream_url = source
                fallback_path = source
                local_source = True
                try:
                    duration = probe_duration(source)
                except Exception:
                    duration = requested_duration
                words = transcribe_clip_words(source)

        audit_source = source if local_source and os.path.isfile(source) else (fallback_path or stream_url)
        emit("source-audit", "running", message="Auditing master media quality before rendering...")
        source_quality = source_quality_report(audit_source)
        emit(
            "source-audit", "complete",
            message=(
                f"Master source: {source_quality['width']}×{source_quality['height']} at {source_quality['frameRate'] or 'unknown'} fps"
                if source_quality.get("width") else "Master source audit completed with limited stream metadata"
            ),
            source_quality=source_quality,
        )

        # Preserve this immutable master reference before a user-directed range
        # becomes a small local analysis plate.  The range keeps candidate
        # analysis efficient, but final pixels must still be decoded directly
        # from the original retained source at the source-relative timestamp.
        master_source = source if local_source and os.path.isfile(source) else fallback_path
        if not master_source or not os.path.isfile(master_source):
            master_source = None

        # Preserve the source identity before a user-directed range becomes a
        # short local plate.  The range itself gets a distinct cache entry, so
        # a range never reuses evidence from an unrelated part of the video.
        origin_duration = float(duration)
        origin_source_fingerprint = source_fingerprint(source if imported_source_kind == "local-file" else requested_source_identity)
        source_range = resolve_source_range(cfg, origin_duration, requested_duration)
        source_origin = {
            "mode": "full-source",
            "sourceDurationSeconds": round(origin_duration, 3),
            "startSeconds": 0.0,
            "endSeconds": round(origin_duration, 3),
            "durationSeconds": round(origin_duration, 3),
            "clamped": False,
        }
        moment_request = str(cfg.get("moment_request") or cfg.get("momentRequest") or "").strip()
        # The default stays within an 8 GB CPU machine.  Deployments that
        # provision an isolated high-memory verifier may opt in explicitly;
        # the provider itself enforces the resource gate again before launch.
        video_understanding_profile = str(
            cfg.get("video_understanding_profile") or cfg.get("videoUnderstandingProfile") or "8gb_cpu"
        ).strip().lower() or "8gb_cpu"
        # A custom request is the retrieval query.  The broad objective remains
        # useful for scoring, but must not replace what the user actually asked
        # Clyra to find.
        selection_intent = moment_request or moment_type

        if source_range:
            emit(
                "captions",
                "running",
                message=(
                    f"Preparing the requested source range at {fmt_time(source_range['startSeconds'])}..."
                ),
                source_range=source_range,
            )
            range_source = os.path.join(job_tmp, "source-range.mp4")
            try:
                extract_plate_clip(
                    stream_url,
                    fallback_path,
                    range_source,
                    source_range["startSeconds"],
                    source_range["durationSeconds"],
                    analysis_only=False,
                )
            except Exception:
                # The normal public-source path uses a progressive stream. If
                # its short range request expires, use the existing
                # downloader fallback rather than expanding the requested
                # range or abandoning the same source.
                if local_source or not yt:
                    raise
                fallback_path = os.path.join(job_tmp, "source.mp4")
                if not os.path.isfile(fallback_path):
                    select_progressive_stream(yt).download(job_tmp, filename="source.mp4")
                extract_plate_clip(
                    fallback_path,
                    fallback_path,
                    range_source,
                    source_range["startSeconds"],
                    source_range["durationSeconds"],
                    analysis_only=False,
                )
            if not os.path.isfile(range_source) or os.path.getsize(range_source) <= 1024:
                fail("The selected source range could not be prepared")
            words = rebase_words_to_source_range(
                words,
                source_range["startSeconds"],
                source_range["endSeconds"],
            )
            source = range_source
            stream_url = range_source
            fallback_path = range_source
            local_source = True
            duration = float(source_range["durationSeconds"])
            source_origin = dict(source_range)

        emit(
            "captions",
            "complete",
            message=f"{len(words)} caption words loaded from \"{title[:56]}\"" if words else f"No captions found for \"{title[:56]}\"; using a stable window",
            title=title,
            duration=origin_duration,
            analysis_duration=duration,
            source_range=source_range,
            word_count=len(words),
        )

        # Analysis artifacts are durable; render intermediates remain job-local.
        source_cache_identity = origin_source_fingerprint
        if source_range:
            source_cache_identity = (
                f"{origin_source_fingerprint}:"
                f"{source_range['startSeconds']:.3f}:{source_range['endSeconds']:.3f}"
            )
        source_cache = os.path.join(TMP_ROOT, ARTIFACT_CACHE_DIR, source_fingerprint(source_cache_identity))
        normalised = normalise_words(words)
        write_json(os.path.join(source_cache, "source-metadata.json"), {
            # Do not persist source URLs or absolute local media paths in a
            # long-lived cache.  The fingerprint is sufficient to resume the
            # analysis artifacts for the same input.
            "sourceKind": imported_source_kind,
            "title": title,
            "durationMs": round(origin_duration * 1000),
            "analysisDurationMs": round(duration * 1000),
            "sourceOrigin": source_origin,
            "createdAt": int(time.time() * 1000),
            "fingerprint": source_fingerprint(source_cache_identity),
            "sourceQuality": source_quality,
        })
        write_json(os.path.join(source_cache, "transcript-words.json"), [
            {
                "text": word["word"],
                "startMs": round(word["start"] * 1000),
                "endMs": round(word["end"] * 1000),
                "confidence": word.get("confidence"),
                "speakerId": word.get("speakerId"),
            }
            for word in normalised
        ])
        write_json(os.path.join(source_cache, "speech-regions.json"), speech_regions(normalised))
        sentences = sentence_boundaries(normalised)
        write_json(os.path.join(source_cache, "topic-segments.json"), topic_segments(sentences, requested_duration))

        # V2 intelligence foundation.  Each stage records what it could
        # actually observe; unavailable local providers stay explicit rather
        # than being represented as fake zero-valued visual/audio signals.
        intelligence_caps = intelligence_capability_report(FFMPEG)
        intelligence_caps["deepTemporalVerifier"] = deep_verifier_capability(video_understanding_profile)
        write_json(os.path.join(source_cache, "intelligence-capabilities.json"), intelligence_caps)
        analysis_source = source if local_source and os.path.isfile(source) else stream_url
        try:
            intelligence_limit = max(1.0, float(os.environ.get("CLIPPER_INTELLIGENCE_MAX_SECONDS", 1800) or 1800))
        except (TypeError, ValueError):
            intelligence_limit = 1800.0
        required_analysis_coverage = analysis_coverage_ms(duration, intelligence_limit)

        audio_path = os.path.join(source_cache, "audio-evidence.json")
        audio_evidence = read_json(audio_path, {})
        audio_recomputed = False
        emit("audio", "running", message="Measuring audio energy and silence...")
        if not intelligence_cache_valid(
            audio_evidence,
            INTELLIGENCE_SCHEMA_VERSION,
            minimum_coverage_ms=required_analysis_coverage,
        ) or (
            not audio_evidence.get("available") and intelligence_caps.get("audioEnergy")
        ):
            check_cancelled()
            audio_evidence = analyze_audio_evidence(
                analysis_source,
                duration,
                FFMPEG,
                max_seconds=intelligence_limit,
            )
            write_json(audio_path, audio_evidence)
            audio_recomputed = True
        emit(
            "audio",
            "complete",
            message=(
                f"Measured {len(audio_evidence.get('seconds') or [])} seconds of audio activity"
                if audio_evidence.get("available")
                else "Audio evidence unavailable for this source"
            ),
            available=bool(audio_evidence.get("available")),
            seconds=len(audio_evidence.get("seconds") or []),
            cache_hit=not audio_recomputed,
        )

        visual_path = os.path.join(source_cache, "visual-evidence.json")
        visual_evidence = read_json(visual_path, {})
        visual_recomputed = False
        visual_source = {"available": False, "reason": "opencv_unavailable"}
        emit("vision", "running", message="Sampling visual motion and scene changes...")
        if intelligence_caps.get("adaptiveVisualSampling"):
            visual_source = prepare_visual_source(
                analysis_source,
                source_cache,
                FFMPEG,
                duration,
                max_seconds=intelligence_limit,
            )
        if not intelligence_cache_valid(
            visual_evidence,
            INTELLIGENCE_SCHEMA_VERSION,
            minimum_coverage_ms=required_analysis_coverage,
        ) or (
            not visual_evidence.get("available") and visual_source.get("available")
        ):
            check_cancelled()
            if visual_source.get("available"):
                visual_evidence = adaptive_visual_evidence(
                    visual_source.get("path", ""),
                    duration,
                    max_seconds=intelligence_limit,
                )
                visual_evidence["inputKind"] = visual_source.get("kind")
                visual_evidence["inputCoverageEndMs"] = visual_source.get("coverageEndMs", 0)
            else:
                visual_evidence = {
                    "schemaVersion": INTELLIGENCE_SCHEMA_VERSION,
                    "available": False,
                    "reason": visual_source.get("reason", "vision_unavailable"),
                    "samples": [],
                    "events": [],
                    "coverageEndMs": 0,
                }
            write_json(visual_path, visual_evidence)
            visual_recomputed = True
        emit(
            "vision",
            "complete",
            message=(
                f"Adaptive visual pass found {len(visual_evidence.get('events') or [])} scene or motion events"
                if visual_evidence.get("available")
                else "Visual evidence unavailable for this source"
            ),
            available=bool(visual_evidence.get("available")),
            samples=len(visual_evidence.get("samples") or []),
            events=len(visual_evidence.get("events") or []),
            cache_hit=not visual_recomputed,
        )

        ocr_path = os.path.join(source_cache, "ocr-evidence.json")
        ocr_evidence = read_json(ocr_path, {})
        ocr_recomputed = False
        emit("ocr", "running", message="Reading informative on-screen text...")
        if not intelligence_cache_valid(ocr_evidence, INTELLIGENCE_SCHEMA_VERSION) or (
            not ocr_evidence.get("available") and intelligence_caps.get("ocr") and visual_source.get("available")
        ):
            check_cancelled()
            ocr_evidence = analyze_ocr_evidence(visual_source.get("path", ""), visual_evidence)
            write_json(ocr_path, ocr_evidence)
            ocr_recomputed = True
        emit(
            "ocr",
            "complete",
            message=(
                f"Read text from {len(ocr_evidence.get('samples') or [])} visual moments"
                if ocr_evidence.get("available")
                else "On-screen text evidence unavailable"
            ),
            available=bool(ocr_evidence.get("available")),
            samples=len(ocr_evidence.get("samples") or []),
            cache_hit=not ocr_recomputed,
        )

        timeline_path = os.path.join(source_cache, "timeline-knowledge-graph.json")
        timeline = read_json(timeline_path, {})
        timeline_recomputed = False
        emit("timeline", "running", message="Building the cross-modal timeline...")
        if (
            not isinstance(timeline, dict)
            or timeline.get("schemaVersion") != TIMELINE_SCHEMA_VERSION
            or audio_recomputed
            or visual_recomputed
            or ocr_recomputed
        ):
            check_cancelled()
            timeline = build_timeline_knowledge_graph(
                duration,
                normalised,
                audio_evidence=audio_evidence,
                visual_evidence=visual_evidence,
                ocr_evidence=ocr_evidence,
                capabilities=intelligence_caps,
            )
            write_json(timeline_path, timeline)
            timeline_recomputed = True
        intelligence_status = intelligence_summary(audio_evidence, visual_evidence, ocr_evidence, timeline)
        emit(
            "timeline",
            "complete",
            message=f"Mapped {intelligence_status['timeline']['segments']} seconds with {intelligence_status['timeline']['events']} evidence events",
            intelligence=intelligence_status,
            cache_hit=not timeline_recomputed,
        )

        shot_path = os.path.join(source_cache, "shot-boundaries.json")
        shot_boundaries = read_json(shot_path, [])
        if not isinstance(shot_boundaries, list) or not shot_boundaries:
            probe_path = source if local_source else fallback_path
            shot_boundaries = detect_shot_boundaries(probe_path)
            write_json(shot_path, shot_boundaries)

        if source_range:
            # A caller supplied an exact source range.  Preserve the intent by
            # pinning the first output candidate to its beginning instead of
            # letting autonomous ranking move it elsewhere in the source.
            clip_count = 1
            emit(
                "analyze",
                "running",
                message="Validating the user-directed source range...",
                source_range=source_origin,
            )
            candidates = [user_directed_candidate(normalised, duration, requested_duration)]
        else:
            emit("analyze", "running", message=f"Finding {clip_count} distinct {int(requested_duration)}s moments...")
            # V2 includes structural numbered-section retrieval. Do not reuse
            # an older generic ranking cache for a now-specific user request.
            candidate_cache = os.path.join(source_cache, f"clip-candidates-v3-{clean_name(selection_intent)}-{int(requested_duration)}.json")
            candidates = read_json(candidate_cache)
            if not isinstance(candidates, list) or not candidates:
                check_cancelled()
                # Specific numbered-section requests are not generic topic
                # prompts. Resolve them directly from the real source
                # transcript before the virality scorer can move the clip to
                # a different part of the video.
                candidates = query_directed_candidates(
                    words,
                    duration,
                    moment_request,
                    requested_duration,
                    clip_count,
                ) if moment_request else []
                if candidates:
                    emit(
                        "analyze",
                        "running",
                        message="Found the requested numbered section; preserving its complete spoken context.",
                        query_directed=True,
                        candidates=len(candidates),
                    )
                else:
                    pool = max(clip_count * 3, 6)
                    candidates = semantic_candidates(normalised, duration, selection_intent, requested_duration, pool)
                write_json(candidate_cache, candidates)

        # A user asking for a visible event deserves candidate coverage that
        # is not limited to the transcript's strongest sentences.  These are
        # only windows for an isolated temporal verifier to inspect; local
        # motion/OCR signals never claim that the requested event occurred.
        moment_plan = parse_moment_query(moment_request) if moment_request else None
        if moment_plan and moment_plan.get("requires", {}).get("visual") and not source_range:
            try:
                verification_limit = max(4, min(16, int(os.environ.get("CLIPPER_VISUAL_VERIFY_CANDIDATE_LIMIT", "10"))))
            except (TypeError, ValueError):
                verification_limit = 10
            visual_candidates = retrieve_visual_candidate_windows(
                timeline,
                duration,
                requested_duration,
                limit=verification_limit,
            )
            seen_windows = {(round(float(item.get("start", 0.0)), 1), round(float(item.get("end", 0.0)), 1)) for item in candidates}
            added_windows = []
            for item in visual_candidates:
                key = (round(float(item.get("start", 0.0)), 1), round(float(item.get("end", 0.0)), 1))
                if key not in seen_windows:
                    seen_windows.add(key)
                    candidates.append(item)
                    added_windows.append(item)
            if added_windows:
                emit(
                    "analyze",
                    "running",
                    message=f"Added {len(added_windows)} diverse visual windows for temporal verification.",
                    visual_candidate_windows=len(added_windows),
                )

        emit("rank", "running", message="Combining transcript, audio, and visual evidence...")
        check_cancelled()
        ranked_all = apply_clip_scores(candidates, moment_type, use_llm=True)
        ranked_all = enrich_candidates_with_timeline(ranked_all, timeline)
        if moment_request:
            # This is the agentic evidence loop's final safety gate.  Planning
            # chooses candidates, but never chooses an exact visual moment
            # without a temporal verifier's before/during/after evidence.
            moment_plan = moment_plan or parse_moment_query(moment_request)
            emit(
                "verify",
                "running",
                message=(
                    "Verifying visual state changes in the shortlisted moments..."
                    if moment_plan.get("requires", {}).get("visual")
                    else "Checking transcript and audio evidence for the requested moment..."
                ),
                moment_plan=moment_plan,
            )
            verified = []
            for item in ranked_all:
                candidate_bounds = {
                    "startMs": int(round(float(item.get("start", 0.0)) * 1000)),
                    "endMs": int(round(float(item.get("end", 0.0)) * 1000)),
                }
                verifier_descriptor = deep_verifier_capability(video_understanding_profile)
                cache_payload = {
                    "schemaVersion": "clyra.event-verification-cache.v1",
                    "query": moment_plan.get("originalQuery"),
                    "candidate": candidate_bounds,
                    "resourceProfile": video_understanding_profile,
                    "provider": verifier_descriptor.get("provider"),
                    "upstream": verifier_descriptor.get("upstream", {}).get("revision"),
                }
                verification_key = hashlib.sha256(
                    json.dumps(cache_payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
                ).hexdigest()[:24]
                verification_path = os.path.join(source_cache, "event-verifications", f"{verification_key}.json")
                cached_verification = read_json(verification_path, {})
                verification = None
                if (
                    isinstance(cached_verification, dict)
                    and cached_verification.get("schemaVersion") == cache_payload["schemaVersion"]
                    and cached_verification.get("cache") == cache_payload
                    and isinstance(cached_verification.get("verification"), dict)
                ):
                    verification = dict(cached_verification["verification"])
                    verification["cacheHit"] = True
                if verification is None:
                    verification = verify_event_candidate(
                        moment_plan,
                        item,
                        timeline,
                        source_path=analysis_source if isinstance(analysis_source, str) else None,
                        resource_profile=video_understanding_profile,
                    )
                    verification["cacheHit"] = False
                    # Never preserve a missing-provider result: enabling a
                    # worker later must immediately permit real verification.
                    if verification.get("verificationLevel") not in {"unavailable", "failed"}:
                        write_json(verification_path, {
                            "schemaVersion": cache_payload["schemaVersion"],
                            "cache": cache_payload,
                            "verification": verification,
                        })
                item["event_verification"] = verification
                if verification.get("exactMatch"):
                    verified.append(item)
            if not verified:
                if moment_plan.get("requires", {}).get("visual"):
                    fail(
                        "No visually verified moment matching the request was found. "
                        "Clyra will not create a transcript-only substitute."
                    )
                fail("No candidate satisfied the requested transcript or audio evidence.")
            ranked_all = verified
            emit("verify", "complete", message=f"Verified {len(verified)} evidence-backed moment{'s' if len(verified) != 1 else ''}.", candidates=len(verified))
        ranked = dedupe_by_overlap(ranked_all, max_overlap=0.42, limit=clip_count)
        if len(ranked) < clip_count:
            for candidate in ranked_all:
                if candidate in ranked:
                    continue
                ranked.append(candidate)
                if len(ranked) >= clip_count:
                    break
        # When a person is already selected, prefer candidates that overlap accepted face scenes.
        if face_cfg.get("selectedPersonId") and (local_source or (fallback_path and os.path.isfile(fallback_path))):
            try:
                scan_source = source if local_source and os.path.isfile(source) else fallback_path
                people_scan = scan_people(
                    FFMPEG,
                    scan_source,
                    start=0.0,
                    duration=min(float(duration), 180.0),
                    cache_root=os.path.join(source_cache, "face-cache"),
                    job_id=f"{source_fingerprint(source)}-people",
                )
                write_json(os.path.join(source_cache, "detected-people.json"), people_scan.get("people") or [])
                write_json(os.path.join(source_cache, "detected-scenes.json"), people_scan.get("scenes") or [])
                # Mark scenes accepted for the selected person using presence from people bbox samples.
                presence = []
                for person in people_scan.get("people") or []:
                    if person.get("id") != face_cfg.get("selectedPersonId"):
                        continue
                    for sample in person.get("bboxSamples") or []:
                        presence.append(float(sample.get("timeMs", 0)) / 1000.0)
                annotated = annotate_scenes(
                    people_scan.get("scenes") or [],
                    presence,
                    face_cfg.get("personMode") or face_cfg.get("sceneMode") or "strict",
                    face_cfg.get("selectedPersonId"),
                )
                write_json(os.path.join(source_cache, "accepted-face-scenes.json"), [s for s in annotated if s.get("accepted")])
                ranked = filter_candidates_by_scenes(
                    ranked,
                    annotated,
                    person_mode=face_cfg.get("personMode") or face_cfg.get("sceneMode") or "strict",
                )
            except Exception:
                pass
        for index, candidate in enumerate(ranked):
            # A manually requested complete numbered section is bounded by the
            # next section marker. Every autonomous result gets a minimum
            # 30-second scene plate (or the full source when shorter).
            if not (candidate.get("query_directed") and candidate.get("whole_section")):
                candidate = enforce_minimum_candidate_duration(candidate, duration)
                ranked[index] = candidate
            candidate["id"] = f"candidate-{index + 1}"
            candidate["start"] = round(float(candidate["start"]), 2)
            candidate["end"] = round(float(candidate["end"]), 2)
            if not isinstance(candidate.get("score"), (int, float)) or not candidate.get("reason"):
                score_payload = local_clip_score(candidate, moment_type)
                candidate["score"] = score_payload["score"]
                candidate["reason"] = score_payload["reason"]
                candidate["score_source"] = candidate.get("score_source") or "local"
            candidate["score"] = int(max(1, min(100, int(candidate.get("score", 50)))))
        multimodal_count = sum(1 for item in ranked if item.get("multimodal_evidence"))
        emit(
            "rank",
            "complete",
            message=(
                f"Ranked {len(ranked)} candidates with timeline evidence"
                if multimodal_count
                else f"Ranked {len(ranked)} candidates from transcript evidence"
            ),
            candidate_count=len(ranked),
            multimodal_candidate_count=multimodal_count,
            cache_hit=False,
        )
        write_json(os.path.join(source_cache, "ranked-clips.json"), ranked)
        initial_edit_plan = build_edit_plan(ranked, shot_boundaries, face_cfg)
        initial_edit_plan["sourceOrigin"] = source_origin
        write_json(os.path.join(source_cache, "edit-plan.json"), initial_edit_plan)
        candidates = ranked
        emit(
            "analyze",
            "complete",
            message=f"{len(candidates)} non-overlapping candidates ranked",
            candidate_count=len(candidates),
            face_tracking=face_capability_report(),
        )

        probe_source = fallback_path if fallback_path and os.path.isfile(fallback_path) else (source if local_source else stream_url)
        try:
            frame_w, frame_h = probe_video_size(FFPROBE, FFMPEG, probe_source if os.path.isfile(str(probe_source)) else (fallback_path or source))
        except Exception:
            frame_w, frame_h = 1280, 720

        results = []
        crop_plans = {}
        for candidate_index, candidate in enumerate(candidates):
            check_cancelled()
            clip_start = float(candidate["start"])
            clip_end = float(candidate["end"])
            candidate_duration_limit = 90.0 if candidate.get("query_directed") and candidate.get("whole_section") else requested_duration
            candidate = clamp_candidate_duration(
                {"start": clip_start, "end": clip_end, **{k: v for k, v in candidate.items() if k not in {"start", "end"}}},
                candidate_duration_limit,
                duration,
            )
            if not (candidate.get("query_directed") and candidate.get("whole_section")):
                candidate = enforce_minimum_candidate_duration(candidate, duration)
            clip_start = float(candidate["start"])
            clip_end = float(candidate["end"])
            clip_duration = min(candidate_duration_limit * 1.08, clip_end - clip_start)
            clip_end = clip_start + clip_duration
            absolute_clip_start = float(source_origin.get("startSeconds", 0.0)) + clip_start
            absolute_clip_end = float(source_origin.get("startSeconds", 0.0)) + clip_end
            clip_origin = {
                **source_origin,
                "actualStartSeconds": round(absolute_clip_start, 3),
                "actualEndSeconds": round(absolute_clip_end, 3),
            }
            item_name = f"{base_name}-{candidate_index + 1}"
            output_name = f"{job_id}-{candidate_index + 1}.mp4"
            clean_clip_path = os.path.join(job_tmp, f"{item_name}-clean.mp4")
            plate_path = os.path.join(job_tmp, f"{item_name}-plate.mp4")
            output_path = os.path.join(OUTPUT_DIR, output_name)
            artifact_dir = artifact_dir_for(output_name)
            sendcmd_path = os.path.join(job_tmp, f"{item_name}.sendcmd")

            emit("clip", "running", message=f"Cutting candidate {candidate_index + 1} of {len(candidates)}...")
            # Persist an uncropped plate so face-tracking changes can re-render without re-download.
            try:
                extract_plate_clip(stream_url, fallback_path, plate_path, clip_start, clip_duration)
            except Exception:
                if local_source or not yt:
                    raise
                if not fallback_path:
                    fallback_path = os.path.join(job_tmp, "source.mp4")
                    yt.streams.filter(progressive=True, file_extension="mp4").order_by("resolution").desc().first().download(job_tmp, filename="source.mp4")
                extract_plate_clip(fallback_path, fallback_path, plate_path, clip_start, clip_duration)

            track_source = plate_path if os.path.isfile(plate_path) else (fallback_path or stream_url)
            # Crop coordinates live in the scale-to-cover output space, but the
            # face normalisation must use the *actual* tracking plate geometry.
            # Passing the remote master fallback size here previously made a
            # 640×360 plate behave as if it were 1280×720 and sent the crop
            # far past the selected person.
            try:
                tracking_frame_w, tracking_frame_h = probe_video_size(FFPROBE, FFMPEG, track_source)
            except Exception:
                tracking_frame_w, tracking_frame_h = frame_w, frame_h
            emit("clip", "running", message=f"Planning subject framing for candidate {candidate_index + 1}...")
            faces_dir = os.path.join(artifact_dir, "faces")
            crop_plan = track_faces_and_build_crops(
                FFMPEG,
                track_source,
                0.0 if os.path.isfile(plate_path) else clip_start,
                clip_duration,
                OUTPUT_WIDTH,
                OUTPUT_HEIGHT,
                # Even with visible face/body tracking switched off we retain
                # the lightweight analysis pass. Its active-speaker and
                # exit-risk evidence powers the discrete smart reframe mode.
                mode=face_cfg["mode"] if face_cfg["enabled"] else "smooth",
                selected_track_id=face_cfg.get("selectedPersonId") or face_cfg.get("selectedTrackId"),
                selected_person_id=face_cfg.get("selectedPersonId") or face_cfg.get("selectedTrackId"),
                person_mode=face_cfg.get("personMode") or face_cfg.get("sceneMode", "strict"),
                scene_mode=face_cfg.get("sceneMode") or face_cfg.get("personMode", "strict"),
                allow_zoom=face_cfg.get("allowZoom", True),
                crop_focus=crop_focus,
                cache_root=os.path.join(source_cache, "face-cache"),
                frame_w=tracking_frame_w,
                frame_h=tracking_frame_h,
                shot_boundaries=[
                    {
                        "startMs": max(0, int(item.get("startMs", 0)) - int(clip_start * 1000)),
                        "endMs": max(0, int(item.get("endMs", 0)) - int(clip_start * 1000)),
                    }
                    for item in (shot_boundaries or [])
                    if isinstance(item, dict)
                ],
                scene_rules=face_cfg.get("sceneRules"),
                thumb_dir=faces_dir,
                audio_evidence=audio_evidence,
                audio_offset_ms=int(round(clip_start * 1000)),
                reframe_mode=face_cfg.get("reframeMode", "auto"),
                speaker_mode=face_cfg.get("speakerMode", "auto"),
                tracking_quality=face_cfg.get("trackingQuality", "balanced"),
                split_screen_requested=face_cfg.get("splitScreenRequested", False),
                source_fps=tracking_source_frame_rate(source_quality),
            )
            if not face_cfg["enabled"] and face_cfg.get("smartReframe", True):
                crop_plan = build_smart_reframe_keyframes(crop_plan)
                emit(
                    "clip",
                    "running",
                    message="Face/body follow is off; retaining smart speaker and exit reframe decisions.",
                    smart_reframe=True,
                )
            # A sparse or lost track must never be rendered as if it were a
            # confident camera operator.  A manual lock is a hard requirement;
            # auto mode degrades to a stable source crop so it cannot wander
            # through unrelated scenery after the subject disappears.
            # An automatic scene must not be marked trackable merely because
            # there is no user-selected face.  `annotate_scenes` deliberately
            # accepts auto scenes before a subject is chosen so the picker can
            # remain usable, but a final follow crop requires at least one
            # actual MediaPipe/Norfair detection.  Without it, rendering the
            # synthetic centre keyframes would zoom into arbitrary scenery.
            has_detected_subject = bool(crop_plan.get("availableFaces")) and any(
                bool(row.get("faces")) for row in (crop_plan.get("faceOverlay") or [])
            )
            strict_subject_required = (face_cfg.get("personMode") or face_cfg.get("sceneMode")) == "strict"
            if crop_plan.get("scenes") or crop_plan.get("acceptedScenes"):
                scenes = crop_plan.get("acceptedScenes") or [s for s in (crop_plan.get("scenes") or []) if s.get("accepted")]
                if strict_subject_required and (not scenes or not has_detected_subject):
                    if face_cfg.get("selectedPersonId"):
                        fail("The selected person was not visible long enough for strict head tracking. Choose another moment or use a locked crop.")
                    crop_plan["faceTracking"] = {
                        **(crop_plan.get("faceTracking") or {}),
                        "enabled": False,
                        "mode": "off",
                        "backend": "stable-fallback",
                        "fallbackReason": "auto_subject_visibility_insufficient",
                        "preserveSource": True,
                    }
                    crop_plan["cropKeyframes"] = []
                    candidate["face_tracking_fallback"] = "stable-wide-crop"
                    emit(
                        "clip",
                        "running",
                        message="Subject visibility was insufficient for a reliable follow crop; using a stable source crop instead.",
                        tracking_fallback="stable-wide-crop",
                    )
            crop_plans[candidate["id"]] = crop_plan
            write_json(os.path.join(artifact_dir, "shot-boundaries.json"), shot_boundaries or [])

            if face_cfg.get("enableDebugOverlay"):
                debug_path = os.path.join(artifact_dir, "tracking_debug.mp4")
                if render_tracking_debug_overlay(
                    track_source,
                    debug_path,
                    0.0 if os.path.isfile(plate_path) else clip_start,
                    clip_duration,
                    crop_plan.get("cropKeyframes") or [],
                    crop_plan.get("trackingDiagnostics") or [],
                    output_fps=output_frame_rate(source_quality),
                ):
                    crop_plan["debugOutput"] = debug_path

            # The plate is a small disposable analysis artifact only.  Final
            # pixels are rendered directly from the original stream below.
            analysis_clip_path = plate_path
            if not os.path.exists(analysis_clip_path) or os.path.getsize(analysis_clip_path) <= 1024:
                fail(f"Candidate {candidate_index + 1} did not produce a playable analysis plate")
            emit("clip", "complete", message=f"Candidate {candidate_index + 1} analysis plate ready; master source retained for final render")

            emit("transcribe", "running", message=f"Transcribing candidate {candidate_index + 1} for exact word timing...")
            transcribed_words = transcribe_clip_words(analysis_clip_path)
            timing_source = os.environ.get("CLIPPER_WHISPER_MODEL", "base.en")
            if len(transcribed_words) < 5:
                fallback_words = caption_words_relative(words, clip_start, clip_end)
                if len(fallback_words) >= 5:
                    transcribed_words = fallback_words
                    timing_source = "caption fallback"
                else:
                    # A visual/gameplay clip can be a perfectly valid result
                    # even when it contains no speech.  Do not make a clean,
                    # captions-off render fail because there are no word
                    # timings; mark the subtitle layer unavailable instead.
                    transcribed_words = []
                    timing_source = "no speech detected"
            if remove_fillers:
                filler_words = {"UM", "UH", "ERM", "AH", "LIKE"}
                transcribed_words = [word for word in transcribed_words if word["word"] not in filler_words]
            emit(
                "transcribe", "complete",
                message=(
                    f"Candidate {candidate_index + 1}: {len(transcribed_words)} timed words"
                    if transcribed_words else "No timed speech was available; Clyra captions will be skipped for this clip."
                ),
                word_count=len(transcribed_words),
                timing_source=timing_source,
            )

            # Existing source captions are preserved by default so exports
            # never present two competing subtitle layers. Editors can still
            # explicitly move Clyra captions or allow both layers.
            # Avoid duplicate subtitle layers by default: embedded source
            # captions stay visible unless the user explicitly chooses a
            # different collision policy.
            collision_mode = str(cfg.get("caption_collision_mode") or cfg.get("captionCollisionMode") or "keep-existing").lower()
            caption_collision = detect_embedded_caption_risk(analysis_clip_path, os.path.join(artifact_dir, "caption-audit"))
            candidate_captions_enabled = captions_enabled and bool(transcribed_words)
            effective_caption_position = position
            custom_caption_position = has_manual_caption_placement(cfg, caption_x, caption_y)
            if captions_enabled and caption_collision.get("detected") and collision_mode == "keep-existing":
                candidate_captions_enabled = False
                caption_collision["action"] = "kept-existing"
                emit("subtitles", "running", message="Existing captions detected; keeping the source captions at your request.", caption_collision=caption_collision)
            elif captions_enabled and caption_collision.get("detected") and collision_mode != "allow-overlap" and not custom_caption_position and position in {"bottom", "bottom-centre"}:
                effective_caption_position = "top"
                caption_collision["action"] = "relocated"
                caption_collision["placement"] = "top"
                emit("subtitles", "running", message="Existing captions detected; placing Clyra's timed captions in the top safe zone.", caption_collision=caption_collision)
            else:
                if captions_enabled and caption_collision.get("detected"):
                    caption_collision["action"] = "preserved"
                    caption_collision["placement"] = position
                emit(
                    "subtitles", "running",
                    message=(
                        f"Styling captions for candidate {candidate_index + 1}..."
                        if candidate_captions_enabled
                        else "Preparing clean output without a generated caption layer..."
                    ),
                    caption_collision=caption_collision,
                )
            subtitle_path = os.path.join(job_tmp, f"{item_name}.ass")
            subtitle_count = 0
            if candidate_captions_enabled:
                render_caption_x = None if caption_collision.get("action") == "relocated" else caption_x
                render_caption_y = None if caption_collision.get("action") == "relocated" else caption_y
                subtitle_count = write_subtitles(
                    subtitle_path,
                    transcribed_words,
                    0.0,
                    clip_duration,
                    font,
                    font_size,
                    text_color,
                    effective_caption_position,
                    subtitle_style,
                    render_caption_x,
                    render_caption_y,
                )
            emit("subtitles", "complete", message=(f"{subtitle_count} frame-safe caption beats prepared" if candidate_captions_enabled else "Using existing source captions; no duplicate Clyra caption layer added"), word_count=subtitle_count, caption_collision=caption_collision)

            emit("render", "running", message=f"Encoding candidate {candidate_index + 1} of {len(candidates)}...")
            # `source` may point to a range/proxy used for analysis. The final
            # encode always seeks the original master when it is available.
            render_source = master_source or (source if local_source and os.path.isfile(source) else stream_url)
            render_start = absolute_clip_start if master_source else clip_start
            render_fallback = master_source or fallback_path
            final_render_source = render_final_from_master(
                render_source,
                render_fallback,
                output_path,
                render_start,
                clip_duration,
                crop_focus=crop_focus,
                crop_keyframes=(
                    crop_plan.get("cropKeyframes")
                    if face_cfg["enabled"] or (crop_plan.get("faceTracking") or {}).get("smartReframe")
                    else None
                ),
                sendcmd_path=(
                    sendcmd_path
                    if face_cfg["enabled"] or (crop_plan.get("faceTracking") or {}).get("smartReframe")
                    else None
                ),
                subtitle_path=subtitle_path if candidate_captions_enabled else None,
                output_fps=output_frame_rate(source_quality),
                render_quality=render_quality,
                preserve_source=bool((crop_plan.get("faceTracking") or {}).get("preserveSource")),
                fit_source=(
                    (crop_plan.get("faceTracking") or {}).get("backend") == "stable-fallback"
                    # A low-detail landscape crop is still allowed to follow a
                    # verified subject.  The prior condition disabled the
                    # dynamic crop for *every* normal 16:9 source because its
                    # native 9:16 section is narrower than 1080px, silently
                    # rendering a static centre crop despite stored tracking
                    # keyframes. Use the static fill only when tracking is
                    # disabled or has explicitly fallen back.
                    or (
                        not bool((crop_plan.get("faceTracking") or {}).get("enabled"))
                        and not bool((crop_plan.get("faceTracking") or {}).get("smartReframe"))
                        and source_needs_full_frame_fill(source_quality)
                    )
                ),
            )
            if not os.path.exists(output_path) or os.path.getsize(output_path) <= 1024:
                fail(f"Encoder did not produce candidate {candidate_index + 1}")

            persist_clip_artifacts(
                artifact_dir,
                words=transcribed_words,
                meta={
                    "clip_id": candidate["id"],
                    "rank": candidate_index + 1,
                    "title": candidate.get("title") or f"{title[:58]} - moment {candidate_index + 1}",
                    "source_title": title,
                    "source_start": fmt_time(absolute_clip_start),
                    "source_end": fmt_time(absolute_clip_end),
                    "source_start_seconds": round(absolute_clip_start, 3),
                    "source_end_seconds": round(absolute_clip_end, 3),
                    "source_origin": clip_origin,
                    "clip_duration": clip_duration,
                    "reason": str(candidate.get("reason") or ""),
                    "score": int(candidate.get("score", 50)),
                    "hashtags": {"viral": "#viral #shorts", "funny": "#funny #shorts", "dramatic": "#story #shorts"}.get(moment_type, "#shorts"),
                    "virality_score": round(float(candidate.get("score", 50)) / 10, 1),
                    "aspect_ratio": aspect,
                    "crop_focus": crop_focus,
                    "font": font,
                    "font_size": font_size,
                    "text_colour": text_color,
                    "position": position,
                    "subtitle_style": subtitle_style,
                    "captions_enabled": candidate_captions_enabled,
                    "caption_position": effective_caption_position,
                    "caption_x": caption_x,
                    "caption_y": caption_y,
                    "caption_collision_mode": collision_mode,
                    "caption_collision": caption_collision,
                    "subtitle_layer": {
                        "coordinate_space": f"{OUTPUT_WIDTH}x{OUTPUT_HEIGHT}-final-canvas",
                        "composited_after_crop": True,
                        "moves_with_subject": False,
                    },
                    "render_quality": render_quality,
                    "final_render_source": final_render_source,
                    "source_quality": source_quality,
                    "output_name": output_name,
                    "face_tracking": crop_plan.get("faceTracking"),
                },
                plate_path=plate_path if os.path.isfile(plate_path) else None,
                subtitle_path=subtitle_path,
                crop_plan=crop_plan,
            )
            # Reload relocated thumb URLs from persisted plan.
            persisted = read_json(os.path.join(artifact_dir, "crop-plan.json"), crop_plan)
            crop_plan = persisted if isinstance(persisted, dict) else crop_plan
            crop_plans[candidate["id"]] = crop_plan

            caption_words = [word["word"] for word in transcribed_words if len(word["word"]) > 2]
            score = int(max(1, min(100, int(candidate.get("score", 50)))))
            reason = str(candidate.get("reason") or f"{score} — Strong standalone moment")[:220]
            available_faces = _faces_with_urls(os.path.basename(artifact_dir), crop_plan.get("availableFaces") or [])
            result = {
                "id": candidate["id"],
                "rank": candidate_index + 1,
                "output": f"./output/{output_name}",
                "title": candidate.get("title") or f"{title[:58]} - moment {candidate_index + 1}",
                "source_title": title,
                "source_start": fmt_time(absolute_clip_start),
                "source_end": fmt_time(absolute_clip_end),
                "source_start_seconds": round(absolute_clip_start, 3),
                "source_end_seconds": round(absolute_clip_end, 3),
                "source_origin": clip_origin,
                "clip_duration": f"{round(clip_duration)}s",
                "reason": reason,
                "caption": " ".join(caption_words[:24])[:220],
                "words": transcribed_words,
                "hashtags": {"viral": "#viral #shorts", "funny": "#funny #shorts", "dramatic": "#story #shorts"}.get(moment_type, "#shorts"),
                "virality_score": round(float(score) / 10, 1),
                "score": score,
                "clip_potential_score": score,
                "score_source": candidate.get("score_source", "local"),
                "file_size": os.path.getsize(output_path),
                "timing_source": timing_source,
                "word_count": subtitle_count,
                "output_quality": f"{OUTPUT_WIDTH}x{OUTPUT_HEIGHT} {aspect} {render_quality_label(render_quality)}",
                "final_render_source": final_render_source,
                "source_quality": source_quality,
                "caption_collision": caption_collision,
                "moment_verification": candidate.get("event_verification"),
                "captions_enabled": candidate_captions_enabled,
                "caption_position": effective_caption_position,
                "artifact_id": os.path.basename(artifact_dir),
                "face_tracking": crop_plan.get("faceTracking"),
                "available_faces": available_faces,
                "crop_keyframes": crop_plan.get("cropKeyframes") or [],
                "face_overlay": crop_plan.get("faceOverlay") or [],
                "face_scenes": crop_plan.get("scenes") or [],
                "plate_url": f"/api/clipper/artifact/{os.path.basename(artifact_dir)}/plate.mp4",
            }
            results.append(result)
            print(json.dumps({"type": "clip_result", "step": "result", "status": "complete", "message": f"Candidate {candidate_index + 1} ready", "result": result}), flush=True)

        final_edit_plan = build_edit_plan(ranked, shot_boundaries, face_cfg, crop_plans)
        final_edit_plan["sourceOrigin"] = source_origin
        write_json(os.path.join(source_cache, "edit-plan.json"), final_edit_plan)
        emit("render", "complete", message=f"{len(results)} MP4 clips rendered")
        elapsed = time.time() - started
        first = results[0]
        emit(
            "complete",
            "complete",
            message=f"Done in {round(elapsed)}s",
            results=results,
            output=first["output"],
            title=first["title"],
            original_duration=fmt_time(origin_duration),
            analysis_duration=fmt_time(duration),
            source_origin=source_origin,
            clip_duration=first["clip_duration"],
            font=font,
            font_size=font_size,
            position=position,
            reason=first["reason"],
            moment_type=moment_type,
            caption=first["caption"],
            hashtags=first["hashtags"],
            virality_score=first["virality_score"],
            total_seconds=round(elapsed),
            file_size=first["file_size"],
            timing_source=first["timing_source"],
            output_quality=first["output_quality"],
            face_tracking=face_cfg,
            video_understanding_profile=video_understanding_profile,
        )
    except PipelineCancelled:
        emit(
            "cancelled",
            "cancelled",
            message="Clip generation cancelled; completed analysis artifacts remain available for the next run",
        )
    except SystemExit:
        raise
    except Exception as exc:
        fail(f"{type(exc).__name__}: {exc}")
    finally:
        shutil.rmtree(job_tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
