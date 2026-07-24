/**
 * Backend voice-call end-to-end emulation.
 *
 * Streams PCM16 the same way VoicePcmCapturer + useVoiceCall / DictationController
 * do over `/voice/session` + `/voice/stream`, then asserts STT → LLM → TTS.
 *
 * Usage:
 *   node tools/voice-call-e2e.mjs
 *   node tools/voice-call-e2e.mjs --dictation
 *   node tools/voice-call-e2e.mjs path/to/audio.m4a
 *   CLYRA_VOICE_BASE_URL=http://127.0.0.1:31415 node tools/voice-call-e2e.mjs
 *   npm run test:voice-e2e
 *
 * Fixture (preferred):
 *   tmp/voice-bench/wallace-cl-2.m4a
 *   tmp/voice-bench/wallace-cl-2.pcm   (16 kHz mono s16le)
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_M4A = path.join(ROOT, "tmp/voice-bench/wallace-cl-2.m4a");
const DEFAULT_PCM = path.join(ROOT, "tmp/voice-bench/wallace-cl-2.pcm");
const SAMPLE_RATE = 16_000;
/** Match server VOICE_SAMPLE_RATE / config.chunkMs (~20ms mic packets). */
const CHUNK_MS = 20;
const CHUNK_BYTES = Math.floor((SAMPLE_RATE * CHUNK_MS) / 1000) * 2;
const OVERALL_TIMEOUT_MS = 120_000;
const CANDIDATE_BASES = [
  process.env.CLYRA_VOICE_BASE_URL,
  "http://127.0.0.1:31415",
  "http://127.0.0.1:3000",
].filter(Boolean).map((u) => String(u).replace(/\/$/, ""));

const argv = process.argv.slice(2);
const dictationMode = argv.includes("--dictation");
const echoPrompt = argv.includes("--echo");
const inputArg = argv.find((a) => !a.startsWith("--"))
  ? path.resolve(argv.find((a) => !a.startsWith("--")))
  : "";

const MAGIC = 0x43545453; // CTTS — src/lib/voicePcmPacket.ts
const HEADER_BYTES = 32;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function whichFfmpeg() {
  for (const candidate of ["ffmpeg", "/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/Users/lukesimpson/.local/bin/ffmpeg"]) {
    try {
      if (candidate === "ffmpeg") return "ffmpeg";
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // keep looking
    }
  }
  return "ffmpeg";
}

function decodeVoicePcmPacket(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < HEADER_BYTES) return null;
  if (buf.readUInt32BE(0) !== MAGIC || buf.readUInt8(4) !== 1) return null;
  const headerBytes = buf.readUInt16LE(6);
  if (headerBytes < HEADER_BYTES || headerBytes > buf.length) return null;
  return {
    sampleRate: buf.readUInt32LE(8),
    generation: buf.readUInt32LE(12),
    sequence: buf.readUInt32LE(16),
    phraseSequence: buf.readUInt32LE(20),
    pcm: buf.subarray(headerBytes),
  };
}

async function ensurePcm16(sourcePath, outDir) {
  if (sourcePath?.endsWith(".pcm") && fs.existsSync(sourcePath)) return sourcePath;
  if (!sourcePath && fs.existsSync(DEFAULT_PCM)) return DEFAULT_PCM;

  const media = sourcePath || (fs.existsSync(DEFAULT_M4A) ? DEFAULT_M4A : "");
  if (!media || !fs.existsSync(media)) {
    throw new Error(
      `Missing audio fixture. Expected ${DEFAULT_M4A} or pass a path.\n` +
        `Copy Wallace Cl 2.m4a into tmp/voice-bench/ if you have the Voice Memos export.`,
    );
  }
  if (media.endsWith(".pcm")) return media;
  if (media.endsWith(".wav")) {
    const buf = fs.readFileSync(media);
    const idx = buf.indexOf(Buffer.from("data"));
    if (idx >= 0) {
      const pcm = buf.subarray(idx + 8);
      const outPcm = path.join(outDir, `${path.basename(media, path.extname(media))}.pcm`);
      fs.writeFileSync(outPcm, pcm);
      return outPcm;
    }
  }

  const outPcm = path.join(outDir, `${path.basename(media, path.extname(media))}.pcm`);
  if (fs.existsSync(DEFAULT_PCM) && path.resolve(media) === path.resolve(DEFAULT_M4A)) {
    // Prefer the checked-in 16 kHz PCM when the default m4a is used.
    return DEFAULT_PCM;
  }
  const ffmpeg = whichFfmpeg();
  await new Promise((resolve, reject) => {
    const child = spawn(
      ffmpeg,
      ["-y", "-i", media, "-ac", "1", "-ar", String(SAMPLE_RATE), "-f", "s16le", outPcm],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0 && fs.existsSync(outPcm)) resolve(null);
      else reject(new Error(`ffmpeg failed (${code}): ${stderr.slice(-800)}`));
    });
  });
  return outPcm;
}

async function resolveBaseUrl() {
  const errors = [];
  for (const base of [...new Set(CANDIDATE_BASES)]) {
    try {
      const res = await fetch(`${base}/voice/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "dictation",
          history: [],
          conversationId: "voice-e2e-probe",
        }),
        signal: AbortSignal.timeout(8_000),
      });
      const body = await res.json().catch(() => null);
      if (res.ok && body?.ok && body.sessionId) {
        // End the probe session so it does not linger.
        await fetch(`${base}/voice/end`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: body.sessionId }),
        }).catch(() => undefined);
        return base;
      }
      errors.push(`${base}: HTTP ${res.status} ${JSON.stringify(body)?.slice(0, 120)}`);
    } catch (error) {
      errors.push(`${base}: ${error instanceof Error ? error.message : error}`);
    }
  }
  throw new Error(
    `No voice server reachable. Tried: ${CANDIDATE_BASES.join(", ")}\n` +
      errors.map((e) => `  - ${e}`).join("\n") +
      `\nStart desktop (npm run desktop:dev) or source server (npm run dev:source), ` +
      `or set CLYRA_VOICE_BASE_URL.`,
  );
}

function appendJsonl(filePath, row) {
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`);
}

async function streamAudio(ws, sessionId, pcm, marks) {
  let seq = 0;
  marks.audioStart = Date.now();
  for (let off = 0; off < pcm.length; off += CHUNK_BYTES) {
    const slice = pcm.subarray(off, Math.min(pcm.length, off + CHUNK_BYTES));
    seq += 1;
    ws.send(JSON.stringify({
      type: "audio",
      sessionId,
      codec: "pcm16",
      data: slice.toString("base64"),
      seq,
    }));
    // Slightly faster than realtime (same pattern as voice-latency-bench).
    await sleep(Math.max(4, CHUNK_MS * 0.5));
  }
  marks.audioEnd = Date.now();
  marks.audioPackets = seq;
  console.log(`audio_streamed packets=${seq} wall_ms=${marks.audioEnd - marks.audioStart}`);

  // Trailing silence so VAD / async STT can endpoint (DictationController flush path).
  const silence = Buffer.alloc(CHUNK_BYTES, 0);
  for (let i = 0; i < Math.ceil(700 / CHUNK_MS); i += 1) {
    seq += 1;
    ws.send(JSON.stringify({
      type: "audio",
      sessionId,
      codec: "pcm16",
      data: silence.toString("base64"),
      seq,
    }));
    await sleep(Math.max(4, CHUNK_MS * 0.5));
  }
  ws.send(JSON.stringify({ type: "flush", sessionId }));
  marks.flushAt = Date.now();
  console.log("flush_sent");
}

async function runTurn({ baseUrl, pcmPath, outDir, mode }) {
  const pcm = fs.readFileSync(pcmPath);
  const durationMs = (pcm.length / 2 / SAMPLE_RATE) * 1000;
  const eventsPath = path.join(outDir, "events.jsonl");
  const ttsPath = path.join(outDir, "tts.pcm");
  fs.writeFileSync(eventsPath, "");
  if (fs.existsSync(ttsPath)) fs.unlinkSync(ttsPath);

  const sessionBody = {
    conversationId: mode === "dictation" ? "voice-e2e-dictation" : "voice-e2e-call",
    history: [],
    mode,
    temperature: 0.4,
  };
  if (echoPrompt && mode === "conversation") {
    sessionBody.systemPrompt = `You are in a voice call latency test.
When the user speaks, respond by clearly repeating back exactly what they said, prefixed with: "You said:".
Do not add extra commentary. Keep it to one short spoken sentence.`;
  }

  const sessionRes = await fetch(`${baseUrl}/voice/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(sessionBody),
  });
  const session = await sessionRes.json();
  if (!sessionRes.ok || !session.ok) {
    throw new Error(`voice/session failed: HTTP ${sessionRes.status} ${JSON.stringify(session)}`);
  }

  console.log(`base=${baseUrl}`);
  console.log(`mode=${mode}`);
  console.log(`audio=${pcmPath} bytes=${pcm.length} duration_ms=${durationMs.toFixed(0)}`);
  console.log(`session=${session.sessionId}`);
  console.log(`websocket=${session.websocketUrl}`);

  const marks = {
    mode: "",
    ready: false,
    firstPartial: null,
    sttFinal: null,
    firstLlmToken: null,
    llmDone: null,
    firstTts: null,
    ttsDone: null,
    playbackDoneSent: false,
    transcript: "",
    reply: "",
    error: null,
    ttsBytes: 0,
    ttsPackets: 0,
    ttsSampleRate: null,
    audioStart: 0,
    audioEnd: 0,
    audioPackets: 0,
    flushAt: 0,
    t0: Date.now(),
  };

  await new Promise((resolve, reject) => {
    const ws = new WebSocket(session.websocketUrl);
    const timeout = setTimeout(() => {
      try { ws.close(); } catch { /* ignore */ }
      reject(new Error(
        `overall timeout after ${OVERALL_TIMEOUT_MS}ms ` +
          `(transcript=${Boolean(marks.transcript)} llm=${Boolean(marks.reply)} tts_bytes=${marks.ttsBytes})`,
      ));
    }, OVERALL_TIMEOUT_MS);

    const finishOk = () => {
      clearTimeout(timeout);
      try { ws.close(); } catch { /* ignore */ }
      resolve(null);
    };

    const fail = (error) => {
      clearTimeout(timeout);
      try { ws.close(); } catch { /* ignore */ }
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    const maybeComplete = () => {
      if (mode === "dictation") {
        if (marks.transcript.trim()) finishOk();
        return;
      }
      // Conversation: need STT + LLM + TTS (or explicit tts_done without PCM on browser fallback).
      if (!marks.transcript.trim() || !marks.llmDone) return;
      if (marks.ttsDone && (marks.ttsBytes > 0 || marks.firstTts != null)) {
        if (!marks.playbackDoneSent && ws.readyState === WebSocket.OPEN) {
          marks.playbackDoneSent = true;
          ws.send(JSON.stringify({ type: "playback_done", sessionId: session.sessionId }));
        }
        finishOk();
      }
    };

    ws.on("open", async () => {
      try {
        // Wait for ready / pipeline_mode like useVoiceCall (do not race capture).
        await sleep(900);
        if (!marks.ready) console.warn("WARN: ready not received yet; continuing");
        if (marks.mode && marks.mode !== "pipeline") {
          console.warn(`WARN: expected pipeline mode, got ${marks.mode}`);
        }
        await streamAudio(ws, session.sessionId, pcm, marks);
      } catch (error) {
        fail(error);
      }
    });

    ws.on("message", (raw, isBinary) => {
      const now = Date.now();
      if (isBinary) {
        const packet = decodeVoicePcmPacket(Buffer.from(raw));
        const pcmBytes = packet?.pcm || Buffer.from(raw);
        fs.appendFileSync(ttsPath, pcmBytes);
        marks.ttsBytes += pcmBytes.length;
        marks.ttsPackets += 1;
        if (packet?.sampleRate) marks.ttsSampleRate = packet.sampleRate;
        if (marks.firstTts == null) {
          marks.firstTts = now;
          console.log(`first_tts +${now - (marks.firstLlmToken || now)}ms after_first_token bytes=${pcmBytes.length}`);
        }
        appendJsonl(eventsPath, {
          at: now - marks.t0,
          type: "tts_binary",
          bytes: pcmBytes.length,
          sequence: packet?.sequence ?? null,
          sampleRate: packet?.sampleRate ?? null,
        });
        maybeComplete();
        return;
      }

      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      appendJsonl(eventsPath, { at: now - marks.t0, ...msg });

      if (msg.type === "ready") {
        marks.ready = true;
        console.log(`ready sampleRate=${msg.sampleRate}`);
      }
      if (msg.type === "pipeline_mode") {
        marks.mode = msg.mode;
        console.log(`pipeline_mode=${msg.mode}`);
      }
      if (msg.type === "transcript_partial" && msg.text && marks.firstPartial == null) {
        marks.firstPartial = now;
        console.log(`first_partial +${now - marks.audioStart}ms :: ${msg.text}`);
      }
      if (msg.type === "transcript_final" || msg.type === "dictation_final") {
        marks.sttFinal = now;
        marks.transcript = String(msg.text || "");
        const afterAudio =
          marks.audioEnd > 0 ? `${now - marks.audioEnd}ms after_audio_end` : "before_audio_end";
        console.log(`${msg.type} +${afterAudio} :: ${marks.transcript}`);
        if (mode === "dictation") maybeComplete();
      }
      if (msg.type === "llm_token") {
        if (marks.firstLlmToken == null) {
          marks.firstLlmToken = now;
          console.log(`first_llm_token +${now - (marks.sttFinal || now)}ms after_final`);
        }
      }
      if (msg.type === "llm_done") {
        marks.llmDone = now;
        marks.reply = String(msg.text || "");
        console.log(`llm_done :: ${marks.reply.slice(0, 240)}`);
        maybeComplete();
      }
      if (msg.type === "tts_format") {
        marks.ttsSampleRate = msg.sampleRate || marks.ttsSampleRate;
        console.log(`tts_format sampleRate=${msg.sampleRate} codec=${msg.codec}`);
      }
      if (msg.type === "tts_chunk" && msg.data) {
        const chunk = Buffer.from(msg.data, "base64");
        fs.appendFileSync(ttsPath, chunk);
        marks.ttsBytes += chunk.length;
        marks.ttsPackets += 1;
        if (marks.firstTts == null) {
          marks.firstTts = now;
          console.log(`first_tts(json) +${now - (marks.firstLlmToken || now)}ms after_first_token`);
        }
      }
      if (msg.type === "tts_done") {
        marks.ttsDone = now;
        console.log(`tts_done bytes=${marks.ttsBytes} packets=${marks.ttsPackets}`);
        maybeComplete();
      }
      if (msg.type === "status" && msg.status === "listening" && marks.llmDone && marks.ttsDone == null) {
        // Browser TTS path: no PCM — treat as done once listening returns.
        marks.ttsDone = now;
        marks.firstTts = marks.firstTts ?? marks.llmDone;
        console.log("tts_done implied by listening (no PCM)");
        maybeComplete();
      }
      if (msg.type === "error") {
        marks.error = msg.message;
        fail(new Error(String(msg.message || "voice stream error")));
      }
    });

    ws.on("error", fail);
  });

  await fetch(`${baseUrl}/voice/end`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: session.sessionId }),
  }).catch(() => undefined);

  const failures = [];
  if (!marks.transcript.trim()) failures.push("STT produced no transcript");
  if (mode === "conversation") {
    if (!marks.reply.trim()) failures.push("LLM produced no reply");
    if (marks.ttsBytes <= 0 && marks.firstTts == null) {
      failures.push("TTS produced no audio frames");
    }
  }

  const result = {
    ok: failures.length === 0,
    failures,
    mode,
    pipeline_mode: marks.mode,
    base_url: baseUrl,
    session_id: session.sessionId,
    audio_source: path.relative(ROOT, pcmPath),
    audio_duration_ms: Math.round(durationMs),
    transcript: marks.transcript,
    reply: marks.reply,
    tts_bytes: marks.ttsBytes,
    tts_packets: marks.ttsPackets,
    tts_sample_rate: marks.ttsSampleRate,
    timings_ms: {
      audio_to_first_partial:
        marks.firstPartial && marks.audioStart ? marks.firstPartial - marks.audioStart : null,
      audio_end_to_stt_final:
        marks.sttFinal && marks.audioEnd ? marks.sttFinal - marks.audioEnd : null,
      stt_final_to_first_llm:
        marks.firstLlmToken && marks.sttFinal ? marks.firstLlmToken - marks.sttFinal : null,
      first_llm_to_first_tts:
        marks.firstTts && marks.firstLlmToken ? marks.firstTts - marks.firstLlmToken : null,
      speech_end_to_first_tts:
        marks.firstTts && marks.audioEnd ? marks.firstTts - marks.audioEnd : null,
      total: Date.now() - marks.t0,
    },
    artifacts: {
      dir: path.relative(ROOT, outDir),
      events: path.relative(ROOT, eventsPath),
      tts_pcm: marks.ttsBytes > 0 ? path.relative(ROOT, ttsPath) : null,
    },
  };

  fs.writeFileSync(path.join(outDir, "result.json"), JSON.stringify(result, null, 2));
  fs.writeFileSync(path.join(outDir, "transcript.txt"), `${marks.transcript}\n`);
  if (marks.reply) fs.writeFileSync(path.join(outDir, "reply.txt"), `${marks.reply}\n`);

  return result;
}

async function main() {
  const outDir = path.join(ROOT, "tmp/voice-bench", `e2e-${stamp()}${dictationMode ? "-dictation" : ""}`);
  fs.mkdirSync(outDir, { recursive: true });

  let baseUrl;
  try {
    baseUrl = await resolveBaseUrl();
  } catch (error) {
    fs.writeFileSync(
      path.join(outDir, "result.json"),
      JSON.stringify({
        ok: false,
        failures: [error instanceof Error ? error.message : String(error)],
        note: "Server was not reachable; script and fixture are ready to re-run.",
      }, null, 2),
    );
    throw error;
  }

  const pcmPath = await ensurePcm16(inputArg, outDir);
  fs.copyFileSync(pcmPath, path.join(outDir, path.basename(pcmPath)));

  const result = await runTurn({
    baseUrl,
    pcmPath,
    outDir,
    mode: dictationMode ? "dictation" : "conversation",
  });

  console.log("\n=== VOICE E2E RESULT ===");
  console.log(JSON.stringify(result, null, 2));
  console.log(`wrote ${path.join(outDir, "result.json")}`);

  if (!result.ok) {
    throw new Error(result.failures.join("; "));
  }
}

main().catch((error) => {
  console.error("VOICE_E2E_FAIL", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
