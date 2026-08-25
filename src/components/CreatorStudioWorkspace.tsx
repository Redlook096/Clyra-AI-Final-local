import {
  ArrowDown,
  ArrowUp,
  Check,
  Clock3,
  Copy,
  Download,
  FileJson,
  Gauge,
  ImagePlus,
  Loader2,
  Maximize2,
  MessageCircle,
  Mic2,
  Palette,
  Pause,
  Play,
  Plus,
  Redo2,
  RotateCcw,
  Save,
  Send,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  Undo2,
  Upload,
  Video,
  Volume2,
  X,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  memo,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  FAKE_TEXT_GAMEPLAY_LIBRARY,
  type FakeTextGameplayCategory,
  type FakeTextGameplayClip,
} from "../data/fakeTextGameplay";
import { cn } from "../lib/utils";
import {
  playCreatorCue,
  playCreatorSpeech,
  playCreatorVoicePreview,
  primeCreatorAudio,
  prefetchCreatorVoicePreviews,
  renderMessageStoryVideo,
  renderStoryVideo,
  renderWouldRatherVideo,
  type CreatorVoice,
  type WouldRatherPhase,
} from "../lib/creatorMedia";
import {
  createCreatorProject,
  creatorProjectDuration,
  creatorTimeline,
  exportCreatorProject,
  loadCreatorProject,
  migrateCreatorProject,
  saveCreatorProject,
  WOULD_RATHER_LEAD_IN_MS,
  type CreatorProject,
  type CreatorProjectType,
  type FakeTextProject,
  type StoryMessage,
  type WouldRatherProject,
  type WouldRatherRound,
} from "../lib/creatorProject";
import {
  buildIMessageTimeline,
  getIMessageFrame,
  getIMessageFloatingPanelGeometry,
  getIMessageGroupPosition,
  getIMessagePanelLayout,
  getTypingDotPhase,
  IMESSAGE_CANVAS,
  IMESSAGE_TOKENS,
} from "../lib/fakeTextTimeline";

export type CreatorMode = "would-rather" | "reddit-story" | "fake-text";

type InspectorTab = "style" | "timing" | "audio";
type SetupStep = "start" | "brief";
type TemplateStep = "script" | "theme" | "gameplay" | "audio";

const MODE_TO_TYPE: Record<CreatorMode, CreatorProjectType> = {
  "would-rather": "would_rather",
  "fake-text": "fake_text_story",
  "reddit-story": "story_video",
};

const MODE_META: Record<CreatorMode, {
  name: string;
  detail: string;
  promptLabel: string;
  promptPlaceholder: string;
  accent: string;
}> = {
  "would-rather": {
    name: "Would You Rather",
    detail: "Build paced, narrated choice videos with timed poll reveals.",
    promptLabel: "Topic or audience",
    promptPlaceholder: "Impossible travel choices for university students",
    accent: "#d946ef",
  },
  "fake-text": {
    name: "Message Story",
    detail: "Turn a premise into a naturally paced, two-voice message story.",
    promptLabel: "Story premise",
    promptPlaceholder: "Two friends discover they received the same mysterious photo",
    accent: "#0a84ff",
  },
  "reddit-story": {
    name: "Story Video",
    detail: "Shape a concise hook and narration for a vertical story.",
    promptLabel: "Story idea",
    promptPlaceholder: "The small decision that changed an ordinary evening",
    accent: "#f97316",
  },
};

const VOICES: Array<{ id: CreatorVoice; name: string; detail: string }> = [
  { id: "Max", name: "Max", detail: "Clear, warm and natural" },
  { id: "Ryan", name: "Ryan", detail: "Warm, grounded and conversational" },
  { id: "Aiden", name: "Aiden", detail: "Bright, relaxed and expressive" },
  { id: "Aaron", name: "Aaron", detail: "Steady, clear and confident" },
  { id: "Abigail", name: "Abigail", detail: "Soft, friendly and natural" },
  { id: "Anaya", name: "Anaya", detail: "Warm, expressive and bright" },
  { id: "Andy", name: "Andy", detail: "Casual, upbeat and easygoing" },
  { id: "Archer", name: "Archer", detail: "Crisp, polished and articulate" },
  { id: "Brian", name: "Brian", detail: "Deep, calm and measured" },
  { id: "Chloe", name: "Chloe", detail: "Light, lively and engaging" },
  { id: "Dylan", name: "Dylan", detail: "Youthful, smooth and clear" },
  { id: "Emmanuel", name: "Emmanuel", detail: "Rich, warm and assured" },
  { id: "Ethan", name: "Ethan", detail: "Friendly, natural and even" },
  { id: "Evelyn", name: "Evelyn", detail: "Soft, elegant and clear" },
  { id: "Gavin", name: "Gavin", detail: "Confident, sharp and energetic" },
  { id: "Gordon", name: "Gordon", detail: "Mature, steady and grounded" },
  { id: "Ivan", name: "Ivan", detail: "Low, composed and direct" },
  { id: "Laura", name: "Laura", detail: "Bright, warm and conversational" },
  { id: "Lucy", name: "Lucy", detail: "Sweet, clear and cheerful" },
  { id: "Madison", name: "Madison", detail: "Modern, crisp and friendly" },
  { id: "Marisol", name: "Marisol", detail: "Warm, fluent and expressive" },
  { id: "Meera", name: "Meera", detail: "Soft, measured and articulate" },
  { id: "Walter", name: "Walter", detail: "Deep, deliberate and classic" },
];

function cloneProject<T extends CreatorProject>(project: T): T {
  return JSON.parse(JSON.stringify(project)) as T;
}

function MessageSpeakerToggle({
  side,
  onClick,
  label,
}: {
  side: "left" | "right";
  onClick: () => void;
  label: string;
}) {
  const active = side === "right";
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "relative h-[40px] w-[64px] shrink-0 rounded-full transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-300",
        active ? "bg-[#091b68]" : "bg-[#b7bfd3]",
      )}
    >
      <span
        className={cn(
          "absolute left-[4px] top-[4px] grid h-8 w-8 place-items-center rounded-full bg-white shadow-[0_2px_7px_rgba(15,23,42,.16)] transition-transform duration-200 ease-out",
          active && "translate-x-6",
        )}
      >
        <MessageCircle className="h-4 w-4 text-[#091b68]" strokeWidth={2} />
      </span>
    </button>
  );
}

function formatTime(milliseconds: number) {
  const seconds = Math.max(0, Math.round(milliseconds / 1_000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function fileToDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result || "")), { once: true });
    reader.addEventListener("error", () => reject(new Error("The selected file could not be read")), { once: true });
    reader.readAsDataURL(file);
  });
}

function waitFor(milliseconds: number, signal?: AbortSignal) {
  if (signal?.aborted) return Promise.reject(new DOMException("Cancelled", "AbortError"));
  return new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(resolve, milliseconds);
    signal?.addEventListener("abort", () => {
      window.clearTimeout(timer);
      reject(new DOMException("Cancelled", "AbortError"));
    }, { once: true });
  });
}

function waitForProgress(
  milliseconds: number,
  signal: AbortSignal | undefined,
  onProgress: (progress: number) => void,
) {
  if (signal?.aborted) return Promise.reject(new DOMException("Cancelled", "AbortError"));
  if (milliseconds <= 0) {
    onProgress(1);
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    const startedAt = performance.now();
    // Prefer setInterval over rAF — rAF can be fully starved in background /
    // automated browser tabs, which permanently hangs silent WYR preview.
    let timer = 0;
    const cleanup = () => {
      window.clearInterval(timer);
      signal?.removeEventListener("abort", abort);
    };
    const abort = () => {
      cleanup();
      reject(new DOMException("Cancelled", "AbortError"));
    };
    const tick = () => {
      const progress = Math.min(1, (performance.now() - startedAt) / milliseconds);
      onProgress(progress);
      if (progress >= 1) {
        cleanup();
        resolve();
      }
    };
    signal?.addEventListener("abort", abort, { once: true });
    onProgress(0);
    timer = window.setInterval(tick, 16);
  });
}

const WOULD_RATHER_PHASE_CLOCK = {
  promptEnd: 850,
  firstEntranceEnd: 1_070,
  firstSpeechEnd: 2_250,
  firstHoldEnd: 3_250,
  orEnd: 3_850,
  secondEntranceEnd: 4_070,
  timerStart: WOULD_RATHER_LEAD_IN_MS,
} as const;

function useCreatorDocument<T extends CreatorProject>(initial: T) {
  const [project, setProject] = useState<T>(() => cloneProject(initial));
  const [saveState, setSaveState] = useState<"saved" | "saving">("saved");
  const undoStack = useRef<T[]>([]);
  const redoStack = useRef<T[]>([]);

  const edit = useCallback((mutator: (draft: T) => void) => {
    setProject((current) => {
      undoStack.current = [...undoStack.current.slice(-49), cloneProject(current)];
      redoStack.current = [];
      const next = cloneProject(current);
      mutator(next);
      next.updatedAt = new Date().toISOString();
      return next;
    });
    setSaveState("saving");
  }, []);

  const replace = useCallback((next: T, keepHistory = true) => {
    setProject((current) => {
      if (keepHistory) {
        undoStack.current = [...undoStack.current.slice(-49), cloneProject(current)];
        redoStack.current = [];
      }
      return cloneProject(next);
    });
    setSaveState("saving");
  }, []);

  const undo = useCallback(() => {
    setProject((current) => {
      const previous = undoStack.current.pop();
      if (!previous) return current;
      redoStack.current.push(cloneProject(current));
      setSaveState("saving");
      return previous;
    });
  }, []);

  const redo = useCallback(() => {
    setProject((current) => {
      const next = redoStack.current.pop();
      if (!next) return current;
      undoStack.current.push(cloneProject(current));
      setSaveState("saving");
      return next;
    });
  }, []);

  const saveNow = useCallback(() => {
    saveCreatorProject(project);
    setSaveState("saved");
  }, [project]);

  useEffect(() => {
    setSaveState("saving");
    const timer = window.setTimeout(() => {
      saveCreatorProject(project);
      setSaveState("saved");
    }, 520);
    return () => window.clearTimeout(timer);
  }, [project]);

  return {
    project,
    edit,
    replace,
    undo,
    redo,
    saveNow,
    saveState,
    canUndo: undoStack.current.length > 0,
    canRedo: redoStack.current.length > 0,
  };
}

function IconButton({
  label,
  children,
  onClick,
  disabled,
}: {
  label: string;
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-slate-500 transition-[background-color,color,transform] duration-150 hover:bg-slate-100 hover:text-slate-950 active:scale-95 disabled:pointer-events-none disabled:opacity-30"
    >
      {children}
    </button>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  multiline,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  multiline?: boolean;
}) {
  const classes = "mt-1.5 w-full rounded-md border border-slate-200 bg-white px-3 text-[12px] font-medium text-slate-900 outline-none transition-[border-color,box-shadow] duration-150 focus:border-slate-500 focus:shadow-[0_0_0_3px_rgba(15,23,42,.06)]";
  return (
    <label className="block text-[10px] font-semibold text-slate-500">
      {label}
      {multiline ? (
        <textarea
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          rows={3}
          className={cn(classes, "resize-none py-2.5 leading-5")}
        />
      ) : (
        <input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          className={cn(classes, "h-10")}
        />
      )}
    </label>
  );
}

function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <div>
      <p className="mb-1.5 text-[10px] font-semibold text-slate-500">{label}</p>
      <div className="relative grid grid-flow-col auto-cols-fr rounded-md border border-slate-200 bg-slate-50 p-1">
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            className={cn(
              "relative h-8 rounded text-[10px] font-semibold transition-colors duration-150",
              value === option.value ? "text-slate-950" : "text-slate-400 hover:text-slate-700",
            )}
          >
            {value === option.value ? (
              <motion.span
                layoutId={`creator-segment-${label}`}
                className="absolute inset-0 rounded border border-slate-200 bg-white shadow-sm"
                transition={{ type: "spring", stiffness: 650, damping: 45 }}
              />
            ) : null}
            <span className="relative z-10">{option.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function VoicePicker({
  label,
  value,
  onChange,
  onPreview,
}: {
  label: string;
  value: CreatorVoice;
  onChange: (voice: CreatorVoice) => void;
  onPreview: (voice: CreatorVoice) => void;
}) {
  return (
    <div>
      <p className="mb-2 text-[10px] font-semibold text-slate-500">{label}</p>
      <div className="max-h-[300px] space-y-1 overflow-y-auto rounded-[16px] border border-[#e2e5ea] bg-[#f6f8fc] p-1.5 [scrollbar-width:thin] [scrollbar-color:#dfe3ea_transparent]">
        {VOICES.map((voice) => {
          const active = value === voice.id;
          return (
            <div
              key={voice.id}
              className={cn(
                "flex items-center gap-2 rounded-[12px] px-3 py-2.5 transition-[background-color,box-shadow,color]",
                active
                  ? "bg-white text-slate-950 shadow-[0_2px_10px_rgba(15,23,42,.06)] ring-1 ring-[#4169f6]/30"
                  : "text-slate-700 hover:bg-white/75",
              )}
            >
              <button
                type="button"
                onClick={() => onChange(voice.id)}
                className="min-w-0 flex-1 text-left"
              >
                <span className="block text-[12px] font-semibold">{voice.name}</span>
                <span className={cn("mt-0.5 block truncate text-[8px]", active ? "text-slate-500" : "text-slate-400")}>{voice.detail}</span>
              </button>
              <button
                type="button"
                aria-label={`Preview ${voice.name}`}
                onClick={() => onPreview(voice.id)}
                className={cn(
                  "grid h-8 w-8 shrink-0 place-items-center rounded-full transition-[background-color,color,transform] active:scale-95",
                  active ? "bg-[#4169f6] text-white" : "bg-[#edf2ff] text-[#4169f6] hover:bg-[#4169f6] hover:text-white",
                )}
              >
                <Play className="h-3.5 w-3.5 fill-current" />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PercentScroller({
  value,
  onChange,
  leftLabel = "First choice",
  rightLabel = "Second choice",
}: {
  value: number;
  onChange: (value: number) => void;
  leftLabel?: string;
  rightLabel?: string;
}) {
  return (
    <div className="rounded-[14px] border border-[#e2e5ea] bg-[#f6f8fc] px-4 py-3.5">
      <div className="mb-2.5 flex items-end justify-between gap-3">
        <div>
          <p className="text-[10px] font-medium text-[#68707c]">{leftLabel}</p>
          <p className="mt-0.5 text-[18px] font-semibold tabular-nums text-[#ef1710]">{value}%</p>
        </div>
        <div className="text-right">
          <p className="text-[10px] font-medium text-[#68707c]">{rightLabel}</p>
          <p className="mt-0.5 text-[18px] font-semibold tabular-nums text-[#1598dc]">{100 - value}%</p>
        </div>
      </div>
      <input
        aria-label="Poll split percentage"
        type="range"
        min={5}
        max={95}
        step={1}
        value={value}
        onChange={(event) => onChange(Math.max(5, Math.min(95, Number(event.target.value))))}
        className="h-2 w-full cursor-pointer appearance-none rounded-full bg-[#e2e5ea] accent-[#4169f6] [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-[#4169f6] [&::-webkit-slider-thumb]:shadow-[0_2px_8px_rgba(65,105,246,.35)]"
      />
    </div>
  );
}

function ThemePreviewMock({ theme }: { theme: "ios_dark" | "ios_light" }) {
  const dark = theme === "ios_dark";
  return (
    <div className="mb-3 overflow-hidden rounded-[12px] border border-black/5 shadow-[0_6px_16px_rgba(15,23,42,.08)]" style={{ background: dark ? "#000000" : "#ffffff" }}>
      <div className="flex items-center gap-1.5 px-2.5 py-2" style={{ background: dark ? "#1f1f1f" : "#f4f4f6" }}>
        <span className="grid h-5 w-5 place-items-center rounded-full text-[8px] font-light text-white" style={{ background: "#aab0bb" }}>A</span>
        <span className="h-1.5 w-12 rounded-full" style={{ background: dark ? "#d8d8dc" : "#26262b", opacity: 0.45 }} />
        <span className="ml-auto h-2.5 w-4 rounded-[2px]" style={{ border: `1.5px solid ${dark ? "#0a84ff" : "#0a84ff"}` }} />
      </div>
      <div className="space-y-1.5 px-2.5 py-2.5">
        <div className="h-4 w-[62%] rounded-full" style={{ background: dark ? "#292929" : "#e9e9eb" }} />
        <div className="ml-auto h-4 w-[52%] rounded-full bg-[#0a84ff]" />
        <div className="h-4 w-[44%] rounded-full" style={{ background: dark ? "#292929" : "#e9e9eb" }} />
      </div>
    </div>
  );
}

function LoadingScreen({
  stage,
  onCancel,
  eyebrow = "Clyra creator",
  title = "Building your project",
}: {
  stage: string;
  onCancel?: () => void;
  eyebrow?: string;
  title?: string;
}) {
  return createPortal(
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[700] grid place-items-center bg-[#f8fafc]/96 px-6 backdrop-blur-xl"
    >
      <div className="w-full max-w-[460px]">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[.18em] text-slate-400">{eyebrow}</p>
            <h2 className="mt-2 text-[28px] font-semibold tracking-[-.02em] text-slate-950">{title}</h2>
          </div>
          {onCancel ? (
            <IconButton label="Cancel" onClick={onCancel}>
              <X className="h-4 w-4" />
            </IconButton>
          ) : null}
        </div>
        <div className="mt-8 space-y-2">
          {[0.78, 1, 0.64, 0.88].map((width, index) => (
            <motion.div
              key={index}
              className="h-10 overflow-hidden rounded-md bg-slate-200/65"
              style={{ width: `${width * 100}%` }}
            >
              <motion.span
                className="block h-full w-1/2 bg-gradient-to-r from-transparent via-white/85 to-transparent"
                animate={{ x: ["-120%", "260%"] }}
                transition={{ repeat: Infinity, duration: 1.05, ease: "linear", delay: index * 0.08 }}
              />
            </motion.div>
          ))}
        </div>
        <div className="mt-7 flex items-center gap-3 text-[11px] font-semibold text-slate-600">
          <Loader2 className="h-4 w-4 animate-spin" />
          {stage}
        </div>
      </div>
    </motion.div>,
    document.body,
  );
}

function createGeneratedProject(
  type: CreatorProjectType,
  data: Record<string, unknown>,
): CreatorProject {
  const project = createCreatorProject(type);
  const title = typeof data.title === "string" ? data.title.slice(0, 80) : project.name;
  project.name = title || project.name;

  if (project.type === "would_rather") {
    const rows = Array.isArray(data.rounds) ? data.rounds : [];
    const rounds = rows.slice(0, 20).map((raw) => {
      const row = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
      const percent = Math.max(5, Math.min(95, Number(row.leftPercent) || 50));
      return {
        id: crypto.randomUUID(),
        question: String(row.question || "Would you rather...").slice(0, 120),
        left: String(row.left || "Option A").slice(0, 120),
        right: String(row.right || "Option B").slice(0, 120),
        leftPercent: percent,
        timerSeconds: 5,
        revealSeconds: 1.5,
      };
    });
    if (rounds.length) project.rounds = rounds;
  } else if (project.type === "fake_text_story") {
    const contactName = typeof data.contactName === "string" ? data.contactName.slice(0, 30) : "Alex";
    project.participants[0].name = contactName || "Alex";
    const rows = Array.isArray(data.messages) ? data.messages : [];
    const messages = rows.slice(0, 80).map((raw, index) => {
      const row = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
      return {
        id: crypto.randomUUID(),
        side: row.side === "right" ? "right" as const : row.side === "left" ? "left" as const : index % 2 ? "right" as const : "left" as const,
        text: String(row.text || "").trim().slice(0, 600),
        typingSeconds: Math.max(0.35, Math.min(5, String(row.text || "").length / 34)),
        pauseSeconds: 0.25,
        narration: true,
      };
    }).filter((message) => message.text);
    if (messages.length) project.messages = messages;
  } else {
    if (typeof data.title === "string") project.title = data.title.slice(0, 140);
    if (typeof data.body === "string") project.body = data.body.slice(0, 4_000);
  }
  return project;
}

function SetupWizard({
  mode,
  savedProject,
  onReady,
}: {
  mode: CreatorMode;
  savedProject: CreatorProject;
  onReady: (project: CreatorProject) => void;
}) {
  const meta = MODE_META[mode];
  const type = MODE_TO_TYPE[mode];
  const [step, setStep] = useState<SetupStep>("start");
  const [method, setMethod] = useState<"ai" | "manual">("ai");
  const [prompt, setPrompt] = useState("");
  const [tone, setTone] = useState("Conversational");
  const [count, setCount] = useState(type === "story_video" ? 1 : type === "fake_text_story" ? 12 : 5);
  const [error, setError] = useState("");
  const [loadingStage, setLoadingStage] = useState("");
  const request = useRef<AbortController | null>(null);
  const hasDraft = savedProject.updatedAt !== savedProject.createdAt;

  useEffect(() => () => request.current?.abort(), []);

  const generate = async () => {
    if (method === "manual") {
      onReady(createCreatorProject(type));
      return;
    }
    if (!prompt.trim()) {
      setError(`Enter a ${meta.promptLabel.toLowerCase()} first.`);
      return;
    }
    const controller = new AbortController();
    request.current = controller;
    setError("");
    setLoadingStage("Sending your brief securely");
    try {
      const response = await fetch("/api/creator/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({ kind: type, prompt: prompt.trim(), tone, count }),
      });
      setLoadingStage("Validating the generated script");
      const payload = await response.json() as { ok?: boolean; data?: Record<string, unknown>; error?: string };
      if (!response.ok || !payload.data) throw new Error(payload.error || "The script could not be generated");
      onReady(createGeneratedProject(type, payload.data));
    } catch (cause) {
      if (controller.signal.aborted) return;
      setError(cause instanceof Error ? cause.message : String(cause));
      setLoadingStage("");
    } finally {
      if (request.current === controller) request.current = null;
    }
  };

  return (
    <div className="relative h-full overflow-y-auto bg-[#f8fafc] px-5 py-8 sm:px-8 lg:px-12">
      <AnimatePresence>{loadingStage ? <LoadingScreen stage={loadingStage} onCancel={() => { request.current?.abort(); setLoadingStage(""); }} /> : null}</AnimatePresence>
      <div className="mx-auto flex min-h-full w-full max-w-[1120px] flex-col justify-center">
        <div className="mb-7 flex items-end justify-between gap-6 border-b border-slate-200 pb-6">
          <div>
            <div className="mb-4 flex items-center gap-2">
              <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: meta.accent }} />
              <span className="text-[10px] font-bold uppercase tracking-[.17em] text-slate-400">Creator studio</span>
            </div>
            <h1 className="text-[clamp(30px,4vw,48px)] font-semibold tracking-[-.035em] text-slate-950">{meta.name}</h1>
            <p className="mt-2 max-w-xl text-[13px] leading-6 text-slate-500">{meta.detail}</p>
          </div>
          {hasDraft ? (
            <button
              type="button"
              onClick={() => onReady(savedProject)}
              className="hidden h-10 shrink-0 items-center gap-2 rounded-md border border-slate-200 bg-white px-4 text-[10px] font-semibold text-slate-700 shadow-sm transition-colors hover:border-slate-400 sm:flex"
            >
              <Clock3 className="h-3.5 w-3.5" />
              Continue draft
            </button>
          ) : null}
        </div>

        <div className="creator-setup-layout grid gap-5">
          <ol className="space-y-2" aria-label="Project setup">
            {[
              { id: "start" as const, index: 1, title: "Starting point", detail: "Choose AI or manual creation" },
              { id: "brief" as const, index: 2, title: "Project brief", detail: "Set the content and pacing" },
            ].map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => item.id === "start" || step === "brief" ? setStep(item.id) : undefined}
                  className={cn(
                    "flex w-full items-start gap-3 rounded-md px-3 py-3 text-left transition-colors",
                    step === item.id ? "bg-white text-slate-950 shadow-sm ring-1 ring-slate-200" : "text-slate-400 hover:bg-white/70",
                  )}
                >
                  <span className={cn(
                    "grid h-6 w-6 shrink-0 place-items-center rounded-full border text-[9px] font-bold",
                    step === item.id ? "border-slate-900 bg-slate-950 text-white" : "border-slate-200 bg-white",
                  )}>{item.index}</span>
                  <span>
                    <span className="block text-[11px] font-semibold">{item.title}</span>
                    <span className="mt-0.5 block text-[8px] leading-4 text-slate-400">{item.detail}</span>
                  </span>
                </button>
              </li>
            ))}
          </ol>

          <motion.section
            key={step}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.24, ease: [0.2, 0.8, 0.2, 1] }}
            className="border-t border-slate-200 pt-6 lg:border-l lg:border-t-0 lg:pl-8 lg:pt-0"
          >
            {step === "start" ? (
              <div>
                <p className="text-[10px] font-bold uppercase tracking-[.14em] text-slate-400">Choose a workflow</p>
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  {[
                    { id: "ai" as const, icon: Sparkles, name: "Create with AI", detail: "Generate a structured first draft using the LLM already connected to Clyra." },
                    { id: "manual" as const, icon: SlidersHorizontal, name: "Start manually", detail: "Open a clean project and build every scene yourself." },
                  ].map((option) => {
                    const Icon = option.icon;
                    return (
                      <button
                        key={option.id}
                        type="button"
                        onClick={() => setMethod(option.id)}
                        className={cn(
                          "min-h-[150px] rounded-md border p-5 text-left transition-[border-color,background-color,transform] duration-150 active:scale-[.99]",
                          method === option.id ? "border-slate-900 bg-white shadow-sm" : "border-slate-200 bg-white/60 hover:border-slate-400",
                        )}
                      >
                        <div className="flex items-center justify-between">
                          <span className="grid h-9 w-9 place-items-center rounded-md bg-slate-100 text-slate-700">
                            <Icon className="h-4 w-4" />
                          </span>
                          {method === option.id ? <Check className="h-4 w-4 text-slate-950" /> : null}
                        </div>
                        <p className="mt-5 text-[13px] font-semibold text-slate-950">{option.name}</p>
                        <p className="mt-1.5 text-[10px] leading-5 text-slate-500">{option.detail}</p>
                      </button>
                    );
                  })}
                </div>
                <div className="mt-6 flex items-center justify-between">
                  {hasDraft ? (
                    <button type="button" onClick={() => onReady(savedProject)} className="text-[10px] font-semibold text-slate-500 hover:text-slate-950 sm:hidden">
                      Continue saved draft
                    </button>
                  ) : <span />}
                  <button
                    type="button"
                    onClick={() => setStep("brief")}
                    className="h-10 rounded-md bg-slate-950 px-5 text-[10px] font-semibold text-white transition-transform active:scale-[.98]"
                  >
                    Continue
                  </button>
                </div>
              </div>
            ) : (
              <div>
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-[10px] font-bold uppercase tracking-[.14em] text-slate-400">Project brief</p>
                    <h2 className="mt-2 text-[22px] font-semibold text-slate-950">{method === "ai" ? "Give Clyra a direction" : "Open a clean composition"}</h2>
                  </div>
                  <button type="button" onClick={() => setStep("start")} className="text-[10px] font-semibold text-slate-400 hover:text-slate-950">Change workflow</button>
                </div>
                {method === "ai" ? (
                  <div className="mt-6 space-y-5">
                    <Field label={meta.promptLabel} value={prompt} onChange={setPrompt} placeholder={meta.promptPlaceholder} multiline />
                    <div className="grid gap-4 sm:grid-cols-2">
                      <label className="block text-[10px] font-semibold text-slate-500">
                        Tone
                        <select value={tone} onChange={(event) => setTone(event.target.value)} className="mt-1.5 h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-[11px] font-medium outline-none">
                          <option>Conversational</option>
                          <option>Funny</option>
                          <option>Suspenseful</option>
                          <option>Warm</option>
                          <option>Fast paced</option>
                        </select>
                      </label>
                      {type !== "story_video" ? (
                        <label className="block text-[10px] font-semibold text-slate-500">
                          {type === "would_rather" ? "Questions" : "Messages"}
                          <input type="number" min="1" max={type === "would_rather" ? 12 : 40} value={count} onChange={(event) => setCount(Number(event.target.value))} className="mt-1.5 h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-[11px] font-medium outline-none" />
                        </label>
                      ) : null}
                    </div>
                  </div>
                ) : (
                  <div className="mt-6 border-y border-slate-200 py-7">
                    <p className="max-w-lg text-[12px] leading-6 text-slate-500">The editor opens with a production-ready default composition. You can change its script, voices, timing, visual style, and export settings immediately.</p>
                  </div>
                )}
                {error ? <p className="mt-4 text-[10px] font-medium text-red-600">{error}</p> : null}
                <div className="mt-7 flex justify-end">
                  <button
                    type="button"
                    onClick={() => void generate()}
                    className="flex h-11 items-center gap-2 rounded-md bg-slate-950 px-6 text-[10px] font-semibold text-white transition-transform active:scale-[.98]"
                  >
                    {method === "ai" ? <Sparkles className="h-3.5 w-3.5" /> : <SlidersHorizontal className="h-3.5 w-3.5" />}
                    {method === "ai" ? "Generate project" : "Open editor"}
                  </button>
                </div>
              </div>
            )}
          </motion.section>
        </div>
      </div>
    </div>
  );
}

function WouldRatherPreview({
  project,
  round,
  phase,
  countdown,
  revealed,
}: {
  project: WouldRatherProject;
  round: WouldRatherRound;
  phase: WouldRatherPhase;
  countdown: number | null;
  revealed: boolean;
}) {
  const optionAnimation = (position: "top" | "bottom") => project.style.optionAnimation === "slide"
    ? { opacity: 0, x: position === "top" ? -90 : 90 }
    : project.style.optionAnimation === "fade"
      ? { opacity: 0 }
      : { opacity: 0, scale: 0.92 };
  const option = (position: "top" | "bottom") => {
    const top = position === "top";
    const text = top ? round.left : round.right;
    const image = top ? round.leftImage : round.rightImage;
    const percent = top ? round.leftPercent : 100 - round.leftPercent;
    const visible = top
      ? phase !== "prompt"
      : phase === "second" || phase === "countdown" || phase === "reveal";
    return (
      <div
        className="relative flex min-h-0 flex-1 flex-col items-center justify-center overflow-hidden px-6 text-center"
        style={{ backgroundColor: top ? project.style.topColor : project.style.bottomColor }}
      >
        {image && visible ? <img src={image} alt="" className="absolute inset-0 h-full w-full object-cover opacity-55" /> : null}
        <div className="absolute inset-0 bg-black/10" />
        <AnimatePresence mode="wait">
          {visible ? (
            <motion.div
              key={`${round.id}-${position}-${text}`}
              initial={optionAnimation(position)}
              animate={{
                opacity: 1,
                x: 0,
                scale: 1,
                y: phase === "reveal" && revealed ? (top ? -28 : 30) : 0,
              }}
              exit={{ opacity: 0, scale: 0.98 }}
              transition={{ duration: 0.22, ease: [0.2, 0.82, 0.2, 1] }}
              className="relative z-10"
            >
              <p
                className="mx-auto max-w-[92%] font-black leading-[1.08] text-white [text-shadow:-2px_-2px_0_#000,2px_-2px_0_#000,-2px_2px_0_#000,2px_2px_0_#000]"
                style={{ fontSize: `${22 * project.style.fontScale}px` }}
              >
                {text}
              </p>
            </motion.div>
          ) : null}
        </AnimatePresence>
        <AnimatePresence>
          {phase === "reveal" && revealed ? (
            <motion.div
              initial={{ opacity: 0, scaleX: 0.2 }}
              animate={{ opacity: 1, scaleX: 1 }}
              transition={{ type: "spring", stiffness: 360, damping: 30 }}
              className={cn("absolute inset-x-6 z-20", top ? "bottom-4" : "top-4")}
            >
              <p
                className={cn(
                  "text-[28px] font-black [text-shadow:-2px_-2px_0_#000,2px_-2px_0_#000,-2px_2px_0_#000,2px_2px_0_#000]",
                  percent >= 50 ? "text-[#30e96f]" : "text-[#ff3838]",
                )}
              >
                {percent}%
              </p>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
    );
  };

  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden bg-black">
      <div className="absolute inset-x-4 top-4 z-30 text-center">
        <p className="text-[7px] font-bold uppercase tracking-[.18em] text-white/70">Would you rather</p>
        <p className="mt-1 line-clamp-2 text-[10px] font-bold leading-4 text-white [text-shadow:0_1px_3px_#000]">{round.question}</p>
      </div>
      {option("top")}
      <div className="relative z-30 h-[5px] shrink-0 bg-black">
        {phase === "or" || phase === "second" || phase === "countdown" ? (
          <motion.span
            key={phase === "countdown" && countdown !== null ? `count-${countdown}` : "or"}
            initial={{ opacity: 0, scale: 0.78 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.16, ease: [0.2, 0.82, 0.2, 1] }}
            className="absolute left-1/2 top-1/2 grid h-14 w-14 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-black text-[17px] font-black text-white"
          >
            {phase === "countdown" && countdown !== null ? countdown : "OR"}
          </motion.span>
        ) : null}
      </div>
      {option("bottom")}
    </div>
  );
}

const MessageGameplayLayer = memo(function MessageGameplayLayer({ project, isPlaying, playbackMs }: { project: FakeTextProject; isPlaying: boolean; playbackMs: number }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (isPlaying) void video.play().catch(() => undefined);
    else video.pause();
  }, [isPlaying, project.gameplay?.src]);
  useEffect(() => {
    const video = videoRef.current;
    if (!video || isPlaying || !Number.isFinite(video.duration) || video.duration <= 0) return;
    const nextTime = (playbackMs / 1_000) % video.duration;
    if (Math.abs(video.currentTime - nextTime) > .12) video.currentTime = nextTime;
  }, [isPlaying, playbackMs, project.gameplay?.src]);
  if (project.gameplay) return <video ref={videoRef} data-testid="fake-text-gameplay" src={project.gameplay.src} poster={project.gameplay.poster} muted loop playsInline preload="metadata" aria-label={`${project.gameplay.category} gameplay background`} className="absolute inset-0 h-full w-full object-cover" />;
  if (project.background) return <img src={project.background} alt="" className="absolute inset-0 h-full w-full object-cover" />;
  return <div className="absolute inset-0 bg-[linear-gradient(155deg,#328d68,#2a7659_52%,#205844)]" />;
}, (previous, next) => previous.project.gameplay?.src === next.project.gameplay?.src && previous.project.background === next.project.background && previous.isPlaying === next.isPlaying && (next.isPlaying || previous.playbackMs === next.playbackMs));

function MessagePreview({
  project,
  isPlaying = false,
  playbackMs,
  visible,
  windowStart = 0,
}: {
  project: FakeTextProject;
  isPlaying?: boolean;
  playbackMs?: number;
  /** Legacy editor fallback. The active template editor always uses playbackMs. */
  visible?: number;
  windowStart?: number;
}) {
  const messageScroll = useRef<HTMLDivElement | null>(null);
  const timeline = useMemo(
    () => buildIMessageTimeline(project.messages, project.playbackRate, { showTypingIndicator: project.showTypingIndicator }),
    [project.messages, project.playbackRate, project.showTypingIndicator],
  );
  // The active editor always supplies media time, including zero. Treat that
  // first frame as a deterministic timeline frame so the first message is
  // present at t=0 exactly like the public Framelabs template. The legacy
  // compact fallback intentionally omits playbackMs and keeps its own visible
  // message count.
  const isTimelineControlled = playbackMs !== undefined;
  const safePlaybackMs = playbackMs ?? 0;
  const frame = isTimelineControlled
    ? getIMessageFrame(timeline, safePlaybackMs)
    : { visibleCount: 0, typingSide: null, typingStartMs: null, enteringMessageId: null, entranceProgress: 1, activeMessageId: null, showReadReceipt: false, readReceiptMessageId: null, readReceiptLabel: null };
  const frameVisible = isTimelineControlled ? frame.visibleCount : (visible ?? project.messages.length);
  const shown = project.messages.slice(windowStart, windowStart + frameVisible);
  // A Fake Text sheet is content-fit by design: its footer follows the newest
  // bubble and lets the gameplay remain visible below.  When a real overflow
  // occurs, this shared layout caps the sheet and the message list scrolls.
  const floatingLayout = getIMessagePanelLayout(shown, { typingSide: frame.typingSide, showReadReceipt: frame.showReadReceipt });
  const floatingGeometry = getIMessageFloatingPanelGeometry(floatingLayout);
  const floatingHeight = `${(floatingGeometry.height / IMESSAGE_CANVAS.height * 100).toFixed(3)}%`;
  const floatingLeft = `${(floatingGeometry.x / IMESSAGE_CANVAS.width * 100).toFixed(3)}%`;
  const floatingTop = `${(floatingGeometry.y / IMESSAGE_CANVAS.height * 100).toFixed(3)}%`;
  const floatingWidth = `${(floatingGeometry.width / IMESSAGE_CANVAS.width * 100).toFixed(3)}%`;
  // `cqw` resolves against the outer 9:16 preview, not the floating card.
  // Express all fixed visual tokens against the logical canvas so DOM preview
  // and canvas export scale with the same 1080px reference width.
  const floatingRadius = `${(floatingGeometry.radius / IMESSAGE_CANVAS.width * 100).toFixed(3)}cqw`;
  const fullHeaderHeight = `${(IMESSAGE_TOKENS.headerHeight / IMESSAGE_CANVAS.width * 100).toFixed(3)}cqw`;
  const floatingHeaderHeight = fullHeaderHeight;
  const panelGeometry = project.layout === "full_chat"
    ? { left: "0%", top: "0%", width: "100%", height: "100%", radius: "0px", headerHeight: fullHeaderHeight }
    : project.layout === "chat_gameplay"
      ? { left: "0%", top: "0%", width: "100%", height: "68%", radius: "0px", headerHeight: fullHeaderHeight }
      : { left: floatingLeft, top: floatingTop, width: floatingWidth, height: floatingHeight, radius: floatingRadius, headerHeight: floatingHeaderHeight };
  const palette = project.theme === "ios_light"
    ? { panel: "#ffffff", header: "#f4f4f6", incoming: "#e9e9eb", outgoing: "#0a84ff", incomingText: "#111114", contact: "#26262b", accent: "#0a84ff", avatar: "#aab0bb" }
    : { panel: "#000000", header: "#1c1c1e", incoming: "#2c2c2e", outgoing: "#0a84ff", incomingText: "#f5f5f7", contact: "#d8d8dc", accent: "#0a84ff", avatar: "#aab0bb" };

  // Layout-effect, not effect: the scroll position must land in the same
  // paint as the bubble's opacity/transform, or the bubble visibly renders a
  // frame ahead of the list catching up to it — the "flicker" a rAF-driven
  // useEffect update introduces once the browser has already painted.
  useLayoutEffect(() => {
    const container = messageScroll.current;
    if (!container || !isTimelineControlled) return;
    // The header never participates in the scroll. The destination is
    // resolved directly from the media time, never a CSS/JS scroll transition,
    // so a scrubbed frame, a paused frame, and an exported frame all describe
    // the identical scroll position for that exact timestamp. The entering
    // bubble occupies its full layout height immediately (only its own
    // opacity/scale/translateY animates via transform), so the "before" list
    // height is derived by subtracting that one bubble's measured
    // contribution rather than by remembering a previous frame.
    const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
    if (!frame.enteringMessageId || frame.entranceProgress >= 1) {
      container.scrollTop = maxScrollTop;
      return;
    }
    const enteringEl = container.querySelector<HTMLElement>(`[data-message-id="${frame.enteringMessageId}"]`);
    let previousMax = maxScrollTop;
    if (enteringEl) {
      const marginTopPx = parseFloat(window.getComputedStyle(enteringEl).marginTop) || 0;
      previousMax = Math.max(0, maxScrollTop - (enteringEl.offsetHeight + marginTopPx));
    }
    container.scrollTop = previousMax + (maxScrollTop - previousMax) * frame.entranceProgress;
  }, [frameVisible, frame.enteringMessageId, frame.entranceProgress, isTimelineControlled]);

  return (
    <div data-testid="fake-text-preview" className="relative h-full w-full overflow-hidden bg-[#2a7659]">
      <MessageGameplayLayer project={project} isPlaying={isPlaying} playbackMs={safePlaybackMs} />
      <div
        data-testid="imessage-conversation-canvas"
        // Height is already derived from the deterministic media timeline
        // (from the media timestamp), so this transition never changes *what*
        // height is correct for a given time — only playback smooths the
        // visual step between two already-correct heights (the typing row
        // adding/removing itself). A scrub or a paused frame disables it so
        // dragging the scrubber snaps immediately instead of lagging behind,
        // keeping the exported frame and a scrubbed preview frame identical.
        className="absolute flex flex-col overflow-hidden"
        style={{
          left: panelGeometry.left,
          top: panelGeometry.top,
          width: panelGeometry.width,
          height: panelGeometry.height,
          borderRadius: panelGeometry.radius,
          backgroundColor: palette.panel,
          borderBottom: "none",
          transition: isPlaying && isTimelineControlled ? "height 180ms cubic-bezier(0.22, 1, 0.36, 1)" : "none",
        }}
      >
          <div data-testid="imessage-header" className="relative shrink-0 border-b border-white/[.04]" style={{ height: panelGeometry.headerHeight, backgroundColor: palette.header }}>
            <div className="absolute left-[3.05%] top-1/2 flex -translate-y-1/2 items-center gap-[.35cqw]" style={{ color: palette.accent }}>
              <span className="text-[3.05cqw] font-light leading-none">‹</span><span className="text-[2.05cqw] font-medium leading-none">99</span>
            </div>
            <div className="absolute left-1/2 top-[5%] flex -translate-x-1/2 flex-col items-center">
              <span className="grid h-[7.5cqw] w-[7.5cqw] place-items-center rounded-full text-[2.65cqw] font-normal text-white" style={{ backgroundColor: palette.avatar }}>{(project.participants[0].name || "Unknown").slice(0, 1).toUpperCase()}</span>
              <span className="mt-[.55cqw] whitespace-nowrap text-[2.22cqw] font-semibold leading-none" style={{ color: palette.contact }}>{project.participants[0].name || "Unknown"} <span className="font-normal opacity-70">›</span></span>
            </div>
            <Video className="absolute right-[3.25%] top-1/2 h-[3.15cqw] w-[4.15cqw] -translate-y-1/2" style={{ color: palette.accent }} strokeWidth={1.55} />
          </div>
          <div ref={messageScroll} className="flex min-h-0 flex-1 flex-col overflow-y-auto px-[2.47%] pb-[1.296cqw] pt-[1.481cqw] [scrollbar-width:none]" style={{ backgroundColor: palette.panel }}>
              {shown.map((message, localIndex) => {
                const index = windowStart + localIndex;
                const groupPosition = getIMessageGroupPosition(shown, localIndex);
                const hasTail = groupPosition === "end" || groupPosition === "single";
                const isEntering = message.id === frame.enteringMessageId;
                const progress = isEntering ? frame.entranceProgress : 1;
                const isReceiptTarget = frame.showReadReceipt && message.id === frame.readReceiptMessageId;
                const tailColor = message.side === "right" ? palette.outgoing : palette.incoming;
                return (
                <div
                  key={message.id}
                  data-testid={`imessage-bubble-${index}`}
                  data-message-id={message.id}
                  className={cn(
                    "relative flex min-h-[4.444cqw] w-fit max-w-[64%] items-center [overflow-wrap:anywhere] px-[1.481cqw] py-[1.019cqw] text-[2.222cqw] font-normal leading-[1.15]",
                    message.side === "right" ? "ml-auto text-white" : "",
                  )}
                  style={{
                    backgroundColor: message.side === "right" ? palette.outgoing : palette.incoming,
                    color: message.side === "right" ? "#ffffff" : palette.incomingText,
                    borderRadius: "2.5cqw",
                    // Consecutive iMessage bubbles sit fractionally closer
                    // together than a sender change. Keep these values tied
                    // to the shared 1080px tokens used by the canvas renderer.
                    marginTop: localIndex
                      ? `${((shown[localIndex - 1]!.side === message.side
                        ? IMESSAGE_TOKENS.sameSenderGap
                        : IMESSAGE_TOKENS.senderSwitchGap) / IMESSAGE_CANVAS.width * 100).toFixed(3)}cqw`
                      : 0,
                    // A short, precise iOS-style pop — opacity/scale/translateY are a
                    // pure function of the media timestamp (see getIMessageFrame), so
                    // a scrub, a paused frame, and playback always agree. Using
                    // transform (not layout width/height) means the bubble already
                    // occupies its final space, which is what keeps the coordinated
                    // auto-scroll above deterministic too.
                    opacity: progress,
                    transform: `translateY(${(1 - progress) * IMESSAGE_TOKENS.bubbleEntranceRiseDistance}px) scale(${IMESSAGE_TOKENS.bubbleEntranceStartScale + (1 - IMESSAGE_TOKENS.bubbleEntranceStartScale) * progress})`,
                    transformOrigin: message.side === "right" ? "bottom right" : "bottom left",
                  }}
                >
                  <span className="relative">{message.text}</span>
                  {hasTail ? (
                    <span aria-hidden className="pointer-events-none absolute bottom-0 h-[1.1cqw] w-[1.1cqw]" style={{
                      [message.side === "right" ? "right" : "left"]: "-0.3cqw",
                      backgroundColor: tailColor,
                      borderRadius: message.side === "right" ? "0 0 0 1.1cqw" : "0 0 1.1cqw 0",
                    }} />
                  ) : null}
                  {hasTail ? (
                    <span aria-hidden className="pointer-events-none absolute bottom-[-0.2cqw] h-[1.5cqw] w-[1.5cqw] rounded-full" style={{
                      [message.side === "right" ? "right" : "left"]: "-1cqw",
                      backgroundColor: palette.panel,
                    }} />
                  ) : null}
                  {isReceiptTarget ? (
                    <span
                      aria-hidden
                      className="absolute -bottom-[1.9cqw] right-0 whitespace-nowrap text-[1.4cqw] font-medium"
                      style={{ color: project.theme === "ios_light" ? "#8a8a8e" : "#98989d" }}
                    >
                      {frame.readReceiptLabel === "read" ? "Read" : "Delivered"}
                    </span>
                  ) : null}
                </div>
                );
              })}
              {frame.typingSide ? (
                <div
                  className={cn(
                    "flex h-[4.444cqw] w-[7.4cqw] items-center justify-center gap-[.55cqw] rounded-[2.5cqw]",
                    frame.typingSide === "right" ? "ml-auto" : "",
                  )}
                  style={{
                    backgroundColor: frame.typingSide === "right" ? palette.outgoing : palette.incoming,
                    marginTop: shown.length ? `${(IMESSAGE_TOKENS.senderSwitchGap / IMESSAGE_CANVAS.width * 100).toFixed(3)}cqw` : 0,
                  }}
                >
                  {getTypingDotPhase(safePlaybackMs, frame.typingStartMs ?? safePlaybackMs).map((offset, dotIndex) => (
                    <span
                      key={dotIndex}
                      aria-hidden
                      className="h-[.55cqw] w-[.55cqw] rounded-full"
                      style={{
                        backgroundColor: frame.typingSide === "right" ? "rgba(255,255,255,.85)" : (project.theme === "ios_light" ? "#8a8a8e" : "#98989d"),
                        transform: `translateY(${-offset * 3.5}px)`,
                      }}
                    />
                  ))}
                </div>
              ) : null}
          </div>
      </div>
    </div>
  );
}

const GAMEPLAY_CATEGORIES: Array<{ id: FakeTextGameplayCategory; label: string; detail: string }> = [
  { id: "subway", label: "Subway Surfers", detail: "Fast, bright runs" },
  { id: "minecraft", label: "Minecraft", detail: "Parkour flow" },
  { id: "gta", label: "GTA", detail: "Mega-ramp action" },
];

function GameplayPicker({ selected, onSelect }: { selected?: string; onSelect: (clip: FakeTextGameplayClip) => void }) {
  const initial = FAKE_TEXT_GAMEPLAY_LIBRARY.find((clip) => clip.id === selected)?.category || "subway";
  const [category, setCategory] = useState<FakeTextGameplayCategory>(initial);
  const clips = FAKE_TEXT_GAMEPLAY_LIBRARY.filter((clip) => clip.category === category);

  useEffect(() => {
    const selectedCategory = FAKE_TEXT_GAMEPLAY_LIBRARY.find((clip) => clip.id === selected)?.category;
    if (selectedCategory) setCategory(selectedCategory);
  }, [selected]);

  const selectCategory = (nextCategory: FakeTextGameplayCategory) => {
    setCategory(nextCategory);
    const nextClip = FAKE_TEXT_GAMEPLAY_LIBRARY.find((clip) => clip.category === nextCategory);
    if (nextClip && nextClip.id !== selected) onSelect(nextClip);
  };

  return (
    <motion.div initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} className="py-5">
      <div>
        <p className="text-[12px] font-semibold text-slate-950">Gameplay background</p>
        <p className="mt-1 text-[8px] leading-4 text-slate-400">Local 40-second, silent 9:16 clips. The selected cut loops behind the conversation.</p>
      </div>

      <div className="mt-5 flex flex-wrap gap-1.5 rounded-[18px] border border-[#e8ebe6] bg-[#f5f3ef] p-1.5">
        {GAMEPLAY_CATEGORIES.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => selectCategory(item.id)}
            className={cn(
              "min-w-0 flex-1 rounded-full px-3 py-2.5 text-center transition-[background-color,color,box-shadow] duration-150",
              category === item.id
                ? "bg-white text-slate-950 shadow-[0_4px_14px_rgba(15,23,42,.08)]"
                : "text-slate-500 hover:bg-white/60 hover:text-slate-800",
            )}
          >
            <span className="block truncate text-[9px] font-semibold">{item.label}</span>
            <span className="mt-0.5 block truncate text-[7px] opacity-70">{item.detail}</span>
          </button>
        ))}
      </div>

      <div className="mt-4 grid grid-cols-3 gap-2 sm:grid-cols-5">
        {clips.map((clip) => {
          const active = selected === clip.id;
          return (
            <button
              key={clip.id}
              type="button"
              aria-pressed={active}
              onClick={() => onSelect(clip)}
              className={cn(
                "group relative overflow-hidden rounded-lg border bg-slate-950 text-left transition-[transform,border-color,box-shadow] duration-150 active:scale-[.98]",
                active ? "border-[#0a84ff] shadow-[0_0_0_2px_rgba(10,132,255,.14),0_12px_28px_rgba(15,23,42,.15)]" : "border-slate-200 hover:-translate-y-0.5 hover:border-slate-400",
              )}
            >
              <img src={clip.poster} alt="" loading="lazy" className="aspect-[9/14] w-full object-cover opacity-90 transition-transform duration-300 group-hover:scale-[1.025]" />
              <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 via-black/55 to-transparent px-2 pb-2 pt-8 text-white">
                <span className="flex items-center justify-between gap-1 text-[7px] font-semibold"><span>Clip {Number(clip.id.slice(-2))}</span>{active ? <Check className="h-3 w-3 text-sky-300" /> : null}</span>
                <span className="mt-0.5 block text-[6px] text-white/60">{clip.timeRange}</span>
              </span>
            </button>
          );
        })}
      </div>

      <div className="mt-4 flex items-center justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5">
        <div className="min-w-0">
          <p className="truncate text-[8px] font-semibold text-slate-700">{FAKE_TEXT_GAMEPLAY_LIBRARY.find((clip) => clip.id === selected)?.label || "Choose a clip"}</p>
          <p className="mt-0.5 text-[7px] text-slate-400">Muted source audio keeps both character voices clear.</p>
        </div>
        <span className="shrink-0 text-[7px] font-semibold text-slate-400">9:16 · 40 sec</span>
      </div>
    </motion.div>
  );
}

function StoryPreview({ project }: { project: Extract<CreatorProject, { type: "story_video" }> }) {
  return (
    <div className="relative flex aspect-[9/16] h-full max-h-[560px] w-auto max-w-full flex-col overflow-hidden rounded-md bg-[#111318] p-6 text-white shadow-[0_24px_70px_rgba(2,6,23,.32)]">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_20%,rgba(249,115,22,.22),transparent_45%)]" />
      <div className="relative mt-12 border-y border-white/15 py-5">
        <p className="text-[8px] font-bold uppercase tracking-[.18em] text-orange-400">Story</p>
        <h2 className="mt-3 text-[21px] font-bold leading-tight">{project.title}</h2>
        <p className="mt-4 text-[10px] leading-5 text-white/62">{project.body}</p>
      </div>
      <div className="relative mt-auto">
        <div className="mb-3 h-px w-12 bg-orange-400" />
        <p className="text-[15px] font-black leading-tight">{project.title}</p>
      </div>
    </div>
  );
}

function Timeline({
  project,
  selectedId,
  onSelect,
}: {
  project: CreatorProject;
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  const [zoom, setZoom] = useState(1);
  const [snap, setSnap] = useState(true);
  const items = useMemo(() => creatorTimeline(project), [project]);
  const duration = Math.max(1, creatorProjectDuration(project));
  const tracks = ["visual", "voice", "sfx"] as const;
  return (
    <section className="shrink-0 border-t border-slate-200 bg-white">
      <div className="flex h-10 items-center justify-between border-b border-slate-100 px-3">
        <div className="flex items-center gap-2">
          <Clock3 className="h-3.5 w-3.5 text-slate-400" />
          <span className="text-[10px] font-semibold text-slate-700">Timeline</span>
          <span className="text-[9px] tabular-nums text-slate-400">0:00 / {formatTime(duration)}</span>
        </div>
        <div className="flex items-center gap-3">
          <button type="button" onClick={() => setSnap((value) => !value)} className={cn("text-[9px] font-semibold", snap ? "text-slate-950" : "text-slate-400")}>Snap</button>
          <input aria-label="Timeline zoom" type="range" min="1" max="2.4" step="0.1" value={zoom} onChange={(event) => setZoom(Number(event.target.value))} className="h-1 w-20 accent-slate-950" />
        </div>
      </div>
      <div className="h-[116px] overflow-auto [scrollbar-width:thin]">
        <div className="min-w-full" style={{ width: `${zoom * 100}%` }}>
          {tracks.map((track) => {
            const trackItems = items.filter((item) => item.track === track);
            return (
              <div key={track} className="grid h-[38px] grid-cols-[58px_minmax(0,1fr)] border-b border-slate-100 last:border-b-0">
                <div className="flex items-center border-r border-slate-100 px-2 text-[8px] font-bold uppercase tracking-[.08em] text-slate-400">{track}</div>
                <div className="relative bg-[linear-gradient(90deg,transparent_24.8%,rgba(148,163,184,.12)_25%,transparent_25.2%,transparent_49.8%,rgba(148,163,184,.12)_50%,transparent_50.2%,transparent_74.8%,rgba(148,163,184,.12)_75%,transparent_75.2%)]">
                  {trackItems.map((item) => {
                    const baseId = item.id.replace(/-voice$/, "");
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => onSelect(baseId)}
                        title={item.label}
                        className={cn(
                          "absolute top-1 h-[30px] overflow-hidden rounded-[3px] border border-black/10 px-2 text-left text-[8px] font-semibold text-white shadow-sm transition-[filter,transform] hover:brightness-105 active:scale-[.99]",
                          selectedId === baseId && "ring-2 ring-slate-950 ring-offset-1",
                        )}
                        style={{
                          left: `${(item.startMs / duration) * 100}%`,
                          width: `${Math.max(2.5, (item.durationMs / duration) * 100)}%`,
                          backgroundColor: item.color,
                        }}
                      >
                        <span className="block truncate">{item.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function RenderOverlay({
  progress,
  onCancel,
}: {
  progress: number | null;
  onCancel: () => void;
}) {
  if (progress === null) return null;
  const stage = progress < 0.25
    ? "Generating narration"
    : progress < 0.9
      ? "Composing frames and timing"
      : "Encoding the final MP4";
  return createPortal(
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="fixed inset-0 z-[700] grid place-items-center bg-[#f8f9fa]/97 px-6 backdrop-blur-xl">
      <div className="w-full max-w-[460px] rounded-2xl border border-white bg-white/82 p-6 shadow-[0_24px_80px_rgba(15,23,42,.1)]">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[.17em] text-slate-400">Local render</p>
            <h2 className="mt-2 text-[28px] font-semibold text-slate-950">Preparing your video</h2>
          </div>
          <IconButton label="Cancel render" onClick={onCancel}><X className="h-4 w-4" /></IconButton>
        </div>
        <div className="mt-8 h-1.5 overflow-hidden rounded-full bg-blue-100">
          <motion.div className="h-full bg-blue-600" animate={{ width: `${Math.max(2, Math.round(progress * 100))}%` }} transition={{ duration: 0.16 }} />
        </div>
        <div className="mt-4 flex items-center justify-between text-[10px] font-semibold text-slate-500">
          <span>{stage}</span>
          <span className="tabular-nums">{Math.round(progress * 100)}%</span>
        </div>
      </div>
    </motion.div>,
    document.body,
  );
}

function InspectorTabs({ value, onChange }: { value: InspectorTab; onChange: (value: InspectorTab) => void }) {
  const tabs: Array<{ id: InspectorTab; label: string; icon: typeof Palette }> = [
    { id: "style", label: "Style", icon: Palette },
    { id: "timing", label: "Timing", icon: Gauge },
    { id: "audio", label: "Audio", icon: Volume2 },
  ];
  return (
    <div className="grid grid-cols-3 border-b border-slate-200">
      {tabs.map((tab) => {
        const Icon = tab.icon;
        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => onChange(tab.id)}
            className={cn(
              "relative flex h-10 items-center justify-center gap-1.5 text-[9px] font-semibold transition-colors",
              value === tab.id ? "text-slate-950" : "text-slate-400 hover:text-slate-700",
            )}
          >
            <Icon className="h-3.5 w-3.5" />
            {tab.label}
            {value === tab.id ? <motion.span layoutId="creator-inspector-tab" className="absolute inset-x-4 bottom-0 h-0.5 bg-slate-950" transition={{ type: "spring", stiffness: 650, damping: 44 }} /> : null}
          </button>
        );
      })}
    </div>
  );
}

function RenderResult({ url, title, onClose }: { url: string; title: string; onClose: () => void }) {
  return createPortal(
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[710] flex flex-col bg-[#f8f9fa] text-slate-950"
    >
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-slate-200 bg-white/90 px-4 backdrop-blur-xl sm:px-6">
        <div className="min-w-0 flex-1">
          <p className="text-[8px] font-bold uppercase tracking-[.16em] text-slate-400">Rendered locally</p>
          <h2 className="truncate text-[12px] font-semibold">{title}</h2>
        </div>
        <a href={url} download={`${title.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "clyra-video"}.mp4`} className="flex h-9 items-center gap-1.5 rounded-xl bg-blue-600 px-3.5 text-[9px] font-semibold text-white hover:bg-blue-700"><Download className="h-3.5 w-3.5" />Download MP4</a>
        <button type="button" onClick={onClose} aria-label="Close rendered video" className="grid h-9 w-9 place-items-center rounded-xl text-slate-500 hover:bg-slate-100 hover:text-slate-950"><X className="h-4 w-4" /></button>
      </header>
      <div className="grid min-h-0 flex-1 place-items-center p-4 sm:p-7">
        <video src={url} controls autoPlay className="max-h-[calc(100dvh-110px)] max-w-full rounded-2xl bg-black shadow-[0_24px_70px_rgba(15,23,42,.22)]" />
      </div>
    </motion.div>,
    document.body,
  );
}

function TemplateCreatorEditor({ initial }: { initial: WouldRatherProject | FakeTextProject }) {
  const { project, edit, replace, undo, redo, saveNow, saveState, canUndo, canRedo } = useCreatorDocument(initial);
  const [step, setStep] = useState<TemplateStep>("script");
  const [selectedId, setSelectedId] = useState(project.type === "would_rather" ? project.rounds[0]?.id || "" : project.messages[0]?.id || "");
  const [playing, setPlaying] = useState(false);
  const [visibleMessages, setVisibleMessages] = useState(project.type === "fake_text_story" ? project.messages.length : 0);
  const [messageWindowStart, setMessageWindowStart] = useState(0);
  const [previewRound, setPreviewRound] = useState(0);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [wouldRatherPhase, setWouldRatherPhase] = useState<WouldRatherPhase>("second");
  const [currentTime, setCurrentTime] = useState(0);
  const [renderProgress, setRenderProgress] = useState<number | null>(null);
  const [resultUrl, setResultUrl] = useState("");
  const [engine, setEngine] = useState("");
  const [error, setError] = useState("");
  const [aiBrief, setAiBrief] = useState("");
  const [showAiBrief, setShowAiBrief] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [messageDraft, setMessageDraft] = useState("");
  const [messageDraftSide, setMessageDraftSide] = useState<"left" | "right">("right");
  const playback = useRef<AbortController | null>(null);
  const previewFrame = useRef<number | null>(null);
  const renderTask = useRef<AbortController | null>(null);
  const importInput = useRef<HTMLInputElement | null>(null);
  const previewStage = useRef<HTMLDivElement | null>(null);
  const duration = creatorProjectDuration(project);
  const templateSteps: TemplateStep[] = project.type === "fake_text_story"
    ? ["script", "theme", "gameplay", "audio"]
    : ["script", "audio"];

  useEffect(() => {
    if (!playing || project.type !== "would_rather") return;
    const timer = window.setInterval(() => setCurrentTime((value) => Math.min(duration, value + 100)), 100);
    return () => window.clearInterval(timer);
  }, [duration, playing, project.type]);

  useEffect(() => {
    if (step !== "audio") return;
    const voices = project.type === "fake_text_story"
      ? project.participants.map((participant) => participant.voice)
      : [project.voice];
    void prefetchCreatorVoicePreviews(voices);
  }, [project, step]);

  useEffect(() => () => {
    playback.current?.abort();
    renderTask.current?.abort();
    if (resultUrl) URL.revokeObjectURL(resultUrl);
  }, [resultUrl]);

  const stopPreview = useCallback(() => {
    playback.current?.abort();
    playback.current = null;
    if (previewFrame.current !== null) window.cancelAnimationFrame(previewFrame.current);
    previewFrame.current = null;
    setPlaying(false);
    setCountdown(null);
    setWouldRatherPhase("second");
    setMessageWindowStart(0);
  }, []);

  const playPreview = async () => {
    if (playing) {
      stopPreview();
      return;
    }
    primeCreatorAudio();
    const controller = new AbortController();
    playback.current = controller;
    setCurrentTime(0);
    setPlaying(true);
    setError("");
    try {
      if (project.type === "would_rather") {
        const visualTimeline = creatorTimeline(project).filter((item) => item.track === "visual");
        for (let index = 0; index < project.rounds.length; index += 1) {
          const round = project.rounds[index]!;
          const roundStart = visualTimeline[index]?.startMs || 0;
          const trackSpeech = (start: number, end: number) => (progress: number) => {
            setCurrentTime(Math.min(duration, roundStart + start + (end - start) * progress));
          };
          setPreviewRound(index);
          setSelectedId(round.id);
          setRevealed(false);
          setCountdown(null);
          setWouldRatherPhase("prompt");
          setCurrentTime(roundStart);
          await waitForProgress(
            WOULD_RATHER_PHASE_CLOCK.promptEnd,
            controller.signal,
            trackSpeech(0, WOULD_RATHER_PHASE_CLOCK.promptEnd),
          );
          setWouldRatherPhase("first");
          await waitForProgress(
            WOULD_RATHER_PHASE_CLOCK.firstEntranceEnd - WOULD_RATHER_PHASE_CLOCK.promptEnd,
            controller.signal,
            trackSpeech(WOULD_RATHER_PHASE_CLOCK.promptEnd, WOULD_RATHER_PHASE_CLOCK.firstEntranceEnd),
          );
          const firstSpeech = await playCreatorSpeech(round.left, project.voice, controller.signal);
          setEngine(firstSpeech.engine);
          await waitForProgress(
            WOULD_RATHER_PHASE_CLOCK.firstHoldEnd - WOULD_RATHER_PHASE_CLOCK.firstSpeechEnd,
            controller.signal,
            trackSpeech(WOULD_RATHER_PHASE_CLOCK.firstSpeechEnd, WOULD_RATHER_PHASE_CLOCK.firstHoldEnd),
          );
          setWouldRatherPhase("or");
          const orSpeech = await playCreatorSpeech("Or", project.voice, controller.signal);
          setEngine(orSpeech.engine);
          await waitForProgress(
            WOULD_RATHER_PHASE_CLOCK.orEnd - WOULD_RATHER_PHASE_CLOCK.firstHoldEnd,
            controller.signal,
            trackSpeech(WOULD_RATHER_PHASE_CLOCK.firstHoldEnd, WOULD_RATHER_PHASE_CLOCK.orEnd),
          );
          setWouldRatherPhase("second");
          const secondSpeech = await playCreatorSpeech(round.right, project.voice, controller.signal);
          setEngine(secondSpeech.engine);
          await waitForProgress(
            WOULD_RATHER_PHASE_CLOCK.secondEntranceEnd - WOULD_RATHER_PHASE_CLOCK.orEnd,
            controller.signal,
            trackSpeech(WOULD_RATHER_PHASE_CLOCK.orEnd, WOULD_RATHER_PHASE_CLOCK.secondEntranceEnd),
          );
          await waitForProgress(
            WOULD_RATHER_PHASE_CLOCK.timerStart - WOULD_RATHER_PHASE_CLOCK.secondEntranceEnd,
            controller.signal,
            trackSpeech(WOULD_RATHER_PHASE_CLOCK.secondEntranceEnd, WOULD_RATHER_PHASE_CLOCK.timerStart),
          );
          setWouldRatherPhase("countdown");
          for (let value = round.timerSeconds; value >= 1; value -= 1) {
            const countdownStep = round.timerSeconds - value;
            const countdownStart = roundStart + WOULD_RATHER_PHASE_CLOCK.timerStart + countdownStep * 1_000;
            setCountdown(value);
            setCurrentTime(countdownStart);
            await playCreatorCue("tick", controller.signal);
            await waitForProgress(930, controller.signal, (progress) => {
              setCurrentTime(Math.min(duration, countdownStart + 70 + progress * 930));
            });
          }
          setCountdown(0);
          const countdownEnd = roundStart + WOULD_RATHER_PHASE_CLOCK.timerStart + round.timerSeconds * 1_000;
          setCurrentTime(countdownEnd);
          await waitForProgress(220, controller.signal, (progress) => {
            setCurrentTime(Math.min(duration, countdownEnd + progress * 220));
          });
          setWouldRatherPhase("reveal");
          setRevealed(true);
          await playCreatorCue("ding", controller.signal);
          const revealStart = countdownEnd + 220;
          const revealDuration = round.revealSeconds * 1_000;
          await waitForProgress(revealDuration, controller.signal, (progress) => {
            setCurrentTime(Math.min(duration, revealStart + progress * revealDuration));
          });
        }
      } else {
        // Visual state, scrubbing, and exported timing all resolve from this one
        // timeline. Voice playback is triggered from bubble entrance but never
        // controls the visual clock, avoiding the old network/TTS-driven drift.
        const timeline = buildIMessageTimeline(project.messages, project.playbackRate);
        const voiced = new Set<string>();
        await new Promise<void>((resolve, reject) => {
          const startedAt = performance.now();
          const abort = () => {
            if (previewFrame.current !== null) window.cancelAnimationFrame(previewFrame.current);
            previewFrame.current = null;
            reject(new DOMException("Preview stopped", "AbortError"));
          };
          controller.signal.addEventListener("abort", abort, { once: true });
          const step = (now: number) => {
            // buildIMessageTimeline already applies playbackRate to every
            // authored duration. Applying it again here made 1.25×/1.5×
            // previews finish too early while exports stayed on the correct
            // timeline. Keep the visual clock in the same milliseconds that
            // the renderer and scrubber consume.
            const elapsed = Math.min(timeline.durationMs, now - startedAt);
            const frame = getIMessageFrame(timeline, elapsed);
            setCurrentTime(elapsed);
            if (frame.activeMessageId) setSelectedId(frame.activeMessageId);
            const event = timeline.events.find((item) => item.bubbleStartMs <= elapsed && !voiced.has(item.id));
            if (event && !voiced.has(event.id)) {
              voiced.add(event.id);
              const message = project.messages[event.index]!;
              if (message.narration) {
                const voice = project.participants.find((participant) => participant.id === message.side)?.voice || "Ryan";
                void playCreatorSpeech(message.text, voice, controller.signal).then((speech) => setEngine(speech.engine)).catch((cause) => {
                  if (!(cause instanceof DOMException && cause.name === "AbortError")) setError(cause instanceof Error ? cause.message : String(cause));
                });
              }
            }
            if (elapsed >= timeline.durationMs) {
              previewFrame.current = null;
              controller.signal.removeEventListener("abort", abort);
              resolve();
              return;
            }
            previewFrame.current = window.requestAnimationFrame(step);
          };
          previewFrame.current = window.requestAnimationFrame(step);
        });
      }
      setCurrentTime(duration);
    } catch (cause) {
      if (!(cause instanceof DOMException && cause.name === "AbortError")) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (previewFrame.current !== null) window.cancelAnimationFrame(previewFrame.current);
      previewFrame.current = null;
      if (playback.current === controller) playback.current = null;
      setPlaying(false);
    }
  };

  const seekPreview = (value: number) => {
    stopPreview();
    setCurrentTime(value);
    const timeline = creatorTimeline(project).filter((item) => item.track === "visual");
    const active = [...timeline].reverse().find((item) => item.startMs <= value) || timeline[0];
    if (!active) return;
    if (project.type === "would_rather") {
      const index = Math.max(0, project.rounds.findIndex((round) => round.id === active.id));
      const round = project.rounds[index]!;
      const local = value - active.startMs;
      setPreviewRound(index);
      setSelectedId(round.id);
      const timerStart = WOULD_RATHER_LEAD_IN_MS;
      const timerElapsed = Math.max(0, local - timerStart);
      const remaining = round.timerSeconds - Math.floor(timerElapsed / 1_000);
      setWouldRatherPhase(
        local < WOULD_RATHER_PHASE_CLOCK.promptEnd ? "prompt"
          : local < WOULD_RATHER_PHASE_CLOCK.firstHoldEnd ? "first"
            : local < WOULD_RATHER_PHASE_CLOCK.orEnd ? "or"
              : local < timerStart ? "second"
                : local < timerStart + round.timerSeconds * 1_000 ? "countdown"
                  : "reveal",
      );
      setCountdown(local >= timerStart && remaining > 0 ? remaining : null);
      setRevealed(local >= timerStart + round.timerSeconds * 1_000);
    } else {
      const index = Math.max(0, project.messages.findIndex((message) => message.id === active.id));
      const message = project.messages[index]!;
      setSelectedId(message.id);
      // Keep 0 as a timeline-controlled typing frame while preserving the
      // rich all-message editor preview when no preview/scrub has occurred.
      setCurrentTime(Math.max(0.01, value));
    }
  };

  const generateScript = async () => {
    if (!aiBrief.trim() || generating) return;
    setGenerating(true);
    setError("");
    try {
      const response = await fetch("/api/creator/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: project.type, prompt: aiBrief.trim(), tone: "Conversational", count: project.type === "would_rather" ? Math.max(3, project.rounds.length) : Math.max(6, project.messages.length) }),
      });
      const payload = await response.json() as { data?: Record<string, unknown>; error?: string };
      if (!response.ok || !payload.data) throw new Error(payload.error || "The script could not be generated");
      const next = createGeneratedProject(project.type, payload.data);
      if (next.type === project.type) {
        if (next.type === "fake_text_story" && project.type === "fake_text_story") {
          next.participants.forEach((participant, index) => { participant.voice = project.participants[index].voice; });
          next.gameplay = project.gameplay;
          next.background = project.background;
        }
        if (next.type === "would_rather" && project.type === "would_rather") next.voice = project.voice;
        replace(next as typeof project);
        setSelectedId(next.type === "would_rather" ? next.rounds[0]?.id || "" : next.messages[0]?.id || "");
        setVisibleMessages(next.type === "fake_text_story" ? next.messages.length : 0);
        setMessageWindowStart(0);
      }
      setShowAiBrief(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setGenerating(false);
    }
  };

  const importScript = async (file?: File) => {
    if (!file) return;
    try {
      const raw = await file.text();
      if (file.name.toLowerCase().endsWith(".json")) {
        const next = migrateCreatorProject(JSON.parse(raw), project.type);
        if (next.type !== project.type) throw new Error("That project belongs to another creator");
        replace(next as typeof project);
        return;
      }
      const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      edit((draft) => {
        if (draft.type === "fake_text_story") draft.messages = lines.slice(0, 80).map((text, index) => ({ id: crypto.randomUUID(), side: index % 2 ? "right" : "left", text: text.replace(/^[^:]{1,30}:\s*/, ""), typingSeconds: Math.max(0.4, Math.min(4, text.length / 34)), pauseSeconds: 0.25, narration: true }));
        if (draft.type === "would_rather") draft.rounds = lines.slice(0, 30).map((line) => { const [left, right] = line.split(/\s+(?:or|\|)\s+/i); return { id: crypto.randomUUID(), question: "Would you rather...", left: left || "Option A", right: right || "Option B", leftPercent: 50, timerSeconds: 3, revealSeconds: 1.5 }; });
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const renderVideo = async () => {
    if (renderProgress !== null) return;
    stopPreview();
    const controller = new AbortController();
    renderTask.current = controller;
    setRenderProgress(0);
    setError("");
    try {
      const mp4 = project.type === "would_rather"
        ? await renderWouldRatherVideo({ rounds: project.rounds.map((round) => ({ ...round, topColor: project.style.topColor, bottomColor: project.style.bottomColor })), voice: project.voice, signal: controller.signal, onProgress: setRenderProgress })
        : await renderMessageStoryVideo({ name: project.participants[0].name, messages: project.messages, voices: { left: project.participants[0].voice, right: project.participants[1].voice }, background: project.background, backgroundVideo: project.gameplay?.src, theme: project.theme, layout: project.layout, playbackRate: project.playbackRate, showTypingIndicator: project.showTypingIndicator, signal: controller.signal, onProgress: setRenderProgress });
      if (resultUrl) URL.revokeObjectURL(resultUrl);
      setResultUrl(URL.createObjectURL(mp4));
    } catch (cause) {
      if (!(cause instanceof DOMException && cause.name === "AbortError")) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (renderTask.current === controller) renderTask.current = null;
      setRenderProgress(null);
    }
  };

  const addItem = () => edit((draft) => {
    if (draft.type === "fake_text_story") draft.messages.push({ id: crypto.randomUUID(), side: draft.messages.at(-1)?.side === "left" ? "right" : "left", text: "New message", typingSeconds: 0.8, pauseSeconds: 0.25, narration: true });
    else draft.rounds.push({ id: crypto.randomUUID(), question: "Would you rather...", left: "Option A", right: "Option B", leftPercent: 50, timerSeconds: 3, revealSeconds: 1.5 });
  });

  const submitMessageDraft = () => {
    const text = messageDraft.trim();
    if (!text || project.type !== "fake_text_story") return;
    const id = crypto.randomUUID();
    edit((draft) => {
      if (draft.type !== "fake_text_story") return;
      draft.messages.push({
        id,
        side: messageDraftSide,
        text: text.slice(0, 600),
        typingSeconds: Math.max(0.45, Math.min(4, text.length / 34)),
        pauseSeconds: 0.25,
        narration: true,
      });
    });
    setSelectedId(id);
    setVisibleMessages(project.messages.length + 1);
    setMessageDraft("");
  };

  const preview = project.type === "would_rather"
    ? <WouldRatherPreview project={project} round={project.rounds[Math.min(previewRound, project.rounds.length - 1)]!} phase={wouldRatherPhase} countdown={countdown} revealed={revealed} />
    : <MessagePreview project={project} visible={visibleMessages} windowStart={messageWindowStart} isPlaying={playing} playbackMs={currentTime} />;

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden bg-white text-[#111318]">
      <AnimatePresence>
        {generating ? (
          <LoadingScreen
            eyebrow="Clyra script"
            title={project.type === "fake_text_story" ? "Writing your message story" : "Writing your script"}
            stage="Shaping a paced, editable first draft"
          />
        ) : null}
      </AnimatePresence>
      <AnimatePresence>{renderProgress !== null ? <RenderOverlay progress={renderProgress} onCancel={() => renderTask.current?.abort()} /> : null}</AnimatePresence>
      <AnimatePresence>{resultUrl ? <RenderResult url={resultUrl} title={project.name} onClose={() => setResultUrl("")} /> : null}</AnimatePresence>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-8 sm:py-8 xl:px-12 xl:py-10">
        <div className="creator-template-layout mx-auto grid w-full max-w-[1540px] gap-6 xl:gap-9">
          <section className="min-w-0 rounded-[22px] border border-[#e2e5ea] bg-white px-5 py-5 shadow-[0_12px_38px_rgba(15,23,42,.045)] sm:px-8 sm:py-7 xl:h-[640px]">
            <div className="flex min-h-[66px] flex-wrap items-center gap-3 border-b border-[#e2e5ea] pb-4">
              <div className="min-w-0 flex-1"><h1 className="text-[clamp(22px,2vw,28px)] font-semibold tracking-0">{step === "gameplay" ? "Gameplay Video" : step === "theme" ? "Message Theme" : step === "audio" ? "Audio" : project.type === "fake_text_story" ? "Text Script" : "Questions"}</h1></div>
              {step === "script" ? (
                <>
                  <button type="button" onClick={() => importInput.current?.click()} className="h-[48px] min-w-[100px] rounded-full border border-[#e2e5ea] px-5 text-[15px] font-medium text-[#303642] transition-colors hover:bg-[#f6f8fc]">Import</button>
                  <button type="button" onClick={() => setShowAiBrief((value) => !value)} className="h-[48px] min-w-[112px] rounded-full bg-[#4169f6] px-5 text-[15px] font-medium text-white shadow-[0_8px_18px_rgba(65,105,246,.24)] transition-[transform,background-color] hover:bg-[#3158ea] active:scale-[.98]">AI Writer</button>
                  <input ref={importInput} type="file" accept=".json,.txt,.csv,text/plain,application/json" className="hidden" onChange={(event) => void importScript(event.target.files?.[0])} />
                </>
              ) : null}
            </div>

            <AnimatePresence>
              {step === "script" && showAiBrief ? <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden"><div className="mt-4 flex gap-2 border-b border-slate-200 pb-4"><input value={aiBrief} onChange={(event) => setAiBrief(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void generateScript(); }} placeholder={project.type === "fake_text_story" ? "A tense conversation with a clever twist" : "Funny choices for university students"} className="h-10 min-w-0 flex-1 rounded-xl border border-slate-200 px-3 text-[10px] outline-none focus:border-blue-300 focus:ring-2 focus:ring-blue-100" /><button type="button" disabled={!aiBrief.trim() || generating} onClick={() => void generateScript()} className="h-10 rounded-xl bg-blue-600 px-4 text-[9px] font-semibold text-white hover:bg-blue-700 disabled:opacity-40">{generating ? "Writing..." : "Generate"}</button></div></motion.div> : null}
            </AnimatePresence>

            {step === "script" ? (
              <div>
                {project.type === "fake_text_story" ? (
                  <>
                    <div className="flex min-h-[132px] items-center gap-4 border-b border-[#e2e5ea] py-5">
                      <span className="grid h-[62px] w-[62px] shrink-0 place-items-center rounded-full bg-[#aab1bf] text-[20px] font-light text-white">{(project.participants[0].name || "Unknown").slice(0, 1).toUpperCase()}</span>
                      <label className="min-w-0 flex-1 text-[16px] font-medium text-[#252a32]">Profile Name<input value={project.participants[0].name} onChange={(event) => edit((draft) => { if (draft.type === "fake_text_story") draft.participants[0].name = event.target.value.slice(0, 30); })} className="mt-2 h-[50px] w-full rounded-[11px] border border-[#dfe3e8] bg-white px-4 text-[17px] font-normal text-[#111318] shadow-[0_2px_6px_rgba(15,23,42,.035)] outline-none transition-shadow focus:border-[#4169f6] focus:ring-2 focus:ring-blue-100" /></label>
                    </div>
                    <div className="flex min-h-[76px] items-center justify-between border-b border-[#e2e5ea]"><p className="text-[21px] font-semibold">Messages</p><div className="flex gap-2.5"><button type="button" onClick={() => edit((draft) => { if (draft.type === "fake_text_story") draft.messages.forEach((message) => { message.side = message.side === "left" ? "right" : "left"; }); })} className="h-[38px] rounded-full border border-[#e0e4e9] px-4 text-[14px] font-medium text-[#303642] transition-colors hover:bg-[#f6f8fc]">Swap All <span className="ml-1.5 text-[17px]">⇄</span></button><button type="button" onClick={() => edit((draft) => { if (draft.type === "fake_text_story") draft.messages = [{ id: crypto.randomUUID(), side: "left", text: "New message", typingSeconds: 0.8, pauseSeconds: 0.25, narration: true }]; })} className="flex h-[38px] items-center gap-2 rounded-full border border-[#e0e4e9] px-4 text-[14px] font-medium text-[#303642] transition-colors hover:bg-[#f6f8fc]">Delete All <Trash2 className="h-4 w-4" /></button></div></div>
                    <div className="mt-4 max-h-[132px] space-y-3 overflow-y-auto pr-1 [scrollbar-width:thin] [scrollbar-color:#dfe3ea_transparent]">
                      {project.messages.map((message, index) => <div key={message.id} className="grid grid-cols-[minmax(0,1fr)_64px_44px] items-center gap-3"><div className="flex h-[48px] min-w-0 items-center rounded-[10px] border border-[#dfe3e8] bg-white px-4 shadow-[0_2px_6px_rgba(15,23,42,.035)] transition-[border-color,box-shadow] focus-within:border-[#4169f6] focus-within:ring-2 focus-within:ring-blue-100"><span className="mr-4 text-[19px] leading-none text-[#111318]">♫</span><input aria-label={`Message ${index + 1}`} value={message.text} onFocus={() => setSelectedId(message.id)} onChange={(event) => edit((draft) => { if (draft.type === "fake_text_story") draft.messages[index].text = event.target.value.slice(0, 600); })} className="min-w-0 flex-1 bg-transparent text-[16px] outline-none" /></div><MessageSpeakerToggle side={message.side} label={`Swap sender for message ${index + 1}`} onClick={() => edit((draft) => { if (draft.type === "fake_text_story") draft.messages[index].side = draft.messages[index].side === "left" ? "right" : "left"; })} /><button type="button" aria-label={`Delete message ${index + 1}`} disabled={project.messages.length <= 1} onClick={() => edit((draft) => { if (draft.type === "fake_text_story" && draft.messages.length > 1) draft.messages.splice(index, 1); })} className="grid h-11 w-11 place-items-center rounded-full bg-[#f3f4f6] text-[#68707c] transition-colors hover:bg-[#e8ebef] disabled:opacity-35"><Trash2 className="h-[18px] w-[18px]" /></button></div>)}
                    </div>
                    <div className="mt-3 grid grid-cols-[minmax(0,1fr)_64px_44px] items-center gap-3"><div className="flex h-[48px] min-w-0 items-center rounded-[10px] border border-[#dfe3e8] bg-white px-4 shadow-[0_2px_6px_rgba(15,23,42,.035)] focus-within:border-[#4169f6] focus-within:ring-2 focus-within:ring-blue-100"><ImagePlus className="mr-4 h-[19px] w-[19px] text-[#7b8492]" /><input value={messageDraft} onChange={(event) => setMessageDraft(event.target.value.slice(0, 600))} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); submitMessageDraft(); } }} placeholder="Type your message here..." aria-label="New message" className="min-w-0 flex-1 bg-transparent text-[16px] outline-none placeholder:text-[#8a909a]" /></div><MessageSpeakerToggle side={messageDraftSide} label="Swap sender for new message" onClick={() => setMessageDraftSide((side) => side === "left" ? "right" : "left")} /><button type="button" aria-label="Send message" disabled={!messageDraft.trim()} onClick={submitMessageDraft} className={cn("grid h-11 w-11 place-items-center rounded-full transition-[background-color,color,transform] active:scale-95", messageDraft.trim() ? "bg-[#4169f6] text-white" : "bg-[#f3f4f6] text-[#8a909a]")}><Send className="h-[18px] w-[18px]" /></button></div>
                  </>
                ) : (
                  <div className="max-h-[440px] space-y-3 overflow-y-auto py-5 pr-1 [scrollbar-width:thin] [scrollbar-color:#dfe3ea_transparent]">
                    {project.rounds.map((round, index) => <div key={round.id} onClick={() => { setSelectedId(round.id); setPreviewRound(index); setRevealed(false); }} className={cn("rounded-[16px] border bg-white p-4 transition-[border-color,box-shadow]", selectedId === round.id ? "border-[#4169f6] shadow-[0_0_0_2px_rgba(65,105,246,.08)]" : "border-[#e2e5ea] hover:border-[#cdd3dc]")}><div className="mb-3 flex items-center justify-between"><span className="text-[15px] font-semibold text-[#303642]">Choice {index + 1}</span><button type="button" aria-label={`Delete choice ${index + 1}`} disabled={project.rounds.length <= 1} onClick={() => edit((draft) => { if (draft.type === "would_rather" && draft.rounds.length > 1) draft.rounds.splice(index, 1); })} className="grid h-9 w-9 place-items-center rounded-full bg-[#f3f4f6] text-[#68707c] hover:bg-[#e8ebef] disabled:opacity-35"><Trash2 className="h-4 w-4" /></button></div><div className="grid gap-3 sm:grid-cols-2"><label className="text-[12px] font-medium text-[#68707c]">First option<input aria-label={`Question ${index + 1} option A`} value={round.left} onChange={(event) => edit((draft) => { if (draft.type === "would_rather") draft.rounds[index].left = event.target.value.slice(0, 120); })} className="mt-1.5 h-[48px] w-full rounded-[10px] border border-[#dfe3e8] bg-white px-4 text-[16px] text-[#111318] outline-none focus:border-[#4169f6] focus:ring-2 focus:ring-blue-100" /></label><label className="text-[12px] font-medium text-[#68707c]">Second option<input aria-label={`Question ${index + 1} option B`} value={round.right} onChange={(event) => edit((draft) => { if (draft.type === "would_rather") draft.rounds[index].right = event.target.value.slice(0, 120); })} className="mt-1.5 h-[48px] w-full rounded-[10px] border border-[#dfe3e8] bg-white px-4 text-[16px] text-[#111318] outline-none focus:border-[#4169f6] focus:ring-2 focus:ring-blue-100" /></label></div><div className="mt-3"><PercentScroller value={round.leftPercent} onChange={(leftPercent) => edit((draft) => { if (draft.type === "would_rather") draft.rounds[index].leftPercent = leftPercent; })} /></div></div>)}
                  </div>
                )}
                <button type="button" onClick={addItem} className="mt-4 flex h-[52px] w-full items-center justify-center gap-2 rounded-[18px] border border-[#e0e5ed] bg-[#f6f8fc] text-[17px] font-medium text-[#303642] transition-colors hover:bg-white"><Plus className="h-5 w-5" />Add {project.type === "fake_text_story" ? "Message" : "Question"}</button>
              </div>
            ) : step === "theme" && project.type === "fake_text_story" ? (
              <motion.div initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} className="py-5">
                <div className="grid gap-3 sm:grid-cols-2">
                  {([
                    { id: "ios_dark", label: "Dark", detail: "Charcoal header with familiar iMessage blue" },
                    { id: "ios_light", label: "Light", detail: "Soft grey surface and classic bubble colours" },
                  ] as const).map((theme) => (
                    <button
                      key={theme.id}
                      type="button"
                      onClick={() => edit((draft) => {
                        if (draft.type !== "fake_text_story") return;
                        draft.theme = theme.id;
                        draft.layout = "floating_phone";
                      })}
                      className={cn(
                        "min-h-[148px] rounded-[18px] border p-4 text-left transition-[border-color,background-color,box-shadow,transform] duration-150 hover:-translate-y-0.5",
                        project.theme === theme.id
                          ? "border-[#4169f6] bg-white shadow-[0_14px_35px_rgba(65,105,246,.12)]"
                          : "border-[#e2e5ea] bg-white text-slate-950 hover:border-[#cdd3dc]",
                      )}
                    >
                      <ThemePreviewMock theme={theme.id} />
                      <span className="block text-[12px] font-semibold text-slate-950">{theme.label}</span>
                      <span className="mt-1.5 block text-[8px] leading-4 text-slate-400">{theme.detail}</span>
                    </button>
                  ))}
                </div>
                <div className="mt-4 flex items-center justify-between rounded-[16px] border border-[#e2e5ea] bg-white p-4">
                  <div className="min-w-0 pr-4">
                    <p className="text-[14px] font-semibold text-slate-950">Typing indicator</p>
                    <p className="mt-0.5 text-[12px] leading-relaxed text-slate-400">Show the "•••" beat before each bubble commits. Turn off for messages to appear instantly.</p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={project.showTypingIndicator}
                    aria-label="Toggle typing indicator"
                    onClick={() => edit((draft) => { if (draft.type === "fake_text_story") draft.showTypingIndicator = !draft.showTypingIndicator; })}
                    className={cn(
                      "relative h-[26px] w-[44px] shrink-0 rounded-full transition-colors duration-200",
                      project.showTypingIndicator ? "bg-[#34c759]" : "bg-[#e2e5ea]",
                    )}
                  >
                    <span
                      className={cn(
                        "absolute top-[2px] h-[22px] w-[22px] rounded-full bg-white shadow-[0_1px_3px_rgba(15,23,42,.25)] transition-transform duration-200",
                        project.showTypingIndicator ? "translate-x-[20px]" : "translate-x-[2px]",
                      )}
                    />
                  </button>
                </div>
              </motion.div>
            ) : step === "gameplay" && project.type === "fake_text_story" ? (
              <GameplayPicker
                selected={project.gameplay?.clipId}
                onSelect={(clip) => edit((draft) => {
                  if (draft.type !== "fake_text_story") return;
                  draft.gameplay = {
                    clipId: clip.id,
                    category: clip.category,
                    src: clip.src,
                    poster: clip.poster,
                    durationSeconds: clip.durationSeconds,
                    sourceUrl: clip.sourceUrl,
                  };
                  draft.layout = "floating_phone";
                })}
              />
            ) : (
              <motion.div initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} className="py-5">
                <div className={cn("grid gap-4", project.type === "fake_text_story" && "md:grid-cols-2")}>
                  {project.type === "fake_text_story" ? project.participants.map((participant, index) => (
                    <VoicePicker
                      key={participant.id}
                      label={index === 0 ? "Grey incoming voice" : "Blue outgoing voice"}
                      value={participant.voice}
                      onChange={(voice) => edit((draft) => { if (draft.type === "fake_text_story") draft.participants[index].voice = voice; })}
                      onPreview={(voice) => void playCreatorVoicePreview(voice).then((speech) => setEngine(speech.engine)).catch((cause) => setError(String(cause)))}
                    />
                  )) : (
                    <VoicePicker
                      label="Narration voice"
                      value={project.voice}
                      onChange={(voice) => edit((draft) => { if (draft.type === "would_rather") draft.voice = voice; })}
                      onPreview={(voice) => void playCreatorVoicePreview(voice).then((speech) => setEngine(speech.engine)).catch((cause) => setError(String(cause)))}
                    />
                  )}
                </div>
                <p className="mt-5 text-[8px] text-slate-400">{engine ? `Active engine: ${engine}` : "Voice previews and final narration use the existing local Clyra TTS worker."}</p>
              </motion.div>
            )}
          </section>

          <aside className="rounded-[22px] border border-[#e2e5ea] bg-white px-6 py-7 shadow-[0_12px_38px_rgba(15,23,42,.045)] sm:px-8 xl:h-[640px]">
            <div className="min-h-[66px] border-b border-[#e2e5ea]"><h2 className="text-[clamp(22px,2vw,28px)] font-semibold tracking-0">Video Preview</h2></div>
            <div className="mt-6 grid place-items-center">
              <div ref={previewStage} className="creator-preview-stage relative aspect-[9/16] w-[min(100%,264px)] overflow-hidden rounded-[15px] bg-[#2a7659] shadow-[0_18px_44px_rgba(15,23,42,.18)]">
                {preview}
                <div className="absolute inset-x-0 bottom-0 z-40 bg-gradient-to-t from-black/70 via-black/20 to-transparent px-3 pb-3 pt-12 text-white">
                  <div className="flex items-center gap-2.5">
                    <button type="button" onClick={() => void playPreview()} aria-label={playing ? "Pause preview" : "Play preview"} className="grid h-7 w-7 shrink-0 place-items-center rounded-full transition-colors hover:bg-white/15">{playing ? <Pause className="h-4 w-4 fill-current" /> : <Play className="h-4 w-4 fill-current" />}</button>
                    <Volume2 className="h-4 w-4 shrink-0" />
                    <span className="text-[11px] font-medium tabular-nums">{formatTime(currentTime)} / {formatTime(duration)}</span>
                    <button type="button" aria-label="Full screen preview" onClick={() => { const stage = previewStage.current; if (!stage) return; if (document.fullscreenElement === stage) void document.exitFullscreen(); else void stage.requestFullscreen?.(); }} className="ml-auto grid h-7 w-7 place-items-center rounded-full transition-colors hover:bg-white/15"><Maximize2 className="h-4 w-4" /></button>
                  </div>
                  <input aria-label="Video time scrubber" type="range" min="0" max={Math.max(1, duration)} value={Math.min(currentTime, duration)} onChange={(event) => seekPreview(Number(event.target.value))} className="mt-2 h-1 w-full cursor-pointer accent-white" />
                </div>
              </div>
            </div>
          </aside>
        </div>
      </div>

      <footer className="shrink-0 bg-white px-4 pb-4 pt-2 sm:px-8 xl:px-12">
        <div className="mx-auto flex min-h-[104px] max-w-[1540px] items-center gap-2 rounded-[22px] border border-[#e2e5ea] bg-white px-5 shadow-[0_12px_38px_rgba(15,23,42,.05)] sm:px-7">
          {templateSteps.map((item, index) => {
            const StepIcon = item === "script" ? MessageCircle : item === "theme" ? Palette : item === "gameplay" ? Video : Volume2;
            return <div key={item} className="flex items-center"><button type="button" onClick={() => setStep(item)} className={cn("flex h-12 items-center gap-3 rounded-2xl px-3 text-[15px] font-medium capitalize transition-colors", step === item ? "text-[#111318]" : "text-[#68707c] hover:bg-[#f6f8fc] hover:text-[#303642]")}><span className={cn("grid h-10 w-10 place-items-center rounded-full", step === item ? "bg-[#4169f6] text-white" : "bg-[#edf2ff] text-[#4169f6]")}><StepIcon className="h-[19px] w-[19px]" /></span>{item === "gameplay" ? "Gameplay Video" : item}</button>{index < templateSteps.length - 1 ? <span className="px-1 text-[22px] font-light text-[#a1a8b3]">›</span> : null}</div>;
          })}
          <button
            type="button"
            onClick={() => {
              const index = templateSteps.indexOf(step);
              if (index >= templateSteps.length - 1) void renderVideo();
              else setStep(templateSteps[index + 1]!);
            }}
            className="ml-auto flex h-[58px] min-w-[145px] items-center justify-center gap-3 rounded-full bg-[#4169f6] px-7 text-[18px] font-medium text-white shadow-[0_10px_22px_rgba(65,105,246,.25)] transition-[transform,background-color] hover:bg-[#3158ea] active:scale-[.98]"
          >
            {templateSteps.indexOf(step) >= templateSteps.length - 1 ? "Render video" : "Continue"}
            {templateSteps.indexOf(step) >= templateSteps.length - 1 ? <Download className="h-5 w-5" /> : <ArrowDown className="h-5 w-5 -rotate-90" />}
          </button>
        </div>
      </footer>
      {error ? <div className="absolute bottom-16 left-1/2 z-20 max-w-[90%] -translate-x-1/2 rounded-md border border-red-200 bg-white px-3 py-2 text-[9px] font-medium text-red-600 shadow-lg">{error}</div> : null}
    </div>
  );
}

function CreatorEditor({ initial }: { initial: CreatorProject }) {
  const {
    project,
    edit,
    replace,
    undo,
    redo,
    saveNow,
    saveState,
    canUndo,
    canRedo,
  } = useCreatorDocument(initial);
  const [selectedId, setSelectedId] = useState(() => project.type === "would_rather" ? project.rounds[0]?.id || "" : project.type === "fake_text_story" ? project.messages[0]?.id || "" : project.id);
  const [messageWindowStart, setMessageWindowStart] = useState(0);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("style");
  const [messagePanel, setMessagePanel] = useState<"messages" | "participants">("messages");
  const [playing, setPlaying] = useState(false);
  const [visibleMessages, setVisibleMessages] = useState(project.type === "fake_text_story" ? project.messages.length : 0);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [wouldRatherPhase, setWouldRatherPhase] = useState<WouldRatherPhase>("second");
  const [previewRound, setPreviewRound] = useState(0);
  const [engine, setEngine] = useState("");
  const [error, setError] = useState("");
  const [renderProgress, setRenderProgress] = useState<number | null>(null);
  const playback = useRef<AbortController | null>(null);
  const renderTask = useRef<AbortController | null>(null);
  const importInput = useRef<HTMLInputElement | null>(null);

  const activeRoundIndex = project.type === "would_rather"
    ? Math.max(0, project.rounds.findIndex((round) => round.id === selectedId))
    : 0;
  const activeRound = project.type === "would_rather"
    ? project.rounds[activeRoundIndex] || project.rounds[0]
    : null;
  const activeMessageIndex = project.type === "fake_text_story"
    ? Math.max(0, project.messages.findIndex((message) => message.id === selectedId))
    : 0;
  const activeMessage = project.type === "fake_text_story"
    ? project.messages[activeMessageIndex] || project.messages[0]
    : null;

  const stopPreview = useCallback(() => {
    playback.current?.abort();
    playback.current = null;
    setPlaying(false);
    setCountdown(null);
    setWouldRatherPhase("second");
    setMessageWindowStart(0);
  }, []);

  const resetPreview = useCallback(() => {
    stopPreview();
    setRevealed(false);
    setPreviewRound(0);
    if (project.type === "fake_text_story") setVisibleMessages(project.messages.length);
  }, [project, stopPreview]);

  useEffect(() => () => {
    playback.current?.abort();
    renderTask.current?.abort();
  }, []);

  const previewVoice = async (voice: CreatorVoice) => {
    setError("");
    try {
      const speech = await playCreatorVoicePreview(voice);
      setEngine(speech.engine);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const playPreview = useCallback(async () => {
    if (playing) {
      stopPreview();
      return;
    }
    primeCreatorAudio();
    const controller = new AbortController();
    playback.current = controller;
    setPlaying(true);
    setError("");
    setRevealed(false);
    try {
      if (project.type === "would_rather") {
        for (let index = 0; index < project.rounds.length; index += 1) {
          const round = project.rounds[index];
          setPreviewRound(index);
          setSelectedId(round.id);
          setRevealed(false);
          setCountdown(null);
          setWouldRatherPhase("prompt");
          await waitFor(WOULD_RATHER_PHASE_CLOCK.promptEnd, controller.signal);
          setWouldRatherPhase("first");
          await waitFor(WOULD_RATHER_PHASE_CLOCK.firstEntranceEnd - WOULD_RATHER_PHASE_CLOCK.promptEnd, controller.signal);
          const firstSpeech = await playCreatorSpeech(round.left, project.voice, controller.signal);
          setEngine(firstSpeech.engine);
          await waitFor(WOULD_RATHER_PHASE_CLOCK.firstHoldEnd - WOULD_RATHER_PHASE_CLOCK.firstSpeechEnd, controller.signal);
          setWouldRatherPhase("or");
          const orSpeech = await playCreatorSpeech("Or", project.voice, controller.signal);
          setEngine(orSpeech.engine);
          await waitFor(WOULD_RATHER_PHASE_CLOCK.orEnd - WOULD_RATHER_PHASE_CLOCK.firstHoldEnd, controller.signal);
          setWouldRatherPhase("second");
          const secondSpeech = await playCreatorSpeech(round.right, project.voice, controller.signal);
          setEngine(secondSpeech.engine);
          await waitFor(WOULD_RATHER_PHASE_CLOCK.secondEntranceEnd - WOULD_RATHER_PHASE_CLOCK.orEnd, controller.signal);
          await waitFor(WOULD_RATHER_PHASE_CLOCK.timerStart - WOULD_RATHER_PHASE_CLOCK.secondEntranceEnd, controller.signal);
          setWouldRatherPhase("countdown");
          for (let value = round.timerSeconds; value >= 1; value -= 1) {
            setCountdown(value);
            await playCreatorCue("tick", controller.signal);
            await waitFor(930, controller.signal);
          }
          setCountdown(0);
          await waitFor(220, controller.signal);
          setWouldRatherPhase("reveal");
          setRevealed(true);
          await playCreatorCue("ding", controller.signal);
          await waitFor(round.revealSeconds * 1_000, controller.signal);
        }
      } else if (project.type === "fake_text_story") {
        setVisibleMessages(0);
        setMessageWindowStart(0);
        for (let index = 0; index < project.messages.length; index += 1) {
          const message = project.messages[index];
          setSelectedId(message.id);
          if (index > 0 && index % 6 === 0) setMessageWindowStart(index);
          setVisibleMessages(index + 1);
          if (message.narration) {
            const voice = project.participants.find((participant) => participant.id === message.side)?.voice || "Ryan";
            const speech = await playCreatorSpeech(message.text, voice, controller.signal);
            setEngine(speech.engine);
          }
          await waitFor(message.pauseSeconds * 1_000 / project.playbackRate, controller.signal);
        }
      } else {
        const speech = await playCreatorSpeech(`${project.title}. ${project.body}`, project.voice, controller.signal);
        setEngine(speech.engine);
      }
    } catch (cause) {
      if (!(cause instanceof DOMException && cause.name === "AbortError")) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (playback.current === controller) playback.current = null;
      setPlaying(false);
    }
  }, [playing, project, stopPreview]);

  const renderVideo = async () => {
    if (renderProgress !== null) return;
    stopPreview();
    const controller = new AbortController();
    renderTask.current = controller;
    setError("");
    setRenderProgress(0);
    try {
      if (project.type === "would_rather") {
        await renderWouldRatherVideo({
          rounds: project.rounds.map((round) => ({
            ...round,
            topColor: project.style.topColor,
            bottomColor: project.style.bottomColor,
          })),
          voice: project.voice,
          signal: controller.signal,
          onProgress: setRenderProgress,
        });
      } else if (project.type === "fake_text_story") {
        await renderMessageStoryVideo({
          name: project.participants[0].name,
          messages: project.messages,
          voices: {
            left: project.participants[0].voice,
            right: project.participants[1].voice,
          },
          background: project.background,
          backgroundVideo: project.gameplay?.src,
          theme: project.theme,
          layout: project.layout,
          showTypingIndicator: project.showTypingIndicator,
          signal: controller.signal,
          onProgress: setRenderProgress,
        });
      } else {
        await renderStoryVideo({
          title: project.title,
          body: project.body,
          voice: project.voice,
          signal: controller.signal,
          onProgress: setRenderProgress,
        });
      }
    } catch (cause) {
      if (!(cause instanceof DOMException && cause.name === "AbortError")) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (renderTask.current === controller) renderTask.current = null;
      setRenderProgress(null);
    }
  };

  const cancelRender = () => {
    renderTask.current?.abort();
    renderTask.current = null;
    setRenderProgress(null);
  };

  const duplicateSelected = useCallback(() => {
    edit((draft) => {
      if (draft.type === "would_rather") {
        const index = draft.rounds.findIndex((round) => round.id === selectedId);
        if (index < 0) return;
        const copy = { ...draft.rounds[index], id: crypto.randomUUID() };
        draft.rounds.splice(index + 1, 0, copy);
        setSelectedId(copy.id);
      } else if (draft.type === "fake_text_story") {
        const index = draft.messages.findIndex((message) => message.id === selectedId);
        if (index < 0) return;
        const copy = { ...draft.messages[index], id: crypto.randomUUID() };
        draft.messages.splice(index + 1, 0, copy);
        setSelectedId(copy.id);
      }
    });
  }, [edit, selectedId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target?.matches("input, textarea, select, [contenteditable='true']");
      const command = event.metaKey || event.ctrlKey;
      if (command && event.key.toLowerCase() === "s") {
        event.preventDefault();
        saveNow();
      } else if (command && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
      } else if (command && event.key.toLowerCase() === "d" && !typing) {
        event.preventDefault();
        duplicateSelected();
      } else if (event.code === "Space" && !typing) {
        event.preventDefault();
        void playPreview();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [duplicateSelected, playPreview, redo, saveNow, undo]);

  const importProject = async (file?: File) => {
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      const next = migrateCreatorProject(parsed, project.type);
      if (next.type !== project.type) throw new Error("That project belongs to a different creator tool");
      replace(next as typeof project);
      setSelectedId(next.type === "would_rather" ? next.rounds[0]?.id || "" : next.type === "fake_text_story" ? next.messages[0]?.id || "" : next.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const moveItem = (direction: -1 | 1) => {
    edit((draft) => {
      const list = draft.type === "would_rather" ? draft.rounds : draft.type === "fake_text_story" ? draft.messages : null;
      if (!list) return;
      const index = list.findIndex((item) => item.id === selectedId);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= list.length) return;
      const [item] = list.splice(index, 1);
      list.splice(target, 0, item as never);
    });
  };

  const deleteSelected = () => {
    edit((draft) => {
      if (draft.type === "would_rather" && draft.rounds.length > 1) {
        const index = draft.rounds.findIndex((round) => round.id === selectedId);
        draft.rounds.splice(index, 1);
        setSelectedId(draft.rounds[Math.max(0, index - 1)]?.id || "");
      } else if (draft.type === "fake_text_story" && draft.messages.length > 1) {
        const index = draft.messages.findIndex((message) => message.id === selectedId);
        draft.messages.splice(index, 1);
        setSelectedId(draft.messages[Math.max(0, index - 1)]?.id || "");
      }
    });
  };

  const addItem = () => {
    edit((draft) => {
      if (draft.type === "would_rather") {
        const next: WouldRatherRound = {
          id: crypto.randomUUID(),
          question: "Would you rather...",
          left: "Option A",
          right: "Option B",
          leftPercent: 50,
          timerSeconds: 5,
          revealSeconds: 1.5,
        };
        draft.rounds.push(next);
        setSelectedId(next.id);
      } else if (draft.type === "fake_text_story") {
        const next: StoryMessage = {
          id: crypto.randomUUID(),
          side: draft.messages.at(-1)?.side === "left" ? "right" : "left",
          text: "New message",
          typingSeconds: 0.8,
          pauseSeconds: 0.25,
          narration: true,
        };
        draft.messages.push(next);
        setSelectedId(next.id);
      }
    });
  };

  const leftPanel = project.type === "would_rather" ? (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-slate-200 px-3">
        <div>
          <p className="text-[10px] font-semibold text-slate-900">Questions</p>
          <p className="text-[8px] text-slate-400">{project.rounds.length} scenes</p>
        </div>
        <IconButton label="Add question" onClick={addItem}><Plus className="h-3.5 w-3.5" /></IconButton>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {project.rounds.map((round, index) => (
          <button
            key={round.id}
            type="button"
            onClick={() => { setSelectedId(round.id); setPreviewRound(index); setRevealed(false); }}
            className={cn(
              "mb-1.5 w-full rounded-md border p-3 text-left transition-colors",
              selectedId === round.id ? "border-slate-400 bg-slate-50" : "border-transparent hover:border-slate-200 hover:bg-white",
            )}
          >
            <span className="text-[8px] font-bold uppercase tracking-[.1em] text-slate-400">Question {index + 1}</span>
            <span className="mt-1 block line-clamp-2 text-[10px] font-semibold leading-4 text-slate-800">{round.left} or {round.right}</span>
          </button>
        ))}
      </div>
      <div className="flex h-10 shrink-0 items-center justify-center gap-1 border-t border-slate-200">
        <IconButton label="Move up" onClick={() => moveItem(-1)}><ArrowUp className="h-3.5 w-3.5" /></IconButton>
        <IconButton label="Move down" onClick={() => moveItem(1)}><ArrowDown className="h-3.5 w-3.5" /></IconButton>
        <IconButton label="Duplicate" onClick={duplicateSelected}><Copy className="h-3.5 w-3.5" /></IconButton>
        <IconButton label="Delete" onClick={deleteSelected} disabled={project.rounds.length <= 1}><Trash2 className="h-3.5 w-3.5" /></IconButton>
      </div>
    </div>
  ) : project.type === "fake_text_story" ? (
    <div className="flex h-full min-h-0 flex-col">
      <div className="grid h-11 shrink-0 grid-cols-2 border-b border-slate-200 p-1">
        {(["messages", "participants"] as const).map((tab) => (
          <button key={tab} type="button" onClick={() => setMessagePanel(tab)} className={cn("rounded text-[9px] font-semibold capitalize", messagePanel === tab ? "bg-slate-100 text-slate-950" : "text-slate-400 hover:text-slate-700")}>{tab}</button>
        ))}
      </div>
      {messagePanel === "messages" ? (
        <>
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {project.messages.map((message, index) => (
              <button
                key={message.id}
                type="button"
                onClick={() => setSelectedId(message.id)}
                className={cn(
                  "mb-1.5 flex w-full items-start gap-2 rounded-md border p-2.5 text-left transition-colors",
                  selectedId === message.id ? "border-slate-400 bg-slate-50" : "border-transparent hover:border-slate-200",
                )}
              >
                <span className={cn("mt-0.5 h-2 w-2 shrink-0 rounded-full", message.side === "right" ? "bg-[#0a84ff]" : "bg-slate-500")} />
                <span className="min-w-0">
                  <span className="block text-[8px] font-bold uppercase tracking-[.08em] text-slate-400">{index + 1} · {project.participants.find((participant) => participant.id === message.side)?.name}</span>
                  <span className="mt-1 block line-clamp-2 text-[10px] font-medium leading-4 text-slate-700">{message.text}</span>
                </span>
              </button>
            ))}
          </div>
          <div className="flex h-10 shrink-0 items-center justify-center gap-1 border-t border-slate-200">
            <IconButton label="Add message" onClick={addItem}><Plus className="h-3.5 w-3.5" /></IconButton>
            <IconButton label="Move up" onClick={() => moveItem(-1)}><ArrowUp className="h-3.5 w-3.5" /></IconButton>
            <IconButton label="Move down" onClick={() => moveItem(1)}><ArrowDown className="h-3.5 w-3.5" /></IconButton>
            <IconButton label="Duplicate" onClick={duplicateSelected}><Copy className="h-3.5 w-3.5" /></IconButton>
            <IconButton label="Delete" onClick={deleteSelected} disabled={project.messages.length <= 1}><Trash2 className="h-3.5 w-3.5" /></IconButton>
          </div>
        </>
      ) : (
        <div className="space-y-5 overflow-y-auto p-4">
          {project.participants.map((participant, index) => (
            <div key={participant.id} className="border-b border-slate-200 pb-5 last:border-b-0">
              <p className="mb-3 text-[9px] font-bold uppercase tracking-[.1em] text-slate-400">{index === 0 ? "Contact" : "Sender"}</p>
              <Field label="Display name" value={participant.name} onChange={(name) => edit((draft) => { if (draft.type === "fake_text_story") draft.participants[index].name = name.slice(0, 30); })} />
            </div>
          ))}
        </div>
      )}
    </div>
  ) : (
    <div className="h-full overflow-y-auto p-4">
      <p className="text-[10px] font-semibold text-slate-900">Story script</p>
      <p className="mt-1 text-[8px] leading-4 text-slate-400">Keep the opening immediate and the spoken sentences concise.</p>
      <div className="mt-5 space-y-4">
        <Field label="Hook" value={project.title} onChange={(title) => edit((draft) => { if (draft.type === "story_video") draft.title = title; })} multiline />
        <Field label="Narration" value={project.body} onChange={(body) => edit((draft) => { if (draft.type === "story_video") draft.body = body; })} multiline />
      </div>
    </div>
  );

  const preview = project.type === "would_rather" && project.rounds.length ? (
    <WouldRatherPreview project={project} round={project.rounds[Math.min(previewRound, project.rounds.length - 1)]} phase={wouldRatherPhase} countdown={countdown} revealed={revealed} />
  ) : project.type === "fake_text_story" ? (
    <MessagePreview project={project} visible={visibleMessages} windowStart={messageWindowStart} isPlaying={playing} />
  ) : project.type === "story_video" ? (
    <StoryPreview project={project} />
  ) : null;

  const editorFields = project.type === "would_rather" && activeRound ? (
    <div className="space-y-4">
      <Field label="Question" value={activeRound.question} onChange={(question) => edit((draft) => { if (draft.type === "would_rather") draft.rounds[activeRoundIndex].question = question; })} />
      <Field label="Option A" value={activeRound.left} onChange={(left) => edit((draft) => { if (draft.type === "would_rather") draft.rounds[activeRoundIndex].left = left; })} multiline />
      <Field label="Option B" value={activeRound.right} onChange={(right) => edit((draft) => { if (draft.type === "would_rather") draft.rounds[activeRoundIndex].right = right; })} multiline />
      <PercentScroller
        value={activeRound.leftPercent}
        onChange={(leftPercent) => edit((draft) => { if (draft.type === "would_rather") draft.rounds[activeRoundIndex].leftPercent = leftPercent; })}
        leftLabel="Option A"
        rightLabel="Option B"
      />
    </div>
  ) : project.type === "fake_text_story" && activeMessage ? (
    <div className="space-y-4">
      <Segmented
        label="Sender"
        value={activeMessage.side}
        options={project.participants.map((participant) => ({ value: participant.id, label: participant.name || participant.id }))}
        onChange={(side) => edit((draft) => { if (draft.type === "fake_text_story") draft.messages[activeMessageIndex].side = side; })}
      />
      <Field label="Message" value={activeMessage.text} onChange={(text) => edit((draft) => { if (draft.type === "fake_text_story") draft.messages[activeMessageIndex].text = text; })} multiline />
    </div>
  ) : null;

  const inspector = inspectorTab === "style" ? (
    <div className="space-y-5">
      {project.type === "would_rather" ? (
        <>
          <div className="grid grid-cols-2 gap-3">
            {[
              { label: "Option A", key: "topColor" as const },
              { label: "Option B", key: "bottomColor" as const },
            ].map((setting) => (
              <label key={setting.key} className="text-[9px] font-semibold text-slate-500">
                {setting.label}
                <span className="mt-1.5 flex h-9 items-center gap-2 rounded-md border border-slate-200 bg-white px-2">
                  <input type="color" value={project.style[setting.key]} onChange={(event) => edit((draft) => { if (draft.type === "would_rather") draft.style[setting.key] = event.target.value; })} className="h-5 w-5 cursor-pointer border-0 bg-transparent p-0" />
                  <span className="text-[8px] uppercase text-slate-400">{project.style[setting.key]}</span>
                </span>
              </label>
            ))}
          </div>
          <Segmented label="Entrance" value={project.style.optionAnimation} options={[{ value: "scale", label: "Scale" }, { value: "slide", label: "Slide" }, { value: "fade", label: "Fade" }]} onChange={(value) => edit((draft) => { if (draft.type === "would_rather") draft.style.optionAnimation = value; })} />
          <label className="block text-[9px] font-semibold text-slate-500">
            Text scale · {Math.round(project.style.fontScale * 100)}%
            <input type="range" min="0.75" max="1.2" step="0.05" value={project.style.fontScale} onChange={(event) => edit((draft) => { if (draft.type === "would_rather") draft.style.fontScale = Number(event.target.value); })} className="mt-2 w-full accent-slate-950" />
          </label>
          <div className="space-y-2">
            <p className="text-[9px] font-semibold text-slate-500">Scene images</p>
            {(["leftImage", "rightImage"] as const).map((key, index) => (
              <label key={key} className="flex h-9 cursor-pointer items-center gap-2 rounded-md border border-dashed border-slate-300 px-2 text-[9px] font-semibold text-slate-500 hover:border-slate-500">
                <ImagePlus className="h-3.5 w-3.5" />
                {project.rounds[activeRoundIndex]?.[key] ? `Replace option ${index ? "B" : "A"} image` : `Add option ${index ? "B" : "A"} image`}
                <input type="file" accept="image/*" className="hidden" onChange={(event) => { const file = event.target.files?.[0]; if (file) void fileToDataUrl(file).then((source) => edit((draft) => { if (draft.type === "would_rather") draft.rounds[activeRoundIndex][key] = source; })); }} />
              </label>
            ))}
          </div>
        </>
      ) : project.type === "fake_text_story" ? (
        <>
          <Segmented
            label="Theme"
            value={project.theme}
            options={[{ value: "ios_dark", label: "Dark" }, { value: "ios_light", label: "Light" }]}
            onChange={(theme) => edit((draft) => {
              if (draft.type !== "fake_text_story") return;
              draft.theme = theme;
              draft.layout = "floating_phone";
            })}
          />
          <label className="flex h-10 cursor-pointer items-center gap-2 rounded-md border border-dashed border-slate-300 px-3 text-[9px] font-semibold text-slate-500 hover:border-slate-500">
            <Upload className="h-3.5 w-3.5" />
            {project.background ? "Replace background" : "Upload background"}
            <input type="file" accept="image/*" className="hidden" onChange={(event) => { const file = event.target.files?.[0]; if (file) void fileToDataUrl(file).then((background) => edit((draft) => { if (draft.type === "fake_text_story") { draft.background = background; draft.gameplay = undefined; } })); }} />
          </label>
        </>
      ) : (
        <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-[9px] leading-5 text-slate-500">The story template uses restrained type, safe-zone spacing, and a dark neutral stage optimised for spoken narrative.</div>
      )}
    </div>
  ) : inspectorTab === "timing" ? (
    <div className="space-y-5">
      {project.type === "would_rather" && activeRound ? (
        <>
          <label className="block text-[9px] font-semibold text-slate-500">Decision timer · {activeRound.timerSeconds}s<input type="range" min="2" max="10" value={activeRound.timerSeconds} onChange={(event) => edit((draft) => { if (draft.type === "would_rather") draft.rounds[activeRoundIndex].timerSeconds = Number(event.target.value); })} className="mt-2 w-full accent-slate-950" /></label>
          <label className="block text-[9px] font-semibold text-slate-500">Result hold · {activeRound.revealSeconds.toFixed(1)}s<input type="range" min="0.8" max="3" step="0.1" value={activeRound.revealSeconds} onChange={(event) => edit((draft) => { if (draft.type === "would_rather") draft.rounds[activeRoundIndex].revealSeconds = Number(event.target.value); })} className="mt-2 w-full accent-slate-950" /></label>
        </>
      ) : project.type === "fake_text_story" && activeMessage ? (
        <>
          <label className="block text-[9px] font-semibold text-slate-500">Pause after TTS · {activeMessage.pauseSeconds.toFixed(1)}s<input type="range" min="0.1" max="3" step="0.1" value={activeMessage.pauseSeconds} onChange={(event) => edit((draft) => { if (draft.type === "fake_text_story") draft.messages[activeMessageIndex].pauseSeconds = Number(event.target.value); })} className="mt-2 w-full accent-slate-950" /></label>
          <label className="block text-[9px] font-semibold text-slate-500">Playback speed · {project.playbackRate.toFixed(1)}x<input type="range" min="0.6" max="1.8" step="0.1" value={project.playbackRate} onChange={(event) => edit((draft) => { if (draft.type === "fake_text_story") draft.playbackRate = Number(event.target.value); })} className="mt-2 w-full accent-slate-950" /></label>
        </>
      ) : (
        <p className="text-[9px] leading-5 text-slate-500">Story timing follows the generated narration so speech is never clipped.</p>
      )}
    </div>
  ) : (
    <div className="space-y-5">
      {project.type === "fake_text_story" ? project.participants.map((participant, index) => (
        <VoicePicker
          key={participant.id}
          label={index === 0 ? "Grey incoming voice" : "Blue outgoing voice"}
          value={participant.voice}
          onChange={(voice) => edit((draft) => { if (draft.type === "fake_text_story") draft.participants[index].voice = voice; })}
          onPreview={(voice) => void previewVoice(voice)}
        />
      )) : (
        <VoicePicker label="Narration voice" value={project.voice} onChange={(voice) => edit((draft) => { if (draft.type === "would_rather" || draft.type === "story_video") draft.voice = voice; })} onPreview={(voice) => void previewVoice(voice)} />
      )}
      {project.type === "fake_text_story" && activeMessage ? (
        <label className="flex items-center justify-between rounded-md border border-slate-200 px-3 py-2.5 text-[9px] font-semibold text-slate-600">
          Narrate this message
          <input type="checkbox" checked={activeMessage.narration} onChange={(event) => edit((draft) => { if (draft.type === "fake_text_story") draft.messages[activeMessageIndex].narration = event.target.checked; })} className="accent-slate-950" />
        </label>
      ) : null}
      <div className={cn("rounded-md border px-3 py-2 text-[8px] leading-4", error ? "border-red-200 bg-red-50 text-red-600" : "border-slate-200 bg-slate-50 text-slate-500")}>
        {error || (engine ? `Narration engine: ${engine}` : "Voices are generated locally. The first preview may take longer while the model warms up.")}
      </div>
    </div>
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#f6f7f9] text-slate-950">
      <AnimatePresence>{renderProgress !== null ? <RenderOverlay progress={renderProgress} onCancel={cancelRender} /> : null}</AnimatePresence>
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-slate-200 bg-white px-3">
        <input
          aria-label="Project name"
          value={project.name}
          onChange={(event) => edit((draft) => { draft.name = event.target.value.slice(0, 80); })}
          className="h-8 min-w-0 flex-1 bg-transparent px-2 text-[11px] font-semibold text-slate-900 outline-none sm:max-w-[240px]"
        />
        <span className="hidden items-center gap-1.5 text-[8px] font-semibold text-slate-400 sm:flex">
          {saveState === "saving" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3 text-emerald-500" />}
          {saveState === "saving" ? "Saving" : "Saved locally"}
        </span>
        <div className="ml-auto flex items-center gap-0.5">
          <IconButton label="Undo" onClick={undo} disabled={!canUndo}><Undo2 className="h-3.5 w-3.5" /></IconButton>
          <IconButton label="Redo" onClick={redo} disabled={!canRedo}><Redo2 className="h-3.5 w-3.5" /></IconButton>
          <IconButton label="Save project" onClick={saveNow}><Save className="h-3.5 w-3.5" /></IconButton>
          <IconButton label="Import project" onClick={() => importInput.current?.click()}><Upload className="h-3.5 w-3.5" /></IconButton>
          <IconButton label="Export project JSON" onClick={() => exportCreatorProject(project)}><FileJson className="h-3.5 w-3.5" /></IconButton>
          <input ref={importInput} type="file" accept="application/json,.json" className="hidden" onChange={(event) => void importProject(event.target.files?.[0])} />
          <button type="button" onClick={() => void renderVideo()} className="ml-1 flex h-8 items-center gap-1.5 rounded-md bg-slate-950 px-3 text-[9px] font-semibold text-white transition-transform active:scale-[.97]">
            <Download className="h-3.5 w-3.5" />
            Export MP4
          </button>
        </div>
      </header>

      <div className="creator-editor-layout grid min-h-0 flex-1">
        <aside className="flex min-h-0 border-r border-slate-200 bg-white">{leftPanel}</aside>
        <main className="flex min-h-0 flex-col bg-[#17191e]">
          <div className="min-h-0 flex-1 p-3 sm:p-5">
            <div className="creator-preview-canvas grid h-full min-h-[390px] place-items-center">
              <div className="creator-preview-stage relative aspect-[9/16] h-auto max-h-full w-auto max-w-full overflow-hidden rounded-[15px] bg-[#2a7659] shadow-[0_18px_44px_rgba(15,23,42,.18)]">
                {preview}
              </div>
            </div>
          </div>
          <div className="flex h-12 shrink-0 items-center justify-center gap-2 border-t border-white/10 bg-[#111318] px-3 text-white">
            <IconButton label="Reset preview" onClick={resetPreview}><RotateCcw className="h-3.5 w-3.5 text-white/70" /></IconButton>
            <button type="button" onClick={() => void playPreview()} className="flex h-8 min-w-[150px] items-center justify-center gap-2 rounded-md bg-white px-4 text-[9px] font-semibold text-slate-950 transition-transform active:scale-[.98]">
              {playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
              {playing ? "Stop preview" : "Play composition"}
            </button>
            <span className="hidden text-[8px] text-white/40 sm:block">{formatTime(creatorProjectDuration(project))}</span>
          </div>
        </main>
        <aside className="flex min-h-0 flex-col border-l border-slate-200 bg-white">
          <InspectorTabs value={inspectorTab} onChange={setInspectorTab} />
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            {editorFields ? <div className="mb-6 border-b border-slate-200 pb-6">{editorFields}</div> : null}
            {inspector}
          </div>
        </aside>
      </div>
      <Timeline project={project} selectedId={selectedId} onSelect={setSelectedId} />
      {error ? <div className="absolute bottom-[126px] left-1/2 z-20 -translate-x-1/2 rounded-md border border-red-200 bg-white px-3 py-2 text-[9px] font-medium text-red-600 shadow-lg">{error}</div> : null}
    </div>
  );
}

export default function CreatorStudioWorkspace({
  mode,
  onBack,
}: {
  mode: CreatorMode;
  onBack: () => void;
}) {
  const type = MODE_TO_TYPE[mode];
  const saved = useMemo(() => loadCreatorProject(type), [type]);
  const [project, setProject] = useState<CreatorProject | null>(() => type === "story_video" ? null : saved);
  void onBack;
  return (
    <div className="h-full min-h-0 overflow-hidden">
      {project ? (
        project.type === "would_rather" || project.type === "fake_text_story" ? (
          <TemplateCreatorEditor key={project.id} initial={project} />
        ) : (
          <CreatorEditor key={project.id} initial={project} />
        )
      ) : (
        <SetupWizard mode={mode} savedProject={saved} onReady={setProject} />
      )}
    </div>
  );
}
