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
  /** Detected platform: web (default) or ios for Swift/Xcode projects. */
  platform?: "web" | "ios";
};

export type ProjectGitStatus = {
  initialized: boolean;
  branch: string | null;
  remoteUrl: string | null;
  ahead: number;
  behind: number;
  changes: Array<{ path: string; status: "A" | "M" | "D" | "R" | "?"; staged: boolean }>;
};

export type IosSimulatorInfo = {
  udid: string;
  name: string;
  version: string;
  booted: boolean;
};

export type IosStatus = {
  mac: boolean;
  xcode: string | null;
  simulators: IosSimulatorInfo[];
  booted: IosSimulatorInfo | null;
  bridgeRunning: boolean;
  bridgeUrl: string | null;
};

export type SwiftWasmStatus = {
  configured: boolean;
  compilerUrl: string | null;
  framework: "ElementaryUI";
  target: string;
  devices: string[];
};

export type MobilePreviewStatus = {
  configured: boolean;
  xtool: boolean;
  goIos: boolean;
  host: string;
  requiresPhysicalDevice: boolean;
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

export type UploadedCodeAttachment = {
  name: string;
  relativePath?: string;
  type: string;
  data: string;
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

  renameProject: (id: string, name: string) =>
    json<{ project: VibeProject }>(`/api/vibe/projects/${enc(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    }).then((r) => r.project),

  githubStatus: () => json<{ connected: boolean; account: { login: string; avatarUrl?: string } | null; authAvailable: boolean; message: string }>("/api/vibe/github/status"),

  projectGitStatus: (id: string) => json<ProjectGitStatus>(`/api/vibe/projects/${enc(id)}/git/status`),

  initProjectGit: (id: string) => json<ProjectGitStatus>(`/api/vibe/projects/${enc(id)}/git/init`, { method: "POST" }),

  stageProjectGitPath: (id: string, path: string, staged: boolean) => json<ProjectGitStatus>(`/api/vibe/projects/${enc(id)}/git/stage`, {
    method: "POST", body: JSON.stringify({ path, staged }),
  }),

  commitProjectGit: (id: string, message: string) => json<{ oid: string; status: ProjectGitStatus }>(`/api/vibe/projects/${enc(id)}/git/commit`, {
    method: "POST", body: JSON.stringify({ message }),
  }),

  projectGitBranches: (id: string) => json<{ current: string | null; branches: string[] }>(`/api/vibe/projects/${enc(id)}/git/branches`),

  createProjectGitBranch: (id: string, name: string) => json<{ current: string | null; branches: string[] }>(`/api/vibe/projects/${enc(id)}/git/branches`, {
    method: "POST", body: JSON.stringify({ name }),
  }),

  checkoutProjectGitBranch: (id: string, branch: string) => json<{ current: string | null; branches: string[] }>(`/api/vibe/projects/${enc(id)}/git/checkout`, {
    method: "POST", body: JSON.stringify({ branch }),
  }),

  iosStatus: () => json<IosStatus>("/api/ios/status"),

  swiftWasmStatus: () => json<SwiftWasmStatus>("/api/swift-wasm/status"),

  swiftWasmBuild: (projectId: string) => json<{ ok: boolean; bundleUrl?: string; buildId?: string; diagnostics?: string[]; error?: string }>(
    `/api/swift-wasm/projects/${enc(projectId)}/build`,
    { method: "POST" },
  ),

  swiftWasmInspect: (projectId: string) =>
    json<{ metadata: { file: string; name: string; line: number } | null }>(
      `/api/swift-wasm/projects/${enc(projectId)}/inspect`,
    ),

  swiftWasmReadiness: (projectId: string) =>
    json<{ ready: boolean; kind: "package" | null; projectPath: string | null }>(
      `/api/swift-wasm/projects/${enc(projectId)}/readiness`,
    ),

  mobilePreviewStatus: () => json<MobilePreviewStatus>("/api/mobile-preview/status"),

  mobilePreviewDevices: () => json<{ devices: string[] }>("/api/mobile-preview/devices"),

  mobilePreviewBuild: (projectId: string, deviceId?: string) => json<{ ok: boolean; bundleId?: string; streamUrl?: string | null; message?: string; error?: string }>(
    `/api/mobile-preview/projects/${enc(projectId)}/build`,
    { method: "POST", body: JSON.stringify(deviceId ? { deviceId } : {}) },
  ),

  mobilePreviewReadiness: (projectId: string) =>
    json<{ ready: boolean; projectPath: string }>(`/api/mobile-preview/projects/${enc(projectId)}/readiness`),

  mobilePreviewInput: (projectId: string, input: Record<string, unknown>) =>
    json<{ ok: boolean; error?: string }>(`/api/mobile-preview/projects/${enc(projectId)}/input`, {
      method: "POST",
      body: JSON.stringify(input),
    }),

  iosStartBridge: () => json<{ ok: boolean; url: string }>("/api/ios/bridge/start", { method: "POST" }),

  iosLaunch: (projectId: string, device?: { name?: string; version?: string }) =>
    json<{
      ok: boolean;
      sessionId?: string;
      controlUrl?: string;
      device?: string;
      version?: string;
      bundleId?: string;
      error?: string;
    }>("/api/ios/launch", {
      method: "POST",
      body: JSON.stringify({ projectId, deviceName: device?.name, iosVersion: device?.version }),
    }),

  iosRelaunch: (projectId: string) =>
    json<{ ok: boolean; error?: string }>("/api/ios/relaunch", {
      method: "POST",
      body: JSON.stringify({ projectId }),
    }),

  iosInspect: (projectId: string) =>
    json<{ metadata: { file: string; name: string; line: number } | null }>(
      `/api/ios/projects/${enc(projectId)}/inspect`,
    ),

  iosReadiness: (projectId: string) =>
    json<{ ready: boolean; kind: "workspace" | "project" | "package" | null; projectPath: string | null }>(
      `/api/ios/projects/${enc(projectId)}/readiness`,
    ),

  sourceEdit: (projectId: string, payload: { file: string; selector: string; property: string; value: string }) =>
    json<{
      applied: boolean;
      error?: string;
      file?: string;
      before?: string;
      after?: string;
      additions?: number;
      deletions?: number;
    }>(`/api/vibe/projects/${enc(projectId)}/source-edit`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  getProject: (id: string) =>
    json<{ project: VibeProject; files: Array<{ path: string; content: string }>; plan: string }>(
      `/api/vibe/projects/${enc(id)}`,
    ),

  writeProjectFile: (id: string, path: string, content: string) =>
    json<{ ok: boolean; files: Array<{ path: string; content: string }> }>(`/api/vibe/projects/${enc(id)}/files`, {
      method: "PUT",
      body: JSON.stringify({ path, content }),
    }),

  createProjectFolder: (id: string, path: string) =>
    json<{ ok: boolean }>(`/api/vibe/projects/${enc(id)}/folders`, {
      method: "POST",
      body: JSON.stringify({ path }),
    }),

  deleteProjectFile: (id: string, path: string, recursive = false) =>
    json<{ ok: boolean }>(`/api/vibe/projects/${enc(id)}/files`, {
      method: "DELETE",
      body: JSON.stringify({ path, recursive }),
    }),

  moveProjectPath: (id: string, from: string, to: string) =>
    json<{ ok: boolean; files: Array<{ path: string; content: string }> }>(`/api/vibe/projects/${enc(id)}/paths`, {
      method: "PATCH",
      body: JSON.stringify({ from, to }),
    }),

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

  renameSession: (projectId: string, sessionId: string, title: string) =>
    json<{ id: string; title: string }>(`/api/opencode/sessions/${enc(projectId)}/${enc(sessionId)}`, {
      method: "PATCH",
      body: JSON.stringify({ title }),
    }),

  deleteSession: (projectId: string, sessionId: string) =>
    json<{ ok: boolean }>(`/api/opencode/sessions/${enc(projectId)}/${enc(sessionId)}`, {
      method: "DELETE",
    }),

  sendPrompt: (projectId: string, sessionId: string, text: string, agent?: string) =>
    json<{ ok: boolean }>(
      `/api/opencode/sessions/${enc(projectId)}/${enc(sessionId)}/prompt`,
      { method: "POST", body: JSON.stringify({ text, agent }) },
    ),

  uploadAttachments: (projectId: string, files: UploadedCodeAttachment[]) =>
    json<{ attachments: Array<{ name: string; path: string; type: string }> }>(
      `/api/opencode/projects/${enc(projectId)}/attachments`,
      { method: "POST", body: JSON.stringify({ files }) },
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
