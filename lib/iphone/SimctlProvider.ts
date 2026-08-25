/**
 * Local macOS Apple Host adapter: real Xcode/CoreSimulator via xcrun simctl
 * + xcodebuild for build/boot/install/launch (universal, any Mac). Control
 * and accessibility route through sim-use when installed (works on any Mac
 * architecture); the live stream prefers serve-sim's fast helper on Apple
 * Silicon and falls back to sim-use's own video/screenshot pipeline
 * everywhere else. See host.ts for how each tool is located.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  BuildResult, Device, Direction, IPhoneProvider, LogEntry, Orientation, Stream, Target, UITree,
} from "./IPhoneProvider";
import { isMac, supportsFastStream, xcodeVersion } from "./host";
import * as xcode from "./xcode";
import * as serveSim from "./serveSim";
import * as simUse from "./simUse";

const execFileAsync = promisify(execFile);

export class SimctlProvider implements IPhoneProvider {
  readonly id = "simctl";
  readonly label = "Local Apple Host (Xcode Simulator)";
  private connected = false;
  private lastBundleId = new Map<string, string>();

  async connect() {
    if (!isMac()) throw new Error("The local Apple Host provider requires macOS.");
    const version = await xcodeVersion();
    if (!version) throw new Error("Full Xcode is not installed (only Command Line Tools were found). Install Xcode from the App Store, then run: sudo xcode-select -s /Applications/Xcode.app/Contents/Developer");
    this.connected = true;
  }

  async disconnect() {
    serveSim.stopAllStreams();
    this.connected = false;
  }

  isConnected() {
    return this.connected;
  }

  async listDevices(): Promise<Device[]> {
    return xcode.listSimulators();
  }

  async boot(deviceId: string) {
    await xcode.bootSimulator(deviceId);
  }

  async shutdown(deviceId: string) {
    serveSim.stopStream(deviceId);
    await xcode.shutdownSimulator(deviceId);
  }

  async build(projectPath: string, deviceId?: string): Promise<BuildResult> {
    const result = await xcode.buildIosApp(projectPath, deviceId);
    if (result.ok && result.bundleId) this.lastBundleId.set(deviceId ?? "*", result.bundleId);
    return result;
  }

  async install(deviceId: string, appPath: string) {
    await xcode.installApp(deviceId, appPath);
  }

  async launch(deviceId: string, bundleId: string) {
    await xcode.launchApp(deviceId, bundleId);
    this.lastBundleId.set(deviceId, bundleId);
  }

  async terminate(deviceId: string, bundleId: string) {
    await xcode.terminateApp(deviceId, bundleId);
  }

  async home(deviceId: string) {
    if (await simUse.isAvailable()) return simUse.button(deviceId, "home");
    await serveSim.button(deviceId, "home");
  }

  async tap(deviceId: string, target: Target) {
    if (target.kind !== "normalized") {
      throw new Error("Point taps must be normalized to 0..1 before reaching the provider.");
    }
    if (await simUse.isAvailable()) {
      // simUse.tap resolves 0..1 to the device's real point size itself
      // (sim-use's own --point flag takes raw device points, not a fraction).
      await simUse.tap(deviceId, target.x, target.y);
      return;
    }
    await serveSim.tap(deviceId, target.x, target.y);
  }

  async longPress(deviceId: string, target: Target, seconds = 0.8) {
    if (target.kind !== "normalized") throw new Error("Point taps must be normalized to 0..1 before reaching the provider.");
    if (!(await simUse.isAvailable())) throw new Error("Long-press requires sim-use.");
    await simUse.longPress(deviceId, target.x, target.y, seconds);
  }

  async swipe(deviceId: string, direction: Direction, target?: Target) {
    if (await simUse.isAvailable()) {
      await simUse.swipe(deviceId, direction);
      return;
    }
    const center = target && target.kind === "normalized" ? target : { x: 0.5, y: 0.5 };
    const offsets: Record<Direction, [number, number]> = {
      up: [0, -0.35], down: [0, 0.35], left: [-0.35, 0], right: [0.35, 0],
    };
    const [dx, dy] = offsets[direction];
    const from = { x: clamp01(center.x - dx / 2), y: clamp01(center.y - dy / 2) };
    const to = { x: clamp01(center.x + dx / 2), y: clamp01(center.y + dy / 2) };
    await serveSim.gesture(deviceId, { type: "begin", x: from.x, y: from.y });
    await serveSim.gesture(deviceId, { type: "move", x: to.x, y: to.y });
    await serveSim.gesture(deviceId, { type: "end", x: to.x, y: to.y });
  }

  async type(deviceId: string, text: string) {
    if (await simUse.isAvailable()) return simUse.type(deviceId, text);
    await serveSim.typeText(deviceId, text);
  }

  async rotate(deviceId: string, orientation: Orientation) {
    // No simctl/serve-sim/sim-use CLI verb rotates the device directly;
    // Simulator.app exposes it only as a menu command / keyboard shortcut
    // (Cmd+Left / Cmd+Right). Best-effort: send that shortcut via AppleScript.
    const keyCode = orientation === "landscape" ? 123 : 124; // left/right arrow
    try {
      await execFileAsync("osascript", ["-e", `tell application "Simulator" to activate`, "-e", `tell application "System Events" to key code ${keyCode} using {command down}`], { timeout: 5_000 });
    } catch {
      throw new Error("Rotation requires the Simulator app to be able to receive keystrokes (Accessibility permission for automation).");
    }
  }

  async getAccessibilityTree(deviceId: string): Promise<UITree | null> {
    if (!(await simUse.isAvailable())) return null;
    return simUse.ui(deviceId);
  }

  async screenshot(deviceId: string): Promise<Buffer> {
    return xcode.screenshot(deviceId);
  }

  async getLogs(deviceId: string): Promise<LogEntry[]> {
    const bundleId = this.lastBundleId.get(deviceId);
    const raw = await xcode.appLogs(deviceId, bundleId);
    return raw.split("\n").filter(Boolean).map((line) => ({
      timestamp: Date.now(),
      level: /error/i.test(line) ? "error" : "info",
      source: bundleId ?? "simulator",
      message: line,
    }));
  }

  async startStream(deviceId: string): Promise<Stream> {
    // serve-sim's touch/keyboard/video pipeline is a native N-API addon
    // shipped Apple-Silicon-only (confirmed from its source: src/native.ts
    // loads dist/native/serve-sim-native.node, which does not exist for
    // x86_64 — it throws on require(), it does not degrade gracefully). So
    // it is only ever selected on arm64; every other Mac streams through
    // sim-use's own MJPEG pipeline instead, which is architecture-agnostic.
    if (supportsFastStream()) {
      try {
        const session = await serveSim.ensureStream(deviceId);
        return { url: `/iphone-stream/${session.port}/`, protocol: "mjpeg", fps: 60, kind: "iframe" };
      } catch {
        // Fall through to the sim-use path below.
      }
    }
    if (await simUse.isAvailable()) {
      return { url: `/api/iphone/devices/${encodeURIComponent(deviceId)}/stream.mjpeg`, protocol: "mjpeg", fps: 15, kind: "img" };
    }
    throw new Error("No streaming backend is available (neither serve-sim nor sim-use).");
  }

  async stopStream(deviceId: string) {
    serveSim.stopStream(deviceId);
  }
}

function clamp01(value: number) {
  return Math.min(1, Math.max(0, value));
}

export const simctlProvider = new SimctlProvider();
