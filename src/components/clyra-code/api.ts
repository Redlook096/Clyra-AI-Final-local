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

export type IPhoneDevice = {
  udid: string;
  name: string;
  runtime: string;
  state: "Booted" | "Shutdown" | "Booting" | "Shutting Down";
};

export type IPhoneStatus = {
  mac: boolean;
  arch: "arm64" | "x86_64" | "other";
  xcodeVersion: string | null;
  fastStreamSupported: boolean;
  devices: IPhoneDevice[];
  booted: IPhoneDevice | null;
};

export type XcodeState =
  | "NO_XCODE"
  | "COMMAND_LINE_TOOLS_ONLY"
  | "XCODE_INSTALLED_NOT_SELECTED"
  | "XCODE_NEEDS_FIRST_LAUNCH"
  | "NO_IOS_RUNTIME"
  | "READY";

export type XcodeDiagnosis = {
  state: XcodeState;
  arch: "arm64" | "x86_64" | "other";
  macOSVersion: string | null;
  xcodeAppInstalled: boolean;
  selectedDeveloperDir: string | null;
  xcodeVersion: string | null;
  simctlAvailable: boolean;
  runtimes: Array<{ identifier: string; name: string; version: string; isAvailable: boolean }>;
  deviceTypes: Array<{ identifier: string; name: string }>;
  devices: Array<{ udid: string; name: string; runtime: string; state: string }>;
  xcodesInstalled: boolean;
  message: string;
};

export type IPhoneRunResult = {
  ok: boolean;
  deviceId?: string;
  bundleId?: string;
  streamUrl?: string;
  streamKind?: "iframe" | "img";
  buildOutput?: string;
  error?: string;
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

  iphoneStatus: () => json<IPhoneStatus>("/api/iphone/status"),

  iphoneDevices: () => json<{ devices: IPhoneDevice[] }>("/api/iphone/devices").then((r) => r.devices ?? []),

  iphoneReadiness: (projectId: string) =>
    json<{ ready: boolean; projectPath: string }>(`/api/iphone/projects/${enc(projectId)}/readiness`),

  iphoneRun: (projectId: string, deviceId?: string) =>
    json<IPhoneRunResult>(`/api/iphone/projects/${enc(projectId)}/run`, {
      method: "POST",
      body: JSON.stringify(deviceId ? { deviceId } : {}),
    }),

  iphoneRebuild: (projectId: string) =>
    json<IPhoneRunResult>(`/api/iphone/projects/${enc(projectId)}/rebuild`, { method: "POST" }),

  iphoneRelaunch: (projectId: string) =>
    json<{ ok: boolean; error?: string }>(`/api/iphone/projects/${enc(projectId)}/relaunch`, { method: "POST" }),

  iphoneStop: (projectId: string) =>
    json<{ ok: boolean }>(`/api/iphone/projects/${enc(projectId)}/stop`, { method: "POST" }),

  iphoneControl: (projectId: string, input: Record<string, unknown>) =>
    json<{ ok: boolean; error?: string }>(`/api/iphone/projects/${enc(projectId)}/control`, {
      method: "POST",
      body: JSON.stringify(input),
    }),

  iphoneLogs: (projectId: string) =>
    json<{ logs: Array<{ timestamp: number; level: string; source: string; message: string }> }>(
      `/api/iphone/projects/${enc(projectId)}/logs`,
    ),

  iphoneSetupDiagnose: () => json<XcodeDiagnosis>("/api/iphone/setup/diagnose"),

  iphoneXcodeVersions: () =>
    json<{ versions: Array<{ version: string; build: string; installed: boolean }> }>("/api/iphone/setup/xcode-versions"),

  iphoneInstallCommand: (version: string) =>
    json<{ command: string }>(`/api/iphone/setup/install-command?version=${enc(version)}`),

  iphoneRecommendedXcode: () =>
    json<{ recommendedXcode: string | null; compatibleXcodes: string[]; blockedReason: string | null; sourceEvidence: string[] }>(
      "/api/iphone/setup/recommended-xcode",
    ),

  iphoneDiskSpace: () =>
    json<{ availableGB: number; requiredGB: number; breakdown: Array<{ label: string; gb: number }>; sufficient: boolean; shortfallGB: number }>(
      "/api/iphone/setup/disk-space",
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
