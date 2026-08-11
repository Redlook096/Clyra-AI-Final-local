import { chmod, mkdir, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";

const targetPlatform = process.env.CLYRA_SIDECAR_TARGET || `${process.platform}-${process.arch}`;
const bunTarget = {
  "darwin-x64": "bun-darwin-x64",
  "darwin-arm64": "bun-darwin-arm64",
  "linux-x64": "bun-linux-x64",
  "linux-arm64": "bun-linux-arm64",
  "win32-x64": "bun-windows-x64",
  "win32-arm64": "bun-windows-arm64",
}[targetPlatform];

if (!bunTarget) throw new Error(`Unsupported Electron sidecar target: ${targetPlatform}`);

const outputDir = path.resolve("desktop-binaries");
await mkdir(outputDir, { recursive: true });
const isWindowsTarget = targetPlatform.startsWith("win32-");
const output = path.join(outputDir, isWindowsTarget ? "clyra-server.exe" : "clyra-server");
const result = spawnSync("bun", [
  "build",
  "server.ts",
  "--compile",
  `--target=${bunTarget}`,
  "--define=process.env.NODE_ENV=\"production\"",
  "--external=electron",
  "--external=chromium-bidi/*",
  "--external=vite",
  `--outfile=${output}`,
], { cwd: process.cwd(), stdio: "inherit" });

if (result.status !== 0) process.exit(result.status ?? 1);
// A release must contain exactly the helper matching its target platform.
// Only remove the stale generated sibling after the new helper was compiled,
// so a failed build never leaves a previously working release without one.
await rm(path.join(outputDir, isWindowsTarget ? "clyra-server" : "clyra-server.exe"), { force: true });
if (!isWindowsTarget) await chmod(output, 0o755);
console.log(`Prepared Electron sidecar: ${output}`);
