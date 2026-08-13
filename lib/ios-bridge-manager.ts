/**
 * iOS Bridge process manager.
 *
 * Runs the AutoFlowLabs ios-bridge FastAPI server (a simulator streaming and
 * control platform) as a child process of the local Clyra service and talks
 * to its REST API so the Vibe Coder preview can embed the live iPhone stream.
 *
 * The bridge owns the simulator session: we create the session, build the
 * app with the real Xcode toolchain, then upload and launch it through the
 * bridge so streaming, touch control and relaunch all stay in sync.
 */
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { xcodeDeveloperDir } from "./ios-toolchain";

const BRIDGE_PORT = 8123;

let child: ChildProcess | null = null;
let bridgeBaseUrl: string | null = null;

export function iosBridgeUrl() {
  return bridgeBaseUrl;
}

export async function iosBridgeEnsure(): Promise<{ running: boolean; url: string | null; error?: string }> {
  if (bridgeBaseUrl) {
    const ok = await probe();
    if (ok) return { running: true, url: bridgeBaseUrl };
    bridgeBaseUrl = null;
  }
  const repo = path.resolve(process.cwd(), "lib/ios-bridge-repo");
  if (!fs.existsSync(path.join(repo, "run.py"))) {
    return { running: false, url: null, error: "ios-bridge is not installed (run: git clone https://github.com/AutoFlowLabs/ios-bridge.git lib/ios-bridge-repo)" };
  }
  // FastAPI + uvicorn must be importable in the local Python.
  try {
    await new Promise<void>((resolve, reject) => {
      const check = spawn(process.env.PYTHON || "python3", ["-c", "import fastapi, uvicorn"], { cwd: repo, stdio: "ignore" });
      check.on("exit", (code) => (code === 0 ? resolve() : reject(new Error("Python deps missing (pip install fastapi uvicorn python-multipart)"))));
      check.on("error", reject);
    });
  } catch (error) {
    return { running: false, url: null, error: error instanceof Error ? error.message : "Python dependencies unavailable" };
  }
  try {
    child = spawn(process.env.PYTHON || "python3", ["run.py"], {
      cwd: repo,
      // The bridge invokes xcrun itself. Pass the same selected full-Xcode
      // developer directory used by Clyra's build helpers so it never falls
      // back to Command Line Tools (which do not include simctl).
      env: {
        ...process.env,
        ...(xcodeDeveloperDir() ? { DEVELOPER_DIR: xcodeDeveloperDir()! } : {}),
        HOST: "127.0.0.1",
        PORT: String(BRIDGE_PORT),
      },
      stdio: "ignore",
    });
    child.on("exit", () => {
      child = null;
      bridgeBaseUrl = null;
    });
  } catch (error) {
    return { running: false, url: null, error: error instanceof Error ? error.message : "ios-bridge failed to start" };
  }
  // Wait for the server to come up.
  for (let attempt = 0; attempt < 20; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    bridgeBaseUrl = `http://127.0.0.1:${BRIDGE_PORT}`;
    if (await probe()) return { running: true, url: bridgeBaseUrl };
  }
  return { running: false, url: null, error: "ios-bridge did not become ready" };
}

async function probe() {
  try {
    const response = await fetch(`${bridgeBaseUrl}/api/sessions/`, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
}

type BridgeSessionInfo = {
  session_id?: string;
  udid?: string;
  device_type?: string;
  ios_version?: string;
  [key: string]: unknown;
};

export async function iosBridgeCreateSession(deviceType: string, iosVersion: string) {
  const body = new URLSearchParams({ device_type: deviceType, ios_version: iosVersion });
  const response = await fetch(`${bridgeBaseUrl}/api/sessions/create`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = (await response.json()) as { success?: boolean; session_id?: string; session_info?: BridgeSessionInfo; detail?: string };
  if (!response.ok || !json.success) {
    throw new Error(String(json.detail || "Could not create the simulator session"));
  }
  const info = json.session_info ?? {};
  return {
    sessionId: json.session_id as string,
    udid: String(info.udid || info.device_udid || info.simulator_udid || ""),
    info,
  };
}

export async function iosBridgeInstallAndLaunch(sessionId: string, appZipPath: string) {
  const form = new FormData();
  const data = await fs.promises.readFile(appZipPath);
  form.append("app_bundle", new Blob([data], { type: "application/zip" }), "app.zip");
  const response = await fetch(`${bridgeBaseUrl}/api/sessions/${encodeURIComponent(sessionId)}/apps/install-and-launch`, {
    method: "POST",
    body: form,
  });
  const text = await response.text();
  if (!response.ok) {
    let message = text;
    try {
      const json = JSON.parse(text) as { detail?: string };
      if (json.detail) message = json.detail;
    } catch { /* raw text */ }
    throw new Error(message || "The app could not be installed");
  }
  return true;
}
