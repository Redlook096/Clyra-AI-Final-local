import type { Application } from "express";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { clyraDataPath } from "../runtime-paths";
import type { VibeCoderEvent } from "../cline/cline-events";

type Listener = (event: VibeCoderEvent) => void;

type OpenCodeTask = {
  child: ChildProcessWithoutNullStreams;
  events: VibeCoderEvent[];
  listeners: Set<Listener>;
  workspace: string;
  files: Map<string, string>;
  lastText: string;
  failed: boolean;
};

const tasks = new Map<string, OpenCodeTask>();
const MAX_PROMPT_LENGTH = 20_000;
const MAX_FILE_BYTES = 900_000;
const MAX_WORKSPACE_FILES = 160;

function safeProjectId(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 96);
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 52) || "clyra-vibe-project";
}

function workspaceFor(projectId: string) {
  // Do not honour a browser-provided filesystem path. OpenCode receives only
  // a Clyra-owned project directory beneath the writable data root.
  return path.join(clyraDataPath("projects"), safeProjectId(projectId), "files");
}

function opencodeBin() {
  const configured = String(process.env.CLYRA_OPENCODE_BIN || "").trim();
  return configured || "opencode";
}

function availableOpenCode() {
  const probe = spawnSync(opencodeBin(), ["--version"], {
    encoding: "utf8",
    timeout: 4_000,
    shell: false,
  });
  if (probe.error || probe.status !== 0) return { available: false, version: undefined };
  const version = String(probe.stdout || "").trim().split(/\s+/).at(-1) || undefined;
  return { available: true, version };
}

function emit(task: OpenCodeTask, event: VibeCoderEvent) {
  const stamped = { ...event, timestamp: event.timestamp || Date.now() } as VibeCoderEvent;
  task.events.push(stamped);
  for (const listener of task.listeners) listener(stamped);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function asText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function field(record: Record<string, unknown>, names: string[]) {
  for (const name of names) {
    const value = asText(record[name]);
    if (value) return value;
  }
  return "";
}

function relativeWorkspaceFile(workspace: string, raw: string) {
  if (!raw) return "";
  const absolute = path.resolve(workspace, raw);
  const relative = path.relative(workspace, absolute);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return "";
  return relative.split(path.sep).join("/");
}

function lineDiff(before: string, after: string) {
  const left = before ? before.split("\n") : [];
  const right = after ? after.split("\n") : [];
  let prefix = 0;
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < left.length - prefix
    && suffix < right.length - prefix
    && left[left.length - 1 - suffix] === right[right.length - 1 - suffix]
  ) suffix += 1;
  return {
    added: Math.max(0, right.length - prefix - suffix),
    removed: Math.max(0, left.length - prefix - suffix),
  };
}

async function walkWorkspace(root: string) {
  const result = new Map<string, string>();
  const walk = async (directory: string) => {
    if (result.size >= MAX_WORKSPACE_FILES) return;
    let entries: import("node:fs").Dirent[] = [];
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (result.size >= MAX_WORKSPACE_FILES) return;
      if (["node_modules", ".git", ".opencode", ".agent"].includes(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      const relative = relativeWorkspaceFile(root, absolute);
      if (!relative) continue;
      try {
        const stat = await fs.stat(absolute);
        if (stat.size > MAX_FILE_BYTES) continue;
        result.set(relative, await fs.readFile(absolute, "utf8"));
      } catch {
        // Binary and concurrently written files are omitted from the editor.
      }
    }
  };
  await walk(root);
  return result;
}

function languageFor(filePath: string) {
  const extension = filePath.split(".").pop()?.toLowerCase() || "";
  return ({ ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", css: "css", html: "html", json: "json", md: "markdown" } as Record<string, string>)[extension] || "plaintext";
}

async function publishWorkspaceChanges(task: OpenCodeTask) {
  const next = await walkWorkspace(task.workspace);
  const paths = new Set([...task.files.keys(), ...next.keys()]);
  for (const filePath of [...paths].sort()) {
    const before = task.files.get(filePath) || "";
    const after = next.get(filePath);
    if (after === before) continue;
    const action = after === undefined ? "delete" : before ? "edit" : "create";
    emit(task, { type: "file_started", path: filePath, language: languageFor(filePath), action });
    if (after === undefined) {
      emit(task, { type: "file_completed", path: filePath, content: "", added: 0, removed: before ? before.split("\n").length : 0 });
      task.files.delete(filePath);
      continue;
    }
    const counts = lineDiff(before, after);
    emit(task, { type: "file_completed", path: filePath, content: after, ...counts });
    task.files.set(filePath, after);
  }
}

function eventFilePath(workspace: string, part: Record<string, unknown>) {
  const state = asRecord(part.state);
  const input = asRecord(state.input || state.arguments || part.input);
  return relativeWorkspaceFile(workspace, field(input, ["filePath", "file", "path", "filename", "target"]));
}

function eventCommand(part: Record<string, unknown>) {
  const state = asRecord(part.state);
  const input = asRecord(state.input || state.arguments || part.input);
  return field(input, ["command", "cmd"]);
}

function safeOpenCodeError(value: unknown) {
  const record = asRecord(value);
  const data = asRecord(record.data);
  const raw = field(data, ["message"]) || field(record, ["message", "name"]);
  // Provider credentials must never travel from OpenCode's raw diagnostics to
  // an SSE client, log, or persisted project session.
  const cleaned = raw.replace(/(?:sk|rk|pk|key)[-_][A-Za-z0-9_-]{8,}/gi, "[redacted credential]");
  if (/api key|authorization|unauthori[sz]ed|\b401\b/i.test(cleaned)) {
    return "OpenCode's configured provider rejected its credentials. Update the provider connection, then retry.";
  }
  return cleaned.slice(0, 1_500) || "OpenCode reported an execution error.";
}

function consumeOpenCodeEvent(task: OpenCodeTask, payload: Record<string, unknown>) {
  const kind = asText(payload.type);
  const part = asRecord(payload.part);
  if (kind === "reasoning") {
    const text = asText(part.text);
    if (text) emit(task, { type: "thinking", text });
    return;
  }
  if (kind === "text") {
    const text = asText(part.text);
    if (text) {
      task.lastText = text;
      emit(task, { type: "status_update", message: text.slice(0, 2_000) });
    }
    return;
  }
  if (kind === "error") {
    task.failed = true;
    emit(task, { type: "error", message: safeOpenCodeError(payload.error), recoverable: false });
    return;
  }
  if (kind !== "tool_use") return;
  const tool = asText(part.tool).toLowerCase();
  const state = asRecord(part.state);
  const status = asText(state.status);
  const command = eventCommand(part);
  if (command || /^(bash|shell|terminal|command)$/.test(tool)) {
    const display = command || tool;
    if (status === "completed" || status === "error") {
      emit(task, { type: "terminal_completed", command: display, exitCode: status === "completed" ? 0 : 1 });
    } else {
      emit(task, { type: "terminal_started", command: display });
    }
    return;
  }
  const filePath = eventFilePath(task.workspace, part);
  if (filePath && /(?:edit|write|patch|apply|delete|file)/.test(tool)) {
    const action = /delete/.test(tool) ? "delete" : task.files.has(filePath) ? "edit" : "create";
    emit(task, { type: "file_started", path: filePath, language: languageFor(filePath), action });
    if (status === "completed") void publishWorkspaceChanges(task);
    return;
  }
  if (status === "completed") emit(task, { type: "status_update", message: `${tool || "Tool"} completed.` });
  else if (status === "running") emit(task, { type: "thinking", text: `Using ${tool || "a project tool"}…` });
}

export function registerOpenCodeRoutes(app: Application) {
  app.get("/api/opencode/status", (_req, res) => {
    const status = availableOpenCode();
    res.json({
      ...status,
      providerConfigured: Boolean(process.env.OPENCODE_CONFIG || process.env.OPENAI_API_KEY || process.env.DEEPSEEK_API_KEY || process.env.ANTHROPIC_API_KEY),
      source: "anomalyco/opencode",
    });
  });

  app.post("/api/opencode/start", async (req, res) => {
    const prompt = String(req.body?.prompt || "").trim();
    if (!prompt || prompt.length > MAX_PROMPT_LENGTH) {
      res.status(400).json({ error: "Enter a coding request up to 20,000 characters." });
      return;
    }
    const status = availableOpenCode();
    if (!status.available) {
      res.status(503).json({ error: "OpenCode is not installed. Set CLYRA_OPENCODE_BIN or install the approved OpenCode runtime." });
      return;
    }
    const requested = safeProjectId(String(req.body?.projectId || ""));
    const projectId = !requested || requested === "project-advanced-vibe"
      ? `${slugify(prompt)}-${randomUUID().slice(0, 6)}`
      : requested;
    const workspace = workspaceFor(projectId);
    await fs.mkdir(workspace, { recursive: true });
    const planMode = Boolean(req.body?.planMode);
    const args = ["run", "--format", "json", "--thinking", "--dir", workspace, "--agent", planMode ? "plan" : "build"];
    const configuredModel = String(process.env.CLYRA_OPENCODE_MODEL || "").trim();
    if (configuredModel) args.push("--model", configuredModel);
    // Auto-approval is an explicit deployment decision. It is never silently
    // enabled by Clyra; OpenCode's own permission policy remains authoritative.
    if (String(process.env.CLYRA_OPENCODE_AUTO_APPROVE || "").toLowerCase() === "true") args.push("--auto");
    args.push(prompt);

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(opencodeBin(), args, {
        cwd: workspace,
        env: { ...process.env, PWD: workspace },
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
      });
    } catch {
      res.status(503).json({ error: "OpenCode could not be started." });
      return;
    }
    const taskId = randomUUID();
    const task: OpenCodeTask = {
      child,
      events: [],
      listeners: new Set(),
      workspace,
      files: await walkWorkspace(workspace),
      lastText: "",
      failed: false,
    };
    tasks.set(taskId, task);
    emit(task, { type: "stage", stage: "inspecting-existing-project", message: planMode ? "OpenCode is inspecting the project and preparing a plan." : "OpenCode is inspecting the project." });
    emit(task, { type: "thinking", text: "Thinking through the request…" });

    let stdoutBuffer = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString("utf8");
      const rows = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = rows.pop() || "";
      for (const row of rows) {
        try {
          consumeOpenCodeEvent(task, JSON.parse(row) as Record<string, unknown>);
        } catch {
          // OpenCode's JSON mode is line-delimited; non-JSON diagnostics stay
          // on stderr and are surfaced only if the task fails.
        }
      }
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(-8_000); });
    child.on("error", (error) => {
      emit(task, { type: "error", message: `OpenCode could not start: ${error.message}`, recoverable: false });
    });
    child.on("close", async (code) => {
      if (stdoutBuffer.trim()) {
        try { consumeOpenCodeEvent(task, JSON.parse(stdoutBuffer) as Record<string, unknown>); } catch { /* ignored */ }
      }
      await publishWorkspaceChanges(task);
      if (code === 0) {
        emit(task, { type: "complete", summary: task.lastText || "OpenCode completed the requested work." });
      } else if (!task.failed) {
        emit(task, {
          type: "error",
          message: stderr.trim()
            ? safeOpenCodeError({ message: stderr })
            : `OpenCode exited with code ${code ?? "unknown"}.`,
          recoverable: false,
        });
      }
      setTimeout(() => tasks.delete(taskId), 5 * 60_000).unref();
    });
    res.json({ taskId, projectId, provider: "opencode", version: status.version });
  });

  app.get("/api/opencode/events/:taskId", (req, res) => {
    const task = tasks.get(req.params.taskId);
    if (!task) {
      res.status(404).json({ error: "OpenCode task not found" });
      return;
    }
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    for (const event of task.events) res.write(`data: ${JSON.stringify(event)}\n\n`);
    const listener: Listener = (event) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
      if (event.type === "complete" || (event.type === "error" && !event.recoverable)) res.end();
    };
    task.listeners.add(listener);
    req.on("close", () => task.listeners.delete(listener));
  });

  app.post("/api/opencode/cancel/:taskId", (req, res) => {
    const task = tasks.get(req.params.taskId);
    if (!task) {
      res.status(404).json({ error: "OpenCode task not found" });
      return;
    }
    task.child.kill("SIGTERM");
    emit(task, { type: "stage", stage: "cancelled", message: "OpenCode run cancelled." });
    res.json({ ok: true });
  });
}
