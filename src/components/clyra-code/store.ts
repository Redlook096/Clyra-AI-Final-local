/**
 * Clyra Code event store.
 *
 * Connects the existing OpenCode harness SSE stream to a normalized,
 * frontend-friendly model: an ordered work log of user prompts, assistant
 * commentary, and agent actions that update in place by stable id.
 * Nothing here fabricates activity — every entry originates from a real
 * harness event or a real API response.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type FileDiff, type OpenCodeMessage, type OpenCodePart, type VibeProject } from "./api";

export type ActionKind =
  | "read"
  | "edit"
  | "create"
  | "delete"
  | "search"
  | "research"
  | "list"
  | "command"
  | "build"
  | "check"
  | "test"
  | "preview"
  | "fetch"
  | "todo"
  | "permission"
  | "generic";

export type ActionStatus = "queued" | "active" | "success" | "error" | "cancelled";

export type AgentAction = {
  id: string;
  kind: ActionKind;
  tool: string;
  status: ActionStatus;
  /** Filename, command, search query or other action target. */
  target: string;
  output?: string;
  error?: string;
  additions?: number;
  deletions?: number;
  startedAt: number;
  endedAt?: number;
  /** Unified diff text from the edit tool's metadata, when provided. */
  patch?: string;
  /** Full file content written by the write tool (used for fallback diffs). */
  contentAfter?: string;
  /** Real before/after snapshots from the session diff endpoint. */
  before?: string;
  after?: string;
  /** For permission rows. */
  permissionId?: string;
  permissionResolved?: string;
};

export type LogEntry =
  | { type: "user"; id: string; text: string; ts: number }
  | { type: "assistant"; id: string; text: string; ts: number }
  /** A concise, provider-supplied reasoning summary — never hidden chain of thought. */
  | { type: "reasoning"; id: string; text?: string; ts: number; endedAt?: number }
  | { type: "action"; id: string; actionId: string; ts: number };

export type RunState = "idle" | "starting" | "running" | "complete" | "failed" | "cancelled";

export type ConnectionState = "idle" | "connected" | "reconnecting";

export type ProjectPlatform = "web" | "ios";

export type ClyraCodeState = {
  projects: VibeProject[];
  activeProjectId: string | null;
  sessionId: string | null;
  sessionTitle: string;
  runState: RunState;
  runStartedAt: number | null;
  runEndedAt: number | null;
  log: LogEntry[];
  actions: Record<string, AgentAction>;
  diffs: FileDiff[];
  error: string | null;
  connection: ConnectionState;
  model: string | null;
  tokens: { input: number; output: number } | null;
  restored: boolean;
  /** Active platform mode; drives Browser vs iPhone preview. */
  platform: ProjectPlatform;
};

const STORAGE_KEY = "clyra-code:last-session";

const INITIAL: ClyraCodeState = {
  projects: [],
  activeProjectId: null,
  sessionId: null,
  sessionTitle: "",
  runState: "idle",
  runStartedAt: null,
  runEndedAt: null,
  log: [],
  actions: {},
  diffs: [],
  error: null,
  connection: "idle",
  model: null,
  tokens: null,
  restored: false,
  platform: "web",
};

function stripProjectPrefix(path: string) {
  const normalized = path.replace(/\\/g, "/");
  if (/^.*\/projects\/[^/]+\/files\/?$/.test(normalized)) return "project root";
  return normalized.replace(/^.*\/projects\/[^/]+\/files\//, "").replace(/^\.\//, "");
}

/** Detect iOS intent from a prompt so iOS App Mode activates automatically. */
export function detectIosIntent(prompt: string): boolean {
  const ios = /\b(ios|iphone|ipad|swiftui|swift\s+app|xcode|apple\s+watch|watchos|visionos|apple\s+tv|tvos|app\s+store)\b/i;
  const web = /\b(website|web\s+app|html|react|next\.?js|electron|desktop\s+app|landing\s+page|portfolio)\b/i;
  return ios.test(prompt) && !web.test(prompt);
}

/** Commands often embed absolute project paths; compress them for display. */
function cleanCommand(command: string) {
  return command
    .replace(/cd\s+"[^"]*\/projects\/[^/]+\/files\/?"\s*(&&|;)\s*/g, "")
    .replace(/cd\s+\S*\/projects\/[^/\s]+\/files\/?\s*(&&|;)\s*/g, "")
    .replace(/"?\/[^\s"]*\/projects\/([^/\s"]+)\/files(\/[^\s"]*)?"?/g, (_m, _id, rest) => `.${rest ?? ""}`)
    .trim();
}

function classifyCommand(command: string): ActionKind {
  const c = command.toLowerCase();
  if (/\b(vitest|jest|pytest|playwright|cypress|mocha|ava|tap|npm\s+test|pnpm\s+test|yarn\s+test|cargo\s+test|go\s+test)\b/.test(c)) {
    return "test";
  }
  if (/\b(npm\s+run\s+build|pnpm\s+build|yarn\s+build|vite\s+build|next\s+build|astro\s+build|react-scripts\s+build|cargo\s+build|go\s+build)\b/.test(c)) {
    return "build";
  }
  if (/\b(tsc|typecheck|eslint|lint|prettier|biome|ruff|mypy|pyright|clippy|cargo\s+check)\b/.test(c)) {
    return "check";
  }
  if (/\b(vite\s+(?:preview|--host)|npm\s+run\s+(?:dev|preview)|pnpm\s+(?:dev|preview)|yarn\s+(?:dev|preview)|http-server|python(?:3)?\s+-m\s+http\.server|serve\s)\b/.test(c)) {
    return "preview";
  }
  return "command";
}

function classifyTool(tool: string, input: Record<string, unknown>): { kind: ActionKind; target: string } {
  // Providers use slightly different names and argument keys for the same
  // tool. Normalize those real variants here instead of hiding them behind a
  // generic "Completed" row in the transcript.
  const lower = tool.toLowerCase().replace(/[.\s-]+/g, "_");
  const file = firstString(input, "filePath", "filepath", "file_path", "path", "file", "target_file", "targetFile", "filename", "relativePath");
  const command = firstString(input, "command", "cmd", "script", "shell", "bash");
  const query = firstString(input, "pattern", "query", "search", "q", "text", "term");
  if (/^(bash|shell|command|execute|exec|run|terminal|shell_command)$/.test(lower)) {
    const cleaned = cleanCommand(command) || tool;
    return { kind: classifyCommand(cleaned), target: cleaned };
  }
  if (/^(write|write_file|create|create_file|file_write)$/.test(lower)) return { kind: "create", target: stripProjectPrefix(file) };
  if (/^(edit|edit_file|apply_patch|applypatch|str_replace|replace|replace_in_file|patch|file_edit)$/.test(lower)) return { kind: "edit", target: stripProjectPrefix(file) };
  if (/^(delete|delete_file|rm|remove|remove_file)$/.test(lower)) return { kind: "delete", target: stripProjectPrefix(file) };
  if (/^(read|read_file|open_file|view_file|cat|file_read)$/.test(lower)) return { kind: "read", target: stripProjectPrefix(file) };
  if (/^(web_search|websearch|search_web|internet_search)$/.test(lower)) return { kind: "research", target: query || tool };
  if (/^(grep|glob|search|codebase_search|find_in_files|ripgrep)$/.test(lower)) return { kind: "search", target: query || stripProjectPrefix(file) || tool };
  if (/^(list|ls|tree|list_files|readdir|directory_list)$/.test(lower)) return { kind: "list", target: stripProjectPrefix(file || firstString(input, "dir", "directory", "cwd")) || "project structure" };
  if (/^(browser|preview|screenshot|open_browser)$/.test(lower)) return { kind: "preview", target: String(input.url || query || "live preview") };
  if (/^(webfetch|fetch|curl)$/.test(lower)) return { kind: "fetch", target: String(input.url || query || tool) };
  if (/^(todowrite|todoread|todo)$/.test(lower)) return { kind: "todo", target: "task list" };
  return { kind: "generic", target: stripProjectPrefix(file) || command || query || tool };
}

function toolStatus(status?: string): ActionStatus {
  if (status === "error") return "error";
  if (status === "running") return "active";
  if (status === "pending") return "queued";
  return "success";
}

/** Line counts from an OpenCode edit-tool diff string, when metadata carries one. */
function countsFromDiffText(diff: string): { additions: number; deletions: number } | null {
  if (!diff || typeof diff !== "string") return null;
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
  }
  return additions || deletions ? { additions, deletions } : null;
}

/** Minimal unified patch rebuilt from an edit tool's real old/new inputs. */
function buildEditSnippet(kind: ActionKind, input: Record<string, unknown>): string {
  if (kind !== "edit") return "";
  const oldText = firstString(input, "old", "oldText", "old_string", "oldString", "search", "find", "from");
  const newText = firstString(input, "new", "newText", "new_string", "newString", "replace_with", "replacement", "to", "replace");
  if (!oldText && !newText) return "";
  const minus = oldText
    ? oldText.split("\n").map((line) => `-${line}`).join("\n")
    : "";
  const plus = newText
    ? newText.split("\n").map((line) => `+${line}`).join("\n")
    : "";
  return [minus, plus].filter(Boolean).join("\n");
}

function firstString(input: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

/**
 * Some providers occasionally mislabel scratch reasoning as a normal text
 * part. It is not a user-facing response. Keep the transcript to concise
 * public progress updates and tool facts rather than leaking a raw planning
 * monologue into the chat.
 */
function looksLikeInternalScratchpad(text: string) {
  const signals = [
    /\b(?:let me|actually|hmm|wait,?|I'?ll first|I'?ll make|I'?ll create)\b/gi,
    /\b(?:better:|simplest:|structure:)\b/gi,
  ].reduce((count, pattern) => count + (text.match(pattern)?.length ?? 0), 0);
  return text.length > 420 && signals >= 3;
}

export function useClyraCode() {
  const [state, setState] = useState<ClyraCodeState>(INITIAL);
  const eventSourceRef = useRef<EventSource | null>(null);
  const activeSessionRef = useRef<string | null>(null);
  const activeProjectRef = useRef<string | null>(null);
  const runStateRef = useRef<RunState>("idle");
  const diffTimerRef = useRef<number | null>(null);
  const projectsRef = useRef<VibeProject[]>([]);

  useEffect(() => {
    runStateRef.current = state.runState;
  }, [state.runState]);

  const closeStream = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
  }, []);

  useEffect(() => () => closeStream(), [closeStream]);

  const refreshDiff = useCallback((projectId: string, sessionId: string) => {
    if (diffTimerRef.current) window.clearTimeout(diffTimerRef.current);
    diffTimerRef.current = window.setTimeout(() => {
      void api
        .sessionDiff(projectId, sessionId)
        .then((diffs) => {
          setState((prev) => {
            const actions = { ...prev.actions };
            for (const key of Object.keys(actions)) {
              const action = actions[key];
              if (!/^(edit|create|delete)$/.test(action.kind)) continue;
              const match = diffs.find(
                (d) => stripProjectPrefix(d.file) === action.target,
              );
              if (match) {
                actions[key] = {
                  ...action,
                  additions: match.additions,
                  deletions: match.deletions,
                  before: match.before || action.before,
                  after: match.after || action.after,
                };
              }
            }
            return { ...prev, diffs, actions };
          });
        })
        .catch(() => undefined);
    }, 400);
  }, []);

  /** Normalize one ClyraAgentEvent envelope from the harness SSE stream. */
  const handleEvent = useCallback(
    (raw: unknown) => {
      const event = raw as {
        payload?: { type?: string; properties?: Record<string, unknown> };
        timestamp?: number;
      };
      const payload = event?.payload;
      if (!payload?.type) return;
      const properties = (payload.properties ?? {}) as Record<string, unknown>;
      const part = (properties.part ?? {}) as OpenCodePart;
      const eventSessionId = String(part.sessionID || properties.sessionID || "");
      if (
        eventSessionId &&
        activeSessionRef.current &&
        eventSessionId !== activeSessionRef.current
      ) {
        return;
      }
      const ts = Number(event?.timestamp) || Date.now();

      if (payload.type === "message.part.updated") {
        if (part.type === "text") {
          const text = String(part.text ?? "");
          if (!text) return;
          if (looksLikeInternalScratchpad(text)) {
            // The preceding reasoning row stays in place and settles into a
            // compact Thought entry once the next real tool action arrives.
            return;
          }
          const entryId = `assistant-${part.messageID}-${part.id}`;
          setState((prev) => {
            // OpenCode replays the submitted user prompt as a part; the
            // optimistic user entry already owns it.
            if (prev.log.some((e) => e.type === "user" && e.text === text)) return prev;
            // An assistant response means the preceding real reasoning phase
            // has concluded. Keep thought events sequential with the streamed
            // tool work instead of leaving several active at once.
            const log = prev.log.map((entry) =>
              entry.type === "reasoning" && !entry.endedAt
                ? { ...entry, endedAt: ts }
                : entry,
            );
            const index = log.findIndex((e) => e.id === entryId);
            const entry: LogEntry = { type: "assistant", id: entryId, text, ts };
            if (index >= 0) log[index] = entry;
            else log.push(entry);
            return { ...prev, log };
          });
          return;
        }
        if (part.type === "reasoning") {
          const entryId = `reasoning-${part.messageID}-${part.id}`;
          const summary = String(part.text ?? "").trim();
          setState((prev) => {
            const existing = prev.log.find((entry) => entry.id === entryId);
            if (existing) {
              if (existing.type !== "reasoning" || !summary || existing.text === summary) return prev;
              return {
                ...prev,
                log: prev.log.map((entry) => entry.id === entryId ? { ...entry, text: summary } : entry),
              };
            }
            return { ...prev, log: [...prev.log, { type: "reasoning", id: entryId, text: summary || undefined, ts }] };
          });
          return;
        }
        if (part.type === "step-finish") {
          const tokens = (part as { tokens?: { input?: number; output?: number } }).tokens;
          if (tokens) {
            setState((prev) => ({
              ...prev,
              tokens: {
                input: (prev.tokens?.input ?? 0) + (tokens.input ?? 0),
                output: (prev.tokens?.output ?? 0) + (tokens.output ?? 0),
              },
            }));
          }
          return;
        }
        if (part.type === "tool") {
          const tool = String(part.tool || "tool");
          const partState = part.state ?? { status: "pending" as const };
          const input = (partState.input ?? {}) as Record<string, unknown>;
          const { kind, target } = classifyTool(tool, input);
          const actionId = `${part.sessionID}:${part.messageID}:${part.id}`;
          const status = toolStatus(partState.status);
          // The harness question tool is the agent asking the user for input.
          // Render it as natural assistant prose instead of a fake
          // "Completed question" status row.
          if (/^question$/.test(tool.trim().toLowerCase())) {
            if (status === "success") {
              const question = String(input.question || partState.output || "").trim();
              if (question) {
                setState((prev) => {
                  const settledLog = prev.log.map((entry) =>
                    entry.type === "reasoning" && !entry.endedAt
                      ? { ...entry, endedAt: ts }
                      : entry,
                  );
                  return {
                    ...prev,
                    log: [
                      ...settledLog,
                      { type: "assistant" as const, id: `assistant-${actionId}`, text: question, ts },
                    ],
                  };
                });
              }
            }
            return;
          }
          const metadataDiff =
            typeof partState.metadata?.diff === "string" ? (partState.metadata.diff as string) : "";
          // Edit tools often carry their old/new text right in the input; the
          // harness metadata has no diff for them. Rebuild the real change as
          // a minimal patch so streaming edit boxes have honest line content.
          const inputPatch = typeof input.patch === "string" ? input.patch : "";
          const editSnippet = buildEditSnippet(kind, input);
          const patchSource = metadataDiff || inputPatch || editSnippet;
          const counts = countsFromDiffText(patchSource);
          const writtenContent =
            kind === "create" && typeof input.content === "string" ? input.content : undefined;
          // The write tool creates whole files; the real addition count is the
          // content it wrote when the harness diff has nothing to report.
          const writeAdditions =
            writtenContent !== undefined && status === "success"
              ? writtenContent.split("\n").length
              : undefined;
          setState((prev) => {
            const existing = prev.actions[actionId];
            const isFileKind = /^(create|edit|delete|read)$/.test(kind);
            const action: AgentAction = {
              id: actionId,
              kind,
              tool,
              status,
              target: target || existing?.target || (isFileKind ? "…" : tool),
              output: String(partState.output ?? existing?.output ?? ""),
              error:
                status === "error"
                  ? String(partState.error || "Tool failed")
                  : undefined,
              additions: counts?.additions ?? existing?.additions ?? writeAdditions,
              deletions: counts?.deletions ?? existing?.deletions,
              patch: patchSource || existing?.patch,
              contentAfter: writtenContent ?? existing?.contentAfter,
              startedAt: existing?.startedAt ?? partState.time?.start ?? ts,
              endedAt:
                status === "success" || status === "error"
                  ? partState.time?.end ?? ts
                  : undefined,
            };
            const actions = { ...prev.actions, [actionId]: action };
            // A real tool invocation is the boundary of a thinking phase. The
            // transcript should show one current action, never a growing list
            // of still-shimmering thoughts.
            const settledLog = prev.log.map((entry) =>
              entry.type === "reasoning" && !entry.endedAt
                ? { ...entry, endedAt: ts }
                : entry,
            );
            const log = settledLog.some((e) => e.type === "action" && e.actionId === actionId)
              ? settledLog
              : [
                  ...settledLog,
                  { type: "action" as const, id: `entry-${actionId}`, actionId, ts },
                ];
            return { ...prev, actions, log };
          });
          if (
            status === "success" &&
            /^(write|edit|apply_patch|str_replace|patch|delete|rm)$/.test(tool.toLowerCase()) &&
            eventSessionId &&
            activeProjectRef.current
          ) {
            refreshDiff(activeProjectRef.current, eventSessionId);
          }
          return;
        }
        return;
      }

      if (payload.type === "permission.updated") {
        const permissionId = String(properties.id || "");
        const title = String(properties.title || properties.type || "Approve action");
        if (!permissionId) return;
        const actionId = `permission:${permissionId}`;
        setState((prev) => {
          if (prev.actions[actionId]) return prev;
          return {
            ...prev,
            actions: {
              ...prev.actions,
              [actionId]: {
                id: actionId,
                kind: "permission",
                tool: "permission",
                status: "active",
                target: title,
                startedAt: ts,
                permissionId,
              },
            },
            log: [...prev.log, { type: "action", id: `entry-${actionId}`, actionId, ts }],
          };
        });
        return;
      }

      if (payload.type === "permission.replied") {
        const permissionId = String(properties.permissionID || "");
        const actionId = `permission:${permissionId}`;
        setState((prev) => {
          const existing = prev.actions[actionId];
          if (!existing) return prev;
          return {
            ...prev,
            actions: {
              ...prev.actions,
              [actionId]: {
                ...existing,
                status: "success",
                endedAt: ts,
                permissionResolved: String(properties.response || "replied"),
              },
            },
          };
        });
        return;
      }

      if (payload.type === "session.error") {
        const error = properties.error as { data?: { message?: string }; message?: string } | undefined;
        const message = String(error?.data?.message || error?.message || "The coding session failed.");
        setState((prev) => ({
          ...prev,
          runState: "failed",
          runEndedAt: ts,
          error: message,
          actions: finalizeActions(prev.actions, "error"),
        }));
        return;
      }

      if (payload.type === "session.idle") {
        setState((prev) => {
          if (prev.runState !== "running" && prev.runState !== "starting") return prev;
          return {
            ...prev,
            runState: "complete",
            runEndedAt: ts,
            actions: finalizeActions(prev.actions, "success"),
            log: prev.log.map((entry) =>
              entry.type === "reasoning" && !entry.endedAt ? { ...entry, endedAt: ts } : entry,
            ),
          };
        });
        if (activeProjectRef.current && activeSessionRef.current) {
          refreshDiff(activeProjectRef.current, activeSessionRef.current);
        }
        return;
      }

      if (payload.type === "session.status") {
        const status = properties.status as { type?: string } | undefined;
        if (status?.type === "busy") {
          setState((prev) =>
            prev.runState === "running" && prev.runStartedAt
              ? prev
              : {
                  ...prev,
                  runState: "running",
                  runStartedAt: prev.runStartedAt ?? ts,
                  runEndedAt: null,
                },
          );
        }
      }
    },
    [refreshDiff],
  );

  const openStream = useCallback(
    (projectId: string) => {
      closeStream();
      const source = new EventSource(api.eventsUrl(projectId));
      eventSourceRef.current = source;
      source.onopen = () => setState((prev) => ({ ...prev, connection: "connected" }));
      source.onmessage = (message) => {
        try {
          handleEvent(JSON.parse(message.data));
        } catch {
          /* malformed frame ignored */
        }
      };
      source.onerror = () => {
        // Browser EventSource retries automatically; the server replays
        // buffered project events on reconnect, and upserts are idempotent.
        if (runStateRef.current === "running" || runStateRef.current === "starting") {
          setState((prev) => ({ ...prev, connection: "reconnecting" }));
        }
      };
    },
    [closeStream, handleEvent],
  );

  const loadProjects = useCallback(async () => {
    // Retry transient failures (e.g. the dev server momentarily busy) so an
    // unlucky fetch cannot present an empty sidebar over real projects.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const projects = await api.listProjects();
        projectsRef.current = projects;
        setState((prev) => ({ ...prev, projects }));
        return projects;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 700 * (attempt + 1)));
      }
    }
    return [] as VibeProject[];
  }, []);

  const selectProject = useCallback(
    (projectId: string | null) => {
      closeStream();
      activeSessionRef.current = null;
      activeProjectRef.current = projectId;
      setState((prev) => {
        const project = prev.projects.find((p) => p.id === projectId);
        return {
          ...INITIAL,
          projects: prev.projects,
          model: prev.model,
          activeProjectId: projectId,
          platform: project?.platform === "ios" ? "ios" : "web",
        };
      });
      try {
        if (projectId) localStorage.setItem(STORAGE_KEY, JSON.stringify({ projectId }));
        else localStorage.removeItem(STORAGE_KEY);
      } catch { /* storage unavailable */ }
    },
    [closeStream],
  );

  const startRun = useCallback(
    async (prompt: string, agent?: string) => {
      const projectId = activeProjectRef.current;
      if (!projectId || !prompt.trim()) return false;
      const followUp = Boolean(activeSessionRef.current) && runStateRef.current !== "idle";
      const userEntry: LogEntry = {
        type: "user",
        id: `user-${Date.now()}`,
        text: prompt,
        ts: Date.now(),
      };
      setState((prev) => ({
        ...prev,
        runState: "starting",
        runStartedAt: followUp ? prev.runStartedAt ?? Date.now() : Date.now(),
        runEndedAt: null,
        error: null,
        restored: false,
        platform: detectIosIntent(prompt) ? "ios" : prev.platform,
        log: [...prev.log, userEntry],
      }));

      try {
        await api.startRuntime(projectId);
        if (!eventSourceRef.current) openStream(projectId);

        let sessionId = activeSessionRef.current;
        if (!sessionId) {
          const session = await api.createSession(projectId, prompt.slice(0, 72));
          sessionId = session.id;
          activeSessionRef.current = sessionId;
          setState((prev) => ({ ...prev, sessionId, sessionTitle: session.title ?? prompt.slice(0, 72) }));
          // First message names the project: a fresh project created without
          // a name takes the request as its title.
          const fresh = projectsRef.current.find((p) => p.id === projectId);
          if (fresh && /^(new project|untitled)$/i.test(fresh.name.trim())) {
            void api
              .renameProject(projectId, session.title ?? prompt.slice(0, 60))
              .then((renamed) => {
                setState((prev) => ({
                  ...prev,
                  projects: prev.projects.map((p) => (p.id === renamed.id ? renamed : p)),
                }));
              })
              .catch(() => undefined);
          }
          try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify({ projectId, sessionId }));
          } catch { /* storage unavailable */ }
        }
        await api.sendPrompt(projectId, sessionId, prompt, agent);
        setState((prev) =>
          prev.runState === "starting" ? { ...prev, runState: "running" } : prev,
        );
        return true;
      } catch (error) {
        setState((prev) => ({
          ...prev,
          runState: "failed",
          runEndedAt: Date.now(),
          error: error instanceof Error ? error.message : "The run could not start.",
        }));
        return false;
      }
    },
    [openStream],
  );

  const cancelRun = useCallback(async () => {
    const projectId = activeProjectRef.current;
    const sessionId = activeSessionRef.current;
    setState((prev) => ({
      ...prev,
      runState: "cancelled",
      runEndedAt: Date.now(),
      actions: finalizeActions(prev.actions, "cancelled"),
      log: prev.log.map((entry) =>
        entry.type === "reasoning" && !entry.endedAt ? { ...entry, endedAt: Date.now() } : entry,
      ),
    }));
    if (projectId && sessionId) {
      await api.abortSession(projectId, sessionId).catch(() => undefined);
    }
  }, []);

  /**
   * A Visual Edit is a real write made through the same project filesystem as
   * OpenCode. Surface it in the existing action/diff stream so it remains
   * reviewable instead of behaving like an invisible preview mutation.
   */
  const recordVisualEdit = useCallback(
    (edit: { file: string; before: string; after: string; additions: number; deletions: number }) => {
      const now = Date.now();
      const actionId = `visual-edit:${now}:${Math.random().toString(36).slice(2, 7)}`;
      const target = stripProjectPrefix(edit.file);
      setState((prev) => ({
        ...prev,
        actions: {
          ...prev.actions,
          [actionId]: {
            id: actionId,
            kind: "edit",
            tool: "visual_edit",
            status: "success",
            target,
            additions: edit.additions,
            deletions: edit.deletions,
            before: edit.before,
            after: edit.after,
            startedAt: now,
            endedAt: now,
          },
        },
        log: [...prev.log, { type: "action", id: `entry:${actionId}`, actionId, ts: now }],
      }));
    },
    [],
  );

  const replyPermission = useCallback(
    async (permissionId: string, response: "allow" | "always" | "deny") => {
      const projectId = activeProjectRef.current;
      const sessionId = activeSessionRef.current;
      if (!projectId || !sessionId) return;
      await api.replyPermission(projectId, sessionId, permissionId, response).catch(() => undefined);
      setState((prev) => {
        const actionId = `permission:${permissionId}`;
        const existing = prev.actions[actionId];
        if (!existing) return prev;
        return {
          ...prev,
          actions: {
            ...prev.actions,
            [actionId]: {
              ...existing,
              status: "success",
              endedAt: Date.now(),
              permissionResolved: response,
            },
          },
        };
      });
    },
    [],
  );

  /** Rebuild the work log from persisted session messages after a reload. */
  const restoreSession = useCallback(
    async (projectId: string, sessionId: string) => {
      // Bring the runtime up so persisted sessions can be queried again.
      await api.startRuntime(projectId).catch(() => undefined);
      const messages = await api.sessionMessages(projectId, sessionId).catch(() => null);
      if (!messages) return false;
      const log: LogEntry[] = [];
      const actions: Record<string, AgentAction> = {};
      for (const message of messages) {
        rebuildMessage(message, log, actions);
      }
      activeSessionRef.current = sessionId;
      const diffs = await api.sessionDiff(projectId, sessionId).catch(() => [] as FileDiff[]);
      for (const key of Object.keys(actions)) {
        const action = actions[key];
        const match = diffs.find((d) => stripProjectPrefix(d.file) === action.target);
        if (match && /^(edit|create|delete)$/.test(action.kind)) {
          actions[key] = {
            ...action,
            additions: match.additions,
            deletions: match.deletions,
            before: match.before || action.before,
            after: match.after || action.after,
          };
        }
      }
      setState((prev) => ({
        ...prev,
        sessionId,
        log,
        actions,
        diffs,
        runState: "complete",
        restored: true,
      }));
      // If the harness is still busy, reattach to the live stream. Replayed
      // buffered events reconcile into the same rows by stable id.
      openStream(projectId);
      return true;
    },
    [openStream],
  );

  /** Select a saved conversation without changing the workspace it belongs to. */
  const selectThread = useCallback(
    async (projectId: string, sessionId: string) => {
      selectProject(projectId);
      await restoreSession(projectId, sessionId);
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ projectId, sessionId }));
      } catch { /* storage unavailable */ }
    },
    [restoreSession, selectProject],
  );

  /** A new chat is a new OpenCode session, never a new project directory. */
  const newChat = useCallback(
    async (projectId: string) => {
      await api.startRuntime(projectId);
      const session = await api.createSession(projectId, "New chat");
      selectProject(projectId);
      activeSessionRef.current = session.id;
      setState((prev) => ({ ...prev, sessionId: session.id, sessionTitle: session.title ?? "New chat" }));
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ projectId, sessionId: session.id }));
      } catch { /* storage unavailable */ }
      return session;
    },
    [selectProject],
  );

  const boot = useCallback(async () => {
    const [, status] = await Promise.all([
      loadProjects(),
      api.openCodeStatus().catch(() => null),
    ]);
    // Clyra deliberately opens in a fresh, unbound welcome state. Projects
    // remain available in the sidebar, but reopening Vibe Coder never drops
    // a user back into an old conversation or restores its scroll position.
    activeProjectRef.current = null;
    activeSessionRef.current = null;
    setState((prev) => ({
      ...prev,
      activeProjectId: null,
      sessionId: null,
      sessionTitle: "",
      model: status?.model ?? null,
      platform: "web",
    }));
  }, [loadProjects]);

  useEffect(() => {
    void boot();
    // boot() is intentionally run once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const derived = useMemo(() => {
    const actionList = state.log
      .filter((e): e is Extract<LogEntry, { type: "action" }> => e.type === "action")
      .map((e) => state.actions[e.actionId])
      .filter(Boolean);
    const running = state.runState === "running" || state.runState === "starting";
    const fileActions = actionList.filter((a) => /^(edit|create|delete)$/.test(a.kind));
    const commandActions = actionList.filter((a) => /^(command|build|check|test|preview)$/.test(a.kind));
    const pendingPermissions = actionList.filter(
      (a) => a.kind === "permission" && a.status === "active",
    );
    // When the harness diff endpoint has nothing (e.g. older projects without
    // git baselines), synthesize file summaries from the real tool payloads:
    // write content and edit patches — never invented numbers.
    let effectiveDiffs: FileDiff[] = state.diffs;
    if (!effectiveDiffs.length && fileActions.length) {
      const byFile = new Map<string, FileDiff>();
      for (const action of fileActions) {
        if (action.status !== "success" || !action.target || action.target === "…") continue;
        const existing = byFile.get(action.target);
        byFile.set(action.target, {
          file: action.target,
          before: "",
          after: action.contentAfter ?? "",
          additions: (existing?.additions ?? 0) + (action.additions ?? 0),
          deletions: (existing?.deletions ?? 0) + (action.deletions ?? 0),
        });
      }
      effectiveDiffs = [...byFile.values()];
    }
    // Keep direct Visual Edit writes visible beside harness-generated diffs.
    // When the same file has a session diff, preserve its original before
    // snapshot and layer the latest real visual edit over it.
    const directVisualEdits = fileActions.filter(
      (action) => action.tool === "visual_edit" && action.status === "success" && action.before !== undefined && action.after !== undefined,
    );
    if (directVisualEdits.length) {
      const byFile = new Map(effectiveDiffs.map((diff) => [diff.file, diff]));
      for (const action of directVisualEdits) {
        const existing = byFile.get(action.target);
        byFile.set(action.target, {
          file: action.target,
          before: existing?.before || action.before || "",
          after: action.after || existing?.after || "",
          additions: (existing?.additions ?? 0) + (action.additions ?? 0),
          deletions: (existing?.deletions ?? 0) + (action.deletions ?? 0),
        });
      }
      effectiveDiffs = [...byFile.values()];
    }
    return { actionList, running, fileActions, commandActions, pendingPermissions, effectiveDiffs };
  }, [state.log, state.actions, state.runState, state.diffs]);

  return {
    state,
    ...derived,
    loadProjects,
    selectProject,
    selectThread,
    newChat,
    startRun,
    cancelRun,
    replyPermission,
    recordVisualEdit,
    setState,
  };
}

function finalizeActions(
  actions: Record<string, AgentAction>,
  terminal: "success" | "error" | "cancelled",
): Record<string, AgentAction> {
  const next: Record<string, AgentAction> = {};
  for (const key of Object.keys(actions)) {
    const action = actions[key];
    next[key] =
      action.status === "active" || action.status === "queued"
        ? { ...action, status: terminal, endedAt: action.endedAt ?? Date.now() }
        : action;
  }
  return next;
}

function rebuildMessage(
  message: OpenCodeMessage,
  log: LogEntry[],
  actions: Record<string, AgentAction>,
) {
  const role = message.info?.role;
  const ts = message.info?.time?.created ?? Date.now();
  for (const part of message.parts ?? []) {
    if (part.type === "text" && part.text) {
      if (role === "user") {
        log.push({ type: "user", id: `user-${message.info.id}-${part.id}`, text: part.text, ts });
      } else {
        log.push({
          type: "assistant",
          id: `assistant-${part.messageID}-${part.id}`,
          text: part.text,
          ts,
        });
      }
      continue;
    }
    if (part.type === "tool" && role === "assistant") {
      const tool = String(part.tool || "tool");
      const partState = part.state ?? { status: "completed" as const };
      const input = (partState.input ?? {}) as Record<string, unknown>;
      if (/^question$/.test(tool.trim().toLowerCase())) {
        const question = String(input.question || partState.output || "").trim();
        if (question) log.push({ type: "assistant", id: `assistant-${part.messageID}-${part.id}`, text: question, ts });
        continue;
      }
      const { kind, target } = classifyTool(tool, input);
      const actionId = `${part.sessionID}:${part.messageID}:${part.id}`;
      const metadataDiff =
        typeof partState.metadata?.diff === "string" ? (partState.metadata.diff as string) : "";
      const inputPatch = typeof input.patch === "string" ? input.patch : "";
      const patchSource = metadataDiff || inputPatch || buildEditSnippet(kind, input);
      const counts = countsFromDiffText(patchSource);
      const writtenContent =
        kind === "create" && typeof input.content === "string" ? input.content : undefined;
      actions[actionId] = {
        id: actionId,
        kind,
        tool,
        status: toolStatus(partState.status),
        target: target || (/^(create|edit|delete|read)$/.test(kind) ? "…" : tool),
        output: String(partState.output ?? ""),
        additions:
          counts?.additions ??
          (writtenContent !== undefined ? writtenContent.split("\n").length : undefined),
        deletions: counts?.deletions,
        patch: patchSource || undefined,
        contentAfter: writtenContent,
        startedAt: partState.time?.start ?? ts,
        endedAt: partState.time?.end,
      };
      log.push({ type: "action", id: `entry-${actionId}`, actionId, ts });
    }
  }
}
