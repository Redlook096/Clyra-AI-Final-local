import { WebSocket } from "ws";

export type AsyncVoiceAudioChunk = {
  contextId: string;
  audio: string;
  final: boolean;
};

type ContextState = {
  cancelled: boolean;
  closing: boolean;
  initialized: boolean;
  providerContextId: string | null;
  receivedAudio: boolean;
  resolveFirstAudio: (() => void) | null;
  resolveFinal: (() => void) | null;
};

export type AsyncVoiceSessionOptions = {
  apiKey: string;
  modelId: string;
  fallbackModelId?: string;
  voiceId: string;
  sampleRate: number;
  language?: string;
  onAudio: (chunk: AsyncVoiceAudioChunk) => void;
  onError: (message: string) => void;
};

const ASYNC_TTS_ENDPOINT = "wss://api.async.com/text_to_speech/websocket/ws";
const CONNECT_TIMEOUT_MS = 8_000;
const MAX_RECONNECTS = 3;
const MAX_TRANSCRIPT_CHARS = 2_400;

function transcriptChunk(value: string) {
  return value.replace(/\s+/g, " ").trim().slice(0, MAX_TRANSCRIPT_CHARS);
}

/**
 * One warm Async socket per local voice call. The API key is used only here,
 * on the Node server, and is never included in messages sent to the browser.
 */
export class AsyncVoiceSession {
  private socket: WebSocket | null = null;
  private connectPromise: Promise<void> | null = null;
  private closed = false;
  private reconnects = 0;
  private contexts = new Map<string, ContextState>();
  private providerContexts = new Map<string, string>();
  private initialProviderContextId: string | null = null;
  private connectTimeout: ReturnType<typeof setTimeout> | null = null;
  private resolveConnection: (() => void) | null = null;
  private rejectConnection: ((error: Error) => void) | null = null;

  constructor(private readonly options: AsyncVoiceSessionOptions) {}

  get configured() {
    return Boolean(this.options.apiKey && this.options.voiceId);
  }

  async connect() {
    if (!this.configured) throw new Error("Async Voice API is not configured.");
    if (this.closed) throw new Error("Async voice session has ended.");
    if (this.socket?.readyState === WebSocket.OPEN) return;
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = new Promise<void>((resolve, reject) => {
      const endpoint = new URL(ASYNC_TTS_ENDPOINT);
      endpoint.searchParams.set("api_key", this.options.apiKey);
      endpoint.searchParams.set("version", "v1");
      const socket = new WebSocket(endpoint);
      this.socket = socket;
      this.connectTimeout = setTimeout(() => {
        socket.terminate();
        reject(new Error("Async voice connection timed out."));
      }, CONNECT_TIMEOUT_MS);
      this.resolveConnection = () => {
        if (this.connectTimeout) clearTimeout(this.connectTimeout);
        this.connectTimeout = null;
        this.resolveConnection = null;
        this.rejectConnection = null;
        resolve();
      };
      this.rejectConnection = (error) => {
        if (this.connectTimeout) clearTimeout(this.connectTimeout);
        this.connectTimeout = null;
        this.resolveConnection = null;
        this.rejectConnection = null;
        reject(error);
      };

      socket.once("open", () => {
        this.reconnects = 0;
        socket.send(JSON.stringify({
          model_id: this.options.modelId,
          voice: { mode: "id", id: this.options.voiceId },
          output_format: {
            container: "raw",
            encoding: "pcm_s16le",
            sample_rate: this.options.sampleRate,
          },
          language: this.options.language ?? "en",
        }));
      });

      socket.on("message", (raw) => this.handleMessage(String(raw)));
      socket.on("error", (error) => {
        if (this.connectTimeout) clearTimeout(this.connectTimeout);
        const message = error instanceof Error ? error.message : "Async voice connection failed.";
        if (socket.readyState !== WebSocket.OPEN) this.rejectConnection?.(new Error(message));
        else this.options.onError(message);
      });
      socket.on("close", () => {
        if (this.connectTimeout) clearTimeout(this.connectTimeout);
        this.rejectConnection?.(new Error("Async voice connection closed during setup."));
        if (this.socket === socket) this.socket = null;
        if (!this.closed && this.contexts.size > 0) void this.reconnect();
      });
    }).finally(() => {
      this.connectPromise = null;
    });

    return this.connectPromise;
  }

  private async reconnect() {
    if (this.closed || this.reconnects >= MAX_RECONNECTS) {
      this.options.onError("Async voice connection could not be restored.");
      return;
    }
    const delay = Math.min(2_000, 250 * 2 ** this.reconnects);
    this.reconnects += 1;
    await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      await this.connect();
    } catch (error) {
      this.options.onError(error instanceof Error ? error.message : "Async voice reconnect failed.");
      void this.reconnect();
    }
  }

  private handleMessage(raw: string) {
    let message: {
      event?: string;
      context_id?: string;
      audio?: string;
      final?: boolean;
      error_code?: string;
      message?: string;
    };
    try {
      message = JSON.parse(raw) as typeof message;
    } catch {
      return;
    }
    if (message.error_code || (message.message && !message.context_id)) {
      const error = new Error(message.message || message.error_code || "Async voice generation failed.");
      if (this.rejectConnection) this.rejectConnection(error);
      else this.options.onError(error.message);
      return;
    }
    // Async creates the actual context ID during the init acknowledgement.
    // Our browser protocol uses its own response ID, so keep a mapping rather
    // than dropping provider audio simply because those identifiers differ.
    if (message.event === "init_ack" && message.context_id) {
      this.initialProviderContextId = message.context_id;
      this.resolveConnection?.();
      return;
    }
    const providerContextId = message.context_id;
    if (!providerContextId) return;
    const contextId = this.providerContexts.get(providerContextId);
    if (!contextId) return;
    const context = this.contexts.get(contextId);
    if (!context || context.cancelled) return;
    const final = message.final === true;
    if (message.audio) {
      context.receivedAudio = true;
      context.resolveFirstAudio?.();
      context.resolveFirstAudio = null;
      this.options.onAudio({ contextId, audio: message.audio, final });
    }
    // Flash can mark a streamed phrase as final before the application has
    // finished adding the remainder of the response.  Removing the mapping at
    // that point silently drops every later PCM packet, which sounded like the
    // assistant stopped halfway through a sentence.  Only retire a context
    // after *we* have explicitly closed the completed response.
    if (final && context.closing) {
      context.resolveFinal?.();
      context.resolveFinal = null;
      this.contexts.delete(contextId);
      this.providerContexts.delete(providerContextId);
    }
  }

  async sendText(contextId: string, value: string, force = false) {
    const transcript = transcriptChunk(value);
    if (!transcript) return;
    await this.connect();
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("Async voice socket is unavailable.");
    }
    let context = this.contexts.get(contextId);
    if (!context) {
      context = {
        cancelled: false,
        closing: false,
        initialized: false,
        providerContextId: this.initialProviderContextId,
        receivedAudio: false,
        resolveFirstAudio: null,
        resolveFinal: null,
      };
      this.contexts.set(contextId, context);
    }
    if (context.cancelled) return;
    const providerContextId = context.providerContextId;
    if (!providerContextId) throw new Error("Async voice did not return a synthesis context.");
    this.providerContexts.set(providerContextId, contextId);
    socket.send(JSON.stringify({
      context_id: providerContextId,
      transcript: `${transcript} `,
      // Flash buffers a new context until it is explicitly forced.  Applying
      // this to the first phrase is what makes conversational TTS begin
      // immediately instead of waiting until the context is closed.
      force,
    }));
    context.initialized = true;
  }

  /** Confirm a provider acknowledgement produced actual PCM within a bounded window. */
  async waitForFirstAudio(contextId: string, timeoutMs = 1_500) {
    const context = this.contexts.get(contextId);
    if (!context || context.cancelled) return false;
    if (context.receivedAudio) return true;
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        context.resolveFirstAudio = null;
        resolve(context.receivedAudio);
      }, timeoutMs);
      context.resolveFirstAudio = () => {
        clearTimeout(timer);
        resolve(true);
      };
    });
  }

  async closeContext(contextId: string, timeoutMs = 20_000) {
    const context = this.contexts.get(contextId);
    if (!context || context.cancelled) return;
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    // Flash needs a short turn to start emitting after its final phrase. A
    // close sent in the same microtask cancels pending synthesis and produces
    // a final event with no PCM, so wait for the first chunk when possible.
    if (!context.receivedAudio) {
      await Promise.race([
        new Promise<void>((resolve) => {
          context.resolveFirstAudio = resolve;
        }),
        new Promise<void>((resolve) => setTimeout(resolve, 900)),
      ]);
      context.resolveFirstAudio = null;
    }
    context.closing = true;
    const final = new Promise<void>((resolve) => {
      context.resolveFinal = resolve;
    });
    socket.send(JSON.stringify({
      context_id: context.providerContextId,
      close_context: true,
      transcript: "",
    }));
    await Promise.race([
      final,
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
    this.contexts.delete(contextId);
    if (context.providerContextId) this.providerContexts.delete(context.providerContextId);
  }

  cancelContext(contextId: string) {
    const context = this.contexts.get(contextId);
    if (context) {
      context.cancelled = true;
      context.resolveFinal?.();
      context.resolveFinal = null;
    }
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({
        context_id: context?.providerContextId ?? contextId,
        close_context: true,
        transcript: "",
      }));
    }
    this.contexts.delete(contextId);
    if (context?.providerContextId) this.providerContexts.delete(context.providerContextId);
  }

  close() {
    this.closed = true;
    for (const [contextId] of this.contexts) this.cancelContext(contextId);
    if (this.socket?.readyState === WebSocket.OPEN) {
      // Async documents both `{ terminate: true }` and `{ text: "" }` as
      // graceful connection-close frames. The current production validator
      // applies the regular transcript schema to the terminate form, so use
      // the empty-text form to close without an avoidable protocol error.
      this.socket.send(JSON.stringify({ text: "" }));
    }
    this.socket?.close();
    this.socket = null;
    this.contexts.clear();
    this.providerContexts.clear();
    this.initialProviderContextId = null;
  }
}
