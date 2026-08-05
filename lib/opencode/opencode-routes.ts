import type { Application } from "express";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { clyraDataPath } from "../runtime-paths";
import { openCodeRuntimeManager } from "./OpenCodeRuntimeManager";

const MAX_PROMPT_LENGTH = 20_000;
const subscriptions = new Map<string, () => void>();

function safeProjectId(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 96);
}

function projectPath(projectId: string) {
  return path.join(clyraDataPath("projects"), safeProjectId(projectId), "files");
}

function titleFor(prompt: string) {
  return prompt.replace(/\s+/g, " ").trim().slice(0, 72) || "New Clyra task";
}

function sendSse(res: import("express").Response, event: unknown) {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

/** SDK-backed local API. The renderer only sees project/session-scoped data. */
export function registerOpenCodeRoutes(app: Application) {
  app.get("/api/opencode/status", async (_req, res) => {
    const health = await openCodeRuntimeManager.health();
    res.json({ sdkVersion: "1.18.12", executableVersion: process.env.CLYRA_OPENCODE_VERSION || "detected at runtime", ...health });
  });

  app.post("/api/opencode/runtime/start", async (req, res) => {
    const projectId = safeProjectId(String(req.body?.projectId || ""));
    if (!projectId) return res.status(400).json({ error: "A valid project ID is required." });
    try {
      const root = projectPath(projectId);
      await fs.mkdir(root, { recursive: true });
      res.json(await openCodeRuntimeManager.start(projectId, root));
    } catch (error) {
      res.status(503).json({ error: error instanceof Error ? error.message : "OpenCode could not start." });
    }
  });

  app.post("/api/opencode/runtime/stop", async (_req, res) => {
    await openCodeRuntimeManager.stop();
    res.json({ ok: true });
  });

  app.get("/api/opencode/diagnostic/:projectId", (req, res) => {
    try { res.json(openCodeRuntimeManager.inspect(safeProjectId(req.params.projectId))); }
    catch (error) { res.status(404).json({ error: error instanceof Error ? error.message : "Project not found." }); }
  });

  app.post("/api/opencode/sessions", async (req, res) => {
    const projectId = safeProjectId(String(req.body?.projectId || ""));
    try { res.json(await openCodeRuntimeManager.createSession(projectId, String(req.body?.title || "").slice(0, 160))); }
    catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : "Could not create session." }); }
  });

  app.get("/api/opencode/sessions/:projectId", async (req, res) => {
    try { res.json(await openCodeRuntimeManager.listSessions(safeProjectId(req.params.projectId))); }
    catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : "Could not list sessions." }); }
  });

  app.get("/api/opencode/sessions/:projectId/:sessionId/messages", async (req, res) => {
    try { res.json(await openCodeRuntimeManager.messages(safeProjectId(req.params.projectId), req.params.sessionId)); }
    catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : "Could not fetch history." }); }
  });

  app.get("/api/opencode/sessions/:projectId/:sessionId/diff", async (req, res) => {
    try { res.json(await openCodeRuntimeManager.diff(safeProjectId(req.params.projectId), req.params.sessionId)); }
    catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : "Could not fetch changes." }); }
  });

  app.post("/api/opencode/sessions/:projectId/:sessionId/prompt", async (req, res) => {
    const text = String(req.body?.text || "").trim();
    if (!text || text.length > MAX_PROMPT_LENGTH) return res.status(400).json({ error: "Enter a coding request up to 20,000 characters." });
    try {
      await openCodeRuntimeManager.prompt(safeProjectId(req.params.projectId), req.params.sessionId, text, typeof req.body?.agent === "string" ? req.body.agent : undefined);
      res.json({ ok: true });
    } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : "Prompt could not be sent." }); }
  });

  app.post("/api/opencode/sessions/:projectId/:sessionId/abort", async (req, res) => {
    try { await openCodeRuntimeManager.abort(safeProjectId(req.params.projectId), req.params.sessionId); res.json({ ok: true }); }
    catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : "Could not abort session." }); }
  });

  app.post("/api/opencode/sessions/:projectId/:sessionId/permissions/:permissionId", async (req, res) => {
    const response = String(req.body?.response || "deny");
    if (!["allow", "always", "deny"].includes(response)) return res.status(400).json({ error: "Invalid permission response." });
    try { await openCodeRuntimeManager.respondPermission(safeProjectId(req.params.projectId), req.params.sessionId, req.params.permissionId, response); res.json({ ok: true }); }
    catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : "Could not answer permission." }); }
  });

  app.get("/api/opencode/events/:projectId", (req, res) => {
    const projectId = safeProjectId(req.params.projectId);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    const id = randomUUID();
    try {
      subscriptions.set(id, openCodeRuntimeManager.subscribe(projectId, (event) => sendSse(res, event)));
      req.on("close", () => { subscriptions.get(id)?.(); subscriptions.delete(id); });
    } catch (error) { sendSse(res, { type: "runtime.error", error: error instanceof Error ? error.message : String(error) }); res.end(); }
  });

  // Compatibility endpoint used by the current renderer while it is migrated.
  app.post("/api/opencode/start", async (req, res) => {
    const prompt = String(req.body?.prompt || "").trim();
    if (!prompt || prompt.length > MAX_PROMPT_LENGTH) return res.status(400).json({ error: "Enter a coding request up to 20,000 characters." });
    const projectId = safeProjectId(String(req.body?.projectId || "")) || `clyra-${randomUUID().slice(0, 8)}`;
    try {
      const root = projectPath(projectId);
      await fs.mkdir(root, { recursive: true });
      await openCodeRuntimeManager.start(projectId, root);
      const session = await openCodeRuntimeManager.createSession(projectId, titleFor(prompt));
      await openCodeRuntimeManager.prompt(projectId, session.id, prompt, Boolean(req.body?.planMode) ? "plan" : undefined);
      res.json({ taskId: session.id, sessionId: session.id, projectId, provider: "opencode-sdk", sdkVersion: "1.18.12" });
    } catch (error) { res.status(503).json({ error: error instanceof Error ? error.message : "OpenCode could not start." }); }
  });

  app.post("/api/opencode/cancel/:sessionId", async (req, res) => {
    const projectId = safeProjectId(String(req.body?.projectId || ""));
    try { await openCodeRuntimeManager.abort(projectId, req.params.sessionId); res.json({ ok: true }); }
    catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : "Could not cancel task." }); }
  });
}
