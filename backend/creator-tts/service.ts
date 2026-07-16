import type express from "express";
import { probeVoicePipeline, synthesizeViaPipeline } from "../voice/pipeline/client";

const MAX_PENDING = 8;
const REQUEST_TIMEOUT_MS = 180_000;
const MAX_CACHE_ITEMS = 64;
const MAX_CACHE_BYTES = 32 * 1024 * 1024;
let pending = 0;
let cacheBytes = 0;

const CREATOR_VOICES = [
  "Ryan",
  "Aiden",
  "Aaron",
  "Abigail",
  "Anaya",
  "Andy",
  "Archer",
  "Brian",
  "Chloe",
  "Dylan",
  "Emmanuel",
  "Ethan",
  "Evelyn",
  "Gavin",
  "Gordon",
  "Ivan",
  "Laura",
  "Lucy",
  "Madison",
  "Marisol",
  "Meera",
  "Walter",
] as const;

type CreatorVoiceName = (typeof CREATOR_VOICES)[number];

type CachedSpeech = {
  audio: Buffer;
  durationMs: number;
  engine: string;
  warning?: string;
};

const speechCache = new Map<string, CachedSpeech>();

function resolveVoice(value: unknown): CreatorVoiceName {
  return typeof value === "string" && (CREATOR_VOICES as readonly string[]).includes(value)
    ? value as CreatorVoiceName
    : "Ryan";
}

function readCachedSpeech(key: string) {
  const cached = speechCache.get(key);
  if (!cached) return undefined;
  speechCache.delete(key);
  speechCache.set(key, cached);
  return cached;
}

function cacheSpeech(key: string, value: CachedSpeech) {
  const previous = speechCache.get(key);
  if (previous) cacheBytes -= previous.audio.length;
  speechCache.delete(key);
  speechCache.set(key, value);
  cacheBytes += value.audio.length;
  while (speechCache.size > MAX_CACHE_ITEMS || cacheBytes > MAX_CACHE_BYTES) {
    const oldestKey = speechCache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    const oldest = speechCache.get(oldestKey);
    speechCache.delete(oldestKey);
    cacheBytes -= oldest?.audio.length || 0;
  }
}

function sendSpeech(
  res: express.Response,
  speech: CachedSpeech,
  voice: CreatorVoiceName,
  cacheStatus: "HIT" | "MISS",
  synthesisMs?: number,
) {
  res.setHeader("Content-Type", "audio/wav");
  res.setHeader("Content-Length", String(speech.audio.length));
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Clyra-TTS-Engine", speech.engine);
  res.setHeader("X-Clyra-TTS-Voice", voice);
  res.setHeader("X-Clyra-TTS-Duration", String(speech.durationMs));
  res.setHeader("X-Clyra-TTS-Cache", cacheStatus);
  if (synthesisMs !== undefined) res.setHeader("X-Clyra-TTS-Synthesis", String(Math.round(synthesisMs)));
  if (speech.warning) res.setHeader("X-Clyra-TTS-Warning", speech.warning);
  res.send(speech.audio);
}

function pcm16Wav(pcm: Buffer, sampleRate: number) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export function registerCreatorTtsRoutes(app: express.Express) {
  app.get("/api/creator/tts/health", async (_req, res) => {
    const health = await probeVoicePipeline();
    if (!health.ok) {
      res.status(503).json({ ok: false, engine: "chatterbox-turbo", error: "Shared voice worker is unavailable" });
      return;
    }
    const runtime = health.detail?.tts_runtime as Record<string, unknown> | undefined;
    res.json({
      ok: true,
      engine: runtime?.active_engine || "chatterbox-turbo",
      requestedEngine: runtime?.requested_engine || "chatterbox-turbo",
      model: "ResembleAI/chatterbox-turbo",
      voices: [...CREATOR_VOICES],
      queueDepth: pending,
      degraded: Boolean(runtime?.degraded),
      warning: runtime?.degraded ? runtime?.reason : undefined,
    });
  });

  app.post("/api/creator/tts", async (req, res) => {
    const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
    const voice = resolveVoice(req.body?.voice);
    if (!text || text.length > 600) {
      res.status(400).json({ error: "Text must contain 1 to 600 characters" });
      return;
    }
    const cacheKey = `${voice}\u0000${text}`;
    const cached = readCachedSpeech(cacheKey);
    if (cached) {
      sendSpeech(res, cached, voice, "HIT");
      return;
    }
    if (pending >= MAX_PENDING) {
      res.status(429).json({ error: "Narration queue is full" });
      return;
    }

    pending += 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    req.once("aborted", () => controller.abort());
    try {
      const result = await synthesizeViaPipeline(text, controller.signal, {
        voice,
        timeoutMs: REQUEST_TIMEOUT_MS,
      });
      const pcm = Buffer.concat(result.chunks.map((chunk) => Buffer.from(chunk, "base64")));
      if (!pcm.length) throw new Error("Chatterbox returned no audio");
      const audio = pcm16Wav(pcm, result.sampleRate);
      const durationMs = Math.round(pcm.length / 2 / result.sampleRate * 1_000);
      const speech = { audio, durationMs, engine: result.engine, warning: result.warning };
      cacheSpeech(cacheKey, speech);
      sendSpeech(res, speech, voice, "MISS", result.ms);
    } catch (error) {
      const message = controller.signal.aborted ? "Narration was cancelled" : error instanceof Error ? error.message : String(error);
      if (!res.headersSent) res.status(controller.signal.aborted ? 499 : 503).json({ error: message });
    } finally {
      clearTimeout(timer);
      pending = Math.max(0, pending - 1);
    }
  });
}

export function stopCreatorTtsWorker() {
  // Creator narration shares the persistent voice worker; server shutdown owns it.
}
