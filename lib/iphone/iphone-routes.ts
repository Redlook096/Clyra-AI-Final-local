/**
 * The one iPhone system. Everything the panel and the agent use to build,
 * boot, install, launch, control and stream a real iOS Simulator goes
 * through here, which in turn goes through IPhoneProvider — never a
 * direct simctl/serve-sim call from the frontend.
 */
import type { Application } from "express";
import type { Server } from "node:http";
import http from "node:http";
import path from "node:path";
import { clyraDataPath } from "../runtime-paths";
import { proxyUpgrade } from "../preview-proxy";
import { isMac, hostArch, supportsFastStream, xcodeVersion } from "./host";
import { simctlProvider } from "./SimctlProvider";
import type { IPhoneProvider } from "./IPhoneProvider";
import { findIosProject } from "./xcode";
import { pipeMjpegStream } from "./simUseStream";
import { issuePairingCode } from "./remote/PairingManager";
import { diagnoseXcode, listAvailableXcodeVersions, installCommandFor } from "./xcodeSetup";
import { recommendXcodeVersion } from "./xcodeCompatibility";
import { checkDiskSpace } from "./diskSpace";
import { getAppleHostCapabilities } from "./capabilities";

function safeProjectId(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 96);
}
function projectRoot(projectId: string) {
  return path.join(clyraDataPath("projects"), safeProjectId(projectId), "files");
}

/**
 * Which provider a given project is currently pinned to. On macOS this is
 * always the local SimctlProvider. On Windows (or a Mac deliberately paired
 * to a remote Mac) it would be a RemoteAppleHostProvider bound to a saved
 * host from DeviceRegistry — see lib/iphone/remote/RemoteAppleHostProvider.ts.
 * Wiring the Windows build to select that path automatically is not done in
 * this pass (this dev host is macOS); the provider and its pairing protocol
 * are implemented and independently exercised — see the reconnect test.
 */
function providerFor(_projectId: string): IPhoneProvider {
  return simctlProvider;
}

type ProjectSession = { deviceId: string; bundleId?: string; appPath?: string };
const sessions = new Map<string, ProjectSession>();

async function ensureConnected(provider: IPhoneProvider) {
  if (!provider.isConnected()) await provider.connect();
}

export function registerIPhoneRoutes(app: Application) {
  // Shown in the Mac's iPhone panel for a Windows client to type in once;
  // AppleHostServer (attached in server.ts) redeems it over the WS connection.
  app.post("/api/iphone/pairing/code", (_req, res) => {
    res.json(issuePairingCode());
  });

  // Powers the setup wizard's real state machine (NO_XCODE, COMMAND_LINE_TOOLS_ONLY, …).
  app.get("/api/iphone/setup/diagnose", async (_req, res) => {
    res.json(await diagnoseXcode());
  });

  app.get("/api/iphone/setup/disk-space", async (_req, res) => {
    try {
      res.json(await checkDiskSpace());
    } catch (error) {
      res.status(503).json({ error: error instanceof Error ? error.message : "Could not check disk space." });
    }
  });

  app.get("/api/iphone/setup/xcode-versions", async (_req, res) => {
    const versions = await listAvailableXcodeVersions();
    res.json({ versions: versions.slice(-40).reverse() });
  });

  app.get("/api/iphone/capabilities", async (_req, res) => {
    res.json(await getAppleHostCapabilities());
  });

  app.get("/api/iphone/setup/recommended-xcode", async (_req, res) => {
    const diag = await diagnoseXcode();
    if (!diag.macOSVersion) return res.status(503).json({ error: "Could not determine macOS version." });
    res.json(await recommendXcodeVersion(diag.macOSVersion, diag.arch));
  });

  app.get("/api/iphone/setup/install-command", async (req, res) => {
    const version = String(req.query.version ?? "").slice(0, 40);
    if (!version) return res.status(400).json({ error: "A version is required." });
    res.json({ command: await installCommandFor(version) });
  });

  app.get("/api/iphone/status", async (_req, res) => {
    const version = await xcodeVersion();
    const devices = version ? await simctlProvider.listDevices().catch(() => []) : [];
    res.json({
      mac: isMac(),
      arch: hostArch(),
      xcodeVersion: version,
      fastStreamSupported: supportsFastStream(),
      devices,
      booted: devices.find((d) => d.state === "Booted") ?? null,
    });
  });

  app.get("/api/iphone/devices", async (_req, res) => {
    try {
      res.json({ devices: await simctlProvider.listDevices() });
    } catch (error) {
      res.status(503).json({ error: error instanceof Error ? error.message : "Could not list simulators." });
    }
  });

  app.get("/api/iphone/projects/:projectId/readiness", (req, res) => {
    const projectId = safeProjectId(String(req.params.projectId ?? ""));
    if (!projectId) return res.status(400).json({ error: "A valid project ID is required." });
    const root = projectRoot(projectId);
    res.json({ ready: Boolean(findIosProject(root)), projectPath: root });
  });

  /** Full pipeline: boot (if needed) -> build -> install -> launch -> stream. */
  app.post("/api/iphone/projects/:projectId/run", async (req, res) => {
    const projectId = safeProjectId(String(req.params.projectId ?? ""));
    if (!projectId) return res.status(400).json({ error: "A valid project ID is required." });
    const provider = providerFor(projectId);
    try {
      await ensureConnected(provider);
    } catch (error) {
      return res.status(503).json({ error: error instanceof Error ? error.message : "The Apple Host is unavailable." });
    }
    const root = projectRoot(projectId);
    try {
      let session = sessions.get(projectId);
      let deviceId = session?.deviceId || String(req.body?.deviceId ?? "");
      if (!deviceId) {
        const devices = await provider.listDevices();
        deviceId = devices.find((d) => d.state === "Booted")?.udid || devices[0]?.udid || "";
        if (!deviceId) return res.status(422).json({ error: "No simulator runtimes are installed. Open Xcode > Settings > Platforms and install an iOS runtime." });
      }
      await provider.boot(deviceId);
      const build = await provider.build(root, deviceId);
      if (!build.ok || !build.appPath) {
        return res.status(422).json({ ok: false, error: build.error ?? "Build failed.", buildOutput: build.output });
      }
      await provider.install(deviceId, build.appPath);
      if (build.bundleId) await provider.launch(deviceId, build.bundleId);
      const stream = await provider.startStream(deviceId);
      session = { deviceId, bundleId: build.bundleId, appPath: build.appPath };
      sessions.set(projectId, session);
      res.json({ ok: true, deviceId, bundleId: build.bundleId, streamUrl: stream.url, streamKind: stream.kind, buildOutput: build.output });
    } catch (error) {
      res.status(422).json({ ok: false, error: error instanceof Error ? error.message : "The iPhone pipeline failed." });
    }
  });

  app.post("/api/iphone/projects/:projectId/relaunch", async (req, res) => {
    const projectId = safeProjectId(String(req.params.projectId ?? ""));
    const provider = providerFor(projectId);
    const session = sessions.get(projectId);
    if (!session?.appPath || !session.bundleId) return res.status(400).json({ error: "No previous build for this project yet." });
    try {
      await provider.install(session.deviceId, session.appPath);
      await provider.launch(session.deviceId, session.bundleId);
      res.json({ ok: true });
    } catch (error) {
      res.status(422).json({ error: error instanceof Error ? error.message : "Relaunch failed." });
    }
  });

  app.post("/api/iphone/projects/:projectId/terminate", async (req, res) => {
    const projectId = safeProjectId(String(req.params.projectId ?? ""));
    const provider = providerFor(projectId);
    const session = sessions.get(projectId);
    if (!session?.bundleId) return res.status(400).json({ error: "No running app for this project." });
    try {
      await provider.terminate(session.deviceId, session.bundleId);
      res.json({ ok: true });
    } catch (error) {
      res.status(422).json({ error: error instanceof Error ? error.message : "Terminate failed." });
    }
  });

  app.post("/api/iphone/projects/:projectId/rebuild", async (req, res) => {
    const projectId = safeProjectId(String(req.params.projectId ?? ""));
    const provider = providerFor(projectId);
    const session = sessions.get(projectId);
    if (!session) return res.status(400).json({ error: "No active simulator session for this project. Run first." });
    const root = projectRoot(projectId);
    try {
      const build = await provider.build(root, session.deviceId);
      if (!build.ok || !build.appPath) return res.status(422).json({ ok: false, error: build.error ?? "Build failed.", buildOutput: build.output });
      await provider.install(session.deviceId, build.appPath);
      if (build.bundleId) await provider.launch(session.deviceId, build.bundleId);
      sessions.set(projectId, { deviceId: session.deviceId, bundleId: build.bundleId, appPath: build.appPath });
      res.json({ ok: true, buildOutput: build.output });
    } catch (error) {
      res.status(422).json({ ok: false, error: error instanceof Error ? error.message : "Rebuild failed." });
    }
  });

  app.post("/api/iphone/projects/:projectId/control", async (req, res) => {
    const projectId = safeProjectId(String(req.params.projectId ?? ""));
    const provider = providerFor(projectId);
    const session = sessions.get(projectId);
    if (!session) return res.status(409).json({ error: "No active simulator session for this project." });
    const action = String(req.body?.action ?? "");
    try {
      switch (action) {
        case "home":
          await provider.home(session.deviceId);
          break;
        case "tap":
          await provider.tap(session.deviceId, { kind: "normalized", x: Number(req.body?.x), y: Number(req.body?.y) });
          break;
        case "swipe":
          await provider.swipe(session.deviceId, req.body?.direction, { kind: "normalized", x: Number(req.body?.x ?? 0.5), y: Number(req.body?.y ?? 0.5) });
          break;
        case "type":
          await provider.type(session.deviceId, String(req.body?.text ?? ""));
          break;
        case "rotate":
          await provider.rotate(session.deviceId, req.body?.orientation === "landscape" ? "landscape" : "portrait");
          break;
        case "longpress":
          if (!provider.longPress) throw new Error("Long-press is not supported by the active provider.");
          await provider.longPress(session.deviceId, { kind: "normalized", x: Number(req.body?.x), y: Number(req.body?.y) }, req.body?.seconds ? Number(req.body.seconds) : undefined);
          break;
        case "scroll":
          // Scroll is a swipe in the opposite direction of travel (scrolling
          // "down" a list means swiping the content up).
          await provider.swipe(session.deviceId, req.body?.direction === "down" ? "up" : req.body?.direction === "up" ? "down" : req.body?.direction, { kind: "normalized", x: Number(req.body?.x ?? 0.5), y: Number(req.body?.y ?? 0.5) });
          break;
        default:
          return res.status(400).json({ error: "Unsupported control action." });
      }
      res.json({ ok: true });
    } catch (error) {
      res.status(422).json({ error: error instanceof Error ? error.message : "Control action failed." });
    }
  });

  app.get("/api/iphone/projects/:projectId/screenshot", async (req, res) => {
    const projectId = safeProjectId(String(req.params.projectId ?? ""));
    const provider = providerFor(projectId);
    const session = sessions.get(projectId);
    if (!session) return res.status(409).json({ error: "No active simulator session for this project." });
    try {
      const png = await provider.screenshot(session.deviceId);
      res.setHeader("Content-Type", "image/png");
      res.send(png);
    } catch (error) {
      res.status(422).json({ error: error instanceof Error ? error.message : "Screenshot failed." });
    }
  });

  // Not project-scoped like the routes above — the panel's <img> tag opens
  // this directly, and by the time it's rendering, the run/relaunch response
  // has already resolved the concrete deviceId for this project.
  app.get("/api/iphone/devices/:deviceId/stream.mjpeg", async (req, res) => {
    const deviceId = String(req.params.deviceId ?? "").replace(/[^a-zA-Z0-9-]/g, "");
    if (!deviceId) return res.status(400).end();
    await pipeMjpegStream(deviceId, res);
  });

  app.get("/api/iphone/projects/:projectId/logs", async (req, res) => {
    const projectId = safeProjectId(String(req.params.projectId ?? ""));
    const provider = providerFor(projectId);
    const session = sessions.get(projectId);
    if (!session) return res.json({ logs: [] });
    try {
      res.json({ logs: await provider.getLogs(session.deviceId) });
    } catch {
      res.json({ logs: [] });
    }
  });

  /** Real accessibility tree when a provider supports one (none does on this host yet — see SimctlProvider.getAccessibilityTree). */
  app.get("/api/iphone/projects/:projectId/accessibility", async (req, res) => {
    const projectId = safeProjectId(String(req.params.projectId ?? ""));
    const provider = providerFor(projectId);
    const session = sessions.get(projectId);
    if (!session) return res.status(409).json({ error: "No active simulator session for this project." });
    const tree = await provider.getAccessibilityTree(session.deviceId);
    if (!tree) return res.status(501).json({ error: "No accessibility-tree provider is installed on this Apple Host (requires sim-use)." });
    res.json(tree);
  });

  app.post("/api/iphone/projects/:projectId/stop", async (req, res) => {
    const projectId = safeProjectId(String(req.params.projectId ?? ""));
    const provider = providerFor(projectId);
    const session = sessions.get(projectId);
    if (session) {
      await provider.stopStream(session.deviceId).catch(() => undefined);
      await provider.shutdown(session.deviceId).catch(() => undefined);
      sessions.delete(projectId);
    }
    res.json({ ok: true });
  });

  // Same-origin passthrough for the serve-sim preview UI so the panel's
  // iframe can embed it without a cross-origin/mixed-content block.
  app.use("/iphone-stream/:port", (req, res) => {
    const port = Number(req.params.port);
    if (!Number.isInteger(port) || port <= 0) return res.status(400).end();
    proxyHttp(req.method ?? "GET", req.url ?? "/", req.headers, req, res, port);
  });
}

function proxyHttp(method: string, url: string, headers: http.IncomingHttpHeaders, req: http.IncomingMessage, res: http.ServerResponse, targetPort: number) {
  const upstream = http.request(
    { host: "127.0.0.1", port: targetPort, method, path: url, headers: { ...headers, host: `127.0.0.1:${targetPort}` } },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    },
  );
  upstream.on("error", () => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "The iPhone stream is not running." }));
  });
  req.pipe(upstream);
}

/** WebSocket upgrades for the serve-sim preview UI's own stream/control channels. */
export function attachIPhoneStreamUpgrades(httpServer: Server) {
  httpServer.on("upgrade", (req, socket, head) => {
    const url = req.url ?? "/";
    const match = /^\/iphone-stream\/(\d+)(\/.*)?$/.exec(url);
    if (!match) return;
    const port = Number(match[1]);
    req.url = match[2] || "/";
    proxyUpgrade(req, socket, head, port);
  });
}
