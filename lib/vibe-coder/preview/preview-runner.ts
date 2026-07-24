import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  PreviewLogLine,
  PreviewSession,
  PreviewStatus,
} from "../../../types/vibe-preview";
import { detectPackageManager } from "../terminal/package-manager";
import { detectDevScript } from "../terminal/script-detector";
import { checkPreviewHealth } from "./preview-health";
import { findPreviewPort, parsePreviewUrl, probePreviewPort } from "./port-detector";
import { parsePreviewError } from "./preview-errors";
import { clyraResourcePath } from "../../runtime-paths";

type RunnerState = {
  process?: ChildProcessWithoutNullStreams;
  session: PreviewSession;
  logs: PreviewLogLine[];
};

const sessions = new Map<string, RunnerState>();

function addLog(state: RunnerState, level: PreviewLogLine["level"], message: string) {
  const clean = message.trim();
  if (!clean) return;
  state.logs.push({
    id: `${Date.now()}-${state.logs.length}`,
    time: new Date().toISOString(),
    level,
    message: clean,
  });
  if (state.logs.length > 600) state.logs.splice(0, state.logs.length - 600);
}

function updateStatus(state: RunnerState, status: PreviewStatus) {
  state.session = {
    ...state.session,
    status,
    lastHealthCheckAt:
      status === "ready" || status === "running" ? Date.now() : state.session.lastHealthCheckAt,
  };
}

function serialise(state: RunnerState): PreviewSession {
  return { ...state.session };
}

function getViteBinary(projectPath: string) {
  const candidates = [
    path.join(projectPath, "node_modules", ".bin", "vite"),
    clyraResourcePath("node_modules", ".bin", "vite"),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

async function waitForReady(state: RunnerState, port: number, timeoutMs = 20000) {
  const started = Date.now();
  const candidateUrls = [
    state.session.url,
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
  ].filter(Boolean) as string[];

  while (Date.now() - started < timeoutMs) {
    for (const candidate of candidateUrls) {
      const health = await checkPreviewHealth(candidate);
      if (health.ok) {
        state.session = {
          ...state.session,
          status: "ready",
          url: candidate,
          port,
          lastHealthCheckAt: Date.now(),
          lastError: undefined,
        };
        addLog(state, "info", `Preview ready at ${candidate}`);
        return;
      }
      if (health.error) state.session.lastError = health.error;
    }
    await new Promise((resolve) => setTimeout(resolve, 550));
  }

  state.session = {
    ...state.session,
    status: "build_failed",
    lastHealthCheckAt: Date.now(),
    lastError: state.session.lastError ?? {
      title: "Preview did not become ready",
      message: "The dev server started, but the health check did not pass in time.",
    },
  };
  addLog(state, "error", state.session.lastError.message);
}

export async function startDevServer({
  projectId,
  projectPath,
  projectName,
}: {
  projectId: string;
  projectPath: string;
  projectName: string;
}) {
  const existing = sessions.get(projectId);
  if (existing?.process && existing.process.exitCode == null && existing.session.url) {
    const health = await checkPreviewHealth(existing.session.url);
    if (health.ok) {
      existing.session = {
        ...existing.session,
        status: "ready",
        lastHealthCheckAt: Date.now(),
      };
      return serialise(existing);
    }
  }

  if (existing?.process && existing.process.exitCode == null) {
    existing.process.kill();
  }

  const hasPackageJson = existsSync(path.join(projectPath, "package.json"));
  const hasHtmlEntry = existsSync(path.join(projectPath, "index.html"));
  if (!hasHtmlEntry) {
    const session: PreviewSession = {
      projectId,
      projectPath,
      packageManager: "npm",
      devCommand: "missing",
      status: "build_failed",
      lastError: {
        title: "Preview files are incomplete",
        message: "The agent has not yet created an index.html entry point, so Clyra cannot start a preview.",
      },
    };
    const state = { session, logs: [] };
    addLog(state, "error", session.lastError!.message);
    sessions.set(projectId, state);
    return session;
  }
  const packageManager = hasPackageJson ? detectPackageManager(projectPath) : "npm";
  const script = hasPackageJson ? await detectDevScript(projectPath) : null;
  if (hasPackageJson && !script) {
    const session: PreviewSession = {
      projectId,
      projectPath,
      packageManager,
      devCommand: "missing",
      status: "build_failed",
      lastError: {
        title: "Preview setup needed",
        message: "No dev, start, or preview script exists in package.json.",
      },
    };
    const state = { session, logs: [] };
    addLog(state, "error", session.lastError!.message);
    sessions.set(projectId, state);
    return session;
  }

  const port = await findPreviewPort(projectId);
  const viteBinary = getViteBinary(projectPath);
  const session: PreviewSession = {
    projectId,
    projectPath,
    packageManager,
    devCommand: script ? `${script.scriptName}: ${script.command}` : "static HTML: vite",
    port,
    url: `http://127.0.0.1:${port}`,
    status: "starting",
    startedAt: Date.now(),
  };
  const state: RunnerState = { session, logs: [] };
  sessions.set(projectId, state);
  addLog(
    state,
    "info",
    script
      ? `Detected ${packageManager} and script "${script.scriptName}".`
      : "Detected a dependency-free static HTML project.",
  );
  addLog(state, "info", `Starting preview on port ${port}.`);

  const child = spawn(
    viteBinary || "python3",
    viteBinary
      ? ["--host", "127.0.0.1", "--port", String(port), "--strictPort"]
      : ["-m", "http.server", String(port), "--bind", "127.0.0.1"],
    {
      cwd: projectPath,
      env: { ...process.env, BROWSER: "none", FORCE_COLOR: "0" },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  state.process = child;
  state.session.processId = String(child.pid ?? "");
  updateStatus(state, "compiling");

  const handleOutput = (level: PreviewLogLine["level"], text: string) => {
    for (const line of text.split(/\r?\n/)) {
      addLog(state, level, line);
      const url = parsePreviewUrl(line);
      if (url) {
        state.session = { ...state.session, url, port: Number(new URL(url).port) };
      }
      const parsedError = parsePreviewError(line);
      if (parsedError) {
        state.session = {
          ...state.session,
          status: "runtime_error",
          lastError: parsedError,
        };
      }
    }
  };

  child.stdout.on("data", (chunk) => handleOutput("info", chunk.toString()));
  child.stderr.on("data", (chunk) => handleOutput("error", chunk.toString()));
  child.on("close", (code) => {
    if (state.session.status !== "stopped") {
      state.session = {
        ...state.session,
        status: "server_crashed",
        lastError: {
          title: "Preview server stopped",
          message: `The preview process exited with code ${code ?? "unknown"}.`,
        },
      };
      addLog(state, "error", state.session.lastError.message);
    }
  });

  const probed = await probePreviewPort(port);
  if (probed) {
    state.session = { ...state.session, url: probed, status: "ready" };
    addLog(state, "info", `Preview ready at ${probed}`);
    return serialise(state);
  }

  await waitForReady(state, port);
  return serialise(state);
}

export async function restartDevServer(args: {
  projectId: string;
  projectPath: string;
  projectName: string;
}) {
  await stopDevServer(args.projectId);
  const session = await startDevServer(args);
  const state = sessions.get(args.projectId);
  if (state) updateStatus(state, session.status === "ready" ? "ready" : "restarting");
  return session;
}

export async function stopDevServer(projectId: string) {
  const state = sessions.get(projectId);
  if (!state) return null;
  state.session = { ...state.session, status: "stopped" };
  if (state.process && state.process.exitCode == null) {
    state.process.kill();
  }
  addLog(state, "info", "Preview server stopped.");
  return serialise(state);
}

export async function stopAllDevServers() {
  await Promise.all([...sessions.keys()].map((projectId) => stopDevServer(projectId)));
  sessions.clear();
}

export async function refreshPreview(projectId: string) {
  const state = sessions.get(projectId);
  if (!state) return null;
  state.session = { ...state.session, status: "refreshing" };
  if (state.session.url) {
    const health = await checkPreviewHealth(state.session.url);
    state.session = {
      ...state.session,
      status: health.ok ? "ready" : "runtime_error",
      lastHealthCheckAt: Date.now(),
      lastError: health.error,
    };
    addLog(
      state,
      health.ok ? "info" : "error",
      health.ok ? "Preview refresh passed health check." : health.error?.message ?? "Preview refresh failed.",
    );
  }
  return serialise(state);
}

export function getPreviewSession(projectId: string) {
  const state = sessions.get(projectId);
  return state ? serialise(state) : null;
}

export function getPreviewLogs(projectId: string) {
  return sessions.get(projectId)?.logs ?? [];
}
