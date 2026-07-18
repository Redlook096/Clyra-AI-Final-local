import { spawn, type ChildProcess, execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const M1_ROOT =
  process.env.CLYRA_M1_ROOT?.trim() ||
  "/Users/lukesimpson/Documents/Coding Projects/Vibe Coder M1 Clyra";

const M1_UI_PORT = Number(process.env.CLYRA_M1_UI_PORT || 8000);
const M1_AGENT_PORT = Number(process.env.CLYRA_M1_AGENT_PORT || 18000);
/** Extra ports the M1 `npm run start` stack requires (must be free or boot fails). */
const M1_EXTRA_PORTS = [
  Number(process.env.CLYRA_M1_AUTOMATION_PORT || 18001),
  Number(process.env.CLYRA_M1_WEBSITE_CLONER_PORT || 18002),
  Number(process.env.CLYRA_M1_VITE_PORT || 3001),
  M1_AGENT_PORT + 1000, // vscode companion port used by agent-canvas
].filter((p) => Number.isFinite(p) && p > 0);
const M1_API_KEY_PATH = path.join(
  homedir(),
  ".openhands",
  "agent-canvas",
  "api-key.txt",
);

let m1Process: ChildProcess | null = null;
let starting: Promise<void> | null = null;
let monitorTimer: NodeJS.Timeout | null = null;

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

async function isUp(url: string) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return res.ok || res.status === 200 || res.status === 304;
  } catch {
    return false;
  }
}

function freePort(port: number) {
  const selfPid = process.pid;
  const parentPid = process.ppid;
  try {
    const pids = execSync(`lsof -ti :${port}`, { encoding: "utf8" })
      .trim()
      .split("\n")
      .filter(Boolean);
    for (const pid of pids) {
      const n = Number(pid);
      if (!n || n === selfPid || n === parentPid) continue;
      try {
        process.kill(n, "SIGTERM");
      } catch {
        // ignore
      }
    }
  } catch {
    // nothing listening
  }
  // Force-kill leftovers that ignore SIGTERM (common for uvx agent-server).
  try {
    execSync("sleep 0.4", { stdio: "ignore" });
    const leftover = execSync(`lsof -ti :${port}`, { encoding: "utf8" })
      .trim()
      .split("\n")
      .filter(Boolean);
    for (const pid of leftover) {
      const n = Number(pid);
      if (!n || n === selfPid || n === parentPid) continue;
      try {
        process.kill(n, "SIGKILL");
      } catch {
        // ignore
      }
    }
  } catch {
    // nothing left
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
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // A process can disappear between discovery and termination.
      }
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
    if (!apiKey) {
      throw new Error(
        `M1 is running but no session API key was found at ${M1_API_KEY_PATH}.`,
      );
    }
    return { uiUrl, agentUrl, apiKey };
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
      freePort(M1_UI_PORT);
      freePort(M1_AGENT_PORT);
      for (const port of M1_EXTRA_PORTS) freePort(port);
      await delay(1200);

      console.log(`[m1] starting full Vibe Coder M1 stack from ${root}`);
      m1Process = spawn("npm", ["run", "start"], {
        cwd: root,
        env: { ...process.env },
        // Detached services must not inherit pipes from Clyra. A closed parent
        // pipe can otherwise take down only the UI while leaving the agent up.
        stdio: "ignore",
        detached: true,
      });
      m1Process.unref();
      m1Process.on("exit", (code, signal) => {
        console.warn(`[m1] process exited code=${code} signal=${signal}`);
        m1Process = null;
        starting = null;
      });

      const startupTimeout = Math.max(15_000, Number(process.env.CLYRA_M1_START_TIMEOUT_MS || 45_000));
      const deadline = Date.now() + startupTimeout;
      while (Date.now() < deadline) {
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
          console.warn(
            `[m1] health check failed ui=${uiReady} agent=${agentReady}; restarting paired stack`,
          );
          void ensureM1Stack().catch((error) => {
            console.warn(
              "[m1] automatic recovery failed:",
              error instanceof Error ? error.message : error,
            );
          });
        },
      );
    }, 15_000);
    monitorTimer.unref();
  }

  void ensureM1Stack()
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
    });
}
