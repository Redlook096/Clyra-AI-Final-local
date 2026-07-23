/**
 * Backend dictation / voice STT smoke test.
 *
 * Converts an M4A (or uses an existing PCM) and streams it through the same
 * `/voice/session` + `/voice/stream` path that Cmd+Shift+K uses.
 *
 * Usage:
 *   node tools/dictation-test.mjs
 *   node tools/dictation-test.mjs path/to/audio.m4a
 *   CLYRA_VOICE_BASE_URL=http://127.0.0.1:31415 node tools/dictation-test.mjs
 *
 * Fixture (already in-repo):
 *   tmp/voice-bench/wallace-cl-2.m4a
 *   tmp/voice-bench/wallace-cl-2.pcm   (16 kHz mono s16le)
 *
 * If you still have the Voice Memos export, copy it in first:
 *   mkdir -p tmp
 *   cp "/Users/lukesimpson/Library/Containers/com.apple.VoiceMemos/Data/tmp/.../Wallace Cl 2.m4a" \
 *      tmp/wallace-cl-2.m4a
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
const CHUNK_MS = 40;
const CHUNK_BYTES = Math.floor((SAMPLE_RATE * CHUNK_MS) / 1000) * 2;
const BASE_URL = (process.env.CLYRA_VOICE_BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");

const inputArg = process.argv[2] ? path.resolve(process.argv[2]) : "";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function whichFfmpeg() {
  for (const candidate of ["ffmpeg", "/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"]) {
    try {
      if (candidate === "ffmpeg") return "ffmpeg";
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // keep looking
    }
  }
  return "ffmpeg";
}

async function ensurePcm16(sourcePath) {
  if (sourcePath.endsWith(".pcm") && fs.existsSync(sourcePath)) {
    return sourcePath;
  }
  if (!sourcePath && fs.existsSync(DEFAULT_PCM)) {
    return DEFAULT_PCM;
  }
  const media = sourcePath || (fs.existsSync(DEFAULT_M4A) ? DEFAULT_M4A : "");
  if (!media || !fs.existsSync(media)) {
    throw new Error(
      `Missing audio fixture. Expected ${DEFAULT_M4A} or pass a path.\n` +
        `Copy Wallace Cl 2.m4a into tmp/ if you have the Voice Memos export.`,
    );
  }
  if (media.endsWith(".pcm")) return media;

  const outDir = path.join(ROOT, "tmp/voice-bench");
  fs.mkdirSync(outDir, { recursive: true });
  const outPcm = path.join(outDir, `${path.basename(media, path.extname(media))}-dictation-test.pcm`);
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

async function main() {
  const pcmPath = await ensurePcm16(inputArg);
  const pcm = fs.readFileSync(pcmPath);
  const durationMs = (pcm.length / 2 / SAMPLE_RATE) * 1000;
  console.log(`base=${BASE_URL}`);
  console.log(`audio=${pcmPath} bytes=${pcm.length} duration_ms=${durationMs.toFixed(0)}`);

  const sessionRes = await fetch(`${BASE_URL}/voice/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "dictation", history: [], conversationId: "dictation-test" }),
  });
  const session = await sessionRes.json();
  if (!session.ok) throw new Error(`session failed: ${JSON.stringify(session)}`);
  console.log(`session=${session.sessionId}`);
  console.log(`websocket=${session.websocketUrl}`);

  const marks = {
    mode: "",
    firstPartial: null,
    transcript: "",
    error: null,
    t0: Date.now(),
  };

  await new Promise((resolve, reject) => {
    const ws = new WebSocket(session.websocketUrl);
    const timeout = setTimeout(() => reject(new Error("dictation test timed out after 90s")), 90_000);

    ws.on("open", async () => {
      await sleep(700);
      if (marks.mode && marks.mode !== "pipeline") {
        console.warn(`WARN: expected pipeline mode, got ${marks.mode}`);
      }
      let seq = 0;
      for (let off = 0; off < pcm.length; off += CHUNK_BYTES) {
        const slice = pcm.subarray(off, Math.min(pcm.length, off + CHUNK_BYTES));
        seq += 1;
        ws.send(JSON.stringify({
          type: "audio",
          sessionId: session.sessionId,
          codec: "pcm16",
          data: slice.toString("base64"),
          seq,
        }));
        await sleep(Math.max(6, CHUNK_MS * 0.45));
      }
      const silence = Buffer.alloc(CHUNK_BYTES, 0);
      for (let i = 0; i < Math.ceil(600 / CHUNK_MS); i += 1) {
        seq += 1;
        ws.send(JSON.stringify({
          type: "audio",
          sessionId: session.sessionId,
          codec: "pcm16",
          data: silence.toString("base64"),
          seq,
        }));
        await sleep(Math.max(6, CHUNK_MS * 0.45));
      }
      ws.send(JSON.stringify({ type: "flush", sessionId: session.sessionId }));
    });

    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (msg.type === "pipeline_mode") {
        marks.mode = msg.mode;
        console.log(`mode=${msg.mode}`);
      }
      if (msg.type === "transcript_partial" && msg.text && marks.firstPartial == null) {
        marks.firstPartial = Date.now() - marks.t0;
        console.log(`partial +${marks.firstPartial}ms :: ${msg.text}`);
      }
      if (msg.type === "dictation_final" || msg.type === "transcript_final") {
        marks.transcript = String(msg.text || "");
        console.log(`final :: ${marks.transcript}`);
        clearTimeout(timeout);
        try { ws.close(); } catch { /* ignore */ }
        resolve(null);
      }
      if (msg.type === "error") {
        marks.error = msg.message;
        clearTimeout(timeout);
        reject(new Error(String(msg.message || "voice stream error")));
      }
    });

    ws.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });

  if (!marks.transcript.trim()) {
    throw new Error("STT returned an empty transcript.");
  }
  console.log(JSON.stringify({
    ok: true,
    mode: marks.mode,
    transcript: marks.transcript,
    first_partial_ms: marks.firstPartial,
    audio: pcmPath,
    base_url: BASE_URL,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
