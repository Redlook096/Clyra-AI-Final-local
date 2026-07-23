#!/usr/bin/env python3
"""AI clipper pipeline with word-accurate subtitles.

Captions are used for fast moment selection only. Subtitle timing comes from
Whisper word timestamps generated from the exact clipped audio/video file, then
burned onto that same file so words line up with the final MP4.
"""

import hashlib
import html
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET


TMP_ROOT = "./tmp"
OUTPUT_DIR = "./output"
ARTIFACT_CACHE_DIR = "clipper-cache"
OUTPUT_WIDTH = 720
OUTPUT_HEIGHT = 1280
OUTPUT_FPS = 30
MAX_CLIP_LENGTH = 60.0
_FASTER_WHISPER_MODEL = None
_OPENAI_WHISPER_MODEL = None


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
    """Write an artifact atomically so a cancelled job never poisons a cache."""
    directory = os.path.dirname(path)
    os.makedirs(directory, exist_ok=True)
    staging = f"{path}.tmp"
    with open(staging, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
    os.replace(staging, path)


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
        return min(MAX_CLIP_LENGTH, max(15.0, float(value)))
    except (TypeError, ValueError):
        return min(MAX_CLIP_LENGTH, max(15.0, float(default)))


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

    target = min(target_duration, max(8.0, video_duration - 1.0))
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

    target = min(target_duration, max(8.0, video_duration - 0.5))
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
        return candidate

    start = float(candidate["start"])
    end = float(candidate["end"])
    target = max(8.0, min(float(target_duration), max(8.0, float(video_duration) - 0.2)))

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

    while len(matching) > 1 and matching[-1]["end"] - matching[0]["start"] > target * 1.15:
        matching.pop()
    while len(matching) > 1 and ends_on_connective(matching[-1]["text"]):
        matching.pop()
    # If still connective-ended (single sentence), extend one sentence when possible.
    if ends_on_connective(matching[-1]["text"]):
        next_index = next((index for index, item in enumerate(sentences) if item is matching[-1] or (
            item["start"] == matching[-1]["start"] and item["end"] == matching[-1]["end"]
        )), None)
        if next_index is not None and next_index + 1 < len(sentences):
            extension = sentences[next_index + 1]
            if extension["end"] - matching[0]["start"] <= target * 1.25:
                matching.append(extension)

    transcript = " ".join(item["text"] for item in matching).strip()
    repaired = dict(candidate)
    repaired["start"] = round(max(0.0, matching[0]["start"]), 2)
    repaired["end"] = round(min(float(video_duration), matching[-1]["end"] + 0.12), 2)
    repaired["transcript"] = transcript[:900]
    repaired["boundary_repaired"] = True
    return repaired


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


def build_edit_plan(ranked_clips, shot_boundaries=None):
    """Canonical render plan consumed by the existing FFmpeg crop/subtitle path."""
    return {
        "version": 1,
        "clips": [
            {
                "id": item["id"],
                "startMs": round(float(item["start"]) * 1000),
                "endMs": round(float(item["end"]) * 1000),
                "score": int(item.get("score", 0)),
                "reason": item.get("reason", ""),
                "title": item.get("title"),
                "cropFocus": "center",
                "captions": True,
            }
            for item in ranked_clips
        ],
        "shotBoundaries": shot_boundaries or [],
        "notes": [
            "Transcript-first selection; visual adapters are optional evidence only.",
            "MediaPipe / Light-ASD / Silero VAD remain feature-detected hooks for later passes.",
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
    target = min(target_duration, max(8.0, video_duration - 0.2))
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
    return selected


def select_progressive_stream(yt):
    streams = list(yt.streams.filter(progressive=True, file_extension="mp4"))
    if not streams:
        fail("No browser-friendly MP4 stream is available for this video")

    def height(stream):
        match = re.search(r"(\d+)", stream.resolution or "")
        return int(match.group(1)) if match else 9999

    sorted_streams = sorted(streams, key=height)
    under_720 = [stream for stream in sorted_streams if height(stream) <= 720]
    return under_720[-1] if under_720 else sorted_streams[0]


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


def subtitle_override(position):
    anchors = {
        "top": (8, 220),
        "top-centre": (8, 220),
        "center": (5, 640),
        "centre": (5, 640),
        "bottom": (2, 1050),
        "bottom-centre": (2, 1050),
    }
    alignment, y = anchors.get(position, anchors["bottom"])
    return alignment, f"{{\\an{alignment}\\pos(360,{y})\\q2\\bord6\\shad1}}"


def subtitle_beats(words, clip_start, clip_end):
    clip_length = max(0.1, clip_end - clip_start)
    clip_length_cs = int(clip_length * 100)
    clip_words = sorted(
        [word for word in words if clip_start <= word["start"] <= clip_end],
        key=lambda word: (word["start"], word["end"], word["word"]),
    )
    if not clip_words:
        clip_words = [{"word": "CLIP", "start": clip_start, "end": clip_start + 0.8}]

    beats = []
    gap_cs = 2
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


def write_subtitles(path, words, clip_start, clip_end, font, font_size, color, position):
    alignment, override = subtitle_override(position)
    beats = subtitle_beats(words, clip_start, clip_end)

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


def extract_clean_clip(input_url, local_fallback_path, clip_path, clip_start, clip_duration, crop_focus="center"):
    crop_x = {"left": "0", "right": "iw-ow"}.get(crop_focus, "(iw-ow)/2")
    video_filter = (
        f"scale={OUTPUT_WIDTH}:{OUTPUT_HEIGHT}:flags=bicubic:force_original_aspect_ratio=increase,"
        f"crop={OUTPUT_WIDTH}:{OUTPUT_HEIGHT}:{crop_x}:(ih-oh)/2,"
        f"fps={OUTPUT_FPS}"
    )
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
        "veryfast",
        "-crf",
        "22",
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


def burn_subtitles(source_clip_path, output_path, subtitle_path):
    subtitle_filter = f"ass={subtitle_path}"
    run_ffmpeg(
        [
            "-i",
            source_clip_path,
            "-vf",
            subtitle_filter,
            "-r",
            str(OUTPUT_FPS),
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "21",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "copy",
            "-movflags",
            "+faststart",
            output_path,
        ],
        timeout=90,
    )


def main():
    global OUTPUT_WIDTH, OUTPUT_HEIGHT
    if len(sys.argv) < 2:
        fail("Usage: clipper-pipeline.py <url-or-file> [config]")

    source = sys.argv[1].strip()
    cfg = json.loads(sys.argv[2]) if len(sys.argv) > 2 else {}
    font = str(cfg.get("font", "Impact"))
    font_size = min(92, max(44, int(cfg.get("font_size", 74))))
    text_color = str(cfg.get("text_colour", "#FFFFFF"))
    position = str(cfg.get("position", "bottom"))
    moment_type = str(cfg.get("moment_type", "viral"))
    requested_duration = parse_duration(cfg.get("clip_duration", MAX_CLIP_LENGTH))
    aspect = str(cfg.get("aspect_ratio", "9:16"))
    crop_focus = str(cfg.get("crop_focus", "center"))
    captions_enabled = bool(cfg.get("captions_enabled", True))
    remove_fillers = bool(cfg.get("remove_fillers", True))
    clip_count = min(8, max(1, int(cfg.get("clip_count", 3))))
    OUTPUT_WIDTH, OUTPUT_HEIGHT = {
        "1:1": (1080, 1080),
        "16:9": (1280, 720),
    }.get(aspect, (720, 1280))
    base_name = clean_name(str(cfg.get("clip_name", "clip")))
    job_id = f"{base_name}-{int(time.time() * 1000) % 1000000}"

    os.makedirs(TMP_ROOT, exist_ok=True)
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    job_tmp = os.path.join(TMP_ROOT, job_id)
    os.makedirs(job_tmp, exist_ok=True)
    started = time.time()

    try:
        emit("captions", "running", message="Reading captions and video metadata...")
        local_source = os.path.isfile(source)
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
            except Exception:
                from yt_dlp import YoutubeDL

                emit("captions", "running", message="Preparing the public video source...")
                template = os.path.join(job_tmp, "source.%(ext)s")
                with YoutubeDL({
                    "format": "bestvideo[height<=720]+bestaudio/best[height<=720]/best",
                    "merge_output_format": "mp4",
                    "outtmpl": template,
                    "quiet": True,
                    "no_warnings": True,
                }) as downloader:
                    info = downloader.extract_info(source, download=True)
                    title = str(info.get("title") or "Public video")
                    duration = float(info.get("duration") or requested_duration)
                downloaded = next(
                    (os.path.join(job_tmp, name) for name in os.listdir(job_tmp) if name.startswith("source.") and not name.endswith(".part")),
                    "",
                )
                if not downloaded or not os.path.exists(downloaded):
                    fail("The public video source could not be downloaded")
                source = downloaded
                stream_url = downloaded
                fallback_path = downloaded
                local_source = True
                words = transcribe_clip_words(downloaded)
        emit(
            "captions",
            "complete",
            message=f"{len(words)} caption words loaded from \"{title[:56]}\"" if words else f"No captions found for \"{title[:56]}\"; using a stable window",
            title=title,
            duration=duration,
            word_count=len(words),
        )

        # Analysis artifacts are durable; render intermediates remain job-local.
        source_cache = os.path.join(TMP_ROOT, ARTIFACT_CACHE_DIR, source_fingerprint(source))
        normalised = normalise_words(words)
        write_json(os.path.join(source_cache, "source-metadata.json"), {
            "source": source,
            "title": title,
            "durationMs": round(duration * 1000),
            "createdAt": int(time.time() * 1000),
            "fingerprint": source_fingerprint(source),
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

        shot_path = os.path.join(source_cache, "shot-boundaries.json")
        shot_boundaries = read_json(shot_path, [])
        if not isinstance(shot_boundaries, list) or not shot_boundaries:
            probe_path = source if local_source else fallback_path
            shot_boundaries = detect_shot_boundaries(probe_path)
            write_json(shot_path, shot_boundaries)

        emit("analyze", "running", message=f"Finding {clip_count} distinct {int(requested_duration)}s moments...")
        candidate_cache = os.path.join(source_cache, f"clip-candidates-{clean_name(moment_type)}-{int(requested_duration)}.json")
        candidates = read_json(candidate_cache)
        if not isinstance(candidates, list) or not candidates:
            pool = max(clip_count * 3, 6)
            candidates = semantic_candidates(normalised, duration, moment_type, requested_duration, pool)
            write_json(candidate_cache, candidates)

        ranked = apply_clip_scores(candidates, moment_type, use_llm=True)
        ranked = dedupe_by_overlap(ranked, max_overlap=0.42, limit=clip_count)
        if len(ranked) < clip_count:
            for candidate in sorted(candidates, key=lambda item: item.get("score", 0), reverse=True):
                if candidate in ranked:
                    continue
                ranked.append(candidate)
                if len(ranked) >= clip_count:
                    break
        for index, candidate in enumerate(ranked):
            candidate["id"] = f"candidate-{index + 1}"
            candidate["start"] = round(float(candidate["start"]), 2)
            candidate["end"] = round(float(candidate["end"]), 2)
            if candidate.get("score_source") != "llm" or not candidate.get("reason"):
                score_payload = local_clip_score(candidate, moment_type)
                candidate["score"] = score_payload["score"]
                candidate["reason"] = score_payload["reason"]
                candidate["score_source"] = candidate.get("score_source") or "local"
            candidate["score"] = int(max(1, min(100, int(candidate.get("score", 50)))))
        write_json(os.path.join(source_cache, "ranked-clips.json"), ranked)
        write_json(os.path.join(source_cache, "edit-plan.json"), build_edit_plan(ranked, shot_boundaries))
        candidates = ranked
        emit(
            "analyze",
            "complete",
            message=f"{len(candidates)} non-overlapping candidates ranked",
            candidate_count=len(candidates),
        )

        results = []
        for candidate_index, candidate in enumerate(candidates):
            clip_start = float(candidate["start"])
            clip_end = float(candidate["end"])
            clip_duration = max(6.0, clip_end - clip_start)
            item_name = f"{base_name}-{candidate_index + 1}"
            output_name = f"{job_id}-{candidate_index + 1}.mp4"
            clean_clip_path = os.path.join(job_tmp, f"{item_name}-clean.mp4")
            output_path = os.path.join(OUTPUT_DIR, output_name)

            emit("clip", "running", message=f"Cutting candidate {candidate_index + 1} of {len(candidates)}...")
            try:
                extract_clean_clip(stream_url, fallback_path, clean_clip_path, clip_start, clip_duration, crop_focus)
            except Exception:
                if local_source or not yt:
                    raise
                if not fallback_path:
                    fallback_path = os.path.join(job_tmp, "source.mp4")
                    yt.streams.filter(progressive=True, file_extension="mp4").order_by("resolution").desc().first().download(job_tmp, filename="source.mp4")
                extract_clean_clip(fallback_path, fallback_path, clean_clip_path, clip_start, clip_duration, crop_focus)

            if not os.path.exists(clean_clip_path) or os.path.getsize(clean_clip_path) <= 1024:
                fail(f"Candidate {candidate_index + 1} did not produce a playable source MP4")
            emit("clip", "complete", message=f"Candidate {candidate_index + 1} exact source extracted")

            emit("transcribe", "running", message=f"Transcribing candidate {candidate_index + 1} for exact word timing...")
            transcribed_words = transcribe_clip_words(clean_clip_path)
            if len(transcribed_words) < 5:
                fallback_words = caption_words_relative(words, clip_start, clip_end)
                if len(fallback_words) < 5:
                    fail(f"Candidate {candidate_index + 1} has insufficient speech for accurate captions")
                transcribed_words = fallback_words
                timing_source = "caption fallback"
            else:
                timing_source = os.environ.get("CLIPPER_WHISPER_MODEL", "base.en")
            if remove_fillers:
                filler_words = {"UM", "UH", "ERM", "AH", "LIKE"}
                transcribed_words = [word for word in transcribed_words if word["word"] not in filler_words]
            emit("transcribe", "complete", message=f"Candidate {candidate_index + 1}: {len(transcribed_words)} timed words", word_count=len(transcribed_words), timing_source=timing_source)

            emit("subtitles", "running", message=f"Styling captions for candidate {candidate_index + 1}..." if captions_enabled else "Preparing clean output...")
            subtitle_path = os.path.join(job_tmp, f"{item_name}.ass")
            subtitle_count = write_subtitles(subtitle_path, transcribed_words, 0.0, clip_duration, font, font_size, text_color, position)
            emit("subtitles", "complete", message=f"{subtitle_count} frame-safe caption beats prepared", word_count=subtitle_count)

            emit("render", "running", message=f"Encoding candidate {candidate_index + 1} of {len(candidates)}...")
            if captions_enabled:
                burn_subtitles(clean_clip_path, output_path, subtitle_path)
            else:
                shutil.copy2(clean_clip_path, output_path)
            if not os.path.exists(output_path) or os.path.getsize(output_path) <= 1024:
                fail(f"Encoder did not produce candidate {candidate_index + 1}")

            caption_words = [word["word"] for word in transcribed_words if len(word["word"]) > 2]
            score = int(max(1, min(100, int(candidate.get("score", 50)))))
            reason = str(candidate.get("reason") or f"{score} — Strong standalone moment")[:220]
            result = {
                "id": candidate["id"],
                "rank": candidate_index + 1,
                "output": f"./output/{output_name}",
                "title": candidate.get("title") or f"{title[:58]} - moment {candidate_index + 1}",
                "source_title": title,
                "source_start": fmt_time(clip_start),
                "source_end": fmt_time(clip_end),
                "clip_duration": f"{round(clip_duration)}s",
                "reason": reason,
                "caption": " ".join(caption_words[:24])[:220],
                "hashtags": {"viral": "#viral #shorts", "funny": "#funny #shorts", "dramatic": "#story #shorts"}.get(moment_type, "#shorts"),
                "virality_score": round(float(score) / 10, 1),
                "score": score,
                "clip_potential_score": score,
                "score_source": candidate.get("score_source", "local"),
                "file_size": os.path.getsize(output_path),
                "timing_source": timing_source,
                "word_count": subtitle_count,
                "output_quality": f"{OUTPUT_WIDTH}x{OUTPUT_HEIGHT} {aspect} 30fps AAC 256k",
            }
            results.append(result)
            print(json.dumps({"type": "clip_result", "step": "result", "status": "complete", "message": f"Candidate {candidate_index + 1} ready", "result": result}), flush=True)

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
            original_duration=fmt_time(duration),
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
        )
    except SystemExit:
        raise
    except Exception as exc:
        fail(f"{type(exc).__name__}: {exc}")
    finally:
        shutil.rmtree(job_tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
