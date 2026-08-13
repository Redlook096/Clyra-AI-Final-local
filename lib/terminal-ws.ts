/**
 * Real PTY terminal bridge for the Vibe Coder.
 *
 * Serves the browser dev mode through a WebSocket on the local Clyra server.
 * Each session owns a real shell (node-pty) started in the project's files
 * directory; output is buffered so a collapsed panel or a tab switch can
 * reconnect to the same running shell without losing its scrollback.
 */
import path from "node:path";
import fs from "node:fs";
import type { Server } from "node:http";
import { createRequire } from "node:module";
import { WebSocket, WebSocketServer } from "ws";
import { clyraDataPath, clyraResourcePath } from "./runtime-paths";

const require = createRequire(import.meta.url);

type PtyLike = {
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  kill: () => void;
  onData: (cb: (data: string) => void) => void;
  onExit: (cb: (code: number) => void) => void;
};

const BUFFER_LIMIT = 64 * 1024;
const SESSION_TTL_MS = 90_000;
const WS_OPEN = 1;

function spawnShell(cwd: string): PtyLike | null {
  const shell =
    process.platform === "win32"
      ? "powershell.exe"
      : process.env.SHELL || "/bin/bash";
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pty = require("node-pty");
    const process_ = pty.spawn(shell, [], {
      name: "xterm-256color",
      cols: 100,
      rows: 30,
      cwd,
      env: { ...process.env, TERM: "xterm-256color" },
    });
    return {
      write: (data) => {
        try { process_.write(data); } catch { /* shell closed */ }
      },
      resize: (cols, rows) => {
        try { process_.resize(cols, rows); } catch { /* closed */ }
      },
      kill: () => {
        try { process_.kill(); } catch { /* closed */ }
      },
      onData: (cb) => process_.onData(cb),
      onExit: (cb) => process_.onExit(({ exitCode }) => cb(exitCode)),
    };
  } catch (error) {
    console.warn(
      "[terminal] node-pty unavailable, falling back to piped shell:",
      error instanceof Error ? error.message : error,
    );
  }
  try {
    // In browser development node-pty may be unavailable because its native
    // ABI differs from the server runtime. `expect` gives the fallback a real
    // pseudo-terminal, unlike a piped stdin/stdout shell (which suppresses
    // command execution while Zsh's line editor is active). Electron uses the
    // node-pty branch above, so this only protects source/dev mode.
    const { spawn } = require("node:child_process");
    const isWindows = process.platform === "win32";
    const expectScript = "set timeout -1; spawn -noecho $env(CLYRA_TERMINAL_SHELL) -i; interact";
    const child = isWindows
      ? spawn(shell, ["-NoLogo", "-NoExit"], {
          cwd,
          env: { ...process.env, TERM: "xterm-256color" },
          stdio: ["pipe", "pipe", "pipe"],
        })
      : spawn("/usr/bin/expect", ["-c", expectScript], {
      cwd,
      env: { ...process.env, TERM: "xterm-256color", CLYRA_TERMINAL_SHELL: shell },
      stdio: ["pipe", "pipe", "pipe"],
      });
    const listeners: Array<(data: string) => void> = [];
    const exitListeners: Array<(code: number) => void> = [];
    child.stdout.on("data", (chunk: Buffer) => {
      const data = chunk.toString("utf8");
      for (const cb of listeners) cb(data);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const data = chunk.toString("utf8");
      for (const cb of listeners) cb(data);
    });
    child.on("exit", (code) => {
      for (const cb of exitListeners) cb(code ?? 0);
    });
    return {
      write: (data) => {
        try {
          child.stdin.write(data);
        } catch { /* closed */ }
      },
      resize: () => undefined,
      kill: () => {
        try { child.kill(); } catch { /* closed */ }
      },
      onData: (cb) => listeners.push(cb),
      onExit: (cb) => exitListeners.push(cb),
    };
  } catch {
    return null;
  }
}

function resolveProjectDirectory(projectId: string) {
  const candidates = [
    clyraDataPath("projects", projectId, "files"),
    clyraResourcePath("projects", projectId, "files"),
    clyraDataPath("projects"),
  ];
  return candidates.find((candidate) => {
    try { return fs.existsSync(candidate); } catch { return false; }
  }) ?? clyraDataPath("projects");
}

type TerminalSession = {
  shell: PtyLike;
  buffer: string;
  lastActive: number;
  ws: WebSocket | null;
};

export function attachTerminalWebSocket(server: Server) {
  const sessions = new Map<string, TerminalSession>();
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== "/api/terminal") return;
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  });

  wss.on("connection", (ws, request) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const projectId = String(url.searchParams.get("projectId") ?? "")
      .replace(/[^a-zA-Z0-9_-]/g, "")
      .slice(0, 96);
    // Reconnects from the same page skip the scrollback replay so StrictMode
    // remounts never duplicate output; fresh page loads get the buffer.
    const replay = url.searchParams.get("replay") !== "0";
    const tabId = String(url.searchParams.get("tabId") ?? "default")
      .replace(/[^a-zA-Z0-9_-]/g, "")
      .slice(0, 64) || "default";
    // A terminal must never wait for project discovery. When no project is
    // selected yet, start a useful shell immediately in the user's home folder.
    const dir = projectId
      ? resolveProjectDirectory(projectId)
      : (process.env.HOME || process.env.USERPROFILE || clyraDataPath("projects"));
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      /* data dir may not exist yet */
    }

    const key = `${projectId || "default"}:${tabId}`;
    let session = sessions.get(key);
    let createdSession = false;

    if (!session || Date.now() - session.lastActive > SESSION_TTL_MS) {
      if (session) {
        session.shell.kill();
        sessions.delete(key);
      }
      const shell = spawnShell(dir);
      if (!shell) {
        ws.close();
        return;
      }
      session = { shell, buffer: "", lastActive: Date.now(), ws };
      sessions.set(key, session);
      createdSession = true;
      shell.onData((data) => {
        session!.buffer = (session!.buffer + data).slice(-BUFFER_LIMIT);
        const activeSocket = session!.ws;
        if (activeSocket && activeSocket.readyState === WS_OPEN) {
          try {
            activeSocket.send(JSON.stringify({ type: "data", tabId, data }));
          } catch { /* browser disconnected between ready check and send */ }
        }
      });
      shell.onExit((code) => {
        const activeSocket = session!.ws;
        if (activeSocket && activeSocket.readyState === WS_OPEN) {
          activeSocket.send(JSON.stringify({ type: "exit", tabId, code }));
        }
      });
    } else {
      session.ws = ws;
      // Reconnect to the same live shell: replay recent output first.
      if (replay && session.buffer) {
        ws.send(JSON.stringify({ type: "data", tabId, data: session.buffer }));
      }
    }

    // Piped-shell fallback output can arrive before its listeners have had an
    // opportunity to write. A short deferred replay guarantees that the
    // initial prompt reaches a fresh browser terminal too.
    if (replay && createdSession) {
      setTimeout(() => {
        if (session?.buffer && ws.readyState === WS_OPEN) {
          ws.send(JSON.stringify({ type: "data", tabId, data: session.buffer }));
        }
      }, 16);
    }

    ws.on("message", (raw) => {
      if (!session) return;
      try {
        const message = JSON.parse(String(raw)) as {
          type?: string;
          data?: string;
          cols?: number;
          rows?: number;
        };
        if (message.type === "input" && typeof message.data === "string") {
          session.shell.write(message.data);
        } else if (message.type === "resize") {
          const cols = Math.max(20, Math.min(400, Number(message.cols) || 100));
          const rows = Math.max(4, Math.min(200, Number(message.rows) || 30));
          session.shell.resize(cols, rows);
        }
      } catch {
        /* ignore malformed frames */
      }
    });

    ws.on("close", () => {
      if (session) {
        session.ws = null;
        session.lastActive = Date.now();
      }
    });
  });

  const gc = setInterval(() => {
    for (const [key, session] of sessions) {
      if (!session.ws && Date.now() - session.lastActive > SESSION_TTL_MS) {
        session.shell.kill();
        sessions.delete(key);
      }
    }
  }, 30_000);
  gc.unref();
}
