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

print(json.dumps({
    "candidates": candidates,
    "shortDuration": module.parse_duration(2),
    "longDuration": module.parse_duration(999),
    "cleanName": module.clean_name("  My Clip: Final!?  "),
    "customKeywords": sorted(module.keyword_set("laughing falls")),
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

console.log("AI Clip unit tests passed (34 assertions)");
