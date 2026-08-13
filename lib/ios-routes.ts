/**
 * iOS App Mode routes for the Vibe Coder.
 *
 * Provides the Xcode toolchain status, simulator inventory and the full
 * build → boot → install → launch → stream pipeline backed by the real
 * local toolchain and the embedded ios-bridge server. On Windows/Linux the
 * endpoints report a clean "connect a Mac" state instead of failing.
 */
import type { Application } from "express";
import path from "node:path";
import fs from "node:fs";
import { clyraDataPath } from "./runtime-paths";
import {
  buildIosApp,
  findIosProject,
  isMac,
  listSimulators,
  xcodeStatus,
  zipAppBundle,
} from "./ios-toolchain";
import {
  iosBridgeCreateSession,
  iosBridgeEnsure,
  iosBridgeInstallAndLaunch,
  iosBridgeUrl,
} from "./ios-bridge-manager";

function safeProjectId(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 96);
}

function projectFilesRoot(projectId: string) {
  return path.join(clyraDataPath("projects"), safeProjectId(projectId), "files");
}

/**
 * Simulator streams do not expose a browser DOM. Give Visual Edit the closest
 * trustworthy SwiftUI/UIKit identity we have: project source metadata. The
 * coding agent receives that source hint and resolves the precise view before
 * applying the requested edit.
 */
function closestIosViewMetadata(root: string) {
  const candidates: Array<{ file: string; name: string; line: number }> = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 5 || candidates.length > 80) return;
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(absolute, depth + 1);
      if (!entry.isFile() || !entry.name.endsWith(".swift")) continue;
      let source = "";
      try { source = fs.readFileSync(absolute, "utf8"); } catch { continue; }
      const match = /(?:struct|class)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?::\s*(?:View|UIViewController))?/.exec(source);
      if (!match) continue;
      candidates.push({
        file: path.relative(root, absolute).replace(/\\/g, "/"),
        name: match[1],
        line: source.slice(0, match.index).split("\n").length,
      });
    }
  };
  walk(root, 0);
  return candidates.find((item) => /content|main|home|root|view/i.test(item.name)) ?? candidates[0] ?? null;
}

/** Active iOS bridge session per project so relaunches refresh the same app. */
const projectSessions = new Map<string, { sessionId: string; device: string; version: string }>();

export function registerIosRoutes(app: Application) {
  // A native preview must not try to build while the coding agent is still
  // creating the Xcode project. The renderer uses this lightweight check to
  // retain its normal preview loading state until there is something real for
  // Xcode to build.
  app.get("/api/ios/projects/:projectId/readiness", (req, res) => {
    const projectId = safeProjectId(String(req.params.projectId ?? ""));
    if (!projectId) {
      res.status(400).json({ error: "A valid project ID is required." });
      return;
    }
    const project = findIosProject(projectFilesRoot(projectId));
    res.json({
      ready: Boolean(project),
      kind: project?.kind ?? null,
      projectPath: project ? path.basename(project.path) : null,
    });
  });

  app.get("/api/ios/projects/:projectId/inspect", (req, res) => {
    const projectId = safeProjectId(String(req.params.projectId ?? ""));
    if (!projectId) {
      res.status(400).json({ error: "A valid project ID is required." });
      return;
    }
    const metadata = closestIosViewMetadata(projectFilesRoot(projectId));
    res.json({ metadata });
  });

  app.get("/api/ios/status", async (_req, res) => {
    const xcode = await xcodeStatus();
    const simulators = await listSimulators();
    const bridge = iosBridgeUrl();
    res.json({
      mac: isMac(),
      xcode: xcode.installed ? xcode.version : null,
      simulators,
      booted: simulators.find((s) => s.booted) ?? null,
      bridgeRunning: Boolean(bridge),
      bridgeUrl: bridge,
    });
  });

  app.post("/api/ios/bridge/start", async (_req, res) => {
    if (!isMac()) {
      res.status(400).json({ error: "The iOS Simulator runs on a Mac with Xcode installed." });
      return;
    }
    const result = await iosBridgeEnsure();
    if (!result.running) {
      res.status(503).json({ error: result.error ?? "ios-bridge could not start." });
      return;
    }
    res.json({ ok: true, url: result.url });
  });

  /**
   * Full pipeline: xcodebuild → simulator session → install → launch →
   * stream URL. Build failures return the real xcodebuild output so the UI
   * can surface the error and the agent can fix it.
   */
  app.post("/api/ios/launch", async (req, res) => {
    if (!isMac()) {
      res.status(400).json({ error: "The iOS Simulator requires a Mac with Xcode installed." });
      return;
    }
    const projectId = safeProjectId(String(req.body?.projectId ?? ""));
    if (!projectId) {
      res.status(400).json({ error: "A valid project ID is required." });
      return;
    }
    const root = projectFilesRoot(projectId);
    const project = findIosProject(root);
    if (!project) {
      res.status(400).json({ error: "This project does not contain an Xcode project or Swift package yet." });
      return;
    }
    try {
      // Reuse the existing simulator session for this project when possible.
      let session = projectSessions.get(projectId);
      let udid: string | undefined;
      if (!session) {
        const simulators = await listSimulators();
        const booted = simulators.find((s) => s.booted);
        const device = String(req.body?.deviceName ?? "") || booted?.name || simulators[0]?.name || "iPhone 17 Pro";
        const version = String(req.body?.iosVersion ?? "") || booted?.version || simulators[0]?.version || "26";
        const bridge = await iosBridgeEnsure();
        if (!bridge.running) {
          res.status(503).json({ error: bridge.error ?? "ios-bridge is unavailable." });
          return;
        }
        const created = await iosBridgeCreateSession(device, version);
        session = { sessionId: created.sessionId, device, version };
        projectSessions.set(projectId, session);
        udid = created.udid || booted?.udid;
      }
      if (!udid) {
        const simulators = await listSimulators();
        udid = simulators.find((s) => s.booted)?.udid;
      }

      // Real build through the local Xcode toolchain.
      const build = await buildIosApp(root, udid);
      if (!build.ok || !build.appPath) {
        res.status(422).json({ ok: false, error: build.error ?? "Build failed.", buildOutput: build.output.slice(-6000) });
        return;
      }

      const zipPath = path.join(root, ".clyra-build", "app.zip");
      await zipAppBundle(build.appPath, zipPath);
      await iosBridgeInstallAndLaunch(session.sessionId, zipPath);

      res.json({
        ok: true,
        sessionId: session.sessionId,
        controlUrl: `${iosBridgeUrl()}/control/${encodeURIComponent(session.sessionId)}`,
        device: session.device,
        version: session.version,
        bundleId: build.bundleId,
        buildSucceeded: true,
      });
    } catch (error) {
      res.status(422).json({
        ok: false,
        error: error instanceof Error ? error.message : "The iOS pipeline failed.",
      });
    }
  });

  app.post("/api/ios/relaunch", async (req, res) => {
    const projectId = safeProjectId(String(req.body?.projectId ?? ""));
    const session = projectSessions.get(projectId);
    if (!session) {
      res.status(400).json({ error: "No simulator session exists yet for this project." });
      return;
    }
    try {
      const root = projectFilesRoot(projectId);
      const zipPath = path.join(root, ".clyra-build", "app.zip");
      if (!fs.existsSync(zipPath)) {
        res.status(400).json({ error: "No built app found. Run the build first." });
        return;
      }
      await iosBridgeInstallAndLaunch(session.sessionId, zipPath);
      res.json({ ok: true });
    } catch (error) {
      res.status(422).json({ error: error instanceof Error ? error.message : "Relaunch failed." });
    }
  });
}

/** True when a project directory looks like an Apple/iOS project. */
export function detectIosPlatform(root: string): boolean {
  try {
    const walk = (dir: string, depth: number): boolean => {
      if (depth > 3) return false;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return false;
      }
      for (const entry of entries.slice(0, 400)) {
        const name = entry.name;
        if (name === "node_modules" || name.startsWith(".")) continue;
        if (entry.isDirectory() && (name.endsWith(".xcodeproj") || name.endsWith(".xcworkspace"))) return true;
        if (entry.isFile() && (name === "Package.swift" || name.endsWith(".swift"))) return true;
        if (entry.isDirectory() && walk(path.join(dir, name), depth + 1)) return true;
      }
      return false;
    };
    return walk(root, 0);
  } catch {
    return false;
  }
}
