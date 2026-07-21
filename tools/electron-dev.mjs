import { spawn } from "node:child_process";
import path from "node:path";

const electronBinary = path.resolve("node_modules", ".bin", process.platform === "win32" ? "electron.cmd" : "electron");
const child = spawn(electronBinary, ["."], {
  cwd: process.cwd(),
  env: { ...process.env, CLYRA_ELECTRON_DEV: "1" },
  stdio: "inherit",
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (!child.killed) child.kill(signal);
  });
}

child.once("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
