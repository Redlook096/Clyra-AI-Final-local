/**
 * Full Xcode/Simulator-runtime diagnostics and the one-time setup flow's
 * backend. This is deliberately more granular than host.ts's xcodeVersion()
 * boolean gate — the setup wizard needs to tell NO_XCODE apart from
 * XCODE_INSTALLED_NOT_SELECTED apart from NO_IOS_RUNTIME so it can show the
 * right single next action instead of one generic "Xcode missing" message.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import { promisify } from "node:util";
import { isMac, hostArch, resolveBin } from "./host";

const execFileAsync = promisify(execFile);

export type XcodeState =
  | "NO_XCODE"
  | "COMMAND_LINE_TOOLS_ONLY"
  | "XCODE_INSTALLED_NOT_SELECTED"
  | "XCODE_NEEDS_FIRST_LAUNCH"
  | "NO_IOS_RUNTIME"
  | "READY";

export type XcodeDiagnosis = {
  state: XcodeState;
  arch: "arm64" | "x86_64" | "other";
  macOSVersion: string | null;
  xcodeAppInstalled: boolean;
  selectedDeveloperDir: string | null;
  xcodeVersion: string | null;
  simctlAvailable: boolean;
  runtimes: Array<{ identifier: string; name: string; version: string; isAvailable: boolean }>;
  deviceTypes: Array<{ identifier: string; name: string }>;
  devices: Array<{ udid: string; name: string; runtime: string; state: string }>;
  xcodesInstalled: boolean;
  message: string;
};

async function run(bin: string, args: string[], timeout = 15_000): Promise<{ stdout: string; ok: boolean; stderr: string }> {
  try {
    const { stdout } = await execFileAsync(bin, args, { timeout, maxBuffer: 4 * 1024 * 1024 });
    return { stdout, ok: true, stderr: "" };
  } catch (error) {
    return { stdout: String((error as { stdout?: string })?.stdout ?? ""), ok: false, stderr: String((error as { stderr?: string })?.stderr ?? error) };
  }
}

export async function diagnoseXcode(): Promise<XcodeDiagnosis> {
  const arch = hostArch();
  if (!isMac()) {
    return {
      state: "NO_XCODE", arch, macOSVersion: null, xcodeAppInstalled: false, selectedDeveloperDir: null,
      xcodeVersion: null, simctlAvailable: false, runtimes: [], deviceTypes: [], devices: [], xcodesInstalled: false,
      message: "The real iOS Simulator only runs on macOS.",
    };
  }

  const [swVers, selectPath, xcodesBin] = await Promise.all([
    run("sw_vers", ["-productVersion"]),
    run("xcode-select", ["-p"]),
    resolveBin("xcodes"),
  ]);
  const macOSVersion = swVers.ok ? swVers.stdout.trim() : null;
  const selectedDeveloperDir = selectPath.ok ? selectPath.stdout.trim() : null;
  const xcodeAppInstalled = fs.existsSync("/Applications/Xcode.app");
  const isCltOnly = Boolean(selectedDeveloperDir && /CommandLineTools/.test(selectedDeveloperDir));

  if (!selectedDeveloperDir) {
    return {
      state: "NO_XCODE", arch, macOSVersion, xcodeAppInstalled, selectedDeveloperDir, xcodeVersion: null,
      simctlAvailable: false, runtimes: [], deviceTypes: [], devices: [], xcodesInstalled: Boolean(xcodesBin),
      message: "No developer tools are selected at all.",
    };
  }

  if (isCltOnly) {
    return {
      state: xcodeAppInstalled ? "XCODE_INSTALLED_NOT_SELECTED" : "COMMAND_LINE_TOOLS_ONLY",
      arch, macOSVersion, xcodeAppInstalled, selectedDeveloperDir, xcodeVersion: null, simctlAvailable: false,
      runtimes: [], deviceTypes: [], devices: [], xcodesInstalled: Boolean(xcodesBin),
      message: xcodeAppInstalled
        ? "Xcode.app is installed but Command Line Tools is still the active developer directory."
        : "Only Command Line Tools are installed — full Xcode is required for the iOS Simulator.",
    };
  }

  const versionResult = await run("xcodebuild", ["-version"]);
  if (!versionResult.ok) {
    return {
      state: "XCODE_NEEDS_FIRST_LAUNCH", arch, macOSVersion, xcodeAppInstalled: true, selectedDeveloperDir,
      xcodeVersion: null, simctlAvailable: false, runtimes: [], deviceTypes: [], devices: [],
      xcodesInstalled: Boolean(xcodesBin), message: "Xcode is selected but hasn't completed first launch (license/component install).",
    };
  }
  const xcodeVersion = /Xcode\s+([\d.]+)/.exec(versionResult.stdout)?.[1] ?? versionResult.stdout.trim();

  const [runtimesResult, deviceTypesResult, devicesResult] = await Promise.all([
    run("xcrun", ["simctl", "list", "runtimes", "-j"]),
    run("xcrun", ["simctl", "list", "devicetypes", "-j"]),
    run("xcrun", ["simctl", "list", "devices", "available", "-j"]),
  ]);

  if (!runtimesResult.ok) {
    return {
      state: "XCODE_NEEDS_FIRST_LAUNCH", arch, macOSVersion, xcodeAppInstalled: true, selectedDeveloperDir, xcodeVersion,
      simctlAvailable: false, runtimes: [], deviceTypes: [], devices: [], xcodesInstalled: Boolean(xcodesBin),
      message: "xcrun simctl still isn't usable — run `xcodebuild -runFirstLaunch`.",
    };
  }

  const runtimesJson = JSON.parse(runtimesResult.stdout || "{}") as { runtimes?: Array<{ identifier: string; name: string; version: string; isAvailable: boolean; bundlePath?: string }> };
  const runtimes = (runtimesJson.runtimes ?? []).filter((r) => /iOS/i.test(r.name));
  const deviceTypesJson = deviceTypesResult.ok ? JSON.parse(deviceTypesResult.stdout || "{}") as { devicetypes?: Array<{ identifier: string; name: string }> } : { devicetypes: [] };
  const deviceTypes = (deviceTypesJson.devicetypes ?? []).filter((d) => /iPhone/i.test(d.name));
  const devicesJson = devicesResult.ok ? JSON.parse(devicesResult.stdout || "{}") as { devices?: Record<string, Array<{ udid: string; name: string; state: string }>> } : { devices: {} };
  const devices = Object.entries(devicesJson.devices ?? {}).flatMap(([runtimeKey, list]) =>
    list.map((d) => ({ udid: d.udid, name: d.name, runtime: runtimeKey, state: d.state })));

  const hasAvailableIosRuntime = runtimes.some((r) => r.isAvailable);
  if (!hasAvailableIosRuntime) {
    return {
      state: "NO_IOS_RUNTIME", arch, macOSVersion, xcodeAppInstalled: true, selectedDeveloperDir, xcodeVersion,
      simctlAvailable: true, runtimes, deviceTypes, devices, xcodesInstalled: Boolean(xcodesBin),
      message: "Xcode is ready but no iOS Simulator runtime is installed (Xcode > Settings > Platforms).",
    };
  }

  return {
    state: "READY", arch, macOSVersion, xcodeAppInstalled: true, selectedDeveloperDir, xcodeVersion,
    simctlAvailable: true, runtimes, deviceTypes, devices, xcodesInstalled: Boolean(xcodesBin),
    message: "Ready.",
  };
}

export type XcodeVersionListing = { version: string; build: string; installed: boolean };

/** Public version catalog via `xcodes list` — no Apple ID needed for this part. */
export async function listAvailableXcodeVersions(): Promise<XcodeVersionListing[]> {
  const xcodes = await resolveBin("xcodes");
  if (!xcodes) return [];
  const [listResult, installedResult] = await Promise.all([
    run(xcodes, ["list"], 20_000),
    run(xcodes, ["installed"], 10_000),
  ]);
  if (!listResult.ok) return [];
  const installedVersions = new Set(installedResult.stdout.split("\n").map((line) => line.trim().split(" ")[0]).filter(Boolean));
  return listResult.stdout
    .split("\n")
    .map((line) => /^([\d.]+(?:\s+[\w\s]+)?)\s+\(([\w.]+)\)/.exec(line.trim()))
    .filter((match): match is RegExpExecArray => Boolean(match))
    .map((match) => ({ version: match[1].trim(), build: match[2], installed: installedVersions.has(match[1].trim().split(" ")[0]) }));
}

/**
 * The exact command to install a given Xcode version. Also runnable inside
 * Clyra's own terminal (IPhoneInstallTerminal) — the interactive Apple ID/
 * password/MFA prompt happens in that real shell, typed by the user, never
 * proxied through this server or an AI prompt. Resolves the absolute binary
 * path rather than the bare `xcodes` name: the terminal's shell doesn't
 * necessarily have Clyra's resolved install location (e.g. the no-sudo
 * ~/.homebrew checkout used when the official Homebrew installer needs
 * admin rights this account doesn't have) on its PATH.
 */
export async function installCommandFor(version: string) {
  const xcodes = await resolveBin("xcodes");
  return `${xcodes ?? "xcodes"} install "${version}"`;
}
