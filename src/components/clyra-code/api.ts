/**
 * Typed client for the existing Clyra OpenCode harness + vibe project/preview
 * APIs. No new backend: every call maps to a route that already exists in
 * lib/opencode/opencode-routes.ts and server.ts.
 */

export type VibeProject = {
  id: string;
  name: string;
  prompt: string;
  mode: "plan" | "fast";
  status: string;
  createdAt: string;
  updatedAt: string;
  previewUrl?: string;
};

export type FileDiff = {
  file: string;
  before: string;
  after: string;
  additions: number;
  deletions: number;
};

export type OpenCodePart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: string;
  text?: string;
  tool?: string;
  callID?: string;
  state?: {
    status: "pending" | "running" | "completed" | "error";
    input?: Record<string, unknown>;
    output?: string;
    title?: string;
    error?: string;
    metadata?: Record<string, unknown>;
    time?: { start?: number; end?: number };
  };
  tokens?: { input?: number; output?: number; reasoning?: number };
  [key: string]: unknown;
};

export type OpenCodeMessage = {
  info: { id: string; role: "user" | "assistant"; time?: { created?: number } };
  parts: OpenCodePart[];
};

export type PreviewSession = {
  projectId: string;
  status: string;
  url?: string;
  port?: number;
  devCommand?: string;
  lastError?: { message?: string } | null;
};

export type PreviewLogLine = {
  id?: string;
  stream?: string;
  line?: string;
  text?: string;
  timestamp?: number;
};

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof (body as { error?: string })?.error === "string"
      ? (body as { error: string }).error
      : `${url} failed (${response.status})`;
    throw new Error(message);
  }
  return body as T;
}

const enc = encodeURIComponent;

export const api = {
  listProjects: () =>
    json<{ projects: VibeProject[] }>("/api/vibe/projects").then((r) => r.projects ?? []),

  createProject: (name: string, prompt = "") =>
    json<{ project: VibeProject }>("/api/vibe/projects", {
      method: "POST",
      body: JSON.stringify({ name, prompt }),
    }).then((r) => r.project),

  getProject: (id: string) =>
    json<{ project: VibeProject; files: Array<{ path: string; content: string }>; plan: string }>(
      `/api/vibe/projects/${enc(id)}`,
    ),

  openCodeStatus: () =>
    json<{ status: string; model?: string; serverUrl?: string; error?: string }>(
      "/api/opencode/status",
    ),

  startRuntime: (projectId: string) =>
    json<{ projectId: string; serverUrl: string; status: string }>(
      "/api/opencode/runtime/start",
      { method: "POST", body: JSON.stringify({ projectId }) },
    ),

  createSession: (projectId: string, title: string) =>
    json<{ id: string; title: string }>("/api/opencode/sessions", {
      method: "POST",
      body: JSON.stringify({ projectId, title }),
    }),

  listSessions: (projectId: string) =>
    json<Array<{ id: string; title: string; time?: { created?: number; updated?: number } }>>(
      `/api/opencode/sessions/${enc(projectId)}`,
    ),

  sendPrompt: (projectId: string, sessionId: string, text: string, agent?: string) =>
    json<{ ok: boolean }>(
      `/api/opencode/sessions/${enc(projectId)}/${enc(sessionId)}/prompt`,
      { method: "POST", body: JSON.stringify({ text, agent }) },
    ),

  abortSession: (projectId: string, sessionId: string) =>
    json<{ ok: boolean }>(
      `/api/opencode/sessions/${enc(projectId)}/${enc(sessionId)}/abort`,
      { method: "POST" },
    ),

  sessionDiff: (projectId: string, sessionId: string) =>
    json<FileDiff[]>(`/api/opencode/sessions/${enc(projectId)}/${enc(sessionId)}/diff`),

  sessionMessages: (projectId: string, sessionId: string) =>
    json<OpenCodeMessage[]>(
      `/api/opencode/sessions/${enc(projectId)}/${enc(sessionId)}/messages`,
    ),

  replyPermission: (
    projectId: string,
    sessionId: string,
    permissionId: string,
    response: "allow" | "always" | "deny",
  ) =>
    json<{ ok: boolean }>(
      `/api/opencode/sessions/${enc(projectId)}/${enc(sessionId)}/permissions/${enc(permissionId)}`,
      { method: "POST", body: JSON.stringify({ response }) },
    ),

  previewStart: (projectId: string) =>
    json<{ session: PreviewSession }>("/api/vibe/preview/start", {
      method: "POST",
      body: JSON.stringify({ projectId }),
    }).then((r) => r.session),

  previewRestart: (projectId: string) =>
    json<{ session: PreviewSession }>("/api/vibe/preview/restart", {
      method: "POST",
      body: JSON.stringify({ projectId }),
    }).then((r) => r.session),

  previewStatus: (projectId: string) =>
    json<{ session: PreviewSession | null }>(`/api/vibe/preview/status/${enc(projectId)}`).then(
      (r) => r.session,
    ),

  previewLogs: (projectId: string) =>
    json<{ logs: PreviewLogLine[] }>(`/api/vibe/preview/logs/${enc(projectId)}`).then(
      (r) => r.logs ?? [],
    ),

  eventsUrl: (projectId: string) => `/api/opencode/events/${enc(projectId)}`,
};
