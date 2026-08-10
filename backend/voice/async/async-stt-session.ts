import { WebSocket } from "ws";

type AsyncSttMessage = {
  transcript?: string;
  text?: string;
  final?: boolean;
  is_final?: boolean;
  error_code?: string;
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
    if (message.error_code) {
      this.options.onError(message.message || message.error_code);
      return;
    }
    const text = (message.transcript || message.text || "").trim();
    if (!text) return;
    if (message.final || message.is_final) {
      this.finalText = text;
      this.options.onFinal(text);
    } else {
      this.options.onPartial(text);
    }
  }

  async sendPcm(base64: string) {
    await this.start();
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(Buffer.from(base64, "base64"), { binary: true });
  }

  async flush() {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return this.finalText;
    this.socket.send(JSON.stringify({ final: true }));
    await new Promise((resolve) => setTimeout(resolve, 160));
    return this.finalText;
  }

  close() {
    this.closed = true;
    this.socket?.close();
    this.socket = null;
  }
}
