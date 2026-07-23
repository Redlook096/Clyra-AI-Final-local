import { useCallback, useEffect, useMemo, useState, useRef } from "react";
import { AnimatePresence, motion } from "motion/react";
import { AiOrb, type OrbColorTheme } from "./AiOrb";
type HarnessMode = "plan" | "fast";
// Keep the plan-review implementation available, but do not route normal Vibe
// requests through it until the approval workflow is reintroduced.
// Plan mode is a first-class Clyra flow: it stays in the native workspace
// until the generated PLAN.md is explicitly accepted or revised.
// Keep the proven Vibe workspace flow as the default while the optional plan review
// surface remains behind a flag for future iteration.
const VIBE_PLAN_REVIEW_ENABLED = false;

// The full Vibe Coder M1 fork is the product surface for Vibe. The older Clyra
// workspace remains below as a fallback while its project/session code is
// retained, but it must not replace the actual OpenHands canvas with a summary
// of agent events.
const VIBE_CODER_M1_EMBED_ENABLED = false;
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
import { describeControls, type AgentBridge, type AgentBridgeAction, type AgentBridgeActionResult } from "../lib/agentController";
import { ShiningText } from "./ui/shining-text";
import { ShiningBrainIcon, ThinkingDots } from "./ShiningText";
import { MarkdownMessageContent } from "./MarkdownMessageContent";
import { ElectronWebContentsSurface } from "./ElectronWebContentsSurface";

// --- New Imports for the Advanced Workspace ---
import { useVibeCoderWorkspace, type ProjectFile } from "../hooks/useVibeCoderWorkspace";
import { MiniCodeBoxQueue } from "./vibe-coder/code/MiniCodeBoxQueue";
import { LivePreviewPanel } from "./vibe-coder/preview/LivePreviewPanel";
import { PreviewSkeletonLayout } from "./vibe-coder/preview/PreviewSkeletonLayout";
import {
  buildSessionFromApi,
  deleteProjectSession,
  loadProjectSession,
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
  added?: number;
  removed?: number;
};

type VibePlanDraft = {
  projectId: string;
  prompt: string;
  title: string;
  summary: string;
  markdown: string;
  taskGraph: unknown[];
};

type RuntimeEvent = {
  id: string;
  sequence: number;
  type: string;
  timestamp: string;
  status: string;
  payload: Record<string, unknown>;
  error?: { message: string };
};

type RuntimeSnapshot = {
  projectId: string;
  state: string;
  stateReason?: string;
  sequence: number;
  validation: Array<{ name: string; status: string }>;
  completionEvidence: string[];
  workspaceAlias: string;
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
      added: file.added ?? 0,
      removed: file.removed ?? 0,
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

type VibeCoderWorkspaceProps = {
  orbColorTheme?: OrbColorTheme;
  onEngaged?: () => void;
};

type M1Status = {
  ready: boolean;
  uiReady: boolean;
  agentReady: boolean;
  uiUrl: string;
  error?: string;
};

function VibeCoderM1Surface({ onEngaged }: Pick<VibeCoderWorkspaceProps, "onEngaged">) {
  const [status, setStatus] = useState<M1Status | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;

    const check = async () => {
      try {
        const response = await fetch("/api/vibe/m1-status", { cache: "no-store" });
        const next = (await response.json()) as M1Status;
        if (cancelled) return;
        if (!response.ok) throw new Error(next.error || "Vibe Coder M1 could not start.");
        setStatus(next);
        setLoadError(null);
        if (next.ready) {
          onEngaged?.();
          return;
        }
        timer = window.setTimeout(() => void check(), 1200);
      } catch (error) {
        if (cancelled) return;
        setLoadError(error instanceof Error ? error.message : "Vibe Coder M1 could not start.");
      }
    };

    void fetch("/api/vibe/m1-warmup", { method: "POST" }).catch(() => undefined);
    void check();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [reloadKey, onEngaged]);

  if (status?.ready && status.uiUrl) {
    const src = `${status.uiUrl.replace(/\/$/, "")}/conversations`;
    return (
      <div className="h-full min-h-0 w-full overflow-hidden bg-white">
        <ElectronWebContentsSurface
          key={reloadKey}
          source={src}
          title="Vibe Coder"
          surfaceId="m1-workspace"
          kind="vibe-runtime"
          fallback={
            <iframe
              title="Vibe Coder"
              src={src}
              className="h-full w-full border-0 bg-white"
              allow="clipboard-read; clipboard-write; fullscreen"
            />
          }
        />
      </div>
    );
  }

  const phase = status?.uiReady
    ? "Connecting the OpenHands workspace"
    : status?.agentReady
      ? "Loading the Vibe Coder interface"
      : "Starting Vibe Coder M1";

  return (
    <div className="flex h-full min-h-0 w-full items-center justify-center bg-white px-6">
      <div className="flex w-full max-w-[300px] flex-col items-center text-center">
        <div className="relative mb-7 h-12 w-12 rounded-full bg-slate-950 shadow-[0_10px_24px_rgba(15,23,42,0.12)]">
          <div className="absolute inset-[9px] rounded-full border border-white/45" />
          <div className="absolute inset-[16px] rounded-full bg-white/90" />
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
          <div className="clyra-m1-boot h-full w-[42%] rounded-full bg-slate-900" />
        </div>
        <p className="mt-3 text-[13px] font-medium text-slate-600">{loadError || phase}</p>
        {loadError ? (
          <button
            type="button"
            onClick={() => {
              setLoadError(null);
              setStatus(null);
              setReloadKey((current) => current + 1);
            }}
            className="mt-5 rounded-full border border-slate-200 bg-white px-3.5 py-2 text-[12px] font-semibold text-slate-700 transition-colors hover:bg-slate-50"
          >
            Retry Vibe Coder
          </button>
        ) : null}
      </div>
    </div>
  );
}

export default function VibeCoderWorkspace(props: VibeCoderWorkspaceProps) {
  if (VIBE_CODER_M1_EMBED_ENABLED) return <VibeCoderM1Surface onEngaged={props.onEngaged} />;
  return <LegacyVibeCoderWorkspace {...props} />;
}

function LegacyVibeCoderWorkspace({ orbColorTheme = "default", onEngaged }: VibeCoderWorkspaceProps) {
  const { state, resetToIdle, setState, loadSavedProject, restoreProject } = useVibeCoderWorkspace("project-advanced-vibe");

  const [mode, setMode] = useState<"plan" | "fast">("fast");
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
  const [m1LaunchError, setM1LaunchError] = useState<string | null>(null);
  const [m1Launching, setM1Launching] = useState(false);
  const [m1Runtime, setM1Runtime] = useState<RuntimeSnapshot | null>(null);
  const [m1RuntimeEvents, setM1RuntimeEvents] = useState<RuntimeEvent[]>([]);
  const [m1ConversationUrl, setM1ConversationUrl] = useState<string | null>(null);
  const [m1UiUrl, setM1UiUrl] = useState(() => {
    if (typeof window === "undefined") return "http://127.0.0.1:8000";
    return window.sessionStorage.getItem("clyra-m1-ui-url") || "http://127.0.0.1:8000";
  });
  const [planDraft, setPlanDraft] = useState<VibePlanDraft | null>(null);
  const [isPreparingPlan, setIsPreparingPlan] = useState(false);
  const [isSavingPlan, setIsSavingPlan] = useState(false);
  // Whether the user explicitly paused the current run from this window.
  // Any PAUSED runtime state without this flag is an unrequested stall
  // (tool hand-off, server restart) that polling should resume on its own.
  const userPausedRef = useRef(false);
  const autoResumeRef = useRef({ projectId: "", attempts: 0, lastAt: 0 });

  const elapsedSinceStart = state.startedAt ? elapsedNow - state.startedAt : 0;
  const planReadyDelayPassed = elapsedSinceStart >= 10000;
  const canReviewPlan = VIBE_PLAN_REVIEW_ENABLED && Boolean(state.planMd) && state.planMode;
  const planReady = canReviewPlan && state.fileQueue.length > 0 && planReadyDelayPassed;
  const thinkingIsResting = state.stage === "complete" || (VIBE_PLAN_REVIEW_ENABLED && state.planMode && planReady);

  useEffect(() => {
    const snapshot = () => ({
        route: window.location.pathname,
        workspace: "vibe",
        activeTab: state.stage === "idle" ? "welcome" : "build",
        projectId: state.projectId === "project-advanced-vibe" ? undefined : state.projectId,
        projectName: activeProjectName,
        buildStatus: m1LaunchError ? "failed" : m1Runtime?.state || state.stage,
        previewReady: state.preview.status === "ready" || m1Runtime?.validation.some((check) => check.name === "preview health" && check.status === "passed"),
        loading: m1Launching || state.stage === "task-created" || state.stage === "generating-file",
        notifications: [],
        errors: m1LaunchError || state.error ? [m1LaunchError || state.error || ""] : [],
        controls: describeControls(document),
        scroll: { x: window.scrollX, y: window.scrollY, width: window.innerWidth, height: window.innerHeight },
        capturedAt: Date.now(),
      });

    const resolve = (ref: string) => Array.from(
      document.querySelectorAll<HTMLElement>("[data-agent-id], [data-testid], button, input, textarea, select, [role=button]"),
    ).find((element) =>
      element.dataset.agentId === ref ||
      element.dataset.testid === ref ||
      element.getAttribute("aria-label") === ref ||
      element.textContent?.trim() === ref,
    ) || null;

    const act = (action: AgentBridgeAction): AgentBridgeActionResult => {
      const before = snapshot();
      let success = false;
      let changed = false;
      let message: string | undefined;
      try {
        if (action.type === "navigate") {
          const target = new URL(action.url, window.location.href);
          if (target.origin !== window.location.origin) throw new Error("Navigation must stay inside Vibe Coder.");
          window.location.assign(target.href);
          success = changed = true;
        } else {
          const control = action.type === "scroll" && !action.ref ? null : resolve("ref" in action && action.ref ? action.ref : "");
          if (action.type !== "scroll" || action.ref) {
            if (!control) throw new Error("The requested Vibe control is not available.");
            if (control.matches("[disabled], [aria-disabled=true]")) throw new Error("The requested Vibe control is disabled.");
          }
          if (action.type === "click") {
            control!.scrollIntoView({ block: "center", behavior: "smooth" });
            control!.click();
            success = changed = true;
          } else if (action.type === "focus") {
            control!.focus();
            success = changed = document.activeElement === control;
          } else if (action.type === "type") {
            const field = control as HTMLInputElement | HTMLTextAreaElement;
            if (!(field instanceof HTMLInputElement) && !(field instanceof HTMLTextAreaElement)) throw new Error("The requested Vibe control does not accept text.");
            const previous = field.value;
            const next = action.clearFirst ? action.text : `${previous}${action.text}`;
            const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value");
            descriptor?.set?.call(field, next);
            field.dispatchEvent(new Event("input", { bubbles: true }));
            field.dispatchEvent(new Event("change", { bubbles: true }));
            field.focus();
            success = true;
            changed = previous !== next;
          } else if (action.type === "press") {
            const target = control || document.activeElement || document.body;
            target.dispatchEvent(new KeyboardEvent("keydown", { key: action.key, bubbles: true }));
            target.dispatchEvent(new KeyboardEvent("keyup", { key: action.key, bubbles: true }));
            success = changed = true;
          } else if (action.type === "scroll") {
            const target = control || document.scrollingElement || document.documentElement;
            const amount = (action.amount ?? 480) * (action.direction === "down" ? 1 : -1);
            if (target instanceof HTMLElement) target.scrollBy({ top: amount, behavior: "smooth" });
            else window.scrollBy({ top: amount, behavior: "smooth" });
            success = changed = true;
          }
        }
      } catch (error) {
        message = error instanceof Error ? error.message : "The Vibe action failed.";
      }
      const after = snapshot();
      return { success, changed, beforeSnapshotId: String(before.capturedAt), afterSnapshotId: String(after.capturedAt), message };
    };
    const bridge: AgentBridge = { snapshot, act };
    window.__CLYRA_AGENT_BRIDGE__ = bridge;
    return () => {
      if (window.__CLYRA_AGENT_BRIDGE__ === bridge) delete window.__CLYRA_AGENT_BRIDGE__;
    };
  }, [activeProjectName, m1LaunchError, m1Launching, m1Runtime, state.error, state.preview.status, state.projectId, state.stage]);

  useEffect(() => {
    if (thinkingIsResting) {
      const timer = window.setTimeout(() => setThinkingCollapsed(true), 1000);
      return () => window.clearTimeout(timer);
    } else {
      setThinkingCollapsed(false);
    }
  }, [thinkingIsResting]);

  useEffect(() => {
    const projectId = state.projectId;
    if (!projectId || projectId === "project-advanced-vibe" || state.stage === "idle") return;
    let cancelled = false;
    const loadRuntime = async () => {
      try {
        const response = await fetch(`/api/vibe/runtime/${encodeURIComponent(projectId)}`);
        if (!response.ok) return;
        const data = await response.json() as { snapshot: RuntimeSnapshot; events: RuntimeEvent[] };
        if (cancelled) return;
        setM1Runtime(data.snapshot);
        setM1RuntimeEvents((current) => {
          const merged = [...current, ...data.events];
          return Array.from(new Map(merged.map((event) => [event.id, event])).values()).slice(-60);
        });
        // Self-heal unrequested pauses. The server watcher normally resumes
        // these, but after a Clyra restart the watcher is gone and polling is
        // the only supervisor left. Bounded retries so a genuinely stuck run
        // still surfaces as PAUSED with a manual Resume button.
        const snapshot = data.snapshot;
        const tracker = autoResumeRef.current;
        if (tracker.projectId !== projectId) {
          autoResumeRef.current = { projectId, attempts: 0, lastAt: 0 };
        }
        if (snapshot.state === "RUNNING") {
          autoResumeRef.current.attempts = 0;
        } else if (
          snapshot.state === "PAUSED" &&
          !userPausedRef.current &&
          !/by the user/i.test(snapshot.stateReason || "")
        ) {
          const now = Date.now();
          if (autoResumeRef.current.attempts < 3 && now - autoResumeRef.current.lastAt > 15_000) {
            autoResumeRef.current.attempts += 1;
            autoResumeRef.current.lastAt = now;
            void fetch(`/api/vibe/runtime/${encodeURIComponent(projectId)}/control`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ command: "resume" }),
            }).catch(() => undefined);
          }
        }
      } catch {
        // The runtime can still be booting. Preserve the current event view.
      }
    };
    void loadRuntime();
    const timer = window.setInterval(() => void loadRuntime(), 1000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [m1ConversationUrl, state.projectId, state.stage]);

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

  useEffect(() => {
    if (state.stage !== "idle") return;
    void fetch("/api/vibe/m1-status", { cache: "no-store" })
      .then((response) => response.ok ? response.json() : null)
      .then((status: { uiUrl?: string } | null) => {
        if (!status?.uiUrl) return;
        setM1UiUrl(status.uiUrl);
        window.sessionStorage.setItem("clyra-m1-ui-url", status.uiUrl);
      })
      .catch(() => undefined);
  }, [state.stage]);

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
      setMode(session.ui.mode === "plan" ? "fast" : session.ui.mode);
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
    if (!VIBE_PLAN_REVIEW_ENABLED || !state.planMode || !state.planMd || planApproved) return;
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

  const launchM1 = useCallback(
    async (opts: {
      prompt?: string;
      projectId?: string;
      planMode?: boolean;
      continueExisting?: boolean;
      projectName?: string;
    }) => {
      setM1LaunchError(null);
      setM1Launching(true);
      setM1Runtime(null);
      setM1RuntimeEvents([]);
      // A fresh launch always starts running; stale pause intent must not
      // block the polling loop's auto-resume for the new conversation.
      userPausedRef.current = false;
      autoResumeRef.current = { projectId: "", attempts: 0, lastAt: 0 };
      // Do not hand the shell to the iframe until launch has returned a real
      // conversation. A warmup probe can succeed while M1's ingress is still
      // waiting for its agent server, which otherwise produces a white or
      // "refused to connect" workspace immediately after Send.
      setSkipEnterAnimation(false);
      setWelcomeView("home");
      // Keep the established welcome surface in place while M1 creates a real
      // conversation. Switching the outer workspace before this returns
      // produced a visible "Preparing" screen (and, on slow launches, a blank
      // panel) between Send and the actual OpenHands canvas.
      if (opts.projectName) setActiveProjectName(opts.projectName);

      try {
        const requestLaunch = () =>
          fetch("/api/vibe/m1-launch", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              prompt: opts.prompt,
              projectId: opts.projectId,
              planMode: !!opts.planMode,
              continueExisting: !!opts.continueExisting,
            }),
          });

        let res: Response;
        try {
          res = await requestLaunch();
        } catch (error) {
          // The M1 warmup process can briefly overlap a local dev-server HMR
          // reconnect. One quiet retry keeps Send deterministic without
          // masking a persistent network failure behind a spinner.
          if (!(error instanceof TypeError)) throw error;
          await new Promise((resolve) => window.setTimeout(resolve, 650));
          res = await requestLaunch();
        }
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data?.error || "Failed to launch Vibe Coder M1");
        }
        const conversationId = String(data.conversationId || "");
        const uiUrl = typeof data.uiUrl === "string" ? data.uiUrl.replace(/\/$/, "") : "";
        if (uiUrl) {
          setM1UiUrl(uiUrl);
          window.sessionStorage.setItem("clyra-m1-ui-url", uiUrl);
        }
        const conversationUrl =
          typeof data.conversationUrl === "string" && data.conversationUrl
            ? data.conversationUrl
            : uiUrl && conversationId
              ? `${uiUrl}/conversations/${encodeURIComponent(conversationId)}?openPreview=1`
              : "";
        if (!conversationUrl) throw new Error("Vibe Coder M1 did not return a conversation workspace.");
        setM1ConversationUrl(conversationUrl);
        setState((prev) => ({
          ...prev,
          projectId: String(data.projectId || prev.projectId),
          stage: "generating-file",
          taskId: conversationId,
          prompt: opts.prompt || prev.prompt || "",
          planMode: !!opts.planMode,
          startedAt: Date.now(),
          error: null,
        }));
        setActiveProjectName(
          opts.projectName ||
            String(opts.prompt || "").slice(0, 70) ||
            "Vibe project",
        );
        const launchedId = String(data.projectId || opts.projectId || "");
        void loadProjects();
        if (launchedId && launchedId !== "project-advanced-vibe") {
          // Capture a fresh card preview after the workspace updates.
          window.setTimeout(() => {
            void fetch(
              `/api/vibe/projects/${encodeURIComponent(launchedId)}/thumbnail/refresh`,
              { method: "POST" },
            )
              .then(() => loadProjects())
              .catch(() => undefined);
          }, 8000);
          window.setTimeout(() => {
            void fetch(
              `/api/vibe/projects/${encodeURIComponent(launchedId)}/thumbnail/refresh`,
              { method: "POST" },
            )
              .then(() => loadProjects())
              .catch(() => undefined);
          }, 45000);
        }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Failed to launch M1";
        setM1LaunchError(message);
        setState((prev) => ({ ...prev, stage: "failed", error: message }));
      } finally {
        setM1Launching(false);
      }
    },
    [loadProjects, m1UiUrl, onEngaged, setState],
  );

  const preparePlanReview = useCallback(async (prompt: string, projectId?: string) => {
    const cleanPrompt = prompt.trim();
    if (!cleanPrompt) return;
    setIsPreparingPlan(true);
    setPlanApproved(false);
    setPlanChangeMode(false);
    setPlanExpanded(false);
    setM1LaunchError(null);
    try {
      const projectPromise = projectId
        ? Promise.resolve({ project: { id: projectId } })
        : fetchJson<{ project: { id: string } }>("/api/vibe/projects", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ prompt: cleanPrompt, mode: "plan" }),
          });
      const planPromise = fetchJson<{
        title: string;
        summary: string;
        markdown: string;
        taskGraph: unknown[];
      }>("/api/vibe/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: cleanPrompt }),
      });
      const [projectResult, planResult] = await Promise.all([projectPromise, planPromise]);
      setPlanDraft({
        projectId: projectResult.project.id,
        prompt: cleanPrompt,
        title: planResult.title || cleanPrompt.slice(0, 80),
        summary: planResult.summary.replace(/^Clyra will build Build\s+/i, "Clyra will build "),
        markdown: planResult.markdown,
        taskGraph: planResult.taskGraph || [],
      });
      setActiveProjectName(planResult.title || cleanPrompt.slice(0, 70));
      void loadProjects();
    } catch (error) {
      setM1LaunchError(error instanceof Error ? error.message : "Couldn’t prepare that plan.");
    } finally {
      setIsPreparingPlan(false);
    }
  }, [fetchJson, loadProjects]);

  const approvePlanAndBuild = useCallback(async () => {
    if (!planDraft || isSavingPlan) return;
    setIsSavingPlan(true);
    setPlanApproved(true);
    try {
      await fetchJson("/api/vibe/write-plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: planDraft.projectId,
          plan: planDraft.markdown,
          taskGraph: planDraft.taskGraph,
        }),
      });
      // Keep the confirmation visible long enough to acknowledge the decision,
      // then pass the saved project to the real M1 workspace.
      await new Promise((resolve) => window.setTimeout(resolve, 420));
      await launchM1({
        prompt: `${planDraft.prompt}\n\nA review-approved implementation plan is saved at plan.md in the workspace root. Read it, inspect the workspace, and follow it before changing files.`,
        planMode: false,
        projectId: planDraft.projectId,
        projectName: planDraft.title,
      });
      setPlanDraft(null);
    } catch (error) {
      setPlanApproved(false);
      setM1LaunchError(error instanceof Error ? error.message : "Couldn’t save the approved plan.");
    } finally {
      setIsSavingPlan(false);
    }
  }, [fetchJson, isSavingPlan, launchM1, planDraft]);

  const handleSubmit = async (overridePrompt?: string) => {
    const cleanPrompt = (typeof overridePrompt === "string" ? overridePrompt : promptInput).trim();
    if (!cleanPrompt) return;
    persistCurrentSession();
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
    setPromptInput("");
    if (VIBE_PLAN_REVIEW_ENABLED && mode === "plan") {
      await preparePlanReview(cleanPrompt);
      return;
    }
    await launchM1({
      prompt: cleanPrompt.replace(/^\/design\s*/i, "").trim() || cleanPrompt,
      planMode: false,
      // A prompt from the welcome composer is always a new build. Reopening
      // an existing project happens through its recent-project card, where
      // `continueExisting` preserves its conversation and files explicitly.
      projectId: undefined,
    });
  };

  const handlePlanRevisionSubmit = async () => {
    const requestedChange = promptInput.trim();
    if (!requestedChange || !planDraft) return;
    setPromptInput("");
    setPlanChangeMode(false);
    await preparePlanReview(
      `${planDraft.prompt}\n\nPlan revision request: ${requestedChange}`,
      planDraft.projectId,
    );
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
        setWelcomeView("home");
        setActiveProjectName(project.name || project.id || "Vibe project");
        setState((prev) => ({
          ...prev,
          projectId: project.id,
          prompt: project.prompt || prev.prompt,
          stage: "complete",
          restored: true,
          preview: { status: "ready" },
          taskId: null,
          currentStreamingFile: null,
        }));
        const cachedSession = loadProjectSession(project.id);
        if (cachedSession) applySavedSession(cachedSession);

        void restoreProject(project.id).catch((error) => {
          console.warn("Failed to hydrate saved Vibe project", error);
        });

        // Reopen the real workspace immediately. A richer server snapshot can
        // hydrate in the background without holding the preview behind I/O.
        void launchM1({
          projectId: project.id,
          continueExisting: true,
          projectName: project.name || cachedSession?.projectName || project.id,
          planMode: false,
        });

        void loadProjectSessionAsync(project.id, {
          id: project.id,
          name: project.name || project.id,
        }).then((saved) => {
          if (!saved) return;
          if (!cachedSession || sessionWorkspaceRichness(saved) > sessionWorkspaceRichness(cachedSession)) {
            applySavedSession(saved);
          }
        });
      } catch (error) {
        console.warn("Failed to open Vibe project in M1", error);
      }
    },
    [applySavedSession, launchM1, persistCurrentSession, restoreProject, setState],
  );

  const handlePreviewAutofix = useCallback((errMsg: string) => {
    if (!state.projectId || state.projectId === "project-advanced-vibe") return;
    void fetch(`/api/vibe/runtime/${encodeURIComponent(state.projectId)}/control`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "steer", message: `Preview failure observed by Clyra: ${errMsg}\nInspect the relevant files, repair it, and rerun preview validation.` }),
    });
  }, [state.projectId]);

  const exitM1ToWelcome = useCallback(() => {
    const projectId = state.projectId;
    persistCurrentSession();
    setM1LaunchError(null);
    setM1Launching(false);
    setM1Runtime(null);
    setM1RuntimeEvents([]);
    setM1ConversationUrl(null);
    resetToIdle();
    setWelcomeView("home");
    if (projectId && projectId !== "project-advanced-vibe") {
      void fetch(`/api/vibe/projects/${encodeURIComponent(projectId)}/thumbnail/refresh`, {
        method: "POST",
      })
        .catch(() => undefined)
        .finally(() => {
          void loadProjects();
        });
    } else {
      void loadProjects();
    }
  }, [loadProjects, persistCurrentSession, resetToIdle, state.projectId]);

  if (VIBE_PLAN_REVIEW_ENABLED && state.stage === "idle" && planDraft) {
    return (
      <div className="relative flex h-full min-h-0 w-full flex-col overflow-hidden bg-white">
        <div className="clyra-visible-scrollbar min-h-0 flex-1 overflow-y-auto px-5 py-6 sm:px-8">
          <motion.section
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.42, ease: [0.22, 1, 0.36, 1] }}
            className="relative mx-auto flex h-full w-full max-w-[1180px] flex-col pb-44"
          >
            <div className="mb-4 flex items-center justify-between">
              <span className="inline-flex items-center gap-2 text-[12px] font-semibold text-slate-500">
                <Brain className="h-4 w-4" /> Plan Mode
              </span>
              <button
                type="button"
                onClick={() => {
                  setPlanDraft(null);
                  setPlanChangeMode(false);
                  setPromptInput("");
                }}
                className="grid h-8 w-8 place-items-center rounded-full text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-900"
                aria-label="Close plan review"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className={cn("max-w-[680px] px-2 py-5 sm:px-3", planExpanded && "max-w-[32%]") }>
              <p className="text-[12px] font-semibold text-slate-400">Plan</p>
              <h1 className="mt-4 text-2xl font-semibold tracking-[-0.035em] text-slate-950 sm:text-4xl">
                {planDraft.title}
              </h1>
              <h2 className="mt-7 text-xl font-semibold tracking-[-0.025em] text-slate-950">Summary</h2>
              <p className="mt-3 max-w-[860px] text-[15px] leading-7 text-slate-600 sm:text-[17px]">
                {planDraft.summary}
              </p>
              <button
                type="button"
                data-agent-id="vibe-expand-plan"
                onClick={() => setPlanExpanded((expanded) => !expanded)}
                className="mt-6 inline-flex h-9 items-center gap-2 rounded-full border border-slate-200 bg-white px-3.5 text-[12px] font-semibold text-slate-700 transition-[background-color,border-color,transform] duration-200 hover:-translate-y-px hover:border-slate-300 hover:bg-slate-50"
              >
                <Maximize2 className="h-3.5 w-3.5" />
                {planExpanded ? "Hide full plan" : "View full plan"}
              </button>
            </div>

            <AnimatePresence initial={false}>
              {planExpanded ? (
                <motion.div
                  key="plan-browser-space"
                  initial={{ opacity: 0, height: 0, y: -10 }}
                  animate={{ opacity: 1, height: "min(72vh, 760px)", y: 0 }}
                  exit={{ opacity: 0, height: 0, y: -8 }}
                  transition={{ duration: 0.48, ease: [0.22, 1, 0.36, 1] }}
                  className="absolute bottom-40 right-0 top-16 w-[65%] overflow-hidden rounded-[18px] border border-slate-200 bg-slate-50/70 shadow-[0_18px_50px_rgba(15,23,42,0.055)]"
                >
                  <div className="flex h-11 items-center justify-between border-b border-slate-200 bg-white px-4">
                    <span className="text-[12px] font-semibold text-slate-500">Browser space · plan.md</span>
                    <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-slate-400"><CheckCircle2 className="h-3.5 w-3.5" /> Ready to review</span>
                  </div>
                  <div className="clyra-visible-scrollbar h-[calc(100%-44px)] overflow-y-auto bg-white px-6 py-5 sm:px-8">
                    <div className="max-w-none text-[14px] leading-7 text-slate-700">
                      <MarkdownMessageContent content={planDraft.markdown} />
                    </div>
                  </div>
                </motion.div>
              ) : null}
            </AnimatePresence>

            <AnimatePresence mode="wait">
              {planApproved ? (
                <motion.div
                  key="approved"
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -6 }}
                  className="mt-5 flex items-center gap-3 rounded-[18px] border border-slate-200 bg-white px-5 py-4 text-slate-900 shadow-[0_10px_30px_rgba(15,23,42,0.04)]"
                >
                  <span className="grid h-8 w-8 place-items-center rounded-full bg-slate-950 text-white"><Check className="h-4 w-4" /></span>
                  <div><p className="text-[14px] font-semibold">Plan approved</p><p className="text-[12px] text-slate-500">Saving plan.md and opening the build workspace.</p></div>
                </motion.div>
              ) : null}
            </AnimatePresence>

            <div className="absolute bottom-4 left-1/2 w-full max-w-[920px] -translate-x-1/2 px-2 sm:px-6">
              <Composer
                compact
                value={promptInput}
                onChange={setPromptInput}
                onSubmit={handlePlanRevisionSubmit}
                mode={mode}
                onModeChange={setMode}
                onAttach={() => fileRef.current?.click()}
                disabled={!promptInput.trim() || isPreparingPlan || isSavingPlan}
                isGenerating={isPreparingPlan || isSavingPlan}
                placeholder="Tell Clyra what to change..."
                activePlaceholder={planChangeMode ? "Tell Clyra what to do differently..." : undefined}
                planApprovalActive={!planApproved}
                onApprovePlan={() => void approvePlanAndBuild()}
                onRequestPlanChanges={() => setPlanChangeMode(true)}
                className="max-w-none rounded-[22px]"
              />
            </div>
          </motion.section>
        </div>
      </div>
    );
  }

  if (state.stage !== "idle") {
    return (
      <div className="relative flex h-full min-h-0 w-full flex-col overflow-hidden bg-white">
        {/* The four workspace surfaces (error, live canvas, runtime panel,
            preparing) used to hard-swap. Cross-fade them so the shell never
            pops between states. */}
        <AnimatePresence mode="wait" initial={false}>
        {m1LaunchError ? (
          <motion.div
            key="m1-error"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center"
          >
            <p className="text-[15px] font-semibold text-slate-900">
              Couldn’t start Vibe Coder M1
            </p>
            <p className="max-w-lg text-[13px] font-medium text-slate-500">
              {m1LaunchError}
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={exitM1ToWelcome}
                className="rounded-full border border-slate-200 bg-white px-4 py-2 text-[12px] font-bold text-slate-700"
              >
                Back
              </button>
              <button
                type="button"
                onClick={() =>
                  void launchM1({
                    projectId: state.projectId,
                    planMode: state.planMode,
                    continueExisting: true,
                    projectName: activeProjectName,
                  })
                }
                className="rounded-full bg-slate-950 px-4 py-2 text-[12px] font-bold text-white"
              >
                Retry
              </button>
            </div>
          </motion.div>
        ) : m1ConversationUrl ? (
          <motion.div
            key="m1-conversation"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            className="h-full min-h-0 w-full overflow-hidden bg-white"
          >
            <ElectronWebContentsSurface
              source={m1ConversationUrl}
              title="Vibe Coder M1"
              surfaceId={`m1-conversation-${state.projectId}`}
              kind="vibe-runtime"
              fallback={
                <iframe
                  title="Vibe Coder M1"
                  src={m1ConversationUrl}
                  className="h-full w-full border-0 bg-white"
                  allow="clipboard-read; clipboard-write; fullscreen"
                />
              }
            />
          </motion.div>
        ) : m1Runtime ? (
          <motion.div
            key="m1-runtime"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            className="flex min-h-0 flex-1 flex-col"
          >
          <M1RuntimePanel
            projectId={m1Runtime.projectId}
            snapshot={m1Runtime}
            events={m1RuntimeEvents}
            onControl={async (command, message) => {
              // Record pause intent before the request so a poll landing
              // mid-flight can't auto-resume a pause the user just asked for.
              if (command === "pause") userPausedRef.current = true;
              else userPausedRef.current = false;
              const response = await fetch(
                `/api/vibe/runtime/${encodeURIComponent(m1Runtime.projectId)}/control`,
                {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ command, message }),
                },
              );
              if (!response.ok) throw new Error("Unable to update the running task.");
              const data = await response.json() as { snapshot?: RuntimeSnapshot };
              if (data.snapshot) setM1Runtime(data.snapshot);
            }}
          />
          </motion.div>
        ) : (
          <motion.div
            key="m1-preparing"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            className="flex min-h-0 flex-1 items-center justify-center bg-white px-6"
          >
            <div className="w-full max-w-sm text-center">
              <div className="inline-flex items-center gap-2 text-[13px] font-medium text-slate-500">
                <ShiningBrainIcon />
                <span className="clyra-thinking-shimmer">Preparing your Vibe workspace</span>
                <ThinkingDots />
              </div>
              <p className="mt-2 text-[12px] text-slate-400">Connecting the build runtime and restoring its tools.</p>
            </div>
          </motion.div>
        )}
        </AnimatePresence>
      </div>
    );
  }

  // IDLE WELCOME PAGE
  // IDLE WELCOME PAGE
  return (
    <div className="relative flex h-full min-h-0 w-full flex-col overflow-hidden bg-white">
      <div
        ref={welcomeScrollRef}
        className={cn(
          "clyra-visible-scrollbar flex min-h-0 flex-1 flex-col overflow-y-auto px-5 sm:px-8",
          welcomeView === "projects" ? "pt-3" : "pt-16",
        )}
      >
        <AnimatePresence mode="wait">
          {welcomeView === "home" && state.stage === "idle" ? (
            <motion.section
              key="welcome"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
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
                Generate, validate, preview, save and reopen real Vibe projects.
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
                  disabled={!promptInput.trim() || m1Launching}
                  isGenerating={false}
                />
              </motion.div>

              <AnimatePresence initial={false}>
                {m1Launching ? (
                  <motion.div
                    key="vibe-launching"
                    initial={{ opacity: 0, y: 5 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -4 }}
                    transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
                    className="-mt-2 mb-5 inline-flex items-center gap-2 text-[13px] font-medium text-slate-500"
                    aria-live="polite"
                  >
                    <ShiningBrainIcon />
                    <span className="clyra-thinking-shimmer">Thinking</span>
                    <ThinkingDots />
                    <span className="text-slate-400">Opening your Vibe workspace</span>
                  </motion.div>
                ) : null}
              </AnimatePresence>

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
      <ProjectActionDialog
        dialog={projectDialog}
        value={projectRename}
        onChange={setProjectRename}
        onClose={() => setProjectDialog(null)}
        onRename={renameProject}
        onDelete={deleteProject}
      />
    </div>
    );
  }

function M1RuntimePanel({
  projectId,
  snapshot,
  events,
  onControl,
}: {
  projectId: string;
  snapshot: RuntimeSnapshot;
  events: RuntimeEvent[];
  onControl: (command: "pause" | "resume" | "cancel" | "steer", message?: string) => Promise<void>;
}) {
  const [steer, setSteer] = useState("");
  const [busy, setBusy] = useState(false);
  const terminal = ["COMPLETED", "FAILED", "CANCELLED", "INTERRUPTED", "INCOMPLETE"].includes(snapshot.state);
  const active = !terminal && snapshot.state !== "PAUSED" && snapshot.state !== "AWAITING_PLAN_APPROVAL";
  const latest = events.slice(-18).reverse();
  const run = async (command: "pause" | "resume" | "cancel" | "steer") => {
    setBusy(true);
    try {
      await onControl(command, command === "steer" ? steer : undefined);
      if (command === "steer") setSteer("");
    } finally {
      setBusy(false);
    }
  };
  return (
    <motion.section
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
      className="clyra-visible-scrollbar h-full overflow-y-auto bg-white px-5 py-6 sm:px-8"
    >
      <div className="mx-auto grid w-full max-w-[1240px] gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 rounded-[20px] border border-slate-200/80 bg-white p-5 shadow-[0_14px_42px_rgba(15,23,42,0.045)]">
          <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-100 pb-4">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400">Clyra agent runtime</p>
              <h2 className="mt-1 flex items-center gap-2 text-[18px] font-semibold text-slate-950">
                {active ? (
                  <>
                    <ShiningBrainIcon />
                    <span className="clyra-thinking-shimmer">{snapshot.state.replaceAll("_", " ")}</span>
                    <ThinkingDots />
                  </>
                ) : (
                  snapshot.state.replaceAll("_", " ")
                )}
              </h2>
              <p className="mt-1 max-w-2xl text-[13px] leading-5 text-slate-500">{snapshot.stateReason || "Waiting for the next verified runtime event."}</p>
            </div>
            <div className="flex items-center gap-2">
              {/* Fade controls in/out instead of mounting them abruptly when
                  the runtime state flips between running and paused. */}
              <AnimatePresence initial={false} mode="popLayout">
                {active ? (
                  <motion.button key="rt-pause" initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.95 }} transition={{ duration: 0.18, ease: "easeOut" }} type="button" disabled={busy} onClick={() => void run("pause")} className="rounded-full border border-slate-200 px-3 py-1.5 text-[12px] font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-50">Pause</motion.button>
                ) : null}
                {snapshot.state === "PAUSED" ? (
                  <motion.button key="rt-resume" initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.95 }} transition={{ duration: 0.18, ease: "easeOut" }} type="button" disabled={busy} onClick={() => void run("resume")} className="rounded-full bg-slate-950 px-3 py-1.5 text-[12px] font-semibold text-white transition hover:bg-slate-800 disabled:opacity-50">Resume</motion.button>
                ) : null}
                {!terminal ? (
                  <motion.button key="rt-stop" initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.95 }} transition={{ duration: 0.18, ease: "easeOut" }} type="button" disabled={busy} onClick={() => void run("cancel")} className="rounded-full border border-slate-200 px-3 py-1.5 text-[12px] font-semibold text-slate-600 transition hover:border-rose-200 hover:text-rose-600 disabled:opacity-50">Stop</motion.button>
                ) : null}
              </AnimatePresence>
            </div>
          </div>
          <div className="mt-5 space-y-2">
            <AnimatePresence initial={false}>
              {latest.length ? latest.map((event) => (
                <motion.div
                  key={event.id}
                  layout
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
                  className="flex items-start gap-3 rounded-xl px-3 py-2.5 transition hover:bg-slate-50"
                >
                  <span className={cn("mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full", event.status === "failed" ? "bg-rose-500" : event.status === "completed" ? "bg-emerald-500" : "bg-blue-500")} />
                  <div className="min-w-0 flex-1">
                    <p className="text-[12px] font-semibold text-slate-800">{event.type.replaceAll(".", " · ").replaceAll("_", " ")}</p>
                    <p className="mt-0.5 truncate text-[11px] text-slate-500">{String(event.payload.summary || event.payload.reason || event.error?.message || "Runtime activity")}</p>
                  </div>
                  <time className="shrink-0 text-[10px] text-slate-400">{new Date(event.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
                </motion.div>
              )) : <PreviewSkeletonLayout message="Connecting to the M1 event stream…" />}
            </AnimatePresence>
          </div>
        </div>
        <aside className="space-y-4">
          <div className="rounded-[18px] border border-slate-200/80 bg-slate-50/80 p-4">
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400">Validation</p>
            <div className="mt-3 space-y-2">
              {snapshot.validation.length ? snapshot.validation.map((check) => <div key={check.name} className="flex items-center justify-between text-[12px]"><span className="truncate text-slate-600">{check.name}</span><span className={cn("font-semibold", check.status === "passed" ? "text-emerald-600" : check.status === "failed" ? "text-rose-600" : "text-slate-400")}>{check.status}</span></div>) : <p className="text-[12px] leading-5 text-slate-500">Validation starts after M1 reports that implementation is complete.</p>}
            </div>
          </div>
          {!terminal ? <form onSubmit={(event) => { event.preventDefault(); if (steer.trim()) void run("steer"); }} className="rounded-[18px] border border-slate-200/80 bg-white p-4 shadow-[0_8px_24px_rgba(15,23,42,0.035)]">
            <label className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400" htmlFor={`vibe-steer-${projectId}`}>Steer active task</label>
            <textarea id={`vibe-steer-${projectId}`} value={steer} onChange={(event) => setSteer(event.target.value)} placeholder="Add a focused instruction…" className="mt-3 min-h-20 w-full resize-none rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-[12px] text-slate-700 outline-none transition focus:border-slate-400" />
            <button type="submit" disabled={busy || !steer.trim()} className="mt-2 w-full rounded-xl bg-slate-950 px-3 py-2 text-[12px] font-semibold text-white transition hover:bg-slate-800 disabled:opacity-40">Send instruction</button>
          </form> : null}
        </aside>
      </div>
    </motion.section>
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
            {item.type === "file" && item.filePath ? (
              <FileEditActivity item={item} />
            ) : item.type === "stage" && item.status === "active" ? (
              // Active agent thoughts use the same treatment as chat thinking:
              // shimmering brain, shimmering text, trailing dots.
              <span className="flex min-w-0 items-center gap-2">
                <ShiningBrainIcon className="shrink-0" />
                <span className="clyra-thinking-shimmer min-w-0 truncate text-[13px] font-bold tracking-[-0.01em]">
                  {item.title}
                </span>
                <ThinkingDots className="shrink-0" />
              </span>
            ) : (
              <p className="min-w-0 truncate text-[13px] font-bold tracking-[-0.01em] text-slate-800">
                {item.title}
              </p>
            )}
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

function AnimatedDiffCount({ value, tone, active }: { value: number; tone: "add" | "remove"; active: boolean }) {
  const [displayed, setDisplayed] = useState(0);

  useEffect(() => {
    const target = Math.max(0, value);
    if (!target) {
      setDisplayed(0);
      return;
    }
    let frame = 0;
    const startedAt = performance.now();
    const duration = active ? 720 : 420;
    const tick = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / duration);
      setDisplayed(Math.round(target * (1 - Math.pow(1 - progress, 3))));
      if (progress < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [active, value]);

  return (
    <span className={cn("font-mono text-[11px] font-bold tabular-nums", tone === "add" ? "text-emerald-700" : "text-rose-600")}>
      {tone === "add" ? "+" : "-"}{displayed}
    </span>
  );
}

function FileEditActivity({ item }: { item: AgentActivityItem }) {
  const active = item.status === "active";
  const isEdit = /edit/i.test(item.title);
  const action = active ? (isEdit ? "Editing" : "Generating") : isEdit ? "Edited" : "Created";
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      {/* While the agent is writing, the whole "Editing <path>" phrase shimmers
          like the thinking state; once done it settles into static slate text. */}
      <span className={cn("text-[13px] font-bold", active ? "clyra-thinking-shimmer" : "text-sky-600")}>{action}</span>
      <span className={cn("max-w-[260px] truncate font-mono text-[12px] font-semibold", active ? "clyra-thinking-shimmer" : "text-slate-600")}>
        {item.filePath}
      </span>
      {active ? <ThinkingDots className="shrink-0" /> : null}
      <motion.span
        layout
        initial={{ opacity: 0, scale: 0.94 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
        className="inline-flex items-center gap-1.5 rounded-full bg-slate-50 px-2 py-0.5"
      >
        <AnimatedDiffCount value={item.added ?? 0} tone="add" active={active} />
        <AnimatedDiffCount value={item.removed ?? 0} tone="remove" active={active} />
      </motion.span>
    </div>
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
      className="relative -mt-1 mx-auto flex w-full max-w-[760px] flex-col items-center pb-10 pt-0 text-center"
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-[-12%] -top-6 h-[180px] rounded-[48%] bg-[radial-gradient(ellipse_at_center,rgba(148,163,184,0.16)_0%,rgba(255,255,255,0)_70%)] blur-2xl"
      />

      <div className="relative z-[1] mb-2 flex w-full flex-col items-center">
        <button
          type="button"
          onClick={onBack}
          className="mb-1 self-start rounded-full border border-slate-200/80 bg-white/80 px-3 py-1.5 text-[11px] font-bold text-slate-500 shadow-[0_8px_20px_rgba(15,23,42,0.035)] transition-all hover:-translate-y-0.5 hover:border-slate-300 hover:text-slate-800"
        >
          ← Back
        </button>

        <div className="mb-0 flex justify-center">
          <div className="scale-[0.55] origin-top">
            <AiOrb colorTheme={orbColorTheme} />
          </div>
        </div>
        <p className="text-[11px] font-black uppercase tracking-[0.18em] text-slate-300">
          Recent projects
        </p>
        <h2 className="mt-0.5 text-3xl font-semibold tracking-[-0.055em] text-slate-950 sm:text-[2.35rem]">
          All projects
        </h2>
        <p className="mt-1 max-w-2xl text-[13px] font-semibold text-slate-500 sm:text-[14px]">
          {filteredProjects.length} of {projects.length} workspaces — reopen, rename, or continue building.
        </p>
      </div>

      <div className="relative z-[1] mb-3 w-full max-w-[700px] space-y-2">
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
  isPaused = false,
  onStop,
  onResume,
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
  isPaused?: boolean;
  onStop?: () => void;
  onResume?: () => void;
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
                  Implement this plan?
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
                      Yes, implement this plan
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
                      No, tell Clyra what to do differently
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
            data-agent-id="vibe-request-input"
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
              {VIBE_PLAN_REVIEW_ENABLED ? <ModeDropdown mode={mode as any} onChange={onModeChange as any} /> : null}
              <button
                data-agent-id="vibe-send-request"
                type="button"
                disabled={isGenerating || isPaused ? false : disabled}
                onClick={() => {
                  if (isGenerating && onStop) {
                    onStop();
                    return;
                  }
                  if (isPaused && onResume) {
                    onResume();
                    return;
                  }
                  onSubmit();
                }}
                aria-label={
                  isGenerating ? "Pause agent" : isPaused ? "Resume agent" : "Send Vibe request"
                }
                className={cn(
                  "grid h-10 w-10 shrink-0 place-items-center rounded-full border transition-[background-color,border-color,color] duration-[120ms] ease-out",
                  disabled && !isGenerating && !isPaused
                    ? "border-transparent bg-transparent text-slate-300"
                    : "border-transparent bg-transparent text-slate-700 hover:border-slate-200/70 hover:bg-white/72 hover:text-slate-950",
                )}
              >
                {isGenerating ? (
                  <div className="h-3 w-3 rounded-[2px] bg-slate-700" />
                ) : isPaused ? (
                  <div className="ml-0.5 h-0 w-0 border-y-[6px] border-l-[10px] border-y-transparent border-l-slate-700" />
                ) : (
                  <Send className="h-5 w-5" />
                )}
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
