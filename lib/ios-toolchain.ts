/**
 * Real Xcode toolchain helpers for the iOS App Mode.
 *
 * Detects local Xcode/simulator tooling, builds the active project through
 * xcodebuild, and prepares the produced .app bundle for the iOS bridge.
 * Everything here is a thin wrapper over the actual local toolchain — no
 * simulated output.
 */
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import fs from "node:fs";

const execFileAsync = promisify(execFile);

export type IosSimulator = {
  udid: string;
  name: string;
  version: string;
  booted: boolean;
};

export function isMac() {
  return process.platform === "darwin";
}

/**
 * Clyra can be installed alongside Command Line Tools while Xcode itself is
 * elsewhere (Downloads is common during a first installation). Prefer an
 * explicit developer dir, then standard locations, so simulator work does
 * not silently use the CLT-only toolchain.
 */
export function xcodeDeveloperDir() {
  const candidates = [
    process.env.DEVELOPER_DIR,
    "/Applications/Xcode.app/Contents/Developer",
    path.join(process.env.HOME || "", "Downloads", "Xcode.app", "Contents", "Developer"),
  ].filter((candidate): candidate is string => Boolean(candidate));
  return candidates.find((candidate) => fs.existsSync(path.join(candidate, "usr", "bin", "xcodebuild"))) ?? null;
}

function xcodeEnv() {
  const directory = xcodeDeveloperDir();
  return directory ? { ...process.env, DEVELOPER_DIR: directory } : process.env;
}

function xcrun(args: string[], timeout = 60_000) {
  return execFileAsync("xcrun", args, { timeout, maxBuffer: 4 * 1024 * 1024, env: xcodeEnv() });
}

async function xcodebuild(args: string[], timeout = 600_000) {
  try {
    const { stdout, stderr } = await execFileAsync("xcodebuild", args, {
      timeout,
      maxBuffer: 8 * 1024 * 1024,
      env: xcodeEnv(),
    });
    return { ok: true, output: `${stdout}\n${stderr}` };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string };
    return { ok: false, output: `${failure.stdout ?? ""}\n${failure.stderr ?? ""}` };
  }
}

export async function xcodeStatus(): Promise<{ installed: boolean; version: string | null }> {
  if (!isMac()) return { installed: false, version: null };
  try {
    const directory = xcodeDeveloperDir();
    if (!directory) return { installed: false, version: null };
    const { stdout } = await execFileAsync(path.join(directory, "usr", "bin", "xcodebuild"), ["-version"], {
      timeout: 15_000,
      env: xcodeEnv(),
    });
    const version = stdout.split("\n").find((line) => line.startsWith("Xcode "))?.replace("Xcode ", "") ?? null;
    return { installed: true, version };
  } catch {
    return { installed: false, version: null };
  }
}

export async function listSimulators(): Promise<IosSimulator[]> {
  if (!isMac()) return [];
  try {
    // CoreSimulator can hang while a newly-downloaded Xcode finishes its first
    // setup. The preview must remain responsive, so fail cleanly rather than
    // blocking the entire native pipeline for a minute.
    const { stdout } = await xcrun(["simctl", "list", "devices", "available", "-j"], 12_000);
    const parsed = JSON.parse(stdout) as {
      devices?: Record<string, Array<{ udid: string; name: string; state: string }>>;
    };
    const list: IosSimulator[] = [];
    for (const [runtime, devices] of Object.entries(parsed.devices ?? {})) {
      const version = runtime.replace(/^.*?(\d+(?:\.\d+)?(?:\.\d+)?)[^)]*$/, "$1") || runtime;
      for (const device of devices ?? []) {
        list.push({
          udid: device.udid,
          name: device.name,
          version,
          booted: device.state === "Booted",
        });
      }
    }
    // iPhone devices first, newest runtimes first.
    return list.sort((a, b) => {
      const ai = /iphone/i.test(a.name) ? 0 : 1;
      const bi = /iphone/i.test(b.name) ? 0 : 1;
      if (ai !== bi) return ai - bi;
      return b.version.localeCompare(a.version, undefined, { numeric: true });
    });
  } catch {
    return [];
  }
}

export function findIosProject(root: string): { kind: "workspace" | "project" | "package"; path: string } | null {
  try {
    // Agents frequently place an Xcode project in a named app folder. Search
    // a few source-level directories while deliberately skipping generated
    // build output and dependencies, so preview readiness follows the real
    // project layout rather than requiring a brittle root-level convention.
    const queue: Array<{ directory: string; depth: number }> = [{ directory: root, depth: 0 }];
    let packageProject: string | null = null;
    while (queue.length) {
      const current = queue.shift()!;
      const entries = fs.readdirSync(current.directory, { withFileTypes: true });
      for (const entry of entries) {
        const entryPath = path.join(current.directory, entry.name);
        if (entry.isDirectory() && entry.name.endsWith(".xcworkspace")) return { kind: "workspace", path: entryPath };
      }
      for (const entry of entries) {
        const entryPath = path.join(current.directory, entry.name);
        if (entry.isDirectory() && entry.name.endsWith(".xcodeproj")) return { kind: "project", path: entryPath };
      }
      if (!packageProject && entries.some((entry) => entry.isFile() && entry.name === "Package.swift")) packageProject = path.join(current.directory, "Package.swift");
      if (current.depth >= 3) continue;
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith(".") || /^(node_modules|build|DerivedData|Pods|\.build)$/i.test(entry.name)) continue;
        queue.push({ directory: path.join(current.directory, entry.name), depth: current.depth + 1 });
      }
    }
    if (packageProject) return { kind: "package", path: packageProject };
  } catch {
    /* unreadable root */
  }
  return null;
}

async function firstScheme(project: { kind: "workspace" | "project" | "package"; path: string }) {
  if (project.kind === "package") return null;
  const flag = project.kind === "workspace" ? ["-workspace", project.path] : ["-project", project.path];
  try {
    const { stdout } = await execFileAsync("xcodebuild", [...flag, "-list", "-json"], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024, env: xcodeEnv() });
    const parsed = JSON.parse(stdout) as {
      workspace?: { schemes?: string[] };
      project?: { schemes?: string[]; targets?: string[] };
    };
    const schemes = parsed.workspace?.schemes ?? parsed.project?.schemes ?? [];
    return schemes[0] ?? null;
  } catch {
    return null;
  }
}

export type IosBuildResult = {
  ok: boolean;
  appPath: string | null;
  bundleId: string | null;
  output: string;
  error?: string;
};

export async function buildIosApp(root: string, destinationUdid?: string): Promise<IosBuildResult> {
  const project = findIosProject(root);
  if (!project) return { ok: false, appPath: null, bundleId: null, output: "", error: "No .xcodeproj, .xcworkspace or Package.swift found in the project." };
  const derived = path.join(root, ".clyra-build");
  const args: string[] = [];
  if (project.kind === "workspace") args.push("-workspace", project.path);
  else if (project.kind === "project") args.push("-project", project.path);
  const scheme = await firstScheme(project);
  if (scheme) args.push("-scheme", scheme);
  args.push("-configuration", "Debug");
  args.push("-derivedDataPath", derived);
  args.push("-destination", destinationUdid ? `platform=iOS Simulator,id=${destinationUdid}` : "platform=iOS Simulator,name=iPhone 17 Pro");
  if (project.kind === "package") {
    args.push("-sdk", "iphonesimulator");
  }
  args.push("build");
  const result = await xcodebuild(args, 600_000);
  if (!result.ok) {
    return { ok: false, appPath: null, bundleId: null, output: result.output, error: result.output.slice(-4000) };
  }
  // Locate the fresh .app bundle.
  const products = path.join(derived, "Build", "Products");
  let appPath: string | null = null;
  try {
    const walk = (dir: string): string | null => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory() && entry.name.endsWith(".app")) return full;
        if (entry.isDirectory() && !entry.name.endsWith(".app")) {
          const nested = walk(full);
          if (nested) return nested;
        }
      }
      return null;
    };
    appPath = walk(products);
  } catch {
    /* not found */
  }
  if (!appPath) {
    return { ok: false, appPath: null, bundleId: null, output: result.output, error: "Build passed but no .app bundle was produced." };
  }
  const bundleId = readBundleId(appPath);
  return { ok: true, appPath, bundleId, output: result.output };
}

function readBundleId(appPath: string): string | null {
  try {
    const plist = path.join(appPath, "Info.plist");
    const stdout = execFileSync("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleIdentifier", plist], { encoding: "utf8", timeout: 10_000 });
    return String(stdout).trim() || null;
  } catch {
    return null;
  }
}

export async function zipAppBundle(appPath: string, outPath: string) {
  try { fs.rmSync(outPath, { force: true }); } catch { /* fresh zip */ }
  const parent = path.dirname(appPath);
  const base = path.basename(appPath);
  execFileSync("/usr/bin/zip", ["-rqy", outPath, base], { cwd: parent, timeout: 120_000 });
  return outPath;
}
