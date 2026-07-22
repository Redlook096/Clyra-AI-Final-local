import type { Server as HttpServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { nextSemanticPhrase, normalizeSpokenText } from "../../../src/lib/voiceSpeech";
import { encodeVoicePcmPacket } from "../../../src/lib/voicePcmPacket";
import { buildVoiceSystemPrompt } from "../../../lib/clyraVoicePrompt";
import { AsyncVoiceSession } from "../async/async-voice-session";
import { AsyncSttSession } from "../async/async-stt-session";
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
  asyncVoice: AsyncVoiceSession | null;
  asyncStt: AsyncSttSession | null;
  asyncSttSpeechAt: number;
  asyncSttFlushTimer: ReturnType<typeof setTimeout> | null;
  asyncSttFallbackInProgress: boolean;
  asyncSttProviderUnavailable: boolean;
  /** Recent PCM retained only for the current utterance so hosted STT can
   * hand the same audio to the local worker when it never yields a final. */
  pendingAudio: Array<{ data: string; seq: number }>;
  asyncContextId: string | null;
  ttsFormatSent: boolean;
};

const sockets = new Map<string, ActiveSocket>();

/** User must talk continuously this long before interrupting the assistant. */
const BARGE_HOLD_MS = Number(process.env.VOICE_BARGE_HOLD_MS ?? 700);
const TTS_FLUSH_MS = Number(process.env.VOICE_TTS_FLUSH_MS ?? 120);

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
  const sendLocalPipelineAudio = async () => {
    const rendered = await synthesizeViaPipeline(spoken, signal, { timeoutMs: 12_000 });
    if (!rendered.chunks.length || signal.aborted) return false;
    const config = loadVoiceConfig();
    send(active.ws, {
      type: "tts_format",
      sessionId: active.sessionId,
      responseId: active.responseId,
      generation: active.generation,
      sampleRate: rendered.sampleRate || config.sampleRate,
      codec: "pcm16",
    });
    active.ttsFormatSent = true;
    for (const chunk of rendered.chunks) {
      if (signal.aborted || active.ws.readyState !== active.ws.OPEN) return false;
      active.ws.send(encodeVoicePcmPacket(Buffer.from(chunk, "base64"), {
        sessionId: active.sessionId,
        responseId: active.responseId,
        generation: active.generation,
        sampleRate: rendered.sampleRate || config.sampleRate,
        sequence: active.ttsSeq++,
        phraseSequence: active.phraseSeq,
      }), { binary: true });
    }
    active.phraseSeq += 1;
    return true;
  };
  try {
    const config = loadVoiceConfig();
    const contextId = active.asyncContextId || active.responseId;
    if (!active.asyncVoice || !contextId) return await sendLocalPipelineAudio();
    if (!active.ttsFormatSent) {
      send(active.ws, {
        type: "tts_format",
        sessionId: active.sessionId,
        responseId: active.responseId,
        generation: active.generation,
        sampleRate: config.asyncSampleRate,
        codec: "pcm16",
      });
      active.ttsFormatSent = true;
    }
    // Start the first complete phrase immediately, then keep appending later
    // phrases to the same provider context.  Forcing every partial phrase can
    // make Flash finalise a context mid-answer and truncate playback.
    await active.asyncVoice.sendText(contextId, spoken, active.phraseSeq === 0);
    if (await active.asyncVoice.waitForFirstAudio(contextId)) {
      active.phraseSeq += 1;
      return true;
    }
    active.asyncVoice.cancelContext(contextId);
    return await sendLocalPipelineAudio();
  } catch (error) {
    console.warn(
      "[voice] Async TTS failed:",
      error instanceof Error ? error.message : error,
    );
    try {
      return await sendLocalPipelineAudio();
    } catch (fallbackError) {
      console.warn("[voice] Local TTS fallback failed:", fallbackError instanceof Error ? fallbackError.message : fallbackError);
      return false;
    }
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
  active.asyncContextId = active.responseId;
  active.ttsFormatSent = false;
  const { signal } = active.aborted;

  const session = voiceSessions.get(sessionId);
  if (session?.mode === "dictation") {
    voiceSessions.appendMessage(sessionId, "user", clean);
    voiceSessions.update(sessionId, { status: "listening" });
    send(ws, {
      type: "dictation_final",
      sessionId,
      text: clean,
      confidence: 0.92,
    });
    return;
  }
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
        // Empty/failed Async output stops this response's TTS attempts.
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
    if (active.asyncVoice && active.asyncContextId) {
      await active.asyncVoice.closeContext(active.asyncContextId).catch((error) => {
        send(ws, {
          type: "error",
          sessionId,
          message: error instanceof Error ? error.message : "Async voice output failed",
        });
      });
    }
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

function pcmHasSpeech(base64: string) {
  const pcm = Buffer.from(base64, "base64");
  if (pcm.length < 4) return false;
  let total = 0;
  const samples = Math.floor(pcm.length / 2);
  for (let index = 0; index < pcm.length - 1; index += 2) {
    const value = pcm.readInt16LE(index) / 32768;
    total += value * value;
  }
  return Math.sqrt(total / samples) > 0.014;
}

function resetAsyncStt(active: ActiveSocket) {
  if (active.asyncSttFlushTimer) clearTimeout(active.asyncSttFlushTimer);
  active.asyncSttFlushTimer = null;
  active.asyncStt?.close();
  active.asyncStt = null;
  active.asyncSttSpeechAt = 0;
}

async function replayPendingAudioToPipeline(active: ActiveSocket) {
  const frames = active.pendingAudio.splice(0);
  await attachPipeline(active);
  for (const frame of frames) active.pipeline?.sendAudio(frame.data, frame.seq);
  active.pipeline?.flush();
}

function attachAsyncStt(active: ActiveSocket, config: ReturnType<typeof loadVoiceConfig>) {
  if (!config.asyncApiKey || !config.asyncSttEnabled || active.asyncSttProviderUnavailable) return false;
  active.pipelineMode = true;
  const createTurn = () => new AsyncSttSession({
    apiKey: config.asyncApiKey,
    modelId: config.asyncSttModel,
    sampleRate: config.sampleRate,
    onPartial: (text) => {
      voiceMetrics.record(active.sessionId, "stt_partial", 0);
      send(active.ws, { type: "transcript_partial", sessionId: active.sessionId, text });
    },
    onFinal: (text) => {
      voiceMetrics.record(active.sessionId, "stt_final", 0);
      resetAsyncStt(active);
      active.pendingAudio = [];
      void handleFinalTranscript(active.sessionId, active.ws, text);
    },
    onError: (message) => {
      if (!active.busy) console.warn("[voice] Async STT:", message);
    },
  });
  active.asyncStt = createTurn();
  return true;
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
    asyncVoice: null,
    asyncStt: null,
    asyncSttSpeechAt: 0,
    asyncSttFlushTimer: null,
    asyncSttFallbackInProgress: false,
    asyncSttProviderUnavailable: false,
    pendingAudio: [],
    asyncContextId: null,
    ttsFormatSent: false,
  };
  active.asyncVoice = new AsyncVoiceSession({
    apiKey: config.asyncApiKey,
    modelId: config.asyncModel,
    fallbackModelId: config.asyncFallbackModel,
    voiceId: config.asyncVoiceId,
    sampleRate: config.asyncSampleRate,
    language: "en",
    onAudio: (chunk) => {
      const current = sockets.get(sessionId);
      if (!current || current !== active || chunk.contextId !== current.asyncContextId) return;
      if (current.aborted.signal.aborted || current.ws.readyState !== current.ws.OPEN) return;
      const packet = encodeVoicePcmPacket(Buffer.from(chunk.audio, "base64"), {
        sessionId,
        responseId: current.responseId,
        generation: current.generation,
        sampleRate: config.asyncSampleRate,
        sequence: current.ttsSeq++,
        phraseSequence: current.phraseSeq,
      });
      current.ws.send(packet, { binary: true });
      if (current.ttsSeq === 1) voiceMetrics.record(sessionId, "tts_chunk", 0);
    },
    onError: (message) => {
      // Async is preferred, but a live call continues through the local TTS
      // fallback when the hosted socket is slow or unavailable.
      console.warn("[voice] Hosted TTS:", message);
    },
  });
  sockets.set(sessionId, active);

  void (async () => {
    void active.asyncVoice?.connect().catch((error) => {
      send(ws, {
        type: "error",
        sessionId,
        message: error instanceof Error ? error.message : "Async voice could not connect.",
      });
    });
    if (!attachAsyncStt(active, config)) await attachPipeline(active);
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
      if (message.muted) resetAsyncStt(current);
      return;
    }

    if (message.type === "barge_in") {
      if (current.asyncContextId) current.asyncVoice?.cancelContext(current.asyncContextId);
      current.aborted.abort();
      current.generation += 1;
      current.busy = false;
      current.playbackHold = false;
      current.bargeSpeechMs = 0;
      current.pendingBargeText = null;
      current.asyncContextId = null;
      current.pipeline?.bargeIn();
      resetAsyncStt(current);
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
      if (current.asyncStt) {
        current.pendingAudio.push({ data: message.data, seq: message.seq });
        // Bound a pathological open mic to roughly 24 seconds at a 20ms
        // capture cadence; the newest frames remain the useful fallback.
        if (current.pendingAudio.length > 1_200) current.pendingAudio.splice(0, current.pendingAudio.length - 1_200);
        const speech = pcmHasSpeech(message.data);
        if (speech) {
          current.asyncSttSpeechAt = Date.now();
          if (current.asyncSttFlushTimer) clearTimeout(current.asyncSttFlushTimer);
          current.asyncSttFlushTimer = null;
        } else if (current.asyncSttSpeechAt && !current.asyncSttFlushTimer) {
          current.asyncSttFlushTimer = setTimeout(() => {
            const turn = current.asyncStt;
            if (!turn || current.busy || current.playbackHold) return;
            void turn.flush().then((text) => {
              if (text) return;
              resetAsyncStt(current);
              return replayPendingAudioToPipeline(current).catch(() => undefined);
            });
          }, 620);
        }
        void current.asyncStt.sendPcm(message.data).catch((error) => {
          // A provider handshake can fail while several 20ms mic packets are
          // already queued. Fall back once, rather than opening a local socket
          // for every packet and flooding the voice worker.
          if (current.asyncSttFallbackInProgress) return;
          current.asyncSttFallbackInProgress = true;
          current.asyncSttProviderUnavailable = true;
          console.warn("[voice] Async STT streaming failed; using local transcription:", error instanceof Error ? error.message : error);
          resetAsyncStt(current);
          void replayPendingAudioToPipeline(current)
            .catch(() => undefined)
            .finally(() => { current.asyncSttFallbackInProgress = false; });
        });
      } else {
        current.pipeline?.sendAudio(message.data, message.seq);
      }
      return;
    }

    if (message.type === "flush") {
      if (current.asyncStt) {
        const turn = current.asyncStt;
        void turn.flush().then((text) => {
          if (!text && current.asyncStt === turn) {
            resetAsyncStt(current);
            return replayPendingAudioToPipeline(current).catch(() => undefined);
          }
        });
      } else current.pipeline?.flush();
      return;
    }
  });

  ws.on("close", () => {
    aborted.abort();
    active.pipeline?.close();
    active.asyncVoice?.close();
    resetAsyncStt(active);
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
  active.asyncVoice?.close();
  resetAsyncStt(active);
  active.ws.close();
  sockets.delete(sessionId);
}
