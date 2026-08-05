import type { WorkspaceState } from "../../hooks/useVibeCoderWorkspace";

export type VibeChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: number;
};

export type SavedProjectSession = {
  version: 1;
  projectId: string;
  projectName: string;
  savedAt: number;
  workspace: WorkspaceState;
  ui: {
    planApproved: boolean;
    planExpanded: boolean;
    thinkingCollapsed: boolean;
    mode: "plan" | "fast";
  };
  chatMessages: VibeChatMessage[];
};

const STORAGE_KEY = "vibe-coder-project-sessions";

function inferLanguage(filePath: string) {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "text";
  const map: Record<string, string> = {
    tsx: "tsx",
    ts: "typescript",
    jsx: "jsx",
    js: "javascript",
    css: "css",
    html: "html",
    json: "json",
    md: "markdown",
  };
  return map[ext] ?? ext;
}

export function loadAllProjectSessions(): Record<string, SavedProjectSession> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, SavedProjectSession>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function loadProjectSession(projectId: string): SavedProjectSession | null {
  return loadAllProjectSessions()[projectId] ?? null;
}

export function saveProjectSession(session: SavedProjectSession) {
  const all = loadAllProjectSessions();
  all[session.projectId] = session;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
}

export function deleteProjectSession(projectId: string) {
  const all = loadAllProjectSessions();
  delete all[projectId];
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
}

export function projectThumbnailUrl(projectId: string, updatedAt?: string) {
  const cache = updatedAt ? `?u=${encodeURIComponent(updatedAt)}` : "";
  return `/api/vibe/projects/${encodeURIComponent(projectId)}/thumbnail${cache}`;
}

function planFromFiles(files: Array<{ path: string; content: string }>) {
  return (
    files.find((file) => /^plan\.md$/i.test(file.path))?.content ??
    files.find((file) => /^PLAN\.md$/i.test(file.path))?.content ??
    ""
  );
}

/** Accept SavedProjectSession (v1) or legacy { chatMessages, workspace, savedAt } payloads. */
export function normalizeSavedSession(
  raw: unknown,
  fallback?: { id: string; name: string },
): SavedProjectSession | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;

  if (record.version === 1 && record.workspace && typeof record.workspace === "object") {
    const workspace = record.workspace as WorkspaceState;
    return {
      version: 1,
      projectId: String(record.projectId ?? workspace.projectId ?? fallback?.id ?? ""),
      projectName: String(record.projectName ?? fallback?.name ?? "Vibe project"),
      savedAt: typeof record.savedAt === "number" ? record.savedAt : Date.now(),
      workspace: {
        ...workspace,
        projectId: String(workspace.projectId ?? record.projectId ?? fallback?.id ?? ""),
        taskId: null,
        currentStreamingFile: null,
        restored: true,
        stage: workspace.stage === "idle" ? "complete" : workspace.stage,
        preview:
          workspace.preview?.status === "ready" || workspace.stage === "complete"
            ? { status: "ready" as const, url: workspace.preview?.url }
            : workspace.preview ?? { status: "idle" as const },
      },
      ui: {
        ...(typeof record.ui === "object" && record.ui ? (record.ui as SavedProjectSession["ui"]) : {}),
        planApproved: (record.ui as SavedProjectSession["ui"] | undefined)?.planApproved ?? true,
        planExpanded: (record.ui as SavedProjectSession["ui"] | undefined)?.planExpanded ?? false,
        thinkingCollapsed: (record.ui as SavedProjectSession["ui"] | undefined)?.thinkingCollapsed ?? true,
        mode:
          (record.ui as SavedProjectSession["ui"] | undefined)?.mode ??
          (workspace.planMode ? "plan" : "fast"),
      },
      chatMessages: Array.isArray(record.chatMessages)
        ? (record.chatMessages as VibeChatMessage[])
        : Array.isArray(workspace.chatMessages)
          ? workspace.chatMessages
          : [],
    };
  }

  if (record.workspace && typeof record.workspace === "object") {
    const workspace = record.workspace as WorkspaceState;
    return normalizeSavedSession(
      {
        version: 1,
        projectId: workspace.projectId || fallback?.id,
        projectName: fallback?.name ?? "Vibe project",
        savedAt:
          typeof record.savedAt === "string"
            ? new Date(record.savedAt).getTime()
            : typeof record.savedAt === "number"
              ? record.savedAt
              : Date.now(),
        workspace,
        ui: record.ui,
        chatMessages: record.chatMessages,
      },
      fallback,
    );
  }

  return null;
}

export function sessionWorkspaceRichness(session: SavedProjectSession) {
  const ws = session.workspace;
  return (
    ws.thinkingLines.length +
    ws.statusUpdates.length +
    ws.terminalLogs.length +
    Object.keys(ws.files).length +
    ws.planMd.length +
    session.chatMessages.length
  );
}

export function refreshSessionFromApi(
  session: SavedProjectSession,
  project: { id: string; name: string; prompt?: string; mode?: string; updatedAt?: string },
  data: {
    files: Array<{ path: string; content: string }>;
    plan?: string;
    project?: { prompt?: string; mode?: string };
  },
): SavedProjectSession {
  const metadata = data.project ?? project;
  const prompt = metadata.prompt || project.prompt || session.workspace.prompt || project.name;
  const planMd =
    session.workspace.planMd ||
    data.plan ||
    planFromFiles(data.files ?? []);
  const files = Object.fromEntries(
    (data.files ?? [])
      .filter((file) => !/(^|\/)node_modules(\/|$)/.test(file.path))
      .map((file) => {
        const existing = session.workspace.files[file.path];
        return [
          file.path,
          existing
            ? { ...existing, code: file.content, status: "complete" as const }
            : {
                path: file.path,
                action: "create" as const,
                status: "complete" as const,
                language: inferLanguage(file.path),
                code: file.content,
              },
        ];
      }),
  );
  const filePaths = Object.keys(files);
  const fileQueue =
    session.workspace.fileQueue.length > 0
      ? session.workspace.fileQueue
      : filePaths.map((path) => ({
          path,
          action: "create" as const,
          reason: "Saved project file",
        }));

  return {
    ...session,
    projectId: project.id,
    projectName: project.name,
    savedAt: Date.now(),
    workspace: {
      ...session.workspace,
      projectId: project.id,
      prompt,
      planMode: (metadata.mode || project.mode) !== "fast",
      planMd,
      files,
      fileQueue,
      activeFilePath: session.workspace.activeFilePath ?? filePaths[0] ?? null,
      stage: session.workspace.stage === "idle" ? "complete" : session.workspace.stage,
      preview:
        session.workspace.preview?.status === "ready" || session.workspace.stage === "complete"
          ? { status: "ready", url: session.workspace.preview?.url }
          : session.workspace.preview,
      restored: true,
      taskId: null,
      currentStreamingFile: null,
    },
    ui: {
      ...session.ui,
      planApproved: session.ui.planApproved ?? true,
      thinkingCollapsed: session.ui.thinkingCollapsed ?? true,
    },
    chatMessages: session.chatMessages.length > 0 ? session.chatMessages : session.workspace.chatMessages,
  };
}

export async function loadProjectSessionFromServer(
  projectId: string,
  fallback?: { id: string; name: string },
): Promise<SavedProjectSession | null> {
  try {
    const response = await fetch(`/api/vibe/projects/${encodeURIComponent(projectId)}/session`);
    if (!response.ok) return null;
    const data = (await response.json()) as { session?: unknown };
    return normalizeSavedSession(data?.session, fallback ?? { id: projectId, name: "Vibe project" });
  } catch {
    return null;
  }
}

export async function loadProjectSessionAsync(
  projectId: string,
  fallback?: { id: string; name: string },
): Promise<SavedProjectSession | null> {
  const local = loadProjectSession(projectId);
  const remote = await loadProjectSessionFromServer(projectId, fallback ?? { id: projectId, name: local?.projectName ?? "Vibe project" });
  if (local && remote) {
    return sessionWorkspaceRichness(local) >= sessionWorkspaceRichness(remote) ? local : remote;
  }
  const session = local ?? remote;
  if (session) saveProjectSession(session);
  return session;
}

export function toCompactSession(session: SavedProjectSession): SavedProjectSession {
  return {
    ...session,
    workspace: {
      ...session.workspace,
      files: Object.fromEntries(
        Object.entries(session.workspace.files).map(([filePath, file]) => [
          filePath,
          { ...file, code: file.code.length > 4000 ? `${file.code.slice(0, 4000)}\n/* truncated */` : file.code },
        ]),
      ),
    },
  };
}

export async function saveProjectSessionToServer(session: SavedProjectSession) {
  try {
    const payload: SavedProjectSession = {
      ...toCompactSession(session),
      version: 1,
      workspace: {
        ...session.workspace,
        taskId: null,
        currentStreamingFile: null,
        restored: true,
        chatMessages: session.chatMessages,
      },
    };
    await fetch(`/api/vibe/projects/${encodeURIComponent(session.projectId)}/session`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: payload }),
    });
  } catch {
    // Best-effort server backup.
  }
}

export function mergeSessionWithCache(
  fresh: SavedProjectSession,
  cached: SavedProjectSession | null,
): SavedProjectSession {
  if (!cached) return fresh;
  const preferCachedWorkspace = sessionWorkspaceRichness(cached) > sessionWorkspaceRichness(fresh);
  const workspace = preferCachedWorkspace
    ? {
        ...cached.workspace,
        files: { ...fresh.workspace.files, ...cached.workspace.files },
        planMd: cached.workspace.planMd || fresh.workspace.planMd,
        preview: cached.workspace.preview?.url ? cached.workspace.preview : fresh.workspace.preview,
      }
    : {
        ...fresh.workspace,
        thinkingLines: fresh.workspace.thinkingLines.length > 0 ? fresh.workspace.thinkingLines : cached.workspace.thinkingLines,
        statusUpdates: fresh.workspace.statusUpdates.length > 0 ? fresh.workspace.statusUpdates : cached.workspace.statusUpdates,
        terminalLogs: fresh.workspace.terminalLogs.length > 0 ? fresh.workspace.terminalLogs : cached.workspace.terminalLogs,
        webResearch: fresh.workspace.webResearch.lines.length > 0 ? fresh.workspace.webResearch : cached.workspace.webResearch,
        planMd: fresh.workspace.planMd || cached.workspace.planMd,
        chatMessages: cached.chatMessages.length > 0 ? cached.chatMessages : fresh.chatMessages,
      };

  return {
    ...fresh,
    projectName: cached.projectName || fresh.projectName,
    chatMessages: cached.chatMessages.length > 0 ? cached.chatMessages : fresh.chatMessages,
    workspace,
    ui: {
      ...fresh.ui,
      ...cached.ui,
      planApproved: cached.ui.planApproved ?? fresh.ui.planApproved,
      thinkingCollapsed: cached.ui.thinkingCollapsed ?? fresh.ui.thinkingCollapsed,
    },
    savedAt: Date.now(),
  };
}

export function buildSessionFromApi(
  project: {
    id: string;
    name: string;
    prompt?: string;
    mode?: string;
    previewUrl?: string;
    updatedAt?: string;
  },
  data: {
    files: Array<{ path: string; content: string }>;
    plan?: string;
    project?: { prompt?: string; mode?: string; previewUrl?: string };
  },
): SavedProjectSession {
  const metadata = data.project ?? project;
  const prompt = metadata.prompt || project.prompt || project.name;
  const planMode = (metadata.mode || project.mode) !== "fast";
  const files = Object.fromEntries(
    (data.files ?? [])
      .filter((file) => !/(^|\/)node_modules(\/|$)/.test(file.path))
      .map((file) => [
      file.path,
      {
        path: file.path,
        action: "create" as const,
        status: "complete" as const,
        language: inferLanguage(file.path),
        code: file.content,
      },
    ]),
  );
  const filePaths = Object.keys(files);
  const updatedAt = project.updatedAt ? new Date(project.updatedAt).getTime() : Date.now();

  return {
    version: 1,
    projectId: project.id,
    projectName: project.name,
    savedAt: Date.now(),
    workspace: {
      projectId: project.id,
      taskId: null,
      prompt,
      planMode,
      stage: "complete",
      thinkingLines: [
        {
          id: "restored-thinking",
          text: "Restored saved project — resuming where you left off.",
          timestamp: updatedAt,
        },
      ],
      statusUpdates: [
        {
          id: "restored-status",
          text: "Project files loaded from disk.",
          timestamp: updatedAt,
        },
      ],
      webResearch: { startedAt: null, completedAt: null, lines: [] },
      files,
      activeFilePath: filePaths[0] ?? null,
      fileQueue: filePaths.map((path) => ({
        path,
        action: "create" as const,
        reason: "Saved project file",
      })),
      currentStreamingFile: null,
      terminalLogs: [],
      preview: { status: "ready" },
      checkpoints: [],
      startedAt: updatedAt,
      completedAt: updatedAt,
      error: null,
      planMd: data.plan ?? planFromFiles(data.files ?? []),
      chatMessages: [
        {
          id: `user-${project.id}`,
          role: "user",
          content: prompt,
          timestamp: updatedAt,
        },
        {
          id: `assistant-${project.id}`,
          role: "assistant",
          content: "Project restored. Files, preview, and workspace state are ready.",
          timestamp: updatedAt,
        },
      ],
      actions: {},
      restored: true,
    },
    ui: {
      planApproved: true,
      planExpanded: false,
      thinkingCollapsed: true,
      mode: planMode ? "plan" : "fast",
    },
    chatMessages: [
      {
        id: `user-${project.id}`,
        role: "user",
        content: prompt,
        timestamp: updatedAt,
      },
      {
        id: `assistant-${project.id}`,
        role: "assistant",
        content: "Project restored. Files, preview, and workspace state are ready.",
        timestamp: updatedAt,
      },
    ],
  };
}
