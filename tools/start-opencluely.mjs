/** Start OpenCluely from npm on macOS, Linux, Windows 10, and Windows 11. */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const isWindows = process.platform === "win32";
const script = path.join(root, "scripts", isWindows ? "start-opencluely-electron.ps1" : "start-opencluely-electron.sh");
const command = isWindows ? "powershell.exe" : "bash";
const args = isWindows
  ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script]
  : [script];
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;

const child = spawn(command, args, {
  cwd: root,
  stdio: "inherit",
  env: environment,
});

child.once("error", (error) => {
  console.error(`Could not launch OpenCluely: ${error.message}`);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  if (signal) process.exitCode = 1;
  else process.exitCode = code ?? 1;
});
