#!/usr/bin/env python3
"""Optional lightweight face tracking for the AI Clipper.

Detection backends (feature-detected, never hard-required):
  1. MediaPipe Tasks Face Landmarker in timestamped VIDEO mode (preferred)
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

Performance defaults: a 480p proxy streamed at the selected clip's native frame
rate (up to 60 fps), with expensive landmark refreshes performed adaptively and
Lucas–Kanade optical flow filling the intervening frames.  This is deliberately
not a live-camera tracker: clips are prerecorded, so Clyra measures a complete
scene trajectory and then creates one timestamp-indexed, non-causal crop path.
That removes the historical lag caused by sparse detections and causal averages.
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

# Face Landmarker supports timestamped prerecorded-video analysis.  The model
# is acquired into Clyra's local worker cache, never bundled into the renderer.
FACE_LANDMARKER_MODEL_URL = (
    "https://storage.googleapis.com/mediapipe-models/face_landmarker/"
    "face_landmarker/float16/1/face_landmarker.task"
)
POSE_LANDMARKER_MODEL_URL = (
    "https://storage.googleapis.com/mediapipe-models/pose_landmarker/"
    "pose_landmarker_lite/float16/latest/pose_landmarker_lite.task"
)
PROXY_HEIGHT = 480
# The proxy stays intentionally lower resolution than the delivery master.
# Its temporal cadence is the source cadence (capped at 60 fps); this lets the
# virtual camera produce a crop coordinate for each 30/60 fps delivery frame.
PROXY_FPS = 30.0
PROXY_HEIGHT_SCAN = 288
PROXY_FPS_SCAN = 1.5
DEAD_ZONE = 0.08  # 8% of crop size
PREFERRED_FACE_Y = 0.38  # upper-middle of the vertical frame
HEADROOM_FRAC = 0.22
# After a short occlusion we predict the last trajectory; after this boundary
# the crop freezes instead of drifting through unrelated scenery.
MISSING_HOLD_S = 0.40
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
# V10 deliberately invalidates the older cache.  That path used one-way LK
# flow and could slowly inherit background/camera movement between landmark
# refreshes.  The current path validates flow in both directions and records a
# crop state for every decoded output frame.
TRAJECTORY_VERSION = "offline-cinematic-v10-face-body-fbflow-per-frame"
PREDICTIVE_LEAD_S = {"smooth": 0.060, "responsive": 0.100}
COMFORT_ZONE_X = 0.10
COMFORT_ZONE_Y = 0.075
COMFORT_STOP_RATIO = 0.80
MAX_OCCLUSION_S = 0.40
ACTIVE_SPEAKER_SWITCH_HOLD_MS = 650
ACTIVE_SPEAKER_SWITCH_MARGIN = 0.12
TRACKING_FPS_BY_QUALITY = {
    # Every selected clip gets a per-output-frame crop path.  The profiles
    # govern landmark refresh / spatial detail rather than dropping temporal
    # samples and making a moving subject step between stale boxes.
    "low_memory": 30.0,
    "balanced": 60.0,
    "high_quality": 60.0,
    "gpu": 60.0,
}
MAX_DYNAMIC_ZOOM = 1.35
ZOOM_CHANGE_THRESHOLD = 0.06
FLOW_MIN_VALID_RATIO = 0.60
FLOW_MAX_FB_ERROR_PX = 1.75


def capability_report() -> Dict[str, Any]:
    mediapipe_ok = False
    norfair_ok = False
    scenedetect_ok = False
    opencv_ok = False
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
    try:
        import cv2  # noqa: F401

        opencv_ok = True
    except Exception:
        opencv_ok = False
    return {
        "mediapipeTasks": mediapipe_ok,
        "poseLandmarker": mediapipe_ok,
        "bodyLandmarks": mediapipe_ok,
        "opencvOpticalFlow": opencv_ok,
        # ByteTrack is intentionally an optional deployment adapter.  Its
        # detector/re-identification weights are not bundled until their model
        # licence has passed Clyra's release gate; Clyra's local association
        # fallback keeps stable IDs without claiming that ByteTrack is active.
        "byteTrack": False,
        "norfair": norfair_ok,
        "scenedetect": scenedetect_ok,
        "fallback": "motion-heuristic" if not mediapipe_ok else None,
        "note": (
            "MediaPipe Tasks Face Landmarker unavailable; Smooth/Responsive use a "
            "lightweight motion-heuristic tracker. Install mediapipe for true face detection."
            if not mediapipe_ok
            else "MediaPipe Face/Pose video-mode adapters with optical-flow propagation ready."
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


def normalise_reframe_mode(value: Any) -> str:
    mode = str(value or "auto").strip().lower().replace("-", "_")
    aliases = {
        "follow": "single_speaker",
        "single": "single_speaker",
        "speaker": "single_speaker",
        "multi": "multi_speaker",
        "keepall": "keep_all",
        "center": "centre",
        "locked": "locked_subject",
        "static": "locked_subject",
        "lock": "locked_subject",
        "off": "disabled",
        "none": "disabled",
    }
    mode = aliases.get(mode, mode)
    return mode if mode in {"auto", "single_speaker", "multi_speaker", "keep_all", "locked_subject", "centre", "disabled"} else "auto"


def normalise_tracking_quality(value: Any) -> str:
    quality = str(value or "balanced").strip().lower().replace("-", "_")
    aliases = {
        "low": "low_memory",
        "low_power": "low_memory",
        "fast": "low_memory",
        "high": "high_quality",
        "quality": "high_quality",
    }
    quality = aliases.get(quality, quality)
    return quality if quality in TRACKING_FPS_BY_QUALITY else "balanced"


def analysis_fps_for_quality(value: Any, source_fps: Optional[float] = None) -> float:
    """Return the source-safe per-frame crop cadence.

    A 30 fps master has no meaningful 16 ms input observations, while a 60 fps
    master can use one every 16.7 ms.  Never invent source frames by requesting
    a higher proxy cadence than the master contains.
    """
    target = float(TRACKING_FPS_BY_QUALITY[normalise_tracking_quality(value)])
    try:
        native = float(source_fps or 0.0)
    except (TypeError, ValueError):
        native = 0.0
    if native >= 1.0:
        return max(1.0, min(target, native, 60.0))
    return target


def smoothing_alpha(mode: str) -> float:
    if mode == "responsive":
        return 0.42
    return 0.18


def _config_bool(value: Any, default: bool = False) -> bool:
    """Parse request booleans without treating the string ``"false"`` as true."""
    if value is None:
        return default
    if isinstance(value, str):
        return value.strip().lower() not in {"", "0", "false", "off", "disabled", "none", "no"}
    return bool(value)


def face_tracking_config(cfg: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    cfg = cfg or {}
    raw = cfg.get("face_tracking") if isinstance(cfg.get("face_tracking"), dict) else {}
    mode = normalise_mode(raw.get("mode", cfg.get("face_tracking_mode", cfg.get("faceTrackingMode", "smooth"))))
    # Respect the editor/request configuration.  Earlier releases replaced the
    # requested mode with ``off`` here, which made the UI appear to offer face
    # tracking while every worker always rendered a centre crop.  A requested
    # path can still downgrade *per scene* when confidence is insufficient;
    # that safety fallback must be visible in the emitted crop plan rather
    # than silently disabling the complete feature at configuration time.
    explicit_enabled = raw.get("enabled", cfg.get("face_tracking_enabled", cfg.get("faceTrackingEnabled")))
    explicit_disabled = explicit_enabled is False or (
        explicit_enabled is not None
        and str(explicit_enabled).strip().lower() in {"0", "false", "off", "disabled", "none"}
    )
    auto_reframe = cfg.get("autoReframe", cfg.get("auto_reframe"))
    if isinstance(auto_reframe, dict):
        auto_reframe_enabled = auto_reframe.get("enabled", True)
    else:
        auto_reframe_enabled = True if auto_reframe is None else auto_reframe
    reframe_mode = normalise_reframe_mode(
        raw.get("reframeMode")
        or raw.get("reframe_mode")
        or cfg.get("reframeMode")
        or cfg.get("reframe_mode")
        or (auto_reframe.get("mode") if isinstance(auto_reframe, dict) else None)
        or "auto"
    )
    tracking_quality = normalise_tracking_quality(
        raw.get("trackingQuality")
        or raw.get("tracking_quality")
        or cfg.get("trackingQuality")
        or cfg.get("tracking_quality")
        or "balanced"
    )
    speaker_mode = str(
        raw.get("speakerMode")
        or raw.get("speaker_mode")
        or cfg.get("speakerMode")
        or cfg.get("speaker_mode")
        or "auto"
    ).strip().lower()
    if speaker_mode not in {"auto", "locked", "active"}:
        speaker_mode = "auto"
    enabled = mode != "off" and not explicit_disabled
    if auto_reframe_enabled is False or str(auto_reframe_enabled).strip().lower() in {"0", "false", "off", "disabled"}:
        enabled = False
    if reframe_mode in {"centre", "disabled"}:
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
        # Turning off the visible face/body-follow effect must not throw away
        # Clyra's scene understanding.  The pipeline still analyses people
        # and active speakers, but applies only discrete reframe decisions
        # when a subject would leave frame or a sustained speaker switch wins.
        "smartReframe": _config_bool(raw.get("smartReframe", raw.get("smart_reframe", cfg.get("smartReframe", cfg.get("smart_reframe", True)))), True)
        and reframe_mode not in {"centre", "disabled"},
        "mode": mode,
        "selectedTrackId": str(selected) if selected else None,
        "selectedPersonId": str(selected_person) if selected_person else (str(selected) if selected else None),
        "sceneMode": scene_mode,
        "personMode": scene_mode,
        # A locked composition deliberately detects a face before rendering,
        # then keeps that composition still. Dynamic zoom would contradict
        # that user-visible promise and make subtitles feel attached to the
        # moving picture rather than to the finished vertical canvas.
        "allowZoom": _config_bool(raw.get("allowZoom", raw.get("allow_zoom", enabled)), enabled) and enabled and reframe_mode != "locked_subject",
        "reframeMode": reframe_mode,
        "speakerMode": speaker_mode,
        "trackingQuality": tracking_quality,
        "enableDebugOverlay": _config_bool(raw.get("enableDebugOverlay", raw.get("enable_debug_overlay", cfg.get("enableDebugOverlay", cfg.get("enable_debug_overlay", False))))),
        "analysisFps": analysis_fps_for_quality(tracking_quality),
        "splitScreenRequested": _config_bool(raw.get("splitScreen", raw.get("split_screen", cfg.get("splitScreen", cfg.get("split_screen", False))))),
        "sceneRules": rules,
    }


def build_smart_reframe_keyframes(crop_plan: Dict[str, Any]) -> Dict[str, Any]:
    """Convert a continuous tracking plan into deliberate smart reframe cuts.

    This is used when a user disables the visible face/body-follow effect.  We
    still use the detected active speaker and exit-risk geometry, but hold a
    composition until it is materially wrong, then switch directly to the new
    safe composition.  It avoids both a permanently static centre crop and
    the continuous virtual-camera motion the toggle intentionally disables.
    """
    plan = dict(crop_plan or {})
    source = [dict(row) for row in (plan.get("cropKeyframes") or []) if isinstance(row, dict)]
    source.sort(key=lambda row: float(row.get("timeMs", 0) or 0))
    if not source:
        return plan

    first = dict(source[0])
    first["timeMs"] = 0
    first["source"] = "smart-reframe"
    # Normalise every snap to the same base zoom.  This is a layout correction,
    # not a face/body-follow effect, so it must not breathe as detection scale
    # changes.
    base_zoom = max(1.0, float(first.get("zoom", 1.0) or 1.0))
    base_width = max(1.0, float(first.get("scaledWidth", 1.0) or 1.0) / base_zoom)
    base_height = max(1.0, float(first.get("scaledHeight", 1.0) or 1.0) / base_zoom)
    out_width = max(1.0, float(first.get("width", 1.0) or 1.0))
    out_height = max(1.0, float(first.get("height", 1.0) or 1.0))

    def snap(row: Dict[str, Any]) -> Dict[str, Any]:
        next_row = dict(row)
        reference_width = max(out_width, float(row.get("scaledWidth", base_width) or base_width))
        reference_height = max(out_height, float(row.get("scaledHeight", base_height) or base_height))
        max_reference_x = max(1.0, reference_width - out_width)
        max_reference_y = max(1.0, reference_height - out_height)
        ratio_x = max(0.0, min(1.0, float(row.get("x", 0) or 0) / max_reference_x))
        ratio_y = max(0.0, min(1.0, float(row.get("y", 0) or 0) / max_reference_y))
        next_row["x"] = int(round(ratio_x * max(0.0, base_width - out_width)))
        next_row["y"] = int(round(ratio_y * max(0.0, base_height - out_height)))
        next_row["scaledWidth"] = int(round(base_width))
        next_row["scaledHeight"] = int(round(base_height))
        next_row["zoom"] = 1.0
        next_row["source"] = "smart-reframe"
        return next_row

    held = snap(first)
    keyframes = [held]
    last_change_ms = 0.0
    held_subject = str(held.get("activeSpeakerTrackId") or held.get("personId") or held.get("trackId") or "")
    # A reframe is only warranted when the composed crop has moved far enough
    # that the person is approaching an edge, or the persisted active-speaker
    # selector verifies a different speaker.  The hold interval prevents a
    # rapid conversation from degenerating into a sequence of whips.
    for source_row in source[1:]:
        candidate = snap(source_row)
        time_ms = max(0.0, float(candidate.get("timeMs", 0) or 0))
        if time_ms - last_change_ms < 450.0:
            continue
        subject = str(candidate.get("activeSpeakerTrackId") or candidate.get("personId") or candidate.get("trackId") or "")
        speaker_changed = bool(subject and held_subject and subject != held_subject)
        movement_x = abs(float(candidate.get("x", 0) or 0) - float(held.get("x", 0) or 0)) / max(1.0, base_width - out_width)
        movement_y = abs(float(candidate.get("y", 0) or 0) - float(held.get("y", 0) or 0)) / max(1.0, base_height - out_height)
        if not speaker_changed and max(movement_x, movement_y) < 0.18:
            continue
        # Two nearly coincident values intentionally make the stored path a
        # cut: hold until the new decision, then snap to the verified framing.
        hold = dict(held)
        hold["timeMs"] = max(float(held.get("timeMs", 0) or 0), time_ms - 1.0)
        if hold["timeMs"] > keyframes[-1]["timeMs"]:
            keyframes.append(hold)
        candidate["timeMs"] = time_ms
        keyframes.append(candidate)
        held = candidate
        held_subject = subject or held_subject
        last_change_ms = time_ms

    tracking = dict(plan.get("faceTracking") or {})
    tracking.update({
        "enabled": False,
        "mode": "off",
        "backend": "smart-scene-reframe",
        "smartReframe": True,
        "trajectoryMode": "snap-on-subject-exit-or-speaker-switch",
        "allowZoom": False,
        "pathSampleCount": len(keyframes),
    })
    plan["faceTracking"] = tracking
    plan["cropKeyframes"] = keyframes
    return plan


def _landmarker_model_path(cache_dir: str, kind: str = "face") -> str:
    os.makedirs(cache_dir, exist_ok=True)
    is_pose = kind == "pose"
    path = os.path.join(cache_dir, "pose_landmarker_lite.task" if is_pose else "face_landmarker.task")
    if os.path.isfile(path) and os.path.getsize(path) > 10_000:
        return path
    tmp = path + ".tmp"
    try:
        urllib.request.urlretrieve(POSE_LANDMARKER_MODEL_URL if is_pose else FACE_LANDMARKER_MODEL_URL, tmp)
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
    """Small persistent fallback tracker when Norfair is not installed.

    A profile cascade is intentionally conservative and can miss a few frames
    while a speaker turns or crosses a busy background.  Plain IoU-only
    matching discarded that identity after roughly a third of a second, then
    created a new face id on every reacquisition.  This fallback keeps a short
    velocity prediction and a lightweight appearance check so a temporary
    detector miss does not turn into an identity switch or a crop jump.
    """

    def __init__(
        self,
        iou_threshold: float = 0.20,
        max_missing: int = int(MAX_MISSING_MS / 1000.0 * PROXY_FPS),
    ):
        self.iou_threshold = iou_threshold
        self.max_missing = max_missing
        self._next_id = 1
        self.tracks: Dict[int, Dict[str, Any]] = {}

    @staticmethod
    def _center(box: Sequence[float]) -> Tuple[float, float]:
        return ((float(box[0]) + float(box[2])) / 2.0, (float(box[1]) + float(box[3])) / 2.0)

    @staticmethod
    def _translate(box: Sequence[float], velocity: Sequence[float], frames: int) -> List[float]:
        dx, dy = float(velocity[0]) * frames, float(velocity[1]) * frames
        width = float(box[2]) - float(box[0])
        height = float(box[3]) - float(box[1])
        x1 = min(max(0.0, float(box[0]) + dx), max(0.0, 1.0 - width))
        y1 = min(max(0.0, float(box[1]) + dy), max(0.0, 1.0 - height))
        return [x1, y1, x1 + width, y1 + height]

    @staticmethod
    def _centre_distance(a: Sequence[float], b: Sequence[float]) -> float:
        ax, ay = SimpleIoUTracker._center(a)
        bx, by = SimpleIoUTracker._center(b)
        return math.hypot(ax - bx, ay - by)

    @staticmethod
    def _identity_box(item: Dict[str, Any]) -> List[float]:
        """Prefer a body box for identity matching while retaining face boxes.

        A face landmark pass can alternate with a pose-only pass during a
        profile turn. Matching the tiny face rectangle to the larger upper-body
        rectangle makes a single person look like several new identities. The
        crop still uses ``bbox``/facial anchor for composition; this separate
        box is exclusively for persistent identity association.
        """
        candidate = item.get("identityBox") or item.get("bodyBox") or item.get("bbox") or []
        if isinstance(candidate, (list, tuple)) and len(candidate) == 4:
            return [float(value) for value in candidate]
        return [0.0, 0.0, 1.0, 1.0]

    def _match_score(self, track: Dict[str, Any], det: Dict[str, Any]) -> Tuple[float, bool]:
        predicted = self._translate(
            self._identity_box(track),
            track.get("velocity", (0.0, 0.0)),
            min(int(track.get("missing", 0)) + 1, 6),
        )
        detection_box = self._identity_box(det)
        overlap = _iou(predicted, detection_box)
        distance = self._centre_distance(predicted, detection_box)
        appearance = _hist_distance(track.get("hist"), det.get("hist"))
        # A fresh profile detection can have low IoU after a quick turn, but it
        # may still be the selected face if motion and appearance agree.  The
        # appearance guard deliberately remains strict enough not to merge two
        # people that cross in the same shot.
        incompatible_appearance = (
            track.get("hist") is not None
            and det.get("hist") is not None
            and appearance > 0.48
        )
        acceptable = not incompatible_appearance and (overlap >= self.iou_threshold or (
            distance <= 0.23 and appearance <= min(PERSON_MATCH_THRESHOLD, 0.32)
        ))
        score = overlap * 0.58 + max(0.0, 1.0 - distance / 0.32) * 0.24 + max(0.0, 1.0 - appearance / 0.42) * 0.18
        return score, acceptable

    def update(self, detections: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        assigned = set()
        matched: List[Tuple[int, Dict[str, Any]]] = []
        for track_id, track in list(self.tracks.items()):
            best_score, best_idx = -1.0, -1
            for index, det in enumerate(detections):
                if index in assigned:
                    continue
                score, acceptable = self._match_score(track, det)
                if acceptable and score > best_score:
                    best_score, best_idx = score, index
            if best_idx >= 0:
                det = detections[best_idx]
                assigned.add(best_idx)
                prior_center = self._center(self._identity_box(track))
                current_center = self._center(self._identity_box(det))
                observed_velocity = (
                    current_center[0] - prior_center[0],
                    current_center[1] - prior_center[1],
                )
                prior_velocity = track.get("velocity", (0.0, 0.0))
                track.update(
                    {
                        "bbox": det["bbox"],
                        "identityBox": self._identity_box(det),
                        "confidence": det["confidence"],
                        "missing": 0,
                        "hist": det.get("hist"),
                        "stableAnchor": det.get("stableAnchor"),
                        "mouthOpen": det.get("mouthOpen"),
                        "bodyBox": det.get("bodyBox") or track.get("bodyBox"),
                        "bodyAnchor": det.get("bodyAnchor") or track.get("bodyAnchor"),
                        "detector": det.get("detector", "face"),
                        "velocity": (
                            float(prior_velocity[0]) * 0.45 + observed_velocity[0] * 0.55,
                            float(prior_velocity[1]) * 0.45 + observed_velocity[1] * 0.55,
                        ),
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
                "identityBox": self._identity_box(det),
                "confidence": det["confidence"],
                "missing": 0,
                "hist": det.get("hist"),
                "stableAnchor": det.get("stableAnchor"),
                "mouthOpen": det.get("mouthOpen"),
                "bodyBox": det.get("bodyBox"),
                "bodyAnchor": det.get("bodyAnchor"),
                "detector": det.get("detector", "face"),
                "velocity": (0.0, 0.0),
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
                "stableAnchor": track.get("stableAnchor"),
                "mouthOpen": track.get("mouthOpen"),
                "bodyBox": track.get("bodyBox"),
                "bodyAnchor": track.get("bodyAnchor"),
                "detector": track.get("detector", "face"),
            }
            for track_id, track in matched
            if int(track.get("missing", 0)) == 0
        ]

    def propagate_optical_flow(
        self,
        dx: float,
        dy: float,
        confidence: float,
    ) -> List[Dict[str, Any]]:
        """Advance confirmed tracks between expensive landmark passes.

        Optical flow updates *the same* persistent record instead of creating a
        fresh detection identity.  It is deliberately disabled by callers when
        the flow estimate is weak, so a transient background motion cannot drag
        the crop through the scene.
        """
        if confidence <= 0.0:
            return []
        shifted: List[Dict[str, Any]] = []
        for track_id, track in self.tracks.items():
            if int(track.get("missing", 0)) > 0:
                continue
            bbox = list(track.get("bbox") or [])
            if len(bbox) != 4:
                continue
            width, height = bbox[2] - bbox[0], bbox[3] - bbox[1]
            x1 = min(max(0.0, float(bbox[0]) + float(dx)), max(0.0, 1.0 - width))
            y1 = min(max(0.0, float(bbox[1]) + float(dy)), max(0.0, 1.0 - height))
            translated = [x1, y1, x1 + width, y1 + height]
            track["bbox"] = translated
            identity_box = self._identity_box(track)
            identity_width, identity_height = identity_box[2] - identity_box[0], identity_box[3] - identity_box[1]
            ix1 = min(max(0.0, identity_box[0] + float(dx)), max(0.0, 1.0 - identity_width))
            iy1 = min(max(0.0, identity_box[1] + float(dy)), max(0.0, 1.0 - identity_height))
            track["identityBox"] = [ix1, iy1, ix1 + identity_width, iy1 + identity_height]
            prior_velocity = track.get("velocity", (0.0, 0.0))
            track["velocity"] = (
                float(prior_velocity[0]) * 0.35 + float(dx) * 0.65,
                float(prior_velocity[1]) * 0.35 + float(dy) * 0.65,
            )
            for anchor_key in ("stableAnchor", "bodyAnchor"):
                anchor = track.get(anchor_key)
                if isinstance(anchor, dict):
                    updated = dict(anchor)
                    for key, delta in (("x", dx), ("y", dy), ("eyeLineY", dy), ("foreheadY", dy), ("chinY", dy)):
                        if key in updated:
                            updated[key] = float(min(1.0, max(0.0, float(updated[key]) + float(delta))))
                    track[anchor_key] = updated
            body_box = track.get("bodyBox")
            if isinstance(body_box, (list, tuple)) and len(body_box) == 4:
                bx1, by1, bx2, by2 = [float(v) for v in body_box]
                bw, bh = bx2 - bx1, by2 - by1
                bx1 = min(max(0.0, bx1 + float(dx)), max(0.0, 1.0 - bw))
                by1 = min(max(0.0, by1 + float(dy)), max(0.0, 1.0 - bh))
                track["bodyBox"] = [bx1, by1, bx1 + bw, by1 + bh]
            shifted.append(
                {
                    "id": f"face_{track_id:02d}",
                    "trackId": f"face_{track_id:02d}",
                    "bbox": translated,
                    "confidence": max(0.0, float(track.get("confidence", 0.5)) * (0.78 + 0.18 * float(confidence))),
                    "hist": track.get("hist"),
                    "stableAnchor": track.get("stableAnchor"),
                    "mouthOpen": track.get("mouthOpen"),
                    "bodyBox": track.get("bodyBox"),
                    "bodyAnchor": track.get("bodyAnchor"),
                    "detector": "optical-flow",
                    "flowConfidence": round(float(confidence), 4),
                }
            )
        return shifted


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
            stable_anchor = None
            mouth_open = None
            best = 1e9
            for det in detections:
                dx = ((det["bbox"][0] + det["bbox"][2]) / 2.0) - cx
                dy = ((det["bbox"][1] + det["bbox"][3]) / 2.0) - cy
                dist = dx * dx + dy * dy
                if dist < best:
                    best = dist
                    hist = det.get("hist")
                    stable_anchor = det.get("stableAnchor")
                    mouth_open = det.get("mouthOpen")
            out.append(
                {
                    "id": f"face_{int(obj.id):02d}",
                    "trackId": f"face_{int(obj.id):02d}",
                    "bbox": [cx - size / 2, cy - size / 2, cx + size / 2, cy + size / 2],
                    "confidence": 0.7,
                    "hist": hist,
                    "stableAnchor": stable_anchor,
                    "mouthOpen": mouth_open,
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


def _mediapipe_landmarker(cache_dir: str):
    from mediapipe.tasks.python import vision
    from mediapipe.tasks.python.core import base_options

    model = _landmarker_model_path(cache_dir)
    options = vision.FaceLandmarkerOptions(
        base_options=base_options.BaseOptions(model_asset_path=model),
        running_mode=vision.RunningMode.VIDEO,
        num_faces=4,
        min_face_detection_confidence=0.60,
        min_face_presence_confidence=0.60,
        min_tracking_confidence=0.65,
        output_face_blendshapes=False,
        output_facial_transformation_matrixes=True,
    )
    return vision.FaceLandmarker.create_from_options(options)


def _mediapipe_pose_landmarker(cache_dir: str):
    """Create the lightweight Pose task in synchronous prerecorded-video mode.

    It is a body fallback, not a second heavy visual model.  The model is only
    loaded while a selected clip is analysed and is closed before rendering.
    """
    from mediapipe.tasks.python import vision
    from mediapipe.tasks.python.core import base_options

    model = _landmarker_model_path(cache_dir, "pose")
    options = vision.PoseLandmarkerOptions(
        base_options=base_options.BaseOptions(model_asset_path=model),
        running_mode=vision.RunningMode.VIDEO,
        num_poses=4,
        min_pose_detection_confidence=0.55,
        min_pose_presence_confidence=0.55,
        min_tracking_confidence=0.60,
        output_segmentation_masks=False,
    )
    return vision.PoseLandmarker.create_from_options(options)


def _robust_anchor(landmarks: Sequence[Any], bbox: Sequence[float]) -> Dict[str, float]:
    """Build a stable upper-face anchor from landmark geometry.

    Eye-line and upper-face points remain materially steadier than the nose tip
    while talking.  A weighted median limits the effect of one unstable point.
    """
    def point(index: int) -> Tuple[float, float]:
        item = landmarks[index]
        return float(item.x), float(item.y)
    try:
        left_outer, right_outer = point(33), point(263)
        left_inner, right_inner = point(133), point(362)
        nose_bridge = point(6)
        upper_face = point(9)
        forehead = point(10)
        chin = point(152)
        mouth_top = point(13)
        mouth_bottom = point(14)
        eye_mid = ((left_outer[0] + right_outer[0] + left_inner[0] + right_inner[0]) / 4.0,
                   (left_outer[1] + right_outer[1] + left_inner[1] + right_inner[1]) / 4.0)
        face_oval_x = (float(bbox[0]) + float(bbox[2])) * 0.5
        face_oval_y = (float(bbox[1]) + float(bbox[3])) * 0.5
        x_values = sorted([eye_mid[0], eye_mid[0], upper_face[0], face_oval_x, nose_bridge[0]])
        y_values = sorted([eye_mid[1], eye_mid[1], upper_face[1], face_oval_y, nose_bridge[1]])
        face_height = max(1e-5, float(bbox[3]) - float(bbox[1]))
        eye_span = max(1e-5, abs(right_outer[0] - left_outer[0]))
        mouth_open = abs(mouth_bottom[1] - mouth_top[1]) / face_height
        yaw = max(-1.0, min(1.0, (nose_bridge[0] - eye_mid[0]) / (eye_span * 0.55)))
        return {
            "x": round(float(x_values[len(x_values) // 2]), 5),
            "y": round(float(y_values[len(y_values) // 2]), 5),
            "eyeLineY": round(float(eye_mid[1]), 5),
            "foreheadY": round(float(forehead[1]), 5),
            "chinY": round(float(chin[1]), 5),
            "width": round(max(1e-5, float(bbox[2]) - float(bbox[0])), 5),
            "height": round(face_height, 5),
            "mouthOpen": round(max(0.0, min(1.0, mouth_open)), 5),
            "yaw": round(yaw, 5),
        }
    except (IndexError, AttributeError, TypeError):
        x1, y1, x2, y2 = [float(value) for value in bbox]
        return {
            "x": round((x1 + x2) * 0.5, 5),
            "y": round(y1 + (y2 - y1) * 0.38, 5),
            "width": round(x2 - x1, 5),
            "height": round(y2 - y1, 5),
            "mouthOpen": 0.0,
            "yaw": 0.0,
        }


def _detect_mediapipe(landmarker, rgb: np.ndarray, timestamp_ms: int) -> List[Dict[str, Any]]:
    # Public package root is stable across current MediaPipe wheels.
    import mediapipe as mp

    mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
    result = landmarker.detect_for_video(mp_image, max(0, int(timestamp_ms)))
    detections = []
    for landmarks in result.face_landmarks or []:
        xs = [float(item.x) for item in landmarks]
        ys = [float(item.y) for item in landmarks]
        if not xs or not ys:
            continue
        x1, y1 = max(0.0, min(xs)), max(0.0, min(ys))
        x2, y2 = min(1.0, max(xs)), min(1.0, max(ys))
        score = 0.82
        if x2 > x1 and y2 > y1:
            bbox = [x1, y1, x2, y2]
            anchor = _robust_anchor(landmarks, bbox)
            detections.append({"bbox": bbox, "confidence": score, "stableAnchor": anchor, "mouthOpen": anchor.get("mouthOpen", 0.0)})
    return detections


def _pose_anchor(landmarks: Sequence[Any]) -> Optional[Dict[str, Any]]:
    """Turn 33 MediaPipe pose landmarks into a face-aware body composition point."""
    try:
        def point(index: int) -> Tuple[float, float, float]:
            item = landmarks[index]
            return float(item.x), float(item.y), float(getattr(item, "visibility", 0.0))

        left_shoulder, right_shoulder = point(11), point(12)
        left_hip, right_hip = point(23), point(24)
        nose = point(0)
        # Pose Landmarker still gives reliable head landmarks when a profile
        # face is too turned for Face Landmarker.  Keeping their position is
        # critical: a torso-centred crop can leave the nose at the edge even
        # though the body itself remains inside the vertical frame.
        left_eye, right_eye = point(2), point(5)
        visible = [left_shoulder[2], right_shoulder[2], left_hip[2], right_hip[2]]
        if float(np.mean(visible)) < 0.28:
            return None
        shoulder_x = (left_shoulder[0] + right_shoulder[0]) * 0.5
        shoulder_y = (left_shoulder[1] + right_shoulder[1]) * 0.5
        hip_x = (left_hip[0] + right_hip[0]) * 0.5
        hip_y = (left_hip[1] + right_hip[1]) * 0.5
        all_visible = [point(i) for i in range(min(33, len(landmarks))) if point(i)[2] >= 0.25]
        if not all_visible:
            return None
        xs = [p[0] for p in all_visible]
        ys = [p[1] for p in all_visible]
        x1, y1, x2, y2 = max(0.0, min(xs)), max(0.0, min(ys)), min(1.0, max(xs)), min(1.0, max(ys))
        if x2 <= x1 or y2 <= y1:
            return None
        torso_height = max(0.04, abs(hip_y - shoulder_y))
        shoulder_width = max(0.035, abs(right_shoulder[0] - left_shoulder[0]))
        head_points = [item for item in (nose, left_eye, right_eye) if item[2] >= 0.28]
        if head_points:
            # Prefer the nose/eyes to the broad shoulder centre. A gentle
            # shoulder contribution preserves room for gestures without
            # allowing a sideways body to pull the face out of frame.
            head_x = float(np.median([item[0] for item in head_points]))
            eye_y = float(np.median([item[1] for item in head_points]))
            composition_x = head_x * 0.82 + shoulder_x * 0.18
            eye_line_y = eye_y
            head_confidence = float(np.mean([item[2] for item in head_points]))
        else:
            composition_x = shoulder_x * 0.72 + hip_x * 0.28
            eye_line_y = max(0.0, shoulder_y - torso_height * 0.72)
            head_confidence = 0.0
        return {
            "bbox": [x1, y1, x2, y2],
            "x": min(1.0, max(0.0, composition_x)),
            "y": min(1.0, max(0.0, shoulder_y * 0.60 + hip_y * 0.40)),
            "eyeLineY": max(0.0, eye_line_y),
            "headX": min(1.0, max(0.0, head_x if head_points else composition_x)),
            "headLandmarkConfidence": head_confidence,
            "shoulderMidX": shoulder_x,
            "shoulderMidY": shoulder_y,
            "torsoCenterX": (shoulder_x + hip_x) * 0.5,
            "torsoCenterY": (shoulder_y + hip_y) * 0.5,
            "width": max(shoulder_width, x2 - x1),
            "height": y2 - y1,
            "confidence": float(np.mean(visible)),
        }
    except (AttributeError, IndexError, TypeError, ValueError):
        return None


def _detect_pose_mediapipe(landmarker, rgb: np.ndarray, timestamp_ms: int) -> List[Dict[str, Any]]:
    import mediapipe as mp

    result = landmarker.detect_for_video(
        mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb),
        max(0, int(timestamp_ms)),
    )
    observations: List[Dict[str, Any]] = []
    for landmarks in result.pose_landmarks or []:
        anchor = _pose_anchor(landmarks)
        if anchor is None:
            continue
        observations.append(anchor)
    return observations


def _attach_bodies_to_faces(
    faces: List[Dict[str, Any]],
    bodies: Sequence[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    """Fuse precise face geometry with a pose-derived shoulder/torso fallback."""
    unused = list(bodies)
    for face in faces:
        fx, fy = _face_center(face["bbox"])
        candidate_index = -1
        candidate_score = float("inf")
        for index, body in enumerate(unused):
            box = body.get("bbox") or []
            if len(box) != 4:
                continue
            # A face must sit in the upper half of the pose box.  This avoids
            # associating a foreground face to a different body in a crossing.
            in_upper = box[0] - 0.06 <= fx <= box[2] + 0.06 and box[1] - 0.14 <= fy <= (box[1] + box[3]) * 0.5 + 0.05
            distance = math.hypot(fx - float(body.get("shoulderMidX", body.get("x", fx))), fy - float(body.get("eyeLineY", fy)))
            if in_upper and distance < candidate_score:
                candidate_index, candidate_score = index, distance
        if candidate_index >= 0:
            body = unused.pop(candidate_index)
            face["bodyBox"] = list(body["bbox"])
            face["bodyAnchor"] = {k: v for k, v in body.items() if k != "bbox"}
            face["detector"] = "mediapipe-face+pose"
    return faces


def _body_only_detections(bodies: Sequence[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Use a shoulder/torso proxy only when a face is genuinely unavailable."""
    out: List[Dict[str, Any]] = []
    for body in bodies:
        bbox = list(body.get("bbox") or [])
        if len(bbox) != 4:
            continue
        # Track the upper body as the identity box, while preserving the full
        # pose box for crop composition and graceful face-loss recovery.
        x1, y1, x2, y2 = [float(v) for v in bbox]
        upper = [x1, y1, x2, y1 + (y2 - y1) * 0.58]
        anchor = {
            "x": float(body.get("x", (x1 + x2) * 0.5)),
            "y": float(body.get("eyeLineY", y1 + (y2 - y1) * 0.24)),
            "eyeLineY": float(body.get("eyeLineY", y1 + (y2 - y1) * 0.24)),
            "foreheadY": y1,
            "chinY": y1 + (y2 - y1) * 0.38,
            "width": max(0.01, x2 - x1),
            "height": max(0.01, y2 - y1),
            "bodyOnly": True,
            "yaw": 0.0,
        }
        out.append({
            "bbox": upper,
            "confidence": max(0.35, min(0.75, float(body.get("confidence", 0.5)))),
            "stableAnchor": anchor,
            "bodyBox": bbox,
            "bodyAnchor": {k: v for k, v in body.items() if k != "bbox"},
            "mouthOpen": 0.0,
            "detector": "mediapipe-pose",
        })
    return out


def _fuse_subject_anchor(
    face_anchor: Optional[Dict[str, Any]],
    body_anchor: Optional[Dict[str, Any]],
    fallback_bbox: Sequence[float],
) -> Dict[str, Any]:
    """Fuse stable facial geometry with shoulders/torso for one camera target.

    The face remains the authority for eye line and horizontal composition.
    Shoulders and torso contribute only enough to make profile views, bends and
    gesture-heavy movement stable.  This avoids the older failure mode where a
    fresh body box could abruptly pull the crop away from a still-visible face.
    """
    fx1, fy1, fx2, fy2 = [float(value) for value in fallback_bbox]
    face = dict(face_anchor or {})
    body = dict(body_anchor or {})
    if face and not bool(face.get("bodyOnly")):
        face_x = float(face.get("x", (fx1 + fx2) * 0.5))
        face_y = float(face.get("y", fy1 + (fy2 - fy1) * 0.38))
        eye_y = float(face.get("eyeLineY", face_y))
        shoulder_x = float(body.get("shoulderMidX", body.get("x", face_x)))
        torso_y = float(body.get("torsoCenterY", body.get("y", face_y)))
        merged = dict(face)
        merged.update({
            "x": min(1.0, max(0.0, face_x * 0.72 + shoulder_x * 0.28)),
            "y": min(1.0, max(0.0, face_y * 0.68 + torso_y * 0.32)),
            "eyeLineY": min(1.0, max(0.0, eye_y)),
            "bodyOnly": False,
            "anchorSource": "face_body" if body else "face",
        })
        if body:
            merged["bodyHeight"] = float(body.get("height", body.get("bodyHeight", 0.0)))
            merged["shoulderMidX"] = shoulder_x
            merged["torsoCenterY"] = torso_y
        return merged
    if body:
        merged = dict(body)
        merged.update({
            "x": float(body.get("x", body.get("shoulderMidX", (fx1 + fx2) * 0.5))),
            "y": float(body.get("y", body.get("torsoCenterY", (fy1 + fy2) * 0.5))),
            "eyeLineY": float(body.get("eyeLineY", fy1 + (fy2 - fy1) * 0.24)),
            "bodyOnly": True,
            "anchorSource": "body",
        })
        return merged
    return {
        "x": (fx1 + fx2) * 0.5,
        "y": fy1 + (fy2 - fy1) * 0.38,
        "eyeLineY": fy1 + (fy2 - fy1) * 0.38,
        "foreheadY": fy1,
        "chinY": fy2,
        "width": max(0.01, fx2 - fx1),
        "height": max(0.01, fy2 - fy1),
        "bodyOnly": False,
        "anchorSource": "box_fallback",
    }


_OPENCV_CASCADE_CACHE: Dict[str, Any] = {}


def _profile_face_fallback(rgb: np.ndarray) -> List[Dict[str, Any]]:
    """Detect side-facing speakers only when the landmark detector has no face.

    MediaPipe landmarks are the primary head geometry source.  Profile views
    frequently have too little visible eye geometry for that model, however,
    and falling straight through to a static crop makes a moving speaker look
    broken.  OpenCV's bundled profile cascade is small, local and deterministic
    enough to be a safe fallback.  We inspect the original and mirrored frame
    because the cascade is direction-sensitive; the result keeps the normalised
    source coordinates so the existing identity/trajectory code remains shared.
    """
    try:
        import cv2
    except Exception:
        return []
    try:
        cascade_path = os.path.join(cv2.data.haarcascades, "haarcascade_profileface.xml")
        cascade = _OPENCV_CASCADE_CACHE.get(cascade_path)
        if cascade is None:
            cascade = cv2.CascadeClassifier(cascade_path)
            if cascade.empty():
                return []
            _OPENCV_CASCADE_CACHE[cascade_path] = cascade
        gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
        height, width = gray.shape[:2]
        candidates: List[Tuple[int, int, int, int]] = []
        for mirrored in (False, True):
            image = cv2.flip(gray, 1) if mirrored else gray
            found = cascade.detectMultiScale(
                image,
                scaleFactor=1.08,
                minNeighbors=3,
                minSize=(max(22, width // 24), max(22, height // 24)),
            )
            for x, y, w, h in found:
                if mirrored:
                    x = width - int(x) - int(w)
                candidate = (int(x), int(y), int(w), int(h))
                if not any(_iou(
                    [candidate[0] / width, candidate[1] / height, (candidate[0] + candidate[2]) / width, (candidate[1] + candidate[3]) / height],
                    [old[0] / width, old[1] / height, (old[0] + old[2]) / width, (old[1] + old[3]) / height],
                ) > 0.6 for old in candidates):
                    candidates.append(candidate)
        detections: List[Dict[str, Any]] = []
        for x, y, w, h in candidates:
            bbox = [
                max(0.0, x / width), max(0.0, y / height),
                min(1.0, (x + w) / width), min(1.0, (y + h) / height),
            ]
            detections.append({
                "bbox": bbox,
                "confidence": 0.58,
                "stableAnchor": _robust_anchor([], bbox),
                "mouthOpen": 0.0,
                "detector": "opencv-profile",
            })
        return detections
    except Exception:
        return []


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


def _optical_flow_delta(
    previous_gray: Optional[np.ndarray],
    current_gray: np.ndarray,
    boxes: Sequence[Sequence[float]],
) -> Tuple[float, float, float, int, Dict[str, Any]]:
    """Return a confidence-checked, camera-compensated subject displacement.

    LK is used on every intermediate frame, but a one-way LK result can be
    confidently wrong after an occlusion, a flash, or a camera pan.  We
    therefore validate each selected-subject point with a forward/backward
    round trip, reject poor tracks, and estimate background translation outside
    the subject boxes.  The returned displacement is relative to that global
    motion, which keeps a handheld camera movement from being mistaken for a
    change in the locked person's identity.

    This function is intentionally bounded: it stores only the two adjacent
    grayscale frames and small point arrays, so it remains safe for the 8 GB
    worker profile.
    """
    empty = {
        "validRatio": 0.0,
        "forwardBackwardErrorPx": None,
        "cameraMotion": {"dx": 0.0, "dy": 0.0, "points": 0, "confidence": 0.0},
        "redetectRecommended": True,
    }
    if previous_gray is None or current_gray is None or not boxes:
        return 0.0, 0.0, 0.0, 0, empty
    try:
        import cv2

        prior = np.asarray(previous_gray, dtype=np.uint8)
        current = np.asarray(current_gray, dtype=np.uint8)
        if prior.shape != current.shape or prior.size == 0:
            return 0.0, 0.0, 0.0, 0, empty
        h, w = prior.shape[:2]
        subject_mask = np.zeros_like(prior, dtype=np.uint8)
        for box in boxes:
            if len(box) != 4:
                continue
            x1 = max(0, min(w - 1, int(float(box[0]) * w)))
            y1 = max(0, min(h - 1, int(float(box[1]) * h)))
            x2 = max(x1 + 1, min(w, int(float(box[2]) * w)))
            y2 = max(y1 + 1, min(h, int(float(box[3]) * h)))
            subject_mask[y1:y2, x1:x2] = 255

        def tracked_displacements(mask: np.ndarray, max_corners: int) -> Tuple[np.ndarray, np.ndarray, float, int]:
            features = cv2.goodFeaturesToTrack(
                prior,
                maxCorners=max_corners,
                qualityLevel=0.012,
                minDistance=5,
                mask=mask,
                blockSize=7,
            )
            if features is None or len(features) < 4:
                return np.empty((0, 2), dtype=np.float32), np.empty((0,), dtype=bool), float("inf"), 0
            next_points, forward_status, forward_errors = cv2.calcOpticalFlowPyrLK(
                prior,
                current,
                features,
                None,
                winSize=(19, 19),
                maxLevel=3,
                criteria=(cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 20, 0.03),
            )
            if next_points is None or forward_status is None:
                return np.empty((0, 2), dtype=np.float32), np.empty((0,), dtype=bool), float("inf"), len(features)
            back_points, backward_status, _ = cv2.calcOpticalFlowPyrLK(
                current,
                prior,
                next_points,
                None,
                winSize=(19, 19),
                maxLevel=3,
                criteria=(cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 20, 0.03),
            )
            if back_points is None or backward_status is None:
                return np.empty((0, 2), dtype=np.float32), np.empty((0,), dtype=bool), float("inf"), len(features)
            valid = forward_status.reshape(-1).astype(bool) & backward_status.reshape(-1).astype(bool)
            if forward_errors is not None:
                valid &= forward_errors.reshape(-1) < 24.0
            roundtrip = np.linalg.norm(features.reshape(-1, 2) - back_points.reshape(-1, 2), axis=1)
            valid &= np.isfinite(roundtrip) & (roundtrip <= FLOW_MAX_FB_ERROR_PX)
            displacement = next_points.reshape(-1, 2) - features.reshape(-1, 2)
            return displacement, valid, (float(np.median(roundtrip[valid])) if int(valid.sum()) else float("inf")), len(features)

        displacement, valid, fb_error, feature_count = tracked_displacements(subject_mask, 96)
        valid_count = int(valid.sum())
        valid_ratio = valid_count / max(1, feature_count)
        if valid_count < 4:
            meta = dict(empty)
            meta["validRatio"] = round(valid_ratio, 4)
            meta["forwardBackwardErrorPx"] = None if not math.isfinite(fb_error) else round(fb_error, 4)
            return 0.0, 0.0, 0.0, valid_count, meta
        subject_delta = np.median(displacement[valid], axis=0)
        residual = np.linalg.norm(displacement[valid] - subject_delta, axis=1)
        inliers = residual <= max(2.5, float(np.percentile(residual, 70)))
        if int(inliers.sum()) >= 4:
            subject_delta = np.median(displacement[valid][inliers], axis=0)
            valid_count = int(inliers.sum())

        # Background features are explicitly outside the selected-person boxes.
        # Their median represents source-camera motion, not the person's own
        # motion.  This is advisory compensation: if too few background points
        # survive, retain the subject displacement rather than fabricating one.
        background_mask = cv2.bitwise_not(subject_mask)
        background_mask[: max(2, int(h * 0.03)), :] = 0
        background_displacement, background_valid, background_fb, background_total = tracked_displacements(background_mask, 120)
        background_count = int(background_valid.sum())
        camera_delta = np.array([0.0, 0.0], dtype=np.float32)
        camera_confidence = 0.0
        if background_count >= 6:
            candidate = np.median(background_displacement[background_valid], axis=0)
            bg_residual = np.linalg.norm(background_displacement[background_valid] - candidate, axis=1)
            bg_inliers = bg_residual <= max(2.5, float(np.percentile(bg_residual, 70)))
            if int(bg_inliers.sum()) >= 6:
                candidate = np.median(background_displacement[background_valid][bg_inliers], axis=0)
                background_count = int(bg_inliers.sum())
            camera_delta = candidate.astype(np.float32)
            camera_confidence = max(0.0, min(1.0, (background_count / 24.0) * (1.0 - min(1.0, background_fb / 4.0))))

        # Relative movement is most useful for identity continuity.  Preserve
        # deliberate source-camera motion in crop composition by only applying
        # compensation when the background estimate is reliable.
        corrected_delta = subject_delta - camera_delta if camera_confidence >= 0.38 else subject_delta
        magnitude = math.hypot(float(corrected_delta[0]) / max(1, w), float(corrected_delta[1]) / max(1, h))
        if not math.isfinite(magnitude) or magnitude > 0.20:
            meta = {
                "validRatio": round(valid_ratio, 4),
                "forwardBackwardErrorPx": round(fb_error, 4) if math.isfinite(fb_error) else None,
                "cameraMotion": {
                    "dx": round(float(camera_delta[0]) / max(1, w), 6),
                    "dy": round(float(camera_delta[1]) / max(1, h), 6),
                    "points": background_count,
                    "confidence": round(camera_confidence, 4),
                },
                "redetectRecommended": True,
            }
            return 0.0, 0.0, 0.0, valid_count, meta

        residual_score = 1.0 - min(1.0, fb_error / max(0.1, FLOW_MAX_FB_ERROR_PX))
        count_score = min(1.0, valid_count / 18.0)
        confidence = max(0.0, min(1.0, residual_score * count_score * min(1.0, valid_ratio / FLOW_MIN_VALID_RATIO)))
        meta = {
            "validRatio": round(valid_ratio, 4),
            "forwardBackwardErrorPx": round(fb_error, 4) if math.isfinite(fb_error) else None,
            "cameraMotion": {
                "dx": round(float(camera_delta[0]) / max(1, w), 6),
                "dy": round(float(camera_delta[1]) / max(1, h), 6),
                "points": background_count,
                "confidence": round(camera_confidence, 4),
            },
            "redetectRecommended": valid_ratio < FLOW_MIN_VALID_RATIO or fb_error > FLOW_MAX_FB_ERROR_PX,
        }
        return float(corrected_delta[0]) / max(1, w), float(corrected_delta[1]) / max(1, h), confidence, valid_count, meta
    except Exception:
        return 0.0, 0.0, 0.0, 0, empty


def _extract_proxy_frames(
    ffmpeg: str,
    source: str,
    start: float,
    duration: float,
    work_dir: str,
    height: int = PROXY_HEIGHT,
    fps: float = PROXY_FPS,
    source_fps: Optional[float] = None,
) -> List[Tuple[float, str]]:
    """Decode a bounded, low-resolution analysis stream without frame skipping.

    The output-frame crop path must be evaluated at source media time.  For
    normal CFR clips the image sequence inherits the native cadence; on a 60fps
    source that is one observation every 16.7ms, and on a 30fps source every
    33.3ms.  The analysis proxy is never used for the final render.
    """
    pattern = os.path.join(work_dir, "frame_%05d.jpg")
    native_fps = float(source_fps or 0.0)
    target_fps = min(max(1.0, float(fps)), native_fps, 60.0) if native_fps >= 1.0 else min(max(1.0, float(fps)), 60.0)
    # Preserve native frames whenever the master cadence is already within the
    # requested tracking cadence.  The fps filter is only a safety downsample
    # for unusually high frame-rate inputs.
    filters = [f"scale=-2:{height}"]
    if native_fps > target_fps + 0.25:
        filters.insert(0, f"fps={target_fps:.6f}")
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
        ",".join(filters),
        "-vsync",
        "0",
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
        # A decoded image sequence cannot retain per-frame PTS metadata itself.
        # With a native-CFR source this is the source presentation cadence.  VFR
        # inputs still retain their original timing during the master render;
        # this bounded fallback intentionally avoids wall-clock/UI timestamps.
        time_s = (index - 1) / max(1.0, target_fps)
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


def _audio_energy_at(audio_evidence: Optional[Dict[str, Any]], time_ms: int, offset_ms: int = 0) -> Optional[float]:
    """Read the existing FFmpeg audio-energy evidence at source media time.

    This is intentionally a weak corroborating signal rather than a new audio
    classifier.  It prevents mouth motion from switching subjects during a
    silent reaction, while keeping the tracker functional when audio analysis
    is unavailable.
    """
    if not isinstance(audio_evidence, dict) or not audio_evidence.get("available"):
        return None
    target = max(0, int(time_ms) + int(offset_ms))
    for row in audio_evidence.get("seconds") or []:
        if int(row.get("startMs", 0)) <= target < int(row.get("endMs", 0)):
            try:
                return max(0.0, min(1.0, float(row.get("energy", 0.0))))
            except (TypeError, ValueError):
                return None
    return None


def score_active_speaker(face: Dict[str, Any], audio_energy: Optional[float], previous_id: Optional[str] = None) -> float:
    """Score one visible tracked face using real mouth movement plus audio.

    It is not presented as TalkNet-style audiovisual speech detection.  This
    CPU-safe heuristic only selects a new speaker after persistent visual mouth
    motion that is corroborated by non-silent source audio.
    """
    confidence = max(0.0, min(1.0, float(face.get("confidence", 0.0))))
    mouth_motion = max(0.0, min(1.0, float(face.get("mouthMotion", 0.0))))
    mouth_open = max(0.0, min(1.0, float(face.get("mouthOpen", 0.0))))
    # Audio is a gate, never sufficient evidence to select a face by itself.
    audio_gate = 1.0 if audio_energy is None else 0.35 + 0.65 * audio_energy
    continuity = 0.12 if previous_id and str(face.get("personId") or face.get("trackId")) == previous_id else 0.0
    return max(0.0, min(1.0, (confidence * 0.31 + mouth_motion * 0.49 + min(1.0, mouth_open * 5.0) * 0.08) * audio_gate + continuity))


def choose_active_speaker(
    faces: Sequence[Dict[str, Any]],
    state: Optional[Dict[str, Any]],
    time_ms: int,
    audio_energy: Optional[float] = None,
    *,
    hold_ms: int = ACTIVE_SPEAKER_SWITCH_HOLD_MS,
) -> Tuple[Optional[Dict[str, Any]], Dict[str, Any]]:
    """Select a persistent active subject without whips between faces.

    A challenger must outrank the current subject by a margin for a sustained
    interval.  This makes rapid back-and-forth dialogue use a stable crop until
    there is enough evidence for a deliberate transition.
    """
    next_state = dict(state or {})
    visible = [dict(face) for face in faces if face.get("trackId") or face.get("personId")]
    if not visible:
        return None, next_state
    active_id = next_state.get("activeId")
    scored = []
    for face in visible:
        identity = str(face.get("personId") or face.get("trackId"))
        score = score_active_speaker(face, audio_energy, active_id)
        face["activeSpeakerScore"] = round(score, 4)
        scored.append((score, identity, face))
    scored.sort(key=lambda row: row[0], reverse=True)
    top_score, top_id, top_face = scored[0]
    current = next((row for row in scored if row[1] == active_id), None)
    if current is None:
        # A temporary detector/profile miss must not make the virtual camera
        # immediately adopt a different visible face.  Return no new target so
        # the crop planner applies its existing predicted/hold path.
        last_visible = next_state.get("activeLastVisibleMs")
        if active_id and last_visible is not None and time_ms - int(last_visible) <= int(MAX_OCCLUSION_S * 1000):
            next_state.update({"candidateId": None, "candidateSinceMs": None})
            return None, next_state
        next_state.update({"activeId": top_id, "candidateId": None, "candidateSinceMs": None, "lastSwitchMs": time_ms})
        next_state["activeLastVisibleMs"] = time_ms
        return top_face, next_state
    current_score, _current_id, current_face = current
    next_state["activeLastVisibleMs"] = time_ms
    if top_id == active_id or top_score < current_score + ACTIVE_SPEAKER_SWITCH_MARGIN:
        next_state.update({"candidateId": None, "candidateSinceMs": None})
        return current_face, next_state
    if next_state.get("candidateId") != top_id:
        next_state.update({"candidateId": top_id, "candidateSinceMs": time_ms})
        return current_face, next_state
    since = int(next_state.get("candidateSinceMs") or time_ms)
    if time_ms - since < max(0, int(hold_ms)):
        return current_face, next_state
    next_state.update({"activeId": top_id, "candidateId": None, "candidateSinceMs": None, "lastSwitchMs": time_ms})
    return top_face, next_state


def classify_tracking_scene(faces: Sequence[Dict[str, Any]]) -> str:
    """Return a conservative framing classification from local observations."""
    count = len(faces)
    if count <= 0:
        return "no_person"
    if count == 1:
        return "single_talking_head"
    return "multi_speaker"


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
    analysis_fps: float = PROXY_FPS,
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
        expected = max(1.0, duration * max(1.0, float(analysis_fps)))
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


def _raw_crop_target(
    face_bbox: Sequence[float],
    frame_w: int,
    frame_h: int,
    out_w: int,
    out_h: int,
    stable_anchor: Optional[Dict[str, Any]] = None,
    allow_zoom: bool = False,
) -> Tuple[float, float, int, int, Dict[str, float]]:
    """Compose a face into a crop without carrying any historical state.

    Face boxes are intentionally converted into an upper-face anchor instead of
    tracking the noisy box centre.  The detector fallback has no landmarks, so
    the anchor is a conservative geometric approximation of the eye line.  A
    Face Landmarker adapter can replace these values without changing the path
    optimiser below.
    """
    scale = max(out_w / max(1, frame_w), out_h / max(1, frame_h))
    base_scaled_w = max(out_w, int(round(frame_w * scale)))
    base_scaled_h = max(out_h, int(round(frame_h * scale)))
    fx1, fy1, fx2, fy2 = [float(v) for v in face_bbox]
    face_w = max(1e-5, fx2 - fx1)
    face_h = max(1e-5, fy2 - fy1)
    anchor_data = stable_anchor or {}
    body_only = bool(anchor_data.get("bodyOnly"))
    body_height = max(0.0, float(anchor_data.get("bodyHeight", anchor_data.get("height", 0.0))))
    # A zoom target is calculated from complete, timestamped observations and
    # later zero-phase smoothed by the planner.  It is deliberately capped so
    # a tiny distant face does not trigger a destructive digital zoom.
    observed_face_h = face_h * base_scaled_h
    desired_face_h = out_h * 0.28
    zoom = 1.0
    if allow_zoom and observed_face_h > 1.0 and not body_only:
        zoom = max(1.0, min(MAX_DYNAMIC_ZOOM, desired_face_h / observed_face_h))
    scaled_w = max(out_w, int(round(base_scaled_w * zoom)))
    scaled_h = max(out_h, int(round(base_scaled_h * zoom)))
    # Eye/upper-face weighted anchor: avoids following mouth movement while
    # preserving natural headroom and the familiar upper-third composition.
    anchor_x = float(anchor_data.get("x", (fx1 + fx2) * 0.5))
    eye_line_y = float(anchor_data.get("eyeLineY", anchor_data.get("y", fy1 + face_h * 0.38)))
    target_x = anchor_x * scaled_w - out_w * 0.5
    target_y = eye_line_y * scaled_h - out_h * PREFERRED_FACE_Y
    target_y -= face_h * scaled_h * HEADROOM_FRAC * 0.10
    target_x = float(min(max(0.0, target_x), max(0, scaled_w - out_w)))
    target_y = float(min(max(0.0, target_y), max(0, scaled_h - out_h)))
    return target_x, target_y, scaled_w, scaled_h, {
        "x": round(anchor_x, 5),
        "y": round(eye_line_y, 5),
        "width": round(float(anchor_data.get("width", face_w)), 5),
        "height": round(float(anchor_data.get("height", face_h)), 5),
        "eyeLineY": round(eye_line_y, 5),
        "foreheadY": round(float(anchor_data.get("foreheadY", fy1)), 5),
        "chinY": round(float(anchor_data.get("chinY", fy2)), 5),
        "yaw": round(float(anchor_data.get("yaw", 0.0)), 5),
        "bodyOnly": body_only,
        "bodyHeight": round(body_height, 5),
        "zoom": round(zoom, 5),
        "baseScaledWidth": base_scaled_w,
        "baseScaledHeight": base_scaled_h,
    }


def _centred_smooth(values: Sequence[float], radius: int = 2) -> np.ndarray:
    """Small zero-phase reflected smoothing window with no historical lag."""
    source = np.asarray(values, dtype=np.float64)
    if len(source) <= 2 or radius <= 0:
        return source.copy()
    padded = np.pad(source, (radius, radius), mode="edge")
    kernel = np.ones(radius * 2 + 1, dtype=np.float64) / float(radius * 2 + 1)
    return np.convolve(padded, kernel, mode="valid")


def _limit_cinematic_motion(
    values: np.ndarray,
    times: np.ndarray,
    max_velocity: float,
    max_acceleration: float,
) -> np.ndarray:
    """Apply a high ceiling on impossible pan jumps without causal lag.

    The target has already passed a centred (future-aware) filter.  This pass
    only prevents a single bad detector/flow frame from becoming a visible
    whip-pan.  It does not act as a heavy historical exponential smoother.
    """
    if len(values) <= 2:
        return values.copy()
    forward = np.empty_like(values)
    forward[0] = values[0]
    velocity = 0.0
    for index in range(1, len(values)):
        dt = max(1.0 / 120.0, float(times[index] - times[index - 1]))
        desired_velocity = float(np.clip((values[index] - forward[index - 1]) / dt, -max_velocity, max_velocity))
        delta_velocity = float(np.clip(desired_velocity - velocity, -max_acceleration * dt, max_acceleration * dt))
        velocity = float(np.clip(velocity + delta_velocity, -max_velocity, max_velocity))
        forward[index] = forward[index - 1] + velocity * dt
    # The input is already a centred, future-aware path.  This one-sided
    # constraint only activates for an implausibly large instantaneous jump;
    # returning its forward solution avoids moving the crop before frame zero.
    return forward


def _scene_ranges(samples: Sequence[Dict[str, Any]], scenes: Sequence[Dict[str, Any]]) -> List[Tuple[int, int]]:
    """Partition samples at hard cuts so no crop path crosses a scene cut."""
    if not samples:
        return []
    cuts = {0, len(samples)}
    for scene in scenes or []:
        end = int(scene.get("endMs") or round(float(scene.get("end") or 0.0) * 1000))
        if end <= 0:
            continue
        index = next((i for i, row in enumerate(samples) if int(row["timeMs"]) >= end), None)
        if index is not None:
            cuts.add(index)
    ordered = sorted(cuts)
    return [(ordered[i], ordered[i + 1]) for i in range(len(ordered) - 1) if ordered[i + 1] > ordered[i]]


def _optimise_crop_trajectory(
    samples: List[Dict[str, Any]],
    scenes: Sequence[Dict[str, Any]],
    mode: str,
    out_w: int,
    out_h: int,
) -> List[Dict[str, Any]]:
    """Build an offline crop trajectory with a comfort zone and predictive lead.

    Unlike exponential smoothing, this function sees future samples.  It uses a
    small symmetric filter per shot, so the visual path has no phase shift, then
    applies a comfort zone to suppress facial jitter without waiting for a large
    moving-average window.  The recorded diagnostics make delay measurable in
    cache artifacts and keep preview/export on the exact same stored path.
    """
    if not samples:
        return samples
    lead = PREDICTIVE_LEAD_S.get(mode, PREDICTIVE_LEAD_S["smooth"])
    for begin, finish in _scene_ranges(samples, scenes):
        rows = samples[begin:finish]
        if not rows:
            continue
        times = np.asarray([float(row["timeMs"]) / 1000.0 for row in rows], dtype=np.float64)
        # Position and scale have different dynamics.  Position can react to
        # meaningful movement promptly; zoom intentionally has a slower,
        # zero-phase path so face-box noise never produces a breathing frame.
        has_recorded_zoom = any("rawZoom" in row or "zoom" in (row.get("headAnchor") or {}) for row in rows)
        raw_zoom = np.asarray([float(row.get("rawZoom", row.get("headAnchor", {}).get("zoom", 1.0))) for row in rows], dtype=np.float64)
        raw_zoom = np.clip(raw_zoom, 1.0, MAX_DYNAMIC_ZOOM)
        smooth_zoom = _centred_smooth(raw_zoom, radius=4)
        stable_zoom = np.empty_like(smooth_zoom)
        stable_zoom[0] = smooth_zoom[0]
        for index in range(1, len(rows)):
            if abs(smooth_zoom[index] - stable_zoom[index - 1]) < ZOOM_CHANGE_THRESHOLD:
                stable_zoom[index] = stable_zoom[index - 1]
            else:
                # Symmetric source data already removed phase lag.  This blend
                # merely limits zoom velocity at the visible transition.
                stable_zoom[index] = stable_zoom[index - 1] * 0.35 + smooth_zoom[index] * 0.65
        raw_x_values: List[float] = []
        raw_y_values: List[float] = []
        for index, row in enumerate(rows):
            anchor = row.get("headAnchor") or {}
            base_w = float(anchor.get("baseScaledWidth") or max(1, row.get("scaledWidth", out_w)))
            base_h = float(anchor.get("baseScaledHeight") or max(1, row.get("scaledHeight", out_h)))
            zoom = float(stable_zoom[index])
            scaled_w = max(out_w, int(round(base_w * zoom)))
            scaled_h = max(out_h, int(round(base_h * zoom)))
            anchor_x = float(anchor.get("x", 0.5))
            eye_line_y = float(anchor.get("eyeLineY", anchor.get("y", 0.38)))
            if has_recorded_zoom:
                raw_x_values.append(float(min(max(0.0, anchor_x * scaled_w - out_w * 0.5), max(0, scaled_w - out_w))))
                raw_y_values.append(float(min(max(0.0, eye_line_y * scaled_h - out_h * PREFERRED_FACE_Y), max(0, scaled_h - out_h))))
            else:
                # Compatibility for external/debug callers that supply only
                # precomputed raw targets, not the complete landmark path.
                raw_x_values.append(float(row.get("rawTargetX", row.get("x", 0.0))))
                raw_y_values.append(float(row.get("rawTargetY", row.get("y", 0.0))))
            row["zoom"] = round(zoom, 5)
            row["scaledWidth"] = scaled_w
            row["scaledHeight"] = scaled_h
        raw_x = np.asarray(raw_x_values, dtype=np.float64)
        raw_y = np.asarray(raw_y_values, dtype=np.float64)
        if len(rows) > 1:
            velocity_x = np.gradient(raw_x, times, edge_order=1)
            velocity_y = np.gradient(raw_y, times, edge_order=1)
        else:
            velocity_x = np.zeros(len(rows))
            velocity_y = np.zeros(len(rows))
        confidence = np.asarray([float(row.get("confidence", 0.0)) for row in rows], dtype=np.float64)
        # Predict only where a confident track is visible.  Missing samples keep
        # their prior prediction and are explicitly marked in diagnostics.
        lead_weight = np.clip((confidence - 0.45) / 0.45, 0.0, 1.0)
        predictive_x = raw_x + velocity_x * lead * lead_weight
        predictive_y = raw_y + velocity_y * lead * lead_weight

        comfort_x = np.empty_like(predictive_x)
        comfort_y = np.empty_like(predictive_y)
        comfort_x[0], comfort_y[0] = predictive_x[0], predictive_y[0]
        start_x, stop_x = out_w * COMFORT_ZONE_X, out_w * COMFORT_ZONE_X * COMFORT_STOP_RATIO
        start_y, stop_y = out_h * COMFORT_ZONE_Y, out_h * COMFORT_ZONE_Y * COMFORT_STOP_RATIO
        for index in range(1, len(rows)):
            dx, dy = predictive_x[index] - comfort_x[index - 1], predictive_y[index] - comfort_y[index - 1]
            comfort_x[index] = predictive_x[index] if abs(dx) > start_x else comfort_x[index - 1]
            comfort_y[index] = predictive_y[index] if abs(dy) > start_y else comfort_y[index - 1]
            # Hysteresis avoids an oscillating start/stop motion when a head sits
            # beside the boundary.  The smaller stop zone retains the movement
            # until the subject is safely composed again.
            if abs(predictive_x[index] - comfort_x[index]) < stop_x:
                comfort_x[index] = comfort_x[index]
            if abs(predictive_y[index] - comfort_y[index]) < stop_y:
                comfort_y[index] = comfort_y[index]

        smooth_x = _centred_smooth(comfort_x, radius=2)
        smooth_y = _centred_smooth(comfort_y, radius=2)
        # When a target exits the comfort zone, favour the immediate target so
        # fast movement never looks like the crop is chasing the speaker.
        moved_x = np.abs(predictive_x - np.r_[comfort_x[0], comfort_x[:-1]]) > start_x
        moved_y = np.abs(predictive_y - np.r_[comfort_y[0], comfort_y[:-1]]) > start_y
        smooth_x = np.where(moved_x, predictive_x * 0.72 + smooth_x * 0.28, smooth_x)
        smooth_y = np.where(moved_y, predictive_y * 0.72 + smooth_y * 0.28, smooth_y)
        # These limits are generous enough to respond within one source frame
        # once a subject leaves the comfort zone, while rejecting isolated
        # detector spikes that would look like a crop snap.
        smooth_x = _limit_cinematic_motion(smooth_x, times, max_velocity=out_w * 1.45, max_acceleration=out_w * 9.0)
        smooth_y = _limit_cinematic_motion(smooth_y, times, max_velocity=out_h * 1.10, max_acceleration=out_h * 7.5)

        for index, row in enumerate(rows):
            max_x = max(0, int(row["scaledWidth"]) - int(row["width"]))
            max_y = max(0, int(row["scaledHeight"]) - int(row["height"]))
            row["x"] = int(round(float(min(max(0.0, smooth_x[index]), max_x))))
            row["y"] = int(round(float(min(max(0.0, smooth_y[index]), max_y))))
            row["velocityX"] = round(float(velocity_x[index]), 4)
            row["velocityY"] = round(float(velocity_y[index]), 4)
            row["rawHeadX"] = row["headAnchor"]["x"]
            row["rawHeadY"] = row["headAnchor"]["y"]
            # The output path is explicitly per source/output frame.  Keep
            # the smoothed anchor alongside crop pixels so debug tools can
            # distinguish detector input from the offline virtual-camera plan.
            row["smoothedAnchorX"] = round(float((row["x"] + int(row["width"]) * 0.5) / max(1, int(row["scaledWidth"]))), 6)
            row["smoothedAnchorY"] = round(float((row["y"] + int(row["height"]) * PREFERRED_FACE_Y) / max(1, int(row["scaledHeight"]))), 6)
            row.setdefault("frameIndex", begin + index)
            row.setdefault("ptsMs", row.get("timeMs", 0))
            row["targetX"] = round(float(predictive_x[index]), 3)
            row["targetY"] = round(float(predictive_y[index]), 3)
            row["cropCenterX"] = round(float(row["x"] + int(row["width"]) / 2.0), 3)
            row["cropCenterY"] = round(float(row["y"] + int(row["height"]) * PREFERRED_FACE_Y), 3)
            row["smoothingMode"] = "offline-zero-phase"
            row["estimatedDelayFrames"] = 0
            row["trajectoryVersion"] = TRAJECTORY_VERSION
    return samples


def _lock_initial_composition(samples: Sequence[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Choose one early, confident subject composition and hold it.

    The user-facing ``Locked Crop`` mode should still frame the person instead
    of blindly using the mathematical centre of the source.  We therefore use
    the first short stable detection window to choose a composition once, then
    return a single keyframe.  FFmpeg receives no subsequent crop commands,
    so neither the video nor the subtitle layer can drift during the clip.
    """
    if not samples:
        return []
    first_time = int(samples[0].get("timeMs") or 0)
    early_detected = [
        row for row in samples
        if int(row.get("timeMs") or 0) <= first_time + 800
        and row.get("source") in {"face", "face_body", "body", "optical_flow"}
        and float(row.get("confidence") or 0.0) >= 0.55
    ]
    candidates = early_detected or [
        row for row in samples
        if row.get("source") in {"face", "face_body", "body", "optical_flow", "prediction"}
        and float(row.get("confidence") or 0.0) >= 0.35
    ] or list(samples[:1])
    reference = dict(candidates[len(candidates) // 2])
    reference["timeMs"] = 0
    reference["source"] = "locked-composition"
    reference["holding"] = False
    reference["velocityX"] = 0.0
    reference["velocityY"] = 0.0
    reference["smoothingMode"] = "locked-initial-composition"
    reference["estimatedDelayFrames"] = 0
    reference["trajectoryVersion"] = TRAJECTORY_VERSION
    return [reference]


def _cache_key(
    source: str,
    start: float,
    duration: float,
    mode: str,
    selected: Optional[str],
    out_w: int,
    out_h: int,
    scene_mode: str = "strict",
    source_fps: Optional[float] = None,
) -> str:
    payload = f"{source}|{start:.3f}|{duration:.3f}|{mode}|{selected or ''}|{out_w}x{out_h}|{scene_mode}|{source_fps or 0:.3f}|{TRAJECTORY_VERSION}"
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
    source_fps: Optional[float] = None,
    tracking_quality: str = "balanced",
) -> Dict[str, Any]:
    """Stream per-frame face/body observations with adaptive landmark refresh.

    Face and pose landmark inference is the costly part.  Quality exports run
    landmark refreshes on every decoded frame.  Balanced mode uses every frame
    while movement is meaningful and at most every second frame when still;
    low-power uses every second frame and validated LK on intervening frames.
    This produces one fresh crop coordinate per output frame without retaining
    the video in memory.
    """
    caps = capability_report()
    backend = "mediapipe-face-pose+lk-flow" if caps["mediapipeTasks"] else "motion-heuristic"
    work_dir = tempfile.mkdtemp(prefix="clyra-face-", dir=cache_root)
    detector = pose_detector = None
    iou_tracker = SimpleIoUTracker(max_missing=max(1, int(MAX_MISSING_MS / 1000.0 * max(1.0, float(fps)))))
    track_stats: Dict[str, Dict[str, Any]] = {}
    face_tracks: List[Dict[str, Any]] = []
    last_mouth_by_track: Dict[str, Tuple[float, float]] = {}
    previous_gray: Optional[np.ndarray] = None
    previous_boxes: List[List[float]] = []
    last_detection_index = -10_000
    last_motion = 0.0
    frames: List[Tuple[float, str]] = []
    proxy_w = proxy_h = None

    try:
        if caps["mediapipeTasks"]:
            try:
                detector = _mediapipe_landmarker(os.path.join(cache_root, "models"))
                pose_detector = _mediapipe_pose_landmarker(os.path.join(cache_root, "models"))
            except Exception:
                # Face tracking is still useful if the optional pose task model
                # is unavailable; never make a complete clip fail because a
                # body fallback cannot initialise.
                if detector is None:
                    backend = "motion-heuristic"
                else:
                    backend = "mediapipe-face+lk-flow"
                pose_detector = None

        frames = _extract_proxy_frames(
            ffmpeg,
            source,
            start,
            duration,
            work_dir,
            height=height,
            fps=fps,
            source_fps=source_fps,
        )
        if frames:
            first_rgb = _load_rgb(frames[0][1])
            proxy_h, proxy_w = first_rgb.shape[:2]
            del first_rgb

        if thumb_dir:
            os.makedirs(thumb_dir, exist_ok=True)

        for frame_index, (time_s, path) in enumerate(frames):
            rgb = _load_rgb(path)
            try:
                import cv2

                gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
            except Exception:
                gray = np.mean(rgb, axis=2).astype(np.uint8)
            flow_dx, flow_dy, flow_confidence, flow_points, flow_meta = _optical_flow_delta(previous_gray, gray, previous_boxes)
            flow_motion = math.hypot(flow_dx, flow_dy)
            # Do not let an incidental detector interval create stale camera
            # coordinates.  Quality is every decoded frame; balanced becomes
            # every frame as soon as motion/flow is uncertain, otherwise every
            # second frame; low-power is every second frame with FB-validated
            # LK propagation in between.
            if tracking_quality in {"high_quality", "gpu"}:
                adaptive_stride = 1
            elif tracking_quality == "low_memory":
                adaptive_stride = 2
            else:
                adaptive_stride = 1 if flow_motion > 0.006 or last_motion > 0.006 else 2
            should_detect = (
                frame_index == 0
                or not iou_tracker.tracks
                or frame_index - last_detection_index >= adaptive_stride
                or (previous_gray is not None and (flow_confidence < 0.25 or bool(flow_meta.get("redetectRecommended"))))
            )
            tracked: List[Dict[str, Any]] = []
            frame_source = "optical-flow"
            if should_detect and detector is not None:
                try:
                    # VIDEO mode receives monotonically increasing media time,
                    # never worker completion time or React animation time.
                    detections = _detect_mediapipe(detector, rgb, int(round(time_s * 1000)))
                    bodies = _detect_pose_mediapipe(pose_detector, rgb, int(round(time_s * 1000))) if pose_detector is not None else []
                    detections = _attach_bodies_to_faces(detections, bodies)
                    if not detections and bodies:
                        detections = _body_only_detections(bodies)
                    if not detections:
                        detections = _profile_face_fallback(rgb)
                        if detections:
                            backend = "mediapipe-tasks+opencv-profile"
                    if not detections:
                        # Gameplay, stylised characters and profile/occlusion
                        # ranges do not always expose a human face or pose.
                        # Use a conservative upper-body motion region so the
                        # per-frame LK tracker can still follow sustained
                        # on-screen movement; it remains lower confidence than
                        # a real face/pose and never replaces a locked identity.
                        detections, _ = _motion_heuristic_detect(previous_gray, gray)
                        for item in detections:
                            item.setdefault("stableAnchor", _robust_anchor([], item["bbox"]))
                            item["detector"] = "motion-saliency"
                        if detections:
                            backend = "mediapipe-face-pose+motion-saliency"
                except Exception:
                    detections, _ = _motion_heuristic_detect(previous_gray, gray)
                    backend = "motion-heuristic"
                detections = _augment_detections_with_hist(rgb, detections)
                tracked = iou_tracker.update(detections)
                last_detection_index = frame_index
                frame_source = "detected"
            else:
                tracked = iou_tracker.propagate_optical_flow(flow_dx, flow_dy, flow_confidence)
                if not tracked:
                    # Mark a detector miss only after flow could not maintain
                    # the prior identity. This gives short occlusions a chance
                    # to recover without silently adopting another face.
                    iou_tracker.update([])
                    frame_source = "predicted"

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
                        "bodySamples": [],
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
                    "stableAnchor": item.get("stableAnchor"),
                    "bodyBox": item.get("bodyBox"),
                    "bodyAnchor": item.get("bodyAnchor"),
                    "detector": item.get("detector", frame_source),
                    "flowConfidence": round(float(item.get("flowConfidence", flow_confidence)), 4),
                    "flowPoints": int(flow_points),
                    "flowValidRatio": float(flow_meta.get("validRatio", 0.0)),
                    "flowForwardBackwardErrorPx": flow_meta.get("forwardBackwardErrorPx"),
                    "cameraMotion": flow_meta.get("cameraMotion"),
                }
                mouth_open = item.get("mouthOpen", (item.get("stableAnchor") or {}).get("mouthOpen", 0.0))
                try:
                    mouth_open = max(0.0, min(1.0, float(mouth_open)))
                except (TypeError, ValueError):
                    mouth_open = 0.0
                prior_mouth = last_mouth_by_track.get(tid)
                if prior_mouth is None:
                    mouth_motion = 0.0
                else:
                    elapsed = max(1.0 / max(fps, 1.0), float(time_s) - prior_mouth[0])
                    # Normalised mouth-aperture velocity.  Values are bounded
                    # for the active-speaker state machine, not exposed as a
                    # fabricated probability of speech.
                    mouth_motion = min(1.0, abs(mouth_open - prior_mouth[1]) / elapsed * 0.12)
                last_mouth_by_track[tid] = (float(time_s), mouth_open)
                sample["mouthOpen"] = round(mouth_open, 5)
                sample["mouthMotion"] = round(mouth_motion, 5)
                if len(stats["bboxSamples"]) < 24:
                    stats["bboxSamples"].append(sample)
                if sample.get("bodyBox") and len(stats["bodySamples"]) < 24:
                    stats["bodySamples"].append(sample)
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
                        "stableAnchor": sample["stableAnchor"],
                        "mouthOpen": sample["mouthOpen"],
                        "mouthMotion": sample["mouthMotion"],
                        "hist": hist,
                        "bodyBox": sample.get("bodyBox"),
                        "bodyAnchor": sample.get("bodyAnchor"),
                        "detector": sample.get("detector"),
                        "flowConfidence": sample.get("flowConfidence", 0.0),
                        "flowPoints": sample.get("flowPoints", 0),
                        "flowValidRatio": sample.get("flowValidRatio", 0.0),
                        "flowForwardBackwardErrorPx": sample.get("flowForwardBackwardErrorPx"),
                        "cameraMotion": sample.get("cameraMotion"),
                    }
                )

            face_tracks.append({
                "timeMs": int(round(time_s * 1000)),
                "time": round(time_s, 3),
                "source": frame_source,
                "flow": {
                    "dx": round(flow_dx, 6),
                    "dy": round(flow_dy, 6),
                    "confidence": round(flow_confidence, 4),
                    "points": int(flow_points),
                    "validRatio": flow_meta.get("validRatio", 0.0),
                    "forwardBackwardErrorPx": flow_meta.get("forwardBackwardErrorPx"),
                    "cameraMotion": flow_meta.get("cameraMotion"),
                    "redetectRecommended": bool(flow_meta.get("redetectRecommended")),
                },
                "faces": [{k: v for k, v in row.items() if k != "hist"} for row in frame_rows],
            })
            previous_gray = gray
            previous_boxes = [list(item.get("bodyBox") or item.get("bbox")) for item in tracked if item.get("bbox")]
            last_motion = flow_motion
            del rgb

        for landmarker in (detector, pose_detector):
            if landmarker is not None:
                try:
                    landmarker.close()
                except Exception:
                    pass
        detector = pose_detector = None
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
        "proxy": {
            "height": height,
            "fps": fps,
            "sourceFps": source_fps,
            "widthHint": proxy_w,
            "heightHint": proxy_h,
            "trackingPath": "per-frame-face-pose-lk-flow",
        },
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
        duration = 90.0
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
    audio_evidence: Optional[Dict[str, Any]] = None,
    audio_offset_ms: int = 0,
    reframe_mode: str = "auto",
    speaker_mode: str = "auto",
    tracking_quality: str = "balanced",
    split_screen_requested: bool = False,
    source_fps: Optional[float] = None,
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
    reframe_mode = normalise_reframe_mode(reframe_mode)
    tracking_quality = normalise_tracking_quality(tracking_quality)
    try:
        source_fps = float(source_fps) if source_fps is not None else None
    except (TypeError, ValueError):
        source_fps = None
    analysis_fps = analysis_fps_for_quality(tracking_quality, source_fps)
    speaker_mode = str(speaker_mode or "auto").strip().lower()
    if speaker_mode not in {"auto", "locked", "active"}:
        speaker_mode = "auto"
    _ = scene_rules  # thresholds exposed via face_tracking_config; presence uses scene_mode
    caps = capability_report()
    frame_w = int(frame_w or out_w)
    frame_h = int(frame_h or out_h)

    # Resolve selected person vs legacy track id.
    if selected_person_id is None and selected_track_id and str(selected_track_id).startswith("person_"):
        selected_person_id = selected_track_id

    if mode == "off" or reframe_mode in {"centre", "disabled"}:
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
                "reframeMode": reframe_mode,
                "speakerMode": speaker_mode,
                "trackingQuality": tracking_quality,
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
    composition_locked = reframe_mode == "locked_subject"
    effective_allow_zoom = bool(allow_zoom) and not composition_locked
    cache_subject = f"{selected_key or ''}|{reframe_mode}|{speaker_mode}|{tracking_quality}|zoom-{int(effective_allow_zoom)}"
    key = _cache_key(source, clip_start, clip_duration, mode, cache_subject, out_w, out_h, scene_mode, source_fps)
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

    # _crop_from_face is only retained below to maintain legacy hold bookkeeping;
    # its output is replaced by _optimise_crop_trajectory.  Keep it stateless so
    # no historical exponential lag can leak into the final stored path.
    alpha = 1.0
    resolved_thumb_dir = thumb_dir or os.path.join(job_dir, "thumbs")
    os.makedirs(resolved_thumb_dir, exist_ok=True)
    analysis = _analyse_proxy_stream(
        ffmpeg,
        source,
        clip_start,
        clip_duration,
        cache_root,
        height=PROXY_HEIGHT,
        fps=analysis_fps,
        thumb_dir=resolved_thumb_dir,
        source_fps=source_fps,
        tracking_quality=tracking_quality,
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

    # Manual selection is a hard identity lock.  Automatic mode deliberately
    # does not preselect `people[0]`: that old largest-face shortcut is what
    # caused interview clips to frame the wrong person.
    if selected_person_id is None and selected_track_id:
        selected_person_id = track_to_person.get(selected_track_id)
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
    last_stable_anchor: Optional[Dict[str, Any]] = None
    last_seen_t: Optional[float] = None
    holding = False
    manual_lock = bool(selected_person_id or selected_track_id) or speaker_mode == "locked"
    auto_state: Dict[str, Any] = {}
    primary_auto_person: Optional[str] = None
    primary_auto_track: Optional[str] = None
    primary_track_missing_since: Optional[float] = None
    active_switches: List[Dict[str, Any]] = []

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
                    "allowZoom": effective_allow_zoom,
                    "reframeMode": reframe_mode,
                    "speakerMode": speaker_mode,
                    "trackingQuality": tracking_quality,
                    "splitScreenRequested": bool(split_screen_requested),
                    "splitScreenApplied": False,
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
            active_speaker_score = None
            scene_type = classify_tracking_scene(tracked)
            if selected_person_id:
                chosen = next((item for item in tracked if item.get("personId") == selected_person_id), None)
                # Secondary: selected legacy track belonging to that person.
                if chosen is None and selected_track_id:
                    chosen = next((item for item in tracked if item.get("trackId") == selected_track_id), None)
            elif selected_track_id:
                chosen = next((item for item in tracked if item.get("trackId") == selected_track_id), None)
            elif reframe_mode != "keep_all":
                audio_energy = _audio_energy_at(audio_evidence, t_ms, audio_offset_ms)
                active_choice, next_state = choose_active_speaker(
                    tracked,
                    auto_state,
                    t_ms,
                    audio_energy,
                )
                previous_active = auto_state.get("activeId")
                auto_state = next_state
                if active_choice is not None:
                    if reframe_mode == "single_speaker":
                        if primary_auto_person is None:
                            primary_auto_person = str(active_choice.get("personId") or active_choice.get("trackId"))
                        # Lock the actual track as well as the clustered person
                        # identity.  A face/pose hand-off may briefly emit a
                        # second rectangle for the same person. Holding the
                        # prior crop for up to one occlusion window is safer
                        # than switching to that rectangle for a single frame.
                        if primary_auto_track is None:
                            primary_auto_track = str(active_choice.get("trackId") or "") or None
                        preferred_track = next(
                            (item for item in tracked if str(item.get("trackId") or "") == str(primary_auto_track or "")),
                            None,
                        )
                        if preferred_track is not None:
                            chosen = preferred_track
                            primary_track_missing_since = None
                        else:
                            if primary_track_missing_since is None:
                                primary_track_missing_since = time_s
                            same_person = next(
                                (item for item in tracked if str(item.get("personId") or item.get("trackId")) == primary_auto_person),
                                None,
                            )
                            if same_person is not None and time_s - primary_track_missing_since >= MISSING_HOLD_S:
                                chosen = same_person
                                primary_auto_track = str(same_person.get("trackId") or "") or primary_auto_track
                                primary_track_missing_since = None
                            else:
                                # The missing branch below emits a predicted / held
                                # crop for this short hand-off rather than treating
                                # it as a valid identity switch.
                                chosen = None
                    else:
                        chosen = active_choice
                    if chosen is not None:
                        active_speaker_score = chosen.get("activeSpeakerScore")
                        current_active = str(chosen.get("personId") or chosen.get("trackId"))
                        if previous_active and current_active != previous_active and auto_state.get("lastSwitchMs") == t_ms:
                            active_switches.append({"timeMs": t_ms, "from": previous_active, "to": current_active})

            if chosen is not None:
                sample_source = "optical_flow" if chosen.get("detector") == "optical-flow" else "face"
                last_face_bbox = list(chosen["bbox"])
                # Use the measured eye line for composition, but blend in
                # shoulders/torso to retain framing through turns and bends.
                # This one anchor is used by both preview and final render.
                last_stable_anchor = _fuse_subject_anchor(
                    chosen.get("stableAnchor"),
                    chosen.get("bodyAnchor"),
                    last_face_bbox,
                )
                if sample_source != "optical_flow":
                    sample_source = str(last_stable_anchor.get("anchorSource") or "face")
                last_seen_t = time_s
                holding = False
                presence_times.append(time_s)
                x, y, scaled_w, scaled_h, prev_x, prev_y = _crop_from_face(
                    chosen["bbox"], frame_w, frame_h, out_w, out_h, effective_allow_zoom, prev_x, prev_y, alpha
                )
                confidence = float(chosen.get("confidence", 0.6))
                face_box = _bbox_obj(chosen["bbox"])
                face_center = {"x": _face_center(chosen["bbox"])[0], "y": _face_center(chosen["bbox"])[1]}
                track_id = chosen.get("trackId") or selected_track_id
                person_id = chosen.get("personId") or selected_person_id
            else:
                # Selected-person lock: never jump to largest other face.
                active_person_id = selected_person_id or primary_auto_person or auto_state.get("activeId")
                briefly_missing = (
                    active_person_id is not None
                    and last_seen_t is not None
                    and (time_s - last_seen_t) < MISSING_HOLD_S
                    and last_face_bbox is not None
                    and prev_x is not None
                )
                long_hold = (
                    active_person_id is not None
                    and last_face_bbox is not None
                    and prev_x is not None
                )
                if briefly_missing or long_hold:
                    holding = True
                    sample_source = "prediction" if briefly_missing else "fallback"
                    # HOLD previous crop coordinates exactly — no chase to other faces.
                    x = int(round(prev_x))
                    y = int(round(prev_y))
                    scale = max(out_w / max(1, frame_w), out_h / max(1, frame_h))
                    scaled_w = max(out_w, int(round(frame_w * scale)))
                    scaled_h = max(out_h, int(round(frame_h * scale)))
                    confidence = 0.35 if briefly_missing else 0.2
                    face_box = _bbox_obj(last_face_bbox)
                    face_center = {"x": _face_center(last_face_bbox)[0], "y": _face_center(last_face_bbox)[1]}
                    track_id = selected_track_id or primary_auto_track
                    person_id = active_person_id
                else:
                    sample_source = "fallback"
                    x, y, scaled_w, scaled_h, prev_x, prev_y = _crop_from_face(
                        last_face_bbox or [0.35, 0.15, 0.65, 0.55],
                        frame_w,
                        frame_h,
                        out_w,
                        out_h,
                        effective_allow_zoom,
                        prev_x,
                        prev_y,
                        alpha,
                    )
                    confidence = 0.15
                    fallback_box = last_face_bbox or [0.35, 0.15, 0.65, 0.55]
                    face_box = _bbox_obj(fallback_box)
                    face_center = {"x": _face_center(fallback_box)[0], "y": _face_center(fallback_box)[1]}
                    track_id = selected_track_id or primary_auto_track
                    person_id = active_person_id

            raw_bbox = last_face_bbox or [0.35, 0.15, 0.65, 0.55]
            raw_x, raw_y, raw_scaled_w, raw_scaled_h, head_anchor = _raw_crop_target(
                raw_bbox,
                frame_w,
                frame_h,
                out_w,
                out_h,
                stable_anchor=last_stable_anchor,
                allow_zoom=effective_allow_zoom,
            )
            samples.append(
                {
                    "frameIndex": len(samples),
                    "timeMs": t_ms,
                    "ptsMs": t_ms,
                    # These initial positions are replaced by the offline
                    # optimiser after every timestamp has been observed.
                    "x": int(round(raw_x)),
                    "y": int(round(raw_y)),
                    "width": out_w,
                    "height": out_h,
                    "confidence": round(confidence, 3),
                    "scaledWidth": raw_scaled_w,
                    "scaledHeight": raw_scaled_h,
                    "rawTargetX": round(raw_x, 3),
                    "rawTargetY": round(raw_y, 3),
                    "rawZoom": round(float(head_anchor.get("zoom", 1.0)), 5),
                    "rawAnchorX": round(float(head_anchor.get("x", 0.5)), 5),
                    "rawAnchorY": round(float(head_anchor.get("eyeLineY", head_anchor.get("y", 0.38))), 5),
                    "headAnchor": head_anchor,
                    "trackId": track_id,
                    "personId": person_id,
                    "faceBox": face_box,
                    "faceCenter": face_center,
                    "activeSpeakerTrackId": auto_state.get("activeId") if not manual_lock else (person_id or track_id),
                    "activeSpeakerScore": round(float(active_speaker_score or 0.0), 4),
                    "sceneType": scene_type,
                    "bodyBox": chosen.get("bodyBox") if chosen is not None else None,
                    "bodyAnchor": chosen.get("bodyAnchor") if chosen is not None else None,
                    "flow": {
                        "confidence": round(float(chosen.get("flowConfidence", 0.0)), 4) if chosen is not None else 0.0,
                        "validRatio": round(float(chosen.get("flowValidRatio", 0.0)), 4) if chosen is not None else 0.0,
                        "forwardBackwardErrorPx": chosen.get("flowForwardBackwardErrorPx") if chosen is not None else None,
                        "cameraMotion": chosen.get("cameraMotion") if chosen is not None else None,
                    },
                    "holding": holding,
                    "source": sample_source,
                }
            )
    finally:
        shutil.rmtree(analysis["work_dir"], ignore_errors=True)

    if not samples:
        samples = [_fixed_crop_keyframe(0, frame_w, frame_h, out_w, out_h, crop_focus)]

    samples = _optimise_crop_trajectory(samples, scenes, mode, out_w, out_h)
    if composition_locked:
        samples = _lock_initial_composition(samples)

    # A crop coordinate exists for every decoded output frame.  The old
    # sparsifier converted otherwise smooth motion into stale 250ms steps.
    # Keeping these tiny numeric keyframes on disk is comfortably below the 8GB
    # budget for a selected clip and makes preview/export use the identical path.
    keyframes = list(samples)
    if keyframes[0]["timeMs"] != 0:
        zero = dict(keyframes[0])
        zero["timeMs"] = 0
        keyframes.insert(0, zero)

    locked_subject_id = keyframes[0].get("personId") if composition_locked and keyframes else None
    selected_for_scene = selected_person_id or primary_auto_person or locked_subject_id
    annotated_scenes = annotate_scenes(scenes, presence_times, scene_mode, selected_for_scene, analysis_fps=analysis_fps)
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
        "personId": selected_for_scene,
        "id": selected_for_scene,
        "trackId": selected_track_id,
        "sceneMode": scene_mode,
        "personMode": scene_mode,
        "referenceFrames": [],
        "faceEmbeddings": [],
        "averageEmbedding": [],
        "thumbnailPath": next((p.get("thumbnailPath") or "" for p in available if p["id"] == selected_for_scene), ""),
        "presenceSeconds": round(len(presence_times) / max(analysis_fps, 0.1), 2),
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
            "activeSpeakerPersonId": locked_subject_id or auto_state.get("activeId") or primary_auto_person,
            "reframeMode": reframe_mode,
            "speakerMode": speaker_mode,
            "trackingQuality": tracking_quality,
            "splitScreenRequested": bool(split_screen_requested),
            "splitScreenApplied": False,
            "sceneMode": scene_mode,
            "personMode": scene_mode,
            "allowZoom": effective_allow_zoom,
            "backend": backend,
            "trajectoryMode": "locked-initial-composition" if composition_locked else "offline-zero-phase",
            "trajectoryVersion": TRAJECTORY_VERSION,
            "sampleRate": analysis_fps,
            "cropPathCadence": "per-output-frame",
            "frameIntervalMs": round(1000.0 / max(analysis_fps, 1.0), 3),
            "pathSampleCount": len(keyframes),
            "predictiveLeadMs": 0 if composition_locked else int(round(PREDICTIVE_LEAD_S.get(mode, 0.0) * 1000)),
            "comfortZone": {"x": COMFORT_ZONE_X, "y": COMFORT_ZONE_Y},
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
        "activeSpeakerSwitches": active_switches,
        "trackingDiagnostics": [
            {
                "frameIndex": row.get("frameIndex"),
                "timeMs": row["timeMs"],
                "ptsMs": row.get("ptsMs", row["timeMs"]),
                "rawHeadX": row.get("rawHeadX"),
                "rawHeadY": row.get("rawHeadY"),
                "rawAnchorX": row.get("rawAnchorX"),
                "rawAnchorY": row.get("rawAnchorY"),
                "smoothedAnchorX": row.get("smoothedAnchorX"),
                "smoothedAnchorY": row.get("smoothedAnchorY"),
                "rawTargetX": row.get("rawTargetX"),
                "rawTargetY": row.get("rawTargetY"),
                "targetX": row.get("targetX"),
                "targetY": row.get("targetY"),
                "cropX": row.get("x"),
                "cropY": row.get("y"),
                "velocityX": row.get("velocityX", 0.0),
                "velocityY": row.get("velocityY", 0.0),
                "zoom": row.get("zoom", 1.0),
                "trackId": row.get("trackId"),
                "personId": row.get("personId"),
                "activeSpeakerTrackId": row.get("activeSpeakerTrackId"),
                "activeSpeakerScore": row.get("activeSpeakerScore", 0.0),
                "sceneType": row.get("sceneType", "unknown"),
                "confidence": row.get("confidence"),
                "holding": row.get("holding", False),
                "source": row.get("source", "detected"),
                "bodyBox": row.get("bodyBox"),
                "bodyAnchor": row.get("bodyAnchor"),
                "flow": row.get("flow"),
                "estimatedDelayFrames": row.get("estimatedDelayFrames", 0),
                "smoothingMode": row.get("smoothingMode", "offline-zero-phase"),
            }
            for row in samples
        ],
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
            "tracking-diagnostics.json": payload.get("trackingDiagnostics") or [],
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
    """Write a timestamped crop-path artifact for diagnostics/legacy consumers."""
    lines = []
    for kf in keyframes:
        t = max(0.0, float(kf.get("timeMs", 0)) / 1000.0)
        x = int(kf.get("x", 0))
        y = int(kf.get("y", 0))
        # 6 decimal places preserves distinct 60fps frame timestamps (16.667ms)
        # instead of collapsing adjacent camera positions into a 1ms grid.
        lines.append(f"{t:.6f} crop x {x};")
        lines.append(f"{t:.6f} crop y {y};")
    with open(path, "w", encoding="utf-8") as handle:
        handle.write("\n".join(lines) + "\n")
    return path


def _escape_filter_path(path: str) -> str:
    # FFmpeg filtergraph path escaping for sendcmd=f=...
    return path.replace("\\", "/").replace(":", "\\:").replace("'", "\\'")


def _zoom_expression(keyframes: Sequence[Dict[str, Any]]) -> Optional[str]:
    """Return a bounded, piecewise-linear FFmpeg expression for crop zoom.

    FFmpeg's crop filter accepts live x/y commands but not reliable dynamic
    output dimensions across builds.  The scale filter *does* support per-frame
    expressions, so we scale by the recorded zoom and update crop x/y from the
    same timestamped keyframes.  Compression of nearly identical zoom points
    keeps the expression small for long clips.
    """
    points: List[Tuple[float, float]] = []
    last_t = -1.0
    last_zoom = 1.0
    for row in keyframes:
        try:
            time_s = max(0.0, float(row.get("timeMs", 0)) / 1000.0)
            zoom = max(1.0, min(MAX_DYNAMIC_ZOOM, float(row.get("zoom", 1.0))))
        except (TypeError, ValueError):
            continue
        if points and time_s - last_t < 0.22 and abs(zoom - last_zoom) < 0.015:
            continue
        points.append((time_s, zoom))
        last_t, last_zoom = time_s, zoom
    if len(points) < 2 or max(abs(zoom - 1.0) for _, zoom in points) < 0.012:
        return None
    # A pathological detection stream should not produce an enormous filter
    # graph.  Retain evenly distributed change points; x/y remain at the full
    # keyframe density through sendcmd.
    if len(points) > 160:
        stride = max(1, int(math.ceil(len(points) / 160.0)))
        points = points[::stride]
        if points[-1][0] < last_t:
            points.append((last_t, last_zoom))
    expression = f"{points[-1][1]:.5f}"
    for index in range(len(points) - 2, -1, -1):
        start_t, start_zoom = points[index]
        end_t, end_zoom = points[index + 1]
        duration = max(0.001, end_t - start_t)
        linear = f"({start_zoom:.5f}+({end_zoom - start_zoom:.5f})*(t-{start_t:.3f})/{duration:.3f})"
        expression = f"if(lt(t,{end_t:.3f}),{linear},{expression})"
    return expression


def build_crop_filter(
    out_w: int,
    out_h: int,
    keyframes: Optional[Sequence[Dict[str, Any]]] = None,
    crop_focus: str = "center",
    sendcmd_path: Optional[str] = None,
) -> str:
    """Return the legacy FFmpeg crop filter.

    The production master renderer consumes animated paths through its bounded
    per-frame crop stage.  FFmpeg's crop filter cannot accept live ``x``/``y``
    commands and its expression parser has a shallow nesting limit, so this
    helper intentionally remains a deterministic static fallback for legacy
    plate-only callers.  It still records the path as a diagnostic artifact.
    """
    if keyframes and len(keyframes) >= 1 and sendcmd_path:
        # Preserve a human-readable command timeline for diagnostics and
        # existing artifact consumers.  It is deliberately not used as the
        # renderer control channel: crop x/y are evaluated from the time path
        # below because crop does not implement live sendcmd updates.
        write_sendcmd(sendcmd_path, keyframes)
        first = keyframes[0]
        x0 = int(first.get("x", 0))
        y0 = int(first.get("y", 0))
        return (
            f"scale={out_w}:{out_h}:flags=lanczos:force_original_aspect_ratio=increase,"
            f"crop={out_w}:{out_h}:{x0}:{y0},setsar=1"
        )
    crop_x = {"left": "0", "right": "iw-ow"}.get(crop_focus, "(iw-ow)/2")
    return (
        f"scale={out_w}:{out_h}:flags=lanczos:force_original_aspect_ratio=increase,"
        f"crop={out_w}:{out_h}:{crop_x}:(ih-oh)/2,setsar=1"
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
