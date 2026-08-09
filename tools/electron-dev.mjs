import { spawn } from "node:child_process";
import path from "node:path";
import { patchClyraElectron } from "./patch-electron-macos-privacy.mjs";

// Unique macOS TCC identity so Privacy → Microphone lists "Clyra".
try {
  const patched = patchClyraElectron();
  if (patched?.ok) {
    const signNote =
      process.env.CLYRA_ELECTRON_CODESIGN === "1"
        ? ` signed=${patched.signed ? "yes" : "no"}`
        : " (plist identity only; set CLYRA_ELECTRON_CODESIGN=1 to ad-hoc resign)";
    console.log(
      `[electron-dev] macOS privacy identity → ${patched.bundleName} (${patched.bundleId})` +
        ` helpers=${patched.helpers ?? 0}${signNote}`,
    );
    if (patched.signError && process.env.CLYRA_ELECTRON_CODESIGN === "1") {
      console.warn(`[electron-dev] codesign warning: ${patched.signError}`);
    }
  }
} catch (error) {
  console.warn("[electron-dev] could not patch Electron Info.plist:", error?.message || error);
}

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
