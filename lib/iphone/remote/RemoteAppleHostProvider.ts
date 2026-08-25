/**
 * IPhoneProvider that forwards every call over the network to a paired
 * Mac's AppleHostServer. Registering this instead of SimctlProvider is the
 * entire difference between "Mac local mode" and "Windows remote mode" —
 * routes.ts, IPhonePanel.tsx and the agent CLI never know which one is
 * active, exactly as required ("do not show the user these implementation
 * differences").
 */
import type {
  BuildResult, Device, Direction, IPhoneProvider, LogEntry, Orientation, Stream, Target, UITree,
} from "../IPhoneProvider";
import { AppleHostClient, type HostConnectionState } from "./AppleHostClient";
import type { SavedHost } from "./DeviceRegistry";

export class RemoteAppleHostProvider implements IPhoneProvider {
  readonly id = "remote-apple-host";
  readonly label: string;
  private client: AppleHostClient;

  constructor(private savedHost: SavedHost) {
    this.label = `Remote Apple Host (${savedHost.hostLabel})`;
    this.client = new AppleHostClient(savedHost.url, "Clyra");
  }

  state(): HostConnectionState {
    return this.client.getState();
  }

  async connect() {
    await this.client.reconnect(this.savedHost);
  }

  async disconnect() {
    this.client.disconnect();
  }

  isConnected() {
    return this.client.getState() === "connected";
  }

  listDevices(): Promise<Device[]> {
    return this.client.call("listDevices");
  }

  boot(deviceId: string): Promise<void> {
    return this.client.call("boot", { deviceId });
  }

  shutdown(deviceId: string): Promise<void> {
    return this.client.call("shutdown", { deviceId });
  }

  build(projectPath: string, deviceId?: string): Promise<BuildResult> {
    // The project's Swift source lives on the machine calling this — a real
    // remote build needs the source synced to the Mac host first. That sync
    // step (rsync/tar-over-WS onto the Mac's own projects dir) is not
    // implemented in this pass; this call intentionally fails loudly rather
    // than silently building stale or missing source on the Mac.
    return Promise.reject(new Error("Remote build needs project source synced to the Apple Host first (not implemented yet) — build locally on the Mac host for now."));
  }

  install(deviceId: string, appPath: string): Promise<void> {
    return this.client.call("install", { deviceId, appPath });
  }

  launch(deviceId: string, bundleId: string): Promise<void> {
    return this.client.call("launch", { deviceId, bundleId });
  }

  terminate(deviceId: string, bundleId: string): Promise<void> {
    return this.client.call("terminate", { deviceId, bundleId });
  }

  home(deviceId: string): Promise<void> {
    return this.client.call("home", { deviceId });
  }

  tap(deviceId: string, target: Target): Promise<void> {
    if (target.kind !== "normalized") return Promise.reject(new Error("Point taps must be normalized."));
    return this.client.call("tap", { deviceId, x: target.x, y: target.y });
  }

  swipe(deviceId: string, direction: Direction): Promise<void> {
    return this.client.call("swipe", { deviceId, direction });
  }

  type(deviceId: string, text: string): Promise<void> {
    return this.client.call("type", { deviceId, text });
  }

  rotate(deviceId: string, orientation: Orientation): Promise<void> {
    return this.client.call("rotate", { deviceId, orientation });
  }

  getAccessibilityTree(deviceId: string): Promise<UITree | null> {
    return this.client.call("getAccessibilityTree", { deviceId });
  }

  screenshot(_deviceId: string): Promise<Buffer> {
    return Promise.reject(new Error("Remote screenshot transport not implemented in this pass — use the live stream instead."));
  }

  getLogs(deviceId: string): Promise<LogEntry[]> {
    return this.client.call("getLogs", { deviceId });
  }

  startStream(_deviceId: string): Promise<Stream> {
    // The live framebuffer stream is a separate, higher-bandwidth transport
    // (video, not JSON-RPC) — StreamTransport in the architecture. Wiring an
    // actual remote video relay (WebRTC or an MJPEG relay through this same
    // WS connection) is not implemented in this pass.
    return Promise.reject(new Error("Remote video streaming (StreamTransport) is not implemented in this pass."));
  }

  stopStream(_deviceId: string): Promise<void> {
    return Promise.resolve();
  }
}
