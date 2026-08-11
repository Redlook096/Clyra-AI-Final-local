/** Prepare a platform-specific Electron release without shell-specific env syntax. */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const target = String(process.argv[2] || "").trim();
if (!/^(?:darwin|linux|win32)-(?:x64|arm64)$/.test(target)) {
  throw new Error("Usage: node tools/prepare-electron-target.mjs <darwin|linux|win32>-<x64|arm64>");
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

function run(command, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit", env });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited with ${signal || code}`));
    });
  });
}

await run(npm, ["run", "build"]);
await run(process.execPath, ["tools/build-electron-sidecar.mjs"], {
  ...process.env,
  CLYRA_SIDECAR_TARGET: target,
});
await run(process.execPath, ["tools/seed-desktop-runtime-config.mjs"]);
console.log(`Prepared Clyra desktop resources for ${target}.`);
