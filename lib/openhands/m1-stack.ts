import { spawn, type ChildProcess, execSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const M1_ROOT =
  process.env.CLYRA_M1_ROOT?.trim() ||
  "/Users/lukesimpson/Documents/Coding Projects/Vibe Coder M1 Clyra";

const M1_UI_PORT = Number(process.env.CLYRA_M1_UI_PORT || 8000);
const M1_AGENT_PORT = Number(process.env.CLYRA_M1_AGENT_PORT || 18000);
// Agent Canvas eagerly restores every saved conversation before exposing its
// health endpoint. Keep Clyra's runtime separate from a developer's personal
// Agent Canvas history so opening a project is not blocked by old sessions.
const M1_STATE_DIR =
  process.env.CLYRA_M1_STATE_DIR?.trim() ||
  path.join(homedir(), ".openhands", "clyra-vibe-m1");
/** Extra ports the M1 `npm run start` stack requires (must be free or boot fails). */
const M1_EXTRA_PORTS = [
  Number(process.env.CLYRA_M1_AUTOMATION_PORT || 18001),
  Number(process.env.CLYRA_M1_WEBSITE_CLONER_PORT || 18002),
  Number(process.env.CLYRA_M1_VITE_PORT || 3001),
  M1_AGENT_PORT + 1000, // vscode companion port used by agent-canvas
].filter((p) => Number.isFinite(p) && p > 0);
const M1_API_KEY_PATH = path.join(M1_STATE_DIR, "api-key.txt");
const M1_SECRET_KEY_PATH = path.join(M1_STATE_DIR, "secret-key.txt");

let m1Process: ChildProcess | null = null;
let starting: Promise<void> | null = null;
let backgroundWarmup: Promise<unknown> | null = null;
let monitorTimer: NodeJS.Timeout | null = null;
let lastM1LaunchError: Error | null = null;

export function getM1Paths() {
  return {
    root: M1_ROOT,
    uiUrl: `http://127.0.0.1:${M1_UI_PORT}`,
    agentUrl: `http://127.0.0.1:${M1_AGENT_PORT}`,
    apiKeyPath: M1_API_KEY_PATH,
  };
}

export function readM1SessionApiKey(): string | null {
  try {
    const key = readFileSync(M1_API_KEY_PATH, "utf8").trim();
    return key || null;
  } catch {
    return process.env.OH_SESSION_API_KEY?.trim() || null;
  }
}

async function isUp(url: string, timeoutMs = 5_000) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok || res.status === 200 || res.status === 304;
  } catch {
    return false;
  }
}

/**
 * A public health endpoint only proves that *an* agent-server owns the port.
 * The full M1 stack persists its session key in an isolated Clyra directory,
 * so a manually started Agent Canvas process can otherwise pass the health
 * check and then reject the first real conversation with a 401. Query a
 * lightweight authenticated endpoint before accepting an already-running
 * stack.
 */
async function hasMatchingSessionKey(agentUrl: string, apiKey: string) {
  try {
    const response = await fetch(`${agentUrl}/api/conversations/count`, {
      headers: { "X-Session-API-Key": apiKey },
      signal: AbortSignal.timeout(5_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function listeningProcesses(port: number) {
  try {
    return execSync(`lsof -nP -tiTCP:${port} -sTCP:LISTEN`, { encoding: "utf8" })
      .trim()
      .split("\n")
      .map(Number)
      .filter((pid) => Number.isFinite(pid) && pid > 0);
  } catch {
    return [];
  }
}

function commandForPid(pid: number) {
  try {
    return execSync(`ps -p ${pid} -o command=`, { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

function ensureM1NpmShim(nodeRuntime: string) {
  // Agent Canvas uses `npm run` for local scripts, but desktop packaging does
  // not provide a global npm binary. Keep a deliberately tiny, local-only
  // runner that supports its dev scripts and forwards their output directly.
  const runtimeDir = path.join(process.env.CLYRA_DATA_ROOT || homedir(), ".clyra", "m1-runtime");
  const runnerPath = path.join(runtimeDir, "npm-runner.mjs");
  const commandPath = path.join(runtimeDir, "npm");
  mkdirSync(runtimeDir, { recursive: true });
  if (!existsSync(runnerPath)) {
    writeFileSync(runnerPath, `import { readFileSync } from "node:fs";\nimport { spawnSync } from "node:child_process";\nimport path from "node:path";\nconst args = process.argv.slice(2);\nif (args[0] !== "run" || !args[1]) { console.error("Clyra M1 runtime supports npm run <script> only."); process.exit(64); }\nconst cwd = process.cwd();\nconst pkg = JSON.parse(readFileSync(path.join(cwd, "package.json"), "utf8"));\nconst script = pkg.scripts?.[args[1]];\nif (!script) { console.error(\`Unknown npm script: \${args[1]}\`); process.exit(1); }\nconst localBin = path.join(cwd, "node_modules", ".bin");\nconst shell = process.platform === "win32" ? "cmd.exe" : "/bin/sh";\nconst shellArgs = process.platform === "win32" ? ["/d", "/s", "/c", script] : ["-lc", script];\nconst result = spawnSync(shell, shellArgs, { cwd, stdio: "inherit", env: { ...process.env, PATH: [localBin, process.env.PATH].filter(Boolean).join(path.delimiter) } });\nprocess.exit(typeof result.status === "number" ? result.status : 1);\n`, { mode: 0o700 });
  }
  writeFileSync(commandPath, `#!/bin/sh\nexec "${nodeRuntime}" "${runnerPath}" "$@"\n`, { mode: 0o700 });
  chmodSync(commandPath, 0o700);
  return runtimeDir;
}

function isOwnedM1Process(pid: number) {
  if (pid === m1Process?.pid) return true;
  const command = commandForPid(pid);
  if (command.includes(M1_ROOT) && /agent-canvas|openhands|uvx|static-server|ingress/.test(command)) {
    return true;
  }
  // `uvx` resolves agent-server into its cache, so the listening child no
  // longer contains the Agent Canvas repository path. These are still Clyra's
  // paired M1 services when they occupy the dedicated M1 port; without this
  // recognition a stale child prevents every subsequent M1 launch.
  return (
    /(?:openhands-agent-server|\bagent-server\b).*--(?:host\s+)?(?:127\.0\.0\.1|0\.0\.0\.0).*--port\s+18000/.test(command) ||
    /openhands\.automation\.app:app.*--port\s+18001/.test(command) ||
    /(?:website-cloner|static-server|agent-canvas|openhands).*--port\s+(?:8000|3001|18002|19000)/.test(command)
  );
}

async function freeOwnedPort(port: number) {
  const selfPid = process.pid;
  const parentPid = process.ppid;
  const pids = listeningProcesses(port).filter((pid) => pid !== selfPid && pid !== parentPid);
  const foreign = pids.filter((pid) => !isOwnedM1Process(pid));
  if (foreign.length) {
    throw new Error(`Port ${port} is in use by an unrelated process (${foreign.join(", ")}). Clyra will not terminate it.`);
  }
  for (const pid of pids) terminateProcessTree(pid, "SIGTERM");
  if (pids.length) {
    await delay(600);
    const remaining = listeningProcesses(port).filter((pid) => isOwnedM1Process(pid));
    for (const pid of remaining) terminateProcessTree(pid, "SIGKILL");
  }
}

function terminateProcessTree(pid: number, signal: NodeJS.Signals = "SIGTERM") {
  try {
    const childPids = execSync(`pgrep -P ${pid}`, { encoding: "utf8" })
      .trim()
      .split("\n")
      .map(Number)
      .filter((child) => Number.isFinite(child) && child > 0);
    for (const childPid of childPids) terminateProcessTree(childPid, signal);
  } catch {
    // A leaf process has no children, or can exit while we inspect it.
  }
  try {
    process.kill(pid, signal);
  } catch {
    // Best effort cleanup for a stale detached process.
  }
}

async function stopStaleM1Launchers() {
  try {
    const output = execSync("ps -axo pid=,command=", { encoding: "utf8" });
    const pids = output
      .split("\n")
      .map((line) => {
        const match = line.trim().match(/^(\d+)\s+(.*)$/);
        return match && match[2].includes("agent-canvas/start.py --skip-install") ? Number(match[1]) : 0;
      })
      .filter((pid) => pid > 0 && pid !== process.pid && pid !== process.ppid);
    for (const pid of pids) {
      // start.py spawns uvx, ingress, and static-server children. Terminating
      // only the parent leaves orphaned agent servers that can race the next
      // launch for :18000, so release the complete known launcher tree.
      terminateProcessTree(pid);
    }
    if (pids.length) await delay(900);
  } catch {
    // Process inspection is best-effort; port cleanup below remains authoritative.
  }
}

export async function ensureM1Stack(): Promise<{
  uiUrl: string;
  agentUrl: string;
  apiKey: string;
}> {
  const { uiUrl, agentUrl, root } = getM1Paths();

  if (!existsSync(path.join(root, "package.json"))) {
    throw new Error(
      `M1 Vibe Coder not found at ${root}. Set CLYRA_M1_ROOT to the Vibe Coder M1 Clyra folder.`,
    );
  }

  const uiReady = await isUp(uiUrl);
  const agentReady = await isUp(`${agentUrl}/server_info`);
  if (uiReady && agentReady) {
    const apiKey = readM1SessionApiKey();
    if (apiKey && (await hasMatchingSessionKey(agentUrl, apiKey))) {
      return { uiUrl, agentUrl, apiKey };
    }
    // A healthy stack with no matching key in Clyra's isolated state directory
    // belongs to an older/manual Agent Canvas launch. Recycle it below so the
    // UI and API cannot appear ready while authenticating against different
    // keys.
    console.warn(
      `[m1] found a stack using a different state directory; restarting with ${M1_STATE_DIR}`,
    );
  }

  if (!starting) {
    starting = (async () => {
      // Full M1 owns both ports. A lone agent-server on :18000 (e.g. Clyra's
      // older OpenHands helper) blocks `npm run start` — always free both when
      // the UI is missing so the real Agent Canvas stack can boot.
      console.log(
        `[m1] freeing :${M1_UI_PORT}, :${M1_AGENT_PORT}, and companion ports for full Vibe Coder M1`,
      );
      await stopStaleM1Launchers();
      await freeOwnedPort(M1_UI_PORT);
      await freeOwnedPort(M1_AGENT_PORT);
      for (const port of M1_EXTRA_PORTS) await freeOwnedPort(port);
      await delay(1200);

      console.log(`[m1] starting full Vibe Coder M1 stack from ${root}`);
      // The M1 package's `start` script delegates through a Python launcher,
      // which then shells out to `npm` and `node`. Packaged Electron keeps a
      // deliberately small PATH, so run Agent Canvas's real Node entry point
      // with Clyra's already-working runtime instead of depending on global
      // Node/npm installations.
      const canvasRoot = path.join(root, "agent-canvas");
      const launcher = path.join(canvasRoot, "scripts", "dev-with-automation.mjs");
      const nodeRuntime = process.execPath;
      const canvasBin = path.join(canvasRoot, "node_modules", ".bin");
      const userToolBin = process.env.CLYRA_M1_TOOL_BIN?.trim() || path.join(homedir(), ".local", "bin");
      const npmShimDir = ensureM1NpmShim(nodeRuntime);
      const launchLogPath = path.join(M1_STATE_DIR, "m1-launch.log");
      mkdirSync(M1_STATE_DIR, { recursive: true });
      const launchLogFd = openSync(launchLogPath, "a", 0o600);
      lastM1LaunchError = null;
      m1Process = spawn(nodeRuntime, [launcher], {
        cwd: canvasRoot,
        // Clyra itself commonly runs with PORT=3003. The M1 launcher also
        // reads PORT for its ingress server, so forwarding it makes M1 fight
        // the host app for :3003 and exit before its :8000 UI can start.
        env: {
          ...process.env,
          PORT: String(M1_UI_PORT),
          OH_CANVAS_SAFE_STATE_DIR: M1_STATE_DIR,
          OH_SESSION_API_KEY_PATH: M1_API_KEY_PATH,
          OH_SECRET_KEY_PATH: M1_SECRET_KEY_PATH,
          ELECTRON_RUN_AS_NODE: "1",
          PATH: [npmShimDir, canvasBin, userToolBin, process.env.PATH].filter(Boolean).join(path.delimiter),
        },
        // Keep launch output in Clyra's isolated runtime directory. This avoids
        // a fragile parent pipe while preserving the startup evidence needed to
        // repair a partial M1 boot instead of exposing a blank workspace.
        stdio: ["ignore", launchLogFd, launchLogFd],
        detached: true,
      });
      closeSync(launchLogFd);
      m1Process.unref();
      m1Process.once("error", (error) => {
        lastM1LaunchError = new Error(
          `Unable to start Vibe Coder M1 with the bundled Node runtime: ${error.message}`,
        );
        console.warn("[m1] launcher error:", error.message);
      });
      m1Process.on("exit", (code, signal) => {
        console.warn(`[m1] process exited code=${code} signal=${signal}`);
        lastM1LaunchError = new Error(
          `M1 stack exited early with ${signal ? `signal ${signal}` : `code ${code ?? "unknown"}`}. Check the Vibe Coder launcher configuration.`,
        );
        m1Process = null;
        // `npm run start` may hand services off and exit successfully. The
        // startup promise remains authoritative until readiness polling ends;
        // clearing it here lets parallel warmups kill a stack mid-boot.
      });

      // A cold uvx agent-server install routinely needs longer than the UI
      // shell. Keep the first real build attached while its paired backend
      // becomes reachable instead of exposing a false launch failure.
      const startupTimeout = Math.max(30_000, Number(process.env.CLYRA_M1_START_TIMEOUT_MS || 90_000));
      const deadline = Date.now() + startupTimeout;
      while (Date.now() < deadline) {
        if (lastM1LaunchError) throw lastM1LaunchError;
        if (m1Process?.exitCode != null) {
          throw new Error(
            `M1 stack exited early with code ${m1Process.exitCode}. Check Clyra server logs for [m1] output.`,
          );
        }
        const ui = await isUp(uiUrl);
        const agent = await isUp(`${agentUrl}/server_info`);
        if (ui && agent) return;
        await delay(1500);
      }
      throw new Error(
        `Timed out waiting for M1 UI (${uiUrl}) and agent-server (${agentUrl}).`,
      );
    })().finally(() => {
      starting = null;
    });
  }

  await starting;
  const apiKey = readM1SessionApiKey();
  if (!apiKey) {
    throw new Error(
      `M1 started but no session API key was found at ${M1_API_KEY_PATH}.`,
    );
  }
  return { uiUrl, agentUrl, apiKey };
}

/**
 * Fire-and-forget warm start so Vibe Coder is ready when the user opens it.
 * Never throws — failures are logged only.
 */
export function warmupM1StackInBackground(): void {
  const skip =
    process.env.CLYRA_M1_WARMUP === "0" ||
    process.env.CLYRA_M1_WARMUP === "false";
  if (skip) {
    console.log("[m1] warmup skipped (CLYRA_M1_WARMUP=0)");
    return;
  }

  if (!monitorTimer) {
    monitorTimer = setInterval(() => {
      const { uiUrl, agentUrl } = getM1Paths();
      void Promise.all([isUp(uiUrl), isUp(`${agentUrl}/server_info`)]).then(
        ([uiReady, agentReady]) => {
          if (uiReady && agentReady) return;
          // Do not recycle this process group from a background probe. The
          // agent server may temporarily decline a health request while an
          // active conversation is flushing tool output; killing it there
          // abandons the user's build. A fresh explicit launch still calls
          // ensureM1Stack and performs recovery when the stack is truly down.
          console.warn(
            `[m1] health probe missed ui=${uiReady} agent=${agentReady}; preserving active conversations`,
          );
        },
      );
    }, 30_000);
    monitorTimer.unref();
  }

  if (backgroundWarmup) return;

  backgroundWarmup = ensureM1Stack()
    .then(({ uiUrl, agentUrl }) => {
      console.log(`[m1] warmup ready ui=${uiUrl} agent=${agentUrl}`);
      // Touch the UI once so Vite finishes first compile before the iframe opens.
      return fetch(uiUrl, { signal: AbortSignal.timeout(15_000) }).catch(
        () => null,
      );
    })
    .catch((error) => {
      console.warn(
        "[m1] warmup failed:",
        error instanceof Error ? error.message : error,
      );
    })
    .finally(() => {
      backgroundWarmup = null;
    });
}

/** Release the Clyra-owned M1 process group when the desktop app exits. */
export async function shutdownM1Stack(): Promise<void> {
  if (monitorTimer) {
    clearInterval(monitorTimer);
    monitorTimer = null;
  }
  backgroundWarmup = null;

  if (m1Process?.pid) terminateProcessTree(m1Process.pid, "SIGTERM");
  m1Process = null;

  const ports = [M1_UI_PORT, M1_AGENT_PORT, ...M1_EXTRA_PORTS];
  for (const port of ports) {
    for (const pid of listeningProcesses(port)) {
      if (pid !== process.pid && pid !== process.ppid && isOwnedM1Process(pid)) {
        terminateProcessTree(pid, "SIGTERM");
      }
    }
  }

  await delay(500);
  for (const port of ports) {
    for (const pid of listeningProcesses(port)) {
      if (pid !== process.pid && pid !== process.ppid && isOwnedM1Process(pid)) {
        terminateProcessTree(pid, "SIGKILL");
      }
    }
  }
}
