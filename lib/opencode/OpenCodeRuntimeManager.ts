import { createOpencode, createOpencodeClient } from "@opencode-ai/sdk";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import os from "node:os";

const DEFAULT_AGENTS_MD = `# Clyra Code Agent

You are Clyra's autonomous software engineer. Complete the user's actual objective in this repository; decide the next highest-value action from repository evidence rather than following a fixed workflow. Scale work to the task: a small change may need inspect → edit → verify, while a feature or refactor may need repeated exploration, planning, implementation, recovery and review.

For medium, large, investigative, debugging, refactor and greenfield work, use the real todo/task-list tool to track meaningful engineering goals (not every tool call). Keep normally one primary todo active; reopen or revise todos when new evidence or a failed check proves an assumption wrong. Treat PLAN.md as durable task memory when it exists: read relevant sections at major transitions, revise it when the plan changes materially, and do not finish until its success criteria have evidence.

Read before changing unfamiliar code. Use progressively narrower retrieval instead of dumping the repository into context. After significant observations, decide whether an edit is justified, what its blast radius is, and the cheapest meaningful verification. Test/build/typecheck failures are observations to investigate and repair, not reasons to stop. Before declaring completion, inspect the changed files and working diff, verify the requested outcome, and avoid unrelated edits.

Execution discipline for a new product: inspect only the project root/configuration and the directly relevant source files, then start writing the implementation. Do not probe the host filesystem, shell configuration, user directories, environment variables, provider settings, or installed tools beyond one focused capability check. For a multi-file greenfield app, make the first implementation edit within the first three tool calls after orientation; continue with focused edits rather than repeatedly rediscovering the repository. A starter scaffold is only a baseline—change it to satisfy the specific request before finishing.

Between meaningful phases, provide one concise user-facing progress update about what was actually learned or completed and what comes next. Never expose private chain-of-thought, invent actions, files, results, test passes, or progress.

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
  reconciliation: Map<string, { fingerprint: string; idleSince?: number; emptyRetries?: number; completionRetries?: number }>;
};

type TaskComplexity = "trivial" | "small" | "medium" | "large" | "investigative" | "debugging" | "refactor" | "greenfield";

type TaskLedger = {
  taskId: string;
  objective: string;
  complexity: TaskComplexity;
  status: "executing" | "completed" | "failed" | "cancelled";
  planPath?: string;
  todos: Array<{ id: string; title: string; status: "pending" | "in_progress" | "completed" }>;
  modifiedFiles: string[];
  verification: { passed: string[]; failed: string[] };
  createdAt: number;
  updatedAt: number;
};

function classifyTask(text: string): TaskComplexity {
  const value = text.toLowerCase();
  if (/\b(debug|diagnose|investigate|why .*fail|not working|broken)\b/.test(value)) return "debugging";
  if (/\b(refactor|migrate|rewrite|architecture)\b/.test(value)) return "refactor";
  if (/\b(build|create|make)\b/.test(value) && /\b(app|feature|website|system|dashboard)\b/.test(value)) return "greenfield";
  if (/\b(multi|complex|advanced|full|complete|integrat|across)\b/.test(value) || text.length > 420) return "large";
  if (/\b(add|implement|improve|support|update)\b/.test(value)) return "medium";
  if (text.length < 70) return "trivial";
  return "small";
}

function defaultTodos(objective: string, complexity: TaskComplexity): TaskLedger["todos"] {
  if (complexity === "trivial" || complexity === "small") return [];
  return [
    { id: "orient", title: "Understand the relevant repository implementation", status: "in_progress" },
    { id: "implement", title: `Implement: ${objective.slice(0, 90)}`, status: "pending" },
    { id: "verify", title: "Verify the requested outcome", status: "pending" },
  ];
}

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

  /**
   * Keep a small, durable execution checkpoint outside the conversation. This
   * is deliberately support state for OpenCode—not a second scheduler. The
   * model still selects tools and adapts the plan itself through AGENTS.md.
   */
  private async beginTaskLedger(projectPath: string, sessionId: string, objective: string) {
    const complexity = classifyTask(objective);
    const agentRoot = path.join(projectPath, ".clyra", "agent", "sessions");
    await fs.promises.mkdir(agentRoot, { recursive: true });
    const gitignorePath = path.join(projectPath, ".gitignore");
    const gitignore = await fs.promises.readFile(gitignorePath, "utf8").catch(() => "");
    if (!gitignore.split(/\r?\n/).includes(".clyra/agent/")) {
      await fs.promises.writeFile(gitignorePath, `${gitignore.replace(/\s*$/, "")}\n.clyra/agent/\n`, "utf8");
    }
    const planPath = path.join(projectPath, "PLAN.md");
    const needsPlan = ["medium", "large", "investigative", "debugging", "refactor", "greenfield"].includes(complexity);
    if (needsPlan) {
      const exists = await fs.promises.stat(planPath).then(() => true).catch(() => false);
      if (!exists) {
        await fs.promises.writeFile(planPath, `# Task\n\n${objective}\n\n# Success Criteria\n\n- Implement the requested outcome without unrelated changes.\n- Verify it using the strongest practical check.\n\n# Repository Findings\n\n- Pending orientation.\n\n# Implementation Plan\n\n## 1. Understand the relevant implementation\nStatus: in progress\n\n## 2. Implement the requested change\nStatus: pending\n\n## 3. Verify and review the result\nStatus: pending\n\n# Decisions\n\n- Pending repository evidence.\n\n# Discoveries\n\n- Pending orientation.\n\n# Verification\n\n- [ ] Select focused checks from the repository.\n\n# Completion\n\n- Pending verification.\n`, "utf8");
      }
    }
    const now = Date.now();
    const ledger: TaskLedger = {
      taskId: sessionId,
      objective,
      complexity,
      status: "executing",
      planPath: needsPlan ? "PLAN.md" : undefined,
      todos: defaultTodos(objective, complexity),
      modifiedFiles: [],
      verification: { passed: [], failed: [] },
      createdAt: now,
      updatedAt: now,
    };
    await fs.promises.writeFile(path.join(agentRoot, `${sessionId}.json`), JSON.stringify(ledger, null, 2), "utf8");
  }

  private async checkpointTaskLedger(project: ProjectRuntime, sessionId: string, status: TaskLedger["status"]) {
    const ledgerPath = path.join(project.projectPath, ".clyra", "agent", "sessions", `${sessionId}.json`);
    try {
      const ledger = JSON.parse(await fs.promises.readFile(ledgerPath, "utf8")) as TaskLedger;
      const diff = await this.client(project.projectPath).session.diff({ path: { id: sessionId }, throwOnError: true }).catch(() => []);
      const messages = await this.client(project.projectPath).session.messages({ path: { id: sessionId }, throwOnError: true }).catch(() => []);
      const failures = messages.flatMap((message) => message.parts ?? []).filter((part) => (part as { state?: { status?: string } }).state?.status === "error").map((part) => String((part as { state?: { error?: unknown } }).state?.error || "Tool failed"));
      ledger.status = status;
      const sessionFiles = (diff as Array<{ file?: string }>).map((entry) => entry.file).filter((file): file is string => Boolean(file));
      // Some OpenCode providers stream real write parts but do not populate
      // session.diff until a later compaction. Preserve the actual project
      // evidence instead of reporting an empty changed-files ledger.
      ledger.modifiedFiles = [...new Set([...sessionFiles, ...await this.filesTouchedSince(project.projectPath, ledger.createdAt)])];
      ledger.verification.failed = failures.slice(-8);
      if (status === "completed") {
        ledger.todos = ledger.todos.map((todo) => ({ ...todo, status: "completed" }));
        if (ledger.planPath) {
          await fs.promises.appendFile(path.join(project.projectPath, ledger.planPath), `\n# Completion\n\nCompleted by OpenCode after the available task checks. Review the action stream and changed files for exact evidence.\n`, "utf8").catch(() => undefined);
        }
      }
      ledger.updatedAt = Date.now();
      await fs.promises.writeFile(ledgerPath, JSON.stringify(ledger, null, 2), "utf8");
    } catch {
      // Checkpoints must never block a real OpenCode run.
    }
  }

  /**
   * Best-effort fallback for providers whose session.diff lags behind their
   * streamed write events. This runs only at task checkpoints/completion, not
   * while the user is typing or an action stream is rendering.
   */
  private async filesTouchedSince(projectPath: string, since: number): Promise<string[]> {
    const ignored = new Set([".git", ".agent", ".clyra", "node_modules", "dist", "build", ".next"]);
    const touched: string[] = [];
    const visit = async (directory: string): Promise<void> => {
      const entries = await fs.promises.readdir(directory, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (entry.isDirectory() && ignored.has(entry.name)) continue;
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          await visit(absolute);
          continue;
        }
        if (!entry.isFile()) continue;
        const stat = await fs.promises.stat(absolute).catch(() => undefined);
        // A tiny clock skew allowance keeps files written immediately after a
        // task starts from being missed on filesystems with coarse timestamps.
        if (stat && Math.max(stat.mtimeMs, stat.birthtimeMs) >= since - 2_000) {
          touched.push(path.relative(projectPath, absolute));
        }
      }
    };
    await visit(projectPath);
    return touched;
  }

  /**
   * A model saying "done" is not enough evidence for a greenfield app. This
   * guard only applies to substantial build requests and uses real session
   * diffs/tool history to request another turn in the same OpenCode session.
   * It never fabricates work or rewrites the model's result.
   */
  private async completionGap(project: ProjectRuntime, sessionId: string, messages: Array<{ parts?: Array<unknown> }>) {
    const ledgerPath = path.join(project.projectPath, ".clyra", "agent", "sessions", `${sessionId}.json`);
    const ledger = await fs.promises.readFile(ledgerPath, "utf8")
      .then((value) => JSON.parse(value) as TaskLedger)
      .catch(() => undefined);
    if (!ledger || !["greenfield", "large"].includes(ledger.complexity)) return undefined;

    const diff = await this.client(project.projectPath).session.diff({ path: { id: sessionId }, throwOnError: true }).catch(() => []);
    const sessionFiles = (diff as Array<{ file?: string }>).map((entry) => entry.file).filter((file): file is string => Boolean(file));
    // Use the OpenCode diff whenever it is present, but fall back to files
    // truly touched after this task began if a provider has not materialised
    // its diff snapshot yet. The fallback is evidence-based, not a guessed
    // action count, so it cannot turn a no-op into a completed feature.
    const files = [...new Set([...sessionFiles, ...await this.filesTouchedSince(project.projectPath, ledger.createdAt)])];
    const implementationFiles = files.filter((file) => !/(^|\/)(PLAN\.md|AGENTS\.md|\.gitignore|package-lock\.json)$/i.test(file));
    const toolText = JSON.stringify(messages.map((message) => message.parts ?? []));
    const hasValidation = /(?:npm\s+run\s+(?:build|test|typecheck|lint)|\b(?:typecheck|vitest|jest|eslint|swiftc|swift\s+build|xcodebuild)\b)/i.test(toolText);
    const isSwiftTask = /\b(?:swift|swiftui|ios|iphone)\b/i.test(ledger.objective);
    const minimumFiles = isSwiftTask ? 2 : 3;
    if (implementationFiles.length < minimumFiles) {
      return `only ${implementationFiles.length} implementation file${implementationFiles.length === 1 ? "" : "s"} changed (need a real multi-file implementation)`;
    }
    if (!hasValidation) return "no real build, typecheck, test, or Swift validation command ran";
    return undefined;
  }

  private async requestCompletionRecovery(project: ProjectRuntime, sessionId: string, reason: string) {
    this.publish(project, { type: "session.status", properties: { sessionID: sessionId, status: { type: "busy" } } });
    await this.client(project.projectPath).session.promptAsync({
      path: { id: sessionId },
      body: {
        model: resolveRecoveryModel(),
        parts: [{
          type: "text",
          text: `Do not complete this task yet: ${reason}. Continue the same task now. Implement the remaining product across the appropriate real files, make the visible interactions work, run a relevant validation command, inspect the preview where available, and repair any failure. Do not only describe a plan or change configuration.`,
        }],
      },
      throwOnError: true,
    });
  }

  async prompt(projectId: string, sessionId: string, text: string, agent?: string, model?: { providerID: string; modelID: string }) {
    const project = this.requiredSession(projectId, sessionId);
    // The model always comes from Clyra's server-side provider configuration.
    const selectedModel = model ?? resolveCodingModel();
    // Adaptive behaviour is guided via AGENTS.md (OpenCode reads it), not by
    // injecting preface text into the user turn (which models may echo).
    await this.ensureAgentsGuide(project.projectPath);
    await this.beginTaskLedger(project.projectPath, sessionId, text);
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
      const isPortableIosGuide = /Cross-platform SwiftUI Source Mode|swiftui-design-skill\/SKILL\.md/.test(existing);
      if (/Be an adaptive expert coding agent\.|Clyra Code Agent/.test(existing)
        && !/PLAN\.md as durable task memory/.test(existing)
        && !isPortableIosGuide) {
        await fs.promises.writeFile(agentsPath, DEFAULT_AGENTS_MD, "utf8").catch(() => undefined);
      }
    } catch {
      await fs.promises.writeFile(agentsPath, DEFAULT_AGENTS_MD, "utf8").catch(() => undefined);
    }
  }

  async abort(projectId: string, sessionId: string) {
    const project = this.requiredSession(projectId, sessionId);
    const result = await this.client(project.projectPath).session.abort({ path: { id: sessionId }, throwOnError: true });
    await this.checkpointTaskLedger(project, sessionId, "cancelled");
    return result;
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
      project.reconciliation.set(sessionId, { fingerprint, idleSince, emptyRetries: previous?.emptyRetries ?? 0, completionRetries: previous?.completionRetries ?? 0 });

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
          // A generated Swift starter is only a baseline, never evidence that
          // the user's requested product is complete. Continue the same
          // OpenCode session through its bounded recovery path instead of
          // presenting an early, generic iOS scaffold as a finished app.
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
          // Complex multi-file projects can legitimately need several bounded
          // continuations when a provider ends a tool-heavy turn blank. Keep
          // the same session/checkpoint alive, but narrow later recoveries so
          // they converge on a working, validated result instead of replaying
          // discovery or surfacing a premature failure to the user.
          if (didMeaningfulWork && emptyRetries < 5) {
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
                    text: "Continue this exact task from the persisted project state. Do not repeat discovery or narrate a plan. Inspect the current files, complete the smallest remaining implementation, run the relevant validation and preview check, repair real failures, then give a concise final result.",
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
          await this.checkpointTaskLedger(project, sessionId, "failed");
          this.publish(project, { type: "session.error", properties: { sessionID: sessionId, error: { message } } });
          project.reconciliation.delete(sessionId);
          return;
        }
        const gap = await this.completionGap(project, sessionId, messages);
        const completionRetries = previous?.completionRetries ?? 0;
        if (gap && completionRetries < 3) {
          project.reconciliation.set(sessionId, { fingerprint: "", completionRetries: completionRetries + 1, emptyRetries: previous?.emptyRetries ?? 0 });
          try {
            await this.requestCompletionRecovery(project, sessionId, gap);
            setTimeout(() => void this.reconcileSession(project, sessionId, 0), 900).unref();
            return;
          } catch (retryError) {
            this.lastError = retryError instanceof Error ? retryError.message : String(retryError);
          }
        }
        if (gap) {
          const message = `The coding agent stopped before the requested product was complete: ${gap}. Completed work is preserved; retry to continue the same task.`;
          this.lastError = message;
          await this.checkpointTaskLedger(project, sessionId, "failed");
          this.publish(project, { type: "session.error", properties: { sessionID: sessionId, error: { message } } });
          project.reconciliation.delete(sessionId);
          return;
        }
        await this.checkpointTaskLedger(project, sessionId, "completed");
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
