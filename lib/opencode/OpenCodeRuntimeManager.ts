import { createOpencode, createOpencodeClient } from "@opencode-ai/sdk";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import os from "node:os";

const DEFAULT_AGENTS_MD = `# Clyra Code Agent

Be an adaptive expert coding agent like Cursor or Codex. Understand intent → investigate → plan across files → act → inspect → adapt → validate until complete. No fixed tool-call quota. Scale effort to the request. Read before editing. Prefer production-quality work. Fix failures after checks.

Work in real, adaptive phases rather than an unstructured command log. For non-trivial tasks, use the available todo/task-list tool before implementation and keep it updated as discoveries change the plan. Each phase should be a coherent unit such as inspection, implementation, validation, or recovery. Between meaningful phases, provide a concise user-facing progress update (one to three sentences) describing what was actually learned or completed and the next step. Never reveal hidden chain-of-thought or invent actions, files, checks, or results.

Project architecture rules — for every coding request:
- Inspect the existing project structure first (list files, read configs) and match its framework and conventions.
- Split code naturally across components, pages, styles, hooks, utilities, APIs, config, assets, and tests. Never cram everything into a single index.html unless a single-file deliverable is genuinely requested.
- For React/Next/Vite projects create proper files: components, styles, hooks, utilities, routes, and config.
- Reuse existing components instead of rebuilding them. Revisit and edit multiple files during the run when needed.
- Run the project's build/typecheck/tests after changes and fix every error before finishing.
- For greenfield web apps, put index.html at the project root so the live preview can start, and keep it as a thin shell that loads the real source files.
`;

export type ClyraAgentEvent = {
  id: string;
  projectId: string;
  sessionId?: string;
  messageId?: string;
  partId?: string;
  sequence: number;
  timestamp: number;
  type: string;
  status?: string;
  payload: Record<string, unknown>;
};

type ProjectRuntime = {
  projectId: string;
  projectPath: string;
  sessions: Set<string>;
  listeners: Set<(event: ClyraAgentEvent) => void>;
  events: ClyraAgentEvent[];
  partStates: Map<string, string>;
  reconciliation: Map<string, { fingerprint: string; idleSince?: number; emptyRetries?: number }>;
};

export type CodingModelStatus =
  | { available: true; providerID: string; modelID: string }
  | { available: false; error: string };

/**
 * Resolve the coding model from the same server-only configuration that powers
 * Clyra.  The renderer never receives credentials, and we deliberately do not
 * fall back to an OpenCode-hosted free model: doing so would silently bypass a
 * user's configured Clyra provider.
 */
export function codingModelStatus(): CodingModelStatus {
  const provider = String(process.env.CLYRA_OPENCODE_PROVIDER || "").trim();
  const model = String(
    process.env.CLYRA_OPENCODE_MODEL || process.env.DEEPSEEK_MODEL || process.env.MY_LLM_MODEL || "",
  ).trim();
  if (provider && model) return { available: true, providerID: provider, modelID: model };

  const deepseekKey = String(process.env.DEEPSEEK_API_KEY || process.env.MY_LLM_API_KEY || "").trim();
  const deepseekLooksValid =
    deepseekKey.length >= 16 &&
    !/test|dummy|example|placeholder/i.test(deepseekKey);

  if (deepseekLooksValid) {
    return { available: true, providerID: "deepseek", modelID: model || "deepseek-v4-flash" };
  }

  return {
    available: false,
    error: "Clyra's configured coding provider is unavailable. Check the server-side Clyra provider configuration and retry.",
  };
}

function resolveCodingModel(): { providerID: string; modelID: string } {
  const status = codingModelStatus();
  if (!status.available) throw new Error(status.error);
  return { providerID: status.providerID, modelID: status.modelID };
}

/**
 * Some DeepSeek Flash tool-use turns can terminate with no assistant part
 * after a legitimate sequence of commands. Keep the configured model for the
 * normal run, but use the available Pro variant only for the bounded recovery
 * continuation so the agent can finish the work it already started.
 */
function resolveRecoveryModel(): { providerID: string; modelID: string } {
  const model = resolveCodingModel();
  if (model.providerID === "deepseek" && model.modelID === "deepseek-v4-flash") {
    return { ...model, modelID: "deepseek-v4-pro" };
  }
  return model;
}

/**
 * Owns the one loopback-only OpenCode SDK runtime used by the local Clyra
 * service. OpenCode's typed client scopes every call to an explicit directory,
 * so it never falls back to the Clyra installation/repository directory.
 */
export class OpenCodeRuntimeManager {
  private runtime: Awaited<ReturnType<typeof createOpencode>> | null = null;
  private projects = new Map<string, ProjectRuntime>();
  private sequence = 0;
  private streamStarted = false;
  private lastError = "";

  async start(projectId: string, projectPath: string) {
    if (!this.runtime) {
      this.runtime = await createOpencode({ hostname: "127.0.0.1", port: await this.findFreePort(), timeout: 15_000 });
      // The SDK's SSE subscription is intentionally long-lived. Starting it
      // must not block runtime health/session creation while the server keeps
      // its stream request open.
      void this.startEventStream().catch((error) => {
        this.lastError = error instanceof Error ? error.message : String(error);
      });
    }
    const existing = this.projects.get(projectId);
    if (existing && existing.projectPath !== projectPath) throw new Error("Project ID is already associated with a different workspace.");
    const project = existing ?? { projectId, projectPath, sessions: new Set<string>(), listeners: new Set(), events: [], partStates: new Map<string, string>(), reconciliation: new Map<string, { fingerprint: string; idleSince?: number }>() };
    this.projects.set(projectId, project);
    const client = this.client(projectPath);
    const current = await client.path.get({ throwOnError: true });
    if (current.directory !== projectPath && !current.directory.endsWith(`/${projectId}/files`)) {
      throw new Error("OpenCode resolved a different project directory; Clyra refused to send a prompt.");
    }
    return { projectId, projectPath, serverUrl: this.runtime.server.url, currentProject: current, status: "healthy" as const };
  }

  async health(projectId?: string) {
    if (!this.runtime) return { status: "stopped", error: this.lastError || undefined };
    const project = projectId ? this.projects.get(projectId) : undefined;
    try {
      const response = await fetch(`${this.runtime.server.url}/global/health`, { headers: this.authHeaders() });
      return { status: response.ok ? "healthy" : "failed", serverUrl: this.runtime.server.url, projectPath: project?.projectPath };
    } catch (error) {
      return { status: "failed", serverUrl: this.runtime.server.url, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async createSession(projectId: string, title?: string) {
    const project = this.requiredProject(projectId);
    const session = await this.client(project.projectPath).session.create({ body: { title }, throwOnError: true });
    project.sessions.add(session.id);
    return session;
  }

  async listSessions(projectId: string) {
    const project = this.requiredProject(projectId);
    return this.client(project.projectPath).session.list({ throwOnError: true });
  }

  async renameSession(projectId: string, sessionId: string, title: string) {
    const project = this.requiredProject(projectId);
    if (!project.sessions.has(sessionId)) project.sessions.add(sessionId);
    return this.client(project.projectPath).session.update({
      path: { id: sessionId },
      body: { title },
      throwOnError: true,
    });
  }

  async deleteSession(projectId: string, sessionId: string) {
    const project = this.requiredProject(projectId);
    const result = await this.client(project.projectPath).session.delete({
      path: { id: sessionId },
      throwOnError: true,
    });
    project.sessions.delete(sessionId);
    return result;
  }

  async messages(projectId: string, sessionId: string) {
    const project = this.requiredProject(projectId);
    // Sessions persist on the OpenCode server across Clyra restarts, so a
    // restored session may not be in our in-memory set yet. The SDK client
    // is scoped to the project directory, which keeps this safe.
    if (!project.sessions.has(sessionId)) project.sessions.add(sessionId);
    return this.client(project.projectPath).session.messages({ path: { id: sessionId }, throwOnError: true });
  }

  async diff(projectId: string, sessionId: string) {
    const project = this.requiredProject(projectId);
    if (!project.sessions.has(sessionId)) project.sessions.add(sessionId);
    return this.client(project.projectPath).session.diff({ path: { id: sessionId }, throwOnError: true });
  }

  async prompt(projectId: string, sessionId: string, text: string, agent?: string, model?: { providerID: string; modelID: string }) {
    const project = this.requiredSession(projectId, sessionId);
    // The model always comes from Clyra's server-side provider configuration.
    const selectedModel = model ?? resolveCodingModel();
    // Adaptive behaviour is guided via AGENTS.md (OpenCode reads it), not by
    // injecting preface text into the user turn (which models may echo).
    await this.ensureAgentsGuide(project.projectPath);
    this.publish(project, { type: "session.status", properties: { sessionID: sessionId, status: { type: "busy" } } });
    const response = await this.client(project.projectPath).session.promptAsync({
      path: { id: sessionId },
      body: { agent, model: selectedModel, parts: [{ type: "text", text }] },
      throwOnError: true,
    });
    void this.reconcileSession(project, sessionId, 0);
    return response;
  }

  private async ensureAgentsGuide(projectPath: string) {
    const agentsPath = path.join(projectPath, "AGENTS.md");
    try {
      // Upgrade projects still carrying the original seeded guidance so the
      // multi-file architecture rules apply to existing workspaces too.
      const existing = await fs.promises.readFile(agentsPath, "utf8");
      if (/Be an adaptive expert coding agent\./.test(existing) && !/Project architecture rules/.test(existing)) {
        await fs.promises.writeFile(agentsPath, DEFAULT_AGENTS_MD, "utf8").catch(() => undefined);
      }
    } catch {
      await fs.promises.writeFile(agentsPath, DEFAULT_AGENTS_MD, "utf8").catch(() => undefined);
    }
  }

  async abort(projectId: string, sessionId: string) {
    const project = this.requiredSession(projectId, sessionId);
    return this.client(project.projectPath).session.abort({ path: { id: sessionId }, throwOnError: true });
  }

  async respondPermission(projectId: string, sessionId: string, permissionId: string, response: string) {
    const project = this.requiredSession(projectId, sessionId);
    return this.client(project.projectPath).postSessionIdPermissionsPermissionId({
      path: { id: sessionId, permissionID: permissionId }, body: { response }, throwOnError: true,
    });
  }

  subscribe(projectId: string, listener: (event: ClyraAgentEvent) => void) {
    const project = this.requiredProject(projectId);
    project.listeners.add(listener);
    for (const event of project.events) listener(event);
    return () => project.listeners.delete(listener);
  }

  inspect(projectId: string) {
    const project = this.requiredProject(projectId);
    return { projectId, projectPath: project.projectPath, sessions: [...project.sessions], events: project.events.slice(-200), serverUrl: this.runtime?.server.url, lastError: this.lastError };
  }

  async stop() {
    this.projects.clear();
    this.streamStarted = false;
    this.runtime?.server.close();
    this.runtime = null;
  }

  private client(directory: string) {
    if (!this.runtime) throw new Error("OpenCode runtime is not running.");
    return createOpencodeClient({ baseUrl: this.runtime.server.url, directory, responseStyle: "data", headers: this.authHeaders() });
  }

  private authHeaders(): Record<string, string> {
    const username = process.env.OPENCODE_SERVER_USERNAME || "opencode";
    const password = process.env.OPENCODE_SERVER_PASSWORD;
    if (!password) return {};
    const token = Buffer.from(`${username}:${password}`).toString("base64");
    return { Authorization: `Basic ${token}` };
  }

  private requiredProject(projectId: string) {
    const project = this.projects.get(projectId);
    if (!project) throw new Error("Unknown or inactive Clyra project.");
    return project;
  }

  private requiredSession(projectId: string, sessionId: string) {
    const project = this.requiredProject(projectId);
    if (!project.sessions.has(sessionId)) throw new Error("Session does not belong to this project.");
    return project;
  }

  private async startEventStream() {
    if (!this.runtime || this.streamStarted) return;
    this.streamStarted = true;
    const client = createOpencodeClient({ baseUrl: this.runtime.server.url, responseStyle: "data", headers: this.authHeaders() });
    try {
      const subscription = await client.event.subscribe({ throwOnError: true, sseMaxRetryAttempts: 8, sseMaxRetryDelay: 10_000 });
      void (async () => {
        for await (const raw of subscription.stream) {
          const event = raw as { directory?: string; payload?: Record<string, unknown> };
          const properties = event.payload?.properties as Record<string, unknown> | undefined;
          const part = properties?.part as Record<string, unknown> | undefined;
          const sessionId = String(properties?.sessionID || part?.sessionID || "");
          // Some OpenCode versions omit `directory` on global SSE events. The
          // session ID is still authoritative, so use it as a safe fallback
          // rather than silently dropping a real agent update.
          const project = [...this.projects.values()].find((value) =>
            value.projectPath === event.directory || (!!sessionId && value.sessions.has(sessionId)),
          );
          if (project && event.payload) this.publish(project, event.payload);
        }
      })().catch((error) => { this.lastError = error instanceof Error ? error.message : String(error); this.streamStarted = false; });
    } catch (error) {
      this.streamStarted = false;
      this.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  private publish(project: ProjectRuntime, payload: Record<string, unknown>) {
    const properties = (payload.properties && typeof payload.properties === "object" ? payload.properties : {}) as Record<string, unknown>;
    const part = (properties.part && typeof properties.part === "object" ? properties.part : {}) as Record<string, unknown>;
    const sessionId = String(properties.sessionID || part.sessionID || "") || undefined;
    const messageId = String(part.messageID || "") || undefined;
    const partId = String(part.id || "") || undefined;
    const identity = partId ? `${String(payload.type)}:${sessionId ?? ""}:${messageId ?? ""}:${partId}` : "";
    const fingerprint = identity ? JSON.stringify(part.state ?? part.text ?? payload.properties ?? {}) : "";
    if (identity && project.partStates.get(identity) === fingerprint) return;
    if (identity) project.partStates.set(identity, fingerprint);
    const event: ClyraAgentEvent = {
      id: `${project.projectId}:${sessionId ?? "runtime"}:${messageId ?? ""}:${partId ?? payload.type}:${++this.sequence}`,
      projectId: project.projectId, sessionId, messageId, partId, sequence: this.sequence, timestamp: Date.now(), type: String(payload.type || "unknown"), payload,
    };
    project.events.push(event);
    if (project.events.length > 500) project.events.splice(0, project.events.length - 500);
    for (const listener of project.listeners) listener(event);
  }

  private findFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const socket = net.createServer();
      socket.unref();
      socket.once("error", reject);
      socket.listen(0, "127.0.0.1", () => {
        const address = socket.address();
        socket.close(() => typeof address === "object" && address ? resolve(address.port) : reject(new Error("Could not allocate an OpenCode port.")));
      });
    });
  }

  private async reconcileSession(project: ProjectRuntime, sessionId: string, attempt: number): Promise<void> {
    try {
      const messages = await this.client(project.projectPath).session.messages({ path: { id: sessionId }, throwOnError: true });
      for (const message of messages) {
        for (const part of message.parts ?? []) this.publish(project, { type: "message.part.updated", properties: { part } });
        const error = (message.info as { error?: { data?: { message?: unknown }; message?: unknown } }).error;
        if (error) {
          const raw = String(error.data?.message || error.message || "OpenCode session failed.");
          const messageText = raw.replace(/(?:sk|rk|pk|key)[-_][A-Za-z0-9_-]{8,}/gi, "[redacted credential]").slice(0, 1_500);
          this.publish(project, { type: "session.error", properties: { sessionID: sessionId, error: { message: messageText } } });
        }
      }
      const fingerprint = JSON.stringify(messages.map((message) => ({
        id: message.info?.id,
        parts: (message.parts ?? []).map((part) => ({ id: part.id, state: (part as { state?: unknown }).state, text: (part as { text?: unknown }).text })),
      })));
      const previous = project.reconciliation.get(sessionId);
      const statuses = await this.client(project.projectPath).session.status({ throwOnError: true });
      const status = statuses[sessionId];
      const now = Date.now();
      const changed = previous?.fingerprint !== fingerprint;
      // Some free / remote models leave session status stuck on "busy" after the
      // final assistant text lands. Treat a long-stable fingerprint as idle so
      // Thinking collapses and the live preview can refresh.
      const idleSince = !changed ? (previous?.idleSince ?? now) : undefined;
      project.reconciliation.set(sessionId, { fingerprint, idleSince, emptyRetries: previous?.emptyRetries ?? 0 });

      // The server can briefly report idle in between tool-call turns. Keep
      // reconciling through that transition and only complete after a stable
      // quiet window; this is what prevents the UI from stopping after the
      // first tool action of a multi-step DeepSeek task.
      const quietMs = status?.type === "idle" ? 5_000 : 12_000;
      if ((idleSince && now - idleSince >= quietMs) || attempt >= 600) {
        // Detect silent provider failures: assistant turn exists but produced
        // no text and no tool parts (classic OpenCode free-model 401 path).
        const assistant = [...messages].reverse().find((message) => message.info?.role === "assistant");
        const parts = assistant?.parts ?? [];
        const hasText = parts.some((part) => part.type === "text" && String((part as { text?: string }).text || "").trim());
        const hasTool = parts.some((part) => part.type === "tool" || Boolean(part.tool));
        const hasErrorPart = parts.some((part) => part.type === "error" || (part.state as { status?: string } | undefined)?.status === "error");
        if (assistant && !hasText && !hasTool && !hasErrorPart) {
          // Deep tool-use runs can occasionally end with a blank continuation
          // from the model even though OpenCode has already completed real
          // reads/commands. Resume that *same* session before declaring the
          // provider unhealthy. This is intentionally bounded and is not a
          // fabricated activity state: it is a normal OpenCode prompt sent to
          // the configured server-side model, with its ensuing events streamed
          // back through the existing transcript.
          const didMeaningfulWork = messages.some((message) =>
            message.info?.role === "assistant" &&
            (message.parts ?? []).some((part) =>
              part.type === "tool" ||
              (part.type === "reasoning" && String((part as { text?: unknown }).text ?? "").trim().length > 0),
            ),
          );
          const emptyRetries = previous?.emptyRetries ?? 0;
          if (didMeaningfulWork && emptyRetries < 2) {
            project.reconciliation.set(sessionId, {
              fingerprint: "",
              emptyRetries: emptyRetries + 1,
            });
            this.publish(project, { type: "session.status", properties: { sessionID: sessionId, status: { type: "busy" } } });
            try {
              await this.client(project.projectPath).session.promptAsync({
                path: { id: sessionId },
                body: {
                  model: resolveRecoveryModel(),
                  parts: [{
                    type: "text",
                    text: "Continue the current task from the work already completed. Your previous turn ended without a final response. Complete any remaining implementation and validation, then provide a concise final result.",
                  }],
                },
                throwOnError: true,
              });
              setTimeout(() => void this.reconcileSession(project, sessionId, 0), 900).unref();
              return;
            } catch (retryError) {
              this.lastError = retryError instanceof Error ? retryError.message : String(retryError);
            }
          }
          const authHint = this.readRecentProviderAuthError();
          const message = authHint
            || "The configured coding model stopped before completing its final response. Completed work is preserved; retry to continue the same task.";
          this.lastError = message;
          this.publish(project, { type: "session.error", properties: { sessionID: sessionId, error: { message } } });
          project.reconciliation.delete(sessionId);
          return;
        }
        this.publish(project, { type: "session.idle", properties: { sessionID: sessionId } });
        project.reconciliation.delete(sessionId);
        return;
      }
      setTimeout(() => void this.reconcileSession(project, sessionId, attempt + 1), 900).unref();
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
    }
  }

  /** Best-effort parse of OpenCode's local log for the latest provider 401. */
  private readRecentProviderAuthError(): string | null {
    try {
      const logPath = path.join(
        process.platform === "win32"
          ? path.join(os.homedir(), "AppData", "Local", "opencode", "log")
          : path.join(os.homedir(), ".local", "share", "opencode", "log"),
        "opencode.log",
      );
      if (!fs.existsSync(logPath)) return null;
      const text = fs.readFileSync(logPath, "utf8");
      const lines = text.trim().split("\n").slice(-80);
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const line = lines[i];
        if (/\[401\]|Unauthorized|Provider returned error|AI_APICallError/i.test(line)) {
          return "Clyra's configured coding provider rejected the request (401). Check the server-side provider configuration, then retry.";
        }
      }
    } catch {
      /* ignore log parse issues */
    }
    return null;
  }
}

export const openCodeRuntimeManager = new OpenCodeRuntimeManager();
