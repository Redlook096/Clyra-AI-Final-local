/**
 * Wraps the `sim-use` CLI (https://github.com/lycorp-jp/sim-use) — real
 * accessibility inspection and HID control for a booted iOS Simulator.
 * Installed via a user-owned, no-sudo Homebrew checkout (see host.ts's
 * resolveBin) since the machine building this had no admin rights to run
 * the official Homebrew installer. Every command still requires full Xcode
 * (sim-use shells out to simctl/idb internals) — isAvailable() only proves
 * the binary itself is present, not that a simulator can be reached.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveBin } from "./host";
import type { Direction, UITree, UITreeNode } from "./IPhoneProvider";

const execFileAsync = promisify(execFile);

let binPath: string | null | undefined;

export async function isAvailable(): Promise<boolean> {
  if (binPath === undefined) binPath = await resolveBin("sim-use");
  return binPath !== null;
}

async function run(args: string[], timeout = 20_000): Promise<{ stdout: string; ok: boolean }> {
  const bin = await resolveBin("sim-use");
  if (!bin) throw new Error("sim-use is not installed on this Apple Host.");
  try {
    const { stdout } = await execFileAsync(bin, args, { timeout, maxBuffer: 8 * 1024 * 1024 });
    return { stdout, ok: true };
  } catch (error) {
    const stdout = String((error as { stdout?: string })?.stdout ?? "");
    // sim-use exits non-zero on some benign paths (e.g. gesture already at
    // the edge) but still emits a useful --json envelope on stdout.
    if (stdout.trim().startsWith("{")) return { stdout, ok: false };
    throw error;
  }
}

type UiEnvelope = { app?: string; elements?: RawElement[]; ok?: boolean; error?: string; width?: number; height?: number; screen?: { width?: number; height?: number } };

async function describeUi(udid: string): Promise<UiEnvelope> {
  const { stdout } = await run(["describe-ui", "--device", udid, "--json"]);
  try {
    return JSON.parse(stdout) as UiEnvelope;
  } catch {
    return {};
  }
}

export async function ui(udid: string): Promise<UITree | null> {
  const envelope = await describeUi(udid);
  if (envelope.error) throw new Error(envelope.error);
  const root = toTree(envelope.elements ?? []);
  return { app: envelope.app ?? null, root, raw: JSON.stringify(envelope) };
}

let screenSizeCache = new Map<string, { width: number; height: number }>();

/**
 * Device-native point size (not pixels) for a booted simulator, read from
 * `describe-ui`'s own envelope — `sim-use tap --point x,y` takes raw points,
 * not a 0..1 fraction, so every normalized-coordinate call in this module
 * resolves through this first. Cached per UDID for the session; a device
 * doesn't change point size while booted.
 */
export async function screenSize(udid: string): Promise<{ width: number; height: number }> {
  const cached = screenSizeCache.get(udid);
  if (cached) return cached;
  const envelope = await describeUi(udid);
  const width = envelope.width ?? envelope.screen?.width;
  const height = envelope.height ?? envelope.screen?.height;
  if (!width || !height) throw new Error("Could not determine the simulator's screen size from sim-use.");
  const size = { width, height };
  screenSizeCache.set(udid, size);
  return size;
}

type RawElement = { alias?: string; role?: string; type?: string; label?: string; text?: string; frame?: { x: number; y: number; width: number; height: number } };

function toTree(elements: RawElement[]): UITreeNode {
  return {
    role: "screen",
    children: elements.map((el) => ({
      alias: el.alias,
      role: el.role ?? el.type ?? "element",
      label: el.label ?? el.text,
      frame: el.frame,
    })),
  };
}

/** x, y are normalized 0..1 — resolved to real device points via screenSize() before calling sim-use. */
export async function tap(udid: string, xNorm: number, yNorm: number) {
  const { width, height } = await screenSize(udid);
  await run(["tap", "--point", `${Math.round(xNorm * width)},${Math.round(yNorm * height)}`, "--device", udid, "--json"]);
}

export async function tapAlias(udid: string, alias: string) {
  await run(["tap", alias, "--device", udid, "--json"]);
}

export async function longPress(udid: string, xNorm: number, yNorm: number, seconds = 0.8) {
  const { width, height } = await screenSize(udid);
  await run(["long-press", "--point", `${Math.round(xNorm * width)},${Math.round(yNorm * height)}`, "--duration", String(seconds), "--device", udid, "--json"]);
}

export async function swipe(udid: string, direction: Direction) {
  const { width, height } = await screenSize(udid);
  const fractions: Record<Direction, [number, number, number, number]> = {
    up: [0.5, 0.7, 0.5, 0.3],
    down: [0.5, 0.3, 0.5, 0.7],
    left: [0.7, 0.5, 0.3, 0.5],
    right: [0.3, 0.5, 0.7, 0.5],
  };
  const [fx0, fy0, fx1, fy1] = fractions[direction];
  await swipePoints(udid, Math.round(fx0 * width), Math.round(fy0 * height), Math.round(fx1 * width), Math.round(fy1 * height));
}

export async function swipePoints(udid: string, fromX: number, fromY: number, toX: number, toY: number) {
  await run(["swipe", "--from", `${fromX},${fromY}`, "--to", `${toX},${toY}`, "--device", udid, "--json"]);
}

export async function type(udid: string, text: string) {
  await run(["type", text, "--device", udid, "--json"]);
}

export async function button(udid: string, name: "home" | "lock" | "apple-pay" | "side-button" | "siri") {
  await run(["button", name, "--device", udid, "--json"]);
}

export async function screenshotTo(udid: string, outputPath: string) {
  await run(["screenshot", "--device", udid, "--output", outputPath, "--json"]);
}

export async function appState(udid: string): Promise<string> {
  const { stdout } = await run(["app-state", "--device", udid, "--json"]);
  return stdout;
}
