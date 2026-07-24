import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Bookmark,
  Bot,
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
  Download,
  Ellipsis,
  ExternalLink,
  Eye,
  EyeOff,
  FileDown,
  Globe2,
  Hand,
  History,
  Keyboard,
  Loader2,
  LockKeyhole,
  Minus,
  MousePointer2,
  MousePointerClick,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Square,
  Star,
  Trash2,
  TriangleAlert,
  UserRound,
  X,
  ZoomIn,
  ZoomOut,
  type LucideIcon,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
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
import { ShiningBrainIcon, ShiningText, ThinkingDots } from "./ShiningText";

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
  generic: Sparkles,
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
        "grid h-8 w-8 shrink-0 place-items-center rounded-lg text-slate-500 transition-[background-color,color,transform,opacity] duration-150 hover:bg-slate-100 hover:text-slate-900 active:scale-[0.94] disabled:pointer-events-none disabled:opacity-30",
        active && "bg-slate-100 text-slate-700 hover:bg-slate-200 hover:text-slate-900",
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
        checked ? "border-slate-900 bg-slate-900" : "border-slate-300 bg-slate-200",
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
  const [sideView, setSideView] = useState<SideView>("agent");
  const [sideOpen, setSideOpen] = useState(() => typeof window !== "undefined" && window.innerWidth >= 1024);
  const [agentStatus, setAgentStatus] = useState("Ready");
  const [agentPhase, setAgentPhase] = useState<AgentStatus>("idle");
  const [liveSteps, setLiveSteps] = useState<string[]>([]);
  const [plan, setPlan] = useState<TaskPlan | null>(null);
  const [criteriaProgress, setCriteriaProgress] = useState({ complete: 0, total: 0 });
  const [factCount, setFactCount] = useState(0);
  const [activityOpen, setActivityOpen] = useState(false);
  const [browserMenuOpen, setBrowserMenuOpen] = useState(false);
  const [cursor, setCursor] = useState<AgentCursor | null>(null);
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
    void loadState();
    void syncAgentSession();
    return () => {
      mountedRef.current = false;
      if (typingTimerRef.current != null) window.clearTimeout(typingTimerRef.current);
      if (scrollTimerRef.current != null) window.clearTimeout(scrollTimerRef.current);
      if (viewportTimerRef.current != null) window.clearTimeout(viewportTimerRef.current);
    };
  }, [loadState, syncAgentSession]);

  useEffect(() => {
    const desktop = getElectronDesktop();
    if (!desktop) return;
    const stopState = desktop.browser.onState((state) => applyState(state as BrowserState));
    const stopAddress = desktop.browser.onFocusAddress(() => {
      document.querySelector<HTMLInputElement>("[data-browser-omnibox]")?.focus();
    });
    const stopFind = desktop.browser.onFocusFind(() => setSideView("history"));
    return () => {
      stopState();
      stopAddress();
      stopFind();
    };
  }, [applyState]);

  useEffect(() => {
    window.localStorage.setItem(BROWSER_CHAT_STORAGE, JSON.stringify(messages));
  }, [messages]);

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
    (action: BrowserAction, quiet = false) => requestBrowser("/api/openbrowser/action", { body: { action }, quiet }),
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
    await takeManualControl();
    await requestBrowser("/api/openbrowser/navigate", { body: { target } }).catch(() => undefined);
  };

  const flushTyping = useCallback(() => {
    if (typingTimerRef.current != null) window.clearTimeout(typingTimerRef.current);
    typingTimerRef.current = null;
    const text = typingBufferRef.current;
    typingBufferRef.current = "";
    if (text) void performAction({ type: "type", text }, true);
  }, [performAction]);

  const controlAgent = async (command: "pause" | "resume" | "take_control" | "return_control" | "stop") => {
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
      setAgentStatus("Stopping task");
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
    setMessages((current) => [...current, { id: `user-${Date.now()}`, role: "user", content: cleanTask }]);
    try {
      const response = await fetch("/api/openbrowser/assist", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({ task: cleanTask }),
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
      setMessages((current) => [
        ...current,
        {
          id: `error-${Date.now()}`,
          role: "assistant",
          content: nextError instanceof Error ? nextError.message : "The browser agent could not complete that task.",
        },
      ]);
    } finally {
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
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const supported = event.key.length === 1 || ["Enter", "Backspace", "Tab", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key);
    if (!supported) return;
    event.preventDefault();
    void takeManualControl();
    if (event.key.length === 1) {
      typingBufferRef.current += event.key;
      if (typingTimerRef.current != null) window.clearTimeout(typingTimerRef.current);
      typingTimerRef.current = window.setTimeout(flushTyping, 72);
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

  const saveBookmark = async () => {
    await requestBrowser("/api/openbrowser/bookmarks", { body: {}, quiet: true }).catch(() => undefined);
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
        document.querySelector<HTMLInputElement>("[data-browser-omnibox]")?.focus();
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
      }
    };
    window.addEventListener("keydown", onShortcut);
    return () => window.removeEventListener("keydown", onShortcut);
  }, [browserState?.activeTabId, performAction]);

  const settings = browserState?.settings || defaultSettings;

  useEffect(() => {
    if (settings.reducedMotion) {
      chatScrollRef.current?.scrollTo({ top: chatScrollRef.current.scrollHeight });
      return;
    }
    chatEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, isAgentBusy, runItems.length, settings.reducedMotion]);

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
      showLabel: settings.showAiActionLabels,
      reducedMotion: settings.reducedMotion,
    });
    return () => { void desktop.browser.setCursor(null); };
  }, [browserState?.agent.manualControl, cursor, desktopChromium, isAgentBusy, settings.reducedMotion, settings.showAiActionLabels, settings.showAiCursor]);
  const pageHost = useMemo(() => displayHost(browserState?.url || address), [address, browserState?.url]);
  const activeTab = useMemo(
    () => browserState?.tabs.find((tab) => tab.active),
    [browserState?.tabs],
  );
  const pageName = useMemo(
    () => displayPageName(activeTab?.url || browserState?.url || address, activeTab?.title || browserState?.title),
    [activeTab?.title, activeTab?.url, address, browserState?.title, browserState?.url],
  );
  const pageContextReady = Boolean((activeTab?.url || browserState?.url) && (activeTab?.title || browserState?.title));
  const latestSteps = liveSteps.length ? liveSteps : [...messages].reverse().find((message) => message.steps?.length)?.steps || [];
  const frameUrl = browserState
    ? `/api/openbrowser/frame?${isAgentBusy ? "fresh=1&" : ""}v=${browserState.frameVersion}&t=${frameTick}`
    : "";
  const progress = criteriaProgress.total ? Math.min(100, Math.round((criteriaProgress.complete / criteriaProgress.total) * 100)) : 0;
  const aiInControl = ["planning", "observing", "executing", "verifying", "recovering"].includes(agentPhase) && !browserState?.agent.manualControl;

  const openSideView = (view: SideView) => {
    setSideView(view);
    setSideOpen(true);
    setBrowserMenuOpen(false);
  };

  return (
    <div className="flex min-h-0 flex-1 bg-[#f6f8fa] p-[2px]">
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
        className="relative mx-auto flex h-full min-h-0 w-full max-w-none flex-col overflow-hidden rounded-[10px] border border-slate-200/90 bg-white shadow-[0_2px_12px_rgba(36,55,78,0.05)]"
      >
        <div className={cn(
          "flex h-10 shrink-0 items-center gap-1 overflow-x-auto border-b border-slate-200/80 bg-white px-4 [scrollbar-width:none]",
          sideOpen && "lg:mr-[clamp(310px,27vw,430px)]",
        )}>
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
                initial={{ opacity: 0, scale: 0.96, x: -6 }}
                animate={{ opacity: 1, scale: 1, x: 0 }}
                exit={{ opacity: 0, scale: 0.96, x: 6 }}
                transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
                type="button"
                onClick={() => void performAction({ type: "switch_tab", tabId: tab.id })}
                onAuxClick={(event) => {
                  if (event.button === 1 && browserState.tabs.length > 1) void performAction({ type: "close_tab", tabId: tab.id });
                }}
                className={cn(
                  "group/tab relative flex h-8 min-w-[142px] max-w-[250px] items-center gap-2 overflow-hidden rounded-[15px] px-3 text-left text-[12px] font-medium transition-[background-color,color,box-shadow] duration-200 ease-out",
                  tab.active ? "bg-[#f1f1f1] text-slate-800" : "text-slate-500 hover:bg-[#f1f1f1] hover:text-slate-800",
                  agentOwnsTab && "clyra-browser-agent-tab ring-1 ring-slate-300/80",
                )}
                title={agentOwnsTab ? "Clyra is controlling this tab" : undefined}
              >
                {tab.loading ? (
                  <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-slate-500" />
                ) : tab.favicon ? (
                  <img src={tab.favicon} alt="" className="h-3.5 w-3.5 shrink-0 rounded-sm" />
                ) : (
                  <Globe2 className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                )}
                <span className={cn("min-w-0 flex-1 truncate", agentOwnsTab && "clyra-thinking-shimmer [--clyra-thinking-base:#64748b] [--clyra-thinking-highlight:#0f172a]")}>
                  {tab.title || "New tab"}
                </span>
                <span
                  role="button"
                  tabIndex={0}
                  aria-label={`Close ${tab.title || "tab"}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    if ((browserState?.tabs.length || 0) > 1) void performAction({ type: "close_tab", tabId: tab.id });
                  }}
                  className="grid h-5 w-5 shrink-0 place-items-center rounded-full text-slate-400 opacity-0 transition-[opacity,background-color,color] hover:bg-white hover:text-slate-700 group-hover/tab:opacity-100"
                >
                  <X className="h-3 w-3" />
                </span>
              </motion.button>
              );
            })}
          </AnimatePresence>
            <IconButton label="New tab" onClick={() => void performAction({ type: "open_tab" })} className="h-7 w-7 rounded-full text-slate-500 hover:bg-slate-100 hover:text-slate-800">
              <Plus className="h-4 w-4" />
            </IconButton>
        </div>

        <div className={cn(
          "grid min-h-0 flex-1 [transition:grid-template-columns_560ms_cubic-bezier(.16,1,.3,1)]",
          sideOpen ? "lg:grid-cols-[minmax(0,1fr)_clamp(310px,27vw,430px)]" : "grid-cols-1 lg:grid-cols-[minmax(0,1fr)_0px]",
        )}>
        <section className="flex min-h-0 min-w-0 flex-col bg-white">

          <div className="relative flex h-9 shrink-0 items-center gap-0.5 border-b border-slate-200/80 bg-white px-2 [&_button]:text-slate-500 [&_button:hover]:bg-slate-100 [&_button:hover]:text-slate-800">
            <IconButton label="Back" disabled={!browserState?.canGoBack} onClick={() => void performAction({ type: "back" })}>
              <ArrowLeft className="h-4 w-4" />
            </IconButton>
            <IconButton label="Forward" disabled={!browserState?.canGoForward} onClick={() => void performAction({ type: "forward" })}>
              <ArrowRight className="h-4 w-4" />
            </IconButton>
            <IconButton label={browserState?.loading ? "Stop loading" : "Reload"} onClick={() => void performAction({ type: browserState?.loading ? "stop_loading" : "reload" })}>
              {browserState?.loading ? <X className="h-4 w-4" /> : <RefreshCw className={cn("h-4 w-4", isBrowserBusy && "animate-spin")} />}
            </IconButton>
            <form onSubmit={(event) => void navigate(event)} className="min-w-0 flex-1">
              <div className="group/omnibox flex h-8 items-center gap-2 rounded-[10px] border border-transparent bg-white px-3 transition-[background-color,border-color,box-shadow] duration-200 hover:bg-slate-100/85 focus-within:border-slate-300 focus-within:bg-slate-100/85 focus-within:shadow-[0_0_0_3px_rgba(148,163,184,0.14)]">
                {browserState?.secure ? <LockKeyhole className="h-3.5 w-3.5 shrink-0 text-[#7c8798]" strokeWidth={1.8} /> : <Search className="h-3.5 w-3.5 shrink-0 text-[#7c8798]" />}
                <input
                  data-browser-omnibox
                  value={address}
                  onChange={(event) => setAddress(event.target.value)}
                  onFocus={(event) => event.currentTarget.select()}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter") return;
                    event.preventDefault();
                    void navigate(undefined, event.currentTarget.value);
                  }}
                  className="min-w-0 flex-1 bg-transparent text-[12px] font-medium text-slate-700 outline-none placeholder:text-slate-400"
                  placeholder="Search or enter address"
                  aria-label="Address and search bar"
                />
              </div>
            </form>
            <IconButton label="Open history" onClick={() => {
              setSideView((view) => view === "history" ? "agent" : "history");
              setSideOpen(true);
            }} active={sideOpen && sideView === "history"}>
              <History className="h-4 w-4" />
            </IconButton>
            <div className="relative z-50">
              <IconButton label="Browser menu" onClick={() => setBrowserMenuOpen((value) => !value)} active={browserMenuOpen}>
                <Ellipsis className="h-[17px] w-[17px]" />
              </IconButton>
              <AnimatePresence>
                {browserMenuOpen ? (
                  <motion.div
                    initial={{ opacity: 0, y: -4, scale: 0.98 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: -4, scale: 0.98 }}
                    transition={{ duration: 0.14 }}
                    className="absolute right-0 top-10 z-[70] w-56 overflow-hidden rounded-xl border border-slate-200 bg-white p-1.5 shadow-[0_16px_42px_rgba(15,23,42,0.16)]"
                  >
                    {[
                      { view: "bookmarks" as const, label: "Bookmarks", icon: Bookmark },
                      { view: "downloads" as const, label: "Downloads", icon: Download },
                      { view: "settings" as const, label: "Browser settings", icon: Settings2 },
                    ].map((item) => (
                      <button key={item.view} type="button" onClick={() => openSideView(item.view)} className="flex h-9 w-full items-center gap-3 rounded-lg px-2.5 text-[12px] font-medium text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-900">
                        <item.icon className="h-4 w-4" /> {item.label}
                      </button>
                    ))}
                    <div className="my-1 h-px bg-slate-100" />
                    <div className="flex items-center justify-between px-2.5 py-1.5 text-[11px] font-medium text-slate-500">
                      <span>Zoom</span>
                      <div className="flex items-center gap-0.5">
                        <IconButton label="Zoom out" onClick={() => void zoom(-0.1)} className="h-7 w-7"><Minus className="h-3.5 w-3.5" /></IconButton>
                        <button type="button" onClick={() => void zoom("reset")} className="min-w-10 text-center text-[10px] font-semibold text-slate-600">{Math.round((browserState?.zoom || 1) * 100)}%</button>
                        <IconButton label="Zoom in" onClick={() => void zoom(0.1)} className="h-7 w-7"><Plus className="h-3.5 w-3.5" /></IconButton>
                      </div>
                    </div>
                  </motion.div>
                ) : null}
              </AnimatePresence>
            </div>
            <IconButton label={sideOpen ? "Hide assistant" : "Show assistant"} onClick={() => setSideOpen((value) => !value)} active={sideOpen && sideView === "agent"}>
              {sideOpen ? <PanelRightClose className="h-4 w-4" /> : <PanelRightOpen className="h-4 w-4" />}
            </IconButton>
          </div>

          <AnimatePresence initial={false}>
            {settings.showBookmarksBar && browserState?.bookmarks.length ? (
              <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 34, opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-slate-200 bg-white px-2 [scrollbar-width:none]">
                {browserState.bookmarks.slice(0, 14).map((bookmark) => (
                  <button key={bookmark.id} type="button" onClick={() => void navigate(undefined, bookmark.url)} className="flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-[10px] font-semibold text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900">
                    <Globe2 className="h-3 w-3" /> <span className="max-w-28 truncate">{bookmark.title}</span>
                  </button>
                ))}
              </motion.div>
            ) : null}
          </AnimatePresence>

          <div
            ref={previewRef}
            tabIndex={0}
            onKeyDown={handlePreviewKeyDown}
            onWheel={handlePreviewWheel}
            className="group relative min-h-0 flex-1 overflow-hidden bg-white outline-none"
            aria-label="Interactive browser page"
          >
            {browserState && desktopChromium ? (
              <ElectronWebContentsSurface
                title={`Live browser page: ${browserState.title}`}
                surfaceId="primary-browser"
                kind="browser"
                className="h-full w-full"
                fallback={
                  <img
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
                src={frameUrl}
                alt={`Live browser page: ${browserState.title}`}
                draggable={false}
                onClick={(event) => void clickPreview(event)}
                className="block h-full w-full cursor-default select-none object-contain object-top"
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
                  className="clyra-browser-ai-control pointer-events-none absolute inset-0 z-[18]"
                >
                  <motion.div
                    aria-hidden
                    className="absolute inset-0 ring-1 ring-inset ring-slate-400/40"
                    animate={settings.reducedMotion ? { boxShadow: "inset 0 0 28px rgba(15,23,42,0.10)" } : {
                      boxShadow: [
                        "inset 0 0 22px rgba(15,23,42,0.06)",
                        "inset 0 0 42px rgba(15,23,42,0.14)",
                        "inset 0 0 22px rgba(15,23,42,0.06)",
                      ],
                    }}
                    transition={{ duration: 2.6, repeat: Infinity, ease: "easeInOut" }}
                  />
                  <div className="absolute left-3 top-3 flex items-center gap-2 rounded-full bg-slate-950/90 px-2.5 py-1.5 text-[9px] font-semibold text-white shadow-[0_8px_24px_rgba(15,23,42,.18)] backdrop-blur-xl">
                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-slate-300" />
                    <ShiningText text={agentStatus} play={!settings.reducedMotion} className="!text-[9px] !text-white [--clyra-thinking-base:#cbd5e1] [--clyra-thinking-highlight:#ffffff]" />
                  </div>
                </motion.div>
              ) : null}
            </AnimatePresence>

            <AnimatePresence>
              {cursor && isAgentBusy && settings.showAiCursor && !browserState?.agent.manualControl ? [
                <motion.div
                  key="browser-ai-cursor-trail"
                  initial={settings.reducedMotion ? false : { opacity: 0 }}
                  animate={{
                    opacity: settings.reducedMotion ? 0 : 0.5,
                    left: `${(cursor.x / (browserState?.viewport.width || 1440)) * 100}%`,
                    top: `${(cursor.y / (browserState?.viewport.height || 900)) * 100}%`,
                  }}
                  exit={{ opacity: 0 }}
                  transition={{
                    left: { type: "spring", stiffness: 120, damping: 26, mass: 0.85 },
                    top: { type: "spring", stiffness: 120, damping: 26, mass: 0.85 },
                    opacity: { duration: 0.18 },
                  }}
                  className="pointer-events-none absolute z-[19] -translate-x-1/2 -translate-y-1/2"
                  aria-hidden
                >
                  <span className="block h-5 w-5 rounded-full bg-slate-400/35 blur-[8px]" />
                </motion.div>,
                <motion.div
                  key="browser-ai-cursor"
                  initial={settings.reducedMotion ? false : { opacity: 0, scale: 0.86 }}
                  animate={{
                    opacity: 1,
                    scale: cursor.kind === "click" || cursor.kind === "double_click" ? [1, 0.84, 1] : 1,
                    left: `${(cursor.x / (browserState?.viewport.width || 1440)) * 100}%`,
                    top: `${(cursor.y / (browserState?.viewport.height || 900)) * 100}%`,
                  }}
                  exit={{ opacity: 0, scale: 0.9 }}
                  transition={{
                    left: settings.aiCursorSpeed === "instant" ? { duration: 0.035 } : { type: "spring", stiffness: settings.aiCursorSpeed === "fast" ? 520 : 310, damping: settings.aiCursorSpeed === "fast" ? 38 : 31, mass: 0.46 },
                    top: settings.aiCursorSpeed === "instant" ? { duration: 0.035 } : { type: "spring", stiffness: settings.aiCursorSpeed === "fast" ? 520 : 310, damping: settings.aiCursorSpeed === "fast" ? 38 : 31, mass: 0.46 },
                    scale: { duration: 0.2 },
                    opacity: { duration: 0.12 },
                  }}
                  className="clyra-browser-agent-cursor pointer-events-none absolute z-20 -translate-x-[4px] -translate-y-[3px]"
                >
                  <span
                    aria-hidden
                    className="absolute -left-3 -top-3 h-12 w-12 rounded-full bg-[radial-gradient(circle,rgba(15,23,42,0.22)_0%,rgba(100,116,139,0.12)_50%,transparent_75%)] blur-[10px]"
                  />
                  <MousePointer2 className="relative h-6 w-6 fill-slate-800 text-white [filter:drop-shadow(0_0_8px_rgba(15,23,42,.28))_drop-shadow(0_3px_6px_rgba(15,23,42,.28))]" />
                  {settings.showAiActionLabels && cursor.label ? (
                    <span className="absolute left-5 top-5 whitespace-nowrap rounded-md bg-slate-900 px-2 py-1 text-[9px] font-semibold text-white shadow-[0_4px_14px_rgba(15,23,42,.35)]">{cursor.label}</span>
                  ) : null}
                  {(cursor.kind === "click" || cursor.kind === "double_click") ? (
                    <span key={cursor.id} className="absolute left-[3px] top-[2px]" aria-hidden>
                      <span className="absolute h-5 w-5 animate-ping rounded-full border-2 border-slate-500/70" />
                      <span className="absolute h-5 w-5 animate-ping rounded-full bg-slate-400/30 [animation-duration:1.2s]" />
                    </span>
                  ) : null}
                </motion.div>,
              ] : null}
            </AnimatePresence>

            <AnimatePresence>
              {isBrowserBusy || (isAgentBusy && browserState?.loading) ? (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
                  className="pointer-events-none absolute inset-x-0 top-0 z-30 h-[2px] overflow-hidden bg-slate-100/90"
                >
                  <motion.div
                    className="h-full w-[38%] rounded-full bg-gradient-to-r from-transparent via-slate-700 to-transparent"
                    animate={{ x: ["-120%", "320%"] }}
                    transition={{ duration: 1.15, repeat: Infinity, ease: [0.16, 1, 0.3, 1] }}
                  />
                </motion.div>
              ) : null}
            </AnimatePresence>

            {browserState?.agent.manualControl ? (
              <div className="pointer-events-none absolute left-3 top-3 flex items-center gap-1.5 rounded-md border border-slate-200 bg-white/94 px-2 py-1 text-[9px] font-semibold text-slate-600 shadow-sm backdrop-blur-md">
                <UserRound className="h-3 w-3 text-slate-700" /> Manual control
              </div>
            ) : null}

            <AnimatePresence>
              {isAgentBusy ? (
                <motion.div
                  initial={{ opacity: 0, y: 10, scale: 0.97 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: 8, scale: 0.97 }}
                  transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
                  className="absolute bottom-4 left-1/2 z-30 flex h-9 -translate-x-1/2 items-center gap-1.5 rounded-full border border-slate-200/90 bg-white/95 px-1.5 text-[9px] font-semibold text-slate-700 shadow-[0_10px_28px_rgba(15,23,42,.12)] backdrop-blur-xl"
                >
                  <span className="grid h-6 w-6 place-items-center rounded-full bg-slate-100 text-slate-500"><Globe2 className="h-3 w-3" /></span>
                  <span className="max-w-32 truncate px-1 text-slate-600">{agentStatus}</span>
                  <button type="button" onClick={() => void controlAgent(agentPhase === "paused" && !browserState?.agent.manualControl ? "resume" : "pause")} className="flex h-7 items-center gap-1 rounded-full bg-slate-100 px-2 text-[9px] text-slate-600 transition-[background-color,transform] duration-200 hover:-translate-y-px hover:bg-slate-200">
                    {agentPhase === "paused" && !browserState?.agent.manualControl ? <><CirclePlay className="h-3 w-3" /> Resume</> : <><CirclePause className="h-3 w-3" /> Pause</>}
                  </button>
                  <button type="button" onClick={() => void controlAgent(browserState?.agent.manualControl ? "return_control" : "take_control")} className="flex h-7 items-center gap-1 rounded-full bg-slate-100 px-2 text-[9px] text-slate-600 transition-[background-color,transform] duration-200 hover:-translate-y-px hover:bg-slate-200">
                    {browserState?.agent.manualControl ? <><Sparkles className="h-3 w-3" /> Resume AI</> : <><MousePointer2 className="h-3 w-3" /> Take control</>}
                  </button>
                  <button type="button" onClick={() => void controlAgent("stop")} className="grid h-7 w-7 place-items-center rounded-full bg-rose-500 text-white transition-[background-color,transform] duration-200 hover:-translate-y-px hover:bg-rose-600" aria-label="Stop browser task"><Square className="h-2.5 w-2.5 fill-current" /></button>
                </motion.div>
              ) : null}
            </AnimatePresence>

            {error ? (
              <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="absolute inset-x-4 bottom-4 z-30 flex items-center gap-3 rounded-lg border border-red-200 bg-white px-3 py-2.5 text-[11px] font-medium text-red-600 shadow-lg">
                <span className="min-w-0 flex-1">{error}</span>
                <button type="button" onClick={() => void loadState()} className="font-semibold text-slate-900">Retry</button>
              </motion.div>
            ) : null}
          </div>

          <div className="flex h-7 shrink-0 items-center justify-between border-t border-slate-200 bg-white px-3 text-[9px] font-medium text-slate-400">
            <span className="flex min-w-0 items-center gap-1.5"><ShieldCheck className="h-3 w-3 text-slate-400" /><span className="truncate">{compactUrl(browserState?.url || "")}</span></span>
            <span>{Math.round((browserState?.zoom || 1) * 100)}%</span>
          </div>
        </section>

        <AnimatePresence initial={false}>
          {sideOpen ? (
            <motion.aside
              initial={{ opacity: 0, x: 28 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 18 }}
              transition={{ duration: 0.56, ease: [0.16, 1, 0.3, 1] }}
              className="absolute inset-x-0 bottom-0 top-10 z-40 flex min-h-0 flex-col border-l border-slate-200 bg-white text-slate-800 lg:static lg:rounded-none"
            >
              <header className="relative flex shrink-0 flex-col gap-2 border-b border-slate-200/80 px-4 py-3">
                <div className="flex h-4 items-center justify-center">
                  {sideView !== "agent" ? (
                    <button type="button" onClick={() => setSideView("agent")} className="absolute left-3 grid h-7 w-7 place-items-center rounded-lg text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700" aria-label="Back to Clyra">
                      <ArrowLeft className="h-3.5 w-3.5" />
                    </button>
                  ) : null}
                  <span className="text-[12px] font-semibold tracking-[-0.01em] text-slate-700">Clyra</span>
                </div>
                <button type="button" title={activeTab?.url || browserState?.url || "New tab"} className="flex min-w-0 items-center gap-2 rounded-xl border border-slate-200/90 bg-slate-50/75 px-2.5 py-2 text-left transition-[border-color,background-color,box-shadow] duration-200 hover:border-slate-300 hover:bg-white hover:shadow-[0_4px_12px_rgba(35,54,76,0.06)]">
                  <span className="grid h-6 w-6 shrink-0 place-items-center overflow-hidden rounded-lg border border-slate-200 bg-white text-slate-400">
                    {activeTab?.favicon ? <img src={activeTab.favicon} alt="" className="h-3.5 w-3.5" /> : <Globe2 className="h-3.5 w-3.5" />}
                  </span>
                  <span className="min-w-0 flex-1"><span className="block truncate text-[10.5px] font-semibold text-slate-700">{pageName}</span><span className="block truncate text-[9px] font-medium text-slate-400">{pageContextReady ? "Current page" : "Ready to assist"}</span></span>
                  <ChevronDown className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                </button>
              </header>

              {sideView === "agent" ? (
                <>
                  <div ref={chatScrollRef} className="clyra-visible-scrollbar min-h-0 flex-1 overflow-y-auto px-4 py-3.5">
                    <div className="space-y-5">
                      <AnimatePresence initial={false} mode="wait">
                        {messages.length === 0 && !isAgentBusy ? (
                          <motion.section key="browser-welcome" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8, height: 0 }} transition={{ duration: settings.reducedMotion ? 0.01 : 0.22, ease: [0.16, 1, 0.3, 1] }} className="mx-auto flex min-h-[calc(100vh-330px)] max-w-[300px] flex-col justify-center pb-8 pt-4 text-center">
                            <span className="mx-auto mb-4 grid h-10 w-10 place-items-center rounded-2xl border border-slate-200 bg-slate-50 text-slate-600 shadow-[0_6px_18px_rgba(15,23,42,0.06)]"><Sparkles className="h-4 w-4" /></span>
                            <h2 className="text-[17px] font-semibold tracking-[-0.02em] text-slate-800">Browse with Clyra</h2>
                            <p className="mx-auto mt-2 max-w-[270px] text-[11px] font-medium leading-5 text-slate-500">Ask about this page, find information, compare options, or let Clyra complete a browser task.</p>
                            <div className="mt-5 grid gap-2 text-left">
                              {[
                                { label: "Summarise this page", detail: "Extract the useful points", icon: Sparkles, prompt: "Summarise the current page and cite the most important details." },
                                { label: "Find something on this page", detail: "Search the visible content", icon: Search, prompt: "Find the most relevant information on the current page." },
                                { label: "Complete a task", detail: "Plan and act in this browser", icon: MousePointer2, prompt: "Help me complete a task on the current page." },
                              ].map((action) => (
                                <button key={action.label} type="button" onClick={() => void runAgentTask(action.prompt)} className="group flex min-h-14 items-center gap-3 rounded-2xl border border-slate-200 bg-white px-3 text-left shadow-[0_4px_14px_rgba(35,54,76,0.035)] transition-[transform,border-color,background-color,box-shadow] duration-200 hover:-translate-y-px hover:border-slate-300 hover:bg-slate-50 hover:shadow-[0_8px_20px_rgba(15,23,42,0.06)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300">
                                  <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl border border-slate-100 bg-slate-50 text-slate-500 transition-colors group-hover:border-slate-200 group-hover:bg-white group-hover:text-slate-800"><action.icon className="h-3.5 w-3.5" /></span>
                                  <span className="min-w-0"><span className="block text-[10.5px] font-semibold text-slate-700">{action.label}</span><span className="mt-0.5 block text-[9px] font-medium text-slate-400">{action.detail}</span></span>
                                </button>
                              ))}
                            </div>
                            {pageContextReady ? <span className="mt-4 flex items-center justify-center gap-1.5 text-[9px] font-semibold text-emerald-600"><Check className="h-3 w-3" /> Page context ready</span> : null}
                          </motion.section>
                        ) : null}
                      </AnimatePresence>
                      {messages.map((message) => {
                        const animateTypewriter = message.role === "assistant"
                          && !settings.reducedMotion
                          && !hydratedMessageIdsRef.current.has(message.id)
                          && !message.id.startsWith("welcome");
                        return (
                        <motion.div key={message.id} layout="position" initial={message.role === "user" ? { opacity: 0, y: 28, scale: 0.94 } : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ duration: message.role === "user" ? 0.72 : 0.22, ease: [0.16, 1, 0.3, 1] }} className={cn("flex gap-2.5", message.role === "user" && "clyra-browser-user-message-entry origin-bottom-right justify-end")}>
                          <div className={cn(
                            "max-w-[300px] text-[12.5px] font-medium leading-[1.65]",
                            message.role === "user"
                              ? "clyra-chat-user-bubble rounded-[18px] rounded-br-md border border-slate-200/70 bg-[#f4f4f4] px-3.5 py-3 text-slate-800"
                              : "max-w-full pr-1 text-slate-700",
                          )}>
                            <p className="whitespace-pre-wrap">
                              {message.role === "assistant" ? (
                                <TypewriterText
                                  text={message.content}
                                  active={animateTypewriter}
                                  msPerChar={12}
                                  onComplete={() => { hydratedMessageIdsRef.current.add(message.id); }}
                                />
                              ) : (
                                message.content
                              )}
                            </p>
                            {message.facts?.length ? (
                              <div className="mt-2.5 flex flex-wrap gap-1.5">
                                {message.facts.slice(0, 5).map((fact, index) => (
                                  <a key={`${fact.sourceUrl}-${index}`} href={fact.sourceUrl} target="_blank" rel="noreferrer" title={fact.claim} className="flex h-6 max-w-full items-center gap-1 rounded-full bg-slate-50 px-2 text-[8px] font-semibold text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800">
                                    <ExternalLink className="h-2.5 w-2.5" /><span className="truncate">{displayHost(fact.sourceUrl)}</span>
                                  </a>
                                ))}
                              </div>
                            ) : null}
                            {message.steps?.length ? (
                              <button type="button" onClick={() => setActivityOpen((value) => !value)} className="mt-2.5 flex items-center gap-1.5 text-[9px] font-semibold text-slate-400 hover:text-slate-700">
                                <Check className="h-3 w-3 text-emerald-500" /> {message.steps.length} verified actions <ChevronDown className={cn("h-3 w-3 transition-transform", activityOpen && "rotate-180")} />
                              </button>
                            ) : null}
                          </div>
                        </motion.div>
                        );
                      })}

                      {isAgentBusy ? (
                        <AgentRunSection
                          task={runTask || browserState?.agent.task || ""}
                          active={isAgentBusy}
                          phase={agentPhase}
                          statusText={agentStatus}
                          plan={plan}
                          items={runItems}
                          paused={agentPhase === "paused"}
                          manualControl={Boolean(browserState?.agent.manualControl)}
                          reducedMotion={settings.reducedMotion}
                          factCount={factCount}
                          completedStepsOpen={completedStepsOpen}
                          onToggleCompletedSteps={() => setCompletedStepsOpen((value) => !value)}
                          onControl={(command) => void controlAgent(command)}
                        />
                      ) : null}

                      <AnimatePresence>
                        {activityOpen && latestSteps.length ? (
                          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden border-l border-slate-200/80 pl-3.5">
                            {latestSteps.map((step, index) => <p key={`${step}-${index}`} className="mb-2 text-[10px] font-medium leading-4 text-slate-400">{step.replace(/ -> .*/, "")}</p>)}
                          </motion.div>
                        ) : null}
                      </AnimatePresence>
                      <div ref={chatEndRef} aria-hidden className="h-px w-full shrink-0" />
                    </div>
                  </div>

                  <div className="shrink-0 border-t border-slate-200/80 px-3 pb-3 pt-2.5">
                    <form
                      onSubmit={(event) => { event.preventDefault(); void runAgentTask(); }}
                      className="rounded-2xl border border-slate-200 bg-white p-3.5 shadow-[0_12px_30px_rgba(35,54,76,0.08)] transition-[border-color,box-shadow] duration-200 focus-within:border-slate-400 focus-within:shadow-[0_0_0_3px_rgba(148,163,184,0.18),0_12px_34px_rgba(35,54,76,0.10)]"
                    >
                      <textarea
                        value={task}
                        onChange={(event) => setTask(event.target.value)}
                        onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void runAgentTask(); } }}
                        rows={2}
                        placeholder="Ask Clyra about this page..."
                        className="w-full resize-none bg-transparent px-1 py-0.5 text-[13px] font-medium leading-5 text-slate-800 outline-none placeholder:text-slate-400"
                      />
                      <div className="flex items-center justify-between pt-1.5">
                        <span title={activeTab?.url || browserState?.url || "New tab"} className="flex min-w-0 items-center gap-1.5 text-[9px] font-medium text-slate-400"><span className="grid h-4 w-4 shrink-0 place-items-center overflow-hidden rounded border border-slate-200 bg-white">{activeTab?.favicon ? <img src={activeTab.favicon} alt="" className="h-2.5 w-2.5" /> : <Eye className="h-2.5 w-2.5" />}</span><span className="max-w-40 truncate">{pageName}</span></span>
                        <button type="submit" disabled={isAgentBusy || !task.trim()} className="grid h-9 w-9 place-items-center rounded-full bg-slate-900 text-white transition-[background-color,transform] hover:bg-slate-700 active:scale-95 disabled:bg-slate-100 disabled:text-slate-400" aria-label="Run browser task"><ArrowUp className="h-3.5 w-3.5" /></button>
                      </div>
                    </form>
                  </div>
                </>
              ) : null}

              {sideView === "history" ? (
                <div className="min-h-0 flex-1 overflow-y-auto p-2">
                  <div className="mb-2 flex items-center justify-between px-2 py-1"><span className="text-[9px] font-semibold uppercase text-slate-400">Recent</span><button type="button" onClick={() => void requestBrowser("/api/openbrowser/history", { method: "DELETE", body: {}, quiet: true })} className="text-[9px] font-semibold text-slate-500 hover:text-red-600">Clear</button></div>
                  {browserState?.history.length ? browserState.history.map((entry) => (
                    <button key={entry.id} type="button" onClick={() => void navigate(undefined, entry.url)} className="group flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors hover:bg-white">
                      <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md border border-slate-200 bg-white"><Clock3 className="h-3.5 w-3.5 text-slate-400" /></span>
                      <span className="min-w-0 flex-1"><span className="block truncate text-[10px] font-semibold text-slate-700">{entry.title}</span><span className="block truncate text-[8px] font-medium text-slate-400">{compactUrl(entry.url)}</span></span>
                      <span className="text-[8px] font-medium text-slate-400">{formatWhen(entry.visitedAt)}</span>
                    </button>
                  )) : <EmptyPanel icon={History} label="No browsing history" />}
                </div>
              ) : null}

              {sideView === "bookmarks" ? (
                <div className="min-h-0 flex-1 overflow-y-auto p-2">
                  <button type="button" onClick={() => void saveBookmark()} className="mb-2 flex h-9 w-full items-center justify-center gap-2 rounded-lg border border-dashed border-slate-300 text-[10px] font-semibold text-slate-600 transition-colors hover:border-slate-400 hover:bg-white"><Plus className="h-3.5 w-3.5" /> Bookmark current page</button>
                  {browserState?.bookmarks.length ? browserState.bookmarks.map((bookmark) => (
                    <div key={bookmark.id} className="group flex items-center gap-2 rounded-lg px-2 py-2 hover:bg-white">
                      <button type="button" onClick={() => void navigate(undefined, bookmark.url)} className="flex min-w-0 flex-1 items-center gap-2.5 text-left">
                        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md border border-slate-200 bg-white"><Star className="h-3.5 w-3.5 fill-amber-400 text-amber-500" /></span>
                        <span className="min-w-0"><span className="block truncate text-[10px] font-semibold text-slate-700">{bookmark.title}</span><span className="block truncate text-[8px] font-medium text-slate-400">{compactUrl(bookmark.url)}</span></span>
                      </button>
                      <IconButton label="Remove bookmark" onClick={() => void requestBrowser(`/api/openbrowser/bookmarks/${bookmark.id}`, { method: "DELETE", quiet: true })} className="opacity-0 group-hover:opacity-100"><Trash2 className="h-3.5 w-3.5" /></IconButton>
                    </div>
                  )) : <EmptyPanel icon={Bookmark} label="No bookmarks yet" />}
                </div>
              ) : null}

              {sideView === "downloads" ? (
                <div className="min-h-0 flex-1 overflow-y-auto p-2">
                  {browserState?.downloads.length ? browserState.downloads.map((download) => (
                    <div key={download.id} className="flex items-center gap-2.5 rounded-lg px-2 py-2 hover:bg-white">
                      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md border border-slate-200 bg-white"><FileDown className="h-4 w-4 text-slate-500" /></span>
                      <span className="min-w-0 flex-1"><span className="block truncate text-[10px] font-semibold text-slate-700">{download.filename}</span><span className={cn("block text-[8px] font-medium", download.status === "failed" ? "text-red-500" : download.status === "complete" ? "text-emerald-600" : "text-slate-600")}>{download.status}</span></span>
                    </div>
                  )) : <EmptyPanel icon={Download} label="No downloads" />}
                </div>
              ) : null}

              {sideView === "settings" ? (
                <div className="min-h-0 flex-1 overflow-y-auto p-4">
                  <SettingSelect label="Search engine" value={settings.defaultSearchEngine} options={["bing", "google", "duckduckgo"]} onChange={(value) => void updateSettings({ defaultSearchEngine: value as BrowserSettings["defaultSearchEngine"] })} />
                  <SettingSelect label="Performance" value={settings.performanceMode} options={["quality", "balanced", "efficient"]} onChange={(value) => void updateSettings({ performanceMode: value as BrowserSettings["performanceMode"] })} />
                  <div className="mt-3 divide-y divide-slate-100 border-y border-slate-100">
                    <SettingToggle label="Restore tabs" checked={settings.restoreTabs} onChange={(value) => void updateSettings({ restoreTabs: value })} />
                    <SettingToggle label="Save history" checked={settings.saveHistory} onChange={(value) => void updateSettings({ saveHistory: value })} />
                    <SettingToggle label="Bookmarks bar" checked={settings.showBookmarksBar} onChange={(value) => void updateSettings({ showBookmarksBar: value })} />
                    <SettingToggle label="AI cursor" checked={settings.showAiCursor} onChange={(value) => void updateSettings({ showAiCursor: value })} />
                    <SettingToggle label="Action labels" checked={settings.showAiActionLabels} onChange={(value) => void updateSettings({ showAiActionLabels: value })} />
                    <SettingToggle label="Private session" checked={settings.privateMode} onChange={(value) => void updateSettings({ privateMode: value })} />
                  </div>
                  <div className="mt-4 flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-[9px] font-medium text-slate-500"><ShieldCheck className="h-4 w-4 shrink-0 text-emerald-600" /> Browser data stays in the local Clyra profile.</div>
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

function statusPillMeta(phase: AgentStatus, manualControl: boolean): { label: string; className: string; live?: boolean } {
  switch (phase) {
    case "planning": return { label: "Planning", className: "bg-slate-100 text-slate-600 border-slate-200", live: true };
    case "observing": return { label: "Observing", className: "bg-slate-100 text-slate-600 border-slate-200", live: true };
    case "executing": return { label: "Acting", className: "bg-slate-100 text-slate-600 border-slate-200", live: true };
    case "verifying": return { label: "Verifying", className: "bg-slate-100 text-slate-600 border-slate-200", live: true };
    case "recovering": return { label: "Recovering", className: "bg-amber-50 text-amber-600 border-amber-200", live: true };
    case "waiting_for_user": return { label: "Needs you", className: "bg-amber-50 text-amber-600 border-amber-200" };
    case "paused": return { label: manualControl ? "You have control" : "Paused", className: "bg-slate-100 text-slate-500 border-slate-200" };
    case "completed": return { label: "Done", className: "bg-emerald-50 text-emerald-600 border-emerald-200" };
    case "failed": return { label: "Failed", className: "bg-rose-50 text-rose-600 border-rose-200" };
    case "cancelled": return { label: "Stopped", className: "bg-slate-100 text-slate-500 border-slate-200" };
    default: return { label: "Idle", className: "bg-slate-100 text-slate-500 border-slate-200" };
  }
}

function StatusPill({ phase, manualControl }: { phase: AgentStatus; manualControl: boolean }) {
  const meta = statusPillMeta(phase, manualControl);
  return (
    <span className={cn("flex h-5 shrink-0 items-center gap-1 rounded-full border px-1.5 text-[8.5px] font-semibold", meta.className)}>
      {meta.live ? <span className="h-1 w-1 animate-pulse rounded-full bg-current" /> : null}
      {meta.label}
    </span>
  );
}

function VerdictIcon({ verdict }: { verdict?: StepEvaluation["verdict"] }) {
  if (verdict === "Success") return <CircleCheck className="h-3.5 w-3.5 shrink-0 text-emerald-500" />;
  if (verdict === "Failure") return <CircleX className="h-3.5 w-3.5 shrink-0 text-rose-500" />;
  return <CircleHelp className="h-3.5 w-3.5 shrink-0 text-amber-500" />;
}

function RunControlButton({ label, onClick, tone = "slate", children }: { label: string; onClick: () => void; tone?: "slate" | "rose"; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className={cn(
        "grid h-6 w-6 shrink-0 place-items-center rounded-md transition-[background-color,color,transform] duration-150 active:scale-[0.92]",
        tone === "rose" ? "text-rose-500 hover:bg-rose-50 hover:text-rose-600" : "text-slate-400 hover:bg-slate-100 hover:text-slate-700",
      )}
    >
      {children}
    </button>
  );
}

function PlanChecklistCard({ plan, completedOpen, onToggleCompleted, reducedMotion }: { plan: TaskPlan; completedOpen: boolean; onToggleCompleted: () => void; reducedMotion: boolean }) {
  const completed = plan.steps.filter((step) => step.status === "complete");
  const remaining = plan.steps.filter((step) => step.status !== "complete");
  const collapseCompleted = completed.length > 1;
  const renderStep = (step: TaskPlan["steps"][number]) => (
    <li key={step.id} className="flex items-start gap-2 py-[3px]">
      <span className="mt-[3px] grid h-3 w-3 shrink-0 place-items-center" aria-hidden>
        {step.status === "complete" ? (
          <CircleCheck className="h-3 w-3 text-emerald-500" />
        ) : step.status === "active" ? (
          <motion.span
            className="h-2 w-2 rounded-full bg-slate-700"
            animate={reducedMotion ? undefined : { scale: [1, 1.35, 1], opacity: [1, 0.55, 1] }}
            transition={{ duration: 1.4, repeat: Infinity, ease: "easeInOut" }}
          />
        ) : step.status === "blocked" ? (
          <TriangleAlert className="h-3 w-3 text-amber-500" />
        ) : (
          <span className="h-2 w-2 rounded-full border border-slate-300" />
        )}
      </span>
      <span className={cn(
        "min-w-0 flex-1 text-[10px] font-medium leading-4",
        step.status === "complete" ? "text-slate-400 line-through decoration-slate-300" : step.status === "active" ? "text-slate-800" : "text-slate-500",
      )}>
        {step.label}
      </span>
    </li>
  );
  return (
    <motion.section initial={{ opacity: 0, y: 5 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: reducedMotion ? 0.01 : 0.2, ease: [0.16, 1, 0.3, 1] }} className="rounded-xl border border-slate-200 bg-white px-3 py-2.5 shadow-[0_2px_8px_rgba(35,54,76,0.04)]">
      <div className="mb-1 flex items-center justify-between text-[9px] font-semibold uppercase tracking-wide text-slate-400">
        <span>Plan</span>
        <span>{completed.length}/{plan.steps.length}</span>
      </div>
      <ol>
        {collapseCompleted ? (
          <li>
            <button type="button" onClick={onToggleCompleted} className="flex w-full items-center gap-2 py-[3px] text-left text-[10px] font-medium text-slate-400 transition-colors hover:text-slate-600">
              <CircleCheck className="h-3 w-3 shrink-0 text-emerald-500" />
              <span className="min-w-0 flex-1">{completed.length} steps completed</span>
              <ChevronDown className={cn("h-3 w-3 shrink-0 transition-transform duration-150", completedOpen && "rotate-180")} />
            </button>
            <AnimatePresence initial={false}>
              {completedOpen ? (
                <motion.ol initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.18 }} className="overflow-hidden pl-1">
                  {completed.map(renderStep)}
                </motion.ol>
              ) : null}
            </AnimatePresence>
          </li>
        ) : completed.map(renderStep)}
        {remaining.map(renderStep)}
      </ol>
    </motion.section>
  );
}

function ReasoningCard({ item, reducedMotion }: { item: Extract<RunItem, { kind: "reasoning" }>; reducedMotion: boolean }) {
  return (
    <motion.div initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: reducedMotion ? 0.01 : 0.18, ease: [0.16, 1, 0.3, 1] }} className="rounded-lg border border-slate-200 bg-slate-50/60 px-2.5 py-2">
      <div className="flex items-start gap-2">
        <span className="mt-[1px]"><VerdictIcon verdict={item.evaluation?.verdict} /></span>
        <div className="min-w-0 flex-1">
          <p className="text-[10.5px] font-semibold leading-4 text-slate-700">{item.nextGoal}</p>
          {item.evaluation?.reason ? <p className="mt-0.5 text-[9px] font-medium leading-3.5 text-slate-400">{item.evaluation.reason}</p> : null}
          {item.memory ? <p className="mt-1 text-[9px] font-medium leading-3.5 text-slate-400/90">{item.memory}</p> : null}
        </div>
      </div>
    </motion.div>
  );
}

function ActionRow({ item, reducedMotion }: { item: Extract<RunItem, { kind: "action" }>; reducedMotion: boolean }) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const Icon = ACTION_ICONS[item.icon] || Sparkles;
  return (
    <motion.div initial={{ opacity: 0, x: -4 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: reducedMotion ? 0.01 : 0.16, ease: [0.16, 1, 0.3, 1] }} className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5">
      <div className="flex items-center gap-2">
        <span className="grid h-5 w-5 shrink-0 place-items-center rounded-md bg-slate-100 text-slate-600"><Icon className="h-3 w-3" /></span>
        <span className="min-w-0 flex-1 truncate text-[10.5px] font-medium text-slate-700">{item.label}</span>
        {item.status === "running" ? (
          <Loader2 className="h-3 w-3 shrink-0 animate-spin text-slate-500" />
        ) : item.status === "success" ? (
          <CircleCheck className="h-3 w-3 shrink-0 text-emerald-500" />
        ) : (
          <CircleX className="h-3 w-3 shrink-0 text-rose-500" />
        )}
        <button type="button" onClick={() => setDetailsOpen((value) => !value)} aria-label="Toggle action details" className="grid h-4 w-4 shrink-0 place-items-center rounded text-slate-300 transition-colors hover:text-slate-500">
          <ChevronDown className={cn("h-3 w-3 transition-transform duration-150", detailsOpen && "rotate-180")} />
        </button>
      </div>
      <AnimatePresence initial={false}>
        {detailsOpen ? (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.16 }} className="overflow-hidden">
            {item.result ? <p className="mt-1.5 text-[9px] font-medium leading-3.5 text-slate-500">{item.result}</p> : null}
            <pre className="mt-1.5 max-h-32 overflow-auto rounded-md bg-slate-50 p-2 text-[8.5px] leading-3.5 text-slate-500">{item.detail}</pre>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </motion.div>
  );
}

function RecoveryCard({ item, reducedMotion }: { item: Extract<RunItem, { kind: "recovery" | "strategy" }>; reducedMotion: boolean }) {
  const Icon = item.kind === "strategy" ? RotateCcw : TriangleAlert;
  return (
    <motion.div initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: reducedMotion ? 0.01 : 0.18, ease: [0.16, 1, 0.3, 1] }} className="flex items-start gap-2 rounded-lg border border-amber-200/80 bg-amber-50/70 px-2.5 py-2">
      <Icon className="mt-[1px] h-3.5 w-3.5 shrink-0 text-amber-500" />
      <p className="min-w-0 flex-1 text-[10px] font-medium leading-4 text-amber-800">
        {item.kind === "strategy" ? <span className="mr-1 font-semibold">Changing strategy —</span> : null}
        {item.message}
      </p>
    </motion.div>
  );
}

function AskUserCard({ question, reducedMotion }: { question: string; reducedMotion: boolean }) {
  return (
    <motion.div initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: reducedMotion ? 0.01 : 0.2, ease: [0.16, 1, 0.3, 1] }} className="rounded-xl border border-slate-200 bg-slate-50/80 px-3 py-2.5">
      <div className="flex items-start gap-2">
        <CircleHelp className="mt-[1px] h-3.5 w-3.5 shrink-0 text-slate-500" />
        <div className="min-w-0 flex-1">
          <p className="text-[9px] font-semibold uppercase tracking-wide text-slate-500">Clyra needs your input</p>
          <p className="mt-1 text-[11px] font-medium leading-4.5 text-slate-700">{question}</p>
          <p className="mt-1.5 text-[9px] font-medium text-slate-400">Reply in the box below to continue.</p>
        </div>
      </div>
    </motion.div>
  );
}

function CompletionCard({ item, reducedMotion }: { item: Extract<RunItem, { kind: "complete" }>; reducedMotion: boolean }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 5 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: reducedMotion ? 0.01 : 0.22, ease: [0.16, 1, 0.3, 1] }}
      className={cn(
        "rounded-xl border px-3 py-2.5",
        item.success ? "border-emerald-200 bg-emerald-50/70" : "border-rose-200 bg-rose-50/60",
      )}
    >
      <div className="flex items-start gap-2">
        {item.success ? <CircleCheck className="mt-[1px] h-4 w-4 shrink-0 text-emerald-500" /> : <CircleX className="mt-[1px] h-4 w-4 shrink-0 text-rose-500" />}
        <div className="min-w-0 flex-1">
          <p className={cn("text-[9px] font-semibold uppercase tracking-wide", item.success ? "text-emerald-600" : "text-rose-500")}>
            {item.success ? "Task completed" : "Task not completed"}
          </p>
          {item.message ? <p className="mt-1 whitespace-pre-wrap text-[10.5px] font-medium leading-4.5 text-slate-700">{item.message}</p> : null}
          {item.evidence?.url ? (
            <a href={item.evidence.url} target="_blank" rel="noreferrer" className="mt-2 flex h-6 max-w-full items-center gap-1.5 rounded-md border border-slate-200/80 bg-white/80 px-2 text-[9px] font-semibold text-slate-600 transition-colors hover:text-slate-900">
              <ExternalLink className="h-2.5 w-2.5 shrink-0" />
              <span className="min-w-0 truncate">{item.evidence.title || displayHost(item.evidence.url)}</span>
              <span className="shrink-0 text-slate-400">{displayHost(item.evidence.url)}</span>
            </a>
          ) : null}
          {item.evidence?.checks?.length ? (
            <ul className="mt-1.5 space-y-0.5">
              {item.evidence.checks.slice(0, 6).map((check, index) => (
                <li key={`${check}-${index}`} className="flex items-start gap-1.5 text-[9px] font-medium leading-3.5 text-slate-500">
                  <Check className={cn("mt-[1px] h-2.5 w-2.5 shrink-0", item.success ? "text-emerald-500" : "text-slate-400")} />
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
  paused,
  manualControl,
  reducedMotion,
  factCount,
  completedStepsOpen,
  onToggleCompletedSteps,
  onControl,
}: {
  task: string;
  active: boolean;
  phase: AgentStatus;
  statusText: string;
  plan: TaskPlan | null;
  items: RunItem[];
  paused: boolean;
  manualControl: boolean;
  reducedMotion: boolean;
  factCount: number;
  completedStepsOpen: boolean;
  onToggleCompletedSteps: () => void;
  onControl: (command: "pause" | "resume" | "take_control" | "return_control" | "stop") => void;
}) {
  const completeItem = [...items].reverse().find((item): item is Extract<RunItem, { kind: "complete" }> => item.kind === "complete");
  const askItem = [...items].reverse().find((item): item is Extract<RunItem, { kind: "ask" }> => item.kind === "ask");
  const displayPhase: AgentStatus = active ? phase : completeItem ? (completeItem.success ? "completed" : "failed") : askItem ? "waiting_for_user" : phase;
  const feedItems = active ? items.slice(-24) : [];
  const thinking = active && ["planning", "observing"].includes(phase) && !manualControl;
  return (
    <motion.section initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: reducedMotion ? 0.01 : 0.22, ease: [0.16, 1, 0.3, 1] }} className="space-y-2">
      <div className="rounded-xl border border-slate-200 bg-slate-50/70 px-3 py-2.5">
        <div className="flex items-center gap-2">
          <span className="grid h-5 w-5 shrink-0 place-items-center rounded-md bg-slate-100 text-slate-600"><Bot className="h-3 w-3" /></span>
          <span className="min-w-0 flex-1 truncate text-[9px] font-semibold uppercase tracking-wide text-slate-400">Browser task</span>
          <StatusPill phase={displayPhase} manualControl={manualControl} />
          {active ? (
            <span className="flex shrink-0 items-center gap-0.5">
              <RunControlButton label={paused && !manualControl ? "Resume" : "Pause"} onClick={() => onControl(paused && !manualControl ? "resume" : "pause")}>
                {paused && !manualControl ? <CirclePlay className="h-3.5 w-3.5" /> : <CirclePause className="h-3.5 w-3.5" />}
              </RunControlButton>
              <RunControlButton label={manualControl ? "Hand control back to Clyra" : "Take control"} onClick={() => onControl(manualControl ? "return_control" : "take_control")}>
                {manualControl ? <Sparkles className="h-3.5 w-3.5" /> : <Hand className="h-3.5 w-3.5" />}
              </RunControlButton>
              <RunControlButton label="Stop task" tone="rose" onClick={() => onControl("stop")}>
                <Square className="h-2.5 w-2.5 fill-current" />
              </RunControlButton>
            </span>
          ) : null}
        </div>
        {task ? <p className="mt-1.5 line-clamp-3 text-[11px] font-medium leading-4.5 text-slate-700">{task}</p> : null}
      </div>

      {plan && active ? (
        <PlanChecklistCard plan={plan} completedOpen={completedStepsOpen} onToggleCompleted={onToggleCompletedSteps} reducedMotion={reducedMotion} />
      ) : null}

      {feedItems.length ? (
        <div className="space-y-1.5">
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
        <div className="flex items-center gap-2 px-0.5 py-0.5">
          <ShiningBrainIcon className="h-4 w-4 shrink-0" />
          <ShiningText text={statusText || "Thinking"} preset="thinkingChat" play={!reducedMotion} className="min-w-0 flex-1 truncate !text-[11.5px]" />
          <ThinkingDots />
          {factCount > 0 ? <span className="shrink-0 text-[9px] font-medium text-slate-400">{factCount} facts</span> : null}
        </div>
      ) : null}
    </motion.section>
  );
}

function EmptyPanel({ icon: Icon, label }: { icon: typeof History; label: string }) {
  return <div className="grid min-h-56 place-items-center text-center"><div><Icon className="mx-auto mb-2 h-5 w-5 text-slate-300" /><p className="text-[10px] font-semibold text-slate-400">{label}</p></div></div>;
}

function SettingToggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return <div className="flex h-11 items-center justify-between text-[10px] font-semibold text-slate-600"><span>{label}</span><Toggle label={label} checked={checked} onChange={onChange} /></div>;
}

function SettingSelect({ label, value, options, onChange }: { label: string; value: string; options: string[]; onChange: (value: string) => void }) {
  return (
    <label className="mb-3 block">
      <span className="mb-1.5 block text-[9px] font-semibold uppercase text-slate-400">{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)} className="h-9 w-full rounded-lg border border-slate-200 bg-white px-2.5 text-[10px] font-semibold capitalize text-slate-700 outline-none transition-colors focus:border-slate-400">
        {options.map((option) => <option key={option} value={option}>{option.replace(/_/g, " ")}</option>)}
      </select>
    </label>
  );
}
