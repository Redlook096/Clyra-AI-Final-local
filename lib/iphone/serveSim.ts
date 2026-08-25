/**
 * Wraps the `serve-sim` CLI (https://github.com/EvanBacon/serve-sim) — the
 * only piece of this system that talks to the real Simulator's HID/video
 * pipeline. Clyra never re-implements touch/keyboard forwarding itself: it
 * spawns serve-sim's own preview server per booted device and proxies that
 * server's page straight into the iPhone panel, and shells out to its CLI
 * for one-shot control actions (home, tap, gesture, type).
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import { promisify } from "node:util";
import { supportsFastStream } from "./host";

const execFileAsync = promisify(execFile);

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

async function runCli(args: string[], timeout = 15_000) {
  return execFileAsync("npx", ["--yes", "serve-sim", ...args], { timeout, maxBuffer: 4 * 1024 * 1024 });
}

export type ServeSimSession = { port: number; process: ChildProcess; udid: string };
const sessions = new Map<string, ServeSimSession>();

/** Starts (or reuses) the serve-sim preview server for one booted device. */
export async function ensureStream(udid: string): Promise<ServeSimSession> {
  const existing = sessions.get(udid);
  if (existing && !existing.process.killed) return existing;
  const port = await freePort();
  const child = spawn("npx", ["--yes", "serve-sim", "--port", String(port), "--host", "127.0.0.1", "--panes", "devices", udid], {
    stdio: "ignore",
    detached: false,
  });
  const session: ServeSimSession = { port, process: child, udid };
  sessions.set(udid, session);
  child.once("exit", () => {
    if (sessions.get(udid) === session) sessions.delete(udid);
  });
  // The preview server takes a moment to bind; give it a beat before the
  // caller's iframe tries to load it.
  await new Promise((resolve) => setTimeout(resolve, supportsFastStream() ? 900 : 1500));
  return session;
}

export function activeStream(udid: string) {
  return sessions.get(udid) ?? null;
}

export function stopStream(udid: string) {
  const session = sessions.get(udid);
  if (!session) return;
  session.process.kill();
  sessions.delete(udid);
}

export async function tap(udid: string, xNorm: number, yNorm: number) {
  await runCli(["tap", String(xNorm), String(yNorm), "-d", udid]);
}

export async function gesture(udid: string, payload: Record<string, unknown>) {
  await runCli(["gesture", JSON.stringify(payload), "-d", udid]);
}

export async function button(udid: string, name: string) {
  await runCli(["button", name, "-d", udid]);
}

export async function typeText(udid: string, text: string) {
  await runCli(["type", text, "-d", udid]);
}

export function stopAllStreams() {
  for (const session of sessions.values()) session.process.kill();
  sessions.clear();
}
