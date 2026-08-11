import { WebSocket } from "ws";

type AsyncSttMessage = {
  type?: "interim" | "done" | "error";
  transcript?: string;
  text?: string;
  final?: boolean;
  is_final?: boolean;
  error_code?: string;
  error?: string;
  message?: string;
};

type AsyncSttSessionOptions = {
  apiKey: string;
  modelId: string;
  sampleRate: number;
  onPartial: (text: string) => void;
  onFinal: (text: string) => void;
  onError: (message: string) => void;
};

const ENDPOINT = "wss://api.async.com/speech_to_text/stream";
// Hosted ASR final packets occasionally arrive just after the silence turn has
// been closed. Giving that packet a short grace period avoids unnecessarily
// replaying the utterance through the slower local fallback.
const FINAL_GRACE_MS = Math.max(160, Number(process.env.ASYNC_STT_FINAL_GRACE_MS ?? 360));

/**
 * Short-lived, server-owned Async ASR socket. A socket corresponds to one
 * utterance so `{ final: true }` is deterministic and the browser never sees
 * an API credential.
 */
export class AsyncSttSession {
  private socket: WebSocket | null = null;
  private opening: Promise<void> | null = null;
  private closed = false;
  private finalText = "";
  private pcmBuffer = Buffer.alloc(0);

  private get minimumPacketBytes() {
    // Async recommends 250–500ms PCM packets. The application still captures
    // in 20ms slices for responsive VAD; batching happens only at this hosted
    // transport boundary and avoids starving the recognizer with tiny frames.
    return Math.max(4_000, Math.round(this.options.sampleRate * 2 * 0.25));
  }

  constructor(private readonly options: AsyncSttSessionOptions) {}

  async start() {
    if (!this.options.apiKey) throw new Error("Async Speech-to-Text is not configured.");
    if (this.socket?.readyState === WebSocket.OPEN) return;
    if (this.opening) return this.opening;
    this.closed = false;
    this.opening = new Promise<void>((resolve, reject) => {
      const endpoint = new URL(ENDPOINT);
      endpoint.searchParams.set("api_key", this.options.apiKey);
      endpoint.searchParams.set("model_id", this.options.modelId);
      endpoint.searchParams.set("sample_rate", String(this.options.sampleRate));
      endpoint.searchParams.set("language", "en");
      const socket = new WebSocket(endpoint);
      this.socket = socket;
      const timeout = setTimeout(() => {
        socket.terminate();
        reject(new Error("Async transcription connection timed out."));
      }, 8_000);
      socket.once("open", () => {
        clearTimeout(timeout);
        resolve();
      });
      socket.on("message", (raw) => this.handleMessage(String(raw)));
      socket.once("error", (error) => {
        clearTimeout(timeout);
        if (socket.readyState !== WebSocket.OPEN) reject(error);
        else this.options.onError(error.message);
      });
      socket.once("close", () => {
        clearTimeout(timeout);
        if (this.socket === socket) this.socket = null;
      });
    }).finally(() => { this.opening = null; });
    return this.opening;
  }

  private handleMessage(raw: string) {
    let message: AsyncSttMessage;
    try { message = JSON.parse(raw) as AsyncSttMessage; } catch { return; }
    if (message.type === "error" || message.error_code || message.error) {
      this.options.onError(message.message || message.error || message.error_code || "Async transcription failed.");
      return;
    }
    const text = (message.transcript || message.text || "").trim();
    if (!text) return;
    if (message.type === "done" || message.final || message.is_final) {
      this.finalText = text;
      this.options.onFinal(text);
    } else {
      this.options.onPartial(text);
    }
  }

  async sendPcm(base64: string) {
    await this.start();
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    const chunk = Buffer.from(base64, "base64");
    if (!chunk.length) return;
    this.pcmBuffer = this.pcmBuffer.length
      ? Buffer.concat([this.pcmBuffer, chunk])
      : chunk;
    while (this.pcmBuffer.length >= this.minimumPacketBytes) {
      this.socket.send(this.pcmBuffer.subarray(0, this.minimumPacketBytes), { binary: true });
      this.pcmBuffer = this.pcmBuffer.subarray(this.minimumPacketBytes);
    }
  }

  async flush() {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return this.finalText;
    if (this.pcmBuffer.length) {
      this.socket.send(this.pcmBuffer, { binary: true });
      this.pcmBuffer = Buffer.alloc(0);
    }
    this.socket.send(JSON.stringify({ final: true }));
    await new Promise((resolve) => setTimeout(resolve, FINAL_GRACE_MS));
    return this.finalText;
  }

  close() {
    this.closed = true;
    this.socket?.close();
    this.socket = null;
    this.pcmBuffer = Buffer.alloc(0);
  }
}
