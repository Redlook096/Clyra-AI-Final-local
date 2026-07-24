import type { VibeCoderEvent } from "../cline/cline-events";

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as JsonRecord;
}

function getKind(event: JsonRecord): string {
  return String(event.kind || event.type || "").toLowerCase();
}

function getToolName(event: JsonRecord): string {
  const action = asRecord(event.action) || asRecord(event.tool_call) || event;
  return String(
    event.tool_name ||
      action.tool_name ||
      action.name ||
      event.name ||
      "",
  ).toLowerCase();
}

function getActionCommand(event: JsonRecord): string {
  const action = asRecord(event.action) || event;
  return String(action.command || action.cmd || "").toLowerCase();
}

function getPath(event: JsonRecord): string {
  const action = asRecord(event.action) || event;
  return String(action.path || action.file_path || action.file || "").trim();
}

function getText(event: JsonRecord): string {
  const content = event.content ?? event.text ?? event.message;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        const rec = asRecord(part);
        if (!rec) return "";
        return String(rec.text || rec.content || "");
      })
      .filter(Boolean)
      .join("");
  }
  const delta = asRecord(event.delta);
  if (delta) {
    return String(delta.content || delta.reasoning_content || delta.text || "");
  }
  return "";
}

function languageFromPath(filePath: string) {
  const ext = filePath.split(".").pop()?.toLowerCase() || "";
  if (ext === "ts" || ext === "tsx") return "typescript";
  if (ext === "js" || ext === "jsx") return "javascript";
  if (ext === "py") return "python";
  if (ext === "css") return "css";
  if (ext === "html") return "html";
  if (ext === "md") return "markdown";
  if (ext === "json") return "json";
  return "text";
}

export class OpenHandsEventMapper {
  private activeTerminal: string | null = null;
  private activeFile: string | null = null;
  private planBuffer = "";
  private summaryBuffer = "";
  private waitingForPlanApproval = false;

  constructor(private options: { planMode: boolean; previewBaseUrl?: string }) {}

  setWaitingForPlanApproval(value: boolean) {
    this.waitingForPlanApproval = value;
  }

  map(raw: unknown): VibeCoderEvent[] {
    const event = asRecord(raw);
    if (!event) return [];
    const kind = getKind(event);
    const out: VibeCoderEvent[] = [];
    const ts = Date.now();

    if (kind.includes("pause") || event.execution_status === "paused") {
      out.push({
        type: "stage",
        stage: "paused",
        message: "Agent paused",
        timestamp: ts,
      });
      return out;
    }

    if (
      event.execution_status === "running" &&
      String(event.source || "").toLowerCase() === "user"
    ) {
      out.push({
        type: "stage",
        stage: "generating-file",
        message: "Agent resumed",
        timestamp: ts,
      });
      return out;
    }

    if (kind.includes("stream") || kind.includes("delta")) {
      const reasoning = String(
        asRecord(event.delta)?.reasoning_content ||
          event.reasoning_content ||
          "",
      );
      const content = getText(event);
      if (reasoning.trim()) {
        out.push({ type: "thinking", text: reasoning, timestamp: ts });
      } else if (content.trim()) {
        this.summaryBuffer += content;
        out.push({ type: "thinking", text: content, timestamp: ts });
      }
      return out;
    }

    if (kind.includes("message") || kind.includes("assistant")) {
      const text = getText(event).trim();
      if (text) {
        this.summaryBuffer = text;
        out.push({ type: "thinking", text, timestamp: ts });
      }
      return out;
    }

    if (kind.includes("action")) {
      const tool = getToolName(event);
      const command = getActionCommand(event);
      const filePath = getPath(event);

      if (tool.includes("research") || tool.includes("theme") || tool.includes("image") || tool.includes("icon")) {
        out.push({
          type: "stage",
          stage: "researching-web",
          message: `Using ${tool || "research"}…`,
          timestamp: ts,
        });
        out.push({
          type: "status_update",
          message: `Research tool: ${tool}`,
          timestamp: ts,
        });
        return out;
      }

      if (
        tool.includes("browser") ||
        kind.includes("browser") ||
        /navigate|click|type|scroll|screenshot|goto/.test(command) &&
          (tool.includes("browser") || String(event.action || "").toLowerCase().includes("browser"))
      ) {
        out.push({
          type: "status_update",
          message: `Browser: ${command || tool || "action"}`,
          timestamp: ts,
        });
        return out;
      }

      // OpenHands browser_tool_set emits action kinds like ClickElement / NavigateToUrl
      if (
        /click|navigate|screenshot|scroll|type|browser/.test(kind) ||
        /ClickElement|NavigateToUrl|Screenshot|BrowserState|TypeText/.test(
          String(event.kind || event.type || ""),
        )
      ) {
        out.push({
          type: "status_update",
          message: `Browser QA: ${String(event.kind || event.type || "action")}`,
          timestamp: ts,
        });
        return out;
      }

      if (tool.includes("codebase_search") || command === "view" || tool.includes("glob") || tool.includes("grep")) {
        out.push({
          type: "stage",
          stage: filePath ? "reviewing-file" : "inspecting-existing-project",
          message: filePath ? `Reviewing ${filePath}` : "Inspecting project…",
          timestamp: ts,
        });
        return out;
      }

      if (tool.includes("task_tracker")) {
        out.push({
          type: "status_update",
          message: "Updating task list…",
          timestamp: ts,
        });
        return out;
      }

      if (tool.includes("canvas_ui")) {
        const action = asRecord(event.action) || event;
        const uiCommand = String(action.command || "");
        if (uiCommand === "show_preview") {
          out.push({ type: "preview_starting", timestamp: ts });
          const previewPath = String(action.path || "index.html");
          out.push({
            type: "preview_ready",
            url:
              this.options.previewBaseUrl ||
              `/api/vibe/preview-proxy?path=${encodeURIComponent(previewPath)}`,
            timestamp: ts,
          });
        } else if (uiCommand === "navigate_to_file" && filePath) {
          out.push({
            type: "status_update",
            message: `Opened ${filePath}`,
            timestamp: ts,
          });
        }
        return out;
      }

      if (tool.includes("terminal") || tool.includes("bash") || command.startsWith("npm") || command.startsWith("pnpm") || command.startsWith("yarn") || command.startsWith("bun")) {
        const shellCommand =
          String(asRecord(event.action)?.command || event.command || "shell");
        this.activeTerminal = shellCommand;
        out.push({
          type: "terminal_started",
          command: shellCommand,
          timestamp: ts,
        });
        return out;
      }

      if (tool.includes("file_editor") || tool.includes("str_replace") || tool.includes("editor")) {
        if (command === "view") {
          out.push({
            type: "stage",
            stage: "reviewing-file",
            message: filePath ? `Reading ${filePath}` : "Reading file…",
            timestamp: ts,
          });
          return out;
        }

        const target = filePath || "file";
        this.activeFile = target;
        const isPlan = /(^|\/)PLAN\.md$/i.test(target);
        if (isPlan) {
          out.push({ type: "plan_started", timestamp: ts });
          out.push({
            type: "mode_changed",
            mode: "plan",
            label: "Plan",
            message: "Writing PLAN.md",
            timestamp: ts,
          });
        } else {
          out.push({
            type: "file_started",
            path: target,
            language: languageFromPath(target),
            action: command === "create" ? "create" : "edit",
            timestamp: ts,
          });
        }

        const action = asRecord(event.action) || {};
        const draft = String(
          action.file_text || action.new_str || action.content || "",
        );
        if (draft) {
          if (isPlan) {
            this.planBuffer = draft;
            out.push({ type: "plan_delta", delta: draft, timestamp: ts });
          } else {
            out.push({
              type: "file_delta",
              path: target,
              delta: draft,
              timestamp: ts,
            });
          }
        }
        return out;
      }

      if (tool.includes("finish") || kind.includes("finish")) {
        if (this.waitingForPlanApproval) return out;
        out.push({
          type: "complete",
          summary: this.summaryBuffer.trim() || "Build complete.",
          timestamp: ts,
        });
        return out;
      }
    }

    if (kind.includes("observation")) {
      const tool = getToolName(event);
      const content = getText(event);
      const filePath = getPath(event) || this.activeFile;

      if (tool.includes("terminal") || this.activeTerminal) {
        const command = this.activeTerminal || "shell";
        if (content) {
          out.push({
            type: "terminal_output",
            command,
            output: content,
            timestamp: ts,
          });
        }
        const exitCode = Number(
          asRecord(event.observation)?.exit_code ??
            event.exit_code ??
            0,
        );
        out.push({
          type: "terminal_completed",
          command,
          exitCode: Number.isFinite(exitCode) ? exitCode : 0,
          timestamp: ts,
        });
        this.activeTerminal = null;
        return out;
      }

      if (filePath) {
        const isPlan = /(^|\/)PLAN\.md$/i.test(filePath);
        const body = content || this.planBuffer;
        if (isPlan) {
          this.planBuffer = body || this.planBuffer;
          out.push({
            type: "plan_completed",
            path: "PLAN.md",
            content: this.planBuffer || body,
            timestamp: ts,
          });
          if (this.options.planMode) {
            this.waitingForPlanApproval = true;
            out.push({
              type: "status_update",
              message: "Plan ready — approve to continue building.",
              timestamp: ts,
            });
          }
        } else {
          out.push({
            type: "file_completed",
            path: filePath,
            content: body,
            timestamp: ts,
          });
        }
        this.activeFile = null;
        return out;
      }
    }

    if (kind.includes("error") || event.error) {
      out.push({
        type: "error",
        message: getText(event) || String(event.error || "Agent error"),
        recoverable: false,
        timestamp: ts,
      });
      return out;
    }

    if (
      event.execution_status === "finished" ||
      event.execution_status === "completed"
    ) {
      if (!this.waitingForPlanApproval) {
        out.push({
          type: "complete",
          summary: this.summaryBuffer.trim() || "Build complete.",
          timestamp: ts,
        });
      }
    }

    return out;
  }
}
