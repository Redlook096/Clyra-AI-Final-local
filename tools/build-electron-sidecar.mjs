import { chmod, mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";

const bunTarget = {
  "darwin-x64": "bun-darwin-x64",
  "darwin-arm64": "bun-darwin-arm64",
  "linux-x64": "bun-linux-x64",
  "linux-arm64": "bun-linux-arm64",
  "win32-x64": "bun-windows-x64",
}[`${process.platform}-${process.arch}`];

if (!bunTarget) throw new Error(`Unsupported Electron sidecar target: ${process.platform}-${process.arch}`);

const outputDir = path.resolve("desktop-binaries");
await mkdir(outputDir, { recursive: true });
const output = path.join(outputDir, process.platform === "win32" ? "clyra-server.exe" : "clyra-server");
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
if (process.platform !== "win32") await chmod(output, 0o755);
console.log(`Prepared Electron sidecar: ${output}`);
