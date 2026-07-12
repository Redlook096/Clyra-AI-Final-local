import { useCallback, useEffect, useMemo, useState, useRef } from "react";
import { AnimatePresence, motion } from "motion/react";
import { AiOrb, type OrbColorTheme } from "./AiOrb";
type HarnessMode = "plan" | "fast";
import {
  AlertTriangle,
  Brain,
  Check,
  CheckCircle2,
  ChevronDown,
  Copy,
  Download,
  Edit2,
  Eye,
  FileCode2,
  GitBranch,
  ListTodo,
  LoaderCircle,
  Maximize2,
  Minimize2,
  MoreHorizontal,
  Paperclip,
  Pencil,
  Rocket,
  Save,
  Search,
  Send,
  Sparkles,
  TerminalSquare,
  Trash2,
  ArrowUp,
  FolderOpen,
  Grid3X3,
  LayoutList,
  X,
} from "lucide-react";
import { cn } from "../lib/utils";
import { ShiningText } from "./ui/shining-text";
import { MarkdownMessageContent } from "./MarkdownMessageContent";

// --- New Imports for the Advanced Workspace ---
import { useVibeCoderWorkspace, type ProjectFile } from "../hooks/useVibeCoderWorkspace";
import { ThinkingStatus } from "./vibe-coder/thinking/ThinkingStatus";
import { MiniCodeBoxQueue } from "./vibe-coder/code/MiniCodeBoxQueue";
import { LivePreviewPanel } from "./vibe-coder/preview/LivePreviewPanel";
import {
  buildSessionFromApi,
  deleteProjectSession,
  loadProjectSessionAsync,
  mergeSessionWithCache,
  projectThumbnailUrl,
  refreshSessionFromApi,
  saveProjectSession,
  saveProjectSessionToServer,
  sessionWorkspaceRichness,
  type SavedProjectSession,
  type VibeChatMessage,
} from "../lib/vibe-coder/project-session";

// Fallback/Mock Composer for the Welcome Page

// Relative time util
function relativeTime(iso: string) {
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "Just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

type AgentActivityStatus = "pending" | "active" | "success" | "warning" | "error" | "cancelled";
type AgentActivityType = "stage" | "plan" | "file" | "terminal" | "preview" | "checkpoint" | "error" | "complete";

type AgentActivityItem = {
  id: string;
  type: AgentActivityType;
  status: AgentActivityStatus;
  title: string;
  description?: string;
  timestamp: number;
  durationMs?: number;
  details?: string;
  filePath?: string;
  command?: string;
};

function isUserVisibleTerminalCommand(command?: string) {
  if (!command) return false;
  const clean = command.trim();
  if (!clean) return false;
  if (isBackgroundFileWriteCommand(clean)) return false;
  if (/^(ls|pwd|head|tail|cat|tee|find|grep|rg|sed|awk)\b/i.test(clean)) return false;
  return /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(build|lint|test|typecheck|dev|preview|install)\b/i.test(clean) ||
    /^(npx\s+)?(vite|tsc|eslint|vitest|jest|playwright)\b/i.test(clean);
}

function buildPlanThinkingSummary(prompt: string) {
  const clean = (prompt || "").trim().replace(/\s+/g, " ");
  const short = clean.length > 140 ? `${clean.slice(0, 140).trim()}…` : clean;
  const focus = short ? `The user wants: “${short}”.` : "The user wants a new build request.";
  return [
    focus,
    "I need to turn that into a clear PLAN.md with the required features, interactions, UI polish, and responsive behaviour.",
    "I’ll also include the exact files to touch and a verification checklist so implementation is predictable and high quality.",
  ].join(" ");
}

function isBackgroundFileWriteCommand(command: string) {
  return /\b(cat|tee)\s+>/.test(command) ||
    /<<\s*['"]?[A-Z0-9_]+['"]?/i.test(command) ||
    /^sh\s+-c\s+['"]?\s*(cat|tee)\b/i.test(command) ||
    /\/tmp\/plan\.md/i.test(command);
}

function formatElapsed(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function cleanActivityText(text: string) {
  return text.replace(/\s+/g, " ").replace(/\.{3,}$/g, "").trim();
}

function stageLabel(stage: string) {
  const labels: Record<string, string> = {
    "task-created": "Starting",
    "inspecting-existing-project": "Inspecting",
    "researching-web": "Searching web",
    "writing-plan-md": "Planning",
    "extracting-file-queue": "Queueing",
    planning: "Plan review",
    "creating-checkpoint": "Checkpointing",
    "generating-file": "Coding",
    "editing-file": "Editing",
    "running-command": "Checking",
    "starting-preview": "Previewing",
    "validating-preview": "Preview ready",
    complete: "Complete",
    failed: "Failed",
    cancelled: "Cancelled",
  };
  return labels[stage] ?? "Working";
}

function nextStepLabel(state: {
  stage: string;
  currentStreamingFile: string | null;
  terminalLogs: Array<{ command?: string; output: string }>;
  preview: { status: string; url?: string };
}) {
  if (state.currentStreamingFile) return `Generating ${state.currentStreamingFile}`;
  if (state.stage === "creating-checkpoint") return "Creating checkpoint";
  if (state.stage === "generating-file" || state.stage === "editing-file") return "Streaming file changes";
  if (state.stage === "running-command") {
    const latestCommand = [...state.terminalLogs].reverse().find((log) => isUserVisibleTerminalCommand(log.command))?.command;
    return latestCommand ? `Running ${latestCommand}` : "Running build validation";
  }
  if (state.stage === "starting-preview") return "Starting live preview";
  if (state.stage === "validating-preview") return "Checking preview";
  if (state.stage === "complete") return state.preview.url ? "Preview ready" : "Final review complete";
  return "Preparing next step";
}

function inferVisibleRequestType(prompt: string) {
  const lower = prompt.toLowerCase();
  if (/\blanding|website|marketing|home page\b/.test(lower)) return "a landing page";
  if (/\bcalculator|calc\b/.test(lower)) return "a calculator app";
  if (/\bdashboard|admin|crm\b/.test(lower)) return "a dashboard";
  if (/\bchat\b/.test(lower)) return "a chat experience";
  if (/\bcomponent|button|modal|card\b/.test(lower)) return "a component";
  if (/\bapp|tool|platform|saas\b/.test(lower)) return "a full app";
  return "a build request";
}

function inferVisibleTarget(prompt: string) {
  const named = prompt.match(/\b(?:called|named|for)\s+([A-Z][A-Za-z0-9]*(?:\s+[A-Z][A-Za-z0-9]*)?)/);
  if (named?.[1]) return named[1].trim();
  if (/\bopen\s*ai\b|\bopenai\b/i.test(prompt)) return "OpenAI";
  if (/\bflowpilot\b/i.test(prompt)) return "FlowPilot";
  return "the requested product";
}

function buildVisibleThoughtText(prompt: string) {
  const requestType = inferVisibleRequestType(prompt);
  const target = inferVisibleTarget(prompt);
  const isCurrentApp = /\b(current app|this app|ai assistant|clyra|vibe coder)\b/i.test(prompt);
  const buildKind = isCurrentApp ? "a current app feature" : requestType === "a component" ? "a component" : requestType === "a landing page" ? "an independent product page" : "an independent product";
  const scope = requestType === "a landing page"
    ? "navbar, hero, product preview, auth UI, CTAs, FAQ, footer, animations, and mobile layout"
    : "the expected screens, working interactions, loading states, responsive layout, and validation";

  return [
    `I'm interpreting your request as: ${requestType} for ${target}.`,
    `I'll build it as ${buildKind}, with ${scope} included.`,
    "I'm checking the existing project so I can reuse current components, Tailwind styling, and routing/state without breaking anything.",
    "The main things I need to plan are structure, interactions, animations, responsive behaviour, validation, and live preview.",
    "I'll avoid assuming this is for the AI assistant unless you say so, then create/update PLAN.md and generate the files one by one.",
    "Next I'll run build checks and show the result in live preview.",
  ].join("\n\n");
}

function buildActivityItems({
  state,
  planApproved,
}: {
  state: ReturnType<typeof useVibeCoderWorkspace>["state"];
  planApproved: boolean;
}) {
  const items: AgentActivityItem[] = [];
  const startedAt = state.startedAt ?? Date.now();
  const seenThoughts = new Set<string>();
  const latestLineId = state.thinkingLines[state.thinkingLines.length - 1]?.id;

  for (const line of state.thinkingLines) {
    const text = cleanActivityText(line.text);
    if (!text || seenThoughts.has(text)) continue;
    seenThoughts.add(text);
    items.push({
      id: `thought-${line.id}`,
      type: "stage",
      status: line.id === latestLineId && state.stage !== "complete" && state.stage !== "failed" ? "active" : "success",
      title: text,
      description: line.id === latestLineId ? "Current agent focus." : "Completed agent step.",
      timestamp: line.timestamp,
    });
  }

  if (state.planMd) {
    items.push({
      id: "plan-md",
      type: "plan",
      status: planApproved ? "success" : "active",
      title: planApproved ? "PLAN.md approved" : "PLAN.md ready for review",
      description: planApproved
        ? "The approved plan is now the source of truth for file generation."
        : "Review the plan before implementation starts.",
      timestamp: startedAt + 1200,
      filePath: "PLAN.md",
    });
  }

  if (state.fileQueue.length > 0) {
    items.push({
      id: "file-queue",
      type: "file",
      status: planApproved ? "success" : "pending",
      title: "File queue prepared",
      description: `${state.fileQueue.length} files queued from PLAN.md.`,
      timestamp: startedAt + 1600,
    });
  }

  for (const file of Object.values(state.files)) {
    items.push({
      id: `file-${file.path}`,
      type: "file",
      status: file.status === "error" ? "error" : file.status === "complete" ? "success" : "active",
      title: `${file.status === "complete" ? file.action === "edit" ? "Edited" : "Created" : file.action === "edit" ? "Editing" : "Generating"} ${file.path}`,
      description: file.status === "complete"
        ? `${file.added ?? 0} additions, ${file.removed ?? 0} removals.`
        : "Streaming through the existing mini code box.",
      timestamp: startedAt + 2200 + items.length * 70,
      filePath: file.path,
    });
  }

  const commandLogs = state.terminalLogs.filter((log) => isUserVisibleTerminalCommand(log.command));
  commandLogs.forEach((log, index) => {
    const failed = /Command exited with code (?!0\b)/.test(log.output);
    const passed = log.output.includes("Command exited with code 0");
    items.push({
      id: `terminal-${log.id}`,
      type: "terminal",
      status: failed ? "error" : passed ? "success" : "active",
      title: log.command ? log.output.replace(/^>\s*/, "") : passed ? "Build check passed" : failed ? "Build check failed" : "Terminal output",
      description: passed ? "Command completed successfully." : failed ? "The harness will pause or patch before continuing." : "Running real terminal command.",
      timestamp: log.timestamp,
      command: log.command,
      details: log.output,
    });
  });

  for (const checkpoint of state.checkpoints) {
    items.push({
      id: `checkpoint-${checkpoint.id}`,
      type: "checkpoint",
      status: "success",
      title: "Checkpoint created",
      description: checkpoint.label,
      timestamp: checkpoint.createdAt,
    });
  }

  if (state.preview.status === "starting") {
    items.push({
      id: "preview-starting",
      type: "preview",
      status: "active",
      title: "Starting live preview",
      description: "Detecting the project dev server and preview URL.",
      timestamp: Date.now(),
    });
  }

  if (state.preview.status === "ready") {
    items.push({
      id: "preview-ready",
      type: "preview",
      status: "success",
      title: "Preview ready",
      description: state.preview.url ? `Loaded ${state.preview.url}.` : "The project is running in live preview.",
      timestamp: Date.now(),
    });
  }

  if (state.error) {
    items.push({
      id: "task-error",
      type: "error",
      status: "error",
      title: "Build paused",
      description: state.error,
      timestamp: state.completedAt ?? Date.now(),
    });
  }

  return items;
}

export default function VibeCoderWorkspace({ orbColorTheme = "default" }: { orbColorTheme?: OrbColorTheme }) {
  const { state, startTask, cancelTask, approvePlan, loadSavedProject, resetToIdle } = useVibeCoderWorkspace("project-advanced-vibe");

  const [mode, setMode] = useState<"plan" | "fast">("plan");
  const [promptInput, setPromptInput] = useState("");
  const [projects, setProjects] = useState<any[]>([]);
  const [attachedFiles, setAttachedFiles] = useState<string[]>([]);
  const [planExpanded, setPlanExpanded] = useState(false);
  const [planApproved, setPlanApproved] = useState(false);
  const [planChangeMode, setPlanChangeMode] = useState(false);
  const [welcomeView, setWelcomeView] = useState<"home" | "projects">("home");
  const [openProjectMenu, setOpenProjectMenu] = useState<string | null>(null);
  const [projectDialog, setProjectDialog] = useState<{ type: "rename" | "delete"; project: any } | null>(null);
  const [projectRename, setProjectRename] = useState("");
  const [activeProjectName, setActiveProjectName] = useState("Vibe project");
  const [chatMessages, setChatMessages] = useState<VibeChatMessage[]>([]);
  const [skipEnterAnimation, setSkipEnterAnimation] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const activeScrollRef = useRef<HTMLDivElement | null>(null);
  const welcomeScrollRef = useRef<HTMLDivElement | null>(null);
  const taskIdRef = useRef<string | undefined>(undefined);
  const [previewAutofixActive, setPreviewAutofixActive] = useState(false);
  const [elapsedNow, setElapsedNow] = useState(Date.now());
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const [thinkingCollapsed, setThinkingCollapsed] = useState(false);

  const elapsedSinceStart = state.startedAt ? elapsedNow - state.startedAt : 0;
  const planReadyDelayPassed = elapsedSinceStart >= 10000;
  const canReviewPlan = Boolean(state.planMd) && state.planMode;
  const planReady = canReviewPlan && state.fileQueue.length > 0 && planReadyDelayPassed;
  const thinkingIsResting = state.stage === "complete" || (state.planMode && planReady);

  useEffect(() => {
    if (thinkingIsResting) {
      const timer = window.setTimeout(() => setThinkingCollapsed(true), 1000);
      return () => window.clearTimeout(timer);
    } else {
      setThinkingCollapsed(false);
    }
  }, [thinkingIsResting]);

  const fetchJson = async <T,>(url: string, init?: RequestInit): Promise<T> => {
    const response = await fetch(url, init);
    if (!response.ok) throw new Error("Fetch failed");
    return response.json();
  };

  const loadProjects = useCallback(async () => {
    try {
      const data = await fetchJson<{ projects: any[] }>("/api/vibe/projects");
      setProjects(data.projects ?? []);
    } catch (error) {
      console.warn("Failed to load Vibe projects", error);
    }
  }, []);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  const persistCurrentSession = useCallback(() => {
    if (state.stage === "idle" || !state.projectId) return;
    const session: SavedProjectSession = {
      version: 1,
      projectId: state.projectId,
      projectName: activeProjectName,
      savedAt: Date.now(),
      workspace: {
        ...state,
        currentStreamingFile: null,
        taskId: null,
      },
      ui: {
        planApproved,
        planExpanded,
        thinkingCollapsed,
        mode,
      },
      chatMessages,
    };
    saveProjectSession(session);
    void saveProjectSessionToServer(session);
  }, [
    activeProjectName,
    chatMessages,
    mode,
    planApproved,
    planExpanded,
    state,
    thinkingCollapsed,
  ]);

  const applySavedSession = useCallback(
    (session: SavedProjectSession) => {
      setSkipEnterAnimation(true);
      loadSavedProject(session.workspace);
      setActiveProjectName(session.projectName);
      setChatMessages(session.chatMessages);
      setMode(session.ui.mode);
      setPlanApproved(session.ui.planApproved);
      setPlanExpanded(session.ui.planExpanded);
      setThinkingCollapsed(session.ui.thinkingCollapsed);
      setPlanChangeMode(false);
      setPromptInput("");
      setWelcomeView("home");
      setOpenProjectMenu(null);
    },
    [loadSavedProject],
  );

  useEffect(() => {
    if (state.stage === "idle" || !state.projectId) return;
    const timer = window.setTimeout(() => persistCurrentSession(), 350);
    return () => window.clearTimeout(timer);
  }, [
    chatMessages,
    persistCurrentSession,
    state.completedAt,
    state.files,
    state.planMd,
    state.preview.url,
    state.projectId,
    state.stage,
  ]);

  useEffect(() => {
    const match = projects.find((project) => project.id === state.projectId);
    if (match?.name) setActiveProjectName(match.name);
  }, [projects, state.projectId]);

  useEffect(() => {
    if (state.stage !== "complete" || !state.completedAt) return;
    setChatMessages((prev) => {
      const id = `assistant-complete-${state.projectId}-${state.completedAt}`;
      if (prev.some((message) => message.id === id)) return prev;
      return [
        ...prev,
        {
          id,
          role: "assistant",
          content: "Build complete. Files, validation, and preview are ready.",
          timestamp: state.completedAt ?? Date.now(),
        },
      ];
    });
  }, [state.completedAt, state.projectId, state.stage]);

  useEffect(() => {
    if (state.stage === "idle") return;
    const timer = window.setInterval(() => setElapsedNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [state.stage]);

  useEffect(() => {
    if (!state.taskId || taskIdRef.current === state.taskId) return;
    taskIdRef.current = state.taskId;
    setPlanChangeMode(false);
    if (previewAutofixActive) {
      setPlanApproved(true);
      setPlanExpanded(false);
      return;
    }
    setPlanExpanded(true);
    setPlanApproved(!state.planMode);
  }, [previewAutofixActive, state.planMode, state.taskId]);

  useEffect(() => {
    if (previewAutofixActive && (state.stage === "complete" || state.stage === "failed" || state.stage === "cancelled")) {
      setPreviewAutofixActive(false);
    }
  }, [previewAutofixActive, state.stage]);

  useEffect(() => {
    if (!state.planMode || !state.planMd || planApproved) return;
    setPlanExpanded(true);
  }, [state.planMd, state.planMode, planApproved]);

  const handleActiveScroll = useCallback(() => {
    const element = activeScrollRef.current;
    if (!element) return;
    const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 140;
    setShowJumpToLatest(!nearBottom);
  }, []);

  const jumpToLatest = useCallback(() => {
    const element = activeScrollRef.current;
    if (!element) return;
    element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
    setShowJumpToLatest(false);
  }, []);

  const activeActivityItems = buildActivityItems({ state, planApproved });
  const activeScrollSignal = [
    state.stage,
    state.thinkingLines.length,
    activeActivityItems.length,
    Object.keys(state.files).length,
    state.terminalLogs.length,
    state.planMd.length,
    state.preview.status,
    planApproved ? "approved" : "reviewing",
  ].join(":");

  useEffect(() => {
    if (state.stage === "idle") return;
    const element = activeScrollRef.current;
    if (!element) return;
    const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 170;
    if (!nearBottom) {
      setShowJumpToLatest(true);
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeScrollSignal, state.stage]);

  const handleSubmit = async (overridePrompt?: string) => {
    const cleanPrompt = (typeof overridePrompt === "string" ? overridePrompt : promptInput).trim();
    if (!cleanPrompt) return;
    persistCurrentSession();
    setSkipEnterAnimation(false);
    setPlanExpanded(false);
    setPlanChangeMode(false);
    setPlanApproved(!mode || mode === "fast");
    setChatMessages((prev) => [
      ...prev,
      {
        id: `user-${Date.now()}`,
        role: "user",
        content: cleanPrompt,
        timestamp: Date.now(),
      },
    ]);
    await startTask(cleanPrompt, mode === "plan");
    setPromptInput("");
  };

  const handlePlanRevisionSubmit = async () => {
    const requestedChange = promptInput.trim();
    if (!requestedChange) return;
    await handleSubmit(`${state.prompt}\n\nPlan revision request: ${requestedChange}`);
  };

  useEffect(() => {
    if (state.stage !== "idle") return;
    const frame = window.requestAnimationFrame(() => {
      welcomeScrollRef.current?.scrollTo({ top: 0, behavior: "auto" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [state.stage, projects.length]);

  const renameProject = useCallback(async () => {
    if (!projectDialog || projectDialog.type !== "rename" || !projectRename.trim()) return;
    await fetchJson(`/api/vibe/projects/${projectDialog.project.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: projectRename.trim() }),
    });
    setProjectDialog(null);
    setProjectRename("");
    setOpenProjectMenu(null);
    await loadProjects();
  }, [fetchJson, loadProjects, projectDialog, projectRename]);

  const deleteProject = useCallback(async () => {
    if (!projectDialog || projectDialog.type !== "delete") return;
    await fetchJson(`/api/vibe/projects/${projectDialog.project.id}`, { method: "DELETE" });
    deleteProjectSession(projectDialog.project.id);
    if (state.projectId === projectDialog.project.id) {
      resetToIdle();
      setChatMessages([]);
      setActiveProjectName("Vibe project");
    }
    setProjectDialog(null);
    setOpenProjectMenu(null);
    await loadProjects();
  }, [fetchJson, loadProjects, projectDialog, resetToIdle, state.projectId]);

  const openProject = useCallback(
    async (project: any) => {
      try {
        persistCurrentSession();
        const [cached, data] = await Promise.all([
          loadProjectSessionAsync(project.id, { id: project.id, name: project.name }),
          fetchJson<{
            project: any;
            files: Array<{ path: string; content: string }>;
            plan?: string;
          }>(`/api/vibe/projects/${encodeURIComponent(project.id)}`),
        ]);

        const built = buildSessionFromApi(project, data);
        let session = cached
          ? refreshSessionFromApi(mergeSessionWithCache(built, cached), project, data)
          : built;

        if (cached && sessionWorkspaceRichness(cached) > sessionWorkspaceRichness(session)) {
          session = refreshSessionFromApi(mergeSessionWithCache(session, cached), project, data);
        }

        saveProjectSession(session);
        void saveProjectSessionToServer(session);
        applySavedSession(session);
      } catch (error) {
        console.warn("Failed to open Vibe project", error);
      }
    },
    [applySavedSession, fetchJson, persistCurrentSession],
  );

  const handlePreviewAutofix = useCallback(
    (errMsg: string) => {
      const fixId = `autofix-${state.projectId}-${Date.now()}`;
      const userFacing = "I'm seeing an error in the preview. Can you fix it?";
      setPreviewAutofixActive(true);
      setPlanChangeMode(false);
      setPlanApproved(true);
      setChatMessages((prev) => {
        if (prev.some((message) => message.id.startsWith(`autofix-${state.projectId}`))) return prev;
        return [
          ...prev,
          {
            id: fixId,
            role: "user",
            content: userFacing,
            timestamp: Date.now(),
          },
          {
            id: `${fixId}-assistant`,
            role: "assistant",
            content: "I'll analyze the preview error and patch the build.",
            timestamp: Date.now(),
          },
        ];
      });
      const fixPrompt = `Fix this preview error:\n${errMsg}`;
      void startTask(fixPrompt, false);
    },
    [startTask, state.projectId],
  );

  useEffect(() => {
    if (!skipEnterAnimation || state.stage === "idle") return;
    const frame = window.requestAnimationFrame(() => {
      activeScrollRef.current?.scrollTo({
        top: activeScrollRef.current.scrollHeight,
        behavior: "auto",
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [skipEnterAnimation, state.projectId, state.stage]);

  if (state.stage !== "idle") {
    const hasSuccessfulBuild = state.terminalLogs.some((log) =>
      log.output.includes("Command exited with code 0"),
    );
    const shouldShowPreview =
      state.preview.status === "ready" ||
      state.stage === "complete" ||
      hasSuccessfulBuild;

    const generatedFiles = Object.values(state.files);
    const elapsedSinceStart = state.startedAt ? elapsedNow - state.startedAt : 0;
    const planBarDelayPassed = elapsedSinceStart > 5000;
    const canShowPlanCard =
      state.planMode &&
      planBarDelayPassed &&
      state.stage !== "failed" &&
      state.stage !== "cancelled" &&
      thinkingCollapsed;
    const showBuildStream = !state.planMode || planApproved;
    const restoredWorkspaceKey = skipEnterAnimation ? `restored:${state.projectId}` : null;
    const visibleChatMessages =
      chatMessages.length > 0
        ? skipEnterAnimation
          ? chatMessages
          : chatMessages.filter((message) => message.role === "user")
        : [
            {
              id: "prompt",
              role: "user" as const,
              content: state.prompt,
              timestamp: state.startedAt ?? Date.now(),
            },
          ];

    return (
      <>
      <div className="relative flex h-full min-h-0 w-full overflow-hidden bg-white text-slate-950">
        <motion.section
          layout
          transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
          className={cn(
            "flex min-h-0 flex-col transition-[width,max-width] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)]",
            shouldShowPreview
              ? "w-[36%] min-w-[360px] max-w-[500px] border-r border-slate-200/70"
              : "mx-auto w-full max-w-[920px]",
            "relative",
          )}
        >
          <div
            ref={activeScrollRef}
            onScroll={handleActiveScroll}
            className="clyra-visible-scrollbar flex min-h-0 flex-1 flex-col overflow-y-auto px-5 pb-52 pt-14 sm:px-8"
          >
            <motion.div
              initial={skipEnterAnimation ? false : { opacity: 0, y: 24, scale: 0.985 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              transition={{ duration: skipEnterAnimation ? 0 : 0.42, ease: [0.22, 1, 0.36, 1] }}
              className="space-y-3"
            >
              {visibleChatMessages.map((message) => (
                <div
                  key={message.id}
                  className={cn(
                    "max-w-[78%] rounded-[26px] border px-5 py-3 text-left text-[15px] font-semibold leading-relaxed shadow-[0_18px_52px_rgba(15,23,42,0.055)]",
                    message.role === "user"
                      ? "ml-auto border-slate-200/75 bg-white/92 text-slate-900"
                      : "mr-auto border-slate-200/60 bg-slate-50/90 text-slate-700",
                  )}
                >
                  {message.content}
                </div>
              ))}
            </motion.div>

            <motion.div
              initial={skipEnterAnimation ? false : { opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: skipEnterAnimation ? 0 : 0.12, duration: skipEnterAnimation ? 0 : 0.34, ease: [0.22, 1, 0.36, 1] }}
              className="mt-8"
            >
              {state.webResearch.startedAt ? (
                <ThinkingStatus
                  lines={state.webResearch.lines}
                  stage="researching-web"
                  isComplete={Boolean(state.webResearch.completedAt)}
                  hasError={state.stage === "failed"}
                  thoughtText={state.planMode && !planApproved ? buildPlanThinkingSummary(state.prompt) : undefined}
                  resetKey={restoredWorkspaceKey ?? `${state.taskId || state.prompt}:research:${state.webResearch.startedAt}`}
                />
              ) : null}
              {state.stage !== "researching-web" ? (
                <ThinkingStatus
                  lines={state.thinkingLines.filter((line) => !state.webResearch.lines.some((item) => item.id === line.id))}
                  stage={state.stage}
                  isComplete={thinkingIsResting}
                  hasError={state.stage === "failed"}
                  thoughtText={!state.webResearch.startedAt && state.planMode && !planApproved ? buildPlanThinkingSummary(state.prompt) : undefined}
                  resetKey={restoredWorkspaceKey ?? `${state.taskId || state.prompt}:${state.startedAt ?? 0}`}
                />
              ) : null}
            </motion.div>

            {canShowPlanCard ? (
            <PlanReviewCard
              markdown={state.planMd}
              expanded={planExpanded}
              approved={planApproved}
              ready={planReady}
              onToggle={() => setPlanExpanded((value) => !value)}
            />
            ) : null}

            {showBuildStream ? (
              <div className="mt-5">
                {planApproved && state.stage !== "complete" && state.stage !== "failed" && Object.keys(state.files).length === 0 ? (
                  <CodeModeThinkingRow resetKey={`${state.taskId}:code:${state.startedAt ?? 0}`} />
                ) : null}
                <CodeModeActivityStream
                  statusUpdates={state.statusUpdates}
                  files={generatedFiles}
                  queueList={state.fileQueue}
                />
              </div>
            ) : null}

            {state.terminalLogs.some((log) => isUserVisibleTerminalCommand(log.command)) ? (
              <TerminalTranscript logs={state.terminalLogs.filter((log) => isUserVisibleTerminalCommand(log.command))} />
            ) : null}

            {state.stage === "complete" ? (
              <CompletionSummary
                filesChanged={generatedFiles.length}
                checksRun={state.terminalLogs.filter((log) => isUserVisibleTerminalCommand(log.command)).length}
                previewUrl={state.preview.url}
              />
            ) : null}
          </div>

          <AnimatePresence>
            {showJumpToLatest ? (
              <motion.button
                type="button"
                onClick={jumpToLatest}
                initial={{ opacity: 0, y: 8, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 8, scale: 0.96 }}
                transition={{ duration: 0.18, ease: "easeOut" }}
                className="absolute bottom-28 left-1/2 z-30 -translate-x-1/2 rounded-full border border-slate-200/80 bg-white/92 px-3.5 py-2 text-[12px] font-bold text-slate-600 shadow-[0_14px_34px_rgba(15,23,42,0.08)] backdrop-blur-xl transition-colors hover:bg-slate-50 hover:text-slate-950"
              >
                Jump to latest
              </motion.button>
            ) : null}
          </AnimatePresence>

          <motion.div
            layout
            className={cn(
              "pointer-events-auto absolute bottom-0 z-20 w-full px-5 sm:px-8",
              shouldShowPreview
                ? "bottom-0 left-0 max-w-none"
                : "left-1/2 max-w-[760px] -translate-x-1/2",
            )}
          >
            <Composer
              compact
              placeholder="Add a follow-up or ask for a change..."
              activePlaceholder={planChangeMode ? "Tell Clyra what to change in the plan..." : undefined}
              value={promptInput}
              onChange={setPromptInput}
              onSubmit={planChangeMode ? handlePlanRevisionSubmit : handleSubmit}
              mode={mode}
              onModeChange={setMode}
              onAttach={() => fileRef?.current?.click()}
              disabled={!promptInput.trim()}
              isGenerating={
                state.stage !== "complete" &&
                state.stage !== "failed" &&
                state.stage !== "cancelled" &&
                !(state.planMode && planApproved)
              }
              planApprovalActive={
                !previewAutofixActive &&
                state.planMode &&
                planReady &&
                state.stage !== "failed" &&
                state.stage !== "cancelled" &&
                !(state.planMode && planApproved) &&
                thinkingCollapsed
              }
              onApprovePlan={() => {
                setPlanApproved(true);
                setPlanExpanded(false);
                setPlanChangeMode(false);
                void approvePlan();
              }}
              onRequestPlanChanges={() => {
                setPlanChangeMode(true);
                setPromptInput("");
              }}
            />
          </motion.div>
        </motion.section>

        <AnimatePresence>
          {shouldShowPreview ? (
            <motion.aside
              key="live-preview"
              initial={skipEnterAnimation ? false : { opacity: 0, x: 80, scale: 0.985 }}
              animate={{ opacity: 1, x: 0, scale: 1 }}
              exit={{ opacity: 0, x: 80, scale: 0.985 }}
              transition={{ duration: skipEnterAnimation ? 0 : 0.58, ease: [0.22, 1, 0.36, 1] }}
              className="min-w-0 flex-1 bg-white p-5"
            >
              <LivePreviewPanel
                project={{ id: state.projectId, name: activeProjectName, status: state.stage }}
                onFixError={skipEnterAnimation ? undefined : handlePreviewAutofix}
              />
            </motion.aside>
          ) : null}
        </AnimatePresence>
      </div>
      </>
    );
  }

  // IDLE WELCOME PAGE
  return (
    <>
    <div className="relative flex h-full min-h-0 w-full flex-col overflow-hidden bg-white">
      <div
        ref={welcomeScrollRef}
        className={cn("clyra-visible-scrollbar flex min-h-0 flex-1 flex-col overflow-y-auto px-5 sm:px-8", "pt-16")}
      >
        <AnimatePresence mode="wait">
          {welcomeView === "home" && state.stage === "idle" ? (
            <motion.section
              key="welcome"
              initial={{ opacity: 0, y: 18 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -12 }}
              transition={{ duration: 0.42, ease: [0.22, 1, 0.36, 1] }}
              className="mx-auto flex w-full max-w-[900px] flex-col items-center pb-14 pt-8 text-center"
            >
              <div className="mb-4 flex justify-center">
                <AiOrb colorTheme={orbColorTheme} />
              </div>
              <h1 className="text-4xl font-semibold tracking-[-0.055em] text-slate-950 sm:text-5xl">
                What should we build?
              </h1>
              <p className="mt-3 text-[15px] font-semibold text-slate-500 sm:text-base">
                Plan, generate, validate, preview, save and reopen real Vibe projects.
              </p>

              <motion.div layoutId="composer-bar" className="mt-8 mb-6 w-full max-w-[900px] px-5 sm:px-8">
                <Composer
                  compact={false}
                  placeholder="Tell the coding agent what to build..."
                  value={promptInput}
                  onChange={setPromptInput}
                  onSubmit={handleSubmit}
                  mode={mode}
                  onModeChange={setMode}
                  onAttach={() => fileRef?.current?.click()}
                  disabled={!promptInput.trim()}
                  isGenerating={false}
                />
              </motion.div>

              <input
                ref={fileRef}
                type="file"
                multiple
                className="hidden"
                onChange={(event) => {
                  setAttachedFiles(Array.from(event.target.files ?? []).map((file) => file.name));
                  event.target.value = "";
                }}
              />

              {attachedFiles.length > 0 && (
                <div className="mt-3 flex flex-wrap justify-center gap-2">
                  {attachedFiles.map((file) => (
                    <span
                      key={file}
                      className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-[11px] font-bold text-slate-500"
                    >
                      {file}
                    </span>
                  ))}
                </div>
              )}

              <div className="mt-5 w-full max-w-[700px]">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <p className="text-left text-[11px] font-black uppercase tracking-[0.18em] text-slate-300">
                    Recent projects
                  </p>
                  {projects.length > 0 ? (
                    <button
                      type="button"
                      onClick={() => setWelcomeView("projects")}
                      className="rounded-full border border-slate-200/80 bg-white/80 px-3 py-1.5 text-[11px] font-bold text-slate-500 shadow-[0_8px_20px_rgba(15,23,42,0.035)] transition-all hover:-translate-y-0.5 hover:border-slate-300 hover:text-slate-800"
                    >
                      View all projects
                    </button>
                  ) : null}
                </div>
                {projects.length === 0 ? (
                  <div className="rounded-[26px] border border-dashed border-slate-200 bg-white/75 px-5 py-5 text-center text-[13px] font-semibold text-slate-400">
                    Your recent projects will appear here.
                  </div>
                ) : (
                  <div className="grid gap-2.5 sm:grid-cols-3">
                    {projects.slice(0, 3).map((item) => (
                      <RecentProjectCard
                        key={item.id}
                        item={item}
                        onOpen={() => void openProject(item)}
                      />
                    ))}
                  </div>
                )}
              </div>
            </motion.section>
          ) : welcomeView === "projects" && state.stage === "idle" ? (
            <AllProjectsView
              key="all-projects"
              projects={projects}
              openProjectMenu={openProjectMenu}
              orbColorTheme={orbColorTheme}
              onBack={() => setWelcomeView("home")}
              onToggleMenu={(id) => setOpenProjectMenu((current) => (current === id ? null : id))}
              onRename={(project) => {
                setProjectDialog({ type: "rename", project });
                setProjectRename(project.name);
                setOpenProjectMenu(null);
              }}
              onDelete={(project) => {
                setProjectDialog({ type: "delete", project });
                setOpenProjectMenu(null);
              }}
              onOpen={(project) => void openProject(project)}
            />
          ) : null}
        </AnimatePresence>
      </div>
    </div>
      <ProjectActionDialog
        dialog={projectDialog}
        value={projectRename}
        onChange={setProjectRename}
        onClose={() => setProjectDialog(null)}
        onRename={renameProject}
        onDelete={deleteProject}
      />
      </>
    );
  }

function AgentStatusHeader({
  prompt,
  stage,
  elapsedMs,
  filesQueued,
  filesChanged,
  checksRun,
  previewStatus,
}: {
  prompt: string;
  stage: string;
  elapsedMs: number;
  filesQueued: number;
  filesChanged: number;
  checksRun: number;
  previewStatus: string;
}) {
  const active = !["complete", "failed", "cancelled"].includes(stage);
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.24, ease: "easeOut" }}
      className="mb-6 rounded-[24px] border border-slate-200/75 bg-white/82 p-3 shadow-[0_16px_48px_rgba(15,23,42,0.045)] backdrop-blur-xl"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[15px] border border-slate-200/75 bg-white text-slate-500">
            {stage === "complete" ? <Rocket className="h-4 w-4" /> : <Brain className="h-4 w-4" />}
          </span>
          <div className="min-w-0">
            <p className="truncate text-[13px] font-bold tracking-[-0.01em] text-slate-950">
              {prompt ? `Building ${prompt.slice(0, 52)}${prompt.length > 52 ? "..." : ""}` : "Vibe coder"}
            </p>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] font-semibold text-slate-400">
              <span>{formatElapsed(elapsedMs)}</span>
              <span className="h-1 w-1 rounded-full bg-slate-300" />
              <span>{filesQueued} queued</span>
              <span className="h-1 w-1 rounded-full bg-slate-300" />
              <span>{filesChanged} changed</span>
              <span className="h-1 w-1 rounded-full bg-slate-300" />
              <span>{checksRun} checks</span>
              <span className="h-1 w-1 rounded-full bg-slate-300" />
              <span>preview {previewStatus}</span>
            </div>
          </div>
        </div>
        <span
          className={cn(
            "inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-[11px] font-black uppercase tracking-[0.12em]",
            active
              ? "agent-soft-shimmer border-slate-200 bg-slate-50/70 text-slate-600"
              : stage === "failed"
                ? "border-rose-200 bg-rose-50 text-rose-600"
                : "border-emerald-200 bg-emerald-50 text-emerald-600",
          )}
        >
          {active ? <LoaderCircle className="h-3 w-3 animate-spin" /> : <CheckCircle2 className="h-3 w-3" />}
          {stageLabel(stage)}
        </span>
      </div>
    </motion.div>
  );
}

function AgentActivityFeed({ items }: { items: AgentActivityItem[] }) {
  if (items.length === 0) return null;
  return (
    <div className="ml-6 mt-5 max-w-[720px]">
      <div className="mb-2 flex items-center gap-2 px-1 text-[11px] font-black uppercase tracking-[0.16em] text-slate-300">
        <Sparkles className="h-3.5 w-3.5" />
        Activity
      </div>
      <div className="space-y-2.5">
        <AnimatePresence initial={false}>
          {items.map((item) => (
            <AgentActivityRow key={item.id} item={item} />
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
}

function AgentActivityRow({ item }: { item: AgentActivityItem }) {
  const Icon =
    item.type === "file" ? FileCode2 :
    item.type === "terminal" ? TerminalSquare :
    item.type === "preview" ? Eye :
    item.type === "checkpoint" ? GitBranch :
    item.type === "error" ? AlertTriangle :
    item.type === "complete" ? Rocket :
    item.type === "plan" ? FileCode2 :
    Brain;

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 6, scale: 0.985 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -4, scale: 0.99 }}
      transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
      className={cn(
        "group relative overflow-hidden rounded-[20px] border bg-white/78 px-3.5 py-3 text-left shadow-[0_10px_30px_rgba(15,23,42,0.03)]",
        item.status === "active" && "agent-soft-shimmer border-slate-200/90",
        item.status === "success" && "border-slate-200/65",
        item.status === "pending" && "border-slate-200/55 opacity-75",
        item.status === "error" && "border-rose-200/90 bg-rose-50/45",
      )}
      style={{ contain: "layout paint" }}
    >
      <div className="flex items-start gap-3">
        <span
          className={cn(
            "mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-[14px] border bg-white text-slate-400",
            item.status === "active" && "border-slate-200 text-slate-600",
            item.status === "success" && "border-emerald-100 text-emerald-600",
            item.status === "error" && "border-rose-100 text-rose-500",
          )}
        >
          {item.status === "active" ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Icon className="h-4 w-4" />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="min-w-0 truncate text-[13px] font-bold tracking-[-0.01em] text-slate-800">
              {item.title}
            </p>
            <span
              className={cn(
                "rounded-full px-2 py-0.5 text-[9.5px] font-black uppercase tracking-[0.1em]",
                item.status === "active" && "bg-slate-100 text-slate-500",
                item.status === "success" && "bg-emerald-50 text-emerald-600",
                item.status === "pending" && "bg-slate-50 text-slate-400",
                item.status === "error" && "bg-rose-100 text-rose-600",
              )}
            >
              {item.status === "active" ? "active" : item.status}
            </span>
          </div>
          {item.description ? (
            <p className="mt-1 text-[12px] font-medium leading-relaxed text-slate-500">
              {item.description}
            </p>
          ) : null}
          {item.filePath ? (
            <p className="mt-1 truncate font-mono text-[10.5px] font-semibold text-slate-400">
              {item.filePath}
            </p>
          ) : null}
        </div>
        <span className="shrink-0 text-[10px] font-bold text-slate-300">
          {relativeTime(new Date(item.timestamp).toISOString())}
        </span>
      </div>
    </motion.div>
  );
}

function CodeModeActivityStream({
  statusUpdates,
  files,
  queueList,
}: {
  statusUpdates: Array<{ id: string; text: string; timestamp: number }>;
  files: ProjectFile[];
  queueList: Array<{ path: string; action: "create" | "edit" | "delete"; reason: string }>;
}) {
  const recentStatus = statusUpdates.slice(-6);

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-3">
      {recentStatus.map((item) => (
        <motion.p
          key={item.id}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
          className="text-left text-[12.5px] font-medium leading-relaxed text-slate-500"
        >
          {item.text}
        </motion.p>
      ))}
      <MiniCodeBoxQueue files={files} queueList={queueList} />
    </div>
  );
}

function CodeModeThinkingRow({ resetKey }: { resetKey: string }) {
  const [seconds, setSeconds] = useState(1);

  useEffect(() => {
    setSeconds(1);
    const timer = window.setInterval(() => {
      setSeconds((value) => value + 1);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [resetKey]);

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
      className="mx-auto mb-4 flex w-full max-w-2xl items-center gap-2 text-left"
    >
      <Brain className="h-4 w-4 text-slate-400" strokeWidth={1.6} />
      <ShiningText text="Thinking" className="text-[13px] font-semibold" />
      <span className="text-[13px] font-semibold text-slate-500">{seconds}s</span>
    </motion.div>
  );
}

function ProjectThumbnail({
  projectId,
  updatedAt,
  alt,
  className,
  priority = false,
}: {
  projectId: string;
  updatedAt?: string;
  alt: string;
  className?: string;
  priority?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const src = projectThumbnailUrl(projectId, updatedAt);

  if (failed) {
    return (
      <div
        className={cn(
          "relative h-full w-full overflow-hidden bg-[linear-gradient(135deg,#ffffff_0%,#f8fafc_46%,#eef2f7_100%)]",
          className,
        )}
      >
        <div className="absolute inset-3 rounded-[18px] border border-slate-200/80 bg-white/90 p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)]">
          <div className="mb-3 h-2.5 w-16 rounded-full bg-slate-200" />
          <div className="mb-2 h-3 w-[70%] rounded-full bg-slate-900/80" />
          <div className="mb-2 h-2 w-[88%] rounded-full bg-slate-200" />
          <div className="h-2 w-[62%] rounded-full bg-slate-100" />
          <div className="mt-4 grid grid-cols-2 gap-2">
            <div className="h-16 rounded-[14px] bg-slate-100" />
            <div className="h-16 rounded-[14px] bg-slate-50" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={cn("relative h-full w-full overflow-hidden", className)}>
      {!loaded ? (
        <div className="absolute inset-0 animate-pulse bg-[linear-gradient(135deg,#ffffff_0%,#f1f5f9_50%,#e2e8f0_100%)]" />
      ) : null}
      <img
        src={src}
        alt={alt}
        loading={priority ? "eager" : "lazy"}
        decoding="async"
        fetchPriority={priority ? "high" : "auto"}
        onLoad={() => setLoaded(true)}
        onError={() => setFailed(true)}
        className={cn(
          "h-full w-full object-cover transition-opacity duration-200",
          loaded ? "opacity-100" : "opacity-0",
        )}
      />
    </div>
  );
}

function RecentProjectCard({
  item,
  onOpen,
}: {
  item: any;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group relative aspect-square overflow-hidden rounded-[20px] border border-slate-200/70 bg-white/88 text-left shadow-[0_10px_28px_rgba(15,23,42,0.03)] transition-[border-color,box-shadow,transform] duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5 hover:border-slate-300/80 hover:shadow-[0_16px_38px_rgba(15,23,42,0.05)]"
    >
      <div className="flex h-full w-full flex-col p-1.5">
        <div className="relative h-[76%] shrink-0 overflow-hidden rounded-[16px] border border-slate-200/70 bg-[linear-gradient(135deg,#ffffff_0%,#f8fafc_46%,#eef2f7_100%)] shadow-[inset_0_1px_0_rgba(255,255,255,0.95)]">
          <ProjectThumbnail
            projectId={item.id}
            updatedAt={item.updatedAt}
            alt={`${item.name} screenshot`}
            className="h-full w-full object-cover transition-transform duration-500 ease-[cubic-bezier(0.16,1,0.3,1)] group-hover:scale-[1.025]"
            priority
          />
          <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0)_58%,rgba(255,255,255,0.78)_100%)]" />
        </div>
        <div className="flex min-h-0 flex-1 items-center gap-2 px-1.5 pb-1 pt-1.5">
          <div className="min-w-0 flex-1">
            <p className="truncate text-[12.5px] font-bold leading-snug tracking-[-0.02em] text-slate-950">
              {item.name}
            </p>
            <p className="mt-0.5 text-[10px] font-semibold text-slate-400">
              {relativeTime(item.updatedAt)}
            </p>
          </div>
          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full border border-slate-200/70 bg-white/92 text-slate-400 transition-all group-hover:border-slate-300 group-hover:text-slate-900">
            <FolderOpen className="h-3.5 w-3.5" />
          </span>
        </div>
      </div>
    </button>
  );
}

function ProjectCard({
  item,
  onOpen,
  menuOpen,
  onToggleMenu,
  onRename,
  onDelete,
}: {
  item: any;
  onOpen: () => void;
  menuOpen: boolean;
  onToggleMenu: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  return (
    <article className="group relative aspect-square overflow-visible rounded-[20px] border border-slate-200/70 bg-white/88 text-left shadow-[0_10px_28px_rgba(15,23,42,0.03)] transition-[border-color,box-shadow,transform] duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5 hover:border-slate-300/80 hover:shadow-[0_16px_38px_rgba(15,23,42,0.05)]">
      <button
        type="button"
        onClick={onOpen}
        className="flex h-full w-full flex-col overflow-hidden rounded-[20px] p-1.5 text-left"
      >
        <div className="relative h-[76%] shrink-0 overflow-hidden rounded-[16px] border border-slate-200/70 bg-[linear-gradient(135deg,#ffffff_0%,#f8fafc_46%,#eef2f7_100%)] shadow-[inset_0_1px_0_rgba(255,255,255,0.95)]">
          <ProjectThumbnail
            projectId={item.id}
            updatedAt={item.updatedAt}
            alt={`${item.name} screenshot`}
            className="h-full w-full object-cover transition-transform duration-500 ease-[cubic-bezier(0.16,1,0.3,1)] group-hover:scale-[1.025]"
            priority
          />
          <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0)_58%,rgba(255,255,255,0.78)_100%)]" />
        </div>
        <div className="flex min-h-0 flex-1 items-center gap-2 px-1.5 pb-1 pt-1.5">
          <div className="min-w-0 flex-1">
            <p className="truncate text-[12.5px] font-bold leading-snug tracking-[-0.02em] text-slate-950">
              {item.name}
            </p>
            <p className="mt-0.5 text-[10px] font-semibold text-slate-400">
              {relativeTime(item.updatedAt)}
            </p>
          </div>
          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full border border-slate-200/70 bg-white/92 text-slate-400 transition-all group-hover:border-slate-300 group-hover:text-slate-900">
            <FolderOpen className="h-3.5 w-3.5" />
          </span>
        </div>
      </button>

      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onToggleMenu();
        }}
        className="absolute right-3 top-3 grid h-8 w-8 place-items-center rounded-full border border-slate-200/80 bg-white/95 text-slate-500 opacity-0 shadow-sm transition-all hover:border-slate-300 hover:text-slate-900 group-hover:opacity-100"
        aria-label={`Project actions for ${item.name}`}
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>

      <AnimatePresence>
        {menuOpen ? (
          <motion.div
            initial={{ opacity: 0, y: 6, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 4, scale: 0.96 }}
            className="absolute right-3 top-12 z-20 w-40 overflow-hidden rounded-[14px] border border-slate-200 bg-white p-1 shadow-xl"
          >
            <button
              type="button"
              onClick={onOpen}
              className="flex w-full items-center gap-2 rounded-[10px] px-3 py-2 text-left text-[12px] font-semibold hover:bg-slate-50"
            >
              <FolderOpen className="h-3.5 w-3.5" />
              Open
            </button>
            <button
              type="button"
              onClick={onRename}
              className="flex w-full items-center gap-2 rounded-[10px] px-3 py-2 text-left text-[12px] font-semibold hover:bg-slate-50"
            >
              <Pencil className="h-3.5 w-3.5" />
              Rename
            </button>
            <button
              type="button"
              onClick={onDelete}
              className="flex w-full items-center gap-2 rounded-[10px] px-3 py-2 text-left text-[12px] font-semibold text-rose-500 hover:bg-rose-50"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Delete
            </button>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </article>
  );
}

function AllProjectsView({
  projects,
  openProjectMenu,
  orbColorTheme = "default",
  onBack,
  onOpen,
  onToggleMenu,
  onRename,
  onDelete,
}: {
  projects: any[];
  openProjectMenu: string | null;
  orbColorTheme?: OrbColorTheme;
  onBack: () => void;
  onOpen: (project: any) => void;
  onToggleMenu: (id: string) => void;
  onRename: (project: any) => void;
  onDelete: (project: any) => void;
}) {
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "ready" | "building" | "failed">("all");
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");

  const filteredProjects = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return projects
      .filter((project) => {
        if (statusFilter === "all") return true;
        const status = String(project.status ?? "").toLowerCase();
        if (statusFilter === "ready") return status === "ready";
        if (statusFilter === "building") return status === "building" || status === "draft";
        return status === "failed";
      })
      .filter((project) => {
        if (!query) return true;
        return (
          project.name?.toLowerCase().includes(query) ||
          project.prompt?.toLowerCase().includes(query) ||
          project.id?.toLowerCase().includes(query)
        );
      });
  }, [projects, searchQuery, statusFilter]);

  const statusCounts = useMemo(() => {
    const counts = { all: projects.length, ready: 0, building: 0, failed: 0 };
    for (const project of projects) {
      const status = String(project.status ?? "").toLowerCase();
      if (status === "ready") counts.ready += 1;
      else if (status === "failed") counts.failed += 1;
      else counts.building += 1;
    }
    return counts;
  }, [projects]);

  return (
    <motion.section
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10 }}
      transition={{ duration: 0.36, ease: [0.22, 1, 0.36, 1] }}
      className="relative mx-auto flex w-full max-w-[760px] flex-col items-center pb-12 pt-0 text-center"
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-[-12%] -top-4 h-[220px] rounded-[48%] bg-[radial-gradient(ellipse_at_center,rgba(148,163,184,0.18)_0%,rgba(255,255,255,0)_70%)] blur-2xl"
      />

      <div className="relative z-[1] mb-3 flex w-full flex-col items-center">
        <button
          type="button"
          onClick={onBack}
          className="mb-1.5 self-start rounded-full border border-slate-200/80 bg-white/80 px-3.5 py-1.5 text-[12px] font-bold text-slate-500 shadow-[0_8px_20px_rgba(15,23,42,0.035)] transition-all hover:-translate-y-0.5 hover:border-slate-300 hover:text-slate-800"
        >
          ← Back
        </button>

        <div className="mb-1.5 flex justify-center">
          <div className="scale-[0.72]">
            <AiOrb colorTheme={orbColorTheme} />
          </div>
        </div>
        <p className="text-[11px] font-black uppercase tracking-[0.18em] text-slate-300">
          Recent projects
        </p>
        <h2 className="mt-1 text-3xl font-semibold tracking-[-0.055em] text-slate-950 sm:text-4xl">
          All projects
        </h2>
        <p className="mt-1 max-w-2xl text-[14px] font-semibold text-slate-500 sm:text-[15px]">
          {filteredProjects.length} of {projects.length} workspaces — reopen, rename, or continue building.
        </p>
      </div>

      <div className="relative z-[1] mb-4 w-full max-w-[700px] space-y-2.5">
        <div className="relative">
          <Search className="absolute left-4 top-1/2 h-4.5 w-4.5 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Search by name, prompt, or id..."
            className="w-full rounded-[24px] border border-slate-200/70 bg-white/92 py-4 pl-12 pr-4 text-[15px] font-medium text-slate-700 shadow-[0_10px_28px_rgba(15,23,42,0.03)] placeholder:text-slate-400 outline-none transition-all focus:border-slate-300"
          />
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap justify-center gap-2">
            {([
              ["all", "All", statusCounts.all],
              ["ready", "Ready", statusCounts.ready],
              ["building", "In progress", statusCounts.building],
              ["failed", "Failed", statusCounts.failed],
            ] as const).map(([id, label, count]) => (
              <button
                key={id}
                type="button"
                onClick={() => setStatusFilter(id)}
                className={cn(
                  "inline-flex items-center gap-2 rounded-full border px-3.5 py-2 text-[12px] font-bold transition-all duration-200",
                  statusFilter === id
                    ? "border-slate-200 bg-white text-slate-900 shadow-[0_8px_20px_rgba(15,23,42,0.06)]"
                    : "border-transparent bg-transparent text-slate-400 hover:border-slate-200/80 hover:bg-white/70 hover:text-slate-700",
                )}
              >
                <span>{label}</span>
                <span
                  className={cn(
                    "rounded-full px-2 py-0.5 text-[11px]",
                    statusFilter === id
                      ? "bg-slate-100 text-slate-600"
                      : "bg-slate-100/70 text-slate-400",
                  )}
                >
                  {count}
                </span>
              </button>
            ))}
          </div>

          <div className="inline-flex rounded-full border border-slate-200/80 bg-white/88 p-1 shadow-[0_8px_20px_rgba(15,23,42,0.03)]">
            <button
              type="button"
              onClick={() => setViewMode("grid")}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-bold transition-colors duration-200",
                viewMode === "grid"
                  ? "bg-slate-100 text-slate-900"
                  : "text-slate-400 hover:text-slate-700",
              )}
            >
              <Grid3X3 className="h-3.5 w-3.5" />
              Grid
            </button>
            <button
              type="button"
              onClick={() => setViewMode("list")}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-bold transition-colors duration-200",
                viewMode === "list"
                  ? "bg-slate-100 text-slate-900"
                  : "text-slate-400 hover:text-slate-700",
              )}
            >
              <LayoutList className="h-3.5 w-3.5" />
              List
            </button>
          </div>
        </div>
      </div>

      <div className="relative z-[1] min-h-[360px] w-full max-w-[700px]">
        {filteredProjects.length === 0 ? (
          <div className="flex h-56 flex-col items-center justify-center rounded-[26px] border border-dashed border-slate-200 bg-white/75 text-center">
            <div className="mb-3 grid h-12 w-12 place-items-center rounded-full bg-white text-slate-400 shadow-sm">
              <Search className="h-5 w-5" />
            </div>
            <p className="text-[14px] font-semibold text-slate-700">No projects found</p>
            <p className="mt-1 max-w-sm text-[12px] text-slate-400">
              {searchQuery || statusFilter !== "all"
                ? "Try clearing filters or using a different search term."
                : "Start a new Vibe project and it will appear here."}
            </p>
          </div>
        ) : viewMode === "grid" ? (
          <div className="grid gap-2.5 sm:grid-cols-3">
            {filteredProjects.map((project) => (
              <ProjectCard
                key={project.id}
                item={project}
                onOpen={() => onOpen(project)}
                menuOpen={openProjectMenu === project.id}
                onToggleMenu={() => onToggleMenu(project.id)}
                onRename={() => onRename(project)}
                onDelete={() => onDelete(project)}
              />
            ))}
          </div>
        ) : (
          <div className="space-y-2 text-left">
            {filteredProjects.map((project) => {
              return (
                <div
                  key={project.id}
                  className="group relative flex items-center gap-4 rounded-[20px] border border-slate-200/70 bg-white/88 px-3 py-3 shadow-[0_10px_28px_rgba(15,23,42,0.03)] transition-all hover:-translate-y-0.5 hover:border-slate-300/80 hover:shadow-[0_16px_38px_rgba(15,23,42,0.05)]"
                >
                  <button type="button" onClick={() => onOpen(project)} className="flex min-w-0 flex-1 items-center gap-4 text-left">
                    <div className="h-14 w-20 shrink-0 overflow-hidden rounded-[14px] border border-slate-200/70 bg-[linear-gradient(135deg,#ffffff_0%,#f8fafc_46%,#eef2f7_100%)]">
                      <ProjectThumbnail
                        projectId={project.id}
                        updatedAt={project.updatedAt}
                        alt=""
                        className="h-full w-full object-cover"
                      />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[14px] font-bold tracking-[-0.02em] text-slate-950">{project.name}</p>
                      <p className="mt-0.5 truncate text-[12px] font-medium text-slate-500">{project.prompt || "Saved Vibe workspace"}</p>
                    </div>
                    <div className="hidden shrink-0 text-right sm:block">
                      <p className="text-[11px] font-bold uppercase tracking-[0.1em] text-slate-400">{project.status || "Draft"}</p>
                      <p className="mt-1 text-[11px] font-semibold text-slate-400">{relativeTime(project.updatedAt)}</p>
                    </div>
                  </button>
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      onClick={() => onRename(project)}
                      className="rounded-full px-3 py-1.5 text-[11px] font-bold text-slate-500 opacity-0 transition-all hover:bg-slate-50 hover:text-slate-900 group-hover:opacity-100"
                    >
                      Rename
                    </button>
                    <button
                      type="button"
                      onClick={() => onDelete(project)}
                      className="rounded-full px-3 py-1.5 text-[11px] font-bold text-rose-500 opacity-0 transition-all hover:bg-rose-50 group-hover:opacity-100"
                    >
                      Delete
                    </button>
                    <button
                      type="button"
                      onClick={() => onToggleMenu(project.id)}
                      className="grid h-8 w-8 place-items-center rounded-full border border-slate-200/70 bg-white/92 text-slate-500 hover:border-slate-300 hover:text-slate-900"
                      aria-label={`More actions for ${project.name}`}
                    >
                      <MoreHorizontal className="h-4 w-4" />
                    </button>
                  </div>
                  <AnimatePresence>
                    {openProjectMenu === project.id ? (
                      <motion.div
                        initial={{ opacity: 0, y: 6, scale: 0.96 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: 4, scale: 0.96 }}
                        className="absolute right-8 z-20 mt-24 w-40 overflow-hidden rounded-[14px] border border-slate-200 bg-white p-1 shadow-xl"
                      >
                        <button type="button" onClick={() => onOpen(project)} className="flex w-full items-center gap-2 rounded-[10px] px-3 py-2 text-left text-[12px] font-semibold hover:bg-slate-50">
                          <FolderOpen className="h-3.5 w-3.5" />
                          Open
                        </button>
                        <button type="button" onClick={() => onRename(project)} className="flex w-full items-center gap-2 rounded-[10px] px-3 py-2 text-left text-[12px] font-semibold hover:bg-slate-50">
                          <Pencil className="h-3.5 w-3.5" />
                          Rename
                        </button>
                        <button type="button" onClick={() => onDelete(project)} className="flex w-full items-center gap-2 rounded-[10px] px-3 py-2 text-left text-[12px] font-semibold text-rose-500 hover:bg-rose-50">
                          <Trash2 className="h-3.5 w-3.5" />
                          Delete
                        </button>
                      </motion.div>
                    ) : null}
                  </AnimatePresence>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </motion.section>
  );
}

function SavedProjectOverlay({
  project,
  onClose,
}: {
  project: { project: any; files: Array<{ path: string; content: string }>; planMd?: string } | null;
  onClose: () => void;
}) {
  const fileCount = project?.files.length ?? 0;
  const planSummary = project?.planMd
    ? buildPlanSummary(project.planMd).split("\n")[0].replace(/^Plan summary:\s*/i, "")
    : "Saved project files are ready to inspect without replaying the generation timeline.";

  return (
    <AnimatePresence>
      {project ? (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[95] bg-white/82 p-5 backdrop-blur-xl"
        >
          <motion.div
            initial={{ opacity: 0, y: 28, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 22, scale: 0.985 }}
            transition={{ duration: 0.34, ease: [0.22, 1, 0.36, 1] }}
            className="relative mx-auto grid h-full max-w-6xl overflow-hidden rounded-[30px] border border-slate-200/80 bg-white/92 shadow-[0_30px_100px_rgba(15,23,42,0.1)] lg:grid-cols-[1.25fr_0.75fr]"
          >
            <div className="relative z-0 min-h-0 border-b border-slate-100 p-5 lg:border-b-0 lg:border-r">
              <div className="relative h-full min-h-[240px] overflow-hidden rounded-[24px] border border-slate-200/75 bg-slate-50 lg:min-h-[360px]">
                <ProjectThumbnail
                  projectId={project.project.id}
                  updatedAt={project.project.updatedAt}
                  alt={`${project.project.name} screenshot`}
                  className="pointer-events-none absolute inset-0 h-full w-full object-cover"
                />
                <div className="pointer-events-none absolute inset-x-0 bottom-0 h-32 bg-gradient-to-t from-white/90 to-transparent" />
              </div>
            </div>
            <div className="relative z-10 flex min-h-0 flex-col p-6">
              <div className="relative z-20 flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-[11px] font-black uppercase tracking-[0.18em] text-slate-300">Saved Vibe project</p>
                  <h2 className="mt-2 text-3xl font-bold tracking-[-0.055em] text-slate-950">
                    {project.project.name}
                  </h2>
                  <p className="mt-3 text-[13px] font-medium leading-relaxed text-slate-500">
                    {planSummary}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={onClose}
                  className="relative z-30 shrink-0 rounded-full border border-slate-200 bg-white px-4 py-2 text-[13px] font-bold text-slate-600 transition-all hover:border-slate-300 hover:text-slate-950"
                >
                  Close
                </button>
              </div>
              <div className="mt-6 grid grid-cols-2 gap-3">
                <div className="rounded-[20px] border border-slate-200/75 bg-white p-4">
                  <p className="text-[11px] font-black uppercase tracking-[0.14em] text-slate-300">Files</p>
                  <p className="mt-2 text-2xl font-bold text-slate-950">{fileCount}</p>
                </div>
                <div className="rounded-[20px] border border-slate-200/75 bg-white p-4">
                  <p className="text-[11px] font-black uppercase tracking-[0.14em] text-slate-300">Updated</p>
                  <p className="mt-2 text-[14px] font-bold text-slate-700">{relativeTime(project.project.updatedAt)}</p>
                </div>
              </div>
              <div className="mt-6 min-h-0 flex-1 overflow-hidden rounded-[22px] border border-slate-200/75 bg-white">
                <div className="border-b border-slate-100 px-4 py-3 text-[12px] font-black uppercase tracking-[0.14em] text-slate-300">
                  Project files
                </div>
                <div className="clyra-visible-scrollbar max-h-full overflow-auto p-2">
                  {project.files.slice(0, 40).map((file) => (
                    <div key={file.path} className="rounded-[14px] px-3 py-2 font-mono text-[12px] font-semibold text-slate-500 transition-colors hover:bg-slate-50 hover:text-slate-900">
                      {file.path}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

function ProjectActionDialog({
  dialog,
  value,
  onChange,
  onClose,
  onRename,
  onDelete,
}: {
  dialog: { type: "rename" | "delete"; project: any } | null;
  value: string;
  onChange: (value: string) => void;
  onClose: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  return (
    <AnimatePresence>
      {dialog ? (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[100] grid place-items-center bg-slate-950/10 px-4 backdrop-blur-sm"
        >
          <motion.div
            initial={{ opacity: 0, y: 16, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.97 }}
            transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
            className="w-full max-w-md rounded-[26px] border border-slate-200/80 bg-white/96 p-5 shadow-[0_28px_90px_rgba(15,23,42,0.14)] backdrop-blur-xl"
          >
            <h3 className="text-[18px] font-bold tracking-[-0.03em] text-slate-950">
              {dialog.type === "rename" ? "Rename project" : "Delete project?"}
            </h3>
            {dialog.type === "rename" ? (
              <input
                value={value}
                onChange={(event) => onChange(event.target.value)}
                autoFocus
                className="mt-4 w-full rounded-[18px] border border-slate-200 bg-white px-4 py-3 text-[14px] font-semibold text-slate-900 outline-none transition-colors focus:border-slate-400"
              />
            ) : (
              <p className="mt-3 text-[13px] font-medium leading-relaxed text-slate-500">
                This removes <span className="font-bold text-slate-800">{dialog.project.name}</span> from saved Vibe projects.
              </p>
            )}
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={onClose} className="rounded-full px-4 py-2 text-[13px] font-bold text-slate-500 transition-colors hover:bg-slate-50">
                Cancel
              </button>
              <button
                type="button"
                onClick={dialog.type === "rename" ? onRename : onDelete}
                className={cn(
                  "rounded-full px-4 py-2 text-[13px] font-bold text-white transition-colors",
                  dialog.type === "rename" ? "bg-slate-950 hover:bg-slate-800" : "bg-rose-500 hover:bg-rose-600",
                )}
              >
                {dialog.type === "rename" ? "Save" : "Delete"}
              </button>
            </div>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

function buildPlanSummary(markdown: string) {
  const plain = markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#*_`>|-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const request = plain.match(/(?:User request|Original request|Request)[:\s]+(.{12,180}?)(?:\.| Product| Interpretation| Type|$)/i)?.[1]?.trim();
  const files = Array.from(markdown.matchAll(/(?:^|\s)([A-Za-z0-9._/-]+\.(?:html|css|js|ts|tsx|md|json))/g)).map((match) => match[1]);
  const uniqueFiles = Array.from(new Set(files)).filter((file) => !/^PLAN\.md$/i.test(file));
  const fileText = uniqueFiles.length ? `It will create or edit ${uniqueFiles.join(", ")}.` : "It will create the needed project files one by one.";
  return [
    request ? `Plan summary: ${request}.` : "Plan summary: Clyra has prepared the build scope, file queue, validation path, and preview steps.",
    fileText,
    "Approve it to start Code Mode with mini code boxes, terminal validation, and live preview.",
  ].join("\n");
}

function CompletionSummary({
  filesChanged,
  checksRun,
  previewUrl,
}: {
  filesChanged: number;
  checksRun: number;
  previewUrl?: string;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10, scale: 0.99 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
      className="ml-6 mt-5 max-w-[720px] rounded-[26px] border border-emerald-200/70 bg-emerald-50/45 p-4 text-left shadow-[0_18px_46px_rgba(16,185,129,0.07)]"
    >
      <div className="flex items-center gap-3">
        <span className="grid h-9 w-9 place-items-center rounded-[15px] border border-emerald-200 bg-white text-emerald-600">
          <Rocket className="h-4 w-4" />
        </span>
        <div>
          <p className="text-[14px] font-black text-slate-950">Build complete</p>
          <p className="mt-1 text-[12px] font-semibold text-slate-500">
            {filesChanged} files streamed, {checksRun} checks recorded, preview {previewUrl ? "ready" : "reported"}.
          </p>
        </div>
      </div>
    </motion.div>
  );
}

function PlanReviewCard({
  markdown,
  expanded,
  approved,
  ready,
  onToggle,
}: {
  markdown: string;
  expanded: boolean;
  approved: boolean;
  ready: boolean;
  onToggle: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [downloaded, setDownloaded] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editPrompt, setEditPrompt] = useState("");
  const [popoverPos, setPopoverPos] = useState<{ top: number; left: number } | null>(null);
  const [selectionText, setSelectionText] = useState("");
  const [highlightRects, setHighlightRects] = useState<Array<{ top: number; left: number; width: number; height: number }>>([]);
  const [draftReplacement, setDraftReplacement] = useState<{ oldText: string; newText: string } | null>(null);
  const [planDraft, setPlanDraft] = useState(markdown);
  const contentRef = useRef<HTMLDivElement>(null);
  const didAutoScrollRef = useRef(false);

  useEffect(() => {
    setPlanDraft(markdown);
    setDraftReplacement(null);
    setHighlightRects([]);
    setPopoverPos(null);
    setSelectionText("");
    didAutoScrollRef.current = false;
  }, [markdown]);

  useEffect(() => {
    if (!expanded || !ready || approved) return;
    if (isEditing) return;
    if (didAutoScrollRef.current) return;
    const frame = window.requestAnimationFrame(() => {
      const container = contentRef.current;
      if (!container) return;
      const headings = Array.from(container.querySelectorAll("h1,h2,h3,strong"));
      const goal = headings.find((node) => /(^|\s)2\.\s*goal\b/i.test(node.textContent || "")) ??
        headings.find((node) => /\bgoal\b/i.test(node.textContent || ""));
      if (goal) {
        goal.scrollIntoView({ block: "start", behavior: "smooth" });
      } else {
        container.scrollTo({ top: 0, behavior: "auto" });
      }
      didAutoScrollRef.current = true;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [approved, expanded, isEditing, ready]);

  const clearSelectionUi = useCallback(() => {
    setPopoverPos(null);
    setSelectionText("");
    setEditPrompt("");
    setHighlightRects([]);
  }, []);

  useEffect(() => {
    if (!popoverPos) return;
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("#plan-ai-popover")) return;
      clearSelectionUi();
    };
    const handleScroll = () => clearSelectionUi();
    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("scroll", handleScroll, { passive: true });
    window.addEventListener("resize", handleScroll);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("scroll", handleScroll);
      window.removeEventListener("resize", handleScroll);
    };
  }, [clearSelectionUi, popoverPos]);

  const handleCopy = useCallback(async () => {
    if (copied) return;
    const textToCopy = contentRef.current?.innerText || planDraft || markdown;
    try {
      await navigator.clipboard?.writeText(textToCopy);
    } catch {
      const textArea = document.createElement("textarea");
      textArea.value = textToCopy;
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand("copy");
      document.body.removeChild(textArea);
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }, [copied, markdown, planDraft]);

  const handleDownload = useCallback(() => {
    if (downloaded) return;
    const textToDownload = contentRef.current?.innerText || planDraft || markdown;
    const blob = new Blob([textToDownload], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "PLAN.md";
    anchor.click();
    URL.revokeObjectURL(url);
    setDownloaded(true);
    window.setTimeout(() => setDownloaded(false), 1600);
  }, [downloaded, markdown, planDraft]);

  const handleSelection = useCallback(() => {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || !contentRef.current) return;
    if (!contentRef.current.contains(selection.anchorNode)) return;
    const selected = selection.toString().trim();
    if (!selected) return;
    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    if (!rect.width && !rect.height) return;
    const rects = Array.from(range.getClientRects()).map((item) => ({
      top: item.top,
      left: item.left,
      width: item.width,
      height: item.height,
    }));
    setHighlightRects(rects);
    setSelectionText(selected);
    setDraftReplacement(null);
    setPopoverPos({
      top: Math.max(72, rect.top - 50),
      left: rect.left + rect.width / 2,
    });
  }, []);

  const proposeEdit = useCallback(() => {
    if (!selectionText || !editPrompt.trim()) return;
    const cleanPrompt = editPrompt.trim();
    const newText =
      cleanPrompt.length < 48
        ? cleanPrompt
        : `${cleanPrompt.slice(0, 1).toUpperCase()}${cleanPrompt.slice(1)}`;
    setDraftReplacement({ oldText: selectionText, newText });
    clearSelectionUi();
  }, [clearSelectionUi, editPrompt, selectionText]);

  const applyDraftReplacement = useCallback(() => {
    if (!draftReplacement) return;
    setPlanDraft((current) => current.replace(draftReplacement.oldText, draftReplacement.newText));
    setDraftReplacement(null);
  }, [draftReplacement]);

  const renderPlanContent = () => {
    if (!draftReplacement) return planDraft;
    const index = planDraft.indexOf(draftReplacement.oldText);
    if (index === -1) return planDraft;
    const before = planDraft.slice(0, index);
    const after = planDraft.slice(index + draftReplacement.oldText.length);
    return (
      <>
        {before}
        <span className="rounded-[5px] bg-slate-100 px-1 text-slate-400 line-through decoration-slate-500/80">
          {draftReplacement.oldText}
        </span>
        <span className="mx-1 rounded-[5px] bg-sky-50 px-1 text-sky-600">{draftReplacement.newText}</span>
        {after}
      </>
    );
  };

  const actionButtonClass =
    "relative grid h-8 w-8 place-items-center rounded-xl text-slate-400 transition-[background-color,color,transform] duration-200 ease-out hover:bg-slate-100/75 hover:text-slate-700 active:scale-95 focus:outline-none focus:ring-2 focus:ring-slate-200";
  return (
    <>
      <AnimatePresence>
        {highlightRects.map((rect, index) => (
          <motion.div
            key={`${rect.top}-${rect.left}-${index}`}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.12 }}
            className="fixed z-[65] pointer-events-none rounded-[3px] bg-sky-100/90 mix-blend-multiply"
            style={{
              top: rect.top,
              left: rect.left,
              width: rect.width,
              height: rect.height,
            }}
          />
        ))}
      </AnimatePresence>
      <AnimatePresence>
        {popoverPos ? (
          <motion.div
            id="plan-ai-popover"
            initial={{ opacity: 0, y: 8, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 4, scale: 0.97 }}
            transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
            className="fixed z-[70] flex items-center gap-1.5 rounded-full border border-slate-200/90 bg-white/95 py-1.5 pl-4 pr-1.5 shadow-[0_10px_32px_rgba(15,23,42,0.1)] backdrop-blur-md"
            style={{ top: popoverPos.top, left: popoverPos.left, transform: "translateX(-50%)" }}
          >
            <input
              autoFocus
              value={editPrompt}
              onChange={(event) => setEditPrompt(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  proposeEdit();
                }
              }}
              placeholder="Ask AI to edit..."
              className="w-[190px] bg-transparent text-[13px] font-medium text-slate-700 outline-none placeholder:text-slate-400"
            />
            <button
              type="button"
              onClick={proposeEdit}
              className="grid h-7 w-7 place-items-center rounded-full bg-slate-950 text-white transition-colors hover:bg-slate-800"
              aria-label="Apply plan edit prompt"
            >
              <ArrowUp className="h-3.5 w-3.5" strokeWidth={2.5} />
            </button>
          </motion.div>
        ) : null}
      </AnimatePresence>

      <motion.div
        layout
        initial={{ opacity: 0, x: -26, scale: 0.992 }}
        animate={{ opacity: 1, x: 0, scale: 1 }}
        transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
        className={cn(
          "ml-6 mt-5 max-w-2xl overflow-hidden rounded-[18px] border bg-white/94 text-left shadow-[0_12px_32px_rgba(15,23,42,0.035)] backdrop-blur-xl transition-[border-color,box-shadow] duration-300 hover:shadow-[0_16px_40px_rgba(15,23,42,0.05)]",
          isEditing ? "border-slate-300 shadow-[0_18px_50px_rgba(15,23,42,0.065)]" : "border-slate-200/78",
        )}
      >
      <div className="flex min-h-[54px] items-center justify-between gap-3 px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-3">
          <motion.span
            className="relative grid h-8 w-8 shrink-0 place-items-center rounded-[12px] text-slate-400"
            animate={!ready && !approved ? { scale: [1, 1.05, 1], opacity: [0.7, 1, 0.7] } : { scale: 1, opacity: 1 }}
            transition={!ready && !approved ? { repeat: Infinity, duration: 2.0, ease: "easeInOut" } : { duration: 0.2 }}
          >
            {approved ? <Check className="h-[18px] w-[18px]" strokeWidth={1.7} /> : <ListTodo className="h-[18px] w-[18px]" strokeWidth={1.5} />}
          </motion.span>
          <div className="min-w-0">
            <div className="relative flex h-[24px] items-center overflow-y-hidden overflow-x-visible">
              <AnimatePresence mode="popLayout" initial={false}>
                {!ready && !approved ? (
                  <motion.div
                    key="generating"
                    initial={{ y: "90%", opacity: 0 }}
                    animate={{ y: 0, opacity: 1 }}
                    exit={{ y: "-90%", opacity: 0 }}
                    transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
                    className="overflow-visible whitespace-nowrap pr-2"
                  >
                    <ShiningText text="Generating plan..." className="text-[15px] font-medium tracking-wide" />
                  </motion.div>
                ) : (
                  <motion.p
                    key={approved ? "approved" : "ready"}
                    initial={{ y: "90%", opacity: 0 }}
                    animate={{ y: 0, opacity: 1 }}
                    exit={{ y: "-90%", opacity: 0 }}
                    transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
                    className={cn(
                      "truncate text-[15px] font-medium tracking-wide",
                      approved ? "text-slate-950" : "text-slate-500",
                    )}
                  >
                    {approved ? "Plan complete" : "Plan"}
                  </motion.p>
                )}
              </AnimatePresence>
            </div>
            {isEditing ? (
              <motion.p
                initial={{ opacity: 0, y: -2 }}
                animate={{ opacity: 1, y: 0 }}
                className="mt-0.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400"
              >
                Editing
              </motion.p>
            ) : null}
          </div>
        </div>

        <AnimatePresence initial={false}>
          {ready ? (
            <motion.div
              key="plan-actions"
              initial={{ opacity: 0, x: 10 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 10 }}
              transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
              className="flex shrink-0 items-center gap-1.5"
            >
              <button
                type="button"
                onClick={() => setIsEditing((value) => !value)}
                aria-label={isEditing ? "Save edits" : "Edit plan"}
                className={actionButtonClass}
              >
                <AnimatePresence mode="popLayout" initial={false}>
                  {isEditing ? (
                    <motion.span key="save" initial={{ opacity: 0, rotate: -45, scale: 0.75 }} animate={{ opacity: 1, rotate: 0, scale: 1 }} exit={{ opacity: 0, rotate: 45, scale: 0.75 }} transition={{ duration: 0.18 }} className="absolute">
                      <Save className="h-4 w-4" strokeWidth={1.5} />
                    </motion.span>
                  ) : (
                    <motion.span key="edit" initial={{ opacity: 0, rotate: 45, scale: 0.75 }} animate={{ opacity: 1, rotate: 0, scale: 1 }} exit={{ opacity: 0, rotate: -45, scale: 0.75 }} transition={{ duration: 0.18 }} className="absolute">
                      <Edit2 className="h-4 w-4" strokeWidth={1.5} />
                    </motion.span>
                  )}
                </AnimatePresence>
              </button>
              <button
                type="button"
                aria-label="Download plan"
                onClick={handleDownload}
                className={actionButtonClass}
              >
                {downloaded ? <Check className="h-4 w-4 text-emerald-500" strokeWidth={2} /> : <Download className="h-4 w-4" strokeWidth={1.5} />}
              </button>
              <button
                type="button"
                aria-label="Copy plan"
                onClick={handleCopy}
                className={actionButtonClass}
              >
                {copied ? <Check className="h-4 w-4 text-emerald-500" strokeWidth={2} /> : <Copy className="h-4 w-4" strokeWidth={1.5} />}
              </button>
              <div className="mx-1 h-5 w-px bg-slate-200/90" />
              <button
                type="button"
                onClick={onToggle}
                aria-label={expanded ? "Collapse plan" : "Expand plan"}
                className={actionButtonClass}
              >
                {expanded ? <Minimize2 className="h-4 w-4" strokeWidth={1.5} /> : <Maximize2 className="h-4 w-4" strokeWidth={1.5} />}
              </button>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>

        <div
          className={cn(
            "grid transition-[grid-template-rows] duration-700 ease-[cubic-bezier(0.16,1,0.3,1)]",
            expanded && ready && !approved ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
          )}
        >
          <div className="overflow-hidden">
            <div
              className={cn(
                "border-t bg-slate-50/50 transition-[opacity,transform] duration-700 ease-[cubic-bezier(0.16,1,0.3,1)]",
                expanded && ready && !approved ? "translate-y-0 opacity-100" : "-translate-y-3 opacity-0",
                expanded && ready && !approved ? "border-slate-100" : "border-transparent",
              )}
            >
              {isEditing ? (
                <div
                  ref={contentRef}
                  contentEditable={!draftReplacement}
                  suppressContentEditableWarning
                  onMouseUp={handleSelection}
                  onKeyUp={handleSelection}
                  onInput={(event) => setPlanDraft(event.currentTarget.innerText)}
                  className="clyra-visible-scrollbar max-h-[min(72vh,760px)] overflow-auto whitespace-pre-wrap rounded-b-[20px] p-6 text-[12.5px] font-medium leading-relaxed text-slate-600 outline-none ring-2 ring-inset ring-slate-200/55 selection:bg-slate-200 selection:text-slate-900"
                >
                  {renderPlanContent()}
                </div>
              ) : (
                <div
                  ref={contentRef}
                  onMouseUp={handleSelection}
                  className="markdown-body clyra-visible-scrollbar max-h-[min(72vh,760px)] overflow-auto p-6 text-[13px] leading-relaxed text-slate-600 selection:bg-slate-200 selection:text-slate-900"
                >
                  <MarkdownMessageContent content={planDraft} codePresentation="soft" suppressCodeBlocks />
                </div>
              )}
              {draftReplacement ? (
                <div className="flex items-center justify-end gap-2 border-t border-slate-100 px-4 py-3">
                  <button
                    type="button"
                    onClick={() => setDraftReplacement(null)}
                    className="rounded-full px-3 py-1.5 text-[12px] font-semibold text-slate-500 transition-colors hover:bg-white"
                  >
                    Keep original
                  </button>
                  <button
                    type="button"
                    onClick={applyDraftReplacement}
                    className="rounded-full bg-slate-950 px-3.5 py-1.5 text-[12px] font-semibold text-white transition-colors hover:bg-slate-800"
                  >
                    Apply edit
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </motion.div>
    </>
  );
}

function GeneratedFilesSummary({ files }: { files: string[] }) {
  if (files.length === 0) return null;

  return (
    <div className="ml-6 mt-4 max-w-[720px] rounded-[24px] border border-slate-200/70 bg-white/74 p-3 shadow-[0_14px_38px_rgba(15,23,42,0.035)]">
      <p className="px-1 text-[11px] font-black uppercase tracking-[0.16em] text-slate-300">
        Generated files
      </p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {files.slice(0, 18).map((file) => (
          <span
            key={file}
            className="rounded-full border border-slate-200/75 bg-white px-2.5 py-1 text-[11px] font-semibold text-slate-500"
          >
            {file}
          </span>
        ))}
      </div>
    </div>
  );
}

function TerminalTranscript({ logs }: { logs: Array<{ id: string; output: string; command?: string }> }) {
  const [expanded, setExpanded] = useState(false);
  if (logs.length === 0) return null;
  const latestCommand = [...logs].reverse().find((log) => log.command)?.command;
  const passed = logs.some((log) => log.output.includes("Command exited with code 0"));
  const failed = logs.some((log) => /Command exited with code (?!0\b)/.test(log.output));
  const status = failed ? "Needs fix" : passed ? "Passed" : "Running";

  return (
    <div className="ml-6 mt-4 max-w-[720px] overflow-hidden rounded-[24px] border border-slate-200/75 bg-white/82 text-left shadow-[0_16px_42px_rgba(15,23,42,0.045)]">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-slate-50/70"
      >
        <span className="flex min-w-0 items-center gap-3">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[14px] border border-slate-200 bg-white text-slate-500">
            <TerminalSquare className="h-4 w-4" />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-[13px] font-black text-slate-900">
              {latestCommand || "Terminal"}
            </span>
            <span className="mt-0.5 block text-[11px] font-semibold text-slate-400">
              {logs.length} log events · {expanded ? "hide output" : "expand output"}
            </span>
          </span>
        </span>
        <span
          className={cn(
            "shrink-0 rounded-full px-2.5 py-1 text-[10px] font-black uppercase tracking-[0.1em]",
            failed ? "bg-rose-50 text-rose-600" : passed ? "bg-emerald-50 text-emerald-600" : "agent-soft-shimmer bg-slate-100 text-slate-500",
          )}
        >
          {status}
        </span>
      </button>
      <AnimatePresence initial={false}>
        {expanded ? (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            className="overflow-hidden"
          >
            <div className="clyra-visible-scrollbar max-h-44 overflow-auto border-t border-slate-200/70 bg-slate-950 px-4 py-3 font-mono text-[11.5px] leading-relaxed text-slate-300">
              {logs.map((log) => (
                <p key={log.id} className={cn("whitespace-pre-wrap break-words", log.command && "text-sky-300")}>
                  {log.output}
                </p>
              ))}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

// --- COMPOSER ---

export function Composer({
  value,
  onChange,
  onSubmit,
  mode,
  onModeChange,
  onAttach,
  disabled,
  className,
  compact = false,
  isGenerating = false,
  placeholder,
  activePlaceholder,
  planApprovalActive = false,
  onApprovePlan,
  onRequestPlanChanges,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  mode: "plan" | "fast";
  onModeChange: (mode: "plan" | "fast") => void;
  onAttach: () => void;
  disabled: boolean;
  className?: string;
  compact?: boolean;
  isGenerating?: boolean;
  placeholder?: string;
  activePlaceholder?: string;
  planApprovalActive?: boolean;
  onApprovePlan?: () => void;
  onRequestPlanChanges?: () => void;
}) {
  const { textareaRef, resize } = useVibeAutoResizeTextarea({
    value,
    minHeight: compact ? 42 : 92,
    maxHeight: compact ? 74 : 124,
  });
  const isPlanRevisionMode = planApprovalActive && Boolean(activePlaceholder);
  const [planChoice, setPlanChoice] = useState<"yes" | "no">("yes");
  const approvalPanelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!planApprovalActive) {
      setPlanChoice("yes");
      return;
    }
    if (isPlanRevisionMode) setPlanChoice("no");
  }, [isPlanRevisionMode, planApprovalActive]);

  useEffect(() => {
    if (!isPlanRevisionMode) return;
    textareaRef.current?.focus();
    resize();
  }, [isPlanRevisionMode, resize, textareaRef]);

  useEffect(() => {
    if (!planApprovalActive) return;
    if (isPlanRevisionMode) return;
    const frame = window.requestAnimationFrame(() => {
      approvalPanelRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [isPlanRevisionMode, planApprovalActive]);

  const chooseNo = () => {
    setPlanChoice("no");
    onRequestPlanChanges?.();
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const chooseYes = () => {
    setPlanChoice("yes");
    requestAnimationFrame(() => approvalPanelRef.current?.focus());
  };

  const submitPlanDecision = () => {
    if (planChoice === "no" || isPlanRevisionMode) {
      if (value.trim()) onSubmit();
      else chooseNo();
      return;
    }
    onApprovePlan?.();
  };

  useEffect(() => {
    if (!planApprovalActive || isPlanRevisionMode) return;
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      const isInput = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
      if (isInput) return;
      if (e.key === "ArrowUp") {
        e.preventDefault();
        chooseYes();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        chooseNo();
      } else if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        submitPlanDecision();
      } else if (e.key === "Escape") {
        e.preventDefault();
        chooseYes();
      }
    };
    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => window.removeEventListener("keydown", handleGlobalKeyDown);
  }, [planApprovalActive, isPlanRevisionMode, chooseYes, chooseNo, submitPlanDecision]);

  return (
    <div
      className={cn(
        "mx-auto flex w-full max-w-3xl flex-col rounded-[24px] border border-slate-200/80 bg-white/86 p-3 shadow-[0_22px_72px_rgba(15,23,42,0.065)] backdrop-blur-xl transition-[box-shadow,border-color] duration-150 ease-[cubic-bezier(0.16,1,0.3,1)]",
        className,
      )}
    >
      <AnimatePresence initial={false}>
        {planApprovalActive ? (
          <motion.div
            layout
            key="plan-approval"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ type: "spring", stiffness: 400, damping: 30, mass: 1 }}
            className="overflow-hidden bg-transparent outline-none"
            tabIndex={-1}
            ref={approvalPanelRef}
            onKeyDown={(event) => {
              const target = event.target as HTMLElement | null;
              const isTypingTarget = target?.tagName === "TEXTAREA" || target?.tagName === "INPUT";
              if (isTypingTarget) return;
              if (event.key === "ArrowDown") {
                event.preventDefault();
                chooseNo();
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                chooseYes();
              }
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                submitPlanDecision();
              }
              if (event.key === "Escape") {
                event.preventDefault();
                chooseYes();
              }
            }}
          >
            <motion.div 
              initial={{ y: 20, filter: "blur(4px)", scale: 0.98 }}
              animate={{ y: 0, filter: "blur(0px)", scale: 1 }}
              exit={{ y: 10, filter: "blur(4px)", scale: 0.98 }}
              transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1], delay: 0.05 }}
              className="mb-4 flex flex-col gap-1.5 rounded-2xl bg-white/40 p-1.5 shadow-[inset_0_1px_1px_rgba(255,255,255,0.6),0_8px_32px_rgba(15,23,42,0.04)] backdrop-blur-md ring-1 ring-black/[0.03]"
            >
              <div className="flex items-center justify-between px-3 pb-1 pt-2">
                <p className="text-[13px] font-semibold tracking-tight text-slate-900">
                  Plan Ready
                </p>
                <p className="text-[11px] font-medium text-slate-500">
                  <span className="rounded bg-white/70 px-1.5 py-0.5 shadow-sm">↑</span> / <span className="rounded bg-white/70 px-1.5 py-0.5 shadow-sm">↓</span> to select
                </p>
              </div>

              <div className="flex flex-col gap-1">
                <button
                  type="button"
                  onClick={() => {
                    if (planChoice === "yes") onApprovePlan?.();
                    else chooseYes();
                  }}
                  className={cn(
                    "group relative flex w-full items-center justify-between gap-3 overflow-hidden rounded-[12px] px-3 py-2.5 text-left transition-all duration-200 active:scale-[0.99]",
                    planChoice === "yes" ? "bg-white/90 shadow-sm ring-1 ring-slate-200/60" : "bg-transparent hover:bg-white/50",
                  )}
                >
                  <div className="flex items-center gap-3">
                    <span className={cn(
                      "grid h-6 w-6 shrink-0 place-items-center rounded-full text-[11px] font-bold transition-all duration-200",
                      planChoice === "yes" ? "bg-slate-900 text-white shadow-md" : "bg-white/60 text-slate-400 ring-1 ring-slate-200/50 group-hover:bg-white",
                    )}>
                      1
                    </span>
                    <span className={cn(
                      "text-[13.5px] font-medium tracking-tight transition-colors duration-200",
                      planChoice === "yes" ? "text-slate-900" : "text-slate-600",
                    )}>
                      Approve and Build
                    </span>
                  </div>
                  <span className={cn(
                    "text-[16px] transition-all duration-200",
                    planChoice === "yes" ? "translate-x-0 font-medium text-slate-400 opacity-100" : "-translate-x-2 text-slate-300 opacity-0",
                  )}>
                    ↵
                  </span>
                </button>

                <div
                  className={cn(
                    "group relative flex min-w-0 flex-1 items-center gap-3 overflow-hidden rounded-[12px] px-3 py-2 text-left transition-all duration-200",
                    planChoice === "no" ? "bg-white/90 shadow-sm ring-1 ring-slate-200/60" : "hover:bg-white/50",
                  )}
                >
                  <span className={cn(
                    "grid h-6 w-6 shrink-0 place-items-center rounded-full text-[11px] font-bold transition-all duration-200",
                    planChoice === "no" ? "bg-slate-200/80 text-slate-600" : "bg-white/60 text-slate-400 ring-1 ring-slate-200/50 group-hover:bg-white",
                  )}>
                    2
                  </span>
                  {isPlanRevisionMode ? (
                    <div className="flex flex-1 items-center gap-2">
                      <textarea
                        ref={textareaRef}
                        value={value}
                        onChange={(event) => {
                          onChange(event.target.value);
                          resize();
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "ArrowUp" && !value.trim()) {
                            event.preventDefault();
                            chooseYes();
                          }
                          if (event.key === "Escape") {
                            event.preventDefault();
                            chooseYes();
                          }
                          if (event.key === "Enter" && !event.shiftKey) {
                            event.preventDefault();
                            if (value.trim()) onSubmit();
                          }
                        }}
                        rows={1}
                        placeholder={activePlaceholder}
                        className="clyra-visible-scrollbar relative z-10 min-h-[28px] max-h-[74px] flex-1 resize-none bg-transparent py-0.5 text-[13.5px] font-medium leading-relaxed text-slate-800 outline-none transition-[opacity] duration-150 placeholder:text-slate-400/80"
                      />
                      <button
                        type="button"
                        onClick={onSubmit}
                        disabled={!value.trim()}
                        className="grid h-[28px] shrink-0 place-items-center rounded-full bg-slate-900 px-3 text-[12px] font-medium text-white transition-opacity disabled:opacity-40"
                      >
                        Submit
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={chooseNo}
                      className="flex-1 truncate bg-transparent text-left text-[13.5px] font-medium tracking-tight text-slate-600 outline-none transition-colors"
                    >
                      Request changes...
                    </button>
                  )}
                </div>
              </div>
            </motion.div>
          </motion.div>
        ) : null}
      </AnimatePresence>
      {!planApprovalActive ? (
        <>
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(event) => {
              onChange(event.target.value);
              resize();
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                if (!disabled) onSubmit();
              }
            }}
            rows={1}
            placeholder={activePlaceholder || placeholder || "Ask Clyra to build a feature, app, page, or fix..."}
            className={cn(
              "clyra-visible-scrollbar w-full resize-none bg-transparent px-0 pb-1 pt-2 text-[15px] font-medium leading-relaxed text-slate-800 outline-none transition-[opacity] duration-150 ease-[cubic-bezier(0.16,1,0.3,1)] placeholder:text-slate-400 sm:text-lg",
              compact ? "max-h-[74px] min-h-[42px]" : "max-h-[124px] min-h-[92px]",
            )}
          />
          <div className="mt-1 flex items-center justify-between gap-3">
            <button
              type="button"
              onClick={onAttach}
              className="grid h-10 w-10 shrink-0 place-items-center rounded-full border border-transparent text-slate-500 transition-[background-color,border-color,color] duration-[120ms] ease-out hover:border-slate-200/70 hover:bg-white/72 hover:text-slate-900"
              aria-label="Attach files"
            >
              <Paperclip className="h-5 w-5" />
            </button>
            <div className="flex shrink-0 items-center gap-1.5">
              <ModeDropdown mode={mode as any} onChange={onModeChange as any} />
              <button
                type="button"
                disabled={disabled}
                onClick={onSubmit}
                aria-label="Send Vibe request"
                className={cn(
                  "grid h-10 w-10 shrink-0 place-items-center rounded-full border transition-[background-color,border-color,color] duration-[120ms] ease-out",
                  disabled && !isGenerating
                    ? "border-transparent bg-transparent text-slate-300"
                    : "border-transparent bg-transparent text-slate-700 hover:border-slate-200/70 hover:bg-white/72 hover:text-slate-950",
                )}
              >
                {isGenerating ? <div className="h-3 w-3 rounded-[2px] bg-slate-700" /> : <Send className="h-5 w-5" />}
              </button>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
function ModeDropdown({
  mode,
  onChange,
}: {
  mode: HarnessMode;
  onChange: (mode: HarnessMode) => void;
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const options: Array<{ id: HarnessMode; title: string; copy: string }> = [
    {
      id: "plan",
      title: "Plan Mode",
      copy: "Think first, review the plan, then build.",
    },
    {
      id: "fast",
      title: "Fast Mode",
      copy: "Short plan, save project, build immediately.",
    },
  ];

  useEffect(() => {
    if (!open) return;
    const selectedIndex = Math.max(
      0,
      options.findIndex((option) => option.id === mode),
    );
    setActiveIndex(selectedIndex);
  }, [mode, open, options]);

  const commit = (index: number) => {
    const option = options[Math.max(0, Math.min(index, options.length - 1))];
    onChange(option.id);
    setOpen(false);
  };

  return (
    <div
      className="relative shrink-0"
      onBlurCapture={(event) => {
        const next = event.relatedTarget as Node | null;
        if (!next || !event.currentTarget.contains(next)) setOpen(false);
      }}
      onKeyDown={(event) => {
        if (!open) {
          if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setOpen(true);
          }
          return;
        }
        if (event.key === "ArrowDown") {
          event.preventDefault();
          setActiveIndex((value) => (value + 1) % options.length);
        }
        if (event.key === "ArrowUp") {
          event.preventDefault();
          setActiveIndex((value) => (value - 1 + options.length) % options.length);
        }
        if (event.key === "Enter") {
          event.preventDefault();
          commit(activeIndex);
        }
        if (event.key === "Escape") {
          event.preventDefault();
          setOpen(false);
        }
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className={cn(
          "inline-flex h-10 items-center gap-2 rounded-full border px-3.5 text-[12.5px] font-bold text-slate-700 outline-none transition-[background-color,border-color,color] duration-150 ease-out",
          open
            ? "border-slate-200/80 bg-white/88 text-slate-900 shadow-[0_10px_26px_rgba(15,23,42,0.045)]"
            : "border-transparent bg-transparent shadow-none hover:border-slate-200/70 hover:bg-white/72 hover:text-slate-900",
        )}
      >
        {mode === "plan" ? "Plan Mode" : "Fast Mode"}
        <motion.span
          animate={{ rotate: open ? 180 : 0 }}
          transition={{ duration: 0.16, ease: "easeOut" }}
          className="grid h-4 w-4 place-items-center"
        >
          <ChevronDown className="h-3.5 w-3.5" />
        </motion.span>
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 8, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.985 }}
            transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
            className="absolute right-0 bottom-[calc(100%+10px)] z-30 w-[270px] origin-bottom-right overflow-hidden rounded-[24px] border border-slate-200/75 bg-white/98 p-1 shadow-[0_14px_36px_rgba(15,23,42,0.06)] will-change-transform"
            style={{ contain: "layout paint" }}
          >
            {options.map((option, index) => {
              const selected = option.id === mode;
              const active = index === activeIndex;
              return (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => {
                    onChange(option.id);
                    setOpen(false);
                  }}
                  onMouseEnter={() => setActiveIndex(index)}
                  className={cn(
                    "group relative flex w-full items-start gap-3 rounded-[18px] px-3.5 py-2.5 text-left transition-[background-color,color] duration-150 ease-out",
                    selected
                      ? "bg-slate-50/76 text-slate-950"
                      : active
                        ? "bg-slate-50/64 text-slate-950"
                        : "text-slate-600 hover:bg-slate-50/64 hover:text-slate-950",
                  )}
                >
                  <span
                    className={cn(
                      "mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full border transition-[border-color,background-color,color,transform] duration-150",
                      selected
                        ? "border-slate-300 bg-white text-slate-800"
                        : "border-slate-200/80 bg-white text-transparent group-hover:border-slate-300",
                    )}
                  >
                    <Check className="h-3 w-3" />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[13px] font-bold leading-snug tracking-[-0.01em]">
                      {option.title}
                    </span>
                    <span className="mt-0.5 block text-[11.5px] font-semibold leading-relaxed text-slate-500/78">
                      {option.copy}
                    </span>
                  </span>
                </button>
              );
            })}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
function useVibeAutoResizeTextarea({
  value,
  minHeight = 92,
  maxHeight = 124,
}: {
  value: string;
  minHeight?: number;
  maxHeight?: number;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const resize = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    window.requestAnimationFrame(() => {
      textarea.style.height = "auto";
      if (textarea.value.length === 0) {
        textarea.style.height = `${minHeight}px`;
        textarea.style.overflowY = "hidden";
        return;
      }
      const nextHeight = Math.max(
        minHeight,
        Math.min(textarea.scrollHeight, maxHeight),
      );
      textarea.style.height = `${nextHeight}px`;
      textarea.style.overflowY =
        textarea.scrollHeight > maxHeight ? "auto" : "hidden";
    });
  }, [maxHeight, minHeight]);

  useEffect(() => {
    resize();
  }, [resize, value]);

  useEffect(() => {
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [resize]);

  return { textareaRef, resize };
}
