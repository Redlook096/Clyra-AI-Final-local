import assert from "node:assert/strict";
import { statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FAKE_TEXT_GAMEPLAY_LIBRARY } from "../src/data/fakeTextGameplay";
import {
  CREATOR_PROJECT_VERSION,
  createCreatorProject,
  creatorProjectDuration,
  creatorTimeline,
  migrateCreatorProject,
} from "../src/lib/creatorProject";
import {
  buildIMessageTimeline,
  getIMessageFrame,
  getIMessageGroupPosition,
} from "../src/lib/fakeTextTimeline";

let assertions = 0;
const check = (condition: unknown, message: string) => {
  assert.ok(condition, message);
  assertions += 1;
};

const choice = createCreatorProject("would_rather");
assert.equal(choice.type, "would_rather"); assertions += 1;
assert.equal(choice.version, CREATOR_PROJECT_VERSION); assertions += 1;
check(choice.rounds.length > 0, "Would You Rather should start with a playable round");
assert.equal(choice.rounds[0].leftPercent + (100 - choice.rounds[0].leftPercent), 100); assertions += 1;

const defaultFakeText = createCreatorProject("fake_text_story");
assert.equal(defaultFakeText.type, "fake_text_story"); assertions += 1;
if (defaultFakeText.type === "fake_text_story") {
  assert.equal(defaultFakeText.theme, "ios_dark"); assertions += 1;
  assert.equal(defaultFakeText.layout, "floating_phone"); assertions += 1;
  assert.equal(defaultFakeText.gameplay?.clipId, "subway-01"); assertions += 1;
  assert.equal(defaultFakeText.canvas.fps, 60); assertions += 1;
  assert.notEqual(defaultFakeText.participants[0].voice, defaultFakeText.participants[1].voice); assertions += 1;
}

const migratedChoice = migrateCreatorProject({
  type: "would_rather",
  version: 1,
  rounds: [{ question: "Test", left: "A", right: "B", leftPercent: 140, timerSeconds: 99, revealSeconds: 0.1 }],
}, "would_rather");
assert.equal(migratedChoice.type, "would_rather"); assertions += 1;
if (migratedChoice.type === "would_rather") {
  assert.equal(migratedChoice.rounds[0].leftPercent, 95); assertions += 1;
  assert.equal(migratedChoice.rounds[0].timerSeconds, 10); assertions += 1;
  assert.equal(migratedChoice.rounds[0].revealSeconds, 0.8); assertions += 1;
}

const story = migrateCreatorProject({
  type: "fake_text_story",
  layout: "chat_gameplay",
  playbackRate: 8,
  participants: [
    { id: "left", name: "Alex", voice: "Ryan", color: "#333" },
    { id: "right", name: "You", voice: "Aiden", color: "#08f" },
  ],
  messages: [
    { side: "left", text: "First", typingSeconds: -2, pauseSeconds: 9, narration: true },
    { side: "right", text: "Second", typingSeconds: 1, pauseSeconds: 0.25, narration: false },
  ],
}, "fake_text_story");
assert.equal(story.type, "fake_text_story"); assertions += 1;
if (story.type === "fake_text_story") {
  assert.equal(story.layout, "floating_phone"); assertions += 1;
  assert.equal(story.playbackRate, 1.8); assertions += 1;
  assert.equal(story.messages[0].typingSeconds, 0); assertions += 1;
  assert.equal(story.messages[0].pauseSeconds, 5); assertions += 1;
  assert.equal(story.messages[1].narration, false); assertions += 1;
  assert.equal(story.gameplay?.clipId, "subway-01"); assertions += 1;
}

const migratedGameplay = migrateCreatorProject({
  type: "fake_text_story",
  gameplay: { clipId: "gta-03", src: "/untrusted/path.mp4" },
}, "fake_text_story");
assert.equal(migratedGameplay.type, "fake_text_story"); assertions += 1;
if (migratedGameplay.type === "fake_text_story") {
  assert.equal(migratedGameplay.gameplay?.clipId, "gta-03"); assertions += 1;
  assert.equal(migratedGameplay.gameplay?.src, "/media/fake-text/gameplay/gta/gta-03.mp4"); assertions += 1;
}

const migratedCustomBackground = migrateCreatorProject({
  type: "fake_text_story",
  background: "data:image/png;base64,custom",
}, "fake_text_story");
if (migratedCustomBackground.type === "fake_text_story") {
  assert.equal(migratedCustomBackground.gameplay?.clipId, "subway-01"); assertions += 1;
  assert.equal(migratedCustomBackground.background, "data:image/png;base64,custom"); assertions += 1;
}

assert.equal(FAKE_TEXT_GAMEPLAY_LIBRARY.length, 15); assertions += 1;
for (const category of ["subway", "minecraft", "gta"] as const) {
  assert.equal(FAKE_TEXT_GAMEPLAY_LIBRARY.filter((clip) => clip.category === category).length, 5); assertions += 1;
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const clip of FAKE_TEXT_GAMEPLAY_LIBRARY) {
  const video = statSync(path.join(repoRoot, "public", clip.src.replace(/^\//, "")));
  const poster = statSync(path.join(repoRoot, "public", clip.poster.replace(/^\//, "")));
  check(video.size > 100_000, `${clip.id} should contain a real video`);
  check(poster.size > 1_000, `${clip.id} should contain a real poster`);
}

const choiceTimeline = creatorTimeline(choice);
check(choiceTimeline.some((item) => item.track === "visual"), "Choice timeline should contain visual scenes");
check(choiceTimeline.some((item) => item.track === "voice"), "Choice timeline should contain narration");
check(choiceTimeline.every((item) => item.durationMs > 0), "Every choice timeline item should have positive duration");

const storyTimeline = creatorTimeline(story);
check(storyTimeline.length >= 3, "Message timeline should include events and narration");
check(storyTimeline.every((item) => item.startMs >= 0), "Timeline starts cannot be negative");
check(creatorProjectDuration(story) > 0, "Message project duration should be positive");

const iMessageScript = [
  { id: "one", side: "left" as const, text: "First incoming message", typingSeconds: 0.4, pauseSeconds: 0.1, narration: true },
  { id: "two", side: "left" as const, text: "A grouped follow-up", typingSeconds: 0.4, pauseSeconds: 0.1, narration: true },
  { id: "three", side: "right" as const, text: "An outgoing reply", typingSeconds: 0.4, pauseSeconds: 0.1, narration: true },
];
const iMessageTimeline = buildIMessageTimeline(iMessageScript);
assert.equal(iMessageTimeline.events.length, 3); assertions += 1;
check(iMessageTimeline.events[1].typingStartMs >= iMessageTimeline.events[0].endMs, "Timeline events must be sequential");
const typingFrame = getIMessageFrame(iMessageTimeline, iMessageTimeline.events[0].typingStartMs + 10);
assert.equal(typingFrame.typingSide, null); assertions += 1;
assert.equal(typingFrame.visibleCount, 1); assertions += 1;
const arrivedFrame = getIMessageFrame(iMessageTimeline, iMessageTimeline.events[1].bubbleStartMs + 220);
assert.equal(arrivedFrame.visibleCount, 2); assertions += 1;
assert.equal(getIMessageGroupPosition(iMessageScript, 0), "start"); assertions += 1;
assert.equal(getIMessageGroupPosition(iMessageScript, 1), "end"); assertions += 1;
assert.equal(getIMessageGroupPosition(iMessageScript, 2), "single"); assertions += 1;

const measuredVoiceTimeline = buildIMessageTimeline([
  { id: "actual-duration", side: "left" as const, text: "Short", narration: true, voiceDurationMs: 2_340 },
]);
assert.equal(measuredVoiceTimeline.events[0].voiceEndMs, 2_340); assertions += 1;

console.log(`creator-unit-tests: ${assertions} assertions passed`);
