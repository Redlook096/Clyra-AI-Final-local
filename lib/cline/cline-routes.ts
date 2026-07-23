import { ClineAdapter } from "./cline-adapter";
import { OpenHandsAdapter } from "../openhands/openhands-adapter";
import {
  controlM1Runtime,
  getM1RuntimeEvents,
  getM1RuntimeSnapshot,
  launchM1Conversation,
} from "../openhands/m1-launch";
import { getM1Paths } from "../openhands/m1-stack";
import { VibeCoderEvent } from "./cline-events";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { promises as fs } from "node:fs";
import { clyraDataPath } from "../runtime-paths";

type VibeAdapter = ClineAdapter | OpenHandsAdapter;

const activeTasks = new Map<
  string,
  {
    adapter: VibeAdapter;
    events: VibeCoderEvent[];
    listeners: ((event: VibeCoderEvent) => void)[];
    approvePlan?: () => void;
    harness: "openhands" | "cline" | "vibe-coder-m1";
  }
>();

function slugifyProjectName(input: string) {
  const cleaned = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 52);
  return cleaned || "clyra-vibe-project";
}

function safeProjectId(id: string) {
  return id.replace(/[^a-zA-Z0-9_-]/g, "");
}

function useOpenHandsHarness() {
  const flag = String(process.env.CLYRA_VIBE_HARNESS || "m1").toLowerCase();
  return flag === "openhands";
}

function useClineHarness() {
  const flag = String(process.env.CLYRA_VIBE_HARNESS || "m1").toLowerCase();
  return flag === "cline";
}

export function registerClineRoutes(app: import("express").Application) {
  app.get("/api/vibe/runtime/:projectId", async (req, res) => {
    try {
      const projectId = safeProjectId(req.params.projectId);
      const after = Math.max(0, Number(req.query.after || 0));
      const [snapshot, events] = await Promise.all([
        getM1RuntimeSnapshot(projectId),
        getM1RuntimeEvents(projectId, after),
      ]);
      res.json({ snapshot, events });
    } catch (error) {
      res.status(404).json({ error: error instanceof Error ? error.message : "Runtime not found" });
    }
  });

  app.get("/api/vibe/runtime/:projectId/events", async (req, res) => {
    const projectId = safeProjectId(req.params.projectId);
    const after = Math.max(0, Number(req.query.after || 0));
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    let cursor = after;
    const flush = async () => {
      try {
        const events = await getM1RuntimeEvents(projectId, cursor);
        for (const event of events) {
          cursor = event.sequence;
          res.write(`id: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`);
        }
      } catch (error) {
        res.write(`event: error\ndata: ${JSON.stringify({ error: error instanceof Error ? error.message : "Runtime stream failed" })}\n\n`);
      }
    };
    await flush();
    const timer = setInterval(() => void flush(), 1_000);
    req.on("close", () => clearInterval(timer));
  });

  app.post("/api/vibe/runtime/:projectId/control", async (req, res) => {
    try {
      const command = String(req.body?.command || "");
      if (!["pause", "resume", "cancel", "steer"].includes(command)) {
        res.status(400).json({ error: "A valid runtime command is required." });
        return;
      }
      const snapshot = await controlM1Runtime(
        safeProjectId(req.params.projectId),
        command as "pause" | "resume" | "cancel" | "steer",
        typeof req.body?.message === "string" ? req.body.message : undefined,
      );
      res.json({ snapshot });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Runtime control failed" });
    }
  });

  app.post("/api/vibe/m1-launch", async (req, res) => {
    try {
      const { prompt, projectId, planMode, continueExisting } = req.body ?? {};
      let timeout: NodeJS.Timeout | undefined;
      try {
        const result = await Promise.race([
          launchM1Conversation({
            prompt: typeof prompt === "string" ? prompt : undefined,
            projectId: typeof projectId === "string" ? projectId : undefined,
            planMode: !!planMode,
            continueExisting: !!continueExisting,
          }),
          new Promise<never>((_, reject) => {
            // A warmed stack responds promptly, but a cold launch first waits
            // for ensureM1Stack (CLYRA_M1_START_TIMEOUT_MS, default 90s) and
            // then still has to create the LLM conversation. Derive this race
            // from the same knob plus headroom so raising the stack timeout
            // can never make this route kill a healthy launch.
            const stackStartupTimeout = Math.max(30_000, Number(process.env.CLYRA_M1_START_TIMEOUT_MS || 90_000));
            const launchTimeout = stackStartupTimeout + 30_000;
            timeout = setTimeout(() => reject(new Error("Vibe Coder is still starting. Please try again in a moment.")), launchTimeout);
          }),
        ]);
        res.json(result);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    } catch (error) {
      console.error("[m1-launch]", error);
      res.status(500).json({
        error: error instanceof Error ? error.message : "Failed to launch M1",
      });
    }
  });

  app.get("/api/vibe/m1-status", async (_req, res) => {
    try {
      const paths = getM1Paths();
      let uiReady = false;
      let agentReady = false;
      try {
        const ui = await fetch(paths.uiUrl, { signal: AbortSignal.timeout(1200) });
        uiReady = ui.ok || ui.status === 200 || ui.status === 304;
      } catch {
        uiReady = false;
      }
      try {
        const agent = await fetch(`${paths.agentUrl}/server_info`, {
          // A busy local agent-server can take a couple of seconds to answer
          // this informational probe while it is flushing a tool result. Do
          // not show Vibe as unavailable just because a short health timeout
          // raced an active build.
          signal: AbortSignal.timeout(5_000),
        });
        agentReady = agent.ok;
      } catch {
        agentReady = false;
      }
      res.json({ ready: uiReady && agentReady, uiReady, agentReady, ...paths });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : "M1 status failed",
      });
    }
  });

  // Boot preload can await a real stack start; hover/idle callers stay fire-and-forget.
  app.post("/api/vibe/m1-warmup", async (req, res) => {
    try {
      const awaitReady =
        req.query.await === "1" ||
        req.query.await === "true" ||
        req.body?.await === true;
      if (!awaitReady) {
        const { warmupM1StackInBackground } = await import("../openhands/m1-stack");
        warmupM1StackInBackground();
        res.json({ ok: true, warming: true });
        return;
      }

      const timeoutMs = Math.max(
        5_000,
        Math.min(
          90_000,
          Number(req.body?.timeoutMs || req.query.timeoutMs || 45_000) || 45_000,
        ),
      );
      const { warmupM1Stack } = await import("../openhands/m1-stack");
      const result = await warmupM1Stack({ timeoutMs });
      res.json({ ok: true, warming: !result.ready, ...result });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : "M1 warmup failed",
      });
    }
  });

  app.post("/api/vibe/start", async (req, res) => {
    const { prompt, projectId, planMode, workspacePath } = req.body;

    if (!prompt) {
      res.status(400).json({ error: "prompt is required" });
      return;
    }

    // Default: full M1 Vibe Coder (welcome/all-projects stay in Clyra UI).
    if (!useOpenHandsHarness() && !useClineHarness()) {
      try {
        const result = await launchM1Conversation({
          prompt,
          projectId,
          planMode: !!planMode,
        });
        res.json({
          taskId: result.conversationId,
          projectId: result.projectId,
          harness: result.harness,
          conversationUrl: result.conversationUrl,
          uiUrl: result.uiUrl,
        });
      } catch (error) {
        console.error("[vibe/start m1]", error);
        res.status(500).json({
          error: error instanceof Error ? error.message : "M1 launch failed",
        });
      }
      return;
    }

    const taskId = randomUUID();
    const harness = useOpenHandsHarness() ? "openhands" : "cline";
    const taskData = {
      adapter: (harness === "openhands"
        ? new OpenHandsAdapter()
        : new ClineAdapter()) as VibeAdapter,
      events: [] as VibeCoderEvent[],
      listeners: [] as ((event: VibeCoderEvent) => void)[],
      harness: harness as "openhands" | "cline",
    };
    activeTasks.set(taskId, taskData);

    const apiKey =
      process.env.MY_LLM_API_KEY ||
      process.env.DEEPSEEK_API_KEY ||
      process.env.ANTHROPIC_API_KEY ||
      process.env.OPENAI_API_KEY;
    const provider = process.env.MY_LLM_BASE_URL
      ? "openai-compatible"
      : process.env.DEEPSEEK_API_KEY
        ? "deepseek"
        : process.env.ANTHROPIC_API_KEY
          ? "anthropic"
          : "openhands";
    const model =
      process.env.MY_LLM_MODEL ||
      (process.env.DEEPSEEK_API_KEY
        ? "deepseek-chat"
        : process.env.ANTHROPIC_API_KEY
          ? "claude-3-5-sonnet-20241022"
          : "gpt-4.1-mini");
    const baseUrl =
      process.env.MY_LLM_BASE_URL ||
      (process.env.DEEPSEEK_API_KEY ? "https://api.deepseek.com" : undefined);

    taskData.adapter.on("event", (event: VibeCoderEvent) => {
      taskData.events.push(event);
      taskData.listeners.forEach((listener) => listener(event));
    });

    const requestedProjectId = typeof projectId === "string" ? projectId : "";
    const shouldCreateFreshProject =
      !requestedProjectId || requestedProjectId === "project-advanced-vibe";
    const actualProjectId = shouldCreateFreshProject
      ? `${slugifyProjectName(prompt)}-${randomUUID().slice(0, 6)}`
      : safeProjectId(requestedProjectId);
    const resolvedWorkspacePath = path.resolve(
      workspacePath ||
        path.join(
          clyraDataPath("projects"),
          safeProjectId(actualProjectId),
          "files",
        ),
    );

    await fs
      .mkdir(resolvedWorkspacePath, { recursive: true })
      .catch(console.error);

    if (harness === "openhands") {
      void (taskData.adapter as OpenHandsAdapter).startOpenHandsTask({
        projectId: actualProjectId,
        prompt,
        planMode: !!planMode,
        workspacePath: resolvedWorkspacePath,
        provider,
        model,
        apiKey,
        baseUrl,
      });
    } else {
      (taskData.adapter as ClineAdapter).startClineTask({
        projectId: actualProjectId,
        prompt,
        planMode: !!planMode,
        workspacePath: resolvedWorkspacePath,
        provider,
        model,
        apiKey,
      });
    }

    res.json({ taskId, projectId: actualProjectId, harness });
  });

  app.get("/api/vibe/events/:taskId", (req, res) => {
    const { taskId } = req.params;
    const taskData = activeTasks.get(taskId);

    if (!taskData) {
      res.status(404).json({ error: "Task not found" });
      return;
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    for (const event of taskData.events) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }

    const listener = (event: VibeCoderEvent) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
      if (
        event.type === "complete" ||
        (event.type === "error" && !event.recoverable)
      ) {
        res.end();
        activeTasks.delete(taskId);
      }
    };

    taskData.listeners.push(listener);

    req.on("close", () => {
      taskData.listeners = taskData.listeners.filter((l) => l !== listener);
    });
  });

  app.post("/api/vibe/cancel/:taskId", async (req, res) => {
    const { taskId } = req.params;
    const taskData = activeTasks.get(taskId);
    if (taskData) {
      await Promise.resolve(taskData.adapter.cancel());
      activeTasks.delete(taskId);
    }
    res.json({ success: true });
  });

  app.post("/api/vibe/pause/:taskId", async (req, res) => {
    const { taskId } = req.params;
    const taskData = activeTasks.get(taskId);
    if (!taskData) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    try {
      if (taskData.adapter instanceof OpenHandsAdapter) {
        await taskData.adapter.pause();
        res.json({ success: true, paused: true });
        return;
      }
      taskData.adapter.cancel();
      res.json({ success: true, paused: true, fallback: "cancel" });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : "Pause failed",
      });
    }
  });

  app.post("/api/vibe/resume/:taskId", async (req, res) => {
    const { taskId } = req.params;
    const taskData = activeTasks.get(taskId);
    if (!taskData) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    try {
      if (taskData.adapter instanceof OpenHandsAdapter) {
        await taskData.adapter.resume();
        res.json({ success: true, resumed: true });
        return;
      }
      res
        .status(400)
        .json({ error: "Resume is only available for OpenHands harness" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Resume failed";
      if (/409|already running/i.test(message)) {
        res.json({ success: true, resumed: true, alreadyRunning: true });
        return;
      }
      res.status(500).json({ error: message });
    }
  });

  app.post("/api/vibe/approve/:taskId", async (req, res) => {
    const { taskId } = req.params;
    const taskData = activeTasks.get(taskId);
    if (!taskData) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    try {
      if (taskData.approvePlan) {
        taskData.approvePlan();
        res.json({ success: true, resumed: true });
        return;
      }
      await Promise.resolve(taskData.adapter.approvePlan());
      res.json({ success: true, resumed: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Approve failed";
      if (/409|already running/i.test(message)) {
        res.json({ success: true, resumed: true, alreadyRunning: true });
        return;
      }
      res.status(500).json({ error: message });
    }
  });
}
