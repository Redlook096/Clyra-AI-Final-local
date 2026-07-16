import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const AGENT_SERVER_VERSION = process.env.OH_AGENT_SERVER_VERSION || "1.33.0";
const DEFAULT_PORT = Number(process.env.OH_AGENT_SERVER_PORT || 18000);
const STATE_DIR = path.join(homedir(), ".openhands", "clyra-vibe");
const API_KEY_PATH = path.join(STATE_DIR, "api-key.txt");
const SECRET_KEY_PATH = path.join(STATE_DIR, "secret-key.txt");

let processHandle: ChildProcess | null = null;
let started: { host: string; apiKey: string; port: number } | null = null;
let starting: Promise<{ host: string; apiKey: string; port: number }> | null =
  null;

function ensureDir(dir: string) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function getOrCreateKey(filePath: string) {
  ensureDir(path.dirname(filePath));
  if (existsSync(filePath)) {
    const existing = readFileSync(filePath, "utf8").trim();
    if (existing) return existing;
  }
  const key = randomBytes(32).toString("hex");
  writeFileSync(filePath, `${key}\n`, "utf8");
  return key;
}

function parseRequirements(filePath: string): string[] {
  try {
    return readFileSync(filePath, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
  } catch {
    return [];
  }
}

async function waitForServer(url: string, timeoutMs = 120_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // keep waiting
    }
    await delay(500);
  }
  throw new Error(`Timed out waiting for OpenHands agent-server at ${url}`);
}

function buildUvxArgs(toolsRequirementsPath: string): string[] {
  const version = AGENT_SERVER_VERSION;
  const hostToolWith = parseRequirements(toolsRequirementsPath).flatMap(
    (pkg) => ["--with", pkg],
  );
  return [
    "--from",
    `openhands-agent-server==${version}`,
    "--with",
    `openhands-sdk==${version}`,
    "--with",
    `openhands-tools==${version}`,
    "--with",
    `openhands-workspace==${version}`,
    "--with",
    "agent-client-protocol<0.11",
    ...hostToolWith,
    "agent-server",
    "--host",
    "127.0.0.1",
    "--port",
    String(DEFAULT_PORT),
  ];
}

export async function ensureOpenHandsAgentServer(): Promise<{
  host: string;
  apiKey: string;
  port: number;
}> {
  if (started) {
    try {
      const res = await fetch(`${started.host}/server_info`);
      if (res.ok) return started;
    } catch {
      started = null;
      processHandle = null;
    }
  }

  if (starting) return starting;

  starting = (async () => {
    ensureDir(STATE_DIR);
    const apiKey =
      process.env.OH_SESSION_API_KEY?.trim() || getOrCreateKey(API_KEY_PATH);
    const secretKey =
      process.env.OH_SECRET_KEY?.trim() || getOrCreateKey(SECRET_KEY_PATH);
    const host = `http://127.0.0.1:${DEFAULT_PORT}`;
    const toolsDir = path.resolve(process.cwd(), "tools");
    const toolsRequirements = path.resolve(
      process.cwd(),
      "requirements-openhands.txt",
    );

    // Reuse a healthy existing server if present.
    try {
      const res = await fetch(`${host}/server_info`);
      if (res.ok) {
        started = { host, apiKey, port: DEFAULT_PORT };
        return started;
      }
    } catch {
      // spawn below
    }

    const conversationsPath = path.join(STATE_DIR, "conversations");
    const bashEventsDir = path.join(STATE_DIR, "bash_events");
    ensureDir(conversationsPath);
    ensureDir(bashEventsDir);

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PYTHONUTF8: "1",
      OH_PERSISTENCE_DIR: path.dirname(STATE_DIR),
      OH_CONVERSATIONS_PATH: conversationsPath,
      OH_BASH_EVENTS_DIR: bashEventsDir,
      OH_SECRET_KEY: secretKey,
      OH_SESSION_API_KEYS_0: apiKey,
      AGENT_SERVER_URL: host,
      OH_EXTRA_PYTHON_PATH: toolsDir,
    };

    const deepseekKey =
      process.env.DEEPSEEK_API_KEY?.trim() ||
      process.env.MY_LLM_API_KEY?.trim();
    if (deepseekKey) {
      const baseUrl =
        process.env.MY_LLM_BASE_URL?.trim() ||
        process.env.DEEPSEEK_BASE_URL?.trim() ||
        "https://api.deepseek.com";
      const rawModel =
        process.env.MY_LLM_MODEL?.trim() ||
        process.env.DEEPSEEK_MODEL?.trim() ||
        "deepseek-chat";
      const model = rawModel.includes("/") ? rawModel : `openai/${rawModel}`;
      env.OH_LLM__MODEL = model;
      env.OH_LLM__API_KEY = deepseekKey;
      env.OH_LLM__BASE_URL = baseUrl;
    }

    const args = buildUvxArgs(toolsRequirements);
    console.log(
      `[openhands] starting agent-server ${AGENT_SERVER_VERSION} on :${DEFAULT_PORT}`,
    );
    processHandle = spawn("uvx", args, {
      cwd: process.cwd(),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    processHandle.stdout?.on("data", (chunk) => {
      const text = String(chunk);
      if (text.trim()) console.log(`[openhands] ${text.trimEnd()}`);
    });
    processHandle.stderr?.on("data", (chunk) => {
      const text = String(chunk);
      if (text.trim()) console.warn(`[openhands] ${text.trimEnd()}`);
    });
    processHandle.on("exit", (code, signal) => {
      console.warn(
        `[openhands] agent-server exited code=${code} signal=${signal}`,
      );
      if (started?.port === DEFAULT_PORT) started = null;
      processHandle = null;
    });

    await waitForServer(`${host}/server_info`);
    started = { host, apiKey, port: DEFAULT_PORT };
    return started;
  })().finally(() => {
    starting = null;
  });

  return starting;
}

export function getOpenHandsServerInfo() {
  return started;
}
