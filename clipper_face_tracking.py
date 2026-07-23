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

Performance defaults: 360p–540p proxy @ ~4 fps, sequential, one clip at a time.
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
DEAD_ZONE = 0.08  # 8% of crop size
PREFERRED_FACE_Y = 0.38  # upper-middle of the vertical frame
HEADROOM_FRAC = 0.22


def capability_report() -> Dict[str, Any]:
    mediapipe_ok = False
    norfair_ok = False
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
    return {
        "mediapipeTasks": mediapipe_ok,
        "norfair": norfair_ok,
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
    selected = raw.get("selectedTrackId") or raw.get("selected_track_id") or cfg.get("selected_face_id")
    return {
        "enabled": enabled,
        "mode": mode,
        "selectedTrackId": str(selected) if selected else None,
        "allowZoom": bool(raw.get("allowZoom", raw.get("allow_zoom", True))),
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
                track.update({"bbox": det["bbox"], "confidence": det["confidence"], "missing": 0})
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
            track = {"bbox": det["bbox"], "confidence": det["confidence"], "missing": 0}
            self.tracks[track_id] = track
            matched.append((track_id, track))

        return [
            {
                "id": f"face_{track_id:02d}",
                "trackId": f"face_{track_id:02d}",
                "bbox": track["bbox"],
                "confidence": float(track.get("confidence", 0.5)),
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
            out.append(
                {
                    "id": f"face_{int(obj.id):02d}",
                    "trackId": f"face_{int(obj.id):02d}",
                    "bbox": [cx - size / 2, cy - size / 2, cx + size / 2, cy + size / 2],
                    "confidence": 0.7,
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
    subprocess.run(cmd, check=True, capture_output=True, timeout=120)
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


def _cache_key(source: str, start: float, duration: float, mode: str, selected: Optional[str], out_w: int, out_h: int) -> str:
    payload = f"{source}|{start:.3f}|{duration:.3f}|{mode}|{selected or ''}|{out_w}x{out_h}|v1"
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:24]


def track_faces_and_build_crops(
    ffmpeg: str,
    source: str,
    clip_start: float,
    clip_duration: float,
    out_w: int,
    out_h: int,
    mode: str = "smooth",
    selected_track_id: Optional[str] = None,
    allow_zoom: bool = True,
    crop_focus: str = "center",
    cache_root: Optional[str] = None,
    frame_w: Optional[int] = None,
    frame_h: Optional[int] = None,
) -> Dict[str, Any]:
    """Return face tracks + crop keyframes for one clip range.

    When mode is off, returns a single fixed crop. When MediaPipe is missing,
    Smooth/Responsive fall back to the motion-heuristic tracker documented above.
    """
    mode = normalise_mode(mode)
    caps = capability_report()
    frame_w = int(frame_w or out_w)
    frame_h = int(frame_h or out_h)

    if mode == "off":
        keyframe = _fixed_crop_keyframe(0, frame_w, frame_h, out_w, out_h, crop_focus)
        return {
            "faceTracking": {"enabled": False, "mode": "off", "selectedTrackId": None, "allowZoom": allow_zoom, "backend": "fixed"},
            "cropKeyframes": [keyframe],
            "availableFaces": [],
            "capabilities": caps,
        }

    cache_root = cache_root or os.path.join(os.environ.get("CLYRA_TMP_DIR") or "./tmp", "clipper-face-cache")
    os.makedirs(cache_root, exist_ok=True)
    key = _cache_key(source, clip_start, clip_duration, mode, selected_track_id, out_w, out_h)
    cache_path = os.path.join(cache_root, f"{key}.json")
    if os.path.isfile(cache_path):
        try:
            with open(cache_path, "r", encoding="utf-8") as handle:
                cached = json.load(handle)
            if isinstance(cached, dict) and cached.get("cropKeyframes"):
                return cached
        except Exception:
            pass

    backend = "mediapipe-tasks" if caps["mediapipeTasks"] else "motion-heuristic"
    alpha = smoothing_alpha(mode)
    work_dir = tempfile.mkdtemp(prefix="clyra-face-", dir=cache_root)
    detector = None
    norfair = _create_norfair_tracker() if caps["norfair"] else None
    iou_tracker = SimpleIoUTracker()
    available: Dict[str, Dict[str, Any]] = {}
    samples: List[Dict[str, Any]] = []
    prev_gray = None
    prev_x = prev_y = None

    try:
        if caps["mediapipeTasks"]:
            try:
                detector = _mediapipe_detector(os.path.join(cache_root, "models"))
            except Exception:
                detector = None
                backend = "motion-heuristic"

        frames = _extract_proxy_frames(ffmpeg, source, clip_start, clip_duration, work_dir)
        if not frames:
            keyframe = _fixed_crop_keyframe(0, frame_w, frame_h, out_w, out_h, crop_focus)
            return {
                "faceTracking": {"enabled": True, "mode": mode, "selectedTrackId": selected_track_id, "allowZoom": allow_zoom, "backend": "fixed"},
                "cropKeyframes": [keyframe],
                "availableFaces": [],
                "capabilities": caps,
            }

        # Probe proxy dimensions from first frame for scale mapping.
        first_rgb = _load_rgb(frames[0][1])
        proxy_h, proxy_w = first_rgb.shape[:2]
        # Map proxy detections onto original frame by assuming same aspect.
        # Caller should pass true frame_w/frame_h when known.
        del first_rgb

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

            tracked = None
            if norfair is not None:
                tracked = _try_norfair_update(norfair, detections)
            if tracked is None:
                tracked = iou_tracker.update(detections)

            for item in tracked:
                available[item["trackId"]] = {
                    "id": item["trackId"],
                    "label": item["trackId"].replace("_", " ").title(),
                    "confidence": item["confidence"],
                }

            chosen = None
            if selected_track_id:
                chosen = next((item for item in tracked if item["trackId"] == selected_track_id), None)
            if chosen is None and tracked:
                chosen = max(tracked, key=lambda item: (item["bbox"][2] - item["bbox"][0]) * (item["bbox"][3] - item["bbox"][1]) * item["confidence"])
            if chosen is None:
                x, y, scaled_w, scaled_h, prev_x, prev_y = _crop_from_face(
                    [0.35, 0.15, 0.65, 0.55], frame_w, frame_h, out_w, out_h, allow_zoom, prev_x, prev_y, alpha
                )
                confidence = 0.2
            else:
                x, y, scaled_w, scaled_h, prev_x, prev_y = _crop_from_face(
                    chosen["bbox"], frame_w, frame_h, out_w, out_h, allow_zoom, prev_x, prev_y, alpha
                )
                confidence = float(chosen["confidence"])
                selected_track_id = selected_track_id or chosen["trackId"]

            samples.append(
                {
                    "timeMs": int(round(time_s * 1000)),
                    "x": x,
                    "y": y,
                    "width": out_w,
                    "height": out_h,
                    "confidence": round(confidence, 3),
                    "scaledWidth": scaled_w,
                    "scaledHeight": scaled_h,
                    "trackId": selected_track_id,
                }
            )
            del rgb, gray

        if detector is not None:
            try:
                detector.close()
            except Exception:
                pass
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)

    if not samples:
        samples = [_fixed_crop_keyframe(0, frame_w, frame_h, out_w, out_h, crop_focus)]

    # Ensure a keyframe at t=0 and sparsify near-duplicates.
    keyframes = [samples[0]]
    for sample in samples[1:]:
        prev = keyframes[-1]
        if abs(sample["x"] - prev["x"]) < 4 and abs(sample["y"] - prev["y"]) < 4 and sample["timeMs"] - prev["timeMs"] < 600:
            continue
        keyframes.append(sample)
    if keyframes[0]["timeMs"] != 0:
        zero = dict(keyframes[0])
        zero["timeMs"] = 0
        keyframes.insert(0, zero)

    payload = {
        "faceTracking": {
            "enabled": True,
            "mode": mode,
            "selectedTrackId": selected_track_id or (next(iter(available), None)),
            "allowZoom": allow_zoom,
            "backend": backend,
        },
        "cropKeyframes": keyframes,
        "availableFaces": list(available.values()),
        "capabilities": caps,
        "proxy": {"height": PROXY_HEIGHT, "fps": PROXY_FPS, "widthHint": proxy_w if frames else None},
    }
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
