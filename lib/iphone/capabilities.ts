/** The structured AppleHostCapabilities object every Apple Host publishes — what selects between hosts and providers, never guessed from the connecting client's OS. */
import { execFile } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";
import { hostArch, isMac, resolveBin, supportsFastStream } from "./host";
import { diagnoseXcode } from "./xcodeSetup";
import * as simUse from "./simUse";

const execFileAsync = promisify(execFile);

export type AppleHostCapabilities = {
  hostId: string;
  hostname: string;
  macArchitecture: "arm64" | "x86_64" | "other";
  macModel: string | null;
  macOSVersion: string | null;
  availableDiskSpaceGB: number | null;
  fullXcodeInstalled: boolean;
  xcodeVersion: string | null;
  simulatorRuntimes: Array<{ identifier: string; name: string; version: string; isAvailable: boolean }>;
  deviceTypes: Array<{ identifier: string; name: string }>;
  roles: Array<"development" | "simulator" | "build" | "release">;
  providerCapabilities: {
    supportsServeSim: boolean;
    supportsIdb: boolean;
    supportsSimUse: boolean;
    supportsStreaming: boolean;
    supportsAccessibility: boolean;
    supportsBuild: boolean;
    supportsInstall: boolean;
    supportsLaunch: boolean;
  };
  health: "healthy" | "degraded" | "unavailable";
};

async function diskSpaceGB(): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync("df", ["-g", "/"], { timeout: 5_000 });
    const line = stdout.trim().split("\n")[1];
    const available = Number(line?.split(/\s+/)[3]);
    return Number.isFinite(available) ? available : null;
  } catch {
    return null;
  }
}

async function macModel(): Promise<string | null> {
  if (!isMac()) return null;
  try {
    const { stdout } = await execFileAsync("sysctl", ["-n", "hw.model"], { timeout: 5_000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export async function getAppleHostCapabilities(): Promise<AppleHostCapabilities> {
  const [diag, disk, model, serveSimBin, idbBin, simUseAvailable] = await Promise.all([
    diagnoseXcode(),
    diskSpaceGB(),
    macModel(),
    resolveBin("serve-sim"),
    resolveBin("idb_companion"),
    simUse.isAvailable(),
  ]);
  const ready = diag.state === "READY";
  const roles: AppleHostCapabilities["roles"] = ready ? ["development", "simulator", "build"] : [];
  return {
    hostId: os.hostname(),
    hostname: os.hostname(),
    macArchitecture: hostArch(),
    macModel: model,
    macOSVersion: diag.macOSVersion,
    availableDiskSpaceGB: disk,
    fullXcodeInstalled: diag.state !== "NO_XCODE" && diag.state !== "COMMAND_LINE_TOOLS_ONLY",
    xcodeVersion: diag.xcodeVersion,
    simulatorRuntimes: diag.runtimes,
    deviceTypes: diag.deviceTypes,
    roles,
    providerCapabilities: {
      supportsServeSim: Boolean(serveSimBin) && supportsFastStream(),
      supportsIdb: Boolean(idbBin),
      supportsSimUse: simUseAvailable,
      supportsStreaming: ready && (supportsFastStream() || simUseAvailable),
      supportsAccessibility: simUseAvailable,
      supportsBuild: ready,
      supportsInstall: ready,
      supportsLaunch: ready,
    },
    health: ready ? "healthy" : diag.state === "NO_XCODE" ? "unavailable" : "degraded",
  };
}
