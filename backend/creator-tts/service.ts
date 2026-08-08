import type express from "express";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { loadVoiceConfig } from "../voice/config";

const MAX_PENDING = 8;
const REQUEST_TIMEOUT_MS = 180_000;
const MAX_CACHE_ITEMS = 64;
const MAX_CACHE_BYTES = 32 * 1024 * 1024;
let pending = 0;
let cacheBytes = 0;

const CREATOR_VOICES = [
  "Max",
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
const execFileAsync = promisify(execFile);

const SYSTEM_VOICE_BY_CREATOR_VOICE: Record<CreatorVoiceName, string> = {
  Max: "Daniel",
  Ryan: "Daniel",
  Aiden: "Samantha",
  Aaron: "Daniel",
  Abigail: "Karen",
  Anaya: "Moira",
  Andy: "Daniel",
  Archer: "Tessa",
  Brian: "Daniel",
  Chloe: "Samantha",
  Dylan: "Daniel",
  Emmanuel: "Daniel",
  Ethan: "Daniel",
  Evelyn: "Karen",
  Gavin: "Daniel",
  Gordon: "Daniel",
  Ivan: "Daniel",
  Laura: "Samantha",
  Lucy: "Karen",
  Madison: "Samantha",
  Marisol: "Moira",
  Meera: "Karen",
  Walter: "Daniel",
};

function environmentVoiceKey(voice: CreatorVoiceName) {
  return voice.replace(/[^a-z0-9]+/gi, "_").toUpperCase();
}

function resolveVoice(value: unknown): CreatorVoiceName {
  return typeof value === "string" && (CREATOR_VOICES as readonly string[]).includes(value)
    ? value as CreatorVoiceName
    : "Max";
}

function configuredCreatorVoiceIds(): Record<string, string> {
  const configured: Record<string, string> = {};
  const raw = process.env.CREATOR_TTS_VOICE_IDS_JSON;
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      for (const [name, id] of Object.entries(parsed)) {
        if ((CREATOR_VOICES as readonly string[]).includes(name) && typeof id === "string" && id.trim()) {
          configured[name] = id.trim();
        }
      }
    } catch {
      // A malformed optional mapping must not make normal Creator exports fail.
    }
  }
  for (const voice of CREATOR_VOICES) {
    const value = process.env[`CREATOR_TTS_VOICE_${environmentVoiceKey(voice)}_ID`]?.trim();
    if (value) configured[voice] = value;
  }
  return configured;
}

function asyncVoiceIdFor(voice: CreatorVoiceName, defaultVoiceId: string) {
  const configured = configuredCreatorVoiceIds();
  if (configured[voice]) return configured[voice]!;
  // ASYNC_VOICE_ID has historically meant Max (see .env.example), not every
  // arbitrary Creator persona.  Reusing it for Ryan/Aiden was why grey and
  // blue messages sounded identical despite the two VoicePicker controls.
  const defaultVoiceName = String(process.env.ASYNC_VOICE_NAME || "Max").trim();
  return voice === defaultVoiceName ? defaultVoiceId : "";
}

function wavDurationMs(audio: Buffer, fallbackRate: number) {
  if (audio.length < 44 || audio.toString("ascii", 0, 4) !== "RIFF") return 0;
  let offset = 12;
  let sampleRate = fallbackRate;
  let dataBytes = 0;
  while (offset + 8 <= audio.length) {
    const chunk = audio.toString("ascii", offset, offset + 4);
    const size = audio.readUInt32LE(offset + 4);
    if (chunk === "fmt " && offset + 16 <= audio.length) sampleRate = audio.readUInt32LE(offset + 12);
    if (chunk === "data") {
      dataBytes = Math.min(size, audio.length - offset - 8);
      break;
    }
    offset += 8 + size + (size % 2);
  }
  return dataBytes > 0 && sampleRate > 0 ? Math.round(dataBytes / 2 / sampleRate * 1_000) : 0;
}

function synthesizeLocalPlaceholderVoice(text: string, voice: CreatorVoiceName, sampleRate: number): CachedSpeech {
  // Offline/dev fallback so Fake Text / Creator exports still finish when Async
  // voice IDs are not configured (common in cloud agents / local Linux).
  const words = Math.max(1, text.trim().split(/\s+/).filter(Boolean).length);
  const durationMs = Math.min(8_000, Math.max(700, Math.round(words * 320)));
  const samples = Math.max(1, Math.round((sampleRate * durationMs) / 1_000));
  const pcm = Buffer.alloc(samples * 2);
  // Soft short tone bursts so the timeline has audible energy without speech.
  const freq = 220 + (CREATOR_VOICES.indexOf(voice) % 12) * 18;
  for (let i = 0; i < samples; i += 1) {
    const t = i / sampleRate;
    const envelope = Math.sin(Math.PI * Math.min(1, t / (durationMs / 1_000)));
    const burst = Math.sin(2 * Math.PI * freq * t) * 0.18 * envelope;
    const value = Math.max(-1, Math.min(1, burst));
    pcm.writeInt16LE((value * 0x7fff) | 0, i * 2);
  }
  return {
    audio: pcm16Wav(pcm, sampleRate),
    durationMs,
    engine: "local-placeholder",
    warning: `No dedicated hosted voice ID is configured for ${voice}; used a local timing placeholder so export can finish.`,
  };
}

async function synthesizeMacSystemVoice(text: string, voice: CreatorVoiceName, sampleRate: number): Promise<CachedSpeech> {
  if (process.platform !== "darwin") {
    return synthesizeLocalPlaceholderVoice(text, voice, sampleRate);
  }
  const directory = await mkdtemp(path.join(tmpdir(), "clyra-creator-tts-"));
  const input = path.join(directory, "speech.txt");
  const aiff = path.join(directory, "speech.aiff");
  const wav = path.join(directory, "speech.wav");
  const systemVoice = SYSTEM_VOICE_BY_CREATOR_VOICE[voice];
  try {
    await writeFile(input, text, "utf8");
    await execFileAsync("/usr/bin/say", ["-v", systemVoice, "-f", input, "-o", aiff]);
    await execFileAsync("/usr/bin/afconvert", ["-f", "WAVE", "-d", `LEI16@${sampleRate}`, aiff, wav]);
    const audio = await readFile(wav);
    if (audio.length < 128) throw new Error("The system voice returned an empty WAV file");
    return {
      audio,
      durationMs: wavDurationMs(audio, sampleRate),
      engine: `macos-say:${systemVoice}`,
      warning: `No dedicated hosted voice ID is configured for ${voice}; used the distinct local ${systemVoice} voice.`,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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
  app.get("/api/creator/tts/health", (_req, res) => {
    const config = loadVoiceConfig();
    const dedicatedVoices = Object.keys(configuredCreatorVoiceIds());
    const systemFallbackAvailable = process.platform === "darwin";
    const localPlaceholderAvailable = process.env.CREATOR_TTS_ALLOW_LOCAL_PLACEHOLDER !== "false";
    const baseVoice = String(process.env.ASYNC_VOICE_NAME || "Max").trim() || "Max";
    const availableVoices = CREATOR_VOICES.filter((voice) => (
      (voice === baseVoice && Boolean(config.asyncApiKey && config.asyncVoiceId))
      || dedicatedVoices.includes(voice)
      || systemFallbackAvailable
      || localPlaceholderAvailable
    ));
    res.json({
      ok: availableVoices.length > 0,
      engine: config.asyncApiKey
        ? "async+system-fallback"
        : systemFallbackAvailable
          ? "system-fallback"
          : "local-placeholder",
      model: config.asyncModel,
      voices: availableVoices,
      dedicatedVoices,
      systemFallbackAvailable,
      localPlaceholderAvailable,
      queueDepth: pending,
    });
  });

  app.post("/api/creator/tts", async (req, res) => {
    const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
    const voice = resolveVoice(req.body?.voice);
    if (!text || text.length > 600) {
      res.status(400).json({ error: "Text must contain 1 to 600 characters" });
      return;
    }
    const config = loadVoiceConfig();
    const asyncVoiceId = asyncVoiceIdFor(voice, config.asyncVoiceId);
    const canUseAsync = Boolean(config.asyncApiKey && asyncVoiceId);
    const canUseSystemVoice = process.platform === "darwin" && process.env.CREATOR_TTS_ALLOW_SYSTEM_FALLBACK !== "false";
    const canUseLocalPlaceholder = process.env.CREATOR_TTS_ALLOW_LOCAL_PLACEHOLDER !== "false";
    if (!canUseAsync && !canUseSystemVoice && !canUseLocalPlaceholder) {
      res.status(503).json({ error: `No dedicated Creator voice is configured for ${voice}. Add CREATOR_TTS_VOICE_${environmentVoiceKey(voice)}_ID.` });
      return;
    }
    const engineKey = canUseAsync
      ? `async:${asyncVoiceId}`
      : canUseSystemVoice
        ? `system:${SYSTEM_VOICE_BY_CREATOR_VOICE[voice]}`
        : "local-placeholder";
    const cacheKey = `${voice}\u0000${engineKey}\u0000${config.asyncModel}\u0000${text}`;
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
      const startedAt = performance.now();
      const requestSpeech = (modelId: string) => fetch("https://api.async.com/text_to_speech/streaming", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": config.asyncApiKey,
            version: "v1",
          },
          body: JSON.stringify({
            model_id: modelId,
            transcript: text,
            voice: { mode: "id", id: asyncVoiceId },
            output_format: {
              container: "raw",
              encoding: "pcm_s16le",
              sample_rate: config.asyncSampleRate,
            },
            language: "en",
          }),
          signal: controller.signal,
        });
      let speech: CachedSpeech;
      if (canUseAsync) {
        try {
          let response = await requestSpeech(config.asyncModel);
          if (!response.ok && config.asyncFallbackModel && config.asyncFallbackModel !== config.asyncModel) {
            response = await requestSpeech(config.asyncFallbackModel);
          }
          if (!response.ok) throw new Error(`Async narration failed (${response.status})`);
          const pcm = Buffer.from(await response.arrayBuffer());
          if (!pcm.length) throw new Error("Async narration returned no audio");
          const audio = pcm16Wav(pcm, config.asyncSampleRate);
          const durationMs = Math.round(pcm.length / 2 / config.asyncSampleRate * 1_000);
          speech = { audio, durationMs, engine: `async:${response.headers.get("x-async-model") || config.asyncModel}` };
        } catch (error) {
          if (canUseSystemVoice) speech = await synthesizeMacSystemVoice(text, voice, config.asyncSampleRate);
          else if (canUseLocalPlaceholder) speech = synthesizeLocalPlaceholderVoice(text, voice, config.asyncSampleRate);
          else throw error;
        }
      } else if (canUseSystemVoice) {
        speech = await synthesizeMacSystemVoice(text, voice, config.asyncSampleRate);
      } else {
        speech = synthesizeLocalPlaceholderVoice(text, voice, config.asyncSampleRate);
      }
      cacheSpeech(cacheKey, speech);
      sendSpeech(res, speech, voice, "MISS", performance.now() - startedAt);
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
