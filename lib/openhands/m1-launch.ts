import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { ConversationClient } from "@openhands/typescript-client/clients";
import WebSocket from "ws";
import { ensureM1Stack } from "./m1-stack";
import { buildOpenHandsConversationPayload } from "./openhands-payload";
import {
  AgentRuntimeStore,
  assertWorkspaceBoundary,
  createWorkspaceCheckpoint,
  ensureWorkspaceAlias,
  type AgentRuntimeEventType,
} from "../vibe-runtime/runtime";
import { runWorkspaceValidation } from "../vibe-runtime/validation";
import { startDevServer } from "../vibe-coder/preview/preview-runner";

function slugify(input: string) {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 52) || "clyra-vibe-project"
  );
}

function safeProjectId(id: string) {
  return id.replace(/[^a-zA-Z0-9_-]/g, "");
}

async function readProjectMetadata(projectRoot: string) {
  try {
    const raw = await fs.readFile(path.join(projectRoot, "metadata.json"), "utf8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function buildConversationUrl(
  uiUrl: string,
  conversationId: string,
  continueExisting: boolean,
) {
  const base = `${uiUrl}/conversations/${conversationId}?openPreview=1`;
  return continueExisting ? `${base}&continue=1` : base;
}

type M1RuntimeControl = {
  client: ConversationClient;
  conversationId: string;
  store: AgentRuntimeStore;
  workspacePath: string;
};

const activeM1Runtimes = new Map<string, M1RuntimeControl>();

async function workspaceHasGeneratedFiles(workspacePath: string) {
  try {
    const entries = await fs.readdir(workspacePath);
    return entries.some((entry) => !entry.startsWith("."));
  } catch {
    return false;
  }
}

function actionRecord(raw: unknown) {
  return (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
}

function eventText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return value.map(eventText).filter(Boolean).join(" ");
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return eventText(
      record.text ?? record.content ?? record.message ?? record.output ?? record.result ?? record.path ?? "",
    );
  }
  return "";
}

function toolName(raw: Record<string, unknown>) {
  const action = actionRecord(raw.action);
  return String(raw.tool_name || action.tool_name || raw.tool || "").toLowerCase();
}

function rawText(raw: Record<string, unknown>) {
  const action = actionRecord(raw.action);
  const observation = actionRecord(raw.observation);
  return eventText(action.command || action.path || action.file_path || raw.path || observation.content || raw.content);
}

function m1EventType(raw: Record<string, unknown>): AgentRuntimeEventType {
  const kind = String(raw.kind || raw.type || "").toLowerCase();
  const tool = toolName(raw);
  if (kind.includes("observation")) {
    if (tool.includes("terminal")) return "command.output";
    if (tool.includes("browser")) return "browser.snapshot";
    return "tool.progress";
  }
  if (tool.includes("terminal") || tool.includes("bash")) return "command.started";
  if (tool.includes("browser")) return "browser.action.started";
  if (tool.includes("file") || tool.includes("editor") || tool.includes("replace")) return "file.change.proposed";
  if (tool.includes("task")) return "plan.updated";
  return "tool.started";
}

function isUnsafeWorkspaceCommand(command: string, workspacePath: string) {
  const value = command.trim();
  if (!value) return false;

  // The agent server sometimes begins a compound command by explicitly
  // entering the workspace it was given. That is equivalent to using $PWD
  // and must not trip the boundary guard. The root and its descendants are
  // valid targets (the generated app lives in `files/`); parent paths and
  // every other absolute location remain outside the workspace contract.
  const approvedRoots = [
    path.resolve(workspacePath),
    path.join(process.cwd(), ".clyra", "vibe-runtime", "workspaces", path.basename(workspacePath)),
  ];
  const commandWithApprovedRootNormalised = approvedRoots.reduce((command, root) => {
    const escapedRoot = root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return command.replace(
      new RegExp(`(?:"${escapedRoot}"|'${escapedRoot}'|${escapedRoot})(?=(?:/|\\s|&&|;|$))`, "g"),
      "$PWD",
    );
  }, value);

  return /(?:^|\s)cd\s+\.\.(?:\s|\/|$)|(?:^|[\s"'=<>])\.\.\/|~\/|\/Users\/|\/private\/|\/tmp\//.test(commandWithApprovedRootNormalised);
}

function decodeM1EventFrames(data: WebSocket.RawData) {
  const text = String(data).trim();
  if (!text) return [] as Record<string, unknown>[];
  const candidates = text
    .split(/\r?\n/)
    .map((line) => line.startsWith("data:") ? line.slice(5).trim() : line.trim())
    .filter((line) => line && line !== "[DONE]");
  const frames: Record<string, unknown>[] = [];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        frames.push(parsed as Record<string, unknown>);
      }
    } catch {
      // The agent server also sends plain streamed text. It is not a runtime
      // event and must not turn into a misleading failed-tool entry.
    }
  }
  return frames;
}

function bridgeM1Events(options: {
  agentUrl: string;
  apiKey: string;
  projectId: string;
  client: ConversationClient;
  conversationId: string;
  store: AgentRuntimeStore;
  workspacePath: string;
}) {
  const base = new URL(options.agentUrl);
  const scheme = base.protocol === "https:" ? "wss:" : "ws:";
  const url = new URL(`${scheme}//${base.host}${base.pathname.replace(/\/$/, "")}/sockets/events/${options.conversationId}`);
  url.searchParams.set("session_api_key", options.apiKey);
  const socket = new WebSocket(url.toString());
  socket.on("message", (data) => {
    void (async () => {
      for (const raw of decodeM1EventFrames(data)) {
        try {
        const eventType = m1EventType(raw);
        const summary = rawText(raw).slice(0, 12_000);
        const action = actionRecord(raw.action);
        const command = String(action.command || "");
        if (eventType === "command.started" && isUnsafeWorkspaceCommand(command, options.workspacePath)) {
          await options.store.append({
            type: "tool.failed",
            harness: "m1",
            status: "failed",
            payload: { tool: toolName(raw), command },
            error: { code: "workspace_boundary", message: "Blocked an M1 command that left the approved workspace.", recoverable: true },
          });
          await options.client.sendEvent(options.conversationId, {
            role: "user",
            content: [{ type: "text", text: "That terminal command was blocked because it referenced a path outside the approved workspace. Continue from the files already created. Use file_editor for source changes, keep terminal commands relative to the workspace, and let Clyra start the preview after you finish." }],
          }, { run: true }).catch(() => undefined);
          continue;
        }
        const candidatePath = String(action.path || action.file_path || raw.path || "");
        if (candidatePath.startsWith("/")) await assertWorkspaceBoundary(options.workspacePath, candidatePath);
        // Text-token frames are useful to the M1 UI but are not independent
        // tool lifecycle events. Avoid writing one runtime row per token.
        if (!toolName(raw) && !action.action && typeof raw.content === "string") continue;
        await options.store.append({
          type: eventType,
          harness: "m1",
          status: String(raw.kind || "").toLowerCase().includes("observation") ? "progress" : "started",
          payload: { tool: toolName(raw), summary, rawEventId: raw.id || raw.event_id || undefined },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.startsWith("Workspace boundary violation:")) {
          await options.store.append({
            type: "tool.failed",
            harness: "m1",
            status: "failed",
            payload: { source: "m1-event-bridge", path: rawText(raw) },
            error: { code: "workspace_boundary", message, recoverable: false },
          });
          await options.store.transition("FAILED", "Blocked a file operation outside the approved workspace.", { code: "workspace_boundary", message, recoverable: false });
          await options.client.interruptConversation(options.conversationId).catch(() => undefined);
          continue;
        }
        await options.store.append({
          type: "tool.failed",
          harness: "m1",
          status: "failed",
          payload: { source: "m1-event-bridge" },
          error: { code: "m1_event_bridge", message, recoverable: true },
        }).catch(() => undefined);
        }
      }
    })();
  });
  socket.on("error", (error) => {
    void options.store.append({
      type: "tool.failed",
      harness: "m1",
      status: "failed",
      payload: { source: "m1-websocket" },
      error: { code: "m1_websocket", message: error.message, recoverable: true },
    }).catch(() => undefined);
  });
  return socket;
}

async function validateM1Completion(options: {
  client: ConversationClient;
  conversationId: string;
  projectId: string;
  prompt: string;
  workspacePath: string;
  store: AgentRuntimeStore;
}) {
  await options.store.transition("VALIDATING", "The agent stopped; validating saved work and preview.");
  await options.store.append({ type: "validation.started", harness: "clyra", status: "started", payload: { workspacePath: options.workspacePath } });
  const checks = await runWorkspaceValidation(options.workspacePath);
  for (const check of checks) await options.store.addValidation(check);
  const failed = checks.find((check) => check.status === "failed");
  if (failed) {
    await options.store.transition("REPAIRING", `${failed.name} failed; requesting a focused repair.`, { code: "validation_failed", message: failed.output || `${failed.name} failed`, recoverable: true });
    await options.client.sendEvent(options.conversationId, {
      role: "user",
      content: [{ type: "text", text: `Validation failed: ${failed.name}. Read the failure output, repair the project, and rerun the failed validation before finishing.\n\n${failed.output || "No captured output."}` }],
    }, { run: true });
    await options.store.transition("RUNNING", "Repair turn started after failed validation.");
    return false;
  }
  try {
    const preview = await startDevServer({ projectId: options.projectId, projectPath: options.workspacePath, projectName: options.prompt.slice(0, 70) || "Vibe project" });
    if (preview.url) {
      const response = await fetch(preview.url, { signal: AbortSignal.timeout(8_000) });
      const evidence = { name: "preview health", command: preview.url, status: response.ok ? "passed" as const : "failed" as const, exitCode: response.status, startedAt: new Date().toISOString(), completedAt: new Date().toISOString() };
      await options.store.addValidation(evidence);
      if (!response.ok) {
        await options.store.transition("INCOMPLETE", "The saved project did not produce a healthy preview.", { code: "preview_unhealthy", message: `Preview responded ${response.status}`, recoverable: true });
        return true;
      }
      await options.store.addCompletionEvidence(`Preview healthy at ${preview.url}`);
    }
  } catch (error) {
    await options.store.transition("INCOMPLETE", "Preview could not be verified.", { code: "preview_unavailable", message: error instanceof Error ? error.message : String(error), recoverable: true });
    return true;
  }
  await options.store.addCompletionEvidence("Required validation commands completed without failures.");
  await options.store.transition("COMPLETED", "Agent completed and validation evidence passed.");
  return true;
}

function watchM1Conversation(options: {
  client: ConversationClient;
  conversationId: string;
  projectId: string;
  prompt: string;
  workspacePath: string;
  store: AgentRuntimeStore;
  writeMeta: (extra: Record<string, unknown>) => Promise<void>;
}) {
  let validationStarted = false;
  let attempts = 0;
  const maxAttempts = 360; // 90 minutes at the 15 second interval below.

  const poll = async () => {
    attempts += 1;
    try {
      const currentSnapshot = await options.store.getSnapshot();
      if (
        ["COMPLETED", "FAILED", "INCOMPLETE", "INTERRUPTED", "CANCELLED"].includes(
          currentSnapshot.state,
        )
      ) {
        return;
      }
      const conversation = await options.client.getConversation<{
        execution_status?: string | null;
        updated_at?: string | null;
      }>(options.conversationId);
      const executionStatus = conversation.execution_status?.toLowerCase() || "running";
      if (["error", "failed"].includes(executionStatus)) {
        await options.store.transition("FAILED", "M1 reported a failed conversation.", { code: "m1_failed", message: executionStatus, recoverable: true });
        await options.writeMeta({ status: "Failed", lastBuildStatus: "failed", lastReviewStatus: "failed", agentExecutionStatus: executionStatus });
        return;
      }
      if (["cancelled"].includes(executionStatus)) {
        await options.store.transition("CANCELLED", "M1 conversation was cancelled.");
        await options.writeMeta({ status: "Failed", lastBuildStatus: "cancelled", lastReviewStatus: "not_started", agentExecutionStatus: executionStatus });
        return;
      }
      if (["stopped", "paused"].includes(executionStatus)) {
        const snapshot = await options.store.getSnapshot();
        // A browser/tool hand-off can pause an M1 conversation after it has
        // already written the project. Validate that work instead of leaving
        // the user at a dead end. An explicit Clyra pause has already put the
        // runtime store in PAUSED, so it remains fully under user control.
        if (
          !validationStarted &&
          snapshot.state !== "PAUSED" &&
          (await workspaceHasGeneratedFiles(options.workspacePath))
        ) {
          validationStarted = true;
          const terminal = await validateM1Completion(options);
          if (terminal) return;
          validationStarted = false;
          const repaired = await options.store.getSnapshot();
          await options.writeMeta({
            status: repaired.state === "COMPLETED" ? "Ready" : "Building",
            lastBuildStatus: repaired.state.toLowerCase(),
            lastReviewStatus: repaired.state === "REPAIRING" ? "repairing" : "pending",
            agentExecutionStatus: executionStatus,
          });
          const timer = setTimeout(poll, 1_500);
          timer.unref();
          return;
        }
        await options.store.transition("PAUSED", "M1 conversation is paused.");
        await options.writeMeta({ status: "Building", lastBuildStatus: "paused", lastReviewStatus: "pending", agentExecutionStatus: executionStatus });
        return;
      }
      if (["finished", "completed", "idle"].includes(executionStatus) && !validationStarted) {
        validationStarted = true;
        const terminal = await validateM1Completion(options);
        const snapshot = await options.store.getSnapshot();
        await options.writeMeta({
          status: snapshot.state === "COMPLETED" ? "Ready" : snapshot.state === "FAILED" ? "Failed" : "Building",
          lastBuildStatus: snapshot.state === "COMPLETED" ? "ready" : snapshot.state.toLowerCase(),
          lastReviewStatus: snapshot.state === "COMPLETED" ? "passed" : snapshot.state === "REPAIRING" ? "repairing" : "pending",
          agentExecutionStatus: executionStatus,
          runtimeState: snapshot.state,
        });
        if (terminal) return;
        validationStarted = false;
      } else {
        const snapshot = await options.store.getSnapshot();
        if (executionStatus === "running" && ["INITIALISING", "INSPECTING", "PLANNING", "PAUSED"].includes(snapshot.state)) {
          await options.store.transition("RUNNING", "M1 is executing the approved task.");
        }
        await options.writeMeta({ status: "Building", lastBuildStatus: "building", lastReviewStatus: "pending", agentExecutionStatus: executionStatus });
      }
      if (attempts >= maxAttempts) {
        await options.store.transition("INCOMPLETE", "The runtime reached its configured observation limit.", { code: "runtime_timeout", message: "M1 did not reach a verified terminal state within 90 minutes.", recoverable: true });
        return;
      }
    } catch (error) {
      console.warn(
        `[m1-launch] unable to reconcile conversation ${options.conversationId}:`,
        error instanceof Error ? error.message : error,
      );
      if (attempts >= maxAttempts) return;
    }
    const timer = setTimeout(poll, 15_000);
    timer.unref();
  };

  const initialTimer = setTimeout(poll, 1_500);
  initialTimer.unref();
}

export async function launchM1Conversation(options: {
  prompt?: string;
  projectId?: string;
  planMode?: boolean;
  continueExisting?: boolean;
}) {
  const stack = await ensureM1Stack();
  const continueExisting = !!options.continueExisting;
  const requestedPrompt = options.prompt?.trim() || "";

  const requested = typeof options.projectId === "string" ? options.projectId : "";
  if (continueExisting && (!requested || requested === "project-advanced-vibe")) {
    throw new Error("A project id is required to reopen an existing Vibe project.");
  }

  const projectId = continueExisting
    ? safeProjectId(requested)
    : requested && requested !== "project-advanced-vibe"
      ? safeProjectId(requested)
      : `${slugify(requestedPrompt || "clyra-vibe-project")}-${randomUUID().slice(0, 6)}`;

  const workspacePath = path.resolve(
    process.cwd(),
    "projects",
    projectId,
    "files",
  );
  const projectRoot = path.resolve(workspacePath, "..");
  await fs.mkdir(workspacePath, { recursive: true });
  // Clyra's preview, project browser, and validator all operate on `files/`.
  // Give M1 that exact directory instead of the metadata-bearing project root
  // so generated source cannot be stranded beside metadata.json where no
  // preview will ever discover it.
  const agentWorkspacePath = workspacePath;
  const workspaceAlias = await ensureWorkspaceAlias(projectId, agentWorkspacePath);

  const existingMeta = await readProjectMetadata(projectRoot);
  const storedPrompt =
    typeof existingMeta?.prompt === "string" ? existingMeta.prompt.trim() : "";
  const storedName =
    typeof existingMeta?.name === "string" ? existingMeta.name.trim() : "";
  const storedConversationId =
    typeof existingMeta?.conversationId === "string"
      ? existingMeta.conversationId.trim()
      : "";

  const promptForAgent = continueExisting
    ? storedPrompt || requestedPrompt || `Continue "${storedName || projectId}"`
    : requestedPrompt;

  if (!continueExisting && !promptForAgent) {
    throw new Error("A prompt is required to launch M1.");
  }

  const now = new Date().toISOString();
  const projectName =
    (continueExisting && storedName) ||
    storedName ||
    promptForAgent.slice(0, 70) ||
    "Vibe project";

  const writeMeta = async (extra: Record<string, unknown>) => {
    await fs.writeFile(
      path.join(projectRoot, "metadata.json"),
      `${JSON.stringify(
        {
          ...(existingMeta || {}),
          id: projectId,
          name: projectName,
          prompt: storedPrompt || promptForAgent,
          mode: options.planMode
            ? "plan"
            : typeof existingMeta?.mode === "string"
              ? existingMeta.mode
              : "fast",
          status: continueExisting ? "Open" : "Building",
          createdAt:
            typeof existingMeta?.createdAt === "string"
              ? existingMeta.createdAt
              : now,
          updatedAt: now,
          harness: "vibe-coder-m1",
          ...extra,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  };

  const runtime = new AgentRuntimeStore(projectRoot);
  const hasExistingRuntime = continueExisting && await runtime.exists();
  if (!hasExistingRuntime) {
    await runtime.create({
      projectId,
      threadId: randomUUID(),
      state: "CREATED",
      workspacePath: agentWorkspacePath,
      workspaceAlias,
      harness: "m1",
    });
    const checkpoint = await createWorkspaceCheckpoint(projectRoot, agentWorkspacePath, "Automatic checkpoint before M1 turn.");
    await runtime.setCheckpoint(checkpoint.id);
    await runtime.append({ type: "checkpoint.created", harness: "clyra", status: "completed", payload: { checkpointId: checkpoint.id, fileCount: checkpoint.manifest.length } });
    await runtime.transition("INITIALISING", "Starting the M1 runtime.");
  } else {
    // Reopening must not rewind an active task. A saved RUNNING, PAUSED, or
    // completed runtime remains authoritative while we reconnect its M1 chat.
    const snapshot = await runtime.getSnapshot();
    await runtime.append({
      type: "thread.restored",
      harness: "clyra",
      status: "completed",
      payload: { state: snapshot.state, conversationId: snapshot.conversationId },
    });
  }

  // Point host tools at M1's tools directory when available.
  const m1Tools = path.join(
    process.env.CLYRA_M1_ROOT?.trim() ||
      "/Users/lukesimpson/Documents/Coding Projects/Vibe Coder M1 Clyra",
    "agent-canvas",
    "tools",
  );
  process.env.OH_EXTRA_PYTHON_PATH = m1Tools;

  const client = new ConversationClient({
    host: stack.agentUrl,
    apiKey: stack.apiKey,
  });

  // Resume saved chat when reopening — keep history instead of a blank convo.
  if (continueExisting && storedConversationId) {
    try {
      const existing = await client.getConversation<{
        id: string;
        title?: string | null;
      }>(storedConversationId);
      const title =
        (typeof existing.title === "string" && existing.title.trim()) ||
        storedName ||
        projectName;
      await writeMeta({
        name: title,
        conversationId: existing.id,
        conversationTitle: title,
        status: "Open",
      });
      await runtime.setConversation(existing.id);
      await runtime.append({ type: "thread.restored", harness: "m1", status: "completed", payload: { conversationId: existing.id } });
      activeM1Runtimes.set(projectId, { client, conversationId: existing.id, store: runtime, workspacePath });
      return {
        projectId,
        workspacePath,
        conversationId: existing.id,
        conversationUrl: buildConversationUrl(stack.uiUrl, existing.id, true),
        uiUrl: stack.uiUrl,
        harness: "vibe-coder-m1" as const,
        openedWithoutPrompt: true,
        resumed: true,
      };
    } catch (error) {
      console.warn(
        `[m1-launch] stored conversation ${storedConversationId} unavailable; creating a new one`,
        error,
      );
    }
  }

  // Resume by workspace path when metadata has no conversationId yet.
  if (continueExisting && !storedConversationId) {
    try {
      const search = await client.searchConversations({ limit: 40 });
      const items = (search as { items?: Array<{ id?: string; workspace?: { working_dir?: string }; title?: string }> }).items
        || (search as { conversations?: Array<{ id?: string; workspace?: { working_dir?: string }; title?: string }> }).conversations
        || [];
      const match = items.find((item) => {
        const dir = item.workspace?.working_dir || "";
        return dir.includes(`/projects/${projectId}/`) || dir.endsWith(`/projects/${projectId}/files`);
      });
      if (match?.id) {
        const title =
          (typeof match.title === "string" && match.title.trim()) ||
          storedName ||
          projectName;
        await writeMeta({
          name: title,
          conversationId: match.id,
          conversationTitle: title,
          status: "Open",
        });
        return {
          projectId,
          workspacePath,
          conversationId: match.id,
          conversationUrl: buildConversationUrl(stack.uiUrl, match.id, true),
          uiUrl: stack.uiUrl,
          harness: "vibe-coder-m1" as const,
          openedWithoutPrompt: true,
          resumed: true,
        };
      }
    } catch (error) {
      console.warn("[m1-launch] conversation search failed", error);
    }
  }

  const model =
    process.env.MY_LLM_MODEL ||
    (process.env.DEEPSEEK_API_KEY ? "deepseek-chat" : "gpt-4.1-mini");
  const apiKey =
    process.env.MY_LLM_API_KEY ||
    process.env.DEEPSEEK_API_KEY ||
    process.env.OPENAI_API_KEY ||
    process.env.ANTHROPIC_API_KEY;
  const baseUrl =
    process.env.MY_LLM_BASE_URL ||
    (process.env.DEEPSEEK_API_KEY ? "https://api.deepseek.com" : undefined);

  const payload = buildOpenHandsConversationPayload({
    prompt: promptForAgent,
    workspacePath: workspaceAlias,
    workspaceAlias,
    planMode: !!options.planMode,
    model,
    apiKey,
    baseUrl,
    includeInitialMessage: !continueExisting,
  });

  const conversation = await client.createConversation<{
    id: string;
    title?: string | null;
  }>(payload);

  const title =
    (typeof conversation.title === "string" && conversation.title.trim()) ||
    projectName;

  await writeMeta({
    conversationId: conversation.id,
    conversationTitle: title,
    name: continueExisting ? projectName : title,
  });
  await runtime.setConversation(conversation.id);
  await runtime.transition(options.planMode ? "PLANNING" : "INSPECTING", options.planMode ? "M1 is inspecting the repository and creating a plan." : "M1 is inspecting the repository before implementation.");
  await runtime.append({ type: "turn.started", harness: "m1", status: "started", payload: { conversationId: conversation.id, planMode: !!options.planMode } });
  activeM1Runtimes.set(projectId, { client, conversationId: conversation.id, store: runtime, workspacePath });
  bridgeM1Events({ agentUrl: stack.agentUrl, apiKey: stack.apiKey, projectId, client, conversationId: conversation.id, store: runtime, workspacePath: agentWorkspacePath });
  watchM1Conversation({
    client,
    conversationId: conversation.id,
    projectId,
    prompt: promptForAgent,
    workspacePath,
    store: runtime,
    writeMeta,
  });

  return {
    projectId,
    workspacePath,
    conversationId: conversation.id,
    conversationUrl: buildConversationUrl(
      stack.uiUrl,
      conversation.id,
      continueExisting,
    ),
    uiUrl: stack.uiUrl,
    harness: "vibe-coder-m1" as const,
    openedWithoutPrompt: continueExisting,
    resumed: false,
  };
}

export async function getM1RuntimeSnapshot(projectId: string) {
  const safeId = safeProjectId(projectId);
  const workspacePath = path.resolve(process.cwd(), "projects", safeId, "files");
  const store = activeM1Runtimes.get(safeId)?.store || new AgentRuntimeStore(path.resolve(workspacePath, ".."));
  return store.getSnapshot();
}

export async function getM1RuntimeEvents(projectId: string, afterSequence = 0) {
  const safeId = safeProjectId(projectId);
  const workspacePath = path.resolve(process.cwd(), "projects", safeId, "files");
  const store = activeM1Runtimes.get(safeId)?.store || new AgentRuntimeStore(path.resolve(workspacePath, ".."));
  return store.events(afterSequence);
}

export async function controlM1Runtime(projectId: string, command: "pause" | "resume" | "cancel" | "steer", message?: string) {
  const runtime = activeM1Runtimes.get(safeProjectId(projectId));
  if (!runtime) throw new Error("The M1 runtime is not active in this Clyra process. Reopen the project to restore it.");
  if (command === "pause") {
    await runtime.client.interruptConversation(runtime.conversationId);
    await runtime.store.transition("PAUSED", "Paused by the user.");
  } else if (command === "resume") {
    await runtime.client.runConversation(runtime.conversationId);
    await runtime.store.transition("RUNNING", "Resumed by the user.");
    await runtime.store.append({ type: "task.resumed", harness: "m1", status: "completed", payload: {} });
  } else if (command === "cancel") {
    await runtime.client.interruptConversation(runtime.conversationId);
    await runtime.store.transition("CANCELLED", "Cancelled by the user.");
  } else {
    const instruction = message?.trim();
    if (!instruction) throw new Error("A steering message is required.");
    await runtime.client.sendEvent(runtime.conversationId, { role: "user", content: [{ type: "text", text: instruction }] }, { run: true });
    await runtime.store.append({ type: "turn.steered", harness: "m1", status: "completed", payload: { message: instruction.slice(0, 2_000) } });
    const snapshot = await runtime.store.getSnapshot();
    if (snapshot.state === "PAUSED") await runtime.store.transition("RUNNING", "Resumed with a new user instruction.");
  }
  return runtime.store.getSnapshot();
}
