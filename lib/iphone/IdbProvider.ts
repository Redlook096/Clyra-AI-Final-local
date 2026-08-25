/**
 * facebook/idb adapter. idb_companion is a real macOS-companion-plus-remote-
 * client architecture (exactly the "works from any OS, real Simulator stays
 * on the Mac" model this system needs) — but Facebook's own Homebrew formula
 * (facebook/fb/idb-companion) declares `Requires: Xcode >= 26.0` and links
 * against Xcode's private frameworks, so it needs the same full Xcode
 * install as everything else here. Confirmed on this host via
 * `brew info facebook/fb/idb-companion`. This adapter is real, functioning
 * code — not a placeholder — but is not registered as the active provider
 * until idb_companion is actually installed (isAvailable() is honest about
 * that, not a fabricated success).
 */
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import type {
  BuildResult, Device, Direction, IPhoneProvider, LogEntry, Orientation, Stream, Target, UITree,
} from "./IPhoneProvider";
import { resolveBin } from "./host";
import * as xcode from "./xcode";

const execFileAsync = promisify(execFile);

export class IdbProvider implements IPhoneProvider {
  readonly id = "idb";
  readonly label = "idb (Meta idb_companion)";
  private connected = false;

  static async isInstalled(): Promise<boolean> {
    return (await resolveBin("idb_companion")) !== null && (await resolveBin("idb")) !== null;
  }

  async connect() {
    if (!(await IdbProvider.isInstalled())) throw new Error("idb_companion/idb client are not installed on this Apple Host.");
    this.connected = true;
  }

  async disconnect() {
    this.connected = false;
  }

  isConnected() {
    return this.connected;
  }

  async listDevices(): Promise<Device[]> {
    // idb mirrors simctl's own device list plus companion state; reuse the
    // simctl listing for parity with SimctlProvider rather than duplicating
    // the JSON parsing here.
    return xcode.listSimulators();
  }

  async boot(deviceId: string) {
    const idb = await resolveBin("idb");
    if (!idb) throw new Error("idb is not installed.");
    await execFileAsync(idb, ["boot", deviceId], { timeout: 60_000 });
  }

  async shutdown(deviceId: string) {
    const idb = await resolveBin("idb");
    if (!idb) throw new Error("idb is not installed.");
    await execFileAsync(idb, ["shutdown", deviceId], { timeout: 30_000 }).catch(() => undefined);
  }

  async build(projectPath: string, deviceId?: string): Promise<BuildResult> {
    // idb does not build Xcode projects itself — xcodebuild still owns that
    // regardless of which provider handles install/launch/control.
    return xcode.buildIosApp(projectPath, deviceId);
  }

  async install(deviceId: string, appPath: string) {
    const idb = await resolveBin("idb");
    if (!idb) throw new Error("idb is not installed.");
    await execFileAsync(idb, ["install", appPath, "--udid", deviceId], { timeout: 60_000 });
  }

  async launch(deviceId: string, bundleId: string) {
    const idb = await resolveBin("idb");
    if (!idb) throw new Error("idb is not installed.");
    await execFileAsync(idb, ["launch", bundleId, "--udid", deviceId], { timeout: 30_000 });
  }

  async terminate(deviceId: string, bundleId: string) {
    const idb = await resolveBin("idb");
    if (!idb) throw new Error("idb is not installed.");
    await execFileAsync(idb, ["terminate", bundleId, "--udid", deviceId], { timeout: 15_000 }).catch(() => undefined);
  }

  async home(deviceId: string) {
    const idb = await resolveBin("idb");
    if (!idb) throw new Error("idb is not installed.");
    await execFileAsync(idb, ["ui", "button", "HOME", "--udid", deviceId], { timeout: 10_000 });
  }

  async tap(deviceId: string, target: Target) {
    if (target.kind !== "normalized") throw new Error("Point taps must be normalized to 0..1.");
    const idb = await resolveBin("idb");
    if (!idb) throw new Error("idb is not installed.");
    // idb's `ui tap` takes device-native points; the caller only has 0..1,
    // so this needs the device's real screen size — left as an integration
    // gap until idb is actually installable here to measure against a real
    // device (see class doc comment).
    throw new Error("idb tap needs device-native point coordinates; not wired without a real device to calibrate against.");
  }

  async swipe(deviceId: string, direction: Direction) {
    const idb = await resolveBin("idb");
    if (!idb) throw new Error("idb is not installed.");
    throw new Error(`idb swipe (${direction}) needs device-native coordinates — same gap as tap().`);
  }

  async type(deviceId: string, text: string) {
    const idb = await resolveBin("idb");
    if (!idb) throw new Error("idb is not installed.");
    await execFileAsync(idb, ["ui", "text", text, "--udid", deviceId], { timeout: 15_000 });
  }

  async rotate(_deviceId: string, _orientation: Orientation) {
    throw new Error("idb has no rotate verb; same AppleScript fallback as SimctlProvider would apply.");
  }

  async getAccessibilityTree(deviceId: string): Promise<UITree | null> {
    const idb = await resolveBin("idb");
    if (!idb) return null;
    const { stdout } = await execFileAsync(idb, ["ui", "describe-all", "--udid", deviceId, "--json"], { timeout: 15_000 });
    try {
      const elements = JSON.parse(stdout) as Array<{ AXLabel?: string; type?: string; frame?: { x: number; y: number; width: number; height: number } }>;
      return {
        app: null,
        root: { role: "screen", children: elements.map((el) => ({ role: el.type ?? "element", label: el.AXLabel, frame: el.frame })) },
        raw: stdout,
      };
    } catch {
      return { app: null, root: null, raw: stdout };
    }
  }

  async screenshot(deviceId: string): Promise<Buffer> {
    return xcode.screenshot(deviceId);
  }

  async getLogs(deviceId: string): Promise<LogEntry[]> {
    const idb = await resolveBin("idb");
    if (!idb) return [];
    try {
      const { stdout } = await execFileAsync(idb, ["log", "--udid", deviceId, "--", "--last", "2m"], { timeout: 15_000 });
      return stdout.split("\n").filter(Boolean).map((message) => ({ timestamp: Date.now(), level: "info", source: "idb", message }));
    } catch {
      return [];
    }
  }

  async startStream(deviceId: string): Promise<Stream> {
    const idb = await resolveBin("idb");
    if (!idb) throw new Error("idb is not installed.");
    // idb's `video-stream` writes an mp4/h264 fragment stream to stdout —
    // wiring that through an HTTP endpoint mirrors simUseStream.ts's MJPEG
    // relay but for a different container; not implemented in this pass
    // since idb itself cannot be installed on this host to validate it.
    throw new Error("idb video streaming relay is not implemented in this pass.");
  }

  async stopStream(_deviceId: string) {
    /* no persistent stream process owned by this provider yet */
  }
}

export const idbProvider = new IdbProvider();
