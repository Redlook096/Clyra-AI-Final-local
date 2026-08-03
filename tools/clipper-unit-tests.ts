import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const probe = String.raw`
import importlib.util, json, os, pathlib, tempfile, sys

root = pathlib.Path(${JSON.stringify(root)})
spec = importlib.util.spec_from_file_location("clipper_pipeline", root / "clipper-pipeline.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

intel_spec = importlib.util.spec_from_file_location("clipper_intelligence", root / "clipper_intelligence.py")
intelligence = importlib.util.module_from_spec(intel_spec)
intel_spec.loader.exec_module(intelligence)

import clipper_video_understanding as video_understanding

words = []
for index in range(360):
    start = index * 0.62
    token = "REVEAL" if index % 27 == 0 else f"WORD{index % 41}"
    words.append({"word": token, "start": start, "end": start + 0.48})

candidates = module.choose_moments(
    words,
    video_duration=240.0,
    moment_type="viral",
    target_duration=30.0,
    count=5,
    url="https://example.com/video",
)

semantic_words = [
    {"word": "Here", "start": 0.0, "end": 0.2},
    {"word": "is", "start": 0.21, "end": 0.35},
    {"word": "the", "start": 0.36, "end": 0.5},
    {"word": "complete", "start": 0.51, "end": 0.78},
    {"word": "answer.", "start": 0.79, "end": 1.04},
    {"word": "This", "start": 2.0, "end": 2.18},
    {"word": "is", "start": 2.19, "end": 2.33},
    {"word": "the", "start": 2.34, "end": 2.46},
    {"word": "payoff!", "start": 2.47, "end": 2.75},
    {"word": "We", "start": 3.2, "end": 3.35},
    {"word": "tried", "start": 3.36, "end": 3.55},
    {"word": "because", "start": 3.56, "end": 3.9},
    {"word": "Next", "start": 4.4, "end": 4.55},
    {"word": "sentence", "start": 4.56, "end": 4.9},
    {"word": "lands.", "start": 4.91, "end": 5.2},
]
sentences = module.sentence_boundaries(semantic_words)
semantic = module.semantic_candidates(semantic_words, 12, "viral", 15, 2)
unpunctuated_words = [
    {"word": "REVEAL" if index % 23 == 0 else f"token{index}", "start": index * 0.55, "end": index * 0.55 + 0.4}
    for index in range(160)
]
unpunctuated_semantic = module.semantic_candidates(unpunctuated_words, 88, "viral", 15, 3)
regions = module.speech_regions(semantic_words)

broken = {
    "id": "candidate-x",
    "start": 3.2,
    "end": 3.9,
    "transcript": "We tried because",
}
repaired = module.repair_clip_boundaries(broken, sentences, 12.0, 15.0)
scored = module.local_clip_score({"start": 0.0, "end": 2.75, "transcript": "Here is the complete answer. This is the payoff!"}, "viral")
scored_bad = module.local_clip_score({"start": 3.2, "end": 3.9, "transcript": "We tried because"}, "viral")

overlap_pool = [
    {"id": "a", "start": 0.0, "end": 10.0, "score": 90, "transcript": "alpha"},
    {"id": "b", "start": 2.0, "end": 12.0, "score": 80, "transcript": "beta"},
    {"id": "c", "start": 20.0, "end": 30.0, "score": 70, "transcript": "gamma"},
]
deduped = module.dedupe_by_overlap(overlap_pool, max_overlap=0.42, limit=3)
edit_plan = module.build_edit_plan([
    {"id": "candidate-1", "start": 1.0, "end": 8.0, "score": 88, "reason": "88 — Strong hook", "title": "Hook"},
])
shots = module.detect_shot_boundaries("/tmp/does-not-exist.mp4")
clamped = module.clamp_candidate_duration({"start": 100.0, "end": 250.0, "transcript": "x"}, 30, 1000)
minimum_extended = module.enforce_minimum_candidate_duration({"start": 80.0, "end": 88.0, "transcript": "hook"}, 240.0)
minimum_source_limited = module.enforce_minimum_candidate_duration({"start": 2.0, "end": 5.0, "transcript": "short source"}, 17.0)

import clipper_face_tracking as face
face_cfg = face.face_tracking_config({"face_tracking": {"mode": "smooth", "allowZoom": True, "personMode": "strict", "selectedPersonId": "person_001"}})
face_flex = face.face_tracking_config({"face_tracking": {"mode": "smooth", "sceneMode": "flexible"}})
face_off = face.face_tracking_config({"face_tracking_mode": "off"})
face_off_false_string = face.face_tracking_config({"face_tracking": {"mode": "off", "smartReframe": "false"}})
face_disabled = face.face_tracking_config({"face_tracking": {"mode": "responsive", "enabled": "false"}})
face_auto = face.face_tracking_config({"face_tracking": {"mode": "responsive", "reframeMode": "auto", "trackingQuality": "balanced", "speakerMode": "auto"}})
face_low_power = face.face_tracking_config({"face_tracking": {"mode": "smooth", "trackingQuality": "low_power"}})
face_locked = face.face_tracking_config({"face_tracking": {"mode": "smooth", "reframeMode": "locked_subject", "allowZoom": True}})
caps = face.capability_report()
fixed = face.track_faces_and_build_crops(
    "ffmpeg",
    "/tmp/does-not-exist.mp4",
    0.0,
    2.0,
    720,
    1280,
    mode="off",
    crop_focus="center",
)
crop_filter = face.build_crop_filter(720, 1280, keyframes=None, crop_focus="center")
zoom_commands = tempfile.NamedTemporaryFile(prefix="clyra-zoom-", suffix=".sendcmd", delete=False)
zoom_commands.close()
zoom_filter = face.build_crop_filter(720, 1280, keyframes=[
    {"timeMs": 0, "x": 10, "y": 20, "zoom": 1.0},
    {"timeMs": 900, "x": 90, "y": 44, "zoom": 1.22},
], sendcmd_path=zoom_commands.name)
alpha_smooth = face.smoothing_alpha("smooth")
alpha_fast = face.smoothing_alpha("responsive")
scene_ok = face.evaluate_scene(
    [
        {"matched": True, "identityConfidence": 0.9, "faceWidth": 0.12, "timeMs": 0, "personId": "person_001"},
        {"matched": True, "identityConfidence": 0.88, "faceWidth": 0.11, "timeMs": 250, "personId": "person_001"},
        {"matched": True, "identityConfidence": 0.86, "faceWidth": 0.1, "timeMs": 500, "personId": "person_001"},
    ],
    person_mode="strict",
    scene_id="scene_001",
    start_ms=0,
    end_ms=500,
)
scene_bad = face.evaluate_scene(
    [
        {"matched": False, "identityConfidence": 0.2, "faceWidth": 0.01, "timeMs": 0},
        {"matched": False, "identityConfidence": 0.1, "faceWidth": 0.01, "timeMs": 250},
    ],
    person_mode="strict",
    scene_id="scene_002",
    start_ms=0,
    end_ms=250,
)
filtered = face.filter_candidates_by_scenes(
    [{"id": "a", "start": 0.0, "end": 8.0}, {"id": "b", "start": 40.0, "end": 48.0}],
    [{"accepted": True, "start": 0.0, "end": 10.0, "startMs": 0, "endMs": 10000}],
)
hist = face._appearance_hist.__doc__ is not None

# A deterministic fast move verifies the new offline path does not retain the
# old causal-filter trail.  The final crop must respond on the boundary sample,
# remain still for tiny jitter, and reset cleanly at a shot cut.
trajectory_samples = []
for index, raw_x in enumerate([100, 102, 101, 103, 105, 340, 342, 344, 346, 348]):
    trajectory_samples.append({
        "timeMs": index * 42,
        "rawTargetX": raw_x,
        "rawTargetY": 0,
        "x": raw_x,
        "y": 0,
        "width": 720,
        "height": 1280,
        "scaledWidth": 1800,
        "scaledHeight": 1280,
        "headAnchor": {"x": 0.5, "y": 0.38},
        "confidence": 0.95,
        "trackId": "face_01",
    })
trajectory = face._optimise_crop_trajectory(trajectory_samples, [{"startMs": 0, "endMs": 210}, {"startMs": 210, "endMs": 420}], "responsive", 720, 1280)
locked_trajectory = face._lock_initial_composition([
    {**row, "source": "detected", "confidence": 0.9}
    for row in trajectory
])
smart_reframe = face.build_smart_reframe_keyframes({
    "faceTracking": {"enabled": True, "mode": "smooth"},
    "cropKeyframes": [
        {"timeMs": 0, "x": 90, "y": 0, "width": 720, "height": 1280, "scaledWidth": 1800, "scaledHeight": 1280, "zoom": 1.0, "activeSpeakerTrackId": "person_001", "source": "detected"},
        {"timeMs": 500, "x": 620, "y": 0, "width": 720, "height": 1280, "scaledWidth": 1800, "scaledHeight": 1280, "zoom": 1.18, "activeSpeakerTrackId": "person_001", "source": "detected"},
        {"timeMs": 1100, "x": 620, "y": 0, "width": 720, "height": 1280, "scaledWidth": 1800, "scaledHeight": 1280, "zoom": 1.08, "activeSpeakerTrackId": "person_002", "source": "detected"},
    ],
})

# Active speaker selection must resist a brief challenger, then deliberately
# switch only after sustained mouth motion backed by non-silent audio.
speaker_state = {}
speaker_first, speaker_state = face.choose_active_speaker([
    {"trackId": "face_01", "personId": "person_001", "confidence": 0.92, "mouthMotion": 0.42, "mouthOpen": 0.05},
], speaker_state, 0, 0.9)
speaker_brief, speaker_state = face.choose_active_speaker([
    {"trackId": "face_01", "personId": "person_001", "confidence": 0.92, "mouthMotion": 0.05, "mouthOpen": 0.02},
    {"trackId": "face_02", "personId": "person_002", "confidence": 0.91, "mouthMotion": 0.95, "mouthOpen": 0.08},
], speaker_state, 250, 0.95)
speaker_switched, speaker_state = face.choose_active_speaker([
    {"trackId": "face_01", "personId": "person_001", "confidence": 0.92, "mouthMotion": 0.05, "mouthOpen": 0.02},
    {"trackId": "face_02", "personId": "person_002", "confidence": 0.91, "mouthMotion": 0.95, "mouthOpen": 0.08},
], speaker_state, 1000, 0.95)

# The lightweight fallback must retain an id through brief profile-detector
# misses and refuse to attach an obviously different-looking face to that id.
fallback_tracker = face.SimpleIoUTracker(max_missing=4)
same_hist = face.np.array([1.0, 0.0], dtype=face.np.float32)
different_hist = face.np.array([0.0, 1.0], dtype=face.np.float32)
first_track = fallback_tracker.update([{
    "bbox": [0.40, 0.18, 0.58, 0.48], "confidence": 0.58,
    "hist": same_hist, "stableAnchor": {"x": 0.49, "y": 0.31},
}])[0]["trackId"]
flow_tracks = [
    {key: value for key, value in row.items() if key in {"trackId", "bbox", "detector", "flowConfidence"}}
    for row in fallback_tracker.propagate_optical_flow(0.028, -0.012, 0.93)
]
fallback_tracker.update([])
fallback_tracker.update([])
reacquired_track = fallback_tracker.update([{
    "bbox": [0.45, 0.19, 0.63, 0.49], "confidence": 0.58,
    "hist": same_hist, "stableAnchor": {"x": 0.54, "y": 0.32},
}])[0]["trackId"]
incompatible_tracks = fallback_tracker.update([{
    "bbox": [0.46, 0.19, 0.64, 0.49], "confidence": 0.58,
    "hist": different_hist, "stableAnchor": {"x": 0.55, "y": 0.32},
}])
fallback_track_ids = [item["trackId"] for item in incompatible_tracks]

timeline = intelligence.build_timeline_knowledge_graph(
    8,
    semantic_words,
    audio_evidence={
        "available": True,
        "coverageEndMs": 8000,
        "seconds": [
            {"second": index, "energy": 0.92 if 2 <= index <= 3 else 0.08, "silence": not (2 <= index <= 3)}
            for index in range(8)
        ],
    },
    visual_evidence={
        "available": True,
        "coverageEndMs": 8000,
        "samples": [
            {"timeMs": index * 1000, "motion": 0.88 if 2 <= index <= 3 else 0.03, "sceneChange": 0.76 if index == 2 else 0.02, "sharpness": 0.8, "brightness": 0.5, "visualImportance": 0.93 if 2 <= index <= 3 else 0.07}
            for index in range(8)
        ],
        "events": [{"type": "scene_change", "timeMs": 2000, "confidence": 0.76}],
    },
    ocr_evidence={
        "available": True,
        "coverageEndMs": 3000,
        "samples": [{"timeMs": 2000, "text": "PRICING REVEAL", "confidence": 0.91}],
    },
)
timeline_enriched = intelligence.enrich_candidates_with_timeline([
    {"id": "visual", "start": 2.0, "end": 4.0, "score": 50, "reason": "Transcript candidate", "score_source": "local"},
    {"id": "quiet", "start": 5.0, "end": 7.0, "score": 50, "reason": "Transcript candidate", "score_source": "local"},
], timeline)
intel_caps = intelligence.capability_report("/definitely/not/ffmpeg")
cache_valid_full = module.intelligence_cache_valid(
    {"schemaVersion": intelligence.INTELLIGENCE_SCHEMA_VERSION, "available": True, "coverageEndMs": 9_200},
    intelligence.INTELLIGENCE_SCHEMA_VERSION,
    minimum_coverage_ms=10_000,
)
cache_valid_short = module.intelligence_cache_valid(
    {"schemaVersion": intelligence.INTELLIGENCE_SCHEMA_VERSION, "available": True, "coverageEndMs": 7_500},
    intelligence.INTELLIGENCE_SCHEMA_VERSION,
    minimum_coverage_ms=10_000,
)
cache_valid_unavailable = module.intelligence_cache_valid(
    {"schemaVersion": intelligence.INTELLIGENCE_SCHEMA_VERSION, "available": False, "coverageEndMs": 0},
    intelligence.INTELLIGENCE_SCHEMA_VERSION,
    minimum_coverage_ms=10_000,
)
analysis_coverage = module.analysis_coverage_ms(7_200, 1_800)
cancel_is_base_exception = issubclass(module.PipelineCancelled, KeyboardInterrupt) and not issubclass(module.PipelineCancelled, Exception)
range_none = module.resolve_source_range({}, 120.0, 30.0)
range_explicit = module.resolve_source_range({"source_start_seconds": 42.125, "source_duration_seconds": 20}, 120.0, 30.0)
range_camel = module.resolve_source_range({"sourceStartSeconds": 112, "sourceDurationSeconds": 30}, 120.0, 30.0)
range_default = module.resolve_source_range({"source_start_seconds": 90}, 120.0, 18.0)
range_rebased_words = module.rebase_words_to_source_range(
    [
        {"word": "Before", "start": 40.0, "end": 41.0},
        {"word": "Target", "start": 42.125, "end": 42.5},
        {"word": "After", "start": 44.0, "end": 44.4},
    ],
    42.125,
    45.0,
)
range_candidate = module.user_directed_candidate(range_rebased_words, 2.875, 15.0)
method_words = [
    {"word": "Here", "start": 0.0, "end": 0.2}, {"word": "is", "start": 0.21, "end": 0.34},
    {"word": "the", "start": 0.35, "end": 0.46}, {"word": "third", "start": 0.47, "end": 0.72},
    {"word": "method", "start": 0.73, "end": 1.0}, {"word": "to", "start": 1.01, "end": 1.1},
    {"word": "make", "start": 1.11, "end": 1.29}, {"word": "money.", "start": 1.30, "end": 1.60},
    {"word": "Use", "start": 2.0, "end": 2.2}, {"word": "this", "start": 2.21, "end": 2.4},
    {"word": "complete", "start": 2.41, "end": 2.7}, {"word": "system.", "start": 2.71, "end": 3.0},
    {"word": "The", "start": 10.0, "end": 10.15}, {"word": "fourth", "start": 10.16, "end": 10.42},
    {"word": "method", "start": 10.43, "end": 10.7}, {"word": "starts", "start": 10.71, "end": 11.0}, {"word": "now.", "start": 11.01, "end": 11.2},
]
directed_method = module.query_directed_candidates(method_words, 20, "Clip the whole section of the 3rd method to make money", 30, 1)
premium_encoding = module.render_encoding_args("premium")
master_encoding = module.render_encoding_args("master")
source_fill_landscape = module.source_needs_full_frame_fill({"width": 1280, "height": 720, "displayAspectRatio": 16 / 9})
source_fill_portrait_sar = module.source_needs_full_frame_fill({"width": 640, "height": 360, "displayAspectRatio": 9 / 16})
zoo_transition = module.visual_transition_spec("Find when they leave the zoo")
zoo_verification = module.verify_visual_transition_candidate(
    {"start": 10.0, "end": 35.0, "transcript": "They say they are leaving"}, timeline, zoo_transition
)
ordinary_verification = module.verify_visual_transition_candidate(
    {"start": 10.0, "end": 35.0}, timeline, module.visual_transition_spec("Find a funny moment")
)
visual_windows = intelligence.retrieve_visual_candidate_windows(timeline, 8, 3, limit=6)
with tempfile.TemporaryDirectory() as provider_dir:
    provider_root = pathlib.Path(provider_dir)
    fake_source = provider_root / "source.mp4"
    fake_source.write_bytes(b"not-decoded-by-protocol-test")
    fake_runner = provider_root / "runner.py"
    fake_runner.write_text(
        "import json, sys\n"
        "json.loads(sys.stdin.read())\n"
        "print(json.dumps({'available': True, 'verdict': {"
        "'event_present': True, 'before_state_verified': True, 'transition_verified': True, "
        "'after_state_verified': True, 'visual_evidence': ['subject crosses the marked exit'], "
        "'audio_evidence': [], 'ocr_evidence': [], 'constraintsSatisfied': ['before/during/after'], "
        "'warnings': [], 'confidence': 0.91}}))\n",
        encoding="utf-8",
    )
    provider_env = {
        "CLYRA_VIDEO_UNDERSTANDING_ENABLED": "1",
        "CLYRA_VIDEO_UNDERSTANDING_RUNNER": str(fake_runner),
        "CLYRA_VIDEO_UNDERSTANDING_PYTHON": sys.executable,
        "CLYRA_VIDEO_UNDERSTANDING_UPSTREAM_INSTALLED": "1",
        "CLYRA_VIDEO_UNDERSTANDING_MIN_RAM_GB": "1",
        "CLYRA_VIDEO_UNDERSTANDING_MIN_DISK_GB": "1",
    }
    provider_8gb = video_understanding.capability_report(
        "8gb_cpu", environ=provider_env, physical_memory_gb=8, free_disk_gb=100
    )
    provider_deep = video_understanding.capability_report(
        "deep_verification", environ=provider_env, physical_memory_gb=32, free_disk_gb=48
    )
    provider_verified = video_understanding.verify_event_candidate(
        {"originalQuery": "Find when the person leaves", "requires": {"visual": True}},
        {"start": 1.0, "end": 3.0},
        source_path=str(fake_source),
        resource_profile="deep_verification",
        environ=provider_env,
        physical_memory_gb=32,
        free_disk_gb=48,
    )
    previous_provider_env = {key: os.environ.get(key) for key in provider_env}
    os.environ.update(provider_env)
    try:
        integrated_provider_verified = intelligence.verify_event_candidate(
            {"originalQuery": "Find when the person leaves", "requires": {"visual": True}},
            {"start": 1.0, "end": 3.0},
            {"segments": []},
            source_path=str(fake_source),
            resource_profile="deep_verification",
        )
    finally:
        for key, previous in previous_provider_env.items():
            if previous is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = previous
provider_malformed = video_understanding.normalise_temporal_verdict({"event_present": True})
range_errors = []
for config in (
    {"source_start_seconds": -1, "source_duration_seconds": 10},
    {"source_start_seconds": 120, "source_duration_seconds": 10},
    {"source_start_seconds": 10, "source_duration_seconds": 0},
    {"source_start_seconds": 118, "source_duration_seconds": 10},
    {"source_start_seconds": "NaN", "source_duration_seconds": 10},
):
    try:
        module.resolve_source_range(config, 120.0, 30.0)
    except ValueError as exc:
        range_errors.append(str(exc))
with tempfile.TemporaryDirectory() as temporary_dir:
    artifact_path = pathlib.Path(temporary_dir) / "artifact.json"
    module.write_json(artifact_path, {"complete": True})
    atomic_artifact = json.loads(artifact_path.read_text())
    atomic_staging_leftovers = list(pathlib.Path(temporary_dir).glob("*.tmp"))
    phrase_path = pathlib.Path(temporary_dir) / "phrase.ass"
    phrase_caption_count = module.write_subtitles(
        phrase_path,
        semantic_words,
        0.0,
        6.0,
        "Arial",
        56,
        "#FFFFFF",
        "bottom",
        "phrase-highlight",
    )
    phrase_captions = phrase_path.read_text()
    phrase_beats = module.phrase_highlight_beats(semantic_words, 0.0, 6.0)
    _, custom_position_override = module.subtitle_override("bottom", 38, 71)

print(json.dumps({
    "candidates": candidates,
    "shortDuration": module.parse_duration(2),
    "longDuration": module.parse_duration(999),
    "cleanName": module.clean_name("  My Clip: Final!?  "),
    "customKeywords": sorted(module.keyword_set("laughing falls")),
    "sentences": [{"start": s["start"], "end": s["end"], "text": s["text"]} for s in sentences],
    "semantic": semantic,
    "unpunctuatedSemantic": unpunctuated_semantic,
    "regions": regions,
    "repaired": repaired,
    "scored": scored,
    "scoredBad": scored_bad,
    "deduped": deduped,
    "editPlan": edit_plan,
    "shots": shots,
    "clamped": clamped,
    "minimumExtended": minimum_extended,
    "minimumSourceLimited": minimum_source_limited,
    "endsConnective": module.ends_on_connective("We tried because"),
    "endsClean": module.ends_on_connective("This is the payoff!"),
    "faceCfg": face_cfg,
    "faceFlex": face_flex,
    "faceAuto": face_auto,
    "faceLowPower": face_low_power,
    "faceLocked": face_locked,
    "faceOff": face_off,
    "faceOffFalseString": face_off_false_string,
    "faceDisabled": face_disabled,
    "faceCaps": caps,
    "faceFixed": fixed,
    "cropFilter": crop_filter,
    "zoomFilter": zoom_filter,
    "alphaSmooth": alpha_smooth,
    "alphaFast": alpha_fast,
    "sceneOk": scene_ok,
    "sceneBad": scene_bad,
    "filtered": filtered,
    "hasAppearanceHist": hist,
    "trajectory": trajectory,
    "lockedTrajectory": locked_trajectory,
    "smartReframe": smart_reframe,
    "speakerFirst": speaker_first,
    "speakerBrief": speaker_brief,
    "speakerSwitched": speaker_switched,
    "firstFallbackTrack": first_track,
    "flowTracks": flow_tracks,
    "reacquiredFallbackTrack": reacquired_track,
    "incompatibleFallbackTrackIds": fallback_track_ids,
    "timeline": timeline,
    "timelineEnriched": timeline_enriched,
    "intelligenceCaps": intel_caps,
    "cacheValidFull": cache_valid_full,
    "cacheValidShort": cache_valid_short,
    "cacheValidUnavailable": cache_valid_unavailable,
    "analysisCoverage": analysis_coverage,
    "cancelIsBaseException": cancel_is_base_exception,
    "rangeNone": range_none,
    "rangeExplicit": range_explicit,
    "rangeCamel": range_camel,
    "rangeDefault": range_default,
    "rangeRebasedWords": range_rebased_words,
    "rangeCandidate": range_candidate,
    "directedMethod": directed_method,
    "premiumEncoding": premium_encoding,
    "masterEncoding": master_encoding,
    "sourceFillLandscape": source_fill_landscape,
    "sourceFillPortraitSar": source_fill_portrait_sar,
    "zooTransition": zoo_transition,
    "zooVerification": zoo_verification,
    "ordinaryVerification": ordinary_verification,
    "visualWindows": visual_windows,
    "provider8Gb": provider_8gb,
    "providerDeep": provider_deep,
    "providerVerified": provider_verified,
    "integratedProviderVerified": integrated_provider_verified,
    "providerMalformed": provider_malformed,
    "rangeErrors": range_errors,
    "atomicArtifact": atomic_artifact,
    "atomicStagingLeftovers": len(atomic_staging_leftovers),
    "phraseCaptionCount": phrase_caption_count,
    "phraseCaptions": phrase_captions,
    "phraseBeats": phrase_beats,
    "customPositionOverride": custom_position_override,
}))
`;

const output = execFileSync("python3", ["-c", probe], {
  cwd: root,
  encoding: "utf8",
});
const payload = JSON.parse(output.trim()) as {
  candidates: Array<{
    id: string;
    start: number;
    end: number;
    score: number;
    transcript: string;
  }>;
  shortDuration: number;
  longDuration: number;
  cleanName: string;
  customKeywords: string[];
  sentences: Array<{ start: number; end: number; text: string }>;
  semantic: Array<{ start: number; end: number; score: number; transcript: string; reason: string }>;
  regions: Array<{ startMs: number; endMs: number }>;
  repaired: { start: number; end: number; transcript: string; boundary_repaired?: boolean };
  scored: { score: number; reason: string };
  scoredBad: { score: number; reason: string };
  deduped: Array<{ id: string }>;
  editPlan: { clips: Array<{ score: number; faceTracking?: { mode?: string } }>; shotBoundaries: unknown[]; version?: number };
  shots: unknown[];
  clamped: { start: number; end: number; duration_clamped?: boolean };
  minimumExtended: { start: number; end: number; minimum_duration_extended?: boolean };
  minimumSourceLimited: { start: number; end: number; minimum_duration_extended?: boolean };
  endsConnective: boolean;
  endsClean: boolean;
  faceCfg: { enabled: boolean; mode: string; selectedPersonId?: string | null; personMode?: string; sceneMode?: string };
  faceFlex: { personMode?: string; sceneMode?: string };
  faceAuto: { reframeMode?: string; trackingQuality?: string; analysisFps?: number; speakerMode?: string };
  faceLowPower: { trackingQuality?: string; analysisFps?: number };
  faceLocked: { reframeMode?: string; enabled?: boolean; allowZoom?: boolean };
  faceOff: { enabled: boolean; mode: string; smartReframe?: boolean };
  faceOffFalseString: { enabled: boolean; mode: string; smartReframe?: boolean };
  faceDisabled: { enabled: boolean; mode: string };
  faceCaps: { mediapipeTasks: boolean; fallback: string | null; poseLandmarker?: boolean; opencvOpticalFlow?: boolean };
  faceFixed: { faceTracking: { mode: string }; cropKeyframes: Array<{ width: number; height: number }> };
  cropFilter: string;
  zoomFilter: string;
  alphaSmooth: number;
  alphaFast: number;
  sceneOk: { accepted: boolean; selectedPersonCoverage: number };
  sceneBad: { accepted: boolean };
  filtered: Array<{ id: string }>;
  hasAppearanceHist: boolean;
  trajectory: Array<{ x: number; velocityX: number; estimatedDelayFrames: number; smoothingMode: string; trajectoryVersion: string }>;
  lockedTrajectory: Array<{ timeMs: number; source: string; velocityX: number; velocityY: number; smoothingMode: string; trajectoryVersion: string }>;
  smartReframe: { faceTracking: { enabled: boolean; smartReframe: boolean; trajectoryMode: string; allowZoom: boolean }; cropKeyframes: Array<{ timeMs: number; x: number; zoom: number; activeSpeakerTrackId?: string }> };
  speakerFirst: { personId?: string } | null;
  speakerBrief: { personId?: string } | null;
  speakerSwitched: { personId?: string } | null;
  firstFallbackTrack: string;
  flowTracks: Array<{ trackId: string; bbox: number[]; detector?: string; flowConfidence?: number }>;
  reacquiredFallbackTrack: string;
  incompatibleFallbackTrackIds: string[];
  timeline: {
    schemaVersion: string;
    segments: Array<{
      second: number;
      audio: { available: boolean; energy: number | null };
      visual: { available: boolean; importance: number | null };
      ocr: { text: string };
      scores: { importance: number };
    }>;
    events: Array<{ type: string; modality: string }>;
  };
  timelineEnriched: Array<{
    id: string;
    score: number;
    score_source: string;
    multimodal_evidence?: { visualScore: number | null; audioScore: number | null; evidenceSeconds: number };
  }>;
  intelligenceCaps: { ffmpeg: boolean; adaptiveVisualSampling: boolean };
  cacheValidFull: boolean;
  cacheValidShort: boolean;
  cacheValidUnavailable: boolean;
  analysisCoverage: number;
  cancelIsBaseException: boolean;
  rangeNone: null;
  rangeExplicit: { startSeconds: number; endSeconds: number; durationSeconds: number; clamped: boolean; mode: string };
  rangeCamel: { startSeconds: number; endSeconds: number; durationSeconds: number; clamped: boolean };
  rangeDefault: { startSeconds: number; endSeconds: number; durationSeconds: number };
  rangeRebasedWords: Array<{ word: string; start: number; end: number }>;
  rangeCandidate: { start: number; end: number; user_directed: boolean; transcript: string };
  directedMethod: Array<{ start: number; end: number; query_directed?: boolean; section_ordinal?: number; transcript: string }>;
  premiumEncoding: string[];
  masterEncoding: string[];
  sourceFillLandscape: boolean;
  sourceFillPortraitSar: boolean;
  zooTransition: { requiresVisualProof: boolean; before?: string; after?: string };
  zooVerification: { exactMatch: boolean; reason?: string; warnings: string[] };
  ordinaryVerification: { exactMatch: boolean };
  visualWindows: Array<{ start: number; end: number; visual_retrieval?: { candidateOnly?: boolean } }>;
  provider8Gb: { available: boolean; reason?: string; resourceGate: { minimumMemoryGb: number } };
  providerDeep: { available: boolean; provider: string; mode: string };
  providerVerified: { available: boolean; provider: string; verdict: { structured: boolean; event_present: boolean; after_state_verified: boolean } };
  integratedProviderVerified: { exactMatch: boolean; verificationLevel: string; reason?: string; visualEvidence?: string[] };
  providerMalformed: { structured: boolean; event_present: boolean; transition_verified: boolean };
  rangeErrors: string[];
  atomicArtifact: { complete: boolean };
  atomicStagingLeftovers: number;
  phraseCaptionCount: number;
  phraseCaptions: string;
  phraseBeats: Array<[number, number, string]>;
  customPositionOverride: string;
};

assert.equal(payload.candidates.length, 5, "returns requested candidate count");
assert.deepEqual(
  payload.candidates.map((candidate) => candidate.id),
  ["candidate-1", "candidate-2", "candidate-3", "candidate-4", "candidate-5"],
  "uses stable candidate ids",
);

for (const candidate of payload.candidates) {
  assert(candidate.start >= 0, "candidate begins inside source");
  assert(candidate.end <= 240, "candidate ends inside source");
  assert(candidate.end > candidate.start, "candidate has positive duration");
  assert(candidate.end - candidate.start <= 30.01, "candidate obeys target duration");
  assert(Number.isFinite(candidate.score), "candidate has a finite media score");
  assert(candidate.transcript.length > 0, "candidate includes transcript evidence");
}

for (let index = 0; index < payload.candidates.length; index += 1) {
  for (let other = index + 1; other < payload.candidates.length; other += 1) {
    const left = payload.candidates[index];
    const right = payload.candidates[other];
    const overlap = Math.max(0, Math.min(left.end, right.end) - Math.max(left.start, right.start));
    assert(overlap / 30 <= 0.43, "selected clips are meaningfully distinct");
  }
}

assert.equal(payload.shortDuration, 30, "automatic clips never default below 30 seconds");
assert.equal(payload.longDuration, 60, "maximum clip duration is enforced");
assert.equal(payload.cleanName, "my-clip-final", "output names are safely normalised");
assert(payload.customKeywords.includes("laugh"), "custom prompts receive semantic expansion");
assert(payload.customKeywords.includes("fell"), "multiple custom terms are expanded");

assert(payload.sentences.length >= 3, "sentence boundaries respect punctuation and pauses");
assert(payload.sentences[0].text.endsWith("answer."), "sentence keeps its complete ending");
assert(payload.sentences.some((sentence) => sentence.text.includes("because")), "connective sentence is preserved as evidence");

assert(payload.semantic.length >= 1, "semantic candidate generation returns a complete candidate");
assert(payload.semantic[0].start >= 0, "semantic candidate starts on a safe timestamp");
assert(payload.semantic[0].end <= 12, "semantic candidate stays inside source bounds");
assert(Number.isInteger(payload.semantic[0].score), "semantic candidate exposes an explainable score");
assert(payload.semantic[0].score >= 1 && payload.semantic[0].score <= 100, "clip potential stays on 0-100 scale");
assert(payload.semantic[0].reason.includes("—"), "semantic score includes a user-facing explanation");
assert(!/\b(and|but|because|so|then|with|to)$/i.test(payload.semantic[0].transcript.trim()), "semantic candidates avoid connective endings");
assert.equal(payload.unpunctuatedSemantic.length, 3, "unpunctuated captions still produce a diverse retrieval pool");
assert(new Set(payload.unpunctuatedSemantic.map((item) => item.start)).size >= 2, "unpunctuated retrieval does not collapse every autonomous candidate to the opening");
assert(payload.unpunctuatedSemantic.every((item) => item.end - item.start <= 30 * 1.08 + 0.05), "unpunctuated retrieval retains the 30-second-minimum automatic duration");

assert.equal(payload.regions.length >= 2, true, "speech regions preserve meaningful pauses");
assert.equal(payload.endsConnective, true, "detects trailing because/and endings");
assert.equal(payload.endsClean, false, "complete sentences are not flagged as connective");

assert(payload.repaired.boundary_repaired === true, "boundary repair marks repaired clips");
assert(payload.repaired.end > 3.9, "repair extends past a hanging because");
assert(!/\bbecause$/i.test(payload.repaired.transcript.trim()), "repair refuses to end on because");

assert(payload.clamped.end - payload.clamped.start <= 30 * 1.08 + 0.05, "hard clamp caps overlong candidates");
assert(payload.clamped.duration_clamped === true, "clamp marks duration_clamped");
assert.equal(payload.minimumExtended.end - payload.minimumExtended.start, 30, "automatic hooks expand into a complete 30-second scene plate");
assert.equal(payload.minimumExtended.minimum_duration_extended, true, "automatic duration extension is explained in candidate metadata");
assert.equal(payload.minimumSourceLimited.end - payload.minimumSourceLimited.start, 17, "short sources remain source-bounded rather than creating invalid media");

assert(payload.scored.score >= payload.scoredBad.score, "complete payoff scores at least as high as hanging connective");
assert(payload.scored.reason.includes("—"), "local score emits explanation");
assert(payload.scoredBad.reason.toLowerCase().includes("ending") || payload.scoredBad.score < 90, "weak ending is reflected in scoring");

assert.deepEqual(
  payload.deduped.map((item) => item.id),
  ["a", "c"],
  "overlap dedupe keeps the best non-overlapping clips",
);
assert.equal(payload.editPlan.clips.length, 1, "edit plan includes ranked clips");
assert.equal(payload.editPlan.clips[0].score, 88, "edit plan preserves clip potential score");
assert.ok((payload.editPlan.version || 0) >= 2, "edit plan preserves stable framing metadata");
assert.equal(payload.editPlan.clips[0].faceTracking?.mode, "off", "default edit plan keeps tracking off when none was requested");
assert.deepEqual(payload.shots, [], "missing PySceneDetect / video soft-fails to empty shot list");

assert.equal(payload.faceCfg.mode, "smooth", "requested smooth tracking mode reaches the worker");
assert.equal(payload.faceCfg.enabled, true, "requested tracking remains enabled until a scene-level safety fallback");
assert.equal(payload.faceCfg.selectedPersonId, "person_001", "selected person id is preserved");
assert.equal(payload.faceCfg.personMode || payload.faceCfg.sceneMode, "strict", "strict is the default person mode");
assert.equal(payload.faceFlex.personMode || payload.faceFlex.sceneMode, "flexible", "flexible scene mode is normalised");
assert.equal(payload.faceAuto.reframeMode, "auto", "auto reframe intent is preserved");
assert.equal(payload.faceAuto.speakerMode, "auto", "automatic speaker selection is explicit");
assert.equal(payload.faceAuto.analysisFps, 60, "balanced tracking plans a native per-frame 60fps-capable path");
assert.equal(payload.faceLowPower.trackingQuality, "low_memory", "low_power is a supported explicit 8 GB profile alias");
assert.equal(payload.faceLowPower.analysisFps, 30, "low-power profile has a bounded source-safe cadence");
assert.equal(payload.faceLocked.reframeMode, "locked_subject", "locked crop keeps a dedicated composition mode");
assert.equal(payload.faceLocked.enabled, true, "locked crop still uses face analysis to frame the person once");
assert.equal(payload.faceLocked.allowZoom, false, "locked crop never adds dynamic zoom after composition is set");
assert.equal(payload.faceOff.mode, "off", "off mode is normalised");
assert.equal(payload.faceOff.enabled, false, "off mode disables tracking");
assert.equal(payload.faceDisabled.enabled, false, "explicit disabled tracking is respected even through string JSON forms");
assert.equal(payload.faceFixed.faceTracking.mode, "off", "off tracking returns fixed crop plan");
assert.equal(payload.faceFixed.cropKeyframes[0].width, 720, "fixed crop matches output width");
assert.equal(payload.faceOff.enabled, false, "No Follow disables continuous face/body tracking");
assert.equal(payload.faceOff.smartReframe, true, "No Follow retains smart scene reframe decisions");
assert.equal(payload.faceOffFalseString.smartReframe, false, "string false disables smart reframe reliably");
assert(payload.cropFilter.includes("crop=720:1280"), "default crop filter covers vertical frame");
assert(payload.zoomFilter.includes("crop=720:1280:10:20"), "legacy plate filters retain the deterministic first crop while the master renderer evaluates the dense per-frame path");
assert(payload.alphaSmooth < payload.alphaFast, "smooth mode uses stronger smoothing than responsive");
assert.equal(typeof payload.faceCaps.mediapipeTasks, "boolean", "capability report exposes MediaPipe Tasks flag");
assert.equal(typeof payload.faceCaps.poseLandmarker, "boolean", "capability report exposes Pose Landmarker support");
assert.equal(typeof payload.faceCaps.opencvOpticalFlow, "boolean", "capability report exposes optical-flow support");
assert.equal(payload.sceneOk.accepted, true, "high-coverage selected-person scene is accepted");
assert.equal(payload.sceneBad.accepted, false, "empty selected-person scene is rejected");
assert.deepEqual(payload.filtered.map((item) => item.id), ["a"], "candidates outside accepted face scenes are filtered");
assert.equal(payload.hasAppearanceHist, true, "appearance histogram helper is available");
assert.equal(payload.trajectory[4]?.x, payload.trajectory[0]?.x, "comfort zone ignores small head jitter");
assert(payload.trajectory[5]?.x > 250, "offline trajectory responds at the first meaningful movement sample");
assert.equal(payload.trajectory[5]?.estimatedDelayFrames, 0, "offline path records zero historical delay");
assert.equal(payload.trajectory[5]?.smoothingMode, "offline-zero-phase", "trajectory declares the offline smoothing mode");
assert.equal(payload.trajectory[5]?.trajectoryVersion, "offline-cinematic-v10-face-body-fbflow-per-frame", "trajectory records the forward/backward-flow per-frame face/body path version");
assert.equal(payload.lockedTrajectory.length, 1, "locked composition emits one crop keyframe only");
assert.equal(payload.lockedTrajectory[0]?.timeMs, 0, "locked composition is applied from the first output frame");
assert.equal(payload.lockedTrajectory[0]?.source, "locked-composition", "locked composition records its non-moving source");
assert.equal(payload.lockedTrajectory[0]?.velocityX, 0, "locked composition has no horizontal camera motion");
assert.equal(payload.lockedTrajectory[0]?.velocityY, 0, "locked composition has no vertical camera motion");
assert.equal(payload.lockedTrajectory[0]?.smoothingMode, "locked-initial-composition", "locked composition is distinguishable from follow mode");
assert.equal(payload.smartReframe.faceTracking.enabled, false, "smart reframe never re-enables continuous following");
assert.equal(payload.smartReframe.faceTracking.smartReframe, true, "smart reframe labels the non-follow path");
assert.equal(payload.smartReframe.faceTracking.trajectoryMode, "snap-on-subject-exit-or-speaker-switch", "smart reframe documents its deliberate decision rule");
assert.equal(payload.smartReframe.faceTracking.allowZoom, false, "smart reframe holds zoom to avoid visible tracking motion");
assert(payload.smartReframe.cropKeyframes.length >= 3, "smart reframe emits hold/snap decisions for a verified subject exit or speaker change");
assert.equal(payload.smartReframe.cropKeyframes[1]?.timeMs, 499, "smart reframe holds the old composition until one millisecond before the decision");
assert(payload.smartReframe.cropKeyframes[2]?.x > payload.smartReframe.cropKeyframes[0]?.x, "smart reframe snaps to keep the subject in the safe composition");
assert.equal(payload.smartReframe.cropKeyframes[2]?.zoom, 1, "smart reframe suppresses zoom pumping");
assert.equal(payload.speakerFirst?.personId, "person_001", "active speaker starts from the visible subject");
assert.equal(payload.speakerBrief?.personId, "person_001", "a brief competing mouth movement does not whip-pan the crop");
assert.equal(payload.speakerSwitched?.personId, "person_002", "a sustained, audio-backed challenger becomes the active speaker");
assert.equal(payload.firstFallbackTrack, payload.reacquiredFallbackTrack, "profile fallback retains the same identity through brief detection loss");
assert.equal(payload.incompatibleFallbackTrackIds.includes(payload.firstFallbackTrack), false, "profile fallback does not merge a clearly different-looking face into the selected identity");
assert.equal(payload.flowTracks[0]?.trackId, payload.firstFallbackTrack, "optical-flow propagation preserves the same track id");
assert.equal(payload.flowTracks[0]?.detector, "optical-flow", "intermediate tracker frames are marked as optical flow");
assert((payload.flowTracks[0]?.bbox[0] || 0) > 0.42, "optical flow advances the tracked subject between detector frames");
assert.equal(payload.zooTransition.requiresVisualProof, true, "state-transition requests require visual verification");
assert.equal(payload.zooVerification.exactMatch, false, "transcript language alone cannot prove a zoo departure");
assert.equal(payload.zooVerification.reason, "visual_state_unverified", "unverified transitions expose an explicit safe reason");
assert.equal(payload.ordinaryVerification.exactMatch, true, "ordinary moment requests remain eligible for ranking");
assert(payload.visualWindows.length >= 2, "visual retrieval exposes diverse candidate windows when measured vision is available");
assert(payload.visualWindows.every((item) => item.end > item.start && item.visual_retrieval?.candidateOnly), "visual retrieval windows are explicitly candidate-only evidence");
assert.equal(payload.provider8Gb.available, false, "the upstream high-memory verifier cannot run in Clyra's 8 GB profile");
assert.equal(payload.provider8Gb.reason, "reserved_for_isolated_high_memory_verification_profile", "8 GB provider gate explains why the heavy verifier is unavailable");
assert.equal(payload.provider8Gb.resourceGate.minimumMemoryGb, 1, "test provider honours a supplied resource threshold without loading models");
assert.equal(payload.providerDeep.available, true, "a separately provisioned deep worker can be enabled without bundling upstream code");
assert.equal(payload.providerDeep.provider, "video-understanding-local", "deep worker reports its evidence provider");
assert.equal(payload.providerDeep.mode, "isolated-high-memory-worker", "deep worker is explicitly isolated from Electron");
assert.equal(payload.providerVerified.available, true, `Clyra accepts a structured isolated-worker protocol response: ${JSON.stringify(payload.providerVerified)}`);
assert.equal(payload.providerVerified.verdict.structured, true, "temporal proof requires every required boolean field");
assert.equal(payload.providerVerified.verdict.event_present, true, "structured worker results preserve event evidence");
assert.equal(payload.providerVerified.verdict.after_state_verified, true, "structured worker results preserve ending-state evidence");
assert.equal(payload.integratedProviderVerified.exactMatch, true, "Clyra's production verifier selects the configured video-understanding adapter");
assert.equal(payload.integratedProviderVerified.verificationLevel, "video-understanding-local", "the result records its real evidence provider");
assert.equal(payload.integratedProviderVerified.reason, "verified", "only an explicit before/during/after verdict is accepted as exact");
assert.equal(payload.integratedProviderVerified.visualEvidence?.[0], "subject crosses the marked exit", "production verification preserves provider evidence for review");
assert.equal(payload.providerMalformed.structured, false, "partial provider prose/data cannot become temporal proof");
assert.equal(payload.providerMalformed.event_present, false, "malformed evidence fails closed");
assert.equal(payload.providerMalformed.transition_verified, false, "malformed evidence cannot invent a transition");

assert.equal(payload.timeline.schemaVersion, "clyra.timeline-knowledge-graph.v1", "timeline uses a durable schema version");
assert.equal(payload.timeline.segments.length, 8, "timeline has one deterministic row per second");
assert.equal(payload.timeline.segments[2]?.audio.available, true, "timeline preserves real audio evidence availability");
assert.equal(payload.timeline.segments[2]?.visual.available, true, "timeline preserves real visual evidence availability");
assert.equal(payload.timeline.segments[2]?.ocr.text, "PRICING REVEAL", "timeline associates OCR evidence to the correct second");
assert(payload.timeline.events.some((event) => event.modality === "vision" && event.type === "scene_change"), "timeline retains visual events with provenance");
assert.equal(payload.timelineEnriched[0]?.id, "visual", "timeline evidence raises the stronger multi-modal candidate");
assert(payload.timelineEnriched[0]?.score > payload.timelineEnriched[1]?.score, "multi-modal evidence affects ranking without changing candidate boundaries");
assert(payload.timelineEnriched[0]?.score_source.includes("timeline"), "rank source records timeline enrichment");
assert.equal(payload.timelineEnriched[0]?.multimodal_evidence?.evidenceSeconds, 2, "candidate evidence is aggregated only across overlapping seconds");
assert.equal(payload.intelligenceCaps.ffmpeg, false, "capability report does not claim a nonexistent FFmpeg binary");
assert.equal(payload.cacheValidFull, true, "near-complete cached evidence is reused");
assert.equal(payload.cacheValidShort, false, "short cached evidence cannot masquerade as a full analysis pass");
assert.equal(payload.cacheValidUnavailable, true, "unavailable-provider evidence remains safely cacheable");
assert.equal(payload.analysisCoverage, 1_800_000, "analysis coverage respects the configured duration cap");
assert.equal(payload.cancelIsBaseException, true, "cancellation cannot be swallowed as soft provider failure");
assert.equal(payload.rangeNone, null, "without range config, autonomous selection remains unchanged");
assert.deepEqual(
  { start: payload.rangeExplicit.startSeconds, end: payload.rangeExplicit.endSeconds, duration: payload.rangeExplicit.durationSeconds },
  { start: 42.125, end: 62.125, duration: 20 },
  "explicit source ranges retain exact source-relative seconds",
);
assert.equal(payload.rangeExplicit.mode, "user-directed-range", "explicit ranges declare their source-directed mode");
assert.equal(payload.rangeExplicit.clamped, false, "fully available source range does not report a clamp");
assert.deepEqual(
  { start: payload.rangeCamel.startSeconds, end: payload.rangeCamel.endSeconds, duration: payload.rangeCamel.durationSeconds },
  { start: 112, end: 120, duration: 8 },
  "camel-case config accepts and clamps a range to the source end",
);
assert.equal(payload.rangeCamel.clamped, true, "range end clamping is reported explicitly");
assert.deepEqual(
  { start: payload.rangeDefault.startSeconds, end: payload.rangeDefault.endSeconds, duration: payload.rangeDefault.durationSeconds },
  { start: 90, end: 108, duration: 18 },
  "start-only requests stay bounded by the requested clip duration",
);
assert.deepEqual(
  payload.rangeRebasedWords.map((word) => word.word),
  ["Target", "After"],
  "source-range captions exclude words outside the selected window",
);
assert.equal(payload.rangeRebasedWords[0]?.start, 0, "range starts retain the opening word at zero");
assert.equal(payload.rangeCandidate.start, 0, "user-directed candidates begin at the requested source frame");
assert.equal(payload.rangeCandidate.end, 2.875, "user-directed candidates never extend beyond the selected range");
assert.equal(payload.rangeCandidate.user_directed, true, "user-directed candidates are marked for downstream metadata");
assert.equal(payload.directedMethod.length, 1, "numbered method requests resolve to a dedicated candidate");
assert.equal(payload.directedMethod[0]?.section_ordinal, 3, "the requested ordinal is retained in the candidate");
assert.equal(payload.directedMethod[0]?.query_directed, true, "directed sections cannot be displaced by generic virality ranking");
assert(payload.directedMethod[0]!.start <= 0.47 && payload.directedMethod[0]!.end < 10.0, "the third-method section begins at its heading and ends before the fourth method");
assert(payload.directedMethod[0]!.transcript.toLowerCase().includes("third method"), "directed selection contains the matched spoken evidence");
assert.equal(payload.premiumEncoding[payload.premiumEncoding.indexOf("-crf") + 1], "12", "premium export uses a high-detail CRF");
assert.equal(payload.masterEncoding[payload.masterEncoding.indexOf("-crf") + 1], "10", "master export exposes an even higher-quality option");
assert.equal(payload.sourceFillLandscape, true, "wide sources use a sharp foreground over a blurred portrait fill");
assert.equal(payload.sourceFillPortraitSar, false, "non-square-pixel portrait sources do not receive landscape fill treatment");
assert.equal(payload.rangeErrors.length, 5, "invalid, non-finite, and too-short source ranges are rejected safely");
assert.equal(payload.atomicArtifact.complete, true, "atomic artifact writes preserve a completed payload");
assert.equal(payload.atomicStagingLeftovers, 0, "atomic artifact writes clean up staging files");
assert(payload.phraseCaptionCount > 0, "phrase-highlight subtitles produce timed caption beats");
assert(payload.phraseCaptions.includes("Here is the") && payload.phraseCaptions.includes("answer."), "phrase-highlight captions keep multiple words visible together");
assert(payload.phraseCaptions.includes("\\c&H"), "phrase-highlight captions mark the active word without moving the phrase");
for (let index = 0; index < payload.phraseBeats.length - 1; index += 1) {
  assert(
    payload.phraseBeats[index][1] <= payload.phraseBeats[index + 1][0],
    "phrase-highlight timing closes before the next spoken word becomes active",
  );
}
assert(payload.customPositionOverride.includes("\\pos(410,1363)"), "custom caption coordinates are converted to final 1080p canvas pixels");

console.log("AI Clip unit tests passed (tracking, framing + timeline intelligence assertions)");
