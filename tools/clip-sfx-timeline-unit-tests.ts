import assert from "node:assert/strict";
import {
  CLIP_SFX_ASSETS,
  clampSfxSpeed,
  createSfxClip,
  isSfxActiveAt,
  normalizeSfxClips,
  sfxClipsForRender,
  sfxSourceTimeAt,
  sfxTimelineDuration,
} from "../src/lib/clipSfxTimeline.ts";

assert.equal(CLIP_SFX_ASSETS.length, 4);
assert.ok(CLIP_SFX_ASSETS.every((asset) => asset.url.startsWith("/media/clipper-sfx/")));

assert.equal(clampSfxSpeed(1), 1);
assert.equal(clampSfxSpeed(0.1), 0.5);
assert.equal(clampSfxSpeed(9), 2);

const thud = createSfxClip({ assetId: "thud", start: 1.5, speed: 1 });
assert.equal(thud.assetId, "thud");
assert.ok(Math.abs(sfxTimelineDuration(thud) - 1.28) < 0.02);
assert.equal(isSfxActiveAt(thud, 1.5), true);
assert.equal(isSfxActiveAt(thud, 1.4), false);
assert.ok(Math.abs(sfxSourceTimeAt(thud, 2.14) - 0.64) < 0.02);

const fast = createSfxClip({ assetId: "sus", start: 0, speed: 2 });
assert.ok(Math.abs(sfxTimelineDuration(fast) - 4.68 / 2) < 0.02);

const normalized = normalizeSfxClips(
  [{ assetId: "fahh_short", start: -2, speed: 0.25, volume: 3 }, { assetId: "nope" }],
  10,
);
assert.equal(normalized.length, 1);
assert.equal(normalized[0].start, 0);
assert.equal(normalized[0].speed, 0.5);
assert.equal(normalized[0].volume, 1.5);

const payload = sfxClipsForRender([thud]);
assert.equal(payload[0].file, "thud.mp3");
assert.equal(payload[0].start, 1.5);

console.log("clip-sfx-timeline-unit-tests: ok");
