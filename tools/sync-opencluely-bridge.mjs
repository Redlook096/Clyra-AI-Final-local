import { cp, mkdir, stat } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const bridge = path.join(root, "scripts", "opencluely-bridge");
const app = path.join(root, "apps", "opencluely");

try {
  await stat(path.join(app, "package.json"));
} catch {
  throw new Error("OpenCluely is not installed. Run the documented clone/setup flow first.");
}

const files = [
  ["main.js", "main.js"],
  ["window.manager.js", "src/managers/window.manager.js"],
  ["capture.service.js", "src/services/capture.service.js"],
  ["capture.service.js", "capture.service.js"],
  ["llm.service.js", "src/services/llm.service.js"],
  ["desktop-control.service.js", "src/services/desktop-control.service.js"],
  ["desktop-control.service.js", "desktop-control.service.js"],
  ["control-safety.js", "src/services/control-safety.js"],
  ["macos-input.py", "src/services/macos-input.py"],
  ["macos-input.py", "macos-input.py"],
  ["macos-input.swift", "src/services/macos-input.swift"],
  ["computer-agent.service.js", "computer-agent.service.js"],
  ["computer-agent.service.js", "src/services/computer-agent.service.js"],
  ["os-ai-computer-use.service.js", "os-ai-computer-use.service.js"],
  ["os-ai-computer-use.service.js", "src/services/os-ai-computer-use.service.js"],
  ["computer-agent-bash.js", "computer-agent-bash.js"],
  ["computer-agent-api.mjs", "computer-agent-api.mjs"],
  ["preload.js", "preload.js"],
  ["ui/bar-chat.js", "src/ui/bar-chat.js"],
  ["html/index.html", "index.html"],
];

for (const [source, target] of files) {
  const sourcePath = path.join(bridge, source);
  const targetPath = path.join(app, target);
  await mkdir(path.dirname(targetPath), { recursive: true });
  await cp(sourcePath, targetPath, { force: true });
}

console.log("Synced OpenCluely bridge (cross-platform Node workflow).");
