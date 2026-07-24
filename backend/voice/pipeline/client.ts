import WebSocket from "ws";
import { loadVoiceConfig } from "../config";

export type PipelineEvent =
  | {
      type: "ready";
      sessionId: string;
      sampleRate: number;
      ttsSampleRate?: number;
      sttModel?: string;
      vad?: string;
    }
  | {
      type: "transcript_partial";
      sessionId: string;
      text: string;
      confidence?: number;
      language?: string;
    }
  | {
      type: "transcript_final";
      sessionId: string;
      text: string;
      confidence?: number;
      language?: string;
      metrics?: { sttMs?: number };
    }
  | {
      type: "tts_chunk";
      sessionId: string;
      requestId?: string;
      codec: "pcm16";
      sampleRate?: number;
      data: string;
      seq: number;
    }
  | {
      type: "tts_done";
      sessionId: string;
      requestId?: string;
      metrics?: { ttsMs?: number };
    }
  | { type: "barge_in"; sessionId: string }
  | { type: "pong"; sessionId: string }
  | { type: "error"; message: string };

type Handlers = {
  onEvent: (event: PipelineEvent) => void;
  onClose?: () => void;
  onError?: (error: Error) => void;
};

function httpToWs(url: string) {
  return url.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
}

export class VoicePipelineClient {
  private ws: WebSocket | null = null;
  private sessionId: string;
  private handlers: Handlers;
  private ready = false;

  constructor(sessionId: string, handlers: Handlers) {
    this.sessionId = sessionId;
    this.handlers = handlers;
  }

  get isReady() {
    return this.ready && this.ws?.readyState === WebSocket.OPEN;
  }

  async connect() {
    const config = loadVoiceConfig();
    const base = config.pipelineUrl.replace(/\/$/, "");
    const wsUrl = `${httpToWs(base)}/stream`;
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      this.ws = ws;
      const timer = setTimeout(() => {
        reject(new Error("voice pipeline connect timeout"));
        try {
          ws.close();
        } catch {
          // ignore
        }
      }, 2500);

      ws.on("open", () => {
        ws.send(
          JSON.stringify({
            type: "session_start",
            sessionId: this.sessionId,
          }),
        );
      });

      ws.on("message", (raw) => {
        try {
          const event = JSON.parse(String(raw)) as PipelineEvent;
          if (event.type === "ready") {
            this.ready = true;
            clearTimeout(timer);
            resolve();
          }
          this.handlers.onEvent(event);
        } catch (error) {
          this.handlers.onError?.(
            error instanceof Error ? error : new Error("bad pipeline event"),
          );
        }
      });

      ws.on("error", (error) => {
        clearTimeout(timer);
        this.handlers.onError?.(error as Error);
        reject(error);
      });

      ws.on("close", () => {
        this.ready = false;
        this.handlers.onClose?.();
      });
    });
  }

  sendAudio(base64Pcm16: string, seq: number) {
    if (!this.isReady || !this.ws) return;
    this.ws.send(
      JSON.stringify({
        type: "audio",
        sessionId: this.sessionId,
        data: base64Pcm16,
        seq,
      }),
    );
  }

  flush() {
    if (!this.isReady || !this.ws) return;
    this.ws.send(
      JSON.stringify({
        type: "flush",
        sessionId: this.sessionId,
      }),
    );
  }

  setMuted(muted: boolean) {
    if (!this.isReady || !this.ws) return;
    this.ws.send(
      JSON.stringify({
        type: "mute",
        sessionId: this.sessionId,
        muted,
      }),
    );
  }

  bargeIn() {
    if (!this.isReady || !this.ws) return;
    this.ws.send(
      JSON.stringify({
        type: "barge_in",
        sessionId: this.sessionId,
      }),
    );
  }

  requestTts(text: string, requestId: string) {
    if (!this.isReady || !this.ws) return;
    const config = loadVoiceConfig();
    this.ws.send(
      JSON.stringify({
        type: "tts",
        sessionId: this.sessionId,
        text,
        voice: config.ttsVoice,
        sampleRate: config.sampleRate,
        requestId,
      }),
    );
  }

  close() {
    if (!this.ws) return;
    try {
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: "end", sessionId: this.sessionId }));
      }
      this.ws.close();
    } catch {
      // ignore
    }
    this.ws = null;
    this.ready = false;
  }
}

export async function probeVoicePipeline(): Promise<{
  ok: boolean;
  detail?: Record<string, unknown>;
}> {
  const config = loadVoiceConfig();
  try {
    const response = await fetch(`${config.pipelineUrl.replace(/\/$/, "")}/health`, {
      signal: AbortSignal.timeout(1200),
    });
    if (!response.ok) return { ok: false };
    const detail = (await response.json()) as Record<string, unknown>;
    return { ok: true, detail };
  } catch {
    return { ok: false };
  }
}

/** Fast HTTP TTS used for sentence-level streaming from the Node gateway. */
export async function synthesizeViaPipeline(
  text: string,
  signal?: AbortSignal,
  options?: { voice?: string; timeoutMs?: number },
): Promise<{ chunks: string[]; sampleRate: number; ms: number; engine: string; warning?: string }> {
  const config = loadVoiceConfig();
  const ttsRate = Number(process.env.VOICE_TTS_SAMPLE_RATE ?? config.sampleRate);
  const response = await fetch(`${config.pipelineUrl.replace(/\/$/, "")}/tts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text,
      voice: options?.voice || config.ttsVoice,
      sampleRate: ttsRate,
    }),
    signal: signal ?? AbortSignal.timeout(options?.timeoutMs ?? Number(process.env.VOICE_TTS_TIMEOUT_MS ?? 8000)),
  });
  if (!response.ok) throw new Error(`tts http ${response.status}`);
  const payload = (await response.json()) as {
    chunks?: string[];
    sampleRate?: number;
    ms?: number;
    engine?: string;
    warning?: string;
  };
  return {
    chunks: payload.chunks ?? [],
    sampleRate: payload.sampleRate ?? ttsRate,
    ms: payload.ms ?? 0,
    engine: payload.engine ?? "chatterbox-turbo",
    warning: payload.warning,
  };
}
