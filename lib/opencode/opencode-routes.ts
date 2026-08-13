import type { Application } from "express";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { clyraDataPath } from "../runtime-paths";
import { codingModelStatus, openCodeRuntimeManager } from "./OpenCodeRuntimeManager";
import { detectMobileSwiftProject } from "../mobile-preview-routes";

const execFileAsync = promisify(execFile);

const IOS_AGENTS_MD = `# Clyra Code Agent — Cross-platform SwiftUI Source Mode

You are building a portable Swift/SwiftUI application source workspace. Clyra
must work consistently on macOS and Windows, so do not depend on Xcode,
xcodebuild, a physical iPhone, xtool, go-ios, WSL, or a platform-only simulator.
Never claim a native install or device build succeeded unless the configured
preview service has returned a real successful result.

Project architecture rules — for every coding request:
- Inspect the existing project structure first (list files and read Package.swift) and match its conventions.
- Split code across the standard layout — never generate the whole application inside one giant Swift file:
  App/  Views/  Components/  Models/  ViewModels/  Services/  Utilities/  Resources/  Tests/
- Use real SwiftUI and a portable Swift Package (Package.swift). Keep views small, focused and reusable.
- Reuse existing views and models instead of rebuilding them. Revisit and edit multiple files during the run when needed.
- Apple guidance lives in .agent/skills/ — apply its design guidance where compatible with ElementaryUI.
- The embedded preview can be unavailable on a host without a configured preview bridge. Generate correct reusable source and use portable/static checks where available; report the preview limitation plainly rather than attempting unavailable device tooling.
- Only claim completion for checks that actually ran. If validation fails, show the error, fix the file, and rerun the available validation.
- Use SF Symbols, Swift concurrency (async/await), and accessibility best practices.
`;

const APPLE_SKILL_SOURCE = path.resolve(process.cwd(), "lib/apple-skills-repo", "skills");
const SWIFTUI_SKILL_SOURCE = path.resolve(process.cwd(), "lib/swiftui-agent-skill-repo", "skills", "swiftui-expert-skill");

/**
 * Project workspaces live inside Clyra's data dir, which the parent repo
 * gitignores. OpenCode's snapshot/diff system needs a git worktree, so give
 * each project its own repo with a baseline commit. Without this, session
 * diffs are always empty and the UI cannot show real +/− statistics.
 */
async function ensureProjectGitRepo(root: string) {
  const git = (...args: string[]) =>
    execFileAsync("git", ["-C", root, ...args], { timeout: 15_000 });
  try {
    await fs.access(path.join(root, ".git"));
  } catch {
    await git("init", "--initial-branch=main").catch(() => git("init"));
    await git("config", "user.email", "agent@clyra.local");
    await git("config", "user.name", "Clyra Agent");
  }
  try {
    await git("rev-parse", "HEAD");
  } catch {
    // No commits yet: snapshot whatever already exists as the baseline.
    await git("add", "-A");
    await git("commit", "--allow-empty", "-m", "Clyra project baseline").catch(() => undefined);
  }
}

const MAX_PROMPT_LENGTH = 20_000;
// The request body is JSON/base64, so keep the decoded total safely inside
// Express's 16 MB body limit.
const MAX_ATTACHMENT_BYTES = 6 * 1024 * 1024;
const MAX_ATTACHMENT_TOTAL_BYTES = 10 * 1024 * 1024;
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

function requestsIosProject(prompt: string) {
  return /\b(?:ios|iphone|ipad|swiftui|uikit|xcode|xcworkspace|xcodeproj)\b/i.test(prompt);
}

/**
 * A new workspace has no Xcode project yet, so file-based platform detection
 * alone cannot select iOS mode. Seed the same real agent guidance from the
 * request when the user explicitly asks for an Apple-platform project.
 */
async function prepareIosAgentWorkspace(root: string) {
  await fs.writeFile(path.join(root, "AGENTS.md"), IOS_AGENTS_MD, "utf8").catch(() => undefined);
  try {
    await fs.mkdir(path.join(root, ".agent", "skills"), { recursive: true });
    await fs.cp(APPLE_SKILL_SOURCE, path.join(root, ".agent", "skills", "apple-skills"), {
      recursive: true,
      force: true,
    }).catch(() => undefined);
    await fs.cp(SWIFTUI_SKILL_SOURCE, path.join(root, ".agent", "skills", "swiftui-expert"), {
      recursive: true,
      force: true,
    }).catch(() => undefined);
  } catch {
    /* Skills are optional context, not a runtime prerequisite. */
  }
}

function sendSse(res: import("express").Response, event: unknown) {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

/** SDK-backed local API. The renderer only sees project/session-scoped data. */
export function registerOpenCodeRoutes(app: Application) {
  app.get("/api/opencode/status", async (_req, res) => {
    const health = await openCodeRuntimeManager.health();
    const configuredModel = codingModelStatus();
    res.json({
      sdkVersion: "1.18.12",
      executableVersion: process.env.CLYRA_OPENCODE_VERSION || "detected at runtime",
      // Model identity is safe to show. Credentials remain exclusively in the
      // service process and are never emitted in this response.
      model: configuredModel.available ? `${configuredModel.providerID}/${configuredModel.modelID}` : undefined,
      providerConfigured: configuredModel.available,
      providerError: configuredModel.available ? undefined : configuredModel.error,
      ...health,
    });
  });

  app.post("/api/opencode/runtime/start", async (req, res) => {
    const projectId = safeProjectId(String(req.body?.projectId || ""));
    if (!projectId) return res.status(400).json({ error: "A valid project ID is required." });
    try {
      const root = projectPath(projectId);
      await fs.mkdir(root, { recursive: true });
      await ensureProjectGitRepo(root).catch(() => undefined);
      // Seed adaptive agent guidance when missing (OpenCode reads AGENTS.md).
      // iOS projects always get the iOS App Mode guidance plus the Apple
      // development skills copied into the sandbox the agent can read.
      try {
        await fs.access(path.join(root, "AGENTS.md"));
      } catch {
        await fs.writeFile(
          path.join(root, "AGENTS.md"),
          `# Clyra Code Agent

Be an adaptive expert coding agent like Cursor or Codex. Understand intent → investigate → plan across files → act → inspect → adapt → validate until complete.
No fixed tool-call quota. Scale effort to the request. Read before editing. Prefer production-quality work. Fix failures after checks.

Project architecture rules — for every coding request:
- Inspect the existing project structure first (list files, read configs) and match its framework and conventions.
- Split code naturally across components, pages, styles, hooks, utilities, APIs, config, assets, and tests. Never cram everything into a single index.html unless a single-file deliverable is genuinely requested.
- For React/Next/Vite projects create proper files: components, styles, hooks, utilities, routes, and config.
- Reuse existing components instead of rebuilding them. Revisit and edit multiple files during the run when needed.
- Run the project's build/typecheck/tests after changes and fix every error before finishing.
- For greenfield web apps, put index.html at the project root so the live preview can start, and keep it as a thin shell that loads the real source files.
- For desktop/Electron requests, build the product first as a responsive web application that runs in the live development preview. Then add a minimal Electron main/preload wrapper, safe BrowserWindow configuration, and package scripts around that same web app. Do not make the live preview depend on Electron or native-only APIs; it must remain usable in Chromium at every responsive preview size.
`,
          "utf8",
        ).catch(() => undefined);
      }
      // Swift mobile preview mode is source based, not Xcode based.
      if (detectMobileSwiftProject(root)) {
        await prepareIosAgentWorkspace(root);
      }
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

  app.patch("/api/opencode/sessions/:projectId/:sessionId", async (req, res) => {
    const title = String(req.body?.title || "").trim().slice(0, 160);
    if (!title) return res.status(400).json({ error: "A chat title is required." });
    try { res.json(await openCodeRuntimeManager.renameSession(safeProjectId(req.params.projectId), req.params.sessionId, title)); }
    catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : "Could not rename chat." }); }
  });

  app.delete("/api/opencode/sessions/:projectId/:sessionId", async (req, res) => {
    try {
      await openCodeRuntimeManager.deleteSession(safeProjectId(req.params.projectId), req.params.sessionId);
      res.json({ ok: true });
    } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : "Could not delete chat." }); }
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
      if (requestsIosProject(text)) await prepareIosAgentWorkspace(projectPath(safeProjectId(req.params.projectId)));
      await openCodeRuntimeManager.prompt(safeProjectId(req.params.projectId), req.params.sessionId, text, typeof req.body?.agent === "string" ? req.body.agent : undefined);
      res.json({ ok: true });
    } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : "Prompt could not be sent." }); }
  });

  // Persist attachments inside the selected workspace. OpenCode can then read
  // the exact files named in the prompt instead of receiving mock metadata.
  app.post("/api/opencode/projects/:projectId/attachments", async (req, res) => {
    const projectId = safeProjectId(req.params.projectId);
    const files = Array.isArray(req.body?.files) ? req.body.files : [];
    if (!projectId || !files.length) return res.status(400).json({ error: "Choose one or more files to attach." });
    if (files.length > 12) return res.status(400).json({ error: "Attach up to 12 files at a time." });
    const root = path.join(projectPath(projectId), ".clyra-attachments");
    let total = 0;
    const saved: Array<{ name: string; path: string; type: string }> = [];
    try {
      await fs.mkdir(root, { recursive: true });
      for (const [index, entry] of files.entries()) {
        const encoded = typeof entry?.data === "string" ? entry.data : "";
        const buffer = Buffer.from(encoded, "base64");
        const name = path.basename(String(entry?.name || "attachment")).replace(/[^a-zA-Z0-9._ -]/g, "_").slice(0, 120) || "attachment";
        if (!encoded || !buffer.length || buffer.length > MAX_ATTACHMENT_BYTES || total + buffer.length > MAX_ATTACHMENT_TOTAL_BYTES) {
          return res.status(413).json({ error: "Attachments are limited to 6 MB each and 10 MB total." });
        }
        total += buffer.length;
        const filename = `${Date.now()}-${index + 1}-${name}`;
        await fs.writeFile(path.join(root, filename), buffer);
        saved.push({ name, path: `.clyra-attachments/${filename}`, type: String(entry?.type || "application/octet-stream").slice(0, 100) });
      }
      res.json({ attachments: saved });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Could not attach the selected files." });
    }
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
      await ensureProjectGitRepo(root).catch(() => undefined);
      if (requestsIosProject(prompt)) await prepareIosAgentWorkspace(root);
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
