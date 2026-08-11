/**
 * Static Windows 10/11 regression guard.
 *
 * This can run on any host, including CI on macOS/Linux, and protects the
 * Windows-specific paths that cannot be exercised without a Windows desktop.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = async (relativePath) => readFile(path.join(root, relativePath), "utf8");

const [desktopControl, desktopMain, sidecarBuild, openCluelyLauncher, openCluelyControl, captureService, packageJson, appCss, npmLauncher] = await Promise.all([
  source("electron/desktop-control.mjs"),
  source("electron/main.mjs"),
  source("tools/build-electron-sidecar.mjs"),
  source("scripts/start-opencluely-electron.ps1"),
  source("scripts/opencluely-bridge/desktop-control.service.js"),
  source("scripts/opencluely-bridge/capture.service.js"),
  source("package.json"),
  source("src/index.css"),
  source("tools/start-opencluely.mjs"),
]);

const requirements = [
  [desktopControl, /powershell-sendinput/, "Screen Companion reports a Windows input driver"],
  [desktopControl, /ClyraWindowsInput/, "Screen Companion includes native Windows input"],
  [desktopControl, /TypeText\(\$value\)/, "Screen Companion supports Unicode text input on Windows"],
  [desktopControl, /case "scroll"/, "Screen Companion supports scroll actions"],
  [desktopControl, /setVisibleOnAllWorkspaces/, "Screen Companion overlay remains visible on Windows desktops"],
  [desktopMain, /process\.platform === "darwin" \? "hidden" : "default"/, "Main Clyra window retains Windows caption controls"],
  [desktopMain, /powershell\.exe/, "Main Clyra app launches the Windows OpenCluely launcher"],
  [sidecarBuild, /win32-arm64/, "Native server sidecar supports Windows on ARM"],
  [sidecarBuild, /CLYRA_SIDECAR_TARGET/, "Native server sidecar can target the release platform"],
  [openCluelyLauncher, /electron\.cmd/, "OpenCluely launcher invokes Electron correctly on Windows"],
  [openCluelyLauncher, /Remove-Item Env:ELECTRON_RUN_AS_NODE/, "OpenCluely launcher clears Electron Node mode on Windows"],
  [openCluelyControl, /process\.platform === 'win32'/, "OpenCluely Take Control has a Windows implementation"],
  [captureService, /_captureWindowsNative/, "OpenCluely has a native Windows screen-capture path"],
  [packageJson, /\"opencluely:start\": \"node tools\/start-opencluely\.mjs\"/, "npm uses the cross-platform OpenCluely launcher"],
  [packageJson, /\"desktop:build:win\"/, "npm exposes a Windows x64 release build"],
  [packageJson, /\"desktop:build:win:arm64\"/, "npm exposes a Windows ARM64 release build"],
  [npmLauncher, /isWindows/, "OpenCluely npm launcher selects the current operating system"],
  [appCss, /Segoe UI/, "Clyra UI includes a Windows system font fallback"],
];

for (const [content, pattern, description] of requirements) {
  assert.match(content, pattern, description);
}

console.log(`Windows compatibility smoke passed (${requirements.length} checks).`);
