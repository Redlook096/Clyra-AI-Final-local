import { spawn } from "node:child_process";
import path from "node:path";

const electronBinary = path.resolve("node_modules", ".bin", process.platform === "win32" ? "electron.cmd" : "electron");
const env = { ...process.env, CLYRA_ELECTRON_DEV: "1" };
// Cursor/agent shells can inherit ELECTRON_RUN_AS_NODE from helper processes.
// That forces Electron to behave like plain Node and breaks `import from "electron"`.
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electronBinary, ["."], {
  cwd: process.cwd(),
  env,
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
