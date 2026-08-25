import assert from "node:assert/strict";
import { stopMediaStreamTracks } from "../src/lib/voicePcmCapture";

// The old raw-WebSocket PCM/phrase-buffering protocol (voicePcmPacket.ts,
// voiceSpeech.ts) is gone now that voice calls run over Pipecat + WebRTC --
// mic capture/encoding and TTS chunking are the Pipecat client's and
// server's job. voicePcmCapture.ts is still shared with dictation
// (Cmd+Shift+K + the composer mic button), which stays on its own small
// Fish-ASR WebSocket bridge (backend/voice/websocket/dictation-stream.ts).

let stops = 0;
const tracks = [{ enabled: true, stop: () => { stops += 1; } }, { enabled: true, stop: () => { stops += 1; } }];
stopMediaStreamTracks({ getTracks: () => tracks as unknown as MediaStreamTrack[] });
assert.equal(stops, 2);
assert.ok(tracks.every((track) => track.enabled === false));

console.log("voice-unit-tests: 2 assertions passed");
