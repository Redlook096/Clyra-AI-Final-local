import assert from "node:assert/strict";
import { SmartCameraSolver } from "../src/lib/clipper/smart-camera";

let assertions = 0;
const solver = new SmartCameraSolver();
const start = solver.update({ x: 50, y: 38, zoom: 1.5, confidence: 0.96, timestampMs: 0, shotId: 1 });
assert.equal(start.x, 50); assertions += 1;

const micro = solver.update({ x: 52, y: 39, zoom: 1.52, confidence: 0.96, timestampMs: 125, shotId: 1 });
assert.equal(micro.x, 50, "micro movement remains in the framing dead zone"); assertions += 1;
assert.equal(micro.zoom, 1.5, "small face-size changes do not pump zoom"); assertions += 1;

const move = solver.update({ x: 70, y: 40, zoom: 1.5, confidence: 0.96, timestampMs: 250, shotId: 1 });
assert(move.x > 50 && move.x < 70, "large movement begins a bounded camera follow"); assertions += 1;
assert(move.velocityX <= 46, "camera velocity is limited"); assertions += 1;

const cut = solver.update({ x: 24, y: 35, zoom: 1.3, confidence: 0.9, timestampMs: 375, shotId: 2 });
assert.equal(cut.x, 24, "shot cuts reset immediately rather than panning between scenes"); assertions += 1;
assert.equal(cut.velocityX, 0); assertions += 1;

console.log(`smart-camera-unit-tests: ${assertions} assertions passed`);
