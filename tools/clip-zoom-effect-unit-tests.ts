import assert from "node:assert/strict";
import {
  createZoomPinEffect,
  easeInOutCubic,
  easeInOutSmooth,
  evaluateZoomAtTime,
  lerp,
  suggestZoomEnd,
  zoomEffectsToCropKeyframes,
} from "../src/lib/clipZoomEffect.ts";

// Smoothstep endpoints: zero velocity feel (derivative ~0 at 0 and 1)
assert.equal(easeInOutSmooth(0), 0);
assert.equal(easeInOutSmooth(1), 1);
assert.ok(easeInOutSmooth(0.5) > 0.49 && easeInOutSmooth(0.5) < 0.51);
// Early progress is slower than linear (ease-in)
assert.ok(easeInOutSmooth(0.2) < 0.2, "start should ease in slowly");
// Late progress is ahead of linear (already decelerating toward 1)
assert.ok(easeInOutSmooth(0.8) > 0.8, "end should ease out");

assert.equal(easeInOutCubic(0), 0);
assert.equal(easeInOutCubic(1), 1);

const zoomIn = createZoomPinEffect({
  id: "zin",
  start: 1,
  end: 3,
  direction: "in",
  intensity: 2,
  originX: 48,
  originY: 40,
});
assert.equal(zoomIn.fromZoom, 1);
assert.equal(zoomIn.toZoom, 2);
assert.equal(zoomIn.start, 1);
assert.equal(zoomIn.end, 3);

const before = evaluateZoomAtTime([zoomIn], 0.5);
assert.equal(before.zoom, 1);
assert.equal(before.effectId, null);

const mid = evaluateZoomAtTime([zoomIn], 2);
assert.ok(mid.zoom > 1.4 && mid.zoom < 1.6, `mid zoom expected ~1.5, got ${mid.zoom}`);
assert.equal(mid.effectId, "zin");
assert.equal(mid.originX, 48);

const after = evaluateZoomAtTime([zoomIn], 4);
assert.equal(after.zoom, 2, "hold end zoom after effect finishes");
assert.equal(after.effectId, null);

const zoomOut = createZoomPinEffect({
  id: "zout",
  start: 4,
  end: 5.5,
  direction: "out",
  intensity: 2,
});
assert.equal(zoomOut.fromZoom, 2);
assert.equal(zoomOut.toZoom, 1);

// Longer span → slower instantaneous rate for the same zoom delta
const short = createZoomPinEffect({ id: "s", start: 0, end: 0.5, direction: "in", intensity: 2 });
const long = createZoomPinEffect({ id: "l", start: 0, end: 4, direction: "in", intensity: 2 });
const shortAt = evaluateZoomAtTime([short], 0.25).zoom;
const longAt = evaluateZoomAtTime([long], 0.25).zoom;
assert.ok(shortAt > longAt, "shorter pin span should zoom faster");

const end = suggestZoomEnd(10, 12, 1.6);
assert.equal(end, 11.6);
assert.ok(suggestZoomEnd(11.5, 12, 1.6) <= 12);

const frames = zoomEffectsToCropKeyframes([zoomIn], 3, 10);
assert.ok(frames.length >= 30);
assert.equal(frames[0].zoom, 1);
assert.ok(frames.at(-1)!.zoom > 1.9);
assert.ok(frames.every((frame) => frame.timeMs >= 0));

assert.equal(lerp(1, 3, 0.5), 2);

console.log("clip zoom effect unit tests passed");
