#!/usr/bin/env python3
"""Optional lightweight face tracking for the AI Clipper.

Detection backends (feature-detected, never hard-required):
  1. MediaPipe Tasks Face Detector (preferred; not deprecated mp.solutions)
  2. Motion-heuristic box tracker when MediaPipe is missing but Smooth/Responsive
     is requested — uses low-res frame differencing + upper-body centroid
  3. Fixed centre crop when mode is Off or tracking is unavailable

Tracking IDs:
  - Norfair when installed
  - Otherwise a simple IoU multi-object tracker

People grouping:
  - Clip-local tracks are clustered into person_001… via lightweight RGB
    appearance histograms (no InsightFace / embeddings unless added later)

Selected-person lock:
  - When the selected person is briefly missing (<1s), HOLD the previous crop
  - Never jump to the largest other face while a person is selected

Scene cuts:
  - Histogram / frame-diff thresholds on the proxy stream
  - PySceneDetect optional when installed

Performance defaults: 360p–540p proxy @ ~2–5 fps, sequential, one clip at a time.
Crop centres bias toward preferredFacePosition ≈ upper-middle with a 5–10%
dead-zone, then exponential smoothing (stronger for Smooth, weaker for Responsive).
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import shutil
import subprocess
import tempfile
import urllib.request
from typing import Any, Dict, List, Optional, Sequence, Tuple

import numpy as np

FACE_MODEL_URL = (
    "https://storage.googleapis.com/mediapipe-models/face_detector/"
    "blaze_face_short_range/float16/1/blaze_face_short_range.tflite"
)
PROXY_HEIGHT = 480
PROXY_FPS = 4.0
PROXY_HEIGHT_SCAN = 360
PROXY_FPS_SCAN = 2.5
DEAD_ZONE = 0.08  # 8% of crop size
PREFERRED_FACE_Y = 0.38  # upper-middle of the vertical frame
HEADROOM_FRAC = 0.22
MISSING_HOLD_S = 1.0
HIST_BINS = 8
PERSON_MATCH_THRESHOLD = 0.42  # lower distance = closer match
SCENE_HIST_DELTA = 0.42
SCENE_FRAME_DIFF = 28.0
SCENE_MIN_GAP_S = 0.6
STRICT_PRESENCE = 0.70
FLEXIBLE_PRESENCE = 0.35
MIN_AVG_CONFIDENCE = 0.72
MIN_FACE_WIDTH = 0.03
MAX_MISSING_MS = 1500
MAX_IDENTITY_SWITCH_MS = 300


def capability_report() -> Dict[str, Any]:
    mediapipe_ok = False
    norfair_ok = False
    scenedetect_ok = False
    try:
        from mediapipe.tasks.python import vision  # noqa: F401
        from mediapipe.tasks.python.core import base_options  # noqa: F401

        mediapipe_ok = True
    except Exception:
        mediapipe_ok = False
    try:
        import norfair  # noqa: F401

        norfair_ok = True
    except Exception:
        norfair_ok = False
    try:
        from scenedetect import SceneManager  # noqa: F401

        scenedetect_ok = True
    except Exception:
        scenedetect_ok = False
    return {
        "mediapipeTasks": mediapipe_ok,
        "norfair": norfair_ok,
        "scenedetect": scenedetect_ok,
        "fallback": "motion-heuristic" if not mediapipe_ok else None,
        "note": (
            "MediaPipe Tasks Face Detector unavailable; Smooth/Responsive use a "
            "lightweight motion-heuristic tracker. Install mediapipe for true face detection."
            if not mediapipe_ok
            else "MediaPipe Tasks Face Detector ready."
        ),
    }


def normalise_mode(value: Any) -> str:
    mode = str(value or "smooth").strip().lower()
    if mode in {"off", "none", "disabled", "0", "false"}:
        return "off"
    if mode in {"responsive", "fast", "follow"}:
        return "responsive"
    return "smooth"


def normalise_scene_mode(value: Any) -> str:
    mode = str(value or "strict").strip().lower()
    if mode in {"flexible", "flex", "loose", "lenient"}:
        return "flexible"
    return "strict"


def smoothing_alpha(mode: str) -> float:
    if mode == "responsive":
        return 0.42
    return 0.18


def face_tracking_config(cfg: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    cfg = cfg or {}
    raw = cfg.get("face_tracking") if isinstance(cfg.get("face_tracking"), dict) else {}
    mode = normalise_mode(raw.get("mode", cfg.get("face_tracking_mode", "smooth")))
    enabled = mode != "off" and bool(raw.get("enabled", cfg.get("face_tracking_enabled", True) if mode != "off" else False))
    if mode == "off":
        enabled = False
    selected = (
        raw.get("selectedTrackId")
        or raw.get("selected_track_id")
        or raw.get("selectedPersonId")
        or raw.get("selected_person_id")
        or cfg.get("selected_face_id")
        or cfg.get("selected_person_id")
    )
    scene_mode = normalise_scene_mode(
        raw.get("personMode")
        or raw.get("person_mode")
        or raw.get("sceneMode")
        or raw.get("scene_mode")
        or cfg.get("person_mode")
        or cfg.get("scene_mode")
        or cfg.get("sceneMode")
        or "strict"
    )
    selected_person = (
        raw.get("selectedPersonId")
        or raw.get("selected_person_id")
        or cfg.get("selected_person_id")
        or (str(selected) if selected and str(selected).startswith("person_") else None)
    )
    rules = {
        "minVisibleRatio": float(raw.get("minVisibleRatio") or raw.get("min_visible_ratio") or 0.70),
        "minIdentityConfidence": float(raw.get("minIdentityConfidence") or raw.get("min_identity_confidence") or 0.72),
        "minFaceWidth": float(raw.get("minFaceWidth") or raw.get("min_face_width") or 0.03),
        "maxIdentitySwitchMs": float(raw.get("maxIdentitySwitchMs") or raw.get("max_identity_switch_ms") or 300),
        "maxMissingMs": float(raw.get("maxMissingMs") or raw.get("max_missing_ms") or 1500),
    }
    return {
        "enabled": enabled,
        "mode": mode,
        "selectedTrackId": str(selected) if selected else None,
        "selectedPersonId": str(selected_person) if selected_person else (str(selected) if selected else None),
        "sceneMode": scene_mode,
        "personMode": scene_mode,
        "allowZoom": bool(raw.get("allowZoom", raw.get("allow_zoom", True))),
        "sceneRules": rules,
    }


def _model_path(cache_dir: str) -> str:
    os.makedirs(cache_dir, exist_ok=True)
    path = os.path.join(cache_dir, "blaze_face_short_range.tflite")
    if os.path.isfile(path) and os.path.getsize(path) > 10_000:
        return path
    tmp = path + ".tmp"
    try:
        urllib.request.urlretrieve(FACE_MODEL_URL, tmp)
        os.replace(tmp, path)
    except Exception:
        if os.path.exists(tmp):
            os.remove(tmp)
        raise
    return path


def _iou(a: Sequence[float], b: Sequence[float]) -> float:
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    ix1, iy1 = max(ax1, bx1), max(ay1, by1)
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    iw, ih = max(0.0, ix2 - ix1), max(0.0, iy2 - iy1)
    inter = iw * ih
    if inter <= 0:
        return 0.0
    area_a = max(0.0, ax2 - ax1) * max(0.0, ay2 - ay1)
    area_b = max(0.0, bx2 - bx1) * max(0.0, by2 - by1)
    union = area_a + area_b - inter
    return inter / union if union > 0 else 0.0


class SimpleIoUTracker:
    """Fallback multi-object tracker when Norfair is not installed."""

    def __init__(self, iou_threshold: float = 0.25, max_missing: int = 8):
        self.iou_threshold = iou_threshold
        self.max_missing = max_missing
        self._next_id = 1
        self.tracks: Dict[int, Dict[str, Any]] = {}

    def update(self, detections: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        assigned = set()
        matched: List[Tuple[int, Dict[str, Any]]] = []
        for track_id, track in list(self.tracks.items()):
            best_iou, best_idx = 0.0, -1
            for index, det in enumerate(detections):
                if index in assigned:
                    continue
                score = _iou(track["bbox"], det["bbox"])
                if score > best_iou:
                    best_iou, best_idx = score, index
            if best_idx >= 0 and best_iou >= self.iou_threshold:
                det = detections[best_idx]
                assigned.add(best_idx)
                track.update(
                    {
                        "bbox": det["bbox"],
                        "confidence": det["confidence"],
                        "missing": 0,
                        "hist": det.get("hist"),
                    }
                )
                matched.append((track_id, track))
            else:
                track["missing"] = int(track.get("missing", 0)) + 1
                if track["missing"] > self.max_missing:
                    del self.tracks[track_id]
                else:
                    matched.append((track_id, track))

        for index, det in enumerate(detections):
            if index in assigned:
                continue
            track_id = self._next_id
            self._next_id += 1
            track = {
                "bbox": det["bbox"],
                "confidence": det["confidence"],
                "missing": 0,
                "hist": det.get("hist"),
            }
            self.tracks[track_id] = track
            matched.append((track_id, track))

        return [
            {
                "id": f"face_{track_id:02d}",
                "trackId": f"face_{track_id:02d}",
                "bbox": track["bbox"],
                "confidence": float(track.get("confidence", 0.5)),
                "hist": track.get("hist"),
            }
            for track_id, track in matched
            if int(track.get("missing", 0)) == 0
        ]


def _try_norfair_update(tracker, detections: List[Dict[str, Any]]) -> Optional[List[Dict[str, Any]]]:
    try:
        from norfair import Detection

        points = []
        for det in detections:
            x1, y1, x2, y2 = det["bbox"]
            cx, cy = (x1 + x2) / 2.0, (y1 + y2) / 2.0
            points.append(Detection(points=np.array([[cx, cy]]), scores=np.array([det["confidence"]])))
        tracked = tracker.update(detections=points)
        out = []
        for obj in tracked:
            if obj.estimate is None or len(obj.estimate) == 0:
                continue
            cx, cy = float(obj.estimate[0][0]), float(obj.estimate[0][1])
            # Reconstruct a stable box around the tracked centre.
            size = 0.18
            # Attach nearest detection hist if available.
            hist = None
            best = 1e9
            for det in detections:
                dx = ((det["bbox"][0] + det["bbox"][2]) / 2.0) - cx
                dy = ((det["bbox"][1] + det["bbox"][3]) / 2.0) - cy
                dist = dx * dx + dy * dy
                if dist < best:
                    best = dist
                    hist = det.get("hist")
            out.append(
                {
                    "id": f"face_{int(obj.id):02d}",
                    "trackId": f"face_{int(obj.id):02d}",
                    "bbox": [cx - size / 2, cy - size / 2, cx + size / 2, cy + size / 2],
                    "confidence": 0.7,
                    "hist": hist,
                }
            )
        return out
    except Exception:
        return None


def _create_norfair_tracker():
    try:
        from norfair import Tracker

        return Tracker(distance_function="euclidean", distance_threshold=0.15, hit_counter_max=15, initialization_delay=1)
    except Exception:
        return None


def _mediapipe_detector(cache_dir: str):
    from mediapipe.tasks.python import vision
    from mediapipe.tasks.python.core import base_options

    model = _model_path(cache_dir)
    options = vision.FaceDetectorOptions(
        base_options=base_options.BaseOptions(model_asset_path=model),
        running_mode=vision.RunningMode.IMAGE,
        min_detection_confidence=0.45,
    )
    return vision.FaceDetector.create_from_options(options)


def _detect_mediapipe(detector, rgb: np.ndarray) -> List[Dict[str, Any]]:
    from mediapipe.tasks.python.vision.core import image as image_module

    mp_image = image_module.Image(image_format=image_module.ImageFormat.SRGB, data=rgb)
    result = detector.detect(mp_image)
    height, width = rgb.shape[:2]
    detections = []
    for det in result.detections or []:
        box = det.bounding_box
        x1 = max(0.0, float(box.origin_x) / width)
        y1 = max(0.0, float(box.origin_y) / height)
        x2 = min(1.0, float(box.origin_x + box.width) / width)
        y2 = min(1.0, float(box.origin_y + box.height) / height)
        score = 0.6
        if det.categories:
            score = float(det.categories[0].score or score)
        if x2 > x1 and y2 > y1:
            detections.append({"bbox": [x1, y1, x2, y2], "confidence": score})
    return detections


def _motion_heuristic_detect(prev_gray: Optional[np.ndarray], gray: np.ndarray) -> Tuple[List[Dict[str, Any]], np.ndarray]:
    """Lightweight subject box when MediaPipe is unavailable."""
    blurred = gray.astype(np.float32)
    if prev_gray is None:
        motion = np.zeros_like(blurred)
    else:
        motion = np.abs(blurred - prev_gray.astype(np.float32))
    # Prefer the upper 70% of the frame (talking-head bias).
    h, w = gray.shape
    mask = np.zeros_like(motion)
    mask[: int(h * 0.72), :] = 1.0
    # Skin-ish / mid-tone prior on the luminance itself.
    tone = np.clip(1.0 - np.abs(blurred - 140.0) / 140.0, 0.0, 1.0)
    score = (motion * 0.65 + tone * 28.0) * mask
    threshold = max(12.0, float(np.percentile(score, 92)))
    ys, xs = np.where(score >= threshold)
    if len(xs) < 40:
        # Fall back to brightest upper-centre blob.
        region = blurred[: int(h * 0.65), int(w * 0.2) : int(w * 0.8)]
        if region.size == 0:
            return [], gray
        cy_local, cx_local = np.unravel_index(int(np.argmax(region)), region.shape)
        cx = (cx_local + int(w * 0.2)) / w
        cy = cy_local / h
        size = 0.22
        return [{"bbox": [cx - size / 2, cy - size / 2, cx + size / 2, cy + size / 2], "confidence": 0.35}], gray

    x1, x2 = float(xs.min()) / w, float(xs.max()) / w
    y1, y2 = float(ys.min()) / h, float(ys.max()) / h
    # Inflate slightly so headroom is preserved.
    pad_x = (x2 - x1) * 0.2 + 0.03
    pad_y = (y2 - y1) * 0.25 + 0.04
    box = [
        max(0.0, x1 - pad_x),
        max(0.0, y1 - pad_y),
        min(1.0, x2 + pad_x),
        min(1.0, y2 + pad_y),
    ]
    return [{"bbox": box, "confidence": 0.45}], gray


def _extract_proxy_frames(
    ffmpeg: str,
    source: str,
    start: float,
    duration: float,
    work_dir: str,
    height: int = PROXY_HEIGHT,
    fps: float = PROXY_FPS,
) -> List[Tuple[float, str]]:
    pattern = os.path.join(work_dir, "frame_%05d.jpg")
    cmd = [
        ffmpeg,
        "-hide_banner",
        "-loglevel",
        "error",
        "-ss",
        str(max(0.0, start)),
        "-t",
        str(max(0.2, duration)),
        "-i",
        source,
        "-vf",
        f"fps={fps},scale=-2:{height}",
        "-q:v",
        "5",
        pattern,
    ]
    subprocess.run(cmd, check=True, capture_output=True, timeout=180)
    frames = []
    for name in sorted(os.listdir(work_dir)):
        if not name.startswith("frame_") or not name.endswith(".jpg"):
            continue
        index = int(name.replace("frame_", "").replace(".jpg", ""))
        time_s = (index - 1) / fps
        frames.append((time_s, os.path.join(work_dir, name)))
    return frames


def _load_rgb(path: str) -> np.ndarray:
    from PIL import Image

    with Image.open(path) as image:
        return np.asarray(image.convert("RGB"))


def _face_center(bbox: Sequence[float]) -> List[float]:
    x1, y1, x2, y2 = bbox
    return [round((x1 + x2) / 2.0, 4), round((y1 + y2) / 2.0, 4)]


def _appearance_hist(rgb: np.ndarray, bbox: Sequence[float]) -> Optional[np.ndarray]:
    """Lightweight RGB histogram for person clustering (8GB-safe, no embeddings)."""
    h, w = rgb.shape[:2]
    x1 = max(0, int(bbox[0] * w))
    y1 = max(0, int(bbox[1] * h))
    x2 = min(w, max(x1 + 1, int(bbox[2] * w)))
    y2 = min(h, max(y1 + 1, int(bbox[3] * h)))
    crop = rgb[y1:y2, x1:x2]
    if crop.size < 16:
        return None
    # Downsample for speed / memory.
    from PIL import Image

    thumb = np.asarray(Image.fromarray(crop).resize((32, 32), Image.BILINEAR))
    hist_parts = []
    for channel in range(3):
        hist, _ = np.histogram(thumb[:, :, channel], bins=HIST_BINS, range=(0, 256), density=True)
        hist_parts.append(hist.astype(np.float32))
    vec = np.concatenate(hist_parts)
    norm = float(np.linalg.norm(vec))
    if norm <= 1e-8:
        return None
    return vec / norm


def _hist_distance(a: Optional[np.ndarray], b: Optional[np.ndarray]) -> float:
    if a is None or b is None:
        return 1.0
    # Cosine distance on normalised histograms.
    return float(max(0.0, 1.0 - float(np.dot(a, b))))


def _frame_hist(rgb: np.ndarray) -> np.ndarray:
    small = rgb[::4, ::4]
    hist, _ = np.histogram(small.reshape(-1), bins=24, range=(0, 256), density=True)
    vec = hist.astype(np.float32)
    norm = float(np.linalg.norm(vec)) + 1e-8
    return vec / norm


def _detect_scenes_from_frames(
    frames: Sequence[Tuple[float, str]],
    source_duration: Optional[float] = None,
) -> List[Dict[str, Any]]:
    """Histogram / frame-diff scene cuts on already-extracted proxy frames."""
    if not frames:
        return []
    cuts = [0.0]
    prev_gray = None
    prev_hist = None
    for time_s, path in frames:
        rgb = _load_rgb(path)
        gray = np.mean(rgb, axis=2).astype(np.float32)
        hist = _frame_hist(rgb)
        is_cut = False
        if prev_hist is not None:
            hist_delta = float(np.linalg.norm(hist - prev_hist))
            frame_diff = float(np.mean(np.abs(gray - prev_gray))) if prev_gray is not None else 0.0
            if hist_delta >= SCENE_HIST_DELTA or frame_diff >= SCENE_FRAME_DIFF:
                if not cuts or (time_s - cuts[-1]) >= SCENE_MIN_GAP_S:
                    is_cut = True
        if is_cut:
            cuts.append(float(time_s))
        prev_gray = gray
        prev_hist = hist
        del rgb

    end_t = float(source_duration if source_duration is not None else (frames[-1][0] + (1.0 / PROXY_FPS)))
    scenes = []
    for index, start in enumerate(cuts):
        finish = cuts[index + 1] if index + 1 < len(cuts) else end_t
        if finish <= start:
            continue
        scenes.append(
            {
                "index": len(scenes),
                "startMs": int(round(start * 1000)),
                "endMs": int(round(finish * 1000)),
                "start": round(start, 3),
                "end": round(finish, 3),
            }
        )
    if not scenes:
        scenes = [{"index": 0, "startMs": 0, "endMs": int(round(end_t * 1000)), "start": 0.0, "end": round(end_t, 3)}]
    return scenes


def _detect_scenes_pyscenedetect(source: str, start: float, duration: float) -> List[Dict[str, Any]]:
    try:
        from scenedetect import SceneManager, open_video
        from scenedetect.detectors import ContentDetector
    except Exception:
        return []
    try:
        video = open_video(source)
        manager = SceneManager()
        manager.add_detector(ContentDetector(threshold=27.0))
        manager.detect_scenes(video, show_progress=False)
        raw = manager.get_scene_list()
        scenes = []
        end_limit = start + duration
        for index, (s, e) in enumerate(raw):
            s_s = float(s.get_seconds())
            e_s = float(e.get_seconds())
            if e_s <= start or s_s >= end_limit:
                continue
            clip_start = max(start, s_s) - start
            clip_end = min(end_limit, e_s) - start
            if clip_end <= clip_start:
                continue
            scenes.append(
                {
                    "index": len(scenes),
                    "startMs": int(round(clip_start * 1000)),
                    "endMs": int(round(clip_end * 1000)),
                    "start": round(clip_start, 3),
                    "end": round(clip_end, 3),
                    "backend": "pyscenedetect",
                }
            )
        return scenes
    except Exception:
        return []


def detect_scenes(
    ffmpeg: str,
    source: str,
    start: float = 0.0,
    duration: Optional[float] = None,
    frames: Optional[Sequence[Tuple[float, str]]] = None,
) -> List[Dict[str, Any]]:
    """Scene cuts via optional PySceneDetect, else proxy histogram/frame-diff."""
    if duration is None:
        duration = 60.0
    pyscene = _detect_scenes_pyscenedetect(source, start, duration)
    if pyscene:
        return pyscene
    if frames is not None:
        return _detect_scenes_from_frames(frames, source_duration=duration)
    return []


def _cluster_people(
    track_stats: Dict[str, Dict[str, Any]],
) -> Tuple[Dict[str, str], List[Dict[str, Any]]]:
    """Cluster clip-local tracks into person_001… by appearance histograms."""
    items = []
    for track_id, stats in track_stats.items():
        hist = stats.get("hist")
        if hist is None:
            continue
        items.append((track_id, stats, hist))
    # Prefer larger / longer tracks first.
    items.sort(key=lambda row: (-float(row[1].get("areaSum", 0)), -int(row[1].get("count", 0))))

    clusters: List[Dict[str, Any]] = []
    track_to_person: Dict[str, str] = {}
    for track_id, stats, hist in items:
        best_idx, best_dist = -1, 1.0
        for index, cluster in enumerate(clusters):
            dist = _hist_distance(hist, cluster["hist"])
            if dist < best_dist:
                best_dist, best_idx = dist, index
        if best_idx >= 0 and best_dist <= PERSON_MATCH_THRESHOLD:
            cluster = clusters[best_idx]
            n = int(cluster["count"])
            cluster["hist"] = (cluster["hist"] * n + hist) / (n + 1)
            cluster["count"] = n + 1
            cluster["areaSum"] = float(cluster["areaSum"]) + float(stats.get("areaSum", 0))
            cluster["trackIds"].append(track_id)
            if float(stats.get("bestConf", 0)) >= float(cluster.get("bestConf", 0)):
                cluster["bestConf"] = float(stats.get("bestConf", 0))
                cluster["thumbnail"] = stats.get("thumbnail")
                cluster["sampleBbox"] = stats.get("sampleBbox")
                cluster["sampleTimeMs"] = stats.get("sampleTimeMs")
            track_to_person[track_id] = cluster["id"]
        else:
            person_id = f"person_{len(clusters) + 1:03d}"
            cluster = {
                "id": person_id,
                "hist": hist.copy(),
                "count": 1,
                "areaSum": float(stats.get("areaSum", 0)),
                "trackIds": [track_id],
                "bestConf": float(stats.get("bestConf", 0)),
                "thumbnail": stats.get("thumbnail"),
                "sampleBbox": stats.get("sampleBbox"),
                "sampleTimeMs": stats.get("sampleTimeMs"),
                "bboxSamples": list(stats.get("bboxSamples") or []),
            }
            clusters.append(cluster)
            track_to_person[track_id] = person_id

    # Tracks without hist still map 1:1 so UI has something.
    for track_id, stats in track_stats.items():
        if track_id in track_to_person:
            continue
        person_id = f"person_{len(clusters) + 1:03d}"
        clusters.append(
            {
                "id": person_id,
                "hist": None,
                "count": int(stats.get("count", 1)),
                "areaSum": float(stats.get("areaSum", 0)),
                "trackIds": [track_id],
                "bestConf": float(stats.get("bestConf", 0)),
                "thumbnail": stats.get("thumbnail"),
                "sampleBbox": stats.get("sampleBbox"),
                "sampleTimeMs": stats.get("sampleTimeMs"),
                "bboxSamples": list(stats.get("bboxSamples") or []),
            }
        )
        track_to_person[track_id] = person_id

    # Re-rank by screen presence and renumber person_001…
    clusters.sort(key=lambda c: (-float(c.get("areaSum", 0)), -int(c.get("count", 0))))
    remapped: Dict[str, str] = {}
    people: List[Dict[str, Any]] = []
    for index, cluster in enumerate(clusters):
        new_id = f"person_{index + 1:03d}"
        remapped[cluster["id"]] = new_id
        # Merge bbox samples from member tracks.
        samples = list(cluster.get("bboxSamples") or [])
        for tid in cluster.get("trackIds") or []:
            samples.extend(track_stats.get(tid, {}).get("bboxSamples") or [])
        # Dedupe by time.
        by_t = {}
        for sample in samples:
            by_t[int(sample.get("timeMs", 0))] = sample
        compact = [by_t[k] for k in sorted(by_t.keys())][:24]
        people.append(
            {
                "id": new_id,
                "label": f"Person {index + 1}",
                "trackIds": cluster.get("trackIds") or [],
                "confidence": round(float(cluster.get("bestConf", 0.5)), 3),
                "sampleCount": int(cluster.get("count", 0)),
                "thumbnail": cluster.get("thumbnail"),
                "sampleBbox": cluster.get("sampleBbox"),
                "sampleTimeMs": cluster.get("sampleTimeMs"),
                "bboxSamples": compact,
            }
        )
    track_to_person = {tid: remapped.get(pid, pid) for tid, pid in track_to_person.items()}
    return track_to_person, people


def _match_person_by_hist(
    hist: Optional[np.ndarray],
    people: Sequence[Dict[str, Any]],
    person_hists: Dict[str, np.ndarray],
) -> Optional[str]:
    if hist is None or not people:
        return None
    best_id, best_dist = None, 1.0
    for person in people:
        pid = person["id"]
        dist = _hist_distance(hist, person_hists.get(pid))
        if dist < best_dist:
            best_dist, best_id = dist, pid
    if best_id is not None and best_dist <= PERSON_MATCH_THRESHOLD:
        return best_id
    return None


def _presence_threshold(scene_mode: str) -> float:
    return FLEXIBLE_PRESENCE if scene_mode == "flexible" else STRICT_PRESENCE


def _bbox_obj(bbox: Sequence[float]) -> Dict[str, float]:
    x1, y1, x2, y2 = [float(v) for v in bbox]
    return {
        "x": round(x1, 4),
        "y": round(y1, 4),
        "width": round(max(0.0, x2 - x1), 4),
        "height": round(max(0.0, y2 - y1), 4),
    }


def annotate_scenes(
    scenes: Sequence[Dict[str, Any]],
    presence_times: Sequence[float],
    scene_mode: str = "strict",
    selected_person_id: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """Return all scenes with accepted / presence annotations."""
    if not selected_person_id:
        return [
            dict(
                scene,
                accepted=True,
                presence=1.0,
                selectedPersonVisible=True,
                selectedPersonCoverage=1.0,
                selectedPersonConfidence=1.0,
                rejectionReason=None,
            )
            for scene in scenes
        ]
    threshold = _presence_threshold(scene_mode)
    times = sorted(float(t) for t in presence_times)
    annotated = []
    for scene in scenes:
        start = float(scene.get("start", (scene.get("startMs") or 0) / 1000.0))
        end = float(scene.get("end", (scene.get("endMs") or 0) / 1000.0))
        duration = max(0.01, end - start)
        hits = sum(1 for t in times if start <= t < end)
        expected = max(1.0, duration * PROXY_FPS)
        presence = min(1.0, hits / expected)
        ok = presence >= threshold or (scene_mode == "flexible" and hits >= 1 and presence >= FLEXIBLE_PRESENCE)
        row = dict(scene)
        row["accepted"] = bool(ok)
        row["presence"] = round(presence, 3)
        row["selectedPersonVisible"] = presence > 0
        row["selectedPersonCoverage"] = round(presence, 3)
        row["selectedPersonConfidence"] = round(min(1.0, 0.55 + presence * 0.45), 3)
        row["selectedPersonId"] = selected_person_id
        row["rejectionReason"] = None if ok else "low_visibility"
        annotated.append(row)
    return annotated


def filter_accepted_scenes(
    scenes: Sequence[Dict[str, Any]],
    presence_times: Sequence[float],
    scene_mode: str = "strict",
    selected_person_id: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """Accept scenes where the selected person is present enough for the mode."""
    return [row for row in annotate_scenes(scenes, presence_times, scene_mode, selected_person_id) if row.get("accepted")]


def evaluate_scene(
    samples_or_scene: Any = None,
    presence_times: Optional[Sequence[float]] = None,
    scene_mode: str = "strict",
    selected_person_id: Optional[str] = None,
    rules: Optional[Dict[str, float]] = None,
    *,
    samples: Optional[Sequence[Dict[str, Any]]] = None,
    person_mode: Optional[str] = None,
    scene_rules: Optional[Dict[str, Any]] = None,
    scene_id: str = "scene_001",
    start_ms: int = 0,
    end_ms: int = 0,
) -> Dict[str, Any]:
    """Evaluate one scene (dict) or a list of identity samples."""
    mode = normalise_scene_mode(person_mode or scene_mode)
    merged_rules = {
        "minVisibleRatio": STRICT_PRESENCE,
        "minAvgConfidence": MIN_AVG_CONFIDENCE,
        "minFaceWidth": MIN_FACE_WIDTH,
        "maxMissingMs": MAX_MISSING_MS,
        **(rules or {}),
        **(scene_rules or {}),
    }
    # Path A: scene dict + presence times (pipeline-friendly).
    if isinstance(samples_or_scene, dict) and "bbox" not in samples_or_scene:
        rows = annotate_scenes(
            [samples_or_scene],
            presence_times or [],
            scene_mode=mode,
            selected_person_id=selected_person_id,
        )
        return rows[0] if rows else dict(samples_or_scene, accepted=selected_person_id is None, presence=0.0)

    sample_rows = list(samples or samples_or_scene or [])
    if not sample_rows:
        return {
            "sceneId": scene_id,
            "startMs": start_ms,
            "endMs": end_ms,
            "selectedPersonVisible": False,
            "selectedPersonConfidence": 0.0,
            "selectedPersonCoverage": 0.0,
            "otherFaceCount": 0,
            "accepted": False,
            "rejectionReason": "no_samples",
            "personMode": mode,
            "sceneMode": mode,
        }
    matched = [s for s in sample_rows if s.get("matched") or s.get("personId")]
    coverage = len(matched) / max(1, len(sample_rows))
    avg_conf = (
        float(np.mean([float(s.get("identityConfidence", s.get("confidence", 0))) for s in matched])) if matched else 0.0
    )
    widths = [float(s.get("faceWidth", 0)) for s in matched if s.get("faceWidth") is not None]
    accepted = coverage >= float(merged_rules["minVisibleRatio"]) and avg_conf >= float(merged_rules["minAvgConfidence"])
    if widths and min(widths) < float(merged_rules["minFaceWidth"]):
        accepted = False
    if mode == "flexible" and coverage >= FLEXIBLE_PRESENCE and avg_conf >= float(merged_rules["minAvgConfidence"]) * 0.9:
        accepted = True
    return {
        "sceneId": scene_id,
        "startMs": start_ms,
        "endMs": end_ms or int(sample_rows[-1].get("timeMs", 0)),
        "selectedPersonVisible": coverage > 0,
        "selectedPersonConfidence": round(avg_conf, 3),
        "selectedPersonCoverage": round(coverage, 3),
        "otherFaceCount": max((int(s.get("otherFaceCount", 0)) for s in sample_rows), default=0),
        "accepted": accepted,
        "rejectionReason": None if accepted else "low_visibility",
        "personMode": mode,
        "sceneMode": mode,
    }


def filter_candidates_by_scenes(
    candidates: Sequence[Dict[str, Any]],
    scenes: Sequence[Dict[str, Any]],
    person_mode: str = "strict",
) -> List[Dict[str, Any]]:
    """Prefer transcript candidates that overlap accepted face scenes."""
    accepted = [s for s in scenes if s.get("accepted")]
    if not accepted or not candidates:
        return list(candidates)
    mode = normalise_scene_mode(person_mode)
    kept: List[Dict[str, Any]] = []
    deferred: List[Dict[str, Any]] = []
    for candidate in candidates:
        start = float(candidate.get("start", 0))
        end = float(candidate.get("end", start))
        ok = clip_overlaps_accepted_scenes(
            start,
            end,
            accepted,
            min_overlap_s=max(0.8, (end - start) * 0.35),
        )
        if ok:
            kept.append({**candidate, "face_filtered": True})
        else:
            deferred.append({**candidate, "face_filtered": False, "face_warning": "low_selected_person_coverage"})
    if mode == "strict" and kept:
        return kept
    if kept:
        return kept + deferred
    return list(candidates)


def clip_overlaps_accepted_scenes(
    clip_start: float,
    clip_end: float,
    accepted_scenes: Sequence[Dict[str, Any]],
    min_overlap_s: float = 1.0,
) -> bool:
    if not accepted_scenes:
        return False
    for scene in accepted_scenes:
        # Scenes may be absolute or clip-relative; treat values as absolute when > clip range scale.
        s = float(scene.get("start", (scene.get("startMs") or 0) / 1000.0))
        e = float(scene.get("end", (scene.get("endMs") or 0) / 1000.0))
        overlap = max(0.0, min(clip_end, e) - max(clip_start, s))
        if overlap >= min_overlap_s:
            return True
    return False


def _write_named_caches(job_dir: str, artifacts: Dict[str, Any]) -> None:
    os.makedirs(job_dir, exist_ok=True)
    for name, payload in artifacts.items():
        path = os.path.join(job_dir, name)
        tmp = path + ".tmp"
        try:
            with open(tmp, "w", encoding="utf-8") as handle:
                json.dump(payload, handle, indent=2)
            os.replace(tmp, path)
        except Exception:
            if os.path.exists(tmp):
                os.remove(tmp)


def _job_cache_dir(cache_root: str, job_key: str) -> str:
    safe = "".join(ch if ch.isalnum() or ch in "-_" else "_" for ch in job_key)[:80] or "job"
    path = os.path.join(cache_root, safe)
    os.makedirs(path, exist_ok=True)
    return path


def _save_person_thumbnail(rgb: np.ndarray, bbox: Sequence[float], path: str) -> Optional[str]:
    try:
        from PIL import Image

        h, w = rgb.shape[:2]
        x1 = max(0, int(bbox[0] * w))
        y1 = max(0, int(bbox[1] * h))
        x2 = min(w, max(x1 + 1, int(bbox[2] * w)))
        y2 = min(h, max(y1 + 1, int(bbox[3] * h)))
        pad = int(0.15 * max(x2 - x1, y2 - y1))
        x1, y1 = max(0, x1 - pad), max(0, y1 - pad)
        x2, y2 = min(w, x2 + pad), min(h, y2 + pad)
        crop = rgb[y1:y2, x1:x2]
        if crop.size < 16:
            return None
        Image.fromarray(crop).resize((96, 96), Image.BILINEAR).save(path, quality=85)
        return path
    except Exception:
        return None


def _fixed_crop_keyframe(time_ms: int, frame_w: int, frame_h: int, out_w: int, out_h: int, crop_focus: str = "center") -> Dict[str, Any]:
    scale = max(out_w / max(1, frame_w), out_h / max(1, frame_h))
    scaled_w = int(round(frame_w * scale))
    scaled_h = int(round(frame_h * scale))
    if crop_focus == "left":
        x = 0
    elif crop_focus == "right":
        x = max(0, scaled_w - out_w)
    else:
        x = max(0, (scaled_w - out_w) // 2)
    y = max(0, (scaled_h - out_h) // 2)
    return {
        "timeMs": time_ms,
        "x": x,
        "y": y,
        "width": out_w,
        "height": out_h,
        "confidence": 1.0,
        "scaledWidth": scaled_w,
        "scaledHeight": scaled_h,
    }


def _apply_deadzone(current: float, target: float, span: float, dead_zone: float = DEAD_ZONE) -> float:
    threshold = span * dead_zone
    if abs(target - current) <= threshold:
        return current
    return target


def _smooth(prev: Optional[float], value: float, alpha: float) -> float:
    if prev is None:
        return value
    return prev * (1.0 - alpha) + value * alpha


def _crop_from_face(
    face_bbox: Sequence[float],
    frame_w: int,
    frame_h: int,
    out_w: int,
    out_h: int,
    allow_zoom: bool,
    prev_x: Optional[float],
    prev_y: Optional[float],
    alpha: float,
) -> Tuple[int, int, int, int, float, float]:
    scale = max(out_w / max(1, frame_w), out_h / max(1, frame_h))
    scaled_w = max(out_w, int(round(frame_w * scale)))
    scaled_h = max(out_h, int(round(frame_h * scale)))

    fx1, fy1, fx2, fy2 = face_bbox
    face_cx = ((fx1 + fx2) / 2.0) * scaled_w
    face_cy = ((fy1 + fy2) / 2.0) * scaled_h
    face_h = max(1.0, (fy2 - fy1) * scaled_h)

    if allow_zoom:
        # Mild zoom so the face fills a natural talking-head portion without empty edges.
        desired_face_h = out_h * 0.28
        zoom = min(1.35, max(1.0, desired_face_h / face_h))
        # Zoom is expressed by recentring; output size stays fixed (no empty pixels).
        _ = zoom

    target_x = face_cx - out_w / 2.0
    target_y = face_cy - out_h * PREFERRED_FACE_Y
    # Extra headroom: pull crop up a little when the face is large.
    target_y -= face_h * HEADROOM_FRAC * 0.15

    if prev_x is not None:
        target_x = _apply_deadzone(prev_x, target_x, out_w)
    if prev_y is not None:
        target_y = _apply_deadzone(prev_y, target_y, out_h)

    x = _smooth(prev_x, target_x, alpha)
    y = _smooth(prev_y, target_y, alpha)
    x = float(min(max(0.0, x), max(0, scaled_w - out_w)))
    y = float(min(max(0.0, y), max(0, scaled_h - out_h)))
    return int(round(x)), int(round(y)), scaled_w, scaled_h, x, y


def _cache_key(
    source: str,
    start: float,
    duration: float,
    mode: str,
    selected: Optional[str],
    out_w: int,
    out_h: int,
    scene_mode: str = "strict",
) -> str:
    payload = f"{source}|{start:.3f}|{duration:.3f}|{mode}|{selected or ''}|{out_w}x{out_h}|{scene_mode}|v2"
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:24]


def _augment_detections_with_hist(rgb: np.ndarray, detections: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    for det in detections:
        det["hist"] = _appearance_hist(rgb, det["bbox"])
    return detections


def _analyse_proxy_stream(
    ffmpeg: str,
    source: str,
    start: float,
    duration: float,
    cache_root: str,
    height: int = PROXY_HEIGHT,
    fps: float = PROXY_FPS,
    thumb_dir: Optional[str] = None,
) -> Dict[str, Any]:
    """Sequential proxy analysis. Unloads the detector before returning."""
    caps = capability_report()
    backend = "mediapipe-tasks" if caps["mediapipeTasks"] else "motion-heuristic"
    work_dir = tempfile.mkdtemp(prefix="clyra-face-", dir=cache_root)
    detector = None
    norfair = _create_norfair_tracker() if caps["norfair"] else None
    iou_tracker = SimpleIoUTracker()
    track_stats: Dict[str, Dict[str, Any]] = {}
    face_tracks: List[Dict[str, Any]] = []
    prev_gray = None
    frames: List[Tuple[float, str]] = []
    proxy_w = proxy_h = None

    try:
        if caps["mediapipeTasks"]:
            try:
                detector = _mediapipe_detector(os.path.join(cache_root, "models"))
            except Exception:
                detector = None
                backend = "motion-heuristic"

        frames = _extract_proxy_frames(ffmpeg, source, start, duration, work_dir, height=height, fps=fps)
        if frames:
            first_rgb = _load_rgb(frames[0][1])
            proxy_h, proxy_w = first_rgb.shape[:2]
            del first_rgb

        if thumb_dir:
            os.makedirs(thumb_dir, exist_ok=True)

        for time_s, path in frames:
            rgb = _load_rgb(path)
            gray = np.mean(rgb, axis=2)
            if detector is not None:
                try:
                    detections = _detect_mediapipe(detector, rgb)
                except Exception:
                    detections, prev_gray = _motion_heuristic_detect(prev_gray, gray)
                    backend = "motion-heuristic"
                else:
                    prev_gray = gray
            else:
                detections, prev_gray = _motion_heuristic_detect(prev_gray, gray)

            detections = _augment_detections_with_hist(rgb, detections)

            tracked = None
            if norfair is not None:
                tracked = _try_norfair_update(norfair, detections)
            if tracked is None:
                tracked = iou_tracker.update(detections)

            frame_rows = []
            for item in tracked:
                tid = item["trackId"]
                bbox = item["bbox"]
                area = max(0.0, (bbox[2] - bbox[0]) * (bbox[3] - bbox[1]))
                stats = track_stats.setdefault(
                    tid,
                    {
                        "count": 0,
                        "areaSum": 0.0,
                        "bestConf": 0.0,
                        "hist": None,
                        "histCount": 0,
                        "thumbnail": None,
                        "sampleBbox": None,
                        "sampleTimeMs": None,
                        "bboxSamples": [],
                    },
                )
                stats["count"] += 1
                stats["areaSum"] += area
                conf = float(item.get("confidence", 0.5))
                hist = item.get("hist")
                if hist is not None:
                    n = int(stats["histCount"])
                    if stats["hist"] is None:
                        stats["hist"] = hist.copy()
                    else:
                        stats["hist"] = (stats["hist"] * n + hist) / (n + 1)
                    stats["histCount"] = n + 1
                sample = {
                    "timeMs": int(round(time_s * 1000)),
                    "bbox": [round(float(v), 4) for v in bbox],
                    "center": _face_center(bbox),
                    "confidence": round(conf, 3),
                }
                if len(stats["bboxSamples"]) < 24:
                    stats["bboxSamples"].append(sample)
                if conf >= float(stats["bestConf"]):
                    stats["bestConf"] = conf
                    stats["sampleBbox"] = sample["bbox"]
                    stats["sampleTimeMs"] = sample["timeMs"]
                    if thumb_dir:
                        thumb_path = os.path.join(thumb_dir, f"{tid}.jpg")
                        saved = _save_person_thumbnail(rgb, bbox, thumb_path)
                        if saved:
                            stats["thumbnail"] = saved
                frame_rows.append(
                    {
                        "trackId": tid,
                        "bbox": sample["bbox"],
                        "center": sample["center"],
                        "confidence": sample["confidence"],
                        "hist": hist,
                    }
                )

            face_tracks.append({"timeMs": int(round(time_s * 1000)), "time": round(time_s, 3), "faces": [
                {k: v for k, v in row.items() if k != "hist"} for row in frame_rows
            ]})
            del rgb, gray

        if detector is not None:
            try:
                detector.close()
            except Exception:
                pass
            detector = None
    finally:
        # Keep frames on disk only until caller finishes; cleaned by caller via work_dir.
        pass

    track_to_person, people = _cluster_people(track_stats)
    # Remap thumbnails onto person ids.
    for person in people:
        if person.get("thumbnail"):
            continue
        for tid in person.get("trackIds") or []:
            thumb = track_stats.get(tid, {}).get("thumbnail")
            if thumb:
                person["thumbnail"] = thumb
                break

    person_hists = {}
    for tid, stats in track_stats.items():
        pid = track_to_person.get(tid)
        if not pid or stats.get("hist") is None:
            continue
        if pid not in person_hists:
            person_hists[pid] = stats["hist"].copy()
            person_hists[f"{pid}__n"] = 1
        else:
            n = int(person_hists[f"{pid}__n"])
            person_hists[pid] = (person_hists[pid] * n + stats["hist"]) / (n + 1)
            person_hists[f"{pid}__n"] = n + 1
    person_hists = {k: v for k, v in person_hists.items() if not k.endswith("__n")}

    # Annotate face_tracks with personId via track map + hist fallback.
    for frame in face_tracks:
        for face in frame["faces"]:
            pid = track_to_person.get(face["trackId"])
            face["personId"] = pid
            # Enrich people bbox samples with person id.
            for person in people:
                if person["id"] == pid:
                    break

    scenes = detect_scenes(ffmpeg, source, start, duration, frames=frames)
    for scene in scenes:
        scene.setdefault("backend", "histogram-diff")

    return {
        "backend": backend,
        "capabilities": caps,
        "frames": frames,
        "work_dir": work_dir,
        "proxy": {"height": height, "fps": fps, "widthHint": proxy_w, "heightHint": proxy_h},
        "track_stats": track_stats,
        "track_to_person": track_to_person,
        "people": people,
        "person_hists": person_hists,
        "face_tracks": face_tracks,
        "scenes": scenes,
    }


def scan_people(
    ffmpeg: str,
    source: str,
    start: float = 0.0,
    duration: Optional[float] = None,
    cache_root: Optional[str] = None,
    job_id: Optional[str] = None,
    max_people: int = 8,
    height: int = PROXY_HEIGHT_SCAN,
    fps: float = PROXY_FPS_SCAN,
) -> Dict[str, Any]:
    """Scan a source for recurring people; returns people list with thumbnail paths."""
    cache_root = cache_root or os.path.join(os.environ.get("CLYRA_TMP_DIR") or "./tmp", "clipper-face-cache")
    os.makedirs(cache_root, exist_ok=True)
    if duration is None:
        # Soft default: scan first 3 minutes for picker UX.
        duration = 180.0
    job_key = job_id or _cache_key(source, start, duration, "scan", None, 0, 0, "strict")
    job_dir = _job_cache_dir(cache_root, job_key)
    thumb_dir = os.path.join(job_dir, "thumbs")

    cached_people = os.path.join(job_dir, "detected-people.json")
    if os.path.isfile(cached_people):
        try:
            with open(cached_people, "r", encoding="utf-8") as handle:
                cached = json.load(handle)
            if isinstance(cached, dict) and cached.get("people"):
                return cached
        except Exception:
            pass

    analysis = _analyse_proxy_stream(
        ffmpeg,
        source,
        start,
        duration,
        cache_root,
        height=height,
        fps=fps,
        thumb_dir=thumb_dir,
    )
    people = analysis["people"][: max(1, max_people)]
    scenes = analysis["scenes"]
    payload = {
        "people": people,
        "scenes": scenes,
        "faceTracks": analysis["face_tracks"],
        "capabilities": analysis["capabilities"],
        "backend": analysis["backend"],
        "proxy": analysis["proxy"],
        "jobId": os.path.basename(job_dir),
        "cacheDir": job_dir,
    }
    _write_named_caches(
        job_dir,
        {
            "detected-scenes.json": scenes,
            "detected-people.json": payload,
            "face-tracks.json": analysis["face_tracks"],
        },
    )
    shutil.rmtree(analysis["work_dir"], ignore_errors=True)
    return payload


def track_faces_and_build_crops(
    ffmpeg: str,
    source: str,
    clip_start: float,
    clip_duration: float,
    out_w: int,
    out_h: int,
    mode: str = "smooth",
    selected_track_id: Optional[str] = None,
    selected_person_id: Optional[str] = None,
    scene_mode: str = "strict",
    person_mode: Optional[str] = None,
    allow_zoom: bool = True,
    crop_focus: str = "center",
    cache_root: Optional[str] = None,
    frame_w: Optional[int] = None,
    frame_h: Optional[int] = None,
    job_id: Optional[str] = None,
    shot_boundaries: Optional[Sequence[Dict[str, Any]]] = None,
    scene_rules: Optional[Dict[str, float]] = None,
    thumb_dir: Optional[str] = None,
) -> Dict[str, Any]:
    """Return face tracks + crop keyframes for one clip range.

    When mode is off, returns a single fixed crop. When MediaPipe is missing,
    Smooth/Responsive fall back to the motion-heuristic tracker documented above.

    Selected person lock: never jump to another face; hold previous crop while
    the person is briefly missing (<1s). Scene acceptance is recorded for the
    pipeline to filter candidates when possible.
    """
    mode = normalise_mode(mode)
    scene_mode = normalise_scene_mode(person_mode or scene_mode)
    _ = scene_rules  # thresholds exposed via face_tracking_config; presence uses scene_mode
    caps = capability_report()
    frame_w = int(frame_w or out_w)
    frame_h = int(frame_h or out_h)

    # Resolve selected person vs legacy track id.
    if selected_person_id is None and selected_track_id and str(selected_track_id).startswith("person_"):
        selected_person_id = selected_track_id

    if mode == "off":
        keyframe = _fixed_crop_keyframe(0, frame_w, frame_h, out_w, out_h, crop_focus)
        return {
            "faceTracking": {
                "enabled": False,
                "mode": "off",
                "selectedTrackId": None,
                "selectedPersonId": None,
                "sceneMode": scene_mode,
                "personMode": scene_mode,
                "allowZoom": allow_zoom,
                "backend": "fixed",
            },
            "cropKeyframes": [keyframe],
            "availableFaces": [],
            "acceptedScenes": [],
            "scenes": [],
            "capabilities": caps,
        }

    cache_root = cache_root or os.path.join(os.environ.get("CLYRA_TMP_DIR") or "./tmp", "clipper-face-cache")
    os.makedirs(cache_root, exist_ok=True)
    selected_key = selected_person_id or selected_track_id
    key = _cache_key(source, clip_start, clip_duration, mode, selected_key, out_w, out_h, scene_mode)
    job_dir = _job_cache_dir(cache_root, job_id or key)
    cache_path = os.path.join(cache_root, f"{key}.json")
    if os.path.isfile(cache_path):
        try:
            with open(cache_path, "r", encoding="utf-8") as handle:
                cached = json.load(handle)
            if isinstance(cached, dict) and cached.get("cropKeyframes"):
                return cached
        except Exception:
            pass

    alpha = smoothing_alpha(mode)
    resolved_thumb_dir = thumb_dir or os.path.join(job_dir, "thumbs")
    os.makedirs(resolved_thumb_dir, exist_ok=True)
    analysis = _analyse_proxy_stream(
        ffmpeg,
        source,
        clip_start,
        clip_duration,
        cache_root,
        height=PROXY_HEIGHT,
        fps=PROXY_FPS,
        thumb_dir=resolved_thumb_dir,
    )
    backend = analysis["backend"]
    people = analysis["people"]
    track_to_person = analysis["track_to_person"]
    person_hists = analysis["person_hists"]
    # Prefer pipeline shot boundaries when provided; else proxy-detected scenes.
    if shot_boundaries:
        scenes = []
        for index, item in enumerate(shot_boundaries):
            start_ms = int(item.get("startMs") or item.get("start_ms") or (float(item.get("start") or 0) * 1000))
            end_ms = int(item.get("endMs") or item.get("end_ms") or (float(item.get("end") or 0) * 1000))
            if end_ms <= start_ms:
                continue
            scenes.append(
                {
                    "index": index,
                    "start": start_ms / 1000.0,
                    "end": end_ms / 1000.0,
                    "startMs": start_ms,
                    "endMs": end_ms,
                }
            )
        if not scenes:
            scenes = analysis["scenes"]
    else:
        scenes = analysis["scenes"]
    frames = analysis["frames"]
    face_tracks = analysis["face_tracks"]

    # Auto-select most prominent person when nothing chosen.
    if selected_person_id is None and selected_track_id:
        selected_person_id = track_to_person.get(selected_track_id)
    if selected_person_id is None and people:
        selected_person_id = people[0]["id"]
    if selected_track_id is None and selected_person_id:
        # Prefer a member track of that person for legacy UI fields.
        for person in people:
            if person["id"] == selected_person_id and person.get("trackIds"):
                selected_track_id = person["trackIds"][0]
                break

    presence_times: List[float] = []
    samples: List[Dict[str, Any]] = []
    prev_x = prev_y = None
    last_face_bbox: Optional[List[float]] = None
    last_seen_t: Optional[float] = None
    holding = False

    # Build a quick lookup of faces by frame time.
    faces_by_time: Dict[int, List[Dict[str, Any]]] = {}
    for row in face_tracks:
        faces_by_time[int(row["timeMs"])] = row["faces"]

    try:
        if not frames:
            keyframe = _fixed_crop_keyframe(0, frame_w, frame_h, out_w, out_h, crop_focus)
            payload = {
                "faceTracking": {
                    "enabled": True,
                    "mode": mode,
                    "selectedTrackId": selected_track_id,
                    "selectedPersonId": selected_person_id,
                    "sceneMode": scene_mode,
                    "allowZoom": allow_zoom,
                    "backend": "fixed",
                },
                "cropKeyframes": [keyframe],
                "availableFaces": people,
                "acceptedScenes": [],
                "scenes": scenes,
                "capabilities": caps,
            }
            return payload

        for time_s, _path in frames:
            t_ms = int(round(time_s * 1000))
            tracked = faces_by_time.get(t_ms) or []
            # Attach hist-based person id when track map missed.
            for item in tracked:
                if not item.get("personId"):
                    # face_tracks already stripped hist; use track map only.
                    item["personId"] = track_to_person.get(item["trackId"])

            chosen = None
            if selected_person_id:
                chosen = next((item for item in tracked if item.get("personId") == selected_person_id), None)
                # Secondary: selected legacy track belonging to that person.
                if chosen is None and selected_track_id:
                    chosen = next((item for item in tracked if item.get("trackId") == selected_track_id), None)
            elif selected_track_id:
                chosen = next((item for item in tracked if item.get("trackId") == selected_track_id), None)

            if chosen is not None:
                last_face_bbox = list(chosen["bbox"])
                last_seen_t = time_s
                holding = False
                presence_times.append(time_s)
                x, y, scaled_w, scaled_h, prev_x, prev_y = _crop_from_face(
                    chosen["bbox"], frame_w, frame_h, out_w, out_h, allow_zoom, prev_x, prev_y, alpha
                )
                confidence = float(chosen.get("confidence", 0.6))
                face_box = _bbox_obj(chosen["bbox"])
                face_center = {"x": _face_center(chosen["bbox"])[0], "y": _face_center(chosen["bbox"])[1]}
                track_id = chosen.get("trackId") or selected_track_id
                person_id = chosen.get("personId") or selected_person_id
            else:
                # Selected-person lock: never jump to largest other face.
                briefly_missing = (
                    selected_person_id is not None
                    and last_seen_t is not None
                    and (time_s - last_seen_t) < MISSING_HOLD_S
                    and last_face_bbox is not None
                    and prev_x is not None
                )
                long_hold = (
                    selected_person_id is not None
                    and last_face_bbox is not None
                    and prev_x is not None
                )
                if briefly_missing or long_hold:
                    holding = True
                    # HOLD previous crop coordinates exactly — no chase to other faces.
                    x = int(round(prev_x))
                    y = int(round(prev_y))
                    scale = max(out_w / max(1, frame_w), out_h / max(1, frame_h))
                    scaled_w = max(out_w, int(round(frame_w * scale)))
                    scaled_h = max(out_h, int(round(frame_h * scale)))
                    confidence = 0.35 if briefly_missing else 0.2
                    face_box = _bbox_obj(last_face_bbox)
                    face_center = {"x": _face_center(last_face_bbox)[0], "y": _face_center(last_face_bbox)[1]}
                    track_id = selected_track_id
                    person_id = selected_person_id
                elif tracked and selected_person_id is None:
                    chosen = max(
                        tracked,
                        key=lambda item: (item["bbox"][2] - item["bbox"][0])
                        * (item["bbox"][3] - item["bbox"][1])
                        * float(item.get("confidence", 0.5)),
                    )
                    last_face_bbox = list(chosen["bbox"])
                    last_seen_t = time_s
                    x, y, scaled_w, scaled_h, prev_x, prev_y = _crop_from_face(
                        chosen["bbox"], frame_w, frame_h, out_w, out_h, allow_zoom, prev_x, prev_y, alpha
                    )
                    confidence = float(chosen.get("confidence", 0.5))
                    face_box = _bbox_obj(chosen["bbox"])
                    face_center = {"x": _face_center(chosen["bbox"])[0], "y": _face_center(chosen["bbox"])[1]}
                    track_id = chosen.get("trackId")
                    person_id = chosen.get("personId")
                    selected_track_id = selected_track_id or track_id
                else:
                    x, y, scaled_w, scaled_h, prev_x, prev_y = _crop_from_face(
                        last_face_bbox or [0.35, 0.15, 0.65, 0.55],
                        frame_w,
                        frame_h,
                        out_w,
                        out_h,
                        allow_zoom,
                        prev_x,
                        prev_y,
                        alpha,
                    )
                    confidence = 0.15
                    fallback_box = last_face_bbox or [0.35, 0.15, 0.65, 0.55]
                    face_box = _bbox_obj(fallback_box)
                    face_center = {"x": _face_center(fallback_box)[0], "y": _face_center(fallback_box)[1]}
                    track_id = selected_track_id
                    person_id = selected_person_id

            samples.append(
                {
                    "timeMs": t_ms,
                    "x": x,
                    "y": y,
                    "width": out_w,
                    "height": out_h,
                    "confidence": round(confidence, 3),
                    "scaledWidth": scaled_w,
                    "scaledHeight": scaled_h,
                    "trackId": track_id,
                    "personId": person_id,
                    "faceBox": face_box,
                    "faceCenter": face_center,
                    "holding": holding,
                }
            )
    finally:
        shutil.rmtree(analysis["work_dir"], ignore_errors=True)

    if not samples:
        samples = [_fixed_crop_keyframe(0, frame_w, frame_h, out_w, out_h, crop_focus)]

    # Ensure a keyframe at t=0 and sparsify near-duplicates.
    keyframes = [samples[0]]
    for sample in samples[1:]:
        prev = keyframes[-1]
        if (
            abs(sample["x"] - prev["x"]) < 4
            and abs(sample["y"] - prev["y"]) < 4
            and sample["timeMs"] - prev["timeMs"] < 600
            and sample.get("holding") == prev.get("holding")
        ):
            continue
        keyframes.append(sample)
    if keyframes[0]["timeMs"] != 0:
        zero = dict(keyframes[0])
        zero["timeMs"] = 0
        keyframes.insert(0, zero)

    annotated_scenes = annotate_scenes(scenes, presence_times, scene_mode, selected_person_id)
    accepted = [row for row in annotated_scenes if row.get("accepted")]
    # For UI: available faces are people (with bbox samples + thumbnails).
    available = []
    for person in people:
        sample_bbox = person.get("sampleBbox")
        bbox_obj = _bbox_obj(sample_bbox) if isinstance(sample_bbox, (list, tuple)) and len(sample_bbox) >= 4 else None
        thumb = person.get("thumbnail") or person.get("thumbnailPath") or ""
        available.append(
            {
                "id": person["id"],
                "personId": person["id"],
                "label": person.get("label") or person["id"].replace("_", " ").title(),
                "confidence": person.get("confidence", 0.5),
                "thumbnail": thumb,
                "thumbnailPath": thumb,
                "trackIds": person.get("trackIds") or [],
                "bboxSamples": person.get("bboxSamples") or [],
                "sampleBbox": sample_bbox,
                "bbox": bbox_obj,
                "sampleTimeMs": person.get("sampleTimeMs"),
            }
        )

    selected_person_payload = {
        "personId": selected_person_id,
        "id": selected_person_id,
        "trackId": selected_track_id,
        "sceneMode": scene_mode,
        "personMode": scene_mode,
        "referenceFrames": [],
        "faceEmbeddings": [],
        "averageEmbedding": [],
        "thumbnailPath": next((p.get("thumbnailPath") or "" for p in available if p["id"] == selected_person_id), ""),
        "presenceSeconds": round(len(presence_times) / max(PROXY_FPS, 0.1), 2),
        "acceptedSceneCount": len(accepted),
        "sceneCount": len(annotated_scenes),
    }

    # Time-keyed overlay samples for the studio face squares.
    face_overlay = []
    for row in face_tracks:
        faces = []
        for face in row.get("faces") or []:
            bbox = face.get("bbox") or []
            if len(bbox) < 4:
                continue
            faces.append(
                {
                    "id": face.get("personId") or face.get("trackId"),
                    "personId": face.get("personId"),
                    "trackId": face.get("trackId"),
                    "bbox": _bbox_obj(bbox),
                    "confidence": face.get("confidence", 0.5),
                }
            )
        face_overlay.append({"timeMs": int(row.get("timeMs") or 0), "faces": faces})

    payload = {
        "faceTracking": {
            "enabled": True,
            "mode": mode,
            "selectedTrackId": selected_person_id or selected_track_id,
            "selectedPersonId": selected_person_id,
            "sceneMode": scene_mode,
            "personMode": scene_mode,
            "allowZoom": allow_zoom,
            "backend": backend,
        },
        "cropKeyframes": keyframes,
        "availableFaces": available,
        "people": available,
        "selectedPerson": selected_person_payload,
        "scenes": [
            {
                **scene,
                "sceneId": f"scene_{int(scene.get('index', i)) + 1:03d}",
            }
            for i, scene in enumerate(annotated_scenes)
        ],
        "acceptedScenes": accepted,
        "faceTracks": face_tracks,
        "faceOverlay": face_overlay,
        "capabilities": caps,
        "proxy": analysis["proxy"],
    }

    _write_named_caches(
        job_dir,
        {
            "detected-scenes.json": annotated_scenes,
            "detected-people.json": {"people": available, "backend": backend},
            "selected-person.json": selected_person_payload,
            "face-tracks.json": face_tracks,
            "accepted-face-scenes.json": accepted,
            "crop-keyframes.json": keyframes,
        },
    )
    payload["cacheDir"] = job_dir

    tmp = cache_path + ".tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as handle:
            json.dump(payload, handle)
        os.replace(tmp, cache_path)
    except Exception:
        if os.path.exists(tmp):
            os.remove(tmp)
    return payload


def write_sendcmd(path: str, keyframes: Sequence[Dict[str, Any]]) -> str:
    """Write an FFmpeg sendcmd script that updates crop x/y over time."""
    lines = []
    for kf in keyframes:
        t = max(0.0, float(kf.get("timeMs", 0)) / 1000.0)
        x = int(kf.get("x", 0))
        y = int(kf.get("y", 0))
        lines.append(f"{t:.3f} crop x {x};")
        lines.append(f"{t:.3f} crop y {y};")
    with open(path, "w", encoding="utf-8") as handle:
        handle.write("\n".join(lines) + "\n")
    return path


def _escape_filter_path(path: str) -> str:
    # FFmpeg filtergraph path escaping for sendcmd=f=...
    return path.replace("\\", "/").replace(":", "\\:").replace("'", "\\'")


def build_crop_filter(
    out_w: int,
    out_h: int,
    keyframes: Optional[Sequence[Dict[str, Any]]] = None,
    crop_focus: str = "center",
    sendcmd_path: Optional[str] = None,
) -> str:
    """Scale-to-cover then crop. Uses sendcmd when animated keyframes exist."""
    if keyframes and len(keyframes) >= 1 and sendcmd_path:
        write_sendcmd(sendcmd_path, keyframes)
        first = keyframes[0]
        x0 = int(first.get("x", 0))
        y0 = int(first.get("y", 0))
        escaped = _escape_filter_path(os.path.abspath(sendcmd_path))
        return (
            f"scale={out_w}:{out_h}:flags=bicubic:force_original_aspect_ratio=increase,"
            f"sendcmd=f='{escaped}',"
            f"crop={out_w}:{out_h}:{x0}:{y0}"
        )
    crop_x = {"left": "0", "right": "iw-ow"}.get(crop_focus, "(iw-ow)/2")
    return (
        f"scale={out_w}:{out_h}:flags=bicubic:force_original_aspect_ratio=increase,"
        f"crop={out_w}:{out_h}:{crop_x}:(ih-oh)/2"
    )


def probe_video_size(ffprobe: Optional[str], ffmpeg: str, path: str) -> Tuple[int, int]:
    if ffprobe:
        try:
            result = subprocess.run(
                [
                    ffprobe,
                    "-v",
                    "error",
                    "-select_streams",
                    "v:0",
                    "-show_entries",
                    "stream=width,height",
                    "-of",
                    "csv=p=0:s=x",
                    path,
                ],
                check=True,
                capture_output=True,
                text=True,
                timeout=20,
            )
            text = (result.stdout or "").strip()
            if "x" in text:
                w, h = text.split("x", 1)
                return int(w), int(h)
        except Exception:
            pass
    try:
        result = subprocess.run(
            [ffmpeg, "-hide_banner", "-i", path],
            check=False,
            capture_output=True,
            text=True,
            timeout=20,
        )
        import re

        match = re.search(r"(\d{2,5})x(\d{2,5})", result.stderr or "")
        if match:
            return int(match.group(1)), int(match.group(2))
    except Exception:
        pass
    return 1280, 720
