import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Bookmark,
  Check,
  ChevronDown,
  ChevronsDown,
  ChevronsUp,
  CircleCheck,
  CircleHelp,
  CirclePause,
  CirclePlay,
  CircleX,
  Clock3,
  Crop,
  Download,
  Ellipsis,
  ExternalLink,
  Eye,
  FileDown,
  Globe2,
  History,
  Keyboard,
  Loader2,
  LockKeyhole,
  Minus,
  MousePointer2,
  MousePointerClick,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Settings2,
  ShieldCheck,
  Star,
  Trash2,
  TriangleAlert,
  UserRound,
  X,
  type LucideIcon,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { createPortal } from "react-dom";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { cn } from "../lib/utils";
import { getElectronDesktop, isElectronRuntime, requestElectronBrowser } from "../lib/electron-runtime";
import { ElectronWebContentsSurface } from "./ElectronWebContentsSurface";
import { BrowserStartPage, hasUsedAskClyra, isBrowserStartPageUrl, markAskClyraUsed } from "./BrowserStartPage";
import { ShiningBrainIcon, ShiningText, ThinkingDots } from "./ShiningText";
import { Bloub } from "./bloub/Bloub";

function useLiveAccentColor(fallback = "#2563eb") {
  const [color] = useState(() => {
    if (typeof document === "undefined") return fallback;
    const value = getComputedStyle(document.documentElement).getPropertyValue("--accent-600").trim();
    return value || fallback;
  });
  return color;
}

type AgentStatus =
  | "idle"
  | "planning"
  | "observing"
  | "executing"
  | "verifying"
  | "recovering"
  | "waiting_for_user"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

type BrowserSettings = {
  defaultSearchEngine: "bing" | "google" | "duckduckgo";
  restoreTabs: boolean;
  saveHistory: boolean;
  showBookmarksBar: boolean;
  showAiCursor: boolean;
  showAiActionLabels: boolean;
  aiCursorSpeed: "instant" | "fast" | "natural";
  reducedMotion: boolean;
  performanceMode: "quality" | "balanced" | "efficient";
  privateMode: boolean;
};

type BrowserTab = {
  id: string;
  title: string;
  url: string;
  active: boolean;
  loading: boolean;
  favicon?: string;
  zoom: number;
};

type InternalBrowserPage = "history" | "bookmarks" | "settings";

type InternalBrowserTab = {
  id: string;
  page: InternalBrowserPage;
};

type BrowserHistoryEntry = {
  id: string;
  title: string;
  url: string;
  visitedAt: string;
  visitCount: number;
  query?: string;
};

type BrowserBookmark = {
  id: string;
  title: string;
  url: string;
  folder: string;
};

type BrowserDownload = {
  id: string;
  filename: string;
  url: string;
  status: "running" | "complete" | "failed" | "cancelled";
  path?: string;
  error?: string;
};

interface BrowserState {
  url: string;
  title: string;
  frameVersion: number;
  viewport: { width: number; height: number; scrollX: number; scrollY: number; pageHeight: number };
  loading: boolean;
  tabs: BrowserTab[];
  activeTabId: string;
  canGoBack: boolean;
  canGoForward: boolean;
  secure: boolean;
  zoom: number;
  history: BrowserHistoryEntry[];
  bookmarks: BrowserBookmark[];
  recentlyClosed: Array<{ id: string; title: string; url: string; closedAt: string }>;
  downloads: BrowserDownload[];
  settings: BrowserSettings;
  agent: { status: AgentStatus; paused: boolean; manualControl: boolean; task?: string };
}

type BrowserAction =
  | { type: "back" | "forward" | "reload" | "stop_loading" | "open_tab" | "restore_closed_tab" }
  | { type: "switch_tab" | "close_tab" | "duplicate_tab"; tabId: string }
  | { type: "click_at"; x: number; y: number }
  | { type: "press"; key: string }
  | { type: "type"; text: string; submit?: boolean; clearFirst?: boolean }
  | { type: "scroll"; direction: "up" | "down"; amount: number };

type AgentCursor = {
  id: number;
  x: number;
  y: number;
  kind: "move" | "click" | "double_click" | "right_click" | "hover" | "type" | "scroll";
  label: string;
};

type TaskPlan = {
  goal: string;
  steps: Array<{ id: string; label: string; status: "pending" | "active" | "complete" | "blocked" }>;
  successCriteria: string[];
};

type StepEvaluation = { verdict: "Success" | "Failure" | "Uncertain"; reason?: string };

type CompletionEvidence = { url: string; title: string; checks: string[] };

/** A progress event streamed over SSE or replayed from the persisted session. */
type RunEvent = {
  phase?: AgentStatus;
  kind?: string;
  message?: string;
  step?: number;
  action?: Record<string, unknown> & { type?: string };
  evaluation?: StepEvaluation;
  memory?: string;
  nextGoal?: string;
  actionIndex?: number;
  actionCount?: number;
  success?: boolean;
  evidence?: CompletionEvidence;
};

type RunItem =
  | { id: string; kind: "reasoning"; step?: number; evaluation?: StepEvaluation; nextGoal: string; memory?: string }
  | { id: string; kind: "action"; step?: number; actionType: string; label: string; icon: ActionIconKey; status: "running" | "success" | "error"; detail: string; result?: string }
  | { id: string; kind: "recovery" | "strategy"; message: string }
  | { id: string; kind: "ask"; question: string }
  | { id: string; kind: "complete"; success: boolean; message: string; evidence?: CompletionEvidence };

type AgentSession = {
  id: string;
  task: string;
  status: AgentStatus;
  message: string;
  startedAt: string;
  updatedAt: string;
  plan?: TaskPlan;
  completedCriteria: number;
  totalCriteria: number;
  factCount: number;
  recentEvents: Array<RunEvent & { phase: AgentStatus; message: string }>;
  result?: {
    message: string;
    steps: string[];
    facts: Array<{ claim: string; sourceUrl: string }>;
  };
};

interface AgentMessage {
  id: string;
  role: "assistant" | "user";
  content: string;
  steps?: string[];
  facts?: Array<{ claim: string; sourceUrl: string }>;
}

const BROWSER_CHAT_STORAGE = "clyra-browser-agent-chat-v3";
const BROWSER_CHAT_STORAGE_LEGACY = "clyra-browser-agent-chat-v2";
const ACTIVE_AGENT_PHASES = new Set<AgentStatus>([
  "planning",
  "observing",
  "executing",
  "verifying",
  "recovering",
  "waiting_for_user",
  "paused",
]);

/** One shared agent chat for the whole browser workspace (all tabs). */
function initialAgentMessages(): AgentMessage[] {
  const withoutRetiredWelcome = (messages: AgentMessage[]) => messages.filter((message) =>
    !(message.role === "assistant" && /^Ready when you are\.?$/i.test(message.content.trim())),
  );
  if (typeof window !== "undefined") {
    try {
      const raw = window.localStorage.getItem(BROWSER_CHAT_STORAGE)
        || window.localStorage.getItem(BROWSER_CHAT_STORAGE_LEGACY)
        || "[]";
      const saved = JSON.parse(raw) as AgentMessage[] | Record<string, AgentMessage[]>;
      if (Array.isArray(saved)) return withoutRetiredWelcome(saved).slice(-60);
      if (saved && typeof saved === "object") {
        // Migrate v2 per-tab transcripts into one shared session.
        const merged = Object.values(saved)
          .filter((messages): messages is AgentMessage[] => Array.isArray(messages))
          .flat();
        return withoutRetiredWelcome(merged).slice(-60);
      }
    } catch {
      // A malformed local draft should not prevent the browser from opening.
    }
  }
  return [];
}

function looksLikeStaleFailureTranscript(messages: AgentMessage[]) {
  if (!messages.length) return false;
  const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
  if (!lastAssistant) return false;
  return /could not complete|task not completed|was not verified|i stopped instead of looping|failed/i.test(lastAssistant.content);
}

type SideView = "agent" | "history" | "bookmarks" | "downloads" | "settings";

type SnipCard = {
  image: string;
  text: string;
  rect: { x: number; y: number; width: number; height: number };
  pageUrl?: string;
  pageTitle?: string;
  left: number;
  top: number;
  status: "loading" | "done" | "error";
  direct?: string;
  explanation?: string;
  error?: string;
};

const defaultSettings: BrowserSettings = {
  defaultSearchEngine: "google",
  restoreTabs: true,
  saveHistory: true,
  showBookmarksBar: false,
  showAiCursor: true,
  showAiActionLabels: true,
  aiCursorSpeed: "fast",
  reducedMotion: false,
  performanceMode: "balanced",
  privateMode: false,
};

function displayHost(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "") || "New tab";
  } catch {
    return "New tab";
  }
}

function displayPageName(url: string, title?: string) {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    const knownNames: Record<string, string> = {
      "google.com": "Google",
      "github.com": "GitHub",
      "youtube.com": "YouTube",
      "docs.google.com": "Google Docs",
      "notion.so": "Notion",
      "figma.com": "Figma",
    };
    if (knownNames[hostname]) return knownNames[hostname];
    const hostLabel = hostname
      .split(".")
      .slice(0, -1)
      .join(" ")
      .replace(/[-_]+/g, " ")
      .replace(/\b\w/g, (letter) => letter.toUpperCase());
    if (hostLabel) return hostLabel;
  } catch {
    // A new tab is not necessarily a valid URL.
  }
  return title?.trim() || "New tab";
}

function compactUrl(url: string) {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname.replace(/^www\./, "")}${parsed.pathname === "/" ? "" : parsed.pathname}`;
  } catch {
    return url;
  }
}

function formatWhen(value: string) {
  const date = new Date(value);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) {
    return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function responseError(payload: unknown, fallback: string) {
  if (
    payload &&
    typeof payload === "object" &&
    "error" in payload &&
    payload.error &&
    typeof payload.error === "object" &&
    "message" in payload.error
  ) {
    return String(payload.error.message);
  }
  return fallback;
}

type ActionIconKey =
  | "click" | "keyboard" | "navigate" | "search" | "scrollDown" | "scrollUp"
  | "back" | "forward" | "reload" | "tab" | "wait" | "read" | "check" | "hover" | "done" | "ask" | "generic";

const ACTION_ICONS: Record<ActionIconKey, LucideIcon> = {
  click: MousePointerClick,
  keyboard: Keyboard,
  navigate: Globe2,
  search: Search,
  scrollDown: ChevronsDown,
  scrollUp: ChevronsUp,
  back: ArrowLeft,
  forward: ArrowRight,
  reload: RefreshCw,
  tab: Plus,
  wait: Clock3,
  read: Eye,
  check: Check,
  hover: MousePointer2,
  done: CircleCheck,
  ask: CircleHelp,
  generic: CircleHelp,
};

function truncateLabel(value: string, max = 30) {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function describeTarget(target: unknown): string {
  if (typeof target === "number") return `element ${target}`;
  if (target && typeof target === "object") {
    const record = target as Record<string, unknown>;
    const name = record.name || record.label || record.text || record.placeholder || record.testId || record.elementId;
    if (name) return `'${truncateLabel(String(name), 26)}'`;
  }
  return "the element";
}

/** One-line, browser-use style summary of a runtime action for the chat feed. */
function actionSummary(action: Record<string, unknown> & { type?: string }): { label: string; icon: ActionIconKey } {
  const type = String(action.type || "");
  switch (type) {
    case "click": case "double_click": case "right_click": case "click_at":
      return { label: `Clicking ${"x" in action ? "the page" : describeTarget(action.target)}`, icon: "click" };
    case "type":
      return { label: action.text ? `Typing "${truncateLabel(String(action.text), 24)}"` : "Typing into a field", icon: "keyboard" };
    case "press": case "press_key":
      return { label: `Pressing ${truncateLabel(String(action.key || "a key"), 16)}`, icon: "keyboard" };
    case "key_combination":
      return { label: `Pressing ${(Array.isArray(action.keys) ? action.keys : []).join("+") || "keys"}`, icon: "keyboard" };
    case "navigate": case "open_tab":
      return { label: `Opening ${displayHost(String(action.url || "")) || "a new tab"}`, icon: type === "open_tab" ? "tab" : "navigate" };
    case "search":
      return { label: `Searching "${truncateLabel(String(action.query || ""), 26)}"`, icon: "search" };
    case "scroll":
      return { label: `Scrolling ${String(action.direction || "down")}`, icon: action.direction === "up" ? "scrollUp" : "scrollDown" };
    case "scroll_to":
      return { label: `Scrolling to ${describeTarget(action.target)}`, icon: "scrollDown" };
    case "scroll_to_top": return { label: "Scrolling to the top", icon: "scrollUp" };
    case "scroll_to_bottom": return { label: "Scrolling to the bottom", icon: "scrollDown" };
    case "go_back": case "back": return { label: "Going back", icon: "back" };
    case "go_forward": case "forward": return { label: "Going forward", icon: "forward" };
    case "reload": return { label: "Reloading the page", icon: "reload" };
    case "stop_loading": return { label: "Stopping the page load", icon: "reload" };
    case "switch_tab": return { label: "Switching tab", icon: "tab" };
    case "close_tab": return { label: "Closing a tab", icon: "tab" };
    case "duplicate_tab": return { label: "Duplicating the tab", icon: "tab" };
    case "restore_closed_tab": return { label: "Restoring a closed tab", icon: "tab" };
    case "wait": return { label: "Waiting for the page", icon: "wait" };
    case "read_page": case "extract": case "inspect_element": return { label: "Reading the page", icon: "read" };
    case "find_text": return { label: `Finding "${truncateLabel(String(action.text || ""), 22)}"`, icon: "search" };
    case "select_option": return { label: `Selecting ${truncateLabel(String(action.label || action.value || "an option"), 22)}`, icon: "check" };
    case "check": return { label: `Checking ${describeTarget(action.target)}`, icon: "check" };
    case "uncheck": return { label: `Unchecking ${describeTarget(action.target)}`, icon: "check" };
    case "hover": case "focus": return { label: `${type === "hover" ? "Hovering over" : "Focusing"} ${describeTarget(action.target)}`, icon: "hover" };
    case "drag": return { label: "Dragging an element", icon: "hover" };
    case "download": return { label: "Downloading a file", icon: "generic" };
    case "done": return { label: "Finishing up", icon: "done" };
    case "ask_user": return { label: "Asking you a question", icon: "ask" };
    default: return { label: truncateLabel(type.replace(/_/g, " ") || "Working", 30), icon: "generic" };
  }
}

let runItemSequence = 0;
const nextRunItemId = () => `run-${++runItemSequence}`;
const MAX_RUN_ITEMS = 80;

/** Folds one streamed progress event into the browser-use style run feed. */
function reduceRunItems(items: RunItem[], event: RunEvent): RunItem[] {
  const phase = event.phase;
  if (!phase) return items;
  const next = [...items];
  const finishRunning = (status: "success" | "error", result?: string) => {
    for (let index = next.length - 1; index >= 0; index -= 1) {
      const item = next[index];
      if (item.kind === "action" && item.status === "running") {
        next[index] = { ...item, status, result: result ?? item.result };
        return;
      }
    }
  };
  if (event.kind === "reasoning" && (event.nextGoal || event.evaluation || event.memory)) {
    next.push({
      id: nextRunItemId(),
      kind: "reasoning",
      step: event.step,
      evaluation: event.evaluation,
      nextGoal: event.nextGoal || event.message || "Deciding the next step",
      memory: event.memory,
    });
    return next.slice(-MAX_RUN_ITEMS);
  }
  if (phase === "executing" && event.action) {
    // A previous action still marked running had no explicit verification event.
    finishRunning("success");
    const summary = actionSummary(event.action);
    next.push({
      id: nextRunItemId(),
      kind: "action",
      step: event.step,
      actionType: String(event.action.type || ""),
      label: summary.label,
      icon: summary.icon,
      status: "running",
      detail: JSON.stringify(event.action, null, 2),
    });
    return next.slice(-MAX_RUN_ITEMS);
  }
  if (phase === "verifying" && event.action) {
    finishRunning("success", event.message);
    return next.slice(-MAX_RUN_ITEMS);
  }
  if (phase === "recovering") {
    finishRunning("error", event.message);
    const message = event.message || "Recovering";
    const last = next[next.length - 1];
    if (!(last && (last.kind === "recovery" || last.kind === "strategy") && last.message === message)) {
      next.push({ id: nextRunItemId(), kind: event.kind === "strategy" ? "strategy" : "recovery", message });
    }
    return next.slice(-MAX_RUN_ITEMS);
  }
  if (phase === "waiting_for_user") {
    next.push({ id: nextRunItemId(), kind: "ask", question: event.message || "The agent needs your input." });
    return next.slice(-MAX_RUN_ITEMS);
  }
  if (phase === "completed" || phase === "failed" || phase === "cancelled") {
    finishRunning(phase === "completed" ? "success" : "error");
    next.push({
      id: nextRunItemId(),
      kind: "complete",
      success: event.success ?? phase === "completed",
      message: event.message || "",
      evidence: event.evidence,
    });
    return next.slice(-MAX_RUN_ITEMS);
  }
  return items;
}

const TYPEWRITER_MS = 15;

/** Reveals text character-by-character; continues smoothly when `text` appends or updates. */
function TypewriterText({
  text,
  active = true,
  msPerChar = TYPEWRITER_MS,
  className,
  showCaret = true,
  onComplete,
}: {
  text: string;
  active?: boolean;
  msPerChar?: number;
  className?: string;
  showCaret?: boolean;
  onComplete?: () => void;
}) {
  const [visibleLength, setVisibleLength] = useState(() => (active ? 0 : text.length));
  const revealedRef = useRef(active ? 0 : text.length);
  const previousTextRef = useRef(text);
  const completedRef = useRef(!active);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  useEffect(() => {
    if (!active) {
      revealedRef.current = text.length;
      previousTextRef.current = text;
      setVisibleLength(text.length);
      return;
    }

    const previous = previousTextRef.current;
    previousTextRef.current = text;

    const isAppend = text.startsWith(previous) || previous.startsWith(text.slice(0, Math.min(previous.length, revealedRef.current)));
    if (!isAppend && previous !== text) {
      revealedRef.current = 0;
      completedRef.current = false;
      setVisibleLength(0);
    } else if (revealedRef.current > text.length) {
      revealedRef.current = text.length;
      setVisibleLength(text.length);
    }

    if (revealedRef.current >= text.length) {
      setVisibleLength(text.length);
      if (!completedRef.current) {
        completedRef.current = true;
        onCompleteRef.current?.();
      }
      return;
    }

    completedRef.current = false;
    let cancelled = false;
    let timer: number | null = null;
    const tick = () => {
      if (cancelled) return;
      if (revealedRef.current < previousTextRef.current.length) {
        revealedRef.current += 1;
        setVisibleLength(revealedRef.current);
        if (revealedRef.current >= previousTextRef.current.length) {
          if (!completedRef.current) {
            completedRef.current = true;
            onCompleteRef.current?.();
          }
          return;
        }
        timer = window.setTimeout(tick, msPerChar);
      }
    };
    timer = window.setTimeout(tick, msPerChar);
    return () => {
      cancelled = true;
      if (timer != null) window.clearTimeout(timer);
    };
  }, [text, active, msPerChar]);

  const done = visibleLength >= text.length;
  return (
    <span className={className}>
      {text.slice(0, visibleLength)}
      {showCaret && active && !done ? (
        <span className="ml-px inline-block h-[1em] w-[1.5px] translate-y-[0.12em] animate-pulse rounded-full bg-current opacity-55" aria-hidden />
      ) : null}
    </span>
  );
}

function IconButton({
  label,
  onClick,
  disabled,
  active,
  children,
  className,
}: {
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  active?: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "grid h-8 w-8 shrink-0 place-items-center rounded-[8px] text-[color:var(--atlas-text-secondary)] transition-[background-color,color,transform,opacity] duration-150 hover:bg-[color:var(--clyra-hover)] hover:text-[color:var(--atlas-text-primary)] active:scale-[0.94] disabled:pointer-events-none disabled:opacity-30",
        active && "bg-[color:var(--clyra-selected)] text-[color:var(--atlas-text-primary)]",
        className,
      )}
    >
      {children}
    </button>
  );
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (value: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative h-5 w-9 shrink-0 rounded-full border transition-[background-color,border-color] duration-150",
        checked
          ? "border-[color:var(--clyra-accent)] bg-[color:var(--clyra-accent)]"
          : "border-[color:var(--clyra-border-strong)] bg-[color:var(--clyra-surface-muted)]",
      )}
    >
      <span
        className={cn(
          "absolute top-[2px] h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-transform duration-150",
          checked ? "translate-x-[17px]" : "translate-x-[2px]",
        )}
      />
    </button>
  );
}

export default function WebBrowserWorkspace() {
  const desktopChromium = isElectronRuntime();
  const [browserState, setBrowserState] = useState<BrowserState | null>(null);
  const [address, setAddress] = useState("");
  const [task, setTask] = useState("");
  // Loading the persisted Chromium state is passive work. Treating it as a
  // navigation made a freshly opened Browser look as though Clyra was already
  // reading the restored page.
  const [isBrowserBusy, setIsBrowserBusy] = useState(false);
  const [isAgentBusy, setIsAgentBusy] = useState(false);
  const accentColor = useLiveAccentColor();
  const [showAskClyraPulse, setShowAskClyraPulse] = useState(() => !hasUsedAskClyra());
  useEffect(() => {
    if (!showAskClyraPulse) return;
    const timer = window.setTimeout(() => setShowAskClyraPulse(false), 6_000);
    return () => window.clearTimeout(timer);
  }, [showAskClyraPulse]);
  const [snipBusy, setSnipBusy] = useState(false);
  const [snipCard, setSnipCard] = useState<SnipCard | null>(null);
  const [snipFollowUp, setSnipFollowUp] = useState("");
  const [snipFollowUpBusy, setSnipFollowUpBusy] = useState(false);
  const [sideView, setSideView] = useState<SideView>("agent");
  // Start with Ask Clyra closed so a new browser / new tab opens on the page canvas.
  const [sideOpen, setSideOpen] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [findResult, setFindResult] = useState<{ total: number; current: number } | null>(null);
  const findInputRef = useRef<HTMLInputElement | null>(null);
  const [omniboxFocused, setOmniboxFocused] = useState(false);
  const [agentDemo] = useState(() => {
    if (typeof window === "undefined") return false;
    const mode = new URLSearchParams(window.location.search).get("browserDemo");
    return mode === "agent" || mode === "ebay" || mode === "typing" || mode === "click";
  });
  const [agentDemoKind] = useState(() => {
    if (typeof window === "undefined") return "agent" as const;
    const demo = new URLSearchParams(window.location.search).get("browserDemo");
    if (demo === "ebay") return "ebay" as const;
    // A focused visual-QA state for the real typing cursor treatment. It is
    // intentionally query-only and mirrors the same `type` event used by an
    // agent action, so we can inspect that state without submitting a task.
    if (demo === "typing") return "typing" as const;
    if (demo === "click") return "click" as const;
    return "agent" as const;
  });
  const [agentStatus, setAgentStatus] = useState("Ready");
  const [agentPhase, setAgentPhase] = useState<AgentStatus>("idle");
  const [liveSteps, setLiveSteps] = useState<string[]>([]);
  const [plan, setPlan] = useState<TaskPlan | null>(null);
  const [criteriaProgress, setCriteriaProgress] = useState({ complete: 0, total: 0 });
  const [factCount, setFactCount] = useState(0);
  const [activityOpen, setActivityOpen] = useState(false);
  const [planDisclosureOpen, setPlanDisclosureOpen] = useState(false);
  const [browserMenuOpen, setBrowserMenuOpen] = useState(false);
  const [hoveredBrowserTabId, setHoveredBrowserTabId] = useState<string | null>(null);
  // These pages deliberately live in the tab strip rather than the utility
  // drawer. They are browser destinations in their own right, while still
  // using the same persisted local profile as the native Chromium tabs.
  const [internalTabs, setInternalTabs] = useState<InternalBrowserTab[]>([]);
  const [activeInternalTabId, setActiveInternalTabId] = useState<string | null>(null);
  const [cursor, setCursor] = useState<AgentCursor | null>(null);
  const cursorIntent = truncateLabel(
    agentDemo
      ? (agentDemoKind === "ebay" ? "Opening MacBook M2 listing" : agentDemoKind === "typing" ? "Typing Clyra AI" : agentDemoKind === "click" ? "Opening result" : "Searching for sunscreen")
      : (agentStatus && agentStatus !== "Ready" ? agentStatus : cursor?.label || "Working"),
    44,
  );
  const [frameTick, setFrameTick] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [messages, setMessagesState] = useState<AgentMessage[]>(() => {
    const saved = initialAgentMessages();
    // Opening Browser on a finished failure should show welcome, not the last error.
    return looksLikeStaleFailureTranscript(saved) ? [] : saved;
  });
  const [runItems, setRunItems] = useState<RunItem[]>([]);
  const [runTask, setRunTask] = useState("");
  const [completedStepsOpen, setCompletedStepsOpen] = useState(false);
  const [agentControlledTabId, setAgentControlledTabId] = useState<string | null>(null);
  const streamingRunRef = useRef(false);
  const assistAbortRef = useRef<AbortController | null>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const typingBufferRef = useRef("");
  const typingTimerRef = useRef<number | null>(null);
  const scrollTimerRef = useRef<number | null>(null);
  const cursorSequenceRef = useRef(0);
  const mountedRef = useRef(true);
  const viewportSizeRef = useRef({ width: 0, height: 0 });
  const viewportTimerRef = useRef<number | null>(null);
  const previousActiveTabRef = useRef("default");
  const agentOriginTabRef = useRef<string | null>(null);
  const sideLockRef = useRef(false);
  const handledAgentSessionsRef = useRef(new Set(
    messages
      .map((message) => message.id)
      .filter((id) => id.startsWith("session-"))
      .map((id) => id.slice("session-".length)),
  ));
  const hydratedMessageIdsRef = useRef(new Set(messages.map((message) => message.id)));

  const setMessages = useCallback((update: React.SetStateAction<AgentMessage[]>) => {
    setMessagesState((current) => {
      const next = typeof update === "function" ? update(current) : update;
      return next.slice(-60);
    });
  }, []);

  const focusOmnibox = useCallback(() => {
    setOmniboxFocused(true);
    setAddress(browserState?.url || address);
    window.requestAnimationFrame(() => {
      const input = document.querySelector<HTMLInputElement>("[data-browser-omnibox]");
      input?.focus({ preventScroll: true });
      input?.select();
    });
  }, [address, browserState?.url]);

  const applyState = useCallback((state: BrowserState) => {
    const previousActive = previousActiveTabRef.current;
    previousActiveTabRef.current = state.activeTabId || previousActive;
    setBrowserState(state);
    setAddress(state.url);
    setAgentPhase(state.agent.status);
    setError(null);
    setFrameTick((value) => value + 1);
  }, []);

  const requestBrowser = useCallback(
    async (path: string, options: { method?: "GET" | "POST" | "PATCH" | "DELETE"; body?: unknown; quiet?: boolean } = {}) => {
      if (!options.quiet) setIsBrowserBusy(true);
      setError(null);
      try {
        const electronPayload = await requestElectronBrowser(path, { body: options.body });
        if (electronPayload) {
          if (!electronPayload?.ok) throw new Error(responseError(electronPayload, "Browser action failed."));
          if (electronPayload.state) applyState(electronPayload.state);
          return electronPayload;
        }
        const response = await fetch(path, {
          method: options.method || "POST",
          headers: options.body === undefined ? undefined : { "Content-Type": "application/json" },
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
        });
        const payload = await response.json();
        if (!response.ok || !payload?.ok) throw new Error(responseError(payload, "Browser action failed."));
        if (payload.state) applyState(payload.state);
        if (payload.cursor) {
          setCursor({ ...payload.cursor, id: ++cursorSequenceRef.current });
        }
        return payload;
      } catch (nextError) {
        const message = nextError instanceof Error ? nextError.message : "Browser action failed.";
        setError(message);
        throw nextError;
      } finally {
        if (!options.quiet) setIsBrowserBusy(false);
      }
    },
    [applyState],
  );

  const loadState = useCallback(async () => {
    try {
      await requestBrowser("/api/openbrowser/state", { method: "GET", quiet: true });
    } catch {
      // Error state is handled by requestBrowser.
    }
  }, [requestBrowser]);

  const applyAgentSession = useCallback((session: AgentSession | null) => {
    if (!session) {
      setIsAgentBusy(false);
      setAgentPhase("idle");
      setAgentStatus("Ready");
      if (!streamingRunRef.current) {
        setRunItems([]);
        setRunTask("");
      }
      return;
    }
    const active = ACTIVE_AGENT_PHASES.has(session.status);
    setIsAgentBusy(active);
    setAgentPhase(session.status);
    setAgentStatus(session.message || (active ? "Working" : "Ready"));
    if (session.plan) setPlan(session.plan);
    setCriteriaProgress({ complete: session.completedCriteria || 0, total: session.totalCriteria || 0 });
    setFactCount(session.factCount || 0);
    if (active && session.recentEvents?.length) {
      setLiveSteps(session.recentEvents.slice(-20).map((event) => `${event.phase}: ${event.message}`));
      // While an SSE stream is live it owns the run feed; the polled session
      // is only used to rebuild it after a reload/reconnect.
      if (!streamingRunRef.current) {
        setRunTask(session.task || "");
        setRunItems(session.recentEvents.reduce((acc, event) => reduceRunItems(acc, event), [] as RunItem[]));
      }
    } else if (!streamingRunRef.current) {
      // Idle reopen must not resurrect a finished Failed run card.
      setRunItems([]);
      setRunTask("");
      setLiveSteps([]);
    }
    if (!active) {
      // Mark finished sessions handled without injecting them into chat on open.
      if (session.id) handledAgentSessionsRef.current.add(session.id);
      agentOriginTabRef.current = null;
      setAgentControlledTabId(null);
    }
  }, []);

  const syncAgentSession = useCallback(async () => {
    try {
      const response = await fetch("/api/openbrowser/session", { cache: "no-store" });
      const payload = await response.json();
      if (response.ok && payload?.ok) applyAgentSession(payload.session as AgentSession | null);
    } catch {
      // The browser state request owns the visible connection error.
    }
  }, [applyAgentSession]);

  useEffect(() => {
    mountedRef.current = true;
    let cancelled = false;
    void (async () => {
      await loadState();
      await syncAgentSession();
      if (cancelled || !mountedRef.current) return;
      // Every Browser open lands on the large Clyra welcome (same as a new tab).
      await requestBrowser("/api/openbrowser/navigate", {
        body: { target: "https://www.google.com/" },
        quiet: true,
      }).catch(() => undefined);
      if (!cancelled && mountedRef.current) {
        setSideOpen(false);
        setAddress("google.com");
      }
    })();
    return () => {
      cancelled = true;
      mountedRef.current = false;
      if (typingTimerRef.current != null) window.clearTimeout(typingTimerRef.current);
      if (scrollTimerRef.current != null) window.clearTimeout(scrollTimerRef.current);
      if (viewportTimerRef.current != null) window.clearTimeout(viewportTimerRef.current);
    };
  }, [loadState, requestBrowser, syncAgentSession]);

  useEffect(() => {
    const desktop = getElectronDesktop();
    if (!desktop) return;
    const stopState = desktop.browser.onState((state) => applyState(state as BrowserState));
    const stopAddress = desktop.browser.onFocusAddress(focusOmnibox);
    const stopFind = desktop.browser.onFocusFind(() => {
      setFindOpen(true);
      window.setTimeout(() => findInputRef.current?.select(), 30);
    });
    return () => {
      stopState();
      stopAddress();
      stopFind();
    };
  }, [applyState, focusOmnibox]);

  useEffect(() => {
    window.localStorage.setItem(BROWSER_CHAT_STORAGE, JSON.stringify(messages));
  }, [messages]);

  useEffect(() => {
    if (!agentDemo) return;
    if (agentDemoKind === "ebay") {
      setMessagesState((current) => current.length ? current : [{
        id: "demo-user",
        role: "user",
        content: "Look at MacBook M2 on eBay and compare the best listings.",
      }, {
        id: "demo-assistant",
        role: "assistant",
        content: "I'll open eBay, search for MacBook M2 laptops, and compare condition, price, and seller ratings.",
      }]);
      setRunTask("Searching MacBook M2 on eBay");
      setAgentPhase("executing");
      setAgentStatus("Opening eBay listings");
      void requestBrowser("/api/openbrowser/navigate", {
        body: { target: "https://www.ebay.com/sch/i.html?_nkw=MacBook+M2&_sacat=0" },
        quiet: true,
      }).catch(() => undefined);
      return;
    }
    setMessagesState((current) => current.length ? current : [{
      id: "demo-user",
      role: "user",
      content: "Find well-rated sunscreen, beach towels and a bucket hat for a beach day.",
    }, {
      id: "demo-assistant",
      role: "assistant",
      content: "The usual. I’ll grab well-rated SPF 50 sunscreen, towels they love, and a sturdy bucket hat so you can enjoy the day.",
    }]);
    setRunTask("Fulfilling beach essentials request");
    setAgentPhase("executing");
    setAgentStatus("Comparing sunscreen");
  }, [agentDemo, agentDemoKind, requestBrowser]);

  useEffect(() => {
    const timer = window.setInterval(() => void syncAgentSession(), isAgentBusy ? 650 : 2_400);
    return () => window.clearInterval(timer);
  }, [isAgentBusy, syncAgentSession]);

  useEffect(() => {
    if (desktopChromium) return;
    const surface = previewRef.current;
    if (!surface || !browserState) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const displayWidth = Math.max(1, entry.contentRect.width);
      const displayHeight = Math.max(1, entry.contentRect.height);
      const scale = displayWidth < 760 ? 1.7 : 1.45;
      const width = Math.round(Math.max(900, Math.min(1_800, displayWidth * scale)));
      const height = Math.round(width * (displayHeight / displayWidth));
      const previous = viewportSizeRef.current;
      if (Math.abs(previous.width - width) < 12 && Math.abs(previous.height - height) < 12) return;
      viewportSizeRef.current = { width, height };
      if (viewportTimerRef.current != null) window.clearTimeout(viewportTimerRef.current);
      viewportTimerRef.current = window.setTimeout(() => {
        void requestBrowser("/api/openbrowser/viewport", { body: { width, height }, quiet: true }).catch(() => undefined);
      }, 180);
    });
    observer.observe(surface);
    return () => observer.disconnect();
  }, [browserState?.activeTabId, desktopChromium, requestBrowser]);

  useEffect(() => {
    if (desktopChromium) return;
    if (!browserState || document.visibilityState === "hidden") return;
    // Keep streamed browser actions legible without turning the page viewer into
    // a high-frequency screenshot loop while it is idle.
    const delay = isAgentBusy || browserState.loading ? 140 : 1_800;
    const timer = window.setTimeout(() => setFrameTick((value) => value + 1), delay);
    return () => window.clearTimeout(timer);
  }, [browserState, desktopChromium, frameTick, isAgentBusy]);

  const performAction = useCallback(
    async (action: BrowserAction, quiet = false) => {
      if (action.type === "open_tab") {
        setActiveInternalTabId(null);
        sideLockRef.current = false;
        setSideOpen(false);
        setSideView("agent");
      }
      return requestBrowser("/api/openbrowser/action", { body: { action }, quiet });
    },
    [requestBrowser],
  );

  const takeManualControl = useCallback(async () => {
    if (!isAgentBusy || browserState?.agent.manualControl) return;
    const response = await requestBrowser("/api/openbrowser/control", { body: { command: "take_control" }, quiet: true }).catch(() => null);
    const agent = response?.agent as { status?: AgentStatus; paused?: boolean; manualControl?: boolean } | undefined;
    if (agent) {
      setBrowserState((current) => current ? {
        ...current,
        agent: { ...current.agent, status: agent.status || "paused", paused: true, manualControl: true },
      } : current);
      setCursor(null);
    }
    setAgentPhase("paused");
    setAgentStatus("You have control");
  }, [browserState?.agent.manualControl, isAgentBusy, requestBrowser]);

  const navigate = async (event?: FormEvent, target = address) => {
    event?.preventDefault();
    if (!target.trim()) return;
    // Typing an address from a Clyra page returns to the last real browser tab.
    setActiveInternalTabId(null);
    await takeManualControl();
    await requestBrowser("/api/openbrowser/navigate", { body: { target } }).catch(() => undefined);
  };

  // "Snip & Ask": the toolbar crop icon and the "Ask Clyra about selection"
  // context-menu item both end here. A screenshot goes to the same Gemini
  // vision pipeline the voice-call camera already uses — the answer card
  // just formats the response as a direct answer first, explanation after.
  const askVisionSnip = useCallback(async (image: string, pageText: string, question: string) => {
    try {
      const response = await fetch("/api/companion/vision-frame", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          image,
          question:
            `${question}\n\n` +
            (pageText ? `Page text near the selection:\n${pageText.slice(0, 3000)}\n\n` : "") +
            "Answer in two parts: the direct answer first (one or two sentences, no preamble), " +
            "then, only if genuinely useful, a short \"Explanation\" section with a few key points. " +
            "Keep it compact — this renders in a small floating card.",
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload?.ok === false) {
        throw new Error(payload?.error || "Clyra couldn't read that selection.");
      }
      const text = String(payload.text || payload.summary || "").trim();
      const splitAt = text.search(/\n\s*(explanation|key points)[:\-]?/i);
      return splitAt > 0
        ? { direct: text.slice(0, splitAt).trim(), explanation: text.slice(splitAt).replace(/^\n?\s*(explanation|key points)[:\-]?\s*/i, "").trim() }
        : { direct: text, explanation: "" };
    } catch (error) {
      return { error: error instanceof Error ? error.message : "Clyra couldn't read that selection." };
    }
  }, []);

  const positionSnipCard = useCallback((rect: { x: number; y: number; width: number; height: number }) => {
    const hostRect = previewRef.current?.getBoundingClientRect();
    const cardWidth = 340;
    if (!hostRect) return { left: 80, top: 80 };
    const spaceRight = hostRect.width - (rect.x + rect.width);
    const left = spaceRight > cardWidth + 24
      ? hostRect.left + rect.x + rect.width + 14
      : Math.max(hostRect.left + 12, hostRect.left + rect.x - cardWidth - 14);
    const top = Math.min(hostRect.top + rect.y, hostRect.top + hostRect.height - 160);
    return { left: Math.round(left), top: Math.round(Math.max(hostRect.top + 12, top)) };
  }, []);

  const openSnipCard = useCallback(
    async (payload: { image: string; text: string; rect: { x: number; y: number; width: number; height: number }; pageUrl?: string; pageTitle?: string }) => {
      const { left, top } = positionSnipCard(payload.rect);
      setSnipCard({ ...payload, left, top, status: "loading" });
      const result = await askVisionSnip(
        payload.image,
        payload.text,
        "What is in this screenshot? If it's a question, problem, or diagram, answer or solve it directly.",
      );
      setSnipCard((current) => {
        if (!current || current.image !== payload.image) return current;
        return "error" in result && result.error
          ? { ...current, status: "error", error: result.error }
          : { ...current, status: "done", direct: result.direct, explanation: result.explanation };
      });
    },
    [askVisionSnip, positionSnipCard],
  );

  const handleSnip = useCallback(async () => {
    const desktop = getElectronDesktop();
    if (!desktop || snipBusy) return;
    setSnipBusy(true);
    try {
      const res = await desktop.browser.snip(browserState?.activeTabId);
      if (!res?.ok || res.cancelled || !res.image || !res.rect) return;
      void openSnipCard({ image: res.image, text: res.text || "", rect: res.rect, pageUrl: res.pageUrl, pageTitle: res.pageTitle });
    } finally {
      setSnipBusy(false);
    }
  }, [browserState?.activeTabId, openSnipCard, snipBusy]);

  const handleSnipFollowUp = useCallback(async () => {
    if (!snipCard || !snipFollowUp.trim()) return;
    setSnipFollowUpBusy(true);
    const question = snipFollowUp.trim();
    setSnipFollowUp("");
    const result = await askVisionSnip(snipCard.image, snipCard.text, question);
    setSnipFollowUpBusy(false);
    setSnipCard((current) => {
      if (!current) return current;
      if ("error" in result && result.error) return { ...current, status: "error", error: result.error };
      const appended = current.explanation ? `${current.explanation}\n\n— ${question}\n${result.direct}` : `— ${question}\n${result.direct}`;
      return { ...current, status: "done", direct: current.direct, explanation: appended };
    });
  }, [askVisionSnip, snipCard, snipFollowUp]);

  const handleSnipCardDragStart = useCallback((event: ReactMouseEvent) => {
    if (!snipCard) return;
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    const originLeft = snipCard.left;
    const originTop = snipCard.top;
    const onMove = (moveEvent: MouseEvent) => {
      setSnipCard((current) =>
        current ? { ...current, left: originLeft + (moveEvent.clientX - startX), top: originTop + (moveEvent.clientY - startY) } : current,
      );
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [snipCard]);

  // The context-menu path (right-click → "Ask Clyra about selection") sends
  // plain text, not a screenshot — route it straight into the existing "Ask
  // Clyra" chat panel instead of the floating card, since there's no image
  // for the vision pipeline to look at.
  useEffect(() => {
    const desktop = getElectronDesktop();
    if (!desktop) return;
    return desktop.browser.onAskSelection(({ text }) => {
      if (!text?.trim()) return;
      setSideView("agent");
      setSideOpen(true);
      void runAgentTask(`About this selected text, answer or explain it:\n\n"${text.trim().slice(0, 2000)}"`);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const flushTyping = useCallback(() => {
    if (typingTimerRef.current != null) window.clearTimeout(typingTimerRef.current);
    typingTimerRef.current = null;
    const text = typingBufferRef.current;
    typingBufferRef.current = "";
    if (text) void performAction({ type: "type", text }, true);
  }, [performAction]);

  const controlAgent = async (command: "pause" | "resume" | "take_control" | "return_control" | "stop") => {
    if (command === "stop") {
      assistAbortRef.current?.abort();
      assistAbortRef.current = null;
      streamingRunRef.current = false;
      setIsAgentBusy(false);
      setAgentPhase("idle");
      setAgentStatus("Ready");
      setCursor(null);
      setAgentControlledTabId(null);
      agentOriginTabRef.current = null;
    }
    const response = await requestBrowser("/api/openbrowser/control", { body: { command }, quiet: true }).catch(() => null);
    if (!response) return;
    const agent = response.agent as { status?: AgentStatus; paused?: boolean; manualControl?: boolean } | undefined;
    if (agent) {
      setBrowserState((current) => current ? {
        ...current,
        agent: {
          ...current.agent,
          status: agent.status || current.agent.status,
          paused: Boolean(agent.paused),
          manualControl: Boolean(agent.manualControl),
        },
      } : current);
      if (agent.manualControl || command === "pause") setCursor(null);
    }
    if (command === "stop") {
      setAgentStatus("Ready");
    } else if (command === "pause" || command === "take_control") {
      setAgentPhase("paused");
      setAgentStatus(command === "take_control" ? "You have control" : "Task paused");
    } else {
      setAgentPhase("observing");
      setAgentStatus("Reading the current page");
    }
  };

  const runAgentTask = async (taskOverride?: string) => {
    const cleanTask = (taskOverride ?? task).trim();
    if (!cleanTask || isAgentBusy) return;
    const originTabId = browserState?.activeTabId || previousActiveTabRef.current || "default";
    agentOriginTabRef.current = originTabId;
    setAgentControlledTabId(originTabId);
    setTask("");
    setIsAgentBusy(true);
    sideLockRef.current = true;
    setSideOpen(true);
    setSideView("agent");
    setAgentPhase("planning");
    setAgentStatus("Building a plan");
    setLiveSteps([]);
    setPlan(null);
    setCriteriaProgress({ complete: 0, total: 0 });
    setFactCount(0);
    streamingRunRef.current = true;
    setRunItems([]);
    setRunTask(cleanTask);
    setCompletedStepsOpen(false);
    // Let the sidebar width animation start, then float the user bubble up.
    await new Promise<void>((resolve) => {
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve()));
    });
    setMessages((current) => [...current, { id: `user-${Date.now()}`, role: "user", content: cleanTask }]);
    const abort = new AbortController();
    assistAbortRef.current?.abort();
    assistAbortRef.current = abort;
    try {
      const response = await fetch("/api/openbrowser/assist", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({ task: cleanTask, tabId: originTabId }),
        signal: abort.signal,
      });
      if (!response.ok || !response.body) {
        const payload = await response.json().catch(() => null);
        throw new Error(responseError(payload, "The browser agent could not start that task."));
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let completePayload: Record<string, unknown> | null = null;
      let acknowledgedPlan = false;
      while (true) {
        if (abort.signal.aborted) break;
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split("\n\n");
        buffer = events.pop() || "";
        for (const event of events) {
          const line = event.split("\n").find((item) => item.startsWith("data: "));
          if (!line) continue;
          const next = JSON.parse(line.slice(6)) as Record<string, any>;
          if (next.type === "error") throw new Error(responseError(next, "The browser agent could not complete that task."));
          if (typeof next.message === "string") setAgentStatus(next.message);
          if (next.state) applyState(next.state as BrowserState);
          if (next.plan) {
            setPlan(next.plan as TaskPlan);
            if (!acknowledgedPlan) {
              acknowledgedPlan = true;
              setMessages((current) => [
                ...current,
                {
                  id: `assistant-plan-${Date.now()}`,
                  role: "assistant",
                  content: "I’ll work through this in the browser, verify each result, and then bring back the outcome.",
                },
              ]);
            }
          }
          if (next.cursor) setCursor({ ...(next.cursor as Omit<AgentCursor, "id">), id: ++cursorSequenceRef.current });
          if (typeof next.completedCriteria === "number" || typeof next.totalCriteria === "number") {
            setCriteriaProgress((current) => ({
              complete: typeof next.completedCriteria === "number" ? next.completedCriteria : current.complete,
              total: typeof next.totalCriteria === "number" ? next.totalCriteria : current.total,
            }));
          }
          if (typeof next.facts === "number") setFactCount(next.facts);
          if (next.type === "progress" && next.phase) {
            setAgentPhase(next.phase as AgentStatus);
            setLiveSteps((current) => [...current.slice(-19), `${next.phase}: ${next.message || "Working"}`]);
            setRunItems((current) => reduceRunItems(current, next as RunEvent));
          }
          if (next.type === "complete") completePayload = next;
        }
      }
      if (abort.signal.aborted) {
        setMessages((current) => [
          ...current,
          { id: `assistant-stop-${Date.now()}`, role: "assistant", content: "Stopped." },
        ]);
        return;
      }
      if (!completePayload?.ok) throw new Error("The browser agent stopped before returning a verified result.");
      const payload = completePayload as Record<string, any>;
      if (payload.state) applyState(payload.state as BrowserState);
      const uniqueSources = Array.isArray(payload.facts)
        ? Array.from(
            new Map<string, { claim: string; sourceUrl: string }>(
              payload.facts
                .filter(
                  (fact: { claim?: unknown; sourceUrl?: unknown }) =>
                    typeof fact?.claim === "string" &&
                    typeof fact?.sourceUrl === "string" &&
                    fact.sourceUrl,
                )
                .map((fact: { claim: string; sourceUrl: string }) => [
                  fact.sourceUrl,
                  { claim: fact.claim, sourceUrl: fact.sourceUrl },
                ]),
            ).values(),
          )
        : undefined;
      setMessages((current) => [
        ...current,
        {
          id: `assistant-${Date.now()}`,
          role: "assistant",
          content: String(payload.content || "Done."),
          steps: Array.isArray(payload.steps) ? payload.steps : undefined,
          facts: uniqueSources,
        },
      ]);
    } catch (nextError) {
      if (abort.signal.aborted || (nextError instanceof DOMException && nextError.name === "AbortError")) {
        // Soft stop — already messaged above when aborting cleanly.
      } else {
        setMessages((current) => [
          ...current,
          {
            id: `error-${Date.now()}`,
            role: "assistant",
            content: nextError instanceof Error ? nextError.message : "The browser agent could not complete that task.",
          },
        ]);
      }
    } finally {
      if (assistAbortRef.current === abort) assistAbortRef.current = null;
      streamingRunRef.current = false;
      if (mountedRef.current) {
        setIsAgentBusy(false);
        setAgentPhase("idle");
        setAgentStatus("Ready");
        setAgentControlledTabId(null);
        agentOriginTabRef.current = null;
        setRunItems([]);
        setRunTask("");
        // A completed task hands the page straight back to the user.  Leaving
        // the last cursor coordinate on screen made an idle browser look as if
        // the agent still had the controls.
        setCursor(null);
      }
    }
  };

  const clickPreview = async (event: ReactMouseEvent<HTMLImageElement>) => {
    if (!browserState || isBrowserBusy) return;
    await takeManualControl();
    const rect = event.currentTarget.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * browserState.viewport.width;
    const y = ((event.clientY - rect.top) / rect.height) * browserState.viewport.height;
    previewRef.current?.focus();
    await performAction({ type: "click_at", x, y }, true).catch(() => undefined);
  };

  const handlePreviewWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    void takeManualControl();
    if (scrollTimerRef.current != null) window.clearTimeout(scrollTimerRef.current);
    const direction = event.deltaY < 0 ? "up" : "down";
    const amount = Math.max(180, Math.min(1_100, Math.abs(event.deltaY) * 2.2));
    scrollTimerRef.current = window.setTimeout(() => {
      void performAction({ type: "scroll", direction, amount }, true);
    }, 22);
  };

  const handlePreviewKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (showStartPage) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const supported = event.key.length === 1 || ["Enter", "Backspace", "Tab", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key);
    if (!supported) return;
    event.preventDefault();
    void takeManualControl();
    if (event.key.length === 1) {
      typingBufferRef.current += event.key;
      if (typingTimerRef.current != null) window.clearTimeout(typingTimerRef.current);
      typingTimerRef.current = window.setTimeout(flushTyping, 36);
      return;
    }
    if (event.key === "Enter" && typingBufferRef.current) {
      if (typingTimerRef.current != null) window.clearTimeout(typingTimerRef.current);
      const text = typingBufferRef.current;
      typingBufferRef.current = "";
      void performAction({ type: "type", text, submit: true }, true);
      return;
    }
    flushTyping();
    void performAction({ type: "press", key: event.key }, true);
  };

  const updateSettings = async (patch: Partial<BrowserSettings>) => {
    await requestBrowser("/api/openbrowser/settings", { method: "PATCH", body: patch, quiet: true }).catch(() => undefined);
  };

  const runFind = async (query: string) => {
    try {
      const payload = await requestBrowser("/api/openbrowser/find", { body: { text: query }, quiet: true });
      setFindResult(query ? payload?.result || { total: 0, current: 0 } : null);
    } catch {
      setFindResult(query ? { total: 0, current: 0 } : null);
    }
  };

  const closeFind = () => {
    setFindOpen(false);
    setFindQuery("");
    setFindResult(null);
    void requestBrowser("/api/openbrowser/find", { body: { text: "" }, quiet: true }).catch(() => undefined);
  };

  const saveBookmark = async () => {
    await requestBrowser("/api/openbrowser/bookmarks", { body: {}, quiet: true }).catch(() => undefined);
  };

  const toggleBookmark = async () => {
    const currentUrl = activeTab?.url || browserState?.url;
    if (!currentUrl || activeInternalTab) return;
    const existing = browserState?.bookmarks.find((bookmark) => bookmark.url === currentUrl);
    if (existing) {
      await requestBrowser(`/api/openbrowser/bookmarks/${existing.id}`, { method: "DELETE", quiet: true }).catch(() => undefined);
      return;
    }
    await saveBookmark();
  };

  const zoom = async (delta: number | "reset") => {
    await requestBrowser("/api/openbrowser/zoom", { body: { delta }, quiet: true }).catch(() => undefined);
  };

  useEffect(() => {
    const onShortcut = (event: globalThis.KeyboardEvent) => {
      const modifier = event.metaKey || event.ctrlKey;
      const target = event.target as HTMLElement | null;
      const typing = target?.matches("input, textarea, [contenteditable='true']");
      if (modifier && event.key.toLowerCase() === "l") {
        event.preventDefault();
        focusOmnibox();
      } else if (modifier && event.key.toLowerCase() === "t") {
        event.preventDefault();
        void performAction({ type: "open_tab" });
      } else if (modifier && event.shiftKey && event.key.toLowerCase() === "t") {
        event.preventDefault();
        void performAction({ type: "restore_closed_tab" });
      } else if (modifier && event.key.toLowerCase() === "w" && !typing && browserState?.activeTabId) {
        event.preventDefault();
        void performAction({ type: "close_tab", tabId: browserState.activeTabId });
      } else if (modifier && event.key.toLowerCase() === "r") {
        event.preventDefault();
        void performAction({ type: "reload" });
      } else if (modifier && (event.key === "+" || event.key === "=")) {
        event.preventDefault();
        void zoom(0.1);
      } else if (modifier && event.key === "-") {
        event.preventDefault();
        void zoom(-0.1);
      } else if (modifier && event.key === "0") {
        event.preventDefault();
        void zoom("reset");
      } else if (modifier && event.key.toLowerCase() === "f" && !typing) {
        // Electron's own Cmd+F is caught by the native window shortcut and
        // arrives via onFocusFind; this covers the web-preview fallback path
        // (no Electron bridge) so the same find bar still opens there.
        if (!getElectronDesktop()) {
          event.preventDefault();
          setFindOpen(true);
          window.setTimeout(() => findInputRef.current?.select(), 30);
        }
      } else if (event.key === "Escape" && findOpen) {
        closeFind();
      }
    };
    window.addEventListener("keydown", onShortcut);
    return () => window.removeEventListener("keydown", onShortcut);
  }, [browserState?.activeTabId, focusOmnibox, performAction, findOpen]);

  const settings = browserState?.settings || defaultSettings;

  useEffect(() => {
    const scroller = chatScrollRef.current;
    if (!scroller) return;
    const snap = () => {
      scroller.scrollTop = scroller.scrollHeight;
      chatEndRef.current?.scrollIntoView({ behavior: settings.reducedMotion ? "instant" as ScrollBehavior : "smooth", block: "end" });
    };
    snap();
    // Agent progress rows grow after the first paint — catch the final bottom.
    const t1 = window.setTimeout(snap, 80);
    const t2 = window.setTimeout(snap, 240);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, [messages.length, isAgentBusy, runItems.length, settings.reducedMotion, planDisclosureOpen, completedStepsOpen]);

  useEffect(() => {
    if (!desktopChromium) return;
    const desktop = getElectronDesktop();
    if (!desktop) return;
    if (!cursor || !isAgentBusy || !settings.showAiCursor || browserState?.agent.manualControl) {
      void desktop.browser.setCursor(null);
      return;
    }
    void desktop.browser.setCursor({
      ...cursor,
      label: cursorIntent,
      showLabel: settings.showAiActionLabels,
      reducedMotion: settings.reducedMotion,
    });
    return () => { void desktop.browser.setCursor(null); };
  }, [browserState?.agent.manualControl, cursor, cursorIntent, desktopChromium, isAgentBusy, settings.reducedMotion, settings.showAiActionLabels, settings.showAiCursor]);
  const pageHost = useMemo(() => displayHost(browserState?.url || address), [address, browserState?.url]);
  const activeTab = useMemo(
    () => browserState?.tabs.find((tab) => tab.active),
    [browserState?.tabs],
  );
  const activeInternalTab = useMemo(
    () => internalTabs.find((tab) => tab.id === activeInternalTabId) || null,
    [activeInternalTabId, internalTabs],
  );
  const currentPageBookmark = useMemo(() => {
    const url = activeTab?.url || browserState?.url;
    return url ? browserState?.bookmarks.find((bookmark) => bookmark.url === url) : undefined;
  }, [activeTab?.url, browserState?.bookmarks, browserState?.url]);
  const pageName = useMemo(
    () => displayPageName(activeTab?.url || browserState?.url || address, activeTab?.title || browserState?.title),
    [activeTab?.title, activeTab?.url, address, browserState?.title, browserState?.url],
  );
  const pageContextReady = Boolean((activeTab?.url || browserState?.url) && (activeTab?.title || browserState?.title));
  const latestSteps = liveSteps.length ? liveSteps : [...messages].reverse().find((message) => message.steps?.length)?.steps || [];
  const frameUrl = browserState
    ? `/api/openbrowser/frame?${isAgentBusy || agentDemo ? "fresh=1&" : ""}v=${browserState.frameVersion}&t=${frameTick}`
    : "";
  const showAgentChrome = isAgentBusy || agentDemo;
  const showStartPage =
    !activeInternalTab &&
    !showAgentChrome &&
    (!browserState || isBrowserStartPageUrl(activeTab?.url || browserState?.url || ""));

  // The Electron browser is a native sibling view rather than a DOM child.
  // Ensure it is explicitly hidden while Clyra owns the new-tab welcome
  // surface; otherwise an async surface update from the prior web page can
  // briefly leave a white Chromium layer above this React view.
  useEffect(() => {
    if (!desktopChromium || (!showStartPage && !activeInternalTab)) return;
    const desktop = getElectronDesktop();
    void desktop?.browser.setSurface({ visible: false });
  }, [activeInternalTab, desktopChromium, showStartPage]);
  const aiInControl = agentDemo
    || (["planning", "observing", "executing", "verifying", "recovering"].includes(agentPhase) && !browserState?.agent.manualControl);

  // Keep Ask Clyra closed on pure welcome loads, but never yank it shut mid-send.
  useEffect(() => {
    if (!showStartPage || sideLockRef.current || isAgentBusy) return;
    setSideOpen(false);
  }, [activeTab?.id, showStartPage, isAgentBusy]);
  const agentTaskTitle = agentDemo
    ? (agentDemoKind === "ebay" ? "Searching MacBook M2 on eBay" : agentDemoKind === "typing" ? "Typing a search query" : agentDemoKind === "click" ? "Opening a result" : "Fulfilling beach essentials request")
    : (runTask || browserState?.agent.task || agentStatus || "Working");
  const restingHost = activeInternalTab
    ? `Clyra ${activeInternalTab.page === "history" ? "History" : activeInternalTab.page === "bookmarks" ? "Bookmarks" : "Settings"}`
    : pageHost || "Search or enter address";
  const demoCursor = agentDemo
    ? {
        x: Math.round((browserState?.viewport.width || 1440) * (agentDemoKind === "ebay" ? 0.48 : agentDemoKind === "typing" ? 0.46 : agentDemoKind === "click" ? 0.52 : 0.42)),
        y: Math.round((browserState?.viewport.height || 900) * (agentDemoKind === "ebay" ? 0.44 : agentDemoKind === "typing" ? 0.36 : agentDemoKind === "click" ? 0.48 : 0.38)),
        kind: agentDemoKind === "typing" ? ("type" as const) : agentDemoKind === "click" ? ("click" as const) : ("move" as const),
        label: agentDemoKind === "ebay" ? "Opening MacBook M2 listing" : agentDemoKind === "typing" ? "Typing Clyra AI" : agentDemoKind === "click" ? "Opening result" : "Searching for sunscreen",
        id: 1,
      }
    : null;
  const liveCursor = cursor && isAgentBusy ? cursor : demoCursor;

  const openSideView = (view: SideView) => {
    sideLockRef.current = true;
    setSideView(view);
    setSideOpen(true);
    setBrowserMenuOpen(false);
  };

  const openInternalPage = (page: InternalBrowserPage) => {
    const existing = internalTabs.find((tab) => tab.page === page);
    const tabId = existing?.id || `clyra-${page}-${Date.now()}`;
    if (!existing) setInternalTabs((tabs) => [...tabs, { id: tabId, page }]);
    setActiveInternalTabId(tabId);
    sideLockRef.current = false;
    setSideOpen(false);
    setBrowserMenuOpen(false);
  };

  const closeInternalPage = (tabId: string) => {
    setInternalTabs((tabs) => tabs.filter((tab) => tab.id !== tabId));
    setActiveInternalTabId((active) => active === tabId ? null : active);
  };

  return (
    <div className="flex min-h-0 flex-1 bg-[var(--atlas-window-bg)]">
      <motion.div
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
        className="relative mx-auto flex h-full min-h-0 w-full max-w-none flex-col overflow-hidden bg-[var(--atlas-window-bg)]"
      >
        {/* Tab strip — full width */}
        <div
          className="flex shrink-0 items-end gap-0.5 overflow-x-auto px-2 pt-0.5 [scrollbar-width:none]"
          style={{ height: "var(--atlas-titlebar-height)", background: "var(--atlas-titlebar-bg)" }}
        >
          <AnimatePresence initial={false} mode="popLayout">
            {browserState?.tabs.map((tab) => {
              const agentOwnsTab = Boolean(
                agentControlledTabId
                && tab.id === agentControlledTabId
                && isAgentBusy
                && !browserState.agent.manualControl,
              );
              return (
              <motion.button
                key={tab.id}
                layout="position"
                initial={{ opacity: 0, scale: 0.98, x: -12 }}
                animate={{ opacity: 1, scale: 1, x: 0 }}
                exit={{ opacity: 0, scale: 0.98, x: -12 }}
                transition={{ type: "spring", stiffness: 440, damping: 34, mass: 0.5 }}
                type="button"
                onPointerEnter={() => setHoveredBrowserTabId(tab.id)}
                onPointerLeave={() => setHoveredBrowserTabId(null)}
                onClick={() => {
                  setActiveInternalTabId(null);
                  void performAction({ type: "switch_tab", tabId: tab.id });
                }}
                onAuxClick={(event) => {
                  if (event.button === 1 && browserState.tabs.length > 1) void performAction({ type: "close_tab", tabId: tab.id });
                }}
                className={cn(
                  "group/tab isolate relative mb-0 flex min-w-[170px] max-w-[210px] items-center gap-2 overflow-hidden px-[15px] text-left font-medium transition-[background-color,color] duration-150 ease-out",
                  tab.active && !activeInternalTab
                    ? agentOwnsTab
                      ? "h-[36px] rounded-t-[10px] bg-transparent text-[var(--atlas-text-secondary)]"
                      : "h-[36px] rounded-t-[10px] bg-[var(--atlas-tab-active)] text-[var(--atlas-text-primary)]"
                    : "mb-px h-[34px] rounded-[9px] text-[var(--atlas-text-secondary)]",
                  agentOwnsTab && "clyra-browser-agent-tab",
                )}
                style={{ fontSize: "13px" }}
                title={agentOwnsTab ? "Clyra is controlling this tab" : undefined}
              >
                {hoveredBrowserTabId === tab.id && !(tab.active && !activeInternalTab) ? <motion.span layoutId="browser-tab-hover" transition={{ type: "spring", stiffness: 580, damping: 42, mass: 0.42 }} className="pointer-events-none absolute inset-0 rounded-[9px] bg-black/[0.045]" /> : null}
                <span className="grid h-[18px] w-[18px] shrink-0 place-items-center rounded-[6px] bg-[#f3f5f7] text-[var(--atlas-text-secondary)]">
                  {tab.loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Globe2 className="h-3 w-3" strokeWidth={1.8} />}
                </span>
                {agentOwnsTab ? (
                  <ShiningText
                    text={agentStatus || "Thinking"}
                    preset="thinkingChat"
                    play={!browserState.settings.reducedMotion}
                    className="min-w-0 flex-1 truncate !text-[13px]"
                  />
                ) : (
                  <span className="min-w-0 flex-1 truncate">{tab.title || "New tab"}</span>
                )}
                <span
                  role="button"
                  tabIndex={0}
                  aria-label={`Close ${tab.title || "tab"}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    if ((browserState?.tabs.length || 0) > 1) void performAction({ type: "close_tab", tabId: tab.id });
                  }}
                  className="grid h-4 w-4 shrink-0 place-items-center rounded-full text-[var(--atlas-text-tertiary)] opacity-0 transition-[opacity,background-color,color] hover:bg-black/[0.06] hover:text-[var(--atlas-text-primary)] group-hover/tab:opacity-100"
                >
                  <X className="h-2.5 w-2.5" />
                </span>
              </motion.button>
              );
            })}
            {internalTabs.map((tab) => {
              const pageTitle = tab.page === "history" ? "History" : tab.page === "bookmarks" ? "Bookmarks" : "Settings";
              const PageIcon = tab.page === "history" ? History : tab.page === "bookmarks" ? Bookmark : Settings2;
              const selected = activeInternalTabId === tab.id;
              return (
                <motion.button
                  key={tab.id}
                  layout="position"
                  initial={{ opacity: 0, scale: 0.98, x: -12 }}
                  animate={{ opacity: 1, scale: 1, x: 0 }}
                  exit={{ opacity: 0, scale: 0.98, x: -12 }}
                  transition={{ type: "spring", stiffness: 440, damping: 34, mass: 0.5 }}
                  type="button"
                  onPointerEnter={() => setHoveredBrowserTabId(tab.id)}
                  onPointerLeave={() => setHoveredBrowserTabId(null)}
                  onClick={() => setActiveInternalTabId(tab.id)}
                  className={cn(
                    "group/tab isolate relative mb-0 flex min-w-[170px] max-w-[210px] items-center gap-2 overflow-hidden px-[15px] text-left text-[13px] font-medium transition-[background-color,color] duration-150 ease-out",
                    selected
                      ? "h-[36px] rounded-t-[10px] bg-[var(--atlas-tab-active)] text-[var(--atlas-text-primary)]"
                      : "mb-px h-[34px] rounded-[9px] text-[var(--atlas-text-secondary)]",
                  )}
                >
                  {hoveredBrowserTabId === tab.id && !selected ? <motion.span layoutId="browser-tab-hover" transition={{ type: "spring", stiffness: 580, damping: 42, mass: 0.42 }} className="pointer-events-none absolute inset-0 rounded-[9px] bg-black/[0.045]" /> : null}
                  <PageIcon className="h-4 w-4 shrink-0 text-[var(--atlas-text-tertiary)]" />
                  <span className="min-w-0 flex-1 truncate">{pageTitle}</span>
                  <span
                    role="button"
                    tabIndex={0}
                    aria-label={`Close ${pageTitle}`}
                    onClick={(event) => { event.stopPropagation(); closeInternalPage(tab.id); }}
                    className="grid h-4 w-4 shrink-0 place-items-center rounded-full text-[var(--atlas-text-tertiary)] opacity-0 transition-[opacity,background-color,color] hover:bg-black/[0.06] hover:text-[var(--atlas-text-primary)] group-hover/tab:opacity-100"
                  >
                    <X className="h-2.5 w-2.5" />
                  </span>
                </motion.button>
              );
            })}
          </AnimatePresence>
          <IconButton label="New tab" onClick={() => void performAction({ type: "open_tab" })} className="mb-0.5 h-8 w-8 rounded-[9px] text-[var(--atlas-text-secondary)] hover:bg-black/[0.05] hover:text-[var(--atlas-text-primary)]">
            <Plus className="h-4 w-4" />
          </IconButton>
        </div>

        {/* Toolbar — full width */}
        <div
          className="relative flex shrink-0 items-center gap-1.5 border-b px-2 [&_button]:text-[var(--atlas-text-secondary)] [&_button:hover]:bg-black/[0.05] [&_button:hover]:text-[var(--atlas-text-primary)]"
          style={{
            height: "var(--atlas-toolbar-height)",
            background: "var(--atlas-toolbar-bg)",
            borderColor: "var(--atlas-divider)",
          }}
        >
          <IconButton label="Back" disabled={Boolean(activeInternalTab) || !browserState?.canGoBack} onClick={() => void performAction({ type: "back" })} className="h-8 w-8">
            <ArrowLeft className="h-4 w-4" />
          </IconButton>
          <IconButton label="Forward" disabled={Boolean(activeInternalTab) || !browserState?.canGoForward} onClick={() => void performAction({ type: "forward" })} className="h-8 w-8">
            <ArrowRight className="h-4 w-4" />
          </IconButton>
          <IconButton label={browserState?.loading ? "Stop loading" : "Reload"} disabled={Boolean(activeInternalTab)} onClick={() => void performAction({ type: browserState?.loading ? "stop_loading" : "reload" })} className="h-8 w-8">
            {browserState?.loading ? <X className="h-4 w-4" /> : <RefreshCw className={cn("h-4 w-4", isBrowserBusy && "animate-spin")} />}
          </IconButton>
          <form onSubmit={(event) => void navigate(event)} className="relative min-w-0 flex-1 px-1.5">
            <div
              className={cn(
                "group/omnibox flex h-9 items-center transition-[background-color,box-shadow,border-radius] duration-150",
                omniboxFocused
                  ? "w-full gap-2 rounded-[10px] bg-white px-3 shadow-[inset_0_0_0_1px_var(--atlas-divider)]"
                  : "w-full justify-center gap-0 rounded-[10px] bg-transparent px-3 hover:bg-black/[0.035]",
              )}
            >
              {omniboxFocused ? (
                browserState?.secure
                  ? <LockKeyhole className="h-4 w-4 shrink-0 text-[var(--atlas-text-tertiary)]" strokeWidth={1.8} />
                  : <Search className="h-4 w-4 shrink-0 text-[var(--atlas-text-tertiary)]" />
              ) : null}
              <input
                data-browser-omnibox
                value={omniboxFocused ? address : restingHost}
                onChange={(event) => setAddress(event.target.value)}
                onFocus={(event) => {
                  setOmniboxFocused(true);
                  setAddress(browserState?.url || address);
                  event.currentTarget.select();
                }}
                onBlur={() => setOmniboxFocused(false)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.currentTarget.blur();
                    return;
                  }
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  void navigate(undefined, event.currentTarget.value);
                  event.currentTarget.blur();
                }}
                className={cn(
                  "min-w-0 flex-1 bg-transparent outline-none",
                  omniboxFocused
                    ? "text-left text-[13px] font-medium text-[var(--atlas-text-primary)]"
                    : "cursor-text text-center text-[13px] font-medium text-[var(--atlas-text-tertiary)]",
                )}
                placeholder="Search or enter address"
                aria-label="Address and search bar"
                readOnly={!omniboxFocused}
                onClick={() => {
                  if (!omniboxFocused) {
                    setOmniboxFocused(true);
                    setAddress(browserState?.url || address);
                  }
                }}
              />
              <button
                type="button"
                title={currentPageBookmark ? "Remove bookmark" : "Bookmark this page"}
                aria-label={currentPageBookmark ? "Remove bookmark" : "Bookmark this page"}
                disabled={Boolean(activeInternalTab) || !browserState?.url}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => void toggleBookmark()}
                className={cn(
                  "grid h-7 w-7 shrink-0 place-items-center rounded-[7px] text-[var(--atlas-text-tertiary)] transition-[background-color,color,transform] duration-150 hover:bg-black/[0.05] hover:text-[var(--atlas-text-primary)] active:scale-95 disabled:pointer-events-none disabled:opacity-30",
                  currentPageBookmark && "text-[var(--atlas-clyra-blue)]",
                )}
              >
                <Star className={cn("h-[15px] w-[15px]", currentPageBookmark && "fill-current")} strokeWidth={1.8} />
              </button>
            </div>
          </form>
          {desktopChromium && !activeInternalTab ? (
            <IconButton
              label="Snip & Ask"
              onClick={() => void handleSnip()}
              disabled={snipBusy}
              className="h-8 w-8"
            >
              {snipBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Crop className="h-4 w-4" strokeWidth={1.8} />}
            </IconButton>
          ) : null}
          <div className="relative z-50">
            <IconButton label="Browser menu" onClick={() => setBrowserMenuOpen((value) => !value)} active={browserMenuOpen} className="h-8 w-8">
              <Ellipsis className="h-4 w-4" />
            </IconButton>
            <AnimatePresence>
              {browserMenuOpen ? (
                <motion.div
                  initial={{ opacity: 0, y: -4, scale: 0.98 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: -4, scale: 0.98 }}
                  transition={{ duration: 0.14 }}
                  className="absolute right-0 top-8 z-[70] w-56 overflow-hidden rounded-xl border border-[var(--atlas-divider)] bg-white p-1.5 shadow-[0_16px_42px_rgba(15,23,42,0.14)]"
                >
                  {[
                    { view: "history" as const, label: "History", icon: History, tabPage: "history" as const },
                    { view: "bookmarks" as const, label: "Bookmarks", icon: Bookmark, tabPage: "bookmarks" as const },
                    { view: "downloads" as const, label: "Downloads", icon: Download },
                    { view: "settings" as const, label: "Browser settings", icon: Settings2, tabPage: "settings" as const },
                  ].map((item) => (
                    <button key={item.view} type="button" onClick={() => item.tabPage ? openInternalPage(item.tabPage) : openSideView(item.view)} className="flex h-9 w-full items-center gap-3 rounded-lg px-2.5 text-[12px] font-medium text-[var(--atlas-text-secondary)] transition-colors hover:bg-black/[0.04] hover:text-[var(--atlas-text-primary)]">
                      <item.icon className="h-4 w-4" /> {item.label}
                    </button>
                  ))}
                  <div className="my-1 h-px bg-[var(--atlas-divider)]" />
                  <div className="flex items-center justify-between px-2.5 py-1.5 text-[11px] font-medium text-[var(--atlas-text-secondary)]">
                    <span>Zoom</span>
                    <div className="flex items-center gap-0.5">
                      <IconButton label="Zoom out" onClick={() => void zoom(-0.1)} className="h-7 w-7"><Minus className="h-3.5 w-3.5" /></IconButton>
                      <button type="button" onClick={() => void zoom("reset")} className="min-w-10 text-center text-[10px] font-semibold text-[var(--atlas-text-secondary)]">{Math.round((browserState?.zoom || 1) * 100)}%</button>
                      <IconButton label="Zoom in" onClick={() => void zoom(0.1)} className="h-7 w-7"><Plus className="h-3.5 w-3.5" /></IconButton>
                    </div>
                  </div>
                </motion.div>
              ) : null}
            </AnimatePresence>
          </div>
          <button
            type="button"
            onClick={() => {
              markAskClyraUsed();
              setShowAskClyraPulse(false);
              setSideView("agent");
              setSideOpen((value) => {
                const next = sideView === "agent" ? !value : true;
                sideLockRef.current = next;
                return next;
              });
            }}
            className={cn(
              "relative ml-0.5 flex h-8 shrink-0 items-center gap-1 rounded-[9px] px-3 text-[12px] font-medium transition-[background-color,color] duration-150",
              sideOpen && sideView === "agent"
                ? "bg-black/[0.04] text-[var(--atlas-clyra-blue)]"
                : "bg-transparent text-[var(--atlas-clyra-blue)] hover:bg-black/[0.035]",
            )}
            aria-label={sideOpen ? "Hide Ask Clyra" : "Ask Clyra"}
          >
            {showAskClyraPulse ? (
              <span className="clyra-ask-pulse pointer-events-none absolute inset-0 rounded-[9px]" aria-hidden />
            ) : null}
            Ask Clyra
          </button>
        </div>

        <AnimatePresence initial={false}>
          {settings.showBookmarksBar && browserState?.bookmarks.length ? (
            <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 28, opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-[var(--atlas-divider)] bg-[var(--atlas-toolbar-bg)] px-2 [scrollbar-width:none]">
              {browserState.bookmarks.slice(0, 14).map((bookmark) => (
                <button key={bookmark.id} type="button" onClick={() => void navigate(undefined, bookmark.url)} className="flex h-6 shrink-0 items-center gap-1.5 rounded-md px-2 text-[10px] font-medium text-[var(--atlas-text-secondary)] transition-colors hover:bg-black/[0.04] hover:text-[var(--atlas-text-primary)]">
                  <Globe2 className="h-3 w-3" /> <span className="max-w-28 truncate">{bookmark.title}</span>
                </button>
              ))}
            </motion.div>
          ) : null}
        </AnimatePresence>

        {/* Page | divider | sidebar */}
        <div className="flex min-h-0 flex-1">
        <section className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-white">
          {findOpen ? (
              <div
                className="absolute right-3 top-3 z-[80] flex h-9 items-center gap-1.5 rounded-[10px] border border-[var(--atlas-divider)] bg-white px-2 shadow-[0_10px_28px_rgba(15,23,42,0.14)]"
              >
                <Search className="h-3.5 w-3.5 shrink-0 text-[var(--atlas-text-tertiary)]" />
                <input
                  ref={findInputRef}
                  autoFocus
                  value={findQuery}
                  onChange={(event) => {
                    setFindQuery(event.target.value);
                    void runFind(event.target.value);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void runFind(findQuery);
                    } else if (event.key === "Escape") {
                      event.preventDefault();
                      closeFind();
                    }
                  }}
                  placeholder="Find on page"
                  className="h-6 w-40 border-0 bg-transparent text-[12.5px] text-[var(--atlas-text-primary)] outline-none placeholder:text-[var(--atlas-text-tertiary)]"
                />
                {findResult ? (
                  <span className="shrink-0 whitespace-nowrap text-[11px] text-[var(--atlas-text-tertiary)]">
                    {findResult.total ? `${findResult.current} of ${findResult.total}` : "0 results"}
                  </span>
                ) : null}
                <button
                  type="button"
                  onClick={closeFind}
                  aria-label="Close find"
                  className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-[var(--atlas-text-tertiary)] hover:bg-black/[0.05] hover:text-[var(--atlas-text-primary)]"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
          ) : null}
          <div
            ref={previewRef}
            tabIndex={0}
            onKeyDown={handlePreviewKeyDown}
            onWheel={handlePreviewWheel}
            className="group relative min-h-0 flex-1 overflow-hidden bg-white outline-none"
            aria-label="Interactive browser page"
          >
            {activeInternalTab ? (
              <BrowserInternalPage
                page={activeInternalTab.page}
                history={browserState?.history || []}
                bookmarks={browserState?.bookmarks || []}
                settings={settings}
                onNavigate={(target) => {
                  setAddress(target);
                  void navigate(undefined, target);
                }}
                onClearHistory={() => void requestBrowser("/api/openbrowser/history", { method: "DELETE", body: {}, quiet: true })}
                onSaveBookmark={() => void saveBookmark()}
                onRemoveBookmark={(id) => void requestBrowser(`/api/openbrowser/bookmarks/${id}`, { method: "DELETE", quiet: true })}
                onUpdateSettings={(patch) => void updateSettings(patch)}
              />
            ) : showStartPage ? (
              <BrowserStartPage
                history={browserState?.history}
                bookmarks={browserState?.bookmarks}
                onNavigate={(target) => {
                  setAddress(target);
                  void navigate(undefined, target);
                }}
                onAskAgent={(prompt) => {
                  sideLockRef.current = true;
                  setSideOpen(true);
                  setSideView("agent");
                  setTask(prompt);
                  void runAgentTask(prompt);
                }}
                onOpenSettings={() => openInternalPage("settings")}
              />
            ) : browserState && desktopChromium ? (
              <ElectronWebContentsSurface
                title={`Live browser page: ${browserState.title}`}
                surfaceId="primary-browser"
                kind="browser"
                className="h-full w-full"
                active={!showStartPage && !activeInternalTab}
                fallback={
                  <img
                    data-clyra-browser-frame="1"
                    src={frameUrl}
                    alt={`Live browser page: ${browserState.title}`}
                    draggable={false}
                    onClick={(event) => void clickPreview(event)}
                    className="block h-full w-full cursor-default select-none object-contain object-top"
                  />
                }
              />
            ) : browserState ? (
              <img
                data-clyra-browser-frame="1"
                src={frameUrl}
                alt={`Live browser page: ${browserState.title}`}
                draggable={false}
                onClick={(event) => void clickPreview(event)}
                className="block h-full w-full cursor-default select-none object-contain object-top transition-opacity duration-150 ease-out"
                style={{ opacity: isBrowserBusy || (isAgentBusy && browserState.loading) ? 0.55 : 1 }}
              />
            ) : (
              <div className="grid h-full place-items-center bg-white">
                <div className="w-[70%] max-w-xl space-y-3 animate-pulse">
                  <div className="h-7 w-1/2 rounded-md bg-slate-100" />
                  <div className="h-3 w-full rounded bg-slate-100" />
                  <div className="h-3 w-4/5 rounded bg-slate-100" />
                  <div className="mt-7 h-44 rounded-lg bg-slate-100" />
                </div>
              </div>
            )}

            <AnimatePresence>
              {aiInControl ? (
                <motion.div
                  aria-hidden="true"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
                  className="pointer-events-none absolute inset-0 z-[18]"
                >
                  <div className="absolute inset-0 ring-1 ring-inset ring-black/[0.04]" />
                </motion.div>
              ) : null}
            </AnimatePresence>

            <AnimatePresence>
              {liveCursor && showAgentChrome && settings.showAiCursor && !browserState?.agent.manualControl ? (
                <motion.div
                  key="browser-ai-cursor"
                  initial={settings.reducedMotion ? false : { opacity: 0, scale: 0.9 }}
                  animate={{
                    opacity: 1,
                    scale: liveCursor.kind === "click" || liveCursor.kind === "double_click" ? [1, 0.88, 1] : 1,
                    left: `${(liveCursor.x / (browserState?.viewport.width || 1440)) * 100}%`,
                    top: `${(liveCursor.y / (browserState?.viewport.height || 900)) * 100}%`,
                  }}
                  exit={{ opacity: 0, scale: 0.92 }}
                  transition={{
                    // Keep the pointer physically connected to each action.
                    // A critically damped spring reads as intentional movement,
                    // rather than a sequence of teleports between targets.
                    left: settings.aiCursorSpeed === "instant" ? { duration: 0.035 } : { type: "spring", stiffness: settings.aiCursorSpeed === "fast" ? 430 : 260, damping: settings.aiCursorSpeed === "fast" ? 34 : 29, mass: 0.52 },
                    top: settings.aiCursorSpeed === "instant" ? { duration: 0.035 } : { type: "spring", stiffness: settings.aiCursorSpeed === "fast" ? 430 : 260, damping: settings.aiCursorSpeed === "fast" ? 34 : 29, mass: 0.52 },
                    scale: { duration: 0.16 },
                    opacity: { duration: 0.1 },
                  }}
                  className="clyra-browser-agent-cursor pointer-events-none absolute z-20 -translate-x-[2px] -translate-y-[2px]"
                  data-kind={liveCursor.kind}
                >
                  <svg className="clyra-browser-agent-cursor__arrow" viewBox="0 0 28 32" aria-hidden="true">
                    <path d="M4.62 2.72C3.09 1.91 1.57 3.43 2.39 4.96l8.36 16.3c.75 1.47 2.87 1.39 3.5-.13l2.69-6.51 6.51-2.69c1.52-.63 1.6-2.75.13-3.5L4.62 2.72Z" />
                  </svg>
                  <span className="clyra-browser-agent-cursor__caret" aria-hidden />
                  {settings.showAiActionLabels ? (
                    <span className="clyra-browser-agent-cursor__label">{cursorIntent}</span>
                  ) : null}
                  {(liveCursor.kind === "click" || liveCursor.kind === "double_click") ? (
                    <span key={liveCursor.id} className="clyra-browser-agent-cursor__click" aria-hidden />
                  ) : null}
                </motion.div>
              ) : null}
            </AnimatePresence>

            <AnimatePresence>
              {isBrowserBusy || (isAgentBusy && browserState?.loading) ? (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0, transition: { duration: 0.18 } }}
                  transition={{ duration: 0.12 }}
                  className="pointer-events-none absolute inset-x-0 top-0 z-30 h-[2.5px] overflow-hidden bg-transparent"
                >
                  {/* Chrome-style progress: a bar that eases up to ~85% and
                      only completes to 100% on the exit transition above, so
                      it never sits mid-way — it reads as real progress even
                      though the page load itself has no granular signal. */}
                  <motion.div
                    className="h-full rounded-r-full"
                    style={{ background: "var(--clyra-accent, #2563eb)" }}
                    initial={{ width: "0%" }}
                    animate={{ width: ["0%", "45%", "72%", "85%"] }}
                    transition={{ duration: 2.4, ease: [0.16, 1, 0.3, 1], times: [0, 0.15, 0.5, 1] }}
                  />
                </motion.div>
              ) : null}
            </AnimatePresence>

            {typeof document !== "undefined" &&
              createPortal(
                <AnimatePresence>
                  {snipCard ? (
                    <motion.div
                      key="snip-card"
                      initial={{ opacity: 0, scale: 0.96, y: 4 }}
                      animate={{ opacity: 1, scale: 1, y: 0 }}
                      exit={{ opacity: 0, scale: 0.97, transition: { duration: 0.12 } }}
                      transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
                      style={{ position: "fixed", left: snipCard.left, top: snipCard.top, width: 340, zIndex: 300 }}
                      className="overflow-hidden rounded-2xl border border-black/[0.08] bg-white/97 shadow-[0_20px_50px_rgba(15,23,42,0.16)] backdrop-blur-xl"
                    >
                      <div
                        onMouseDown={handleSnipCardDragStart}
                        className="flex cursor-grab items-center justify-between gap-2 border-b border-black/[0.06] px-3.5 py-2.5 active:cursor-grabbing"
                      >
                        <span className="text-[11.5px] font-semibold tracking-[-0.01em] text-[#1d1d1f]">Clyra</span>
                        <button
                          type="button"
                          onClick={() => setSnipCard(null)}
                          aria-label="Close"
                          className="grid h-6 w-6 place-items-center rounded-full text-[#9a9a9f] transition-colors hover:bg-black/[0.05] hover:text-[#1d1d1f]"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                      <div className="max-h-[340px] overflow-y-auto px-3.5 py-3">
                        {snipCard.status === "loading" ? (
                          <div className="flex items-center gap-2 text-[13px] text-[#6e6e73]">
                            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Reading selection…
                          </div>
                        ) : snipCard.status === "error" ? (
                          <p className="text-[13px] leading-relaxed text-rose-600">{snipCard.error}</p>
                        ) : (
                          <>
                            <p className="text-[13.5px] leading-relaxed text-[#1d1d1f]">{snipCard.direct}</p>
                            {snipCard.explanation ? (
                              <p className="mt-2.5 whitespace-pre-wrap text-[12.5px] leading-relaxed text-[#6e6e73]">
                                {snipCard.explanation}
                              </p>
                            ) : null}
                          </>
                        )}
                      </div>
                      {snipCard.status === "done" ? (
                        <>
                          <div className="flex items-center gap-1 border-t border-black/[0.06] px-2.5 py-1.5">
                            <button
                              type="button"
                              onClick={() => void navigator.clipboard?.writeText([snipCard.direct, snipCard.explanation].filter(Boolean).join("\n\n"))}
                              className="rounded-lg px-2.5 py-1.5 text-[11.5px] font-medium text-[#6e6e73] transition-colors hover:bg-black/[0.05] hover:text-[#1d1d1f]"
                            >
                              Copy
                            </button>
                          </div>
                          <div className="flex items-center gap-1.5 border-t border-black/[0.06] px-3 py-2">
                            <input
                              value={snipFollowUp}
                              onChange={(event) => setSnipFollowUp(event.target.value)}
                              onKeyDown={(event) => {
                                if (event.key === "Enter") void handleSnipFollowUp();
                              }}
                              placeholder="Ask a follow-up…"
                              className="min-w-0 flex-1 bg-transparent text-[12.5px] text-[#1d1d1f] outline-none placeholder:text-[#9a9a9f]"
                            />
                            <button
                              type="button"
                              onClick={() => void handleSnipFollowUp()}
                              disabled={snipFollowUpBusy || !snipFollowUp.trim()}
                              aria-label="Ask follow-up"
                              className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-[#1d1d1f] text-white transition-opacity disabled:opacity-25"
                            >
                              {snipFollowUpBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <ArrowUp className="h-3 w-3" />}
                            </button>
                          </div>
                        </>
                      ) : null}
                    </motion.div>
                  ) : null}
                </AnimatePresence>,
                document.body,
              )}

            {/* Floating Atlas agent bar over webpage */}
            <AnimatePresence>
              {showAgentChrome ? (
                <motion.div
                  initial={{ opacity: 0, y: 8, scale: 0.98 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: 6, scale: 0.98 }}
                  transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
                  className="absolute bottom-4 left-1/2 z-30 flex h-[30px] max-w-[min(420px,92%)] -translate-x-1/2 items-stretch overflow-hidden rounded-[8px] bg-[var(--atlas-agent-black)] text-[11px] font-medium text-white shadow-[0_8px_24px_rgba(0,0,0,.28)] sm:bottom-[16px]"
                >
                  <div className="flex min-w-0 flex-1 items-center gap-2 px-3">
                    {browserState?.agent.manualControl ? (
                      <UserRound className="h-3 w-3 shrink-0 text-white/70" />
                    ) : agentPhase === "paused" ? (
                      <CirclePause className="h-3 w-3 shrink-0 text-white/70" />
                    ) : (
                      <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-white/80" />
                    )}
                    <span className="min-w-0 truncate text-white/90">
                      {browserState?.agent.manualControl
                        ? "You have control"
                        : agentPhase === "paused"
                          ? "Paused"
                          : truncateLabel(agentTaskTitle, 42)}
                    </span>
                  </div>
                  {browserState?.agent.manualControl ? (
                    <button
                      type="button"
                      onClick={() => void controlAgent("return_control")}
                      className="flex shrink-0 items-center gap-1 border-l border-white/15 px-3 text-[10.5px] font-semibold text-white/90 transition-colors hover:bg-white/10"
                    >
                      <CirclePlay className="h-3 w-3" /> Resume AI
                    </button>
                  ) : agentPhase === "paused" ? (
                    <button
                      type="button"
                      onClick={() => void controlAgent("resume")}
                      className="flex shrink-0 items-center gap-1 border-l border-white/15 px-3 text-[10.5px] font-semibold text-white/90 transition-colors hover:bg-white/10"
                    >
                      <CirclePlay className="h-3 w-3" /> Resume
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void controlAgent("take_control")}
                      className="flex shrink-0 items-center gap-1 border-l border-white/15 px-3 text-[10.5px] font-semibold text-white/90 transition-colors hover:bg-white/10"
                    >
                      Take control
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => void controlAgent("stop")}
                    className="flex shrink-0 items-center gap-1 bg-[var(--atlas-stop-red)] px-3 text-[10.5px] font-semibold text-white transition-colors hover:brightness-110"
                    aria-label="Stop browser task"
                  >
                    Stop
                  </button>
                </motion.div>
              ) : null}
            </AnimatePresence>

            {error ? (
              <motion.div
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                className="absolute inset-x-4 bottom-4 z-30 flex max-w-xl items-start gap-3 rounded-lg border border-red-200/90 bg-white/95 px-3 py-2 text-[11px] font-medium text-red-600 shadow-[0_8px_24px_rgba(15,23,42,.12)] backdrop-blur-sm"
              >
                <span className="min-w-0 flex-1 line-clamp-3">{error.split("╔")[0]?.trim() || error}</span>
                <button type="button" onClick={() => void loadState()} className="shrink-0 font-semibold text-[var(--atlas-text-primary)]">Retry</button>
              </motion.div>
            ) : null}
          </div>
        </section>

        {sideOpen ? (
          <div className="block w-px shrink-0 bg-[var(--atlas-divider)]" aria-hidden />
        ) : null}

        <AnimatePresence initial={false}>
          {sideOpen ? (
            <motion.aside
              initial={{ opacity: 0, width: 0 }}
              animate={{ opacity: 1, width: "var(--atlas-sidebar-width)" }}
              exit={{ opacity: 0, width: 0 }}
              transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
              onUpdate={() => window.dispatchEvent(new Event("clyra:native-surface-layout"))}
              onAnimationComplete={() => window.dispatchEvent(new Event("clyra:native-surface-layout"))}
              className="static flex min-h-0 max-w-[var(--atlas-sidebar-width)] shrink-0 flex-col overflow-hidden bg-[var(--atlas-sidebar-bg)] text-[var(--atlas-text-primary)]"
            >
              <header className="relative flex h-[34px] shrink-0 items-center gap-2 border-b border-[var(--atlas-divider)] px-2">
                <button
                  type="button"
                  onClick={() => (sideView !== "agent" ? setSideView("agent") : setSideOpen(false))}
                  className="grid h-7 w-7 place-items-center rounded-md text-[var(--atlas-text-secondary)] transition-colors hover:bg-black/[0.04] hover:text-[var(--atlas-text-primary)]"
                  aria-label={sideView !== "agent" ? "Back" : "Collapse Ask Clyra"}
                >
                  <ArrowLeft className="h-3.5 w-3.5" />
                </button>
                <Bloub state={isAgentBusy ? "thinking" : "idle"} size={18} color={accentColor} background="#ffffff" className="shrink-0" />
                <span className="text-[11px] font-medium text-[var(--atlas-text-secondary)]">
                  {sideView === "agent" ? "Ask Clyra" : sideView === "downloads" ? "Downloads" : sideView === "history" ? "History" : sideView === "bookmarks" ? "Bookmarks" : "Browser settings"}
                </span>
              </header>

              {sideView === "agent" ? (
                <>
                  <div ref={chatScrollRef} className="clyra-visible-scrollbar min-h-0 flex-1 overflow-y-auto px-3.5 py-3">
                    <div className="space-y-3.5">
                      <AnimatePresence initial={false} mode="wait">
                        {messages.length === 0 && !isAgentBusy ? (
                          <motion.section
                            key="browser-welcome"
                            initial={{ opacity: 0, y: 6 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, y: -6, height: 0 }}
                            transition={{ duration: settings.reducedMotion ? 0.01 : 0.2, ease: [0.16, 1, 0.3, 1] }}
                            className="mx-auto flex min-h-[calc(100vh-360px)] max-w-[280px] flex-col items-center justify-center pb-10 pt-6 text-center"
                          >
                            <Bloub state="idle" size={40} color={accentColor} background="#ffffff" className="mb-3.5" />
                            <p className="text-[12px] font-medium leading-5 text-[var(--atlas-text-secondary)]">
                              Ask about this page, or describe a browser task.
                            </p>
                            <div className="mt-5 space-y-1 text-left">
                              {[
                                { label: "Summarise this page", prompt: "Summarise the current page and cite the most important details." },
                                { label: "Find something on this page", prompt: "Find the most relevant information on the current page." },
                                { label: "Complete a task here", prompt: "Help me complete a task on the current page." },
                              ].map((action) => (
                                <button
                                  key={action.label}
                                  type="button"
                                  onClick={() => void runAgentTask(action.prompt)}
                                  className="block w-full rounded-md px-2 py-1.5 text-left text-[11.5px] font-medium text-[var(--atlas-text-secondary)] transition-colors hover:bg-black/[0.04] hover:text-[var(--atlas-text-primary)]"
                                >
                                  {action.label}
                                </button>
                              ))}
                            </div>
                          </motion.section>
                        ) : null}
                      </AnimatePresence>

                      {messages.length > 0 && pageContextReady ? (
                        <div className="flex items-center gap-1.5 px-0.5">
                          <span className="grid h-4 w-4 shrink-0 place-items-center overflow-hidden rounded-[3px] border border-[var(--atlas-divider)] bg-white">
                            {activeTab?.favicon ? <img src={activeTab.favicon} alt="" className="h-2.5 w-2.5" /> : <Globe2 className="h-2.5 w-2.5 text-[var(--atlas-text-tertiary)]" />}
                          </span>
                          <span className="truncate text-[10px] font-medium text-[var(--atlas-text-tertiary)]">{pageName}</span>
                        </div>
                      ) : null}

                      {messages.map((message) => {
                        const animateTypewriter = message.role === "assistant"
                          && !settings.reducedMotion
                          && !hydratedMessageIdsRef.current.has(message.id)
                          && !message.id.startsWith("welcome");
                        return (
                        <motion.div
                          key={message.id}
                          layout="position"
                          initial={message.role === "user" ? false : { opacity: 0, y: 4 }}
                          animate={{ opacity: 1, y: 0, scale: 1 }}
                          transition={{ duration: message.role === "user" ? 0.01 : 0.18, ease: [0.16, 1, 0.3, 1] }}
                          className={cn("flex", message.role === "user" && "clyra-browser-user-message-entry origin-bottom-right justify-end")}
                        >
                          <div className={cn(
                            "max-w-[92%] text-[13px] leading-[1.55] tracking-[-0.01em]",
                            message.role === "user"
                              ? "rounded-[10px] bg-[var(--atlas-user-bubble)] px-3 py-2 font-normal text-[var(--atlas-text-primary)]"
                              : "max-w-full pr-1 font-normal text-[var(--atlas-text-primary)]",
                          )}>
                            <p className="whitespace-pre-wrap">
                              {message.role === "assistant" ? (
                                <TypewriterText
                                  text={message.content}
                                  active={animateTypewriter}
                                  msPerChar={8}
                                  onComplete={() => { hydratedMessageIdsRef.current.add(message.id); }}
                                />
                              ) : (
                                message.content
                              )}
                            </p>
                            {message.facts?.length ? (
                              <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                                <div className="clyra-message-source-chips" aria-label="Visited sources">
                                  {[...new Map(message.facts.map((fact) => [displayHost(fact.sourceUrl), fact.sourceUrl])).entries()]
                                    .filter(([host]) => host)
                                    .slice(0, 8)
                                    .map(([host, url]) => (
                                      <a key={url} href={url} target="_blank" rel="noreferrer" title={host} className="clyra-message-source-chip">
                                        <span className="clyra-message-source-chip__icon"><Globe2 className="h-3.5 w-3.5" strokeWidth={1.7} /></span>
                                        <span className="clyra-message-source-chip__bullet"><i className="clyra-message-source-chip__dot" /><span className="clyra-message-source-chip__label">{host}</span></span>
                                      </a>
                                    ))}
                                </div>
                              </div>
                            ) : null}
                            {message.steps?.length ? (
                              <button type="button" onClick={() => setActivityOpen((value) => !value)} className="mt-2 flex items-center gap-1.5 text-[11px] font-medium text-[var(--atlas-text-tertiary)] hover:text-[var(--atlas-text-secondary)]">
                                <Check className="h-3 w-3 text-emerald-500" /> {message.steps.length} verified actions <ChevronDown className={cn("h-3 w-3 transition-transform", activityOpen && "rotate-180")} />
                              </button>
                            ) : null}
                          </div>
                        </motion.div>
                        );
                      })}

                      {showAgentChrome ? (
                        <AgentRunSection
                          task={agentDemo
                            ? (agentDemoKind === "ebay"
                              ? "Look at MacBook M2 on eBay and compare the best listings"
                              : "Find well-rated sunscreen, beach towels and a bucket hat")
                            : (runTask || browserState?.agent.task || "")}
                          active={showAgentChrome}
                          phase={agentDemo ? (agentDemoKind === "ebay" ? "observing" : "executing") : agentPhase}
                          statusText={agentDemo
                            ? (agentDemoKind === "ebay" ? "Thinking" : "Comparing sunscreen")
                            : agentStatus}
                          plan={agentDemo ? (agentDemoKind === "ebay" ? {
                            goal: "MacBook M2 on eBay",
                            successCriteria: ["Search results open", "Listings compared", "Best pick noted"],
                            steps: [
                              { id: "1", label: "Opened eBay search", status: "complete" },
                              { id: "2", label: "Filtering MacBook M2", status: "complete" },
                              { id: "3", label: "Comparing top listings", status: "active" },
                              { id: "4", label: "Summarise best options", status: "pending" },
                            ],
                          } : {
                            goal: "Beach essentials",
                            successCriteria: ["Sunscreen added", "Towels added", "Hat added"],
                            steps: [
                              { id: "1", label: "Opened shopping site", status: "complete" },
                              { id: "2", label: "Set delivery location", status: "complete" },
                              { id: "3", label: "Comparing sunscreen", status: "active" },
                              { id: "4", label: "Adding beach towels", status: "pending" },
                            ],
                          }) : plan}
                          items={runItems}
                          paused={agentPhase === "paused"}
                          manualControl={Boolean(browserState?.agent.manualControl)}
                          reducedMotion={settings.reducedMotion}
                          factCount={factCount}
                          criteriaProgress={criteriaProgress}
                          planOpen={planDisclosureOpen}
                          onTogglePlan={() => setPlanDisclosureOpen((value) => !value)}
                          completedStepsOpen={completedStepsOpen}
                          onToggleCompletedSteps={() => setCompletedStepsOpen((value) => !value)}
                        />
                      ) : null}

                      <AnimatePresence>
                        {activityOpen && latestSteps.length ? (
                          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden pl-1">
                            {latestSteps.map((step, index) => <p key={`${step}-${index}`} className="mb-1.5 text-[10px] font-medium leading-4 text-[var(--atlas-text-tertiary)]">{step.replace(/ -> .*/, "")}</p>)}
                          </motion.div>
                        ) : null}
                      </AnimatePresence>
                      <div ref={chatEndRef} aria-hidden className="h-px w-full shrink-0" />
                    </div>
                  </div>

                  <div className="shrink-0 border-t border-[var(--atlas-divider)] px-3 pb-3 pt-2">
                    {messages.length === 0 && pageContextReady ? (
                      <div className="mb-2 flex items-center gap-1.5">
                        <span className="grid h-4 w-4 shrink-0 place-items-center overflow-hidden rounded-[3px] border border-[var(--atlas-divider)] bg-white">
                          {activeTab?.favicon ? <img src={activeTab.favicon} alt="" className="h-2.5 w-2.5" /> : <Globe2 className="h-2.5 w-2.5 text-[var(--atlas-text-tertiary)]" />}
                        </span>
                        <span className="truncate text-[10px] font-medium text-[var(--atlas-text-tertiary)]">{pageName}</span>
                      </div>
                    ) : null}
                    <form
                      onSubmit={(event) => { event.preventDefault(); void runAgentTask(); }}
                      className="flex min-h-[76px] flex-col rounded-none bg-transparent"
                    >
                      <textarea
                        value={task}
                        onChange={(event) => setTask(event.target.value)}
                        onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void runAgentTask(); } }}
                        rows={2}
                        placeholder="Describe a task"
                        className="w-full flex-1 resize-none bg-transparent px-0.5 py-1 text-[13px] font-normal leading-5 text-[var(--atlas-text-primary)] outline-none placeholder:text-[var(--atlas-text-tertiary)]"
                      />
                      <div className="flex items-center justify-between pt-1">
                        <span className="text-[10px] font-medium text-[var(--atlas-text-tertiary)]">Agent · Sources</span>
                        <button type="submit" disabled={isAgentBusy || !task.trim()} className="grid h-6 w-6 place-items-center rounded-full bg-[var(--atlas-agent-black)] text-white transition-[opacity,transform] hover:opacity-90 active:scale-95 disabled:bg-black/[0.08] disabled:text-[var(--atlas-text-tertiary)]" aria-label="Run browser task"><ArrowUp className="h-3 w-3" /></button>
                      </div>
                    </form>
                  </div>
                </>
              ) : null}

              {sideView === "history" ? (
                <div className="min-h-0 flex-1 overflow-y-auto p-2">
                  <div className="mb-2 flex items-center justify-between px-2 py-1"><span className="text-[9px] font-semibold uppercase text-[var(--atlas-text-tertiary)]">Recent</span><button type="button" onClick={() => void requestBrowser("/api/openbrowser/history", { method: "DELETE", body: {}, quiet: true })} className="text-[9px] font-semibold text-[var(--atlas-text-secondary)] hover:text-red-600">Clear</button></div>
                  {browserState?.history.length ? browserState.history.map((entry) => (
                    <button key={entry.id} type="button" onClick={() => void navigate(undefined, entry.url)} className="group flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors hover:bg-black/[0.03]">
                      <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md border border-[var(--atlas-divider)] bg-white"><Clock3 className="h-3.5 w-3.5 text-[var(--atlas-text-tertiary)]" /></span>
                      <span className="min-w-0 flex-1"><span className="block truncate text-[10px] font-semibold text-[var(--atlas-text-primary)]">{entry.title}</span><span className="block truncate text-[8px] font-medium text-[var(--atlas-text-tertiary)]">{compactUrl(entry.url)}</span></span>
                      <span className="text-[8px] font-medium text-[var(--atlas-text-tertiary)]">{formatWhen(entry.visitedAt)}</span>
                    </button>
                  )) : <EmptyPanel icon={History} label="No browsing history" />}
                </div>
              ) : null}

              {sideView === "bookmarks" ? (
                <div className="min-h-0 flex-1 overflow-y-auto p-2">
                  <button type="button" onClick={() => void saveBookmark()} className="mb-2 flex h-9 w-full items-center justify-center gap-2 rounded-lg border border-dashed border-[var(--atlas-divider)] text-[10px] font-semibold text-[var(--atlas-text-secondary)] transition-colors hover:bg-black/[0.03]"><Plus className="h-3.5 w-3.5" /> Bookmark current page</button>
                  {browserState?.bookmarks.length ? browserState.bookmarks.map((bookmark) => (
                    <div key={bookmark.id} className="group flex items-center gap-2 rounded-lg px-2 py-2 hover:bg-black/[0.03]">
                      <button type="button" onClick={() => void navigate(undefined, bookmark.url)} className="flex min-w-0 flex-1 items-center gap-2.5 text-left">
                        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md border border-[var(--atlas-divider)] bg-white"><Star className="h-3.5 w-3.5 fill-amber-400 text-amber-500" /></span>
                        <span className="min-w-0"><span className="block truncate text-[10px] font-semibold text-[var(--atlas-text-primary)]">{bookmark.title}</span><span className="block truncate text-[8px] font-medium text-[var(--atlas-text-tertiary)]">{compactUrl(bookmark.url)}</span></span>
                      </button>
                      <IconButton label="Remove bookmark" onClick={() => void requestBrowser(`/api/openbrowser/bookmarks/${bookmark.id}`, { method: "DELETE", quiet: true })} className="opacity-0 group-hover:opacity-100"><Trash2 className="h-3.5 w-3.5" /></IconButton>
                    </div>
                  )) : <EmptyPanel icon={Bookmark} label="No bookmarks yet" />}
                </div>
              ) : null}

              {sideView === "downloads" ? (
                <div className="min-h-0 flex-1 overflow-y-auto p-2">
                  {browserState?.downloads.length ? browserState.downloads.map((download) => (
                    <div key={download.id} className="flex items-center gap-2.5 rounded-lg px-2 py-2 hover:bg-black/[0.03]">
                      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md border border-[var(--atlas-divider)] bg-white"><FileDown className="h-4 w-4 text-[var(--atlas-text-secondary)]" /></span>
                      <span className="min-w-0 flex-1"><span className="block truncate text-[10px] font-semibold text-[var(--atlas-text-primary)]">{download.filename}</span><span className={cn("block text-[8px] font-medium", download.status === "failed" ? "text-red-500" : download.status === "complete" ? "text-emerald-600" : "text-[var(--atlas-text-secondary)]")}>{download.status}</span></span>
                    </div>
                  )) : <EmptyPanel icon={Download} label="No downloads" />}
                </div>
              ) : null}

              {sideView === "settings" ? (
                <div className="min-h-0 flex-1 overflow-y-auto p-4">
                  <SettingSelect label="Search engine" value={settings.defaultSearchEngine} options={["bing", "google", "duckduckgo"]} onChange={(value) => void updateSettings({ defaultSearchEngine: value as BrowserSettings["defaultSearchEngine"] })} />
                  <SettingSelect label="Performance" value={settings.performanceMode} options={["quality", "balanced", "efficient"]} onChange={(value) => void updateSettings({ performanceMode: value as BrowserSettings["performanceMode"] })} />
                  <div className="mt-3 divide-y divide-[var(--atlas-divider)] border-y border-[var(--atlas-divider)]">
                    <SettingToggle label="Restore tabs" checked={settings.restoreTabs} onChange={(value) => void updateSettings({ restoreTabs: value })} />
                    <SettingToggle label="Save history" checked={settings.saveHistory} onChange={(value) => void updateSettings({ saveHistory: value })} />
                    <SettingToggle label="Bookmarks bar" checked={settings.showBookmarksBar} onChange={(value) => void updateSettings({ showBookmarksBar: value })} />
                    <SettingToggle label="AI cursor" checked={settings.showAiCursor} onChange={(value) => void updateSettings({ showAiCursor: value })} />
                    <SettingToggle label="Action labels" checked={settings.showAiActionLabels} onChange={(value) => void updateSettings({ showAiActionLabels: value })} />
                    <SettingToggle label="Private session" checked={settings.privateMode} onChange={(value) => void updateSettings({ privateMode: value })} />
                  </div>
                  <div className="mt-4 flex items-center gap-2 rounded-lg border border-[var(--atlas-divider)] bg-white px-3 py-2 text-[9px] font-medium text-[var(--atlas-text-secondary)]"><ShieldCheck className="h-4 w-4 shrink-0 text-emerald-600" /> Browser data stays in the local Clyra profile.</div>
                </div>
              ) : null}
            </motion.aside>
          ) : null}
        </AnimatePresence>
        </div>
      </motion.div>
    </div>
  );
}

function BrowserInternalPage({
  page,
  history,
  bookmarks,
  settings,
  onNavigate,
  onClearHistory,
  onSaveBookmark,
  onRemoveBookmark,
  onUpdateSettings,
}: {
  page: InternalBrowserPage;
  history: BrowserHistoryEntry[];
  bookmarks: BrowserBookmark[];
  settings: BrowserSettings;
  onNavigate: (url: string) => void;
  onClearHistory: () => void;
  onSaveBookmark: () => void;
  onRemoveBookmark: (id: string) => void;
  onUpdateSettings: (patch: Partial<BrowserSettings>) => void;
}) {
  const isHistory = page === "history";
  const isBookmarks = page === "bookmarks";
  const [historySearch, setHistorySearch] = useState("");
  const groupedHistory = useMemo(() => {
    const groups = new Map<string, BrowserHistoryEntry[]>();
    const query = historySearch.trim().toLocaleLowerCase();
    history.filter((entry) => !query || `${entry.title} ${entry.url}`.toLocaleLowerCase().includes(query)).forEach((entry) => {
      const date = new Date(entry.visitedAt);
      const label = Number.isNaN(date.valueOf())
        ? "Earlier"
        : date.toDateString() === new Date().toDateString()
          ? "Today"
          : date.toDateString() === new Date(Date.now() - 86_400_000).toDateString()
            ? "Yesterday"
            : date.toLocaleDateString(undefined, { month: "long", day: "numeric" });
      groups.set(label, [...(groups.get(label) || []), entry]);
    });
    return [...groups.entries()].slice(0, 8);
  }, [history, historySearch]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 5 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: settings.reducedMotion ? 0.01 : 0.18, ease: [0.16, 1, 0.3, 1] }}
      className="h-full overflow-y-auto bg-[#fbfbfc] text-[var(--atlas-text-primary)]"
    >
      <div className="mx-auto w-full max-w-[860px] px-8 pb-16 pt-10 sm:px-12">
        {isHistory ? (
          <>
            <header className="mb-9 flex items-start justify-between gap-5">
              <div>
                <div className="mb-3 grid h-9 w-9 place-items-center rounded-[10px] bg-[#f1f5ff] text-[var(--atlas-clyra-blue)]"><History className="h-[18px] w-[18px]" /></div>
                <h1 className="text-[25px] font-semibold tracking-[-0.035em]">History</h1>
                <p className="mt-1.5 text-[13px] text-[var(--atlas-text-secondary)]">Pages you’ve visited in Clyra Browser.</p>
                <div className="mt-4 flex items-center gap-2 text-[11px] text-[var(--atlas-text-tertiary)]"><span className="rounded-full bg-[#f0f2f5] px-2.5 py-1 font-medium">{history.length} saved visits</span><span>Stored locally</span></div>
              </div>
              <button type="button" onClick={onClearHistory} disabled={!history.length} className="mt-1 h-8 rounded-[8px] px-2.5 text-[12px] font-medium text-[var(--atlas-text-secondary)] transition-colors hover:bg-red-50 hover:text-red-600 disabled:opacity-35">Clear browsing data</button>
            </header>
            <div className="mb-7 flex h-10 max-w-[510px] items-center gap-2 rounded-[10px] border border-[var(--atlas-divider)] bg-white px-3 shadow-[0_1px_2px_rgba(15,23,42,0.02)]">
              <Search className="h-4 w-4 text-[var(--atlas-text-tertiary)]" />
              <input value={historySearch} onChange={(event) => setHistorySearch(event.target.value)} className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-[var(--atlas-text-tertiary)]" placeholder="Search history" aria-label="Search history" />
            </div>
            {groupedHistory.length ? (
              <div className="space-y-8">
                {groupedHistory.map(([label, entries]) => (
                  <section key={label}>
                    <h2 className="mb-2 px-1 text-[11px] font-semibold text-[var(--atlas-text-tertiary)]">{label}</h2>
                    <div className="space-y-0.5">
                      {entries.slice(0, 18).map((entry) => (
                        <button key={entry.id} type="button" onClick={() => onNavigate(entry.url)} className="group flex w-full items-center gap-3 rounded-[10px] px-2.5 py-2 text-left transition-colors hover:bg-[#f1f3f6]">
                          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[8px] border border-[var(--atlas-divider)] bg-white"><Globe2 className="h-3.5 w-3.5 text-[var(--atlas-text-tertiary)]" /></span>
                          <span className="min-w-0 flex-1"><span className="block truncate text-[13px] font-medium text-[var(--atlas-text-primary)]">{entry.title || displayHost(entry.url)}</span><span className="mt-0.5 block truncate text-[11px] text-[var(--atlas-text-tertiary)]">{compactUrl(entry.url)}</span></span>
                          <span className="shrink-0 text-[11px] text-[var(--atlas-text-tertiary)]">{formatWhen(entry.visitedAt)}</span>
                        </button>
                      ))}
                    </div>
                  </section>
                ))}
              </div>
            ) : <EmptyPanel icon={History} label={historySearch ? "No matching history" : "No browsing history yet"} />}
          </>
        ) : isBookmarks ? (
          <>
            <header className="mb-9 flex items-start justify-between gap-5">
              <div>
                <div className="mb-3 grid h-9 w-9 place-items-center rounded-[10px] bg-[#f1f5ff] text-[var(--atlas-clyra-blue)]"><Bookmark className="h-[18px] w-[18px]" /></div>
                <h1 className="text-[25px] font-semibold tracking-[-0.035em]">Bookmarks</h1>
                <p className="mt-1.5 text-[13px] text-[var(--atlas-text-secondary)]">Pages you’ve saved for later.</p>
                <div className="mt-4 flex items-center gap-2 text-[11px] text-[var(--atlas-text-tertiary)]"><span className="rounded-full bg-[#f0f2f5] px-2.5 py-1 font-medium">{bookmarks.length} saved pages</span><span>Available on this device</span></div>
              </div>
              <button type="button" onClick={onSaveBookmark} className="mt-1 flex h-8 items-center gap-1.5 rounded-[8px] px-2.5 text-[12px] font-medium text-[var(--atlas-clyra-blue)] transition-colors hover:bg-[#edf3ff]"><Plus className="h-3.5 w-3.5" /> Bookmark current page</button>
            </header>
            <div className="mb-7 flex h-10 max-w-[510px] items-center gap-2 rounded-[10px] border border-[var(--atlas-divider)] bg-white px-3 shadow-[0_1px_2px_rgba(15,23,42,0.02)]">
              <Search className="h-4 w-4 text-[var(--atlas-text-tertiary)]" />
              <input value={historySearch} onChange={(event) => setHistorySearch(event.target.value)} className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-[var(--atlas-text-tertiary)]" placeholder="Search bookmarks" aria-label="Search bookmarks" />
            </div>
            {bookmarks.filter((bookmark) => !historySearch.trim() || `${bookmark.title} ${bookmark.url}`.toLocaleLowerCase().includes(historySearch.trim().toLocaleLowerCase())).length ? (
              <section>
                <h2 className="mb-2 px-1 text-[11px] font-semibold text-[var(--atlas-text-tertiary)]">Saved pages</h2>
                <div className="space-y-0.5">
                  {bookmarks.filter((bookmark) => !historySearch.trim() || `${bookmark.title} ${bookmark.url}`.toLocaleLowerCase().includes(historySearch.trim().toLocaleLowerCase())).map((bookmark) => (
                    <div key={bookmark.id} className="group flex w-full items-center gap-3 rounded-[10px] px-2.5 py-2 transition-colors hover:bg-[#f1f3f6]">
                      <button type="button" onClick={() => onNavigate(bookmark.url)} className="flex min-w-0 flex-1 items-center gap-3 text-left"><span className="grid h-8 w-8 shrink-0 place-items-center rounded-[8px] border border-[var(--atlas-divider)] bg-white"><Bookmark className="h-3.5 w-3.5 text-[var(--atlas-clyra-blue)]" /></span><span className="min-w-0"><span className="block truncate text-[13px] font-medium text-[var(--atlas-text-primary)]">{bookmark.title || displayHost(bookmark.url)}</span><span className="mt-0.5 block truncate text-[11px] text-[var(--atlas-text-tertiary)]">{compactUrl(bookmark.url)}</span></span></button>
                      <button type="button" onClick={() => onRemoveBookmark(bookmark.id)} className="grid h-7 w-7 shrink-0 place-items-center rounded-[7px] text-[var(--atlas-text-tertiary)] opacity-0 transition-[opacity,background-color,color] hover:bg-red-50 hover:text-red-600 group-hover:opacity-100" aria-label={`Remove ${bookmark.title || "bookmark"}`}><Trash2 className="h-3.5 w-3.5" /></button>
                    </div>
                  ))}
                </div>
              </section>
            ) : <EmptyPanel icon={Bookmark} label={historySearch ? "No matching bookmarks" : "No bookmarks yet"} />}
          </>
        ) : (
          <>
            <header className="mb-9">
              <div className="mb-3 grid h-9 w-9 place-items-center rounded-[10px] bg-[#f1f5ff] text-[var(--atlas-clyra-blue)]"><Settings2 className="h-[18px] w-[18px]" /></div>
              <h1 className="text-[25px] font-semibold tracking-[-0.035em]">Browser settings</h1>
              <p className="mt-1.5 text-[13px] text-[var(--atlas-text-secondary)]">A quiet, local setup for browsing with Clyra.</p>
            </header>
            <div className="space-y-8">
              <InternalSettingsSection title="General" icon={Search}>
                <InternalSettingSelect label="Search engine" description="Used when you enter a search in the address bar." value={settings.defaultSearchEngine} options={["google", "bing", "duckduckgo"]} onChange={(value) => onUpdateSettings({ defaultSearchEngine: value as BrowserSettings["defaultSearchEngine"] })} />
                <InternalSettingToggle label="Restore tabs" description="Reopen your last browser tabs when Clyra starts." checked={settings.restoreTabs} onChange={(value) => onUpdateSettings({ restoreTabs: value })} />
                <InternalSettingToggle label="Show bookmarks bar" description="Keep saved pages one click away." checked={settings.showBookmarksBar} onChange={(value) => onUpdateSettings({ showBookmarksBar: value })} />
              </InternalSettingsSection>
              <InternalSettingsSection title="Privacy" icon={ShieldCheck}>
                <InternalSettingToggle label="Save browsing history" description="Store visited pages in your local Clyra profile." checked={settings.saveHistory} onChange={(value) => onUpdateSettings({ saveHistory: value })} />
                <InternalSettingToggle label="Private session" description="Don’t save new tabs or browsing history." checked={settings.privateMode} onChange={(value) => onUpdateSettings({ privateMode: value })} />
              </InternalSettingsSection>
              <InternalSettingsSection title="Clyra assistance" icon={Eye}>
                <InternalSettingToggle label="Show AI cursor" description="Show Clyra’s position while it works on a page." checked={settings.showAiCursor} onChange={(value) => onUpdateSettings({ showAiCursor: value })} />
                <InternalSettingToggle label="Show action labels" description="Briefly describe what Clyra is doing beside the cursor." checked={settings.showAiActionLabels} onChange={(value) => onUpdateSettings({ showAiActionLabels: value })} />
                <InternalSettingSelect label="Cursor speed" description="Choose how quickly Clyra’s cursor travels." value={settings.aiCursorSpeed} options={["natural", "fast", "instant"]} onChange={(value) => onUpdateSettings({ aiCursorSpeed: value as BrowserSettings["aiCursorSpeed"] })} />
              </InternalSettingsSection>
              <InternalSettingsSection title="Performance" icon={Settings2}>
                <InternalSettingSelect label="Browser performance" description="Balance visual quality and system efficiency." value={settings.performanceMode} options={["quality", "balanced", "efficient"]} onChange={(value) => onUpdateSettings({ performanceMode: value as BrowserSettings["performanceMode"] })} />
                <InternalSettingToggle label="Reduce motion" description="Use quieter transitions throughout the browser." checked={settings.reducedMotion} onChange={(value) => onUpdateSettings({ reducedMotion: value })} />
              </InternalSettingsSection>
              <InternalSettingsSection title="Keyboard shortcuts" icon={Keyboard}>
                <div className="divide-y divide-[var(--atlas-divider)] px-4">
                  {[['Focus address bar', '⌘ L'], ['Open new tab', '⌘ T'], ['Reopen closed tab', '⇧ ⌘ T'], ['Close tab', '⌘ W'], ['Reload page', '⌘ R']].map(([label, shortcut]) => <div key={label} className="flex h-10 items-center justify-between text-[12px]"><span className="text-[var(--atlas-text-secondary)]">{label}</span><kbd className="rounded-[5px] border border-[var(--atlas-divider)] bg-[#fbfbfc] px-1.5 py-0.5 text-[10px] font-medium text-[var(--atlas-text-tertiary)]">{shortcut}</kbd></div>)}
                </div>
              </InternalSettingsSection>
              <div className="flex items-center gap-2 rounded-[10px] border border-[var(--atlas-divider)] bg-white px-3 py-2.5 text-[11px] leading-4 text-[var(--atlas-text-secondary)]"><ShieldCheck className="h-4 w-4 shrink-0 text-emerald-600" /> Your browsing profile and saved pages stay on this device.</div>
            </div>
          </>
        )}
      </div>
    </motion.div>
  );
}

function InternalSettingsSection({ title, icon: Icon, children }: { title: string; icon: LucideIcon; children: React.ReactNode }) {
  return <section><div className="mb-2 flex items-center gap-2 px-1"><Icon className="h-3.5 w-3.5 text-[var(--atlas-text-tertiary)]" /><h2 className="text-[12px] font-semibold text-[var(--atlas-text-secondary)]">{title}</h2></div><div className="overflow-hidden rounded-[12px] border border-[var(--atlas-divider)] bg-white">{children}</div></section>;
}

function InternalSettingToggle({ label, description, checked, onChange }: { label: string; description: string; checked: boolean; onChange: (value: boolean) => void }) {
  return <div className="flex min-h-[66px] items-center justify-between gap-5 border-b border-[var(--atlas-divider)] px-4 last:border-b-0"><div><p className="text-[13px] font-medium">{label}</p><p className="mt-0.5 text-[11px] leading-4 text-[var(--atlas-text-secondary)]">{description}</p></div><Toggle label={label} checked={checked} onChange={onChange} /></div>;
}

function InternalSettingSelect({ label, description, value, options, onChange }: { label: string; description: string; value: string; options: string[]; onChange: (value: string) => void }) {
  return <label className="flex min-h-[66px] items-center justify-between gap-5 border-b border-[var(--atlas-divider)] px-4 last:border-b-0"><span><span className="block text-[13px] font-medium">{label}</span><span className="mt-0.5 block text-[11px] leading-4 text-[var(--atlas-text-secondary)]">{description}</span></span><select value={value} onChange={(event) => onChange(event.target.value)} className="h-8 min-w-[112px] rounded-[8px] border border-[var(--atlas-divider)] bg-[#fbfbfc] px-2 text-[12px] font-medium capitalize text-[var(--atlas-text-secondary)] outline-none transition-colors focus:border-[var(--atlas-clyra-blue)]">{options.map((option) => <option key={option} value={option}>{option}</option>)}</select></label>;
}

function statusPillMeta(phase: AgentStatus, manualControl: boolean): { label: string; className: string; live?: boolean } {
  switch (phase) {
    case "planning": return { label: "Planning", className: "text-[var(--atlas-text-secondary)]", live: true };
    case "observing": return { label: "Observing", className: "text-[var(--atlas-text-secondary)]", live: true };
    case "executing": return { label: "Acting", className: "text-[var(--atlas-text-secondary)]", live: true };
    case "verifying": return { label: "Verifying", className: "text-[var(--atlas-text-secondary)]", live: true };
    case "recovering": return { label: "Recovering", className: "text-amber-600", live: true };
    case "waiting_for_user": return { label: "Needs you", className: "text-amber-600" };
    case "paused": return { label: manualControl ? "You have control" : "Paused", className: "text-[var(--atlas-text-tertiary)]" };
    case "completed": return { label: "Done", className: "text-emerald-600" };
    case "failed": return { label: "Failed", className: "text-rose-600" };
    case "cancelled": return { label: "Stopped", className: "text-[var(--atlas-text-tertiary)]" };
    default: return { label: "Idle", className: "text-[var(--atlas-text-tertiary)]" };
  }
}

function VerdictIcon({ verdict }: { verdict?: StepEvaluation["verdict"] }) {
  if (verdict === "Success") return <CircleCheck className="h-3 w-3 shrink-0 text-emerald-500" />;
  if (verdict === "Failure") return <CircleX className="h-3 w-3 shrink-0 text-rose-500" />;
  return <CircleHelp className="h-3 w-3 shrink-0 text-amber-500" />;
}

function PlanDisclosure({
  plan,
  task,
  phase,
  open,
  onToggle,
  completedOpen,
  onToggleCompleted,
  reducedMotion,
  criteriaProgress,
}: {
  plan: TaskPlan | null;
  task: string;
  phase: AgentStatus;
  open: boolean;
  onToggle: () => void;
  completedOpen: boolean;
  onToggleCompleted: () => void;
  reducedMotion: boolean;
  criteriaProgress: { complete: number; total: number };
}) {
  const meta = statusPillMeta(phase, false);
  const title = plan?.goal || task || meta.label;
  const steps = plan?.steps || [];
  const completed = steps.filter((step) => step.status === "complete");
  const remaining = steps.filter((step) => step.status !== "complete");
  const progressHint = criteriaProgress.total
    ? `${criteriaProgress.complete}/${criteriaProgress.total}`
    : steps.length
      ? `${completed.length}/${steps.length}`
      : null;

  const renderStep = (step: TaskPlan["steps"][number]) => (
    <li key={step.id} className="flex items-start gap-2 py-[2px]">
      <span className="mt-[3px] grid h-3 w-3 shrink-0 place-items-center" aria-hidden>
        {step.status === "complete" ? (
          <CircleCheck className="h-3 w-3 text-emerald-500" />
        ) : step.status === "active" ? (
          <motion.span
            className="h-1.5 w-1.5 rounded-full bg-[var(--atlas-text-primary)]"
            animate={reducedMotion ? undefined : { scale: [1, 1.35, 1], opacity: [1, 0.55, 1] }}
            transition={{ duration: 1.4, repeat: Infinity, ease: "easeInOut" }}
          />
        ) : step.status === "blocked" ? (
          <TriangleAlert className="h-3 w-3 text-amber-500" />
        ) : (
          <span className="h-1.5 w-1.5 rounded-full border border-[var(--atlas-divider)]" />
        )}
      </span>
      <span className={cn(
        "min-w-0 flex-1 text-[10.5px] font-medium leading-4",
        step.status === "complete" ? "text-[var(--atlas-text-tertiary)] line-through decoration-[var(--atlas-divider)]" : step.status === "active" ? "text-[var(--atlas-text-primary)]" : "text-[var(--atlas-text-secondary)]",
      )}>
        {step.label}
      </span>
    </li>
  );

  return (
    <motion.section initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: reducedMotion ? 0.01 : 0.18 }} className="space-y-1">
      <button
        type="button"
        onClick={onToggle}
        className="flex h-6 w-full items-center gap-1.5 rounded-md px-1 text-left transition-colors hover:bg-black/[0.03]"
      >
        <ChevronDown className={cn("h-3 w-3 shrink-0 text-[var(--atlas-text-tertiary)] transition-transform duration-150", open && "rotate-180")} />
        <span className={cn("min-w-0 flex-1 truncate text-[11px] font-medium", meta.className)}>
          {phase === "planning" || !plan ? `Planning for ${truncateLabel(title, 36)}` : truncateLabel(title, 42)}
        </span>
        {progressHint ? <span className="shrink-0 text-[10px] font-medium text-[var(--atlas-text-tertiary)]">{progressHint}</span> : null}
        {meta.live ? <span className="h-1 w-1 shrink-0 animate-pulse rounded-full bg-[var(--atlas-text-tertiary)]" /> : null}
      </button>
      <AnimatePresence initial={false}>
        {open && steps.length ? (
          <motion.ol
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.16 }}
            className="overflow-hidden pl-4"
          >
            {completed.length > 1 ? (
              <li>
                <button type="button" onClick={onToggleCompleted} className="flex w-full items-center gap-2 py-[2px] text-left text-[10.5px] font-medium text-[var(--atlas-text-tertiary)] hover:text-[var(--atlas-text-secondary)]">
                  <CircleCheck className="h-3 w-3 shrink-0 text-emerald-500" />
                  <span className="min-w-0 flex-1">{completed.length} steps completed</span>
                  <ChevronDown className={cn("h-3 w-3 shrink-0 transition-transform", completedOpen && "rotate-180")} />
                </button>
                <AnimatePresence initial={false}>
                  {completedOpen ? (
                    <motion.ol initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden pl-1">
                      {completed.map(renderStep)}
                    </motion.ol>
                  ) : null}
                </AnimatePresence>
              </li>
            ) : completed.map(renderStep)}
            {remaining.map(renderStep)}
          </motion.ol>
        ) : null}
      </AnimatePresence>
    </motion.section>
  );
}

function ReasoningCard({ item, reducedMotion }: { item: Extract<RunItem, { kind: "reasoning" }>; reducedMotion: boolean }) {
  return (
    <motion.div initial={{ opacity: 0, y: 3 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: reducedMotion ? 0.01 : 0.16 }} className="px-1 py-0.5">
      <div className="flex items-start gap-2">
        <span className="mt-[2px]"><VerdictIcon verdict={item.evaluation?.verdict} /></span>
        <div className="min-w-0 flex-1">
          <p className="text-[12.5px] font-medium leading-[1.45] text-[var(--atlas-text-primary)]">{item.nextGoal}</p>
          {item.evaluation?.reason ? <p className="mt-0.5 text-[11.5px] font-normal leading-[1.4] text-[var(--atlas-text-tertiary)]">{item.evaluation.reason}</p> : null}
          {item.memory ? <p className="mt-1 text-[11.5px] font-normal leading-[1.4] text-[var(--atlas-text-tertiary)]">{item.memory}</p> : null}
        </div>
      </div>
    </motion.div>
  );
}

function ActionRow({ item, reducedMotion }: { item: Extract<RunItem, { kind: "action" }>; reducedMotion: boolean }) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const Icon = ACTION_ICONS[item.icon] || CircleHelp;
  const action = item.label.split(" ")[0];
  const detail = item.label.includes(" ") ? item.label.slice(item.label.indexOf(" ") + 1) : "";
  return (
    <motion.div initial={{ opacity: 0, x: -3 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: reducedMotion ? 0.01 : 0.14 }} className="px-0.5 py-0.5">
      <div className="flex items-center gap-2">
        <motion.span
          className="grid h-3.5 w-3.5 shrink-0 place-items-center text-[var(--atlas-clyra-blue)]"
          animate={item.status === "running" && !reducedMotion ? { rotate: [0, -8, 8, 0], opacity: [0.75, 1, 0.75] } : { rotate: 0, opacity: 1 }}
          transition={item.status === "running" ? { duration: 1.15, repeat: Infinity, ease: "easeInOut" } : { duration: 0.14 }}
        >
          <Icon className="h-3.5 w-3.5" />
        </motion.span>
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium tracking-[-0.01em] text-[var(--atlas-text-primary)]">
          <span className="text-[color:var(--atlas-clyra-blue,#2b6ef2)]">{action}</span>
          {detail ? item.status === "running" ? <><span> </span><ShiningText text={detail} preset="thinkingChat" play={!reducedMotion} className="inline" /></> : ` ${detail}` : null}
        </span>
        {item.status === "running" ? (
          <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-[var(--atlas-clyra-blue)]" />
        ) : item.status === "success" ? (
          <CircleCheck className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
        ) : (
          <CircleX className="h-3.5 w-3.5 shrink-0 text-rose-500" />
        )}
        <button type="button" onClick={() => setDetailsOpen((value) => !value)} aria-label="Toggle action details" className="grid h-4 w-4 shrink-0 place-items-center rounded text-[var(--atlas-text-tertiary)] hover:text-[var(--atlas-text-secondary)]">
          <ChevronDown className={cn("h-3 w-3 transition-transform duration-150", detailsOpen && "rotate-180")} />
        </button>
      </div>
      <AnimatePresence initial={false}>
        {detailsOpen ? (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.14 }} className="overflow-hidden">
            {item.result ? <p className="mt-1 text-[10px] font-medium leading-3.5 text-[var(--atlas-text-secondary)]">{item.result}</p> : null}
            <pre className="mt-1 max-h-28 overflow-auto rounded-md bg-black/[0.03] p-2 text-[9px] leading-3.5 text-[var(--atlas-text-tertiary)]">{item.detail}</pre>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </motion.div>
  );
}

function RecoveryCard({ item, reducedMotion }: { item: Extract<RunItem, { kind: "recovery" | "strategy" }>; reducedMotion: boolean }) {
  const Icon = item.kind === "strategy" ? RotateCcw : TriangleAlert;
  return (
    <motion.div initial={{ opacity: 0, y: 3 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: reducedMotion ? 0.01 : 0.16 }} className="flex items-start gap-2 px-1 py-0.5">
      <Icon className="mt-[2px] h-3 w-3 shrink-0 text-amber-500" />
      <p className="min-w-0 flex-1 text-[11px] font-medium leading-4 text-[var(--atlas-text-secondary)]">
        {item.kind === "strategy" ? <span className="mr-1 font-semibold text-[var(--atlas-text-primary)]">Changing strategy —</span> : null}
        {item.message}
      </p>
    </motion.div>
  );
}

function AskUserCard({ question, reducedMotion }: { question: string; reducedMotion: boolean }) {
  return (
    <motion.div initial={{ opacity: 0, y: 3 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: reducedMotion ? 0.01 : 0.18 }} className="px-1 py-1">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-[var(--atlas-text-tertiary)]">Needs your input</p>
      <p className="mt-1 text-[11.5px] font-medium leading-4.5 text-[var(--atlas-text-primary)]">{question}</p>
      <p className="mt-1 text-[10px] font-medium text-[var(--atlas-text-tertiary)]">Reply below to continue.</p>
    </motion.div>
  );
}

function CompletionCard({ item, reducedMotion }: { item: Extract<RunItem, { kind: "complete" }>; reducedMotion: boolean }) {
  const conciseSummary = item.message
    .replace(/\s+/g, " ")
    .replace(/^(?:Task (?:completed|complete)[:\-]?\s*)/i, "")
    .trim()
    .slice(0, 180);
  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: reducedMotion ? 0.01 : 0.18 }}
      className="px-1 py-1"
    >
      <div className="flex items-start gap-2">
        {item.success ? <CircleCheck className="mt-[1px] h-3.5 w-3.5 shrink-0 text-emerald-500" /> : <CircleX className="mt-[1px] h-3.5 w-3.5 shrink-0 text-rose-500" />}
        <div className="min-w-0 flex-1">
          <p className={cn("text-[10px] font-semibold", item.success ? "text-emerald-600" : "text-rose-500")}>
            {item.success ? "Task completed" : "Task not completed"}
          </p>
          {item.success && conciseSummary ? <p className="mt-1 text-[10px] font-medium leading-4 text-[var(--atlas-text-secondary)]"><span className="mr-1 text-[var(--atlas-text-tertiary)]">Summary</span>{conciseSummary}</p> : null}
          {item.message ? <p className="mt-1 whitespace-pre-wrap text-[11px] font-medium leading-4.5 text-[var(--atlas-text-primary)]">{item.message}</p> : null}
          {item.evidence?.url ? (
            <a href={item.evidence.url} target="_blank" rel="noreferrer" className="mt-1.5 flex max-w-full items-center gap-1.5 text-[10px] font-medium text-[var(--atlas-text-secondary)] hover:text-[var(--atlas-text-primary)]">
              <ExternalLink className="h-2.5 w-2.5 shrink-0" />
              <span className="min-w-0 truncate">{item.evidence.title || displayHost(item.evidence.url)}</span>
            </a>
          ) : null}
          {item.evidence?.checks?.length ? (
            <ul className="mt-1 space-y-0.5">
              {item.evidence.checks.slice(0, 6).map((check, index) => (
                <li key={`${check}-${index}`} className="flex items-start gap-1.5 text-[10px] font-medium leading-3.5 text-[var(--atlas-text-tertiary)]">
                  <Check className={cn("mt-[1px] h-2.5 w-2.5 shrink-0", item.success ? "text-emerald-500" : "text-[var(--atlas-text-tertiary)]")} />
                  <span className="min-w-0">{check}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>
    </motion.div>
  );
}

function AgentRunSection({
  task,
  active,
  phase,
  statusText,
  plan,
  items,
  manualControl,
  reducedMotion,
  factCount,
  criteriaProgress,
  planOpen,
  onTogglePlan,
  completedStepsOpen,
  onToggleCompletedSteps,
}: {
  task: string;
  active: boolean;
  phase: AgentStatus;
  statusText: string;
  plan: TaskPlan | null;
  items: RunItem[];
  paused?: boolean;
  manualControl: boolean;
  reducedMotion: boolean;
  factCount: number;
  criteriaProgress: { complete: number; total: number };
  planOpen: boolean;
  onTogglePlan: () => void;
  completedStepsOpen: boolean;
  onToggleCompletedSteps: () => void;
}) {
  const completeItem = [...items].reverse().find((item): item is Extract<RunItem, { kind: "complete" }> => item.kind === "complete");
  const askItem = [...items].reverse().find((item): item is Extract<RunItem, { kind: "ask" }> => item.kind === "ask");
  const feedItems = active ? items.slice(-24) : [];
  const thinking = active && ["planning", "observing"].includes(phase) && !manualControl;
  return (
    <motion.section initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: reducedMotion ? 0.01 : 0.18 }} className="space-y-2">
      {active ? (
        <PlanDisclosure
          plan={plan}
          task={task}
          phase={phase}
          open={planOpen}
          onToggle={onTogglePlan}
          completedOpen={completedStepsOpen}
          onToggleCompleted={onToggleCompletedSteps}
          reducedMotion={reducedMotion}
          criteriaProgress={criteriaProgress}
        />
      ) : null}

      {feedItems.length ? (
        <div className="space-y-0.5">
          {feedItems.map((item) => {
            if (item.kind === "reasoning") return <ReasoningCard key={item.id} item={item} reducedMotion={reducedMotion} />;
            if (item.kind === "action") return <ActionRow key={item.id} item={item} reducedMotion={reducedMotion} />;
            if (item.kind === "ask") return <AskUserCard key={item.id} question={item.question} reducedMotion={reducedMotion} />;
            if (item.kind === "complete") return <CompletionCard key={item.id} item={item} reducedMotion={reducedMotion} />;
            return <RecoveryCard key={item.id} item={item} reducedMotion={reducedMotion} />;
          })}
        </div>
      ) : null}

      {!active && askItem && !completeItem ? <AskUserCard question={askItem.question} reducedMotion={reducedMotion} /> : null}
      {!active && completeItem ? <CompletionCard item={completeItem} reducedMotion={reducedMotion} /> : null}

      {thinking ? (
        <div className="flex items-center gap-2 px-0.5 py-1.5">
          <ShiningBrainIcon className="h-4 w-4 shrink-0" />
          <ShiningText text={statusText || "Thinking"} preset="thinkingChat" play={!reducedMotion} className="min-w-0 flex-1 truncate text-[13px] font-medium tracking-[-0.01em]" />
          <ThinkingDots />
          {factCount > 0 ? <span className="shrink-0 text-[11px] font-medium text-[var(--atlas-text-tertiary)]">{factCount} facts</span> : null}
        </div>
      ) : null}
    </motion.section>
  );
}

function EmptyPanel({ icon: Icon, label }: { icon: typeof History; label: string }) {
  return <div className="grid min-h-56 place-items-center text-center"><div><Icon className="mx-auto mb-2 h-5 w-5 text-[var(--atlas-text-tertiary)]" /><p className="text-[10px] font-semibold text-[var(--atlas-text-tertiary)]">{label}</p></div></div>;
}

function SettingToggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return <div className="flex h-11 items-center justify-between text-[10px] font-semibold text-[var(--atlas-text-secondary)]"><span>{label}</span><Toggle label={label} checked={checked} onChange={onChange} /></div>;
}

function SettingSelect({ label, value, options, onChange }: { label: string; value: string; options: string[]; onChange: (value: string) => void }) {
  return (
    <label className="mb-3 block">
      <span className="mb-1.5 block text-[9px] font-semibold uppercase text-[var(--atlas-text-tertiary)]">{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)} className="h-9 w-full rounded-lg border border-[var(--atlas-divider)] bg-white px-2.5 text-[10px] font-semibold capitalize text-[var(--atlas-text-primary)] outline-none transition-colors focus:border-[var(--atlas-text-tertiary)]">
        {options.map((option) => <option key={option} value={option}>{option.replace(/_/g, " ")}</option>)}
      </select>
    </label>
  );
}
