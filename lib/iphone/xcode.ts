/** Thin wrappers around xcodebuild/xcrun simctl. No caching, no process state — SimctlProvider owns that. */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { BuildResult, Device } from "./IPhoneProvider";

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 8 * 1024 * 1024;

async function run(bin: string, args: string[], timeout = 120_000) {
  return execFileAsync(bin, args, { timeout, maxBuffer: MAX_BUFFER });
}

export async function listSimulators(): Promise<Device[]> {
  const { stdout } = await run("xcrun", ["simctl", "list", "devices", "available", "-j"]);
  const parsed = JSON.parse(stdout) as { devices: Record<string, Array<{ udid: string; name: string; state: string; isAvailable?: boolean }>> };
  const out: Device[] = [];
  for (const [runtimeKey, devices] of Object.entries(parsed.devices)) {
    const runtime = /com\.apple\.CoreSimulator\.SimRuntime\.(.+)/.exec(runtimeKey)?.[1]?.replace(/-/g, ".").replace(/^iOS/, "iOS ") ?? runtimeKey;
    for (const device of devices) {
      if (device.isAvailable === false) continue;
      out.push({ udid: device.udid, name: device.name, runtime, state: (device.state as Device["state"]) ?? "Shutdown" });
    }
  }
  return out;
}

export async function bootSimulator(udid: string) {
  try {
    await run("xcrun", ["simctl", "boot", udid], 60_000);
  } catch (error) {
    // "Unable to boot device in current state: Booted" is not a failure.
    if (!/current state: Booted/.test(String((error as { stderr?: string })?.stderr ?? error))) throw error;
  }
  await run("open", ["-a", "Simulator", "--args", "-CurrentDeviceUDID", udid], 15_000).catch(() => undefined);
}

export async function shutdownSimulator(udid: string) {
  await run("xcrun", ["simctl", "shutdown", udid], 30_000).catch(() => undefined);
}

/** Depth-limited search for an .xcodeproj, .xcworkspace, or Package.swift. */
export function findIosProject(root: string): { path: string; kind: "workspace" | "project" | "package" } | null {
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (stack.length) {
    const { dir, depth } = stack.pop()!;
    if (depth > 3) continue;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory() && entry.name.endsWith(".xcworkspace")) return { path: absolute, kind: "workspace" };
      if (entry.isDirectory() && entry.name.endsWith(".xcodeproj")) return { path: absolute, kind: "project" };
      if (entry.isFile() && entry.name === "Package.swift") return { path: absolute, kind: "package" };
      if (entry.isDirectory()) stack.push({ dir: absolute, depth: depth + 1 });
    }
  }
  return null;
}

/** Real build through xcodebuild against the given simulator destination. Returns the actual compiler output on failure. */
export async function buildIosApp(root: string, udid: string | undefined): Promise<BuildResult> {
  const project = findIosProject(root);
  if (!project) return { ok: false, output: "", error: "No .xcodeproj, .xcworkspace, or Package.swift found in this project." };
  const destination = udid ? `platform=iOS Simulator,id=${udid}` : "generic/platform=iOS Simulator";
  const derivedData = path.join(root, ".clyra-build", "DerivedData");
  const args = project.kind === "package"
    ? ["-scheme", packageName(project.path), "-destination", destination, "-derivedDataPath", derivedData, "build"]
    : [project.kind === "workspace" ? "-workspace" : "-project", project.path, "-scheme", schemeName(root, project), "-destination", destination, "-derivedDataPath", derivedData, "build"];
  try {
    const { stdout } = await run("xcodebuild", args, 600_000);
    const appPath = findBuiltApp(derivedData);
    if (!appPath) return { ok: false, output: stdout.slice(-8000), error: "xcodebuild succeeded but no .app product was found." };
    const bundleId = readBundleId(appPath);
    return { ok: true, appPath, bundleId: bundleId ?? undefined, output: stdout.slice(-4000) };
  } catch (error) {
    const stdout = String((error as { stdout?: string })?.stdout ?? "");
    const stderr = String((error as { stderr?: string })?.stderr ?? "");
    return { ok: false, output: (stdout + "\n" + stderr).slice(-8000), error: error instanceof Error ? error.message : "xcodebuild failed." };
  }
}

function packageName(packageSwiftPath: string) {
  return path.basename(path.dirname(packageSwiftPath));
}

function schemeName(root: string, project: { path: string; kind: string }) {
  // Xcode auto-generates a shared scheme named after the project/workspace
  // for a freshly created app; fall back to that convention.
  return path.basename(project.path).replace(/\.(xcodeproj|xcworkspace)$/, "");
}

function findBuiltApp(derivedData: string): string | null {
  const productsDir = path.join(derivedData, "Build", "Products");
  try {
    for (const config of fs.readdirSync(productsDir)) {
      const dir = path.join(productsDir, config);
      const app = fs.readdirSync(dir).find((name) => name.endsWith(".app"));
      if (app) return path.join(dir, app);
    }
  } catch { /* not built yet */ }
  return null;
}

function readBundleId(appPath: string): string | null {
  try {
    const plistPath = path.join(appPath, "Info.plist");
    const raw = fs.readFileSync(plistPath, "utf8");
    return /<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/.exec(raw)?.[1] ?? null;
  } catch { return null; }
}

export async function installApp(udid: string, appPath: string) {
  await run("xcrun", ["simctl", "install", udid, appPath], 60_000);
}

export async function launchApp(udid: string, bundleId: string) {
  await run("xcrun", ["simctl", "launch", udid, bundleId], 30_000);
}

export async function terminateApp(udid: string, bundleId: string) {
  await run("xcrun", ["simctl", "terminate", udid, bundleId], 15_000).catch(() => undefined);
}

export async function createDevice(name: string, deviceTypeId: string, runtimeId: string): Promise<string> {
  const { stdout } = await run("xcrun", ["simctl", "create", name, deviceTypeId, runtimeId], 30_000);
  return stdout.trim();
}

export async function screenshot(udid: string): Promise<Buffer> {
  const tmpPath = path.join(require("node:os").tmpdir(), `clyra-iphone-${Date.now()}.png`);
  await run("xcrun", ["simctl", "io", udid, "screenshot", tmpPath], 15_000);
  const data = fs.readFileSync(tmpPath);
  fs.unlink(tmpPath, () => undefined);
  return data;
}

export async function appLogs(udid: string, bundleId: string | undefined): Promise<string> {
  const predicate = bundleId ? `subsystem == "${bundleId}" OR process CONTAINS "${bundleId.split(".").pop()}"` : "messageType == 16";
  try {
    const { stdout } = await run("xcrun", ["simctl", "spawn", udid, "log", "show", "--last", "2m", "--style", "compact", "--predicate", predicate], 20_000);
    return stdout.slice(-16_000);
  } catch {
    return "";
  }
}
