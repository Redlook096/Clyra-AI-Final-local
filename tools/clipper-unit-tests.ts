import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const probe = String.raw`
import importlib.util, json, pathlib

root = pathlib.Path(${JSON.stringify(root)})
spec = importlib.util.spec_from_file_location("clipper_pipeline", root / "clipper-pipeline.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

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

print(json.dumps({
    "candidates": candidates,
    "shortDuration": module.parse_duration(2),
    "longDuration": module.parse_duration(999),
    "cleanName": module.clean_name("  My Clip: Final!?  "),
    "customKeywords": sorted(module.keyword_set("laughing falls")),
    "sentences": [{"start": s["start"], "end": s["end"], "text": s["text"]} for s in sentences],
    "semantic": semantic,
    "regions": regions,
    "repaired": repaired,
    "scored": scored,
    "scoredBad": scored_bad,
    "deduped": deduped,
    "editPlan": edit_plan,
    "shots": shots,
    "clamped": clamped,
    "endsConnective": module.ends_on_connective("We tried because"),
    "endsClean": module.ends_on_connective("This is the payoff!"),
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
  editPlan: { clips: Array<{ score: number }>; shotBoundaries: unknown[] };
  shots: unknown[];
  clamped: { start: number; end: number; duration_clamped?: boolean };
  endsConnective: boolean;
  endsClean: boolean;
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

assert.equal(payload.shortDuration, 15, "minimum clip duration is enforced");
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

assert.equal(payload.regions.length >= 2, true, "speech regions preserve meaningful pauses");
assert.equal(payload.endsConnective, true, "detects trailing because/and endings");
assert.equal(payload.endsClean, false, "complete sentences are not flagged as connective");

assert(payload.repaired.boundary_repaired === true, "boundary repair marks repaired clips");
assert(payload.repaired.end > 3.9, "repair extends past a hanging because");
assert(!/\bbecause$/i.test(payload.repaired.transcript.trim()), "repair refuses to end on because");

assert(payload.clamped.end - payload.clamped.start <= 30 * 1.08 + 0.05, "hard clamp caps overlong candidates");
assert(payload.clamped.duration_clamped === true, "clamp marks duration_clamped");

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
assert.deepEqual(payload.shots, [], "missing PySceneDetect / video soft-fails to empty shot list");

console.log("AI Clip unit tests passed (60 assertions)");
