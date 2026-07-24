import assert from "node:assert/strict";
import { decodeVoicePcmPacket, encodeVoicePcmPacket, stableVoiceId } from "../src/lib/voicePcmPacket";
import { nextSemanticPhrase, normalizeSpokenText, splitSpeakablePhrases } from "../src/lib/voiceSpeech";
import { stopMediaStreamTracks } from "../src/lib/voicePcmCapture";

const spoken = normalizeSpokenText("## Cost\n- **AUD $699.50** is 25% less. See https://ebay.com.au/item/1");
assert.match(spoken, /six hundred and ninety nine point five zero Australian dollars/i);
assert.match(spoken, /twenty five percent/i);
assert.doesNotMatch(spoken, /https|\*\*|##/);

const growing = "Dr. Chen said the smaller model sounds warmer, but it still keeps every important detail.";
const phrase = nextSemanticPhrase(growing, 0);
assert.ok(phrase);
assert.ok((phrase?.text.split(/\s+/).length ?? 0) >= 8);
assert.doesNotMatch(phrase?.text ?? "", /^Dr\.$/);

const long = "This is a natural opening clause that establishes the speaking rhythm, and this second clause completes the thought without waiting for a whole paragraph.";
const phrases = splitSpeakablePhrases(long);
assert.ok(phrases.length >= 2);
assert.ok(phrases.every((item) => item.split(/\s+/).length >= 5));

const pcm = new Uint8Array([1, 2, 3, 4, 5, 6]);
const packet = encodeVoicePcmPacket(pcm, {
  sessionId: "session-a",
  responseId: "response-4",
  generation: 4,
  sequence: 9,
  phraseSequence: 2,
  sampleRate: 24000,
});
const decoded = decodeVoicePcmPacket(packet);
assert.ok(decoded);
assert.equal(decoded?.generation, 4);
assert.equal(decoded?.sequence, 9);
assert.equal(decoded?.sampleRate, 24000);
assert.equal(decoded?.sessionHash, stableVoiceId("session-a"));
assert.deepEqual(Array.from(decoded?.pcm ?? []), Array.from(pcm));

let stops = 0;
const tracks = [{ enabled: true, stop: () => { stops += 1; } }, { enabled: true, stop: () => { stops += 1; } }];
stopMediaStreamTracks({ getTracks: () => tracks as unknown as MediaStreamTrack[] });
assert.equal(stops, 2);
assert.ok(tracks.every((track) => track.enabled === false));

console.log("voice-unit-tests: 15 assertions passed");
