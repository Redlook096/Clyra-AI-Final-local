/**
 * Connects to a paired Mac's AppleHostServer. Runs identically on Windows,
 * Linux, or another Mac — it is a plain WebSocket JSON-RPC client, nothing
 * platform-specific. Owns reconnect-with-backoff (the "ReconnectManager"
 * role in the architecture) so a dropped LAN link or a restarted Apple Host
 * recovers without losing the paired session or creating a duplicate pair.
 */
import { WebSocket } from "ws";
import { saveHost, touchHost, type SavedHost } from "./DeviceRegistry";

type PendingCall = { resolve: (value: unknown) => void; reject: (error: Error) => void };

export type HostConnectionState = "disconnected" | "connecting" | "connected" | "reconnecting";

export class AppleHostClient {
  private ws: WebSocket | null = null;
  private state: HostConnectionState = "disconnected";
  private token: string | null = null;
  private pending = new Map<string, PendingCall>();
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closedByUser = false;

  constructor(private readonly url: string, private readonly hostLabel: string) {}

  getState() {
    return this.state;
  }

  /** First-time pairing: exchange a one-time code shown on the Mac for a durable session token. */
  async pair(pairingCode: string): Promise<void> {
    this.closedByUser = false;
    await this.connectWith({ pairingCode });
  }

  /** Reconnect using a previously saved token — no code re-entry. */
  async reconnect(savedHost: SavedHost): Promise<void> {
    this.closedByUser = false;
    this.token = savedHost.token;
    await this.connectWith({ token: savedHost.token });
  }

  disconnect() {
    this.closedByUser = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
    this.state = "disconnected";
  }

  private connectWith(auth: { pairingCode?: string; token?: string }): Promise<void> {
    this.state = this.reconnectAttempt > 0 ? "reconnecting" : "connecting";
    return new Promise((resolve, reject) => {
      const query = new URLSearchParams({
        ...(auth.pairingCode ? { pairingCode: auth.pairingCode } : {}),
        ...(auth.token ? { token: auth.token } : {}),
        hostLabel: this.hostLabel,
      });
      const ws = new WebSocket(`${this.url}?${query.toString()}`);
      this.ws = ws;

      const onFirstMessage = (raw: WebSocket.RawData) => {
        let message: { type?: string; token?: string; error?: string };
        try {
          message = JSON.parse(String(raw));
        } catch {
          return;
        }
        if (message.type === "paired" && message.token) {
          this.token = message.token;
          this.state = "connected";
          this.reconnectAttempt = 0;
          saveHost({ hostLabel: this.hostLabel, url: this.url, token: message.token, pairedAt: Date.now() });
          touchHost(this.url);
          ws.off("message", onFirstMessage);
          ws.on("message", (data) => this.handleRpcMessage(data));
          resolve();
        } else if (message.type === "error") {
          this.state = "disconnected";
          reject(new Error(message.error ?? "Pairing failed."));
        }
      };
      ws.on("message", onFirstMessage);
      ws.on("error", (error) => reject(error));
      ws.on("close", () => this.scheduleReconnect());
    });
  }

  private handleRpcMessage(raw: WebSocket.RawData) {
    let message: { id: string; result?: unknown; error?: string };
    try {
      message = JSON.parse(String(raw));
    } catch {
      return;
    }
    const call = this.pending.get(message.id);
    if (!call) return;
    this.pending.delete(message.id);
    if (message.error) call.reject(new Error(message.error));
    else call.resolve(message.result);
  }

  private scheduleReconnect() {
    this.state = "disconnected";
    if (this.closedByUser || !this.token) return;
    this.reconnectAttempt += 1;
    const delay = Math.min(30_000, 1_000 * 2 ** this.reconnectAttempt);
    this.reconnectTimer = setTimeout(() => {
      this.connectWith({ token: this.token! }).catch(() => undefined);
    }, delay);
  }

  async call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!this.ws || this.state !== "connected") throw new Error("Not connected to the Apple Host.");
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.ws!.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`Apple Host call "${method}" timed out.`));
        }
      }, 30_000);
    });
  }
}
