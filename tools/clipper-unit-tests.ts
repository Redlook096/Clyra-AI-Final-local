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
]
sentences = module.sentence_boundaries(semantic_words)
semantic = module.semantic_candidates(semantic_words, 12, "viral", 15, 2)
regions = module.speech_regions(semantic_words)

print(json.dumps({
    "candidates": candidates,
    "shortDuration": module.parse_duration(2),
    "longDuration": module.parse_duration(999),
    "cleanName": module.clean_name("  My Clip: Final!?  "),
    "customKeywords": sorted(module.keyword_set("laughing falls")),
    "sentences": sentences,
    "semantic": semantic,
    "regions": regions,
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
assert.equal(payload.sentences.length, 2, "sentence boundaries respect punctuation and pauses");
assert(payload.sentences[0].text.endsWith("answer."), "sentence keeps its complete ending");
assert(payload.semantic.length >= 1, "semantic candidate generation returns a complete candidate");
assert(payload.semantic[0].start >= 0, "semantic candidate starts on a safe timestamp");
assert(payload.semantic[0].end <= 12, "semantic candidate stays inside source bounds");
assert(Number.isInteger(payload.semantic[0].score), "semantic candidate exposes an explainable score");
assert(payload.semantic[0].reason.includes("—"), "semantic score includes a user-facing explanation");
assert.equal(payload.regions.length, 2, "speech regions preserve a meaningful pause");

console.log("AI Clip unit tests passed (42 assertions)");
