/** Host capability detection for the local Apple Host provider. */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function isMac() {
  return process.platform === "darwin";
}

export function hostArch(): "arm64" | "x86_64" | "other" {
  const arch = process.arch;
  if (arch === "arm64") return "arm64";
  if (arch === "x64") return "x86_64";
  return "other";
}

/** serve-sim's bundled streaming helper only ships an Apple Silicon binary today. */
export function supportsFastStream() {
  return isMac() && hostArch() === "arm64";
}

let cachedXcodeVersion: string | null | undefined;

/** Returns the Xcode version string, or null when only Command Line Tools (no simctl) are installed. */
export async function xcodeVersion(): Promise<string | null> {
  if (cachedXcodeVersion !== undefined) return cachedXcodeVersion;
  if (!isMac()) return (cachedXcodeVersion = null);
  try {
    await execFileAsync("xcrun", ["--find", "simctl"], { timeout: 5_000 });
    const { stdout } = await execFileAsync("xcodebuild", ["-version"], { timeout: 5_000 });
    cachedXcodeVersion = /Xcode\s+([\d.]+)/.exec(stdout)?.[1] ?? stdout.trim();
  } catch {
    cachedXcodeVersion = null;
  }
  return cachedXcodeVersion;
}

/**
 * Locates a CLI tool across every prefix Clyra might reasonably find it in —
 * including a user-owned, no-sudo Homebrew install at ~/.homebrew (the
 * Homebrew installer refuses to run without admin rights; a plain tarball
 * checkout into a user directory needs none and works identically for
 * bottled formulae like sim-use).
 */
const binCache = new Map<string, string | null>();

export async function resolveBin(name: string): Promise<string | null> {
  if (binCache.has(name)) return binCache.get(name)!;
  const candidates = [
    path.join(os.homedir(), ".homebrew", "bin", name),
    "/opt/homebrew/bin/" + name,
    "/usr/local/bin/" + name,
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      binCache.set(name, candidate);
      return candidate;
    }
  }
  try {
    const { stdout } = await execFileAsync("sh", ["-lc", `command -v ${name}`], { timeout: 3_000 });
    const found = stdout.trim() || null;
    binCache.set(name, found);
    return found;
  } catch {
    binCache.set(name, null);
    return null;
  }
}

export function resetHostCacheForTests() {
  cachedXcodeVersion = undefined;
  binCache.clear();
}
