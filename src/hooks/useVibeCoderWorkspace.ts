import { useState, useCallback, useRef, useEffect } from "react";
import type { AgentStage, VibeCoderEvent } from "../../lib/cline/cline-events";

export type ProjectFile = {
  path: string;
  action: "create" | "edit" | "delete";
  status: "idle" | "streaming" | "complete" | "error";
  language: string;
  code: string;
  added?: number;
  removed?: number;
  stepId?: string;
};

export type CodeStep = {
  id: string;
  title: string;
  description: string;
  status: "pending" | "thinking" | "active" | "complete" | "error";
  timestamp: number;
};

export type TerminalLog = {
  id: string;
  command?: string;
  output: string;
  timestamp: number;
};

export type ProjectCheckpoint = {
  id: string;
  label: string;
  createdAt: number;
  files: Record<string, string>;
  stage: AgentStage;
};

export type PreviewState = {
  status: "idle" | "starting" | "ready" | "error";
  url?: string;
  error?: string;
};

export type ThinkingLine = {
  id: string;
  text: string;
  timestamp: number;
};

export type VibeChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: number;
};

export type WorkspaceState = {
  projectId: string;
  taskId: string | null;
  prompt: string;
  planMode: boolean;
  stage: AgentStage;
  thinkingLines: ThinkingLine[];
  statusUpdates: ThinkingLine[];
  webResearch: {
    startedAt: number | null;
    completedAt: number | null;
    lines: ThinkingLine[];
  };
  files: Record<string, ProjectFile>;
  activeFilePath: string | null;
  fileQueue: Array<{
    path: string;
    action: "create" | "edit" | "delete";
    reason: string;
  }>;
  currentStreamingFile: string | null;
  terminalLogs: TerminalLog[];
  preview: PreviewState;
  checkpoints: ProjectCheckpoint[];
  startedAt: number | null;
  completedAt: number | null;
  error: string | null;
  planMd: string;
  chatMessages: VibeChatMessage[];
  restored: boolean;
};

export type VibeProjectSession = {
  chatMessages: VibeChatMessage[];
  workspace: Omit<WorkspaceState, "taskId" | "currentStreamingFile" | "restored">;
  savedAt: string;
};

const PLACEHOLDER_PROJECT_ID = "project-advanced-vibe";
const CHAT_STORAGE_KEY = "vibe-coder-project-chats";

function inferLanguage(filePath: string) {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    json: "json",
    css: "css",
    html: "html",
    md: "markdown",
  };
  return map[ext] || "plaintext";
}

function filesFromProjectList(
  files: Array<{ path: string; content: string }>,
): Record<string, ProjectFile> {
  const record: Record<string, ProjectFile> = {};
  for (const file of files) {
    record[file.path] = {
      path: file.path,
      action: "create",
      status: "complete",
      language: inferLanguage(file.path),
      code: file.content,
    };
  }
  return record;
}

function readLocalChat(projectId: string): VibeChatMessage[] {
  try {
    const raw = localStorage.getItem(CHAT_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Record<string, VibeChatMessage[]>;
    return parsed[projectId] ?? [];
  } catch {
    return [];
  }
}

function writeLocalChat(projectId: string, messages: VibeChatMessage[]) {
  try {
    const raw = localStorage.getItem(CHAT_STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<string, VibeChatMessage[]>) : {};
    parsed[projectId] = messages;
    localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(parsed));
  } catch {
    // ignore storage failures
  }
}

function buildAssistantSummary(workspace: WorkspaceState) {
  const fileCount = Object.keys(workspace.files).length;
  if (workspace.error) return `Build paused: ${workspace.error}`;
  if (workspace.stage === "complete") {
    return `Build complete — ${fileCount} file${fileCount === 1 ? "" : "s"} saved${workspace.preview.url ? " with live preview ready." : "."}`;
  }
  return "Session saved.";
}

function createIdleState(projectId: string): WorkspaceState {
  return {
    projectId,
    taskId: null,
    prompt: "",
    planMode: true,
    stage: "idle",
    thinkingLines: [],
    statusUpdates: [],
    webResearch: { startedAt: null, completedAt: null, lines: [] },
    files: {},
    activeFilePath: null,
    fileQueue: [],
    currentStreamingFile: null,
    terminalLogs: [],
    preview: { status: "idle" },
    checkpoints: [],
    startedAt: null,
    completedAt: null,
    error: null,
    planMd: "",
    chatMessages: [],
    restored: false,
  };
}

export function useVibeCoderWorkspace(projectId: string) {
  const [state, setState] = useState<WorkspaceState>(() => createIdleState(projectId));

  const eventSourceRef = useRef<EventSource | null>(null);
  const projectIdRef = useRef(projectId);
  const saveTimerRef = useRef<number | null>(null);
  const stateRef = useRef(state);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    projectIdRef.current = state.projectId;
  }, [state.projectId]);

  const persistSession = useCallback(async (workspace: WorkspaceState) => {
    if (!workspace.projectId || workspace.projectId === PLACEHOLDER_PROJECT_ID) return;
    if (workspace.stage === "idle" || workspace.stage === "task-created") return;
    writeLocalChat(workspace.projectId, workspace.chatMessages);
  }, []);

  const schedulePersist = useCallback(
    (workspace: WorkspaceState) => {
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = window.setTimeout(() => {
        void persistSession(workspace);
      }, 700);
    },
    [persistSession],
  );

  useEffect(() => {
    if (state.stage === "idle") return;
    schedulePersist(state);
    return () => {
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    };
  }, [schedulePersist, state]);

  const processEvent = useCallback((event: VibeCoderEvent) => {
    setState((prev) => {
      const next = { ...prev };
      const ts = event.timestamp || Date.now();
      const eventId = `${ts}-${event.type}-${prev.thinkingLines.length}-${prev.terminalLogs.length}`;

      switch (event.type) {
        case "mode_changed":
          next.stage = event.mode === "plan" ? "planning" : "creating-checkpoint";
          next.thinkingLines = [...next.thinkingLines, { id: eventId, text: event.message, timestamp: ts }];
          break;
        case "stage":
          if (event.stage === "researching-web") {
            next.webResearch = { startedAt: ts, completedAt: null, lines: [] };
          } else if (prev.stage === "researching-web" && prev.webResearch.startedAt && !prev.webResearch.completedAt) {
            next.webResearch = { ...prev.webResearch, completedAt: ts };
          }
          next.stage = event.stage;
          next.thinkingLines = [...next.thinkingLines, { id: eventId, text: event.message, timestamp: ts }];
          if (event.stage !== "researching-web" && event.stage !== "writing-plan-md" && event.stage !== "planning") {
            next.statusUpdates = [...prev.statusUpdates, { id: eventId, text: event.message, timestamp: ts }];
          }
          if (event.stage === "researching-web") {
            next.webResearch = {
              ...next.webResearch,
              lines: [...next.webResearch.lines, { id: eventId, text: event.message, timestamp: ts }],
            };
          }
          break;
        case "thinking":
          next.thinkingLines = [...next.thinkingLines, { id: eventId, text: event.text, timestamp: ts }];
          if (prev.stage === "researching-web" && prev.webResearch.startedAt && !prev.webResearch.completedAt) {
            next.webResearch = {
              ...prev.webResearch,
              lines: [...next.webResearch.lines, { id: eventId, text: event.text, timestamp: ts }],
            };
          }
          break;
        case "plan_started":
          next.stage = "writing-plan-md";
          next.planMd = "";
          break;
        case "plan_delta":
          next.planMd = prev.planMd + event.delta;
          break;
        case "plan_completed":
          next.planMd = event.content;
          next.stage = "extracting-file-queue";
          break;
        case "file_queue_created":
          next.fileQueue = event.files;
          break;
        case "status_update":
          next.statusUpdates = [...prev.statusUpdates, { id: eventId, text: event.message, timestamp: ts }];
          break;
        case "file_started":
          next.stage = event.action === "create" ? "generating-file" : "editing-file";
          next.currentStreamingFile = event.path;
          next.activeFilePath = event.path;
          next.files = {
            ...prev.files,
            [event.path]: {
              path: event.path,
              action: event.action,
              status: "streaming",
              language: event.language,
              code: "",
              stepId: event.stepId,
            },
          };
          break;
        case "file_delta":
          if (next.files[event.path]) {
            next.files[event.path].code += event.delta;
          }
          break;
        case "file_completed":
          if (next.files[event.path]) {
            next.files[event.path].status = "complete";
            next.files[event.path].code = event.content;
          }
          next.currentStreamingFile = null;
          break;
        case "terminal_started":
          next.stage = "running-command";
          next.terminalLogs = [...prev.terminalLogs, { id: eventId, command: event.command, output: `> ${event.command}`, timestamp: ts }];
          break;
        case "terminal_output":
          next.terminalLogs = [...prev.terminalLogs, { id: eventId, command: event.command, output: event.output, timestamp: ts }];
          break;
        case "terminal_completed":
          next.terminalLogs = [
            ...prev.terminalLogs,
            {
              id: eventId,
              command: event.command,
              output: `Command exited with code ${event.exitCode}\n`,
              timestamp: ts,
            },
          ];
          break;
        case "preview_starting":
          next.stage = "starting-preview";
          next.preview = { status: "starting" };
          break;
        case "preview_ready":
          next.stage = "validating-preview";
          next.preview = { status: "ready", url: event.url };
          break;
        case "checkpoint_created":
          next.checkpoints = [...prev.checkpoints, {
            id: event.id,
            label: event.label,
            createdAt: ts,
            files: {},
            stage: next.stage,
          }];
          break;
        case "error":
          next.stage = "failed";
          next.error = event.message;
          break;
        case "complete":
          next.stage = "complete";
          next.completedAt = ts;
          next.restored = false;
          next.chatMessages = [
            ...prev.chatMessages,
            {
              id: `assistant-${ts}`,
              role: "assistant",
              content: buildAssistantSummary({ ...next, stage: "complete" }),
              timestamp: ts,
            },
          ];
          break;
      }

      if (event.type === "stage" && event.stage === "paused") {
        next.stage = "paused";
      }
      return next;
    });
  }, []);

  const startTask = useCallback(async (prompt: string, planMode: boolean) => {
    const activeProjectId = projectIdRef.current || projectId;
    const isFreshProject = !activeProjectId || activeProjectId === PLACEHOLDER_PROJECT_ID;
    const userMessage: VibeChatMessage = {
      id: `user-${Date.now()}`,
      role: "user",
      content: prompt,
      timestamp: Date.now(),
    };

    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }

    setState((prev) => ({
      ...prev,
      projectId: isFreshProject ? activeProjectId : prev.projectId,
      taskId: null,
      prompt,
      planMode,
      stage: "task-created",
      startedAt: Date.now(),
      completedAt: null,
      error: null,
      restored: false,
      thinkingLines: [],
      statusUpdates: [],
      webResearch: { startedAt: null, completedAt: null, lines: [] },
      files: isFreshProject ? {} : prev.files,
      activeFilePath: null,
      fileQueue: isFreshProject ? [] : prev.fileQueue,
      currentStreamingFile: null,
      terminalLogs: isFreshProject ? [] : prev.terminalLogs,
      preview: isFreshProject ? { status: "idle" } : prev.preview,
      checkpoints: isFreshProject ? [] : prev.checkpoints,
      planMd: isFreshProject ? "" : prev.planMd,
      chatMessages: isFreshProject ? [userMessage] : [...prev.chatMessages, userMessage],
    }));

    try {
      const res = await fetch("/api/vibe/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt,
          planMode,
          projectId: isFreshProject ? undefined : activeProjectId,
        }),
      });
      const data = await res.json();

      setState((prev) => ({
        ...prev,
        taskId: data.taskId,
        projectId: typeof data.projectId === "string" ? data.projectId : prev.projectId,
      }));

      const es = new EventSource(`/api/vibe/events/${data.taskId}`);
      eventSourceRef.current = es;

      es.onmessage = (e) => {
        const ev = JSON.parse(e.data) as VibeCoderEvent;
        processEvent(ev);
        if (ev.type === "complete" || (ev.type === "error" && !ev.recoverable)) {
          es.close();
        }
      };
    } catch (e: any) {
      setState((prev) => ({ ...prev, stage: "failed", error: e.message }));
    }
  }, [projectId, processEvent]);

  const cancelTask = useCallback(async () => {
    if (state.taskId) {
      await fetch(`/api/vibe/cancel/${state.taskId}`, { method: "POST" });
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }
      setState((prev) => ({ ...prev, stage: "cancelled", error: "Cancelled by user" }));
    }
  }, [state.taskId]);

  const pauseTask = useCallback(async () => {
    if (!state.taskId) return;
    await fetch(`/api/vibe/pause/${state.taskId}`, { method: "POST" });
    setState((prev) => ({ ...prev, stage: "paused" }));
  }, [state.taskId]);

  const resumeTask = useCallback(async () => {
    if (!state.taskId) return;
    await fetch(`/api/vibe/resume/${state.taskId}`, { method: "POST" });
    setState((prev) => ({
      ...prev,
      stage: prev.stage === "paused" ? "generating-file" : prev.stage,
    }));
  }, [state.taskId]);

  const approvePlan = useCallback(async () => {
    if (!state.taskId) return;
    await fetch(`/api/vibe/approve/${state.taskId}`, { method: "POST" });
  }, [state.taskId]);

  const loadSavedProject = useCallback((workspace: WorkspaceState) => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    projectIdRef.current = workspace.projectId;
    setState({
      ...workspace,
      currentStreamingFile: null,
      taskId: null,
      restored: true,
    });
  }, []);

  const restoreProject = useCallback(async (projectIdToOpen: string) => {
    const [projectRes, sessionRes] = await Promise.all([
      fetch(`/api/vibe/projects/${encodeURIComponent(projectIdToOpen)}`),
      fetch(`/api/vibe/projects/${encodeURIComponent(projectIdToOpen)}/session`).catch(() => null),
    ]);

    if (!projectRes.ok) throw new Error("Project not found");

    const projectData = await projectRes.json() as {
      project: { id: string; prompt: string; mode: "plan" | "fast"; status: string; name: string };
      files: Array<{ path: string; content: string }>;
      plan?: string;
    };

    let session: VibeProjectSession | null = null;
    if (sessionRes?.ok) {
      const sessionJson = await sessionRes.json() as { session: VibeProjectSession | null };
      session = sessionJson.session;
    }

    const localChat = readLocalChat(projectIdToOpen);
    const chatMessages =
      session?.chatMessages?.length
        ? session.chatMessages
        : localChat.length
          ? localChat
          : projectData.project.prompt
            ? [{
                id: `user-restored-${projectData.project.id}`,
                role: "user" as const,
                content: projectData.project.prompt,
                timestamp: Date.now(),
              }]
            : [];

    const planFromFiles =
      projectData.files.find((file) => /^plan\.md$/i.test(file.path))?.content ??
      projectData.files.find((file) => /^PLAN\.md$/i.test(file.path))?.content ??
      "";

    if (session?.workspace) {
      loadSavedProject({
        ...session.workspace,
        projectId: projectIdToOpen,
        chatMessages,
        preview: session.workspace.preview?.status === "ready"
          ? session.workspace.preview
          : { status: "ready" },
        stage: session.workspace.stage === "idle" ? "complete" : session.workspace.stage,
        restored: true,
        taskId: null,
        currentStreamingFile: null,
      });
      return;
    }

    const files = filesFromProjectList(projectData.files);
    const fileQueue = Object.keys(files).map((path) => ({
      path,
      action: "create" as const,
      reason: "Restored from saved project",
    }));

    loadSavedProject({
      ...createIdleState(projectIdToOpen),
      projectId: projectIdToOpen,
      prompt: projectData.project.prompt,
      planMode: projectData.project.mode === "plan",
      stage: "complete",
      files,
      fileQueue,
      planMd: projectData.plan || planFromFiles,
      preview: { status: "ready" },
      chatMessages,
      completedAt: Date.now(),
      restored: true,
    });
  }, [loadSavedProject]);

  const resetToIdle = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    setState(createIdleState(projectIdRef.current || projectId));
  }, [projectId]);

  return {
    state,
    startTask,
    cancelTask,
    pauseTask,
    resumeTask,
    approvePlan,
    loadSavedProject,
    restoreProject,
    resetToIdle,
    setState,
  };
}
