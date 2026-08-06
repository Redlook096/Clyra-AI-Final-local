/**
 * Launch Electron Screen Companion smoke: capture → ask → take control → stop.
 * Writes /opt/cursor/artifacts/companion-smoke.json
 */
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

const electronBinary = path.resolve(
  "node_modules",
  ".bin",
  process.platform === "win32" ? "electron.cmd" : "electron",
);
const artifactsDir = process.env.CLYRA_COMPANION_ARTIFACTS || "/opt/cursor/artifacts";
const reportPath = path.join(artifactsDir, "companion-smoke.json");

await fs.mkdir(artifactsDir, { recursive: true });
try {
  await fs.unlink(reportPath);
} catch {
  /* first run */
}

const env = {
  ...process.env,
  CLYRA_ELECTRON_DEV: "1",
  CLYRA_COMPANION_SMOKE: "1",
  CLYRA_COMPANION_SMOKE_EXIT: "1",
  CLYRA_COMPANION_ARTIFACTS: artifactsDir,
};
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronBinary, ["."], {
  cwd: process.cwd(),
  env,
  stdio: ["ignore", "pipe", "pipe"],
});

let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => {
  stdout += chunk.toString();
  process.stdout.write(chunk);
});
child.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
  process.stderr.write(chunk);
});

const exitCode = await new Promise((resolve) => {
  const timer = setTimeout(() => {
    child.kill("SIGTERM");
    resolve(124);
  }, 90_000);
  child.once("exit", (code) => {
    clearTimeout(timer);
    resolve(code ?? 1);
  });
});

let report = null;
try {
  report = JSON.parse(await fs.readFile(reportPath, "utf8"));
} catch {
  report = null;
}

if (!report?.ok) {
  console.error("Companion Electron smoke failed", { exitCode, report, stderrTail: stderr.slice(-1500) });
  process.exit(exitCode || 1);
}

console.log("PASS companion electron smoke");
process.exit(0);
