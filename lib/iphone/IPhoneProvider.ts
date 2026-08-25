/**
 * Provider-agnostic contract for real iPhone development/preview backends.
 *
 * Clyra never talks to a single vendor's simulator tool directly — every
 * caller (routes, the agent) goes through this interface so the transport
 * (local simctl, a remote paired Mac, a different streaming tool) can change
 * without touching the panel or the agent workflow. See SimctlProvider for
 * the only adapter implemented so far (local macOS via xcrun/xcodebuild +
 * serve-sim for streaming and HID input).
 */
export type Device = {
  udid: string;
  name: string;
  runtime: string;
  state: "Booted" | "Shutdown" | "Booting" | "Shutting Down";
};

export type BuildResult = {
  ok: boolean;
  appPath?: string;
  bundleId?: string;
  output: string;
  error?: string;
};

export type Target =
  | { kind: "point"; x: number; y: number }
  | { kind: "normalized"; x: number; y: number };

export type Direction = "up" | "down" | "left" | "right";
export type Orientation = "portrait" | "landscape";

export type UITreeNode = {
  alias?: string;
  role: string;
  label?: string;
  frame?: { x: number; y: number; width: number; height: number };
  children?: UITreeNode[];
};

export type UITree = { app: string | null; root: UITreeNode | null; raw?: string };

export type LogEntry = { timestamp: number; level: "info" | "error" | "debug"; source: string; message: string };

export type Stream = {
  url: string;
  protocol: "webrtc" | "mjpeg" | "poll";
  fps: number;
  /** How the panel should embed it: a full interactive page (serve-sim's own preview UI) or a raw image stream (sim-use MJPEG) that the panel drives itself. */
  kind: "iframe" | "img";
};

export interface IPhoneProvider {
  readonly id: string;
  readonly label: string;

  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;

  listDevices(): Promise<Device[]>;
  boot(deviceId: string): Promise<void>;
  shutdown(deviceId: string): Promise<void>;

  build(projectPath: string, deviceId?: string): Promise<BuildResult>;
  install(deviceId: string, appPath: string): Promise<void>;
  launch(deviceId: string, bundleId: string): Promise<void>;
  terminate(deviceId: string, bundleId: string): Promise<void>;

  home(deviceId: string): Promise<void>;
  tap(deviceId: string, target: Target): Promise<void>;
  /** Not every adapter exposes a distinct long-press verb (see SimctlProvider, backed by sim-use; others fall back to a plain tap). */
  longPress?(deviceId: string, target: Target, seconds?: number): Promise<void>;
  swipe(deviceId: string, direction: Direction, target?: Target): Promise<void>;
  type(deviceId: string, text: string): Promise<void>;
  rotate(deviceId: string, orientation: Orientation): Promise<void>;

  /** Not every adapter can produce a real accessibility tree (see SimUseController, unavailable on this host). */
  getAccessibilityTree(deviceId: string): Promise<UITree | null>;
  screenshot(deviceId: string): Promise<Buffer>;
  getLogs(deviceId: string): Promise<LogEntry[]>;

  startStream(deviceId: string): Promise<Stream>;
  stopStream(deviceId: string): Promise<void>;
}
