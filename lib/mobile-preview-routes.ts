/**
 * Physical-device Swift preview service.
 *
 * xtool owns the portable SwiftPM build/sign/install path; go-ios owns the
 * connected-device stream and UI automation. This module deliberately has no
 * simulator, Xcode process, VM, or renderer-side shell access.
 */
import type { Application } from "express";
import { execFile, spawn } from "node:child_process";
import fsSync, { promises as fs } from "node:fs";
import net from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import { clyraDataPath } from "./runtime-paths";

const execFileAsync = promisify(execFile);
const MAX_OUTPUT = 512 * 1024;

type DeviceSession = { port: number; process: import("node:child_process").ChildProcess; bundleId: string; deviceId?: string };
const deviceSessions = new Map<string, DeviceSession>();

function safeProjectId(value: string) { return value.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 96); }
function projectRoot(projectId: string) { return path.join(clyraDataPath("projects"), safeProjectId(projectId), "files"); }
function isWindows() { return process.platform === "win32"; }

async function shellPath(binary: "xtool" | "ios") {
  try {
    if (isWindows()) {
      const { stdout } = await execFileAsync("wsl.exe", ["-e", "sh", "-lc", `command -v ${binary}`], { timeout: 2_000, maxBuffer: 8_192 });
      return stdout.trim() || null;
    }
    const { stdout } = await execFileAsync("sh", ["-lc", `command -v ${binary}`], { timeout: 2_000, maxBuffer: 8_192 });
    return stdout.trim() || null;
  } catch { return null; }
}

async function run(binary: string, args: string[], cwd?: string) {
  if (isWindows()) {
    const command = [binary, ...args].map((value) => `'${value.replace(/'/g, "'\\''")}'`).join(" ");
    return execFileAsync("wsl.exe", ["-e", "sh", "-lc", command], { cwd, timeout: 180_000, maxBuffer: MAX_OUTPUT });
  }
  return execFileAsync(binary, args, { cwd, timeout: 180_000, maxBuffer: MAX_OUTPUT });
}

function start(binary: string, args: string[], cwd?: string) {
  if (isWindows()) {
    const command = [binary, ...args].map((value) => `'${value.replace(/'/g, "'\\''")}'`).join(" ");
    return spawn("wsl.exe", ["-e", "sh", "-lc", command], { cwd, stdio: "ignore", windowsHide: true });
  }
  return spawn(binary, args, { cwd, stdio: "ignore" });
}

async function freePort() {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function hasSwiftSource(root: string) {
  try {
    const entries = await fs.readdir(root, { recursive: true });
    return entries.some((entry) => typeof entry === "string" && entry.endsWith(".swift"));
  } catch { return false; }
}

async function configuredStatus() {
  const [xtool, goIos] = await Promise.all([shellPath("xtool"), shellPath("ios")]);
  return {
    configured: Boolean(xtool && goIos),
    xtool: Boolean(xtool),
    goIos: Boolean(goIos),
    host: isWindows() ? "Windows via WSL" : process.platform === "darwin" ? "macOS" : "Linux",
    requiresPhysicalDevice: true,
  };
}

async function readBundleId(root: string) {
  try {
    const config = await fs.readFile(path.join(root, "xtool.yml"), "utf8");
    return /^bundleID:\s*([^\s#]+)/m.exec(config)?.[1] ?? null;
  } catch { return null; }
}

async function newestIpa(root: string): Promise<string | null> {
  const found: Array<{ path: string; modified: number }> = [];
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (depth > 5) return;
    let entries: import("node:fs").Dirent[] = [];
    try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch { return; }
    await Promise.all(entries.map(async (entry) => {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") return walk(absolute, depth + 1);
      if (!entry.isFile() || !entry.name.endsWith(".ipa")) return;
      try { found.push({ path: absolute, modified: (await fs.stat(absolute)).mtimeMs }); } catch { /* ignore */ }
    }));
  };
  await walk(root, 0);
  return found.sort((a, b) => b.modified - a.modified)[0]?.path ?? null;
}

export function detectMobileSwiftProject(root: string) {
  try {
    const stack = [root];
    while (stack.length) {
      const directory = stack.pop()!;
      for (const entry of fsSync.readdirSync(directory, { withFileTypes: true })) {
        if (entry.name.startsWith(".") || /^(node_modules|build|DerivedData|\.build)$/i.test(entry.name)) continue;
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) stack.push(absolute);
        if (entry.isFile() && (entry.name === "Package.swift" || entry.name.endsWith(".swift"))) return true;
      }
    }
  } catch { /* non-existent workspace */ }
  return false;
}

export function registerMobilePreviewRoutes(app: Application) {
  app.get("/api/mobile-preview/status", async (_req, res) => res.json(await configuredStatus()));

  app.get("/api/mobile-preview/projects/:projectId/readiness", async (req, res) => {
    const projectId = safeProjectId(String(req.params.projectId ?? ""));
    if (!projectId) return res.status(400).json({ error: "A valid project ID is required." });
    const root = projectRoot(projectId);
    res.json({ ready: await hasSwiftSource(root), projectPath: root });
  });

  app.get("/api/mobile-preview/devices", async (_req, res) => {
    const status = await configuredStatus();
    if (!status.goIos) return res.json({ devices: [] });
    try {
      const { stdout } = await run("ios", ["list"]);
      res.json({ devices: stdout.split("\n").map((line) => line.trim()).filter(Boolean) });
    } catch { res.json({ devices: [] }); }
  });

  app.post("/api/mobile-preview/projects/:projectId/build", async (req, res) => {
    const projectId = safeProjectId(String(req.params.projectId ?? ""));
    if (!projectId) return res.status(400).json({ error: "A valid project ID is required." });
    const status = await configuredStatus();
    if (!status.configured) {
      return res.status(503).json({ error: "Install and configure xtool and go-ios before using a physical iPhone preview." });
    }
    const root = projectRoot(projectId);
    // go-ios accepts a UDID selection on commands. Keep this server-side so
    // the renderer never gets shell access or device credentials.
    const deviceId = typeof req.body?.deviceId === "string" && req.body.deviceId.trim()
      ? req.body.deviceId.trim().slice(0, 160)
      : undefined;
    const deviceArgs = deviceId ? [`--udid=${deviceId}`] : [];
    if (!await hasSwiftSource(root)) return res.status(422).json({ error: "Waiting for Swift source files." });
    const bundleId = await readBundleId(root);
    if (!bundleId) return res.status(422).json({ error: "Add xtool.yml with a bundleID before building for a physical device." });
    try {
      await run("xtool", ["dev", "build", "--ipa", "--sign"], root);
      const ipa = await newestIpa(root);
      if (!ipa) return res.status(422).json({ error: "xtool finished without producing an IPA." });
      await run("ios", ["install", `--path=${ipa}`, ...deviceArgs], root);
      await run("ios", ["launch", bundleId, ...deviceArgs], root);
      const existing = deviceSessions.get(projectId);
      existing?.process.kill();
      const port = await freePort();
      const stream = start("ios", ["screenshot", "--stream", `--port=${port}`, ...deviceArgs], root);
      const session = { port, process: stream, bundleId, deviceId };
      deviceSessions.set(projectId, session);
      stream.once("exit", () => {
        if (deviceSessions.get(projectId) === session) deviceSessions.delete(projectId);
      });
      res.json({ ok: true, bundleId, streamUrl: `http://127.0.0.1:${port}/`, message: "Installed and launched on the connected iPhone." });
    } catch (error) {
      const detail = error && typeof error === "object" && "stderr" in error ? String((error as { stderr?: string }).stderr || "") : "";
      res.status(422).json({ error: detail || (error instanceof Error ? error.message : "Physical-device build failed.") });
    }
  });

  app.post("/api/mobile-preview/projects/:projectId/input", async (req, res) => {
    const projectId = safeProjectId(String(req.params.projectId ?? ""));
    const action = String(req.body?.action ?? "");
    const x = Math.round(Number(req.body?.x));
    const y = Math.round(Number(req.body?.y));
    if (!projectId || !deviceSessions.has(projectId)) return res.status(409).json({ error: "No connected preview session." });
    try {
      const deviceArgs = deviceSessions.get(projectId)?.deviceId ? [`--udid=${deviceSessions.get(projectId)!.deviceId}`] : [];
      if (action === "tap") await run("ios", ["ui", "tap", `--x=${x}`, `--y=${y}`, ...deviceArgs]);
      else if (action === "swipe") await run("ios", ["ui", "swipe", `--from-x=${x}`, `--from-y=${y}`, `--to-x=${Math.round(Number(req.body?.toX))}`, `--to-y=${Math.round(Number(req.body?.toY))}`, ...deviceArgs]);
      else if (action === "type") await run("ios", ["ui", "type", `--text=${String(req.body?.text ?? "")}`, ...deviceArgs]);
      else if (action === "orientation") await run("ios", ["ui", "orientation", "set", String(req.body?.value ?? "portrait"), ...deviceArgs]);
      else return res.status(400).json({ error: "Unsupported preview input." });
      res.json({ ok: true });
    } catch (error) { res.status(422).json({ error: error instanceof Error ? error.message : "Device input failed." }); }
  });
}
