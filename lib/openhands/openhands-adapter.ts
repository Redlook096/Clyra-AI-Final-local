import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import WebSocket from "ws";
import { ConversationClient } from "@openhands/typescript-client/clients";
import type { VibeCoderEvent } from "../cline/cline-events";
import { startDevServer } from "../vibe-coder/preview/preview-runner";
import { ensureOpenHandsAgentServer } from "./openhands-process";
import { buildOpenHandsConversationPayload } from "./openhands-payload";
import { OpenHandsEventMapper } from "./openhands-events";
import {
  DEEP_BUILD_CONTINUE_MESSAGE,
  MAX_AUTO_CONTINUE_PER_RUN,
  isBuildLikeUserMessage,
} from "./deep-build-harness";

export interface OpenHandsTaskOptions {
  projectId: string;
  prompt: string;
  planMode: boolean;
  workspacePath: string;
  provider?: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
}

export class OpenHandsAdapter extends EventEmitter {
  private client?: ConversationClient;
  private ws?: WebSocket;
  private conversationId?: string;
  private mapper?: OpenHandsEventMapper;
  private paused = false;
  private cancelled = false;
  private waitingForPlanApproval = false;
  private options?: OpenHandsTaskOptions;
  private fileEditCount = 0;
  private terminalCount = 0;
  private previewSeen = false;
  private autoContinues = 0;
  private completedEmitted = false;
  private previewStarted = false;
  private planApprovalWatchdog?: NodeJS.Timeout;

  public async startOpenHandsTask(options: OpenHandsTaskOptions) {
    this.options = options;
    this.cancelled = false;
    this.paused = false;
    this.waitingForPlanApproval = false;
    this.fileEditCount = 0;
    this.terminalCount = 0;
    this.previewSeen = false;
    this.autoContinues = 0;
    this.completedEmitted = false;
    this.previewStarted = false;

    this.emitEvent({
      type: "stage",
      stage: "task-created",
      message: "Starting OpenHands coding agent…",
    });

    const server = await ensureOpenHandsAgentServer();
    this.client = new ConversationClient({
      host: server.host,
      apiKey: server.apiKey,
    });

    await fs.mkdir(options.workspacePath, { recursive: true });
    const projectRoot = path.resolve(options.workspacePath, "..");
    const createdAt = new Date().toISOString();
    await fs.writeFile(
      path.join(projectRoot, "metadata.json"),
      `${JSON.stringify(
        {
          id: options.projectId,
          name: options.prompt.slice(0, 70) || "Vibe project",
          prompt: options.prompt,
          mode: options.planMode ? "plan" : "fast",
          status: "Building",
          createdAt,
          updatedAt: createdAt,
          harness: "openhands-agent-server",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const model =
      options.model ||
      process.env.MY_LLM_MODEL ||
      (process.env.DEEPSEEK_API_KEY ? "deepseek-chat" : "gpt-4.1-mini");
    const apiKey =
      options.apiKey ||
      process.env.MY_LLM_API_KEY ||
      process.env.DEEPSEEK_API_KEY ||
      process.env.OPENAI_API_KEY ||
      process.env.ANTHROPIC_API_KEY;
    const baseUrl =
      options.baseUrl ||
      process.env.MY_LLM_BASE_URL ||
      (process.env.DEEPSEEK_API_KEY ? "https://api.deepseek.com" : undefined);

    const payload = buildOpenHandsConversationPayload({
      prompt: options.prompt,
      workspacePath: options.workspacePath,
      planMode: options.planMode,
      model,
      apiKey,
      baseUrl,
    });

    this.mapper = new OpenHandsEventMapper({ planMode: options.planMode });
    const conversation = await this.client.createConversation<{ id: string }>(
      payload,
    );
    this.conversationId = conversation.id;
    this.connectWebSocket(
      server.host,
      server.apiKey,
      conversation.id,
      options.planMode,
    );

    this.emitEvent({
      type: "status_update",
      message: "OpenHands agent loop connected.",
    });
  }

  private connectWebSocket(
    host: string,
    apiKey: string,
    conversationId: string,
    planMode: boolean,
  ) {
    const url = new URL(host);
    const wsScheme = url.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = new URL(
      `${wsScheme}//${url.host}${url.pathname.replace(/\/$/, "")}/sockets/events/${conversationId}`,
    );
    if (apiKey) wsUrl.searchParams.set("session_api_key", apiKey);

    this.ws = new WebSocket(wsUrl.toString());
    this.ws.on("message", (data) => {
      if (this.cancelled) return;
      try {
        const raw = JSON.parse(String(data));
        this.trackEvidence(raw);
        const mapped = this.mapper?.map(raw) || [];
        for (const vibeEvent of mapped) {
          if (
            vibeEvent.type === "plan_completed" &&
            planMode &&
            !this.waitingForPlanApproval
          ) {
            this.waitingForPlanApproval = true;
            this.mapper?.setWaitingForPlanApproval(true);
            void this.pause();
            this.armPlanApprovalWatchdog();
          }
          if (vibeEvent.type === "complete") {
            void this.handlePossibleFinish(vibeEvent);
            continue;
          }
          if (
            (vibeEvent.type === "file_completed" &&
              /\.(html?|htm)$/i.test(vibeEvent.path)) ||
            (vibeEvent.type === "preview_starting" && !this.previewStarted)
          ) {
            void this.ensureClyraPreview();
          }
          this.emitEvent(vibeEvent);
        }

        const status = String(
          (raw as { execution_status?: string }).execution_status || "",
        ).toLowerCase();
        if (
          (status === "finished" || status === "idle") &&
          !this.waitingForPlanApproval &&
          !this.completedEmitted
        ) {
          void this.handlePossibleFinish({
            type: "complete",
            summary: "Build finished.",
          });
        }
      } catch (error) {
        this.emitEvent({
          type: "error",
          message:
            error instanceof Error
              ? error.message
              : "Failed to parse OpenHands event",
          recoverable: true,
        });
      }
    });
    this.ws.on("error", (error) => {
      if (this.cancelled) return;
      this.emitEvent({
        type: "error",
        message: error.message || "OpenHands WebSocket error",
        recoverable: true,
      });
    });
  }

  private async ensureClyraPreview() {
    if (!this.options || this.previewStarted || this.cancelled) return;
    this.previewStarted = true;
    this.emitEvent({ type: "preview_starting" });
    try {
      const session = await startDevServer({
        projectId: this.options.projectId,
        projectPath: this.options.workspacePath,
        projectName: this.options.prompt.slice(0, 70) || "Vibe project",
      });
      if (session?.url) {
        this.previewSeen = true;
        this.emitEvent({ type: "preview_ready", url: session.url });
      } else {
        this.previewStarted = false;
        this.emitEvent({
          type: "status_update",
          message: `Preview not ready yet (${session?.status || "unknown"}).`,
        });
      }
    } catch (error) {
      this.previewStarted = false;
      this.emitEvent({
        type: "error",
        message:
          error instanceof Error
            ? `Preview failed: ${error.message}`
            : "Preview failed",
        recoverable: true,
      });
    }
  }

  private trackEvidence(raw: unknown) {
    const event = raw as Record<string, unknown>;
    const kind = String(event.kind || event.type || "").toLowerCase();
    const tool = String(
      event.tool_name ||
        (event.action as { tool_name?: string } | undefined)?.tool_name ||
        "",
    ).toLowerCase();
    const command = String(
      (event.action as { command?: string } | undefined)?.command || "",
    ).toLowerCase();

    if (kind.includes("action")) {
      if (tool.includes("file_editor") || tool.includes("str_replace")) {
        if (command !== "view") this.fileEditCount += 1;
      }
      if (tool.includes("terminal") || tool.includes("bash")) {
        this.terminalCount += 1;
      }
      if (tool.includes("canvas_ui") && command.includes("preview")) {
        this.previewSeen = true;
      }
    }
    if (kind.includes("observation") && tool.includes("terminal")) {
      this.terminalCount += 1;
    }
  }

  private isWeakFinish(): boolean {
    if (!this.options || !isBuildLikeUserMessage(this.options.prompt)) {
      return false;
    }
    return this.fileEditCount < 2 || (!this.previewSeen && this.terminalCount < 1);
  }

  private async handlePossibleFinish(event: VibeCoderEvent) {
    if (this.cancelled || this.completedEmitted || this.waitingForPlanApproval) {
      return;
    }
    if (
      this.isWeakFinish() &&
      this.autoContinues < MAX_AUTO_CONTINUE_PER_RUN &&
      this.client &&
      this.conversationId
    ) {
      this.autoContinues += 1;
      this.emitEvent({
        type: "status_update",
        message: `Deep-build guard: continuing (${this.autoContinues}/${MAX_AUTO_CONTINUE_PER_RUN})…`,
      });
      await this.client.sendEvent(
        this.conversationId,
        {
          role: "user",
          content: [{ type: "text", text: DEEP_BUILD_CONTINUE_MESSAGE }],
        },
        { run: true },
      );
      return;
    }

    this.completedEmitted = true;
    this.emitEvent(event);
  }

  public async pause() {
    if (!this.client || !this.conversationId || this.cancelled) return;
    this.paused = true;
    await this.client.interruptConversation(this.conversationId);
    this.emitEvent({
      type: "stage",
      stage: "paused",
      message: "Agent paused",
    });
  }

  public async resume() {
    if (!this.client || !this.conversationId || this.cancelled) return;
    this.paused = false;
    try {
      await this.client.runConversation(this.conversationId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Already running is fine — approve/sendEvent may have restarted it.
      if (!/409|already running/i.test(message)) throw error;
    }
    this.emitEvent({
      type: "stage",
      stage: "generating-file",
      message: "Agent resumed",
    });
  }

  // The Clyra workspace can run with its plan-review surface disabled, in
  // which case nothing will ever call approvePlan and the run would stall in
  // the approval pause forever. Self-approve after a bounded review window so
  // every task still runs to completion. Set CLYRA_PLAN_APPROVAL_TIMEOUT_MS=0
  // to disable when a real approval UI is guaranteed to be present.
  private armPlanApprovalWatchdog() {
    const timeoutMs = Number(process.env.CLYRA_PLAN_APPROVAL_TIMEOUT_MS ?? 120_000);
    if (!(timeoutMs > 0)) return;
    if (this.planApprovalWatchdog) clearTimeout(this.planApprovalWatchdog);
    this.planApprovalWatchdog = setTimeout(() => {
      if (!this.waitingForPlanApproval || this.cancelled) return;
      this.emitEvent({
        type: "status_update",
        message: "No plan review received — continuing with the generated plan.",
      });
      void this.approvePlan();
    }, timeoutMs);
    this.planApprovalWatchdog.unref?.();
  }

  public async approvePlan() {
    if (!this.client || !this.conversationId || !this.options) return;
    if (this.planApprovalWatchdog) {
      clearTimeout(this.planApprovalWatchdog);
      this.planApprovalWatchdog = undefined;
    }
    this.waitingForPlanApproval = false;
    this.mapper?.setWaitingForPlanApproval(false);
    this.paused = false;
    try {
      await this.client.sendEvent(
        this.conversationId,
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Plan approved. Implement PLAN.md fully now. Use tools as needed and call canvas_ui show_preview when ready.",
            },
          ],
        },
        { run: true },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/409|already running/i.test(message)) {
        // Conversation is already running after interrupt+resume races.
      } else {
        throw error;
      }
    }
    this.emitEvent({
      type: "mode_changed",
      mode: "code",
      label: "Build",
      message: "Plan approved — building…",
    });
  }

  public async cancel() {
    this.cancelled = true;
    if (this.planApprovalWatchdog) {
      clearTimeout(this.planApprovalWatchdog);
      this.planApprovalWatchdog = undefined;
    }
    try {
      if (this.client && this.conversationId) {
        await this.client.interruptConversation(this.conversationId);
      }
    } catch {
      // ignore
    }
    try {
      this.ws?.close();
    } catch {
      // ignore
    }
    this.emitEvent({
      type: "error",
      message: "Task cancelled by user.",
      recoverable: false,
    });
  }

  private emitEvent(event: VibeCoderEvent) {
    this.emit("event", event);
  }
}

export function startOpenHandsTask(
  options: OpenHandsTaskOptions,
  onEvent: (evt: VibeCoderEvent) => void,
) {
  const adapter = new OpenHandsAdapter();
  adapter.on("event", onEvent);
  void adapter.startOpenHandsTask(options).catch((error) => {
    onEvent({
      type: "error",
      message:
        error instanceof Error
          ? error.message
          : "Failed to start OpenHands agent.",
      recoverable: false,
    });
  });
  return adapter;
}
