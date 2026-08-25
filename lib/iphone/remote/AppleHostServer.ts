/**
 * The Mac-side WebSocket server a Windows (or another Mac) Clyra client
 * connects to for remote iPhone control. Real Xcode/CoreSimulator work still
 * only happens here, on the Mac — the client never touches simctl directly,
 * it sends JSON-RPC-style requests and gets results/errors back. This is the
 * "AppleHostServer" the architecture calls for; AppleHostClient below is its
 * counterpart for the connecting side.
 */
import type { Server } from "node:http";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import { simctlProvider } from "../SimctlProvider";
import { isValidSession, redeemPairingCode } from "./PairingManager";
import type { IPhoneProvider } from "../IPhoneProvider";

const REMOTE_PATH = "/api/iphone/remote";

type RpcRequest = { id: string; method: string; params?: Record<string, unknown> };
type RpcResponse = { id: string; result?: unknown; error?: string };

const METHODS: Record<string, (provider: IPhoneProvider, params: Record<string, unknown>) => Promise<unknown>> = {
  listDevices: (p) => p.listDevices(),
  boot: (p, params) => p.boot(String(params.deviceId)),
  shutdown: (p, params) => p.shutdown(String(params.deviceId)),
  build: (p, params) => p.build(String(params.projectPath), params.deviceId ? String(params.deviceId) : undefined),
  install: (p, params) => p.install(String(params.deviceId), String(params.appPath)),
  launch: (p, params) => p.launch(String(params.deviceId), String(params.bundleId)),
  terminate: (p, params) => p.terminate(String(params.deviceId), String(params.bundleId)),
  home: (p, params) => p.home(String(params.deviceId)),
  tap: (p, params) => p.tap(String(params.deviceId), { kind: "normalized", x: Number(params.x), y: Number(params.y) }),
  swipe: (p, params) => p.swipe(String(params.deviceId), params.direction as never),
  type: (p, params) => p.type(String(params.deviceId), String(params.text)),
  rotate: (p, params) => p.rotate(String(params.deviceId), params.orientation as never),
  getAccessibilityTree: (p, params) => p.getAccessibilityTree(String(params.deviceId)),
  getLogs: (p, params) => p.getLogs(String(params.deviceId)),
};

export function attachAppleHostServer(httpServer: Server) {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = req.url ?? "";
    if (!url.startsWith(REMOTE_PATH)) return;
    wss.handleUpgrade(req, socket as never, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    const params = new URLSearchParams((req.url ?? "").split("?")[1] ?? "");
    const pairingCode = params.get("pairingCode");
    const sessionToken = params.get("token");
    const hostLabel = params.get("hostLabel") ?? "Windows Clyra";

    let authed = false;
    if (sessionToken && isValidSession(sessionToken)) {
      authed = true;
      ws.send(JSON.stringify({ type: "paired", token: sessionToken }));
    } else if (pairingCode) {
      const redeemed = redeemPairingCode(pairingCode, hostLabel);
      if (redeemed) {
        authed = true;
        ws.send(JSON.stringify({ type: "paired", token: redeemed.token }));
      }
    }
    if (!authed) {
      ws.send(JSON.stringify({ type: "error", error: "Invalid or expired pairing code." }));
      ws.close();
      return;
    }

    ws.on("message", (raw) => {
      void (async () => {
        let request: RpcRequest;
        try {
          request = JSON.parse(String(raw));
        } catch {
          return;
        }
        const handler = METHODS[request.method];
        const response: RpcResponse = { id: request.id };
        if (!handler) {
          response.error = `Unknown method: ${request.method}`;
        } else {
          try {
            if (!simctlProvider.isConnected()) await simctlProvider.connect();
            response.result = await handler(simctlProvider, request.params ?? {});
          } catch (error) {
            response.error = error instanceof Error ? error.message : "Remote command failed.";
          }
        }
        ws.send(JSON.stringify(response));
      })();
    });
  });

  return wss;
}
