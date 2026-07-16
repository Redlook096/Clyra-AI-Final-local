import type { Server as HttpServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { nextSemanticPhrase, normalizeSpokenText } from "../../../src/lib/voiceSpeech";
import { encodeVoicePcmPacket } from "../../../src/lib/voicePcmPacket";
import { buildVoiceSystemPrompt } from "../../../lib/clyraVoicePrompt";
import { loadVoiceConfig } from "../config";
import { voiceMetrics } from "../metrics/voice-metrics";
import {
  probeVoicePipeline,
  synthesizeViaPipeline,
  VoicePipelineClient,
} from "../pipeline/client";
import { voiceSessions } from "../session/voice-session-manager";
import {
  encodeVoiceServerMessage,
  parseVoiceClientMessage,
  type VoiceServerMessage,
} from "./voice-stream-protocol";

type ActiveSocket = {
  ws: WebSocket;
  sessionId: string;
  aborted: AbortController;
  busy: boolean;
  /** True from thinking until client playback_done / barge — blocks echo turn-taking. */
  playbackHold: boolean;
  pipeline: VoicePipelineClient | null;
  pipelineMode: boolean;
  spokenChars: number;
  ttsSeq: number;
  /** Continuous user-speech ms while hold is active (server-side barge gate). */
  bargeSpeechMs: number;
  pendingBargeText: string | null;
  generation: number;
  responseId: string;
  phraseSeq: number;
};

const sockets = new Map<string, ActiveSocket>();

/** User must talk continuously this long before interrupting the assistant. */
const BARGE_HOLD_MS = Number(process.env.VOICE_BARGE_HOLD_MS ?? 700);
const TTS_FLUSH_MS = Number(process.env.VOICE_TTS_FLUSH_MS ?? 120);

/** Skip slow pipeline probes after a recent failure. */
let pipelineTtsUnavailableUntil = 0;
let pipelineHealthCache: { ok: boolean; at: number } = { ok: false, at: 0 };

function send(ws: WebSocket, message: VoiceServerMessage) {
  if (ws.readyState === ws.OPEN) {
    ws.send(encodeVoiceServerMessage(message));
  }
}

function nextSpeakable(full: string, from: number) {
  return nextSemanticPhrase(full, from, {
    minWords: 8,
    preferredWords: 14,
    maxWords: 28,
  });
}

async function streamLlmReply(
  sessionId: string,
  prompt: string,
  history: Array<{ role: "user" | "assistant"; content: string }>,
  onToken: (token: string) => void,
  signal: AbortSignal,
) {
  const config = loadVoiceConfig();
  const session = voiceSessions.get(sessionId);
  if (!config.llmApiKey) {
    throw new Error("LLM API key is not configured on the server.");
  }
  const started = Date.now();
  const systemPrompt =
    session?.systemPrompt?.trim() || buildVoiceSystemPrompt();
  const temperature = session?.temperature ?? config.temperature;
  const response = await fetch(`${config.llmBaseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.llmApiKey}`,
    },
    body: JSON.stringify({
      model: config.llmModel,
      temperature,
      max_tokens: Math.min(Math.max(config.maxTokens, 80), 220),
      stream: true,
      messages: [
        { role: "system", content: systemPrompt },
        ...history.slice(-20).map((msg) => ({
          role: msg.role,
          content: msg.content,
        })),
        { role: "user", content: prompt },
      ],
    }),
    signal,
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`LLM upstream failed (${response.status})${detail ? `: ${detail.slice(0, 160)}` : ""}`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("LLM stream unavailable");
  const decoder = new TextDecoder();
  let buffer = "";
  let firstToken = true;
  while (true) {
    if (signal.aborted) {
      reader.cancel().catch(() => undefined);
      break;
    }
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const json = JSON.parse(payload) as {
          choices?: Array<{ delta?: { content?: string } }>;
        };
        const token = json.choices?.[0]?.delta?.content;
        if (token) {
          if (firstToken) {
            voiceMetrics.record(sessionId, "llm_token", Date.now() - started);
            firstToken = false;
          }
          onToken(token);
        }
      } catch {
        // ignore malformed chunks
      }
    }
  }
}

async function speakText(
  active: ActiveSocket,
  text: string,
  signal: AbortSignal,
): Promise<boolean> {
  const spoken = normalizeSpokenText(text);
  if (!spoken || signal.aborted) return false;
  if (Date.now() < pipelineTtsUnavailableUntil) return false;

  try {
    const started = Date.now();
    const { chunks, sampleRate } = await synthesizeViaPipeline(spoken, signal);
    // Empty audio is reported to the client. Browser TTS is an explicit
    // operator-enabled emergency mode, never a silent engine substitution.
    // Do NOT start a cooldown; that silenced multi-sentence replies.
    if (!chunks.length) return false;
    if (active.ttsSeq === 0) {
      send(active.ws, {
        type: "tts_format",
        sessionId: active.sessionId,
        responseId: active.responseId,
        generation: active.generation,
        sampleRate,
        codec: "pcm16",
      });
    }
    const phraseSequence = active.phraseSeq++;
    for (const chunk of chunks) {
      if (signal.aborted) return false;
      const packet = encodeVoicePcmPacket(Buffer.from(chunk, "base64"), {
        sessionId: active.sessionId,
        responseId: active.responseId,
        generation: active.generation,
        sampleRate,
        sequence: active.ttsSeq++,
        phraseSequence,
      });
      if (active.ws.readyState === active.ws.OPEN) active.ws.send(packet, { binary: true });
    }
    voiceMetrics.record(active.sessionId, "tts_chunk", Date.now() - started);
    return true;
  } catch (error) {
    // Short cooldown only for transport/HTTP failures, not empty audio.
    pipelineTtsUnavailableUntil = Date.now() + 2_000;
    console.warn(
      "[voice] pipeline TTS failed:",
      error instanceof Error ? error.message : error,
    );
    return false;
  }
}

async function handleFinalTranscript(sessionId: string, ws: WebSocket, text: string) {
  const active = sockets.get(sessionId);
  if (!active) return;
  const clean = text.trim();
  if (!clean) return;

  if (active.busy || active.playbackHold) {
    // Echo / keyboard clicks must not steal the floor. Client only unlocks via
    // barge_in after VOICE_BARGE_HOLD_MS of continuous user speech.
    return;
  }

  active.busy = true;
  active.playbackHold = true;
  active.bargeSpeechMs = 0;
  active.pendingBargeText = null;
  active.aborted = new AbortController();
  active.spokenChars = 0;
  active.ttsSeq = 0;
  active.phraseSeq = 0;
  active.generation += 1;
  active.responseId = `${sessionId}-${active.generation}-${Date.now()}`;
  const { signal } = active.aborted;

  const session = voiceSessions.get(sessionId);
  const history = [...(session?.messages ?? [])];
  voiceSessions.appendMessage(sessionId, "user", clean);
  voiceSessions.update(sessionId, { status: "thinking" });
  send(ws, {
    type: "transcript_final",
    sessionId,
    text: clean,
    confidence: 0.92,
  });
  send(ws, { type: "status", sessionId, status: "thinking" });

  let assistant = "";
  let speakingStarted = false;
  let pipelineTtsSkipped = false;
  let flushChain: Promise<void> = Promise.resolve();
  let flushTimer: NodeJS.Timeout | null = null;
  const flushSpeakable = async (finalize: boolean) => {
    if (pipelineTtsSkipped) return;
    while (true) {
      if (signal.aborted) return;
      const chunk = finalize
        ? nextSemanticPhrase(assistant, active.spokenChars, { final: true })
        : nextSpeakable(assistant, active.spokenChars);
      if (!chunk) break;
      if (!speakingStarted) {
        speakingStarted = true;
        voiceSessions.update(sessionId, { status: "speaking" });
        send(ws, { type: "status", sessionId, status: "speaking" });
      }
      const ok = await speakText(active, chunk.text, signal);
      if (ok) active.spokenChars = chunk.nextIndex;
      else {
        // Empty/failed Chatterbox output stops this response's TTS attempts.
        pipelineTtsSkipped = true;
        break;
      }
    }
    if (finalize && !pipelineTtsSkipped) {
      const tail = assistant.slice(active.spokenChars).trim();
      if (tail) {
        if (!speakingStarted) {
          speakingStarted = true;
          voiceSessions.update(sessionId, { status: "speaking" });
          send(ws, { type: "status", sessionId, status: "speaking" });
        }
        const ok = await speakText(active, tail, signal);
        if (ok) active.spokenChars = assistant.length;
        else pipelineTtsSkipped = true;
      }
    }
  };
  const scheduleFlush = (finalize: boolean) => {
    if (flushTimer) clearTimeout(flushTimer);
    const run = () => {
      flushTimer = null;
      flushChain = flushChain.then(() => flushSpeakable(finalize)).catch(() => undefined);
    };
    if (finalize) run();
    else flushTimer = setTimeout(run, TTS_FLUSH_MS);
  };

  try {
    await streamLlmReply(
      sessionId,
      clean,
      history,
      (token) => {
        if (signal.aborted) return;
        assistant += token;
        send(ws, { type: "llm_token", sessionId, token });
        // Serialized sentence TTS while tokens continue.
        scheduleFlush(false);
      },
      signal,
    );
  } catch (error) {
    if (!signal.aborted) {
      send(ws, {
        type: "error",
        sessionId,
        message: error instanceof Error ? error.message : "LLM stream failed",
      });
      voiceSessions.update(sessionId, { status: "listening" });
      send(ws, { type: "status", sessionId, status: "listening" });
    }
    active.busy = false;
    active.playbackHold = false;
    return;
  }

  if (signal.aborted) {
    active.busy = false;
    active.playbackHold = false;
    return;
  }

  const reply = assistant.trim() || "I'm here — could you say that again?";
  voiceSessions.appendMessage(sessionId, "assistant", reply);
  send(ws, { type: "llm_done", sessionId, text: reply });
  scheduleFlush(true);
  await flushChain;

  if (!signal.aborted) {
    send(ws, { type: "tts_done", sessionId, responseId: active.responseId, generation: active.generation });
    // Keep playbackHold until client reports playback_done — prevents echo barges.
    voiceSessions.update(sessionId, { status: "speaking" });
    send(ws, { type: "status", sessionId, status: "speaking" });
  }
  active.busy = false;
}

async function attachPipeline(active: ActiveSocket) {
  const now = Date.now();
  // Only positive-cache health briefly; always re-check after failures.
  const cacheFresh = now - pipelineHealthCache.at < (pipelineHealthCache.ok ? 5000 : 0);
  if (!cacheFresh) {
    const health = await probeVoicePipeline();
    pipelineHealthCache = { ok: health.ok, at: now };
  }
  if (!pipelineHealthCache.ok) {
    // Still attempt WS connect — health may flap during model warmup.
  }

  const client = new VoicePipelineClient(active.sessionId, {
    onEvent: (event) => {
      if (event.type === "transcript_partial") {
        voiceMetrics.record(active.sessionId, "stt_partial", 0);
        send(active.ws, {
          type: "transcript_partial",
          sessionId: active.sessionId,
          text: event.text,
          confidence: event.confidence,
        });
        return;
      }
      if (event.type === "transcript_final") {
        voiceMetrics.record(
          active.sessionId,
          "stt_final",
          event.metrics?.sttMs ?? 0,
        );
        void handleFinalTranscript(active.sessionId, active.ws, event.text);
      }
    },
    onError: () => {
      active.pipelineMode = false;
    },
    onClose: () => {
      active.pipelineMode = false;
      active.pipeline = null;
    },
  });

  try {
    await client.connect();
    active.pipeline = client;
    active.pipelineMode = true;
    pipelineHealthCache = { ok: true, at: Date.now() };
  } catch {
    active.pipeline = null;
    active.pipelineMode = false;
    pipelineHealthCache = { ok: false, at: Date.now() };
  }
}

function attachSocketHandlers(sessionId: string, ws: WebSocket) {
  const config = loadVoiceConfig();
  const aborted = new AbortController();
  const active: ActiveSocket = {
    ws,
    sessionId,
    aborted,
    busy: false,
    playbackHold: false,
    pipeline: null,
    pipelineMode: false,
    spokenChars: 0,
    ttsSeq: 0,
    bargeSpeechMs: 0,
    pendingBargeText: null,
    generation: 0,
    responseId: "",
    phraseSeq: 0,
  };
  sockets.set(sessionId, active);

  void (async () => {
    await attachPipeline(active);
    send(ws, {
      type: "ready",
      sessionId,
      sampleRate: config.sampleRate,
    });
    // Inform client which capture path to use (extended field ignored safely by older clients).
    send(ws, {
      type: "status",
      sessionId,
      status: "listening",
    });
    if (active.pipelineMode) {
      ws.send(
        JSON.stringify({
          type: "pipeline_mode",
          sessionId,
          mode: "pipeline",
          sampleRate: config.sampleRate,
        }),
      );
    } else {
      ws.send(
        JSON.stringify({
          type: "pipeline_mode",
          sessionId,
          mode: "browser",
          sampleRate: config.sampleRate,
        }),
      );
    }
  })();

  ws.on("message", async (raw) => {
    const message = parseVoiceClientMessage(String(raw));
    if (!message || message.sessionId !== sessionId) return;
    const current = sockets.get(sessionId);
    if (!current) return;

    if (message.type === "ping") {
      send(ws, { type: "pong", sessionId });
      return;
    }

    if (message.type === "mute") {
      voiceSessions.update(sessionId, { muted: message.muted });
      current.pipeline?.setMuted(message.muted);
      return;
    }

    if (message.type === "barge_in") {
      current.aborted.abort();
      current.generation += 1;
      current.busy = false;
      current.playbackHold = false;
      current.bargeSpeechMs = 0;
      current.pendingBargeText = null;
      current.pipeline?.bargeIn();
      voiceMetrics.record(sessionId, "barge_in", BARGE_HOLD_MS);
      send(ws, { type: "barge_in", sessionId });
      voiceSessions.update(sessionId, { status: "listening" });
      send(ws, { type: "status", sessionId, status: "listening" });
      return;
    }

    if (message.type === "playback_done") {
      current.playbackHold = false;
      current.bargeSpeechMs = 0;
      if (!current.busy) {
        voiceSessions.update(sessionId, { status: "listening" });
        send(ws, { type: "status", sessionId, status: "listening" });
      }
      return;
    }

    if (message.type === "utterance") {
      await handleFinalTranscript(sessionId, ws, message.text);
      return;
    }

    if (message.type === "audio") {
      // While assistant holds the floor, ignore mic audio until client barge unlocks
      // (client also gates sends; this is a safety net against echo finals).
      if (current.playbackHold || current.busy) {
        return;
      }
      current.pipeline?.sendAudio(message.data, message.seq);
      return;
    }

    if (message.type === "flush") {
      current.pipeline?.flush();
      return;
    }
  });

  ws.on("close", () => {
    aborted.abort();
    active.pipeline?.close();
    sockets.delete(sessionId);
    voiceSessions.end(sessionId);
    voiceMetrics.clear(sessionId);
  });
}

export function attachVoiceWebSocket(server: HttpServer) {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url || "/", "http://localhost");
    if (url.pathname !== "/voice/stream") {
      return;
    }
    const sessionId = url.searchParams.get("sessionId");
    if (!sessionId || !voiceSessions.get(sessionId)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (upgraded) => {
      attachSocketHandlers(sessionId, upgraded);
    });
  });
}

export function closeVoiceSocket(sessionId: string) {
  const active = sockets.get(sessionId);
  if (!active) return;
  active.aborted.abort();
  active.pipeline?.close();
  active.ws.close();
  sockets.delete(sessionId);
}
