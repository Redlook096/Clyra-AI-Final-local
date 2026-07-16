/**
 * End-to-end voice latency bench:
 * PCM16 audio -> Node /voice/stream (+ pipeline STT) -> existing LLM -> TTS
 *
 * Usage:
 *   node --input-type=module tools/voice-latency-bench.mjs [path/to/audio.pcm|wav] [out.json] [--echo]
 *
 * Default prompt mode uses buildVoiceSystemPrompt() (omit session systemPrompt).
 * Pass --echo for the latency-echo system prompt.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_PCM = path.join(ROOT, "tmp/voice-bench/probe.pcm");
const args = process.argv.slice(2).filter((a) => a !== "--echo");
const useEchoPrompt = process.argv.includes("--echo");
const pcmPath = args[0] ? path.resolve(args[0]) : DEFAULT_PCM;
const outPath = args[1]
  ? path.resolve(args[1])
  : path.join(ROOT, "tmp/voice-bench/latency-result.json");
const SAMPLE_RATE = 16000;
const CHUNK_MS = 40; // stream like realtime mic
const CHUNK_BYTES = Math.floor((SAMPLE_RATE * CHUNK_MS) / 1000) * 2;

function readPcm16(filePath) {
  const buf = fs.readFileSync(filePath);
  if (filePath.endsWith(".wav")) {
    // naive: find "data" chunk
    const idx = buf.indexOf(Buffer.from("data"));
    if (idx >= 0) return buf.subarray(idx + 8);
  }
  return buf;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const marks = {
  t0: 0,
  audioStart: 0,
  audioEnd: 0,
  firstPartial: null,
  sttFinal: null,
  firstLlmToken: null,
  llmDone: null,
  firstTts: null,
  ttsDone: null,
  transcript: "",
  reply: "",
  mode: "",
  error: null,
  promptMode: useEchoPrompt ? "echo" : "normal_voice",
};

async function main() {
  if (!fs.existsSync(pcmPath)) {
    throw new Error(`Missing audio: ${pcmPath}`);
  }
  const pcm = readPcm16(pcmPath);
  const durationMs = (pcm.length / 2 / SAMPLE_RATE) * 1000;
  console.log(`audio=${pcmPath} bytes=${pcm.length} duration_ms=${durationMs.toFixed(0)}`);
  console.log(`prompt_mode=${marks.promptMode} out=${outPath}`);

  const sessionBody = {
    conversationId: "latency-bench",
    temperature: 0.4,
    history: [],
  };
  if (useEchoPrompt) {
    sessionBody.systemPrompt = `You are in a voice call latency test.
When the user speaks, respond by clearly repeating back exactly what they said, prefixed with: "You said:".
Do not add extra commentary. Keep it to one short spoken sentence.`;
  }
  // Omit systemPrompt for normal path so gateway uses buildVoiceSystemPrompt().
  const sessionRes = await fetch("http://127.0.0.1:3000/voice/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(sessionBody),
  });
  const session = await sessionRes.json();
  if (!session.ok) throw new Error(JSON.stringify(session));

  const ws = new WebSocket(session.websocketUrl);
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("overall timeout")), 120000);
    ws.on("open", async () => {
      marks.t0 = Date.now();
      // Wait briefly for pipeline_mode announcement
      await sleep(900);
      if (marks.mode !== "pipeline") {
        console.warn("WARN: expected pipeline mode; continuing anyway");
      }

      marks.audioStart = Date.now();
      let seq = 0;
      for (let off = 0; off < pcm.length; off += CHUNK_BYTES) {
        const slice = pcm.subarray(off, Math.min(pcm.length, off + CHUNK_BYTES));
        seq += 1;
        ws.send(
          JSON.stringify({
            type: "audio",
            sessionId: session.sessionId,
            codec: "pcm16",
            data: slice.toString("base64"),
            seq,
          }),
        );
        // Realtime pacing (slightly faster than realtime to reduce wall wait)
        await sleep(Math.max(8, CHUNK_MS * 0.55));
      }
      // Speech end = last real audio byte (before silence pad).
      marks.audioEnd = Date.now();
      console.log(`audio_streamed in ${marks.audioEnd - marks.audioStart}ms`);
      // Pad trailing silence so VAD can endpoint after the last spoken frame.
      const silence = Buffer.alloc(CHUNK_BYTES, 0);
      for (let i = 0; i < Math.ceil(700 / CHUNK_MS); i += 1) {
        seq += 1;
        ws.send(
          JSON.stringify({
            type: "audio",
            sessionId: session.sessionId,
            codec: "pcm16",
            data: silence.toString("base64"),
            seq,
          }),
        );
        await sleep(Math.max(8, CHUNK_MS * 0.55));
      }
    });

    ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw));
      const now = Date.now();
      if (msg.type === "pipeline_mode") {
        marks.mode = msg.mode;
        console.log(`mode=${msg.mode}`);
      }
      if (msg.type === "transcript_partial" && msg.text && marks.firstPartial == null) {
        marks.firstPartial = now;
        console.log(`first_partial +${now - marks.audioStart}ms :: ${msg.text}`);
      }
      if (msg.type === "transcript_final" && msg.text) {
        marks.sttFinal = now;
        marks.transcript = msg.text;
        const afterAudio =
          marks.audioEnd > 0 ? `${now - marks.audioEnd}ms after_audio_end` : "before_audio_end";
        console.log(`stt_final +${afterAudio} :: ${msg.text}`);
      }
      if (msg.type === "llm_token" && marks.firstLlmToken == null) {
        marks.firstLlmToken = now;
        console.log(`first_llm_token +${now - (marks.sttFinal || now)}ms after_final`);
      }
      if (msg.type === "llm_done") {
        marks.llmDone = now;
        marks.reply = msg.text || "";
        console.log(`llm_done :: ${marks.reply.slice(0, 220)}`);
      }
      if (msg.type === "tts_chunk" && marks.firstTts == null) {
        marks.firstTts = now;
        console.log(`first_tts +${now - (marks.firstLlmToken || now)}ms after_first_token`);
      }
      if (msg.type === "tts_done" || (msg.type === "status" && msg.status === "listening" && marks.llmDone)) {
        if (marks.ttsDone == null && marks.llmDone && marks.firstTts) {
          marks.ttsDone = now;
          clearTimeout(timeout);
          resolve(null);
        } else if (marks.ttsDone == null && marks.llmDone && !marks.firstTts) {
          // No server PCM (browser speechSynthesis path) — still a valid turn.
          marks.ttsDone = now;
          marks.firstTts = marks.firstTts ?? marks.llmDone;
          console.log("tts_done without pcm chunks (browser TTS fallback)");
          clearTimeout(timeout);
          resolve(null);
        }
      }
      if (msg.type === "error") {
        marks.error = msg.message;
        clearTimeout(timeout);
        reject(new Error(msg.message));
      }
    });
    ws.on("error", reject);
  });

  ws.close();
  await fetch("http://127.0.0.1:3000/voice/end", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: session.sessionId }),
  }).catch(() => undefined);

  const row = {
    audio_source: path.relative(ROOT, pcmPath),
    prompt_mode: marks.promptMode,
    mode: marks.mode,
    stt_model: "tiny.en",
    audio_to_first_partial_ms:
      marks.firstPartial && marks.audioStart ? marks.firstPartial - marks.audioStart : null,
    // STT after endpoint: time from last audio byte streamed to transcript_final.
    // Negative means VAD endpoint+decode finished during trailing silence (good).
    audio_end_to_stt_final_ms:
      marks.sttFinal && marks.audioEnd ? marks.sttFinal - marks.audioEnd : null,
    stt_final_to_first_llm_ms:
      marks.firstLlmToken && marks.sttFinal ? marks.firstLlmToken - marks.sttFinal : null,
    first_llm_to_first_tts_ms:
      marks.firstTts && marks.firstLlmToken ? marks.firstTts - marks.firstLlmToken : null,
    speech_end_to_first_tts_ms:
      marks.firstTts && marks.audioEnd ? marks.firstTts - marks.audioEnd : null,
    transcript: marks.transcript,
    reply: marks.reply,
    reply_preview: (marks.reply || "").slice(0, 240),
  };
  console.log("\n=== LATENCY TABLE ===");
  console.log(JSON.stringify(row, null, 2));
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(row, null, 2));
  console.log(`wrote ${outPath}`);
}

main().catch((err) => {
  console.error("BENCH_FAIL", err);
  process.exit(1);
});
