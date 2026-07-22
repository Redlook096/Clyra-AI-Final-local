import {
  AlertCircle,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Download,
  FileVideo2,
  Filter,
  Grid2X2,
  Heart,
  Link2,
  List,
  Loader2,
  MessageSquare,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  Upload,
  Video,
  WandSparkles,
  X,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "../lib/utils";

interface Props {
  onClose: () => void;
  initialUrl?: string;
  embedded?: boolean;
  onEngaged?: () => void;
}

type WorkspaceView = "create" | "processing" | "results";
type SourceMode = "url" | "upload";
type ClipAspect = "9:16" | "1:1" | "16:9";
type CaptionPosition = "top" | "centre" | "bottom";
type CropFocus = "left" | "center" | "right";
type ResultLayout = "grid" | "list";
type SortMode = "score" | "duration" | "source";

type ClipSource = {
  mode: SourceMode;
  url: string;
  uploadId?: string;
  name?: string;
  size?: number;
};

type ClipResult = {
  id: string;
  rank: number;
  output: string;
  title: string;
  source_title?: string;
  source_start?: string;
  source_end?: string;
  clip_duration?: string;
  reason?: string;
  caption?: string;
  hashtags?: string;
  virality_score?: number;
  score?: number;
  file_size?: number;
  timing_source?: string;
  word_count?: number;
  output_quality?: string;
};

type ClipDraft = {
  source: ClipSource;
  objective: string;
  customObjective: string;
  clipLength: number;
  clipCount: number;
  aspect: ClipAspect;
  cropFocus: CropFocus;
  captionsEnabled: boolean;
  removeFillers: boolean;
  font: string;
  fontSize: number;
  colour: string;
  position: CaptionPosition;
};

const OBJECTIVES = [
  ["viral", "Best viral moments"],
  ["educational", "Educational insights"],
  ["funny", "Funny moments"],
  ["emotional", "Emotional moments"],
  ["opinions", "Strong opinions"],
  ["highlights", "Highlights"],
  ["custom", "Custom prompt"],
] as const;

const OBJECTIVE_DETAILS: Record<(typeof OBJECTIVES)[number][0], { icon: typeof Sparkles; detail: string; recommended?: boolean }> = {
  viral: { icon: Sparkles, detail: "Hooks, tension, payoff and retention.", recommended: true },
  educational: { icon: FileVideo2, detail: "Clear ideas that stand on their own." },
  funny: { icon: Heart, detail: "Surprises, reactions and clean punchlines." },
  emotional: { icon: Heart, detail: "Human, high-feeling moments with context." },
  opinions: { icon: MessageSquare, detail: "Strong takes worth discussing." },
  highlights: { icon: Play, detail: "The most complete moments from the source." },
  custom: { icon: WandSparkles, detail: "Give Clyra a specific direction." },
};

const PIPELINE = [
  ["captions", "Reading source"],
  ["analyze", "Finding moments"],
  ["clip", "Preparing clips"],
  ["transcribe", "Timing every word"],
  ["subtitles", "Styling captions"],
  ["render", "Encoding MP4 files"],
  ["complete", "Complete"],
] as const;

const DEFAULT_DRAFT: ClipDraft = {
  source: { mode: "url", url: "" },
  objective: "viral",
  customObjective: "",
  clipLength: 30,
  clipCount: 3,
  aspect: "9:16",
  cropFocus: "center",
  captionsEnabled: true,
  removeFillers: true,
  font: "Impact",
  fontSize: 74,
  colour: "#FFFFFF",
  position: "bottom",
};

const DRAFT_KEY = "clyra.clip.draft.v2";
const RESULT_KEY = "clyra.clip.results.v2";

function loadDraft(initialUrl: string): ClipDraft {
  try {
    const saved = JSON.parse(localStorage.getItem(DRAFT_KEY) || "null") as Partial<ClipDraft> | null;
    const merged = saved ? { ...DEFAULT_DRAFT, ...saved, source: { ...DEFAULT_DRAFT.source, ...(saved.source || {}) } } : DEFAULT_DRAFT;
    if (initialUrl) merged.source = { mode: "url", url: initialUrl };
    return merged;
  } catch {
    return { ...DEFAULT_DRAFT, source: { ...DEFAULT_DRAFT.source, url: initialUrl } };
  }
}

function loadResults(): ClipResult[] {
  try {
    const value = JSON.parse(localStorage.getItem(RESULT_KEY) || "[]");
    return Array.isArray(value) ? value.slice(0, 24) : [];
  } catch {
    return [];
  }
}

function outputUrl(value?: string) {
  return value ? value.replace("./output/", "/output/") : "";
}

function fileSize(bytes?: number) {
  if (!bytes) return "MP4";
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function parseDuration(value?: string) {
  return Number(String(value || "").replace(/[^0-9.]/g, "")) || 0;
}

function youtubeEmbedUrl(value: string) {
  try {
    const url = new URL(value.trim());
    const id = url.hostname.includes("youtu.be")
      ? url.pathname.split("/").filter(Boolean)[0]
      : url.searchParams.get("v") || url.pathname.match(/\/(?:embed|shorts|live)\/([^/?#]+)/)?.[1];
    return id && /^[\w-]{6,}$/.test(id)
      ? `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}?rel=0`
      : null;
  } catch {
    return null;
  }
}

function uploadVideo(file: File, signal: AbortSignal, onProgress: (progress: number) => void) {
  return new Promise<{ uploadId: string; name: string; size: number }>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", `/api/clipper/upload?filename=${encodeURIComponent(file.name)}`);
    request.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    });
    request.addEventListener("load", () => {
      try {
        const payload = JSON.parse(request.responseText);
        if (request.status < 200 || request.status >= 300 || !payload.uploadId) {
          reject(new Error(payload.error || "Video upload failed"));
          return;
        }
        resolve(payload);
      } catch {
        reject(new Error("The upload server returned an invalid response"));
      }
    });
    request.addEventListener("error", () => reject(new Error("Video upload failed")));
    request.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")));
    signal.addEventListener("abort", () => request.abort(), { once: true });
    request.send(file);
  });
}

function Segment<T extends string | number>({
  value,
  current,
  onClick,
  children,
}: {
  value: T;
  current: T;
  onClick: (value: T) => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={() => onClick(value)}
      className={cn(
        "relative h-8 min-w-0 flex-1 rounded px-2 text-[9px] font-semibold transition-colors",
        value === current ? "text-slate-950" : "text-slate-400 hover:text-slate-700",
      )}
    >
      {value === current ? (
        <motion.span layoutId="clip-segment" className="absolute inset-0 rounded border border-slate-200 bg-white shadow-sm" transition={{ type: "spring", stiffness: 650, damping: 45 }} />
      ) : null}
      <span className="relative z-10">{children}</span>
    </button>
  );
}

function Toggle({
  label,
  detail,
  checked,
  onChange,
}: {
  label: string;
  detail: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button type="button" onClick={() => onChange(!checked)} className="flex w-full items-center justify-between gap-4 border-b border-slate-100 py-3 text-left last:border-b-0">
      <span>
        <span className="block text-[10px] font-semibold text-slate-800">{label}</span>
        <span className="mt-0.5 block text-[8px] leading-4 text-slate-400">{detail}</span>
      </span>
      <span className={cn("relative h-5 w-9 shrink-0 rounded-full transition-colors", checked ? "bg-slate-950" : "bg-slate-200")}>
        <motion.span animate={{ x: checked ? 17 : 2 }} transition={{ type: "spring", stiffness: 700, damping: 42 }} className="absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-sm" />
      </span>
    </button>
  );
}

function SourcePicker({
  source,
  onSource,
  onFile,
  uploading,
  uploadProgress,
}: {
  source: ClipSource;
  onSource: (source: ClipSource) => void;
  onFile: (file: File) => void;
  uploading: boolean;
  uploadProgress: number;
}) {
  const fileInput = useRef<HTMLInputElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const previewUrl = useMemo(() => source.mode === "url" ? youtubeEmbedUrl(source.url) : null, [source.mode, source.url]);
  const acceptFile = (file?: File) => {
    if (!file) return;
    if (!file.type.startsWith("video/") && !/\.(mp4|mov|m4v|webm|mkv)$/i.test(file.name)) return;
    onFile(file);
  };
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    acceptFile(event.dataTransfer.files?.[0]);
  };
  return (
    <div>
      <div className="grid grid-cols-2 rounded-[18px] border border-slate-200/80 bg-slate-100/70 p-1.5">
        {([
          { mode: "url" as const, label: "Video URL", icon: Link2 },
          { mode: "upload" as const, label: "Upload", icon: Upload },
        ]).map((option) => {
          const Icon = option.icon;
          return (
            <button key={option.mode} type="button" onClick={() => onSource({ ...source, mode: option.mode })} className={cn("flex h-10 items-center justify-center gap-2 rounded-[14px] text-[11px] font-semibold transition-[background-color,color,box-shadow,transform] duration-200 active:scale-[.985]", source.mode === option.mode ? "bg-white text-slate-950 shadow-sm ring-1 ring-slate-200" : "text-slate-400 hover:text-slate-700")}>
              <Icon className="h-3.5 w-3.5" />
              {option.label}
            </button>
          );
        })}
      </div>
      {source.mode === "url" ? (
        <>
          <label className="mt-4 block text-[10px] font-semibold text-slate-500">
            YouTube or public video URL
            <div className="mt-2 flex h-12 items-center rounded-[18px] border border-slate-200 bg-white px-4 shadow-[0_7px_24px_rgba(15,23,42,.04)] transition-[border-color,box-shadow] duration-200 focus-within:border-blue-200 focus-within:shadow-[0_10px_28px_rgba(37,99,235,.08)]">
              <Link2 className="h-4 w-4 shrink-0 text-slate-400" />
              <input value={source.url} onChange={(event) => onSource({ mode: "url", url: event.target.value })} placeholder="Paste a YouTube or public video link" className="h-full min-w-0 flex-1 bg-transparent px-3 text-[12px] font-medium outline-none placeholder:text-slate-400" />
              {source.url ? <button type="button" onClick={() => onSource({ mode: "url", url: "" })} aria-label="Clear URL"><X className="h-3.5 w-3.5 text-slate-400" /></button> : null}
            </div>
          </label>
          <AnimatePresence initial={false}>
            {previewUrl ? (
              <motion.div
                initial={{ opacity: 0, height: 0, y: -6 }}
                animate={{ opacity: 1, height: "auto", y: 0 }}
                exit={{ opacity: 0, height: 0, y: -6 }}
                transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
                className="clyra-clip-source-preview mt-4 overflow-hidden rounded-[18px] border border-slate-200 bg-slate-950 shadow-[0_10px_26px_rgba(15,23,42,.08)]"
              >
                <div className="clyra-clip-source-preview__frame">
                  <iframe title="Source video preview" src={previewUrl} className="h-full w-full border-0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; picture-in-picture" allowFullScreen />
                </div>
              </motion.div>
            ) : null}
          </AnimatePresence>
        </>
      ) : (
        <div
          onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={cn("mt-4 flex min-h-[170px] flex-col items-center justify-center rounded-[18px] border border-dashed px-5 text-center transition-colors", dragging ? "border-blue-300 bg-blue-50/60" : "border-slate-300 bg-white")}
        >
          {uploading ? (
            <>
              <Loader2 className="h-5 w-5 animate-spin text-slate-500" />
              <p className="mt-3 text-[10px] font-semibold text-slate-700">Uploading {Math.round(uploadProgress * 100)}%</p>
              <div className="mt-3 h-1 w-40 overflow-hidden rounded-full bg-slate-100"><div className="h-full bg-slate-950" style={{ width: `${uploadProgress * 100}%` }} /></div>
            </>
          ) : source.uploadId ? (
            <>
              <CheckCircle2 className="h-5 w-5 text-emerald-500" />
              <p className="mt-3 max-w-full truncate text-[10px] font-semibold text-slate-800">{source.name}</p>
              <p className="mt-1 text-[8px] text-slate-400">{fileSize(source.size)} · ready to analyse</p>
              <button type="button" onClick={() => fileInput.current?.click()} className="mt-3 text-[9px] font-semibold text-slate-500 hover:text-slate-950">Replace video</button>
            </>
          ) : (
            <>
              <FileVideo2 className="h-6 w-6 text-slate-400" />
              <p className="mt-3 text-[10px] font-semibold text-slate-800">Drop a video here</p>
              <p className="mt-1 text-[8px] text-slate-400">MP4, MOV, WebM or MKV up to 1.25 GB</p>
              <button type="button" onClick={() => fileInput.current?.click()} className="mt-3 h-9 rounded-full border border-slate-200 bg-white px-4 text-[10px] font-semibold text-slate-600 shadow-sm transition-colors hover:bg-slate-50">Choose video</button>
            </>
          )}
          <input ref={fileInput} type="file" accept="video/mp4,video/quicktime,video/webm,video/x-matroska,.m4v" className="hidden" onChange={(event) => acceptFile(event.target.files?.[0])} />
        </div>
      )}
    </div>
  );
}

function ProcessingScreen({
  progress,
  status,
  activeStep,
  readyCount,
  elapsed,
  onCancel,
}: {
  progress: number;
  status: string;
  activeStep: string;
  readyCount: number;
  elapsed: number;
  onCancel: () => void;
}) {
  return createPortal(
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[700] overflow-y-auto bg-slate-50/92 px-5 py-8 backdrop-blur-xl">
      <div className="mx-auto flex min-h-full w-full max-w-[760px] flex-col justify-center">
        <section className="rounded-[28px] border border-slate-200/90 bg-white p-6 shadow-[0_20px_54px_rgba(15,23,42,.08)] sm:p-8">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0] text-blue-600">AI Clip</p>
            <h2 className="mt-3 text-[clamp(28px,5vw,44px)] font-semibold tracking-[0] text-slate-950">Finding your strongest moments</h2>
            <p className="mt-2 text-[13px] text-slate-500">{status || "Preparing the source"}</p>
          </div>
          <button type="button" onClick={onCancel} className="grid h-10 w-10 place-items-center rounded-full border border-slate-200 bg-white text-slate-500 shadow-sm transition-colors hover:bg-slate-50" aria-label="Cancel processing"><X className="h-4 w-4" /></button>
        </div>
        <div className="relative mt-10 h-2 overflow-hidden rounded-full bg-slate-100 shadow-inner">
          <motion.div className="relative h-full overflow-hidden rounded-full bg-blue-600" animate={{ width: `${Math.max(2, progress)}%` }} transition={{ duration: 0.22 }}><motion.span className="absolute inset-y-0 w-24 bg-white/35 blur-sm" animate={{ x: [-100, 760] }} transition={{ repeat: Infinity, duration: 1.5, ease: "linear" }} /></motion.div>
        </div>
        <div className="mt-3 flex items-center justify-between text-[9px] font-semibold text-slate-400">
          <span>{readyCount ? `${readyCount} clip${readyCount === 1 ? "" : "s"} ready` : "Analysing source"}</span>
          <span className="tabular-nums">{progress}% · {elapsed}s</span>
        </div>
        <ol className="mt-9 grid gap-2 sm:grid-cols-2">
          {PIPELINE.slice(0, -1).map(([id, label]) => {
            const activeIndex = PIPELINE.findIndex(([step]) => step === activeStep);
            const index = PIPELINE.findIndex(([step]) => step === id);
            const complete = activeIndex > index || activeStep === "complete";
            const active = activeStep === id;
            return (
              <li key={id} className={cn("flex h-[52px] items-center gap-3 rounded-[16px] border px-4 transition-colors", active ? "border-blue-100 bg-blue-50/60 text-slate-900 shadow-[0_8px_24px_rgba(37,99,235,.07)]" : complete ? "border-emerald-100 bg-emerald-50/35 text-slate-500" : "border-transparent text-slate-400")}>
                <span className={cn("grid h-6 w-6 place-items-center rounded-full border", complete ? "border-emerald-200 bg-emerald-50 text-emerald-600" : active ? "border-slate-950 bg-slate-950 text-white" : "border-slate-200 bg-white")}>
                  {complete ? <Check className="h-3 w-3" /> : active ? <Loader2 className="h-3 w-3 animate-spin" /> : <span className="h-1.5 w-1.5 rounded-full bg-slate-300" />}
                </span>
                <span className={cn("text-[11px] font-semibold", active && "text-slate-900")}>{label}</span>
              </li>
            );
          })}
        </ol>
        </section>
      </div>
    </motion.div>,
    document.body,
  );
}

function ClipCard({
  result,
  selected,
  layout,
  liked,
  onSelect,
  onLike,
  onDelete,
}: {
  result: ClipResult;
  selected: boolean;
  layout: ResultLayout;
  liked: boolean;
  onSelect: () => void;
  onLike: () => void;
  onDelete: () => void;
}) {
  return (
    <article className={cn("group border bg-white transition-[border-color,box-shadow,transform] duration-200 hover:-translate-y-px hover:border-slate-300 hover:shadow-[0_10px_22px_rgba(15,23,42,.055)]", layout === "grid" ? "rounded-[16px]" : "grid grid-cols-[112px_minmax(0,1fr)_auto] items-center gap-4 rounded-[16px] p-2", selected ? "border-slate-900 shadow-sm" : "border-slate-200")}>
      <button type="button" onClick={onSelect} className={cn("relative overflow-hidden bg-slate-950", layout === "grid" ? "aspect-video w-full rounded-t-[5px]" : "aspect-[9/16] h-24 rounded")}>
        <video preload="metadata" muted playsInline src={outputUrl(result.output)} className="h-full w-full object-cover" />
        <span className="absolute left-2 top-2 rounded bg-black/72 px-1.5 py-1 text-[7px] font-bold text-white">#{result.rank}</span>
        <span className="absolute inset-0 grid place-items-center bg-black/0 transition-colors group-hover:bg-black/15"><span className="grid h-8 w-8 place-items-center rounded-full bg-white/90 text-slate-950 opacity-0 shadow-sm transition-opacity group-hover:opacity-100"><Play className="ml-0.5 h-3.5 w-3.5" /></span></span>
      </button>
      <div className={cn("min-w-0", layout === "grid" ? "p-3" : "")}>
        <div className="flex items-center justify-between gap-3">
          <span className="text-[9px] font-bold text-emerald-600">{result.score ?? Math.round((result.virality_score || 0) * 10)}/100</span>
          <span className="text-[8px] text-slate-400">{result.clip_duration}</span>
        </div>
        <h3 className="mt-1.5 line-clamp-2 text-[11px] font-semibold leading-4 text-slate-900">{result.title}</h3>
        <p className="mt-1 line-clamp-2 text-[8px] leading-4 text-slate-400">{result.reason}</p>
        <div className="mt-3 flex items-center gap-1">
          <button type="button" onClick={onLike} aria-label={liked ? "Unlike clip" : "Like clip"} className={cn("grid h-7 w-7 place-items-center rounded text-slate-400 hover:bg-slate-100", liked && "text-rose-500")}><Heart className={cn("h-3.5 w-3.5", liked && "fill-current")} /></button>
          <a href={outputUrl(result.output)} download className="flex h-7 items-center gap-1.5 rounded px-2 text-[8px] font-semibold text-slate-600 hover:bg-slate-100"><Download className="h-3 w-3" />Export</a>
          <button type="button" onClick={onDelete} aria-label="Delete clip" className="ml-auto grid h-7 w-7 place-items-center rounded text-slate-300 hover:bg-red-50 hover:text-red-500"><Trash2 className="h-3.5 w-3.5" /></button>
        </div>
      </div>
      {layout === "list" ? <a href={outputUrl(result.output)} download className="mr-3 grid h-8 w-8 place-items-center rounded-md bg-slate-950 text-white" aria-label="Download MP4"><Download className="h-3.5 w-3.5" /></a> : null}
    </article>
  );
}

export default function AIClipper({
  onClose,
  initialUrl = "",
  embedded = false,
  onEngaged,
}: Props) {
  const [draft, setDraft] = useState<ClipDraft>(() => loadDraft(initialUrl));
  const [view, setView] = useState<WorkspaceView>("create");
  const [advanced, setAdvanced] = useState(false);
  const [wizardStep, setWizardStep] = useState(0);
  const [hasChosenObjective, setHasChosenObjective] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [results, setResults] = useState<ClipResult[]>(loadResults);
  const [selectedId, setSelectedId] = useState("");
  const [selectedResults, setSelectedResults] = useState<Set<string>>(new Set());
  const [liked, setLiked] = useState<Set<string>>(new Set());
  const [resultLayout, setResultLayout] = useState<ResultLayout>("grid");
  const [sortMode, setSortMode] = useState<SortMode>("score");
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [activeStep, setActiveStep] = useState("captions");
  const [progress, setProgress] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [readyCount, setReadyCount] = useState(0);
  const task = useRef<AbortController | null>(null);
  const resultBuffer = useRef<ClipResult[]>([]);
  void onClose;

  useEffect(() => {
    if (!initialUrl) return;
    setDraft((current) => ({ ...current, source: { mode: "url", url: initialUrl } }));
  }, [initialUrl]);

  useEffect(() => {
    const timer = window.setTimeout(() => localStorage.setItem(DRAFT_KEY, JSON.stringify(draft)), 350);
    return () => window.clearTimeout(timer);
  }, [draft]);

  useEffect(() => {
    localStorage.setItem(RESULT_KEY, JSON.stringify(results.slice(0, 24)));
  }, [results]);

  useEffect(() => {
    if (view !== "processing") return;
    const timer = window.setInterval(() => setElapsed((value) => value + 1), 1_000);
    return () => window.clearInterval(timer);
  }, [view]);

  useEffect(() => () => task.current?.abort(), []);

  const updateDraft = <K extends keyof ClipDraft>(key: K, value: ClipDraft[K]) => setDraft((current) => ({ ...current, [key]: value }));
  const sourceReady = draft.source.mode === "url" ? /^https?:\/\//i.test(draft.source.url.trim()) : Boolean(draft.source.uploadId);
  const objective = draft.objective === "custom" ? draft.customObjective.trim() : OBJECTIVES.find(([id]) => id === draft.objective)?.[1] || "Best viral moments";

  const handleFile = async (file: File) => {
    const controller = new AbortController();
    task.current?.abort();
    task.current = controller;
    setUploading(true);
    setUploadProgress(0);
    setError("");
    onEngaged?.();
    try {
      const uploaded = await uploadVideo(file, controller.signal, setUploadProgress);
      setDraft((current) => ({ ...current, source: { mode: "upload", url: "", ...uploaded } }));
    } catch (cause) {
      if (!(cause instanceof DOMException && cause.name === "AbortError")) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (task.current === controller) task.current = null;
      setUploading(false);
    }
  };

  const cancel = () => {
    task.current?.abort();
    task.current = null;
    setView("create");
    setProgress(0);
    setStatus("");
  };

  const run = useCallback(async () => {
    if (!sourceReady || !objective) {
      setError("Add a valid source and choose what Clyra should find.");
      return;
    }
    const controller = new AbortController();
    task.current?.abort();
    task.current = controller;
    resultBuffer.current = [];
    setError("");
    setView("processing");
    setStatus("Opening the source");
    setActiveStep("captions");
    setProgress(3);
    setElapsed(0);
    setReadyCount(0);
    onEngaged?.();
    try {
      const response = await fetch("/api/clipper/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          url: draft.source.mode === "url" ? draft.source.url.trim() : undefined,
          uploadId: draft.source.mode === "upload" ? draft.source.uploadId : undefined,
          config: {
            font: draft.font,
            font_size: draft.fontSize,
            text_colour: draft.colour,
            position: draft.position,
            moment_type: objective,
            clip_duration: draft.clipLength,
            clip_count: draft.clipCount,
            aspect_ratio: draft.aspect,
            crop_focus: draft.cropFocus,
            captions_enabled: draft.captionsEnabled,
            remove_fillers: draft.removeFillers,
            clip_name: draft.source.name || "clyra-clip",
          },
        }),
      });
      if (!response.ok) {
        const detail = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(detail.error || `The clip server returned ${response.status}`);
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error("The clip server returned no progress stream");
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line.startsWith("data: ")) continue;
          const event = JSON.parse(line.slice(6)) as {
            type?: string;
            step?: string;
            message?: string;
            result?: ClipResult;
            results?: ClipResult[];
          };
          if (event.type === "error") throw new Error(event.message || "Clip rendering failed");
          if (event.step) {
            setActiveStep(event.step);
            const index = Math.max(0, PIPELINE.findIndex(([id]) => id === event.step));
            const candidateBoost = Math.min(0.72, resultBuffer.current.length / Math.max(1, draft.clipCount) * 0.7);
            setProgress(event.step === "complete" ? 100 : Math.min(98, Math.round((index / (PIPELINE.length - 1) * 28) + candidateBoost * 100)));
          }
          if (event.message) setStatus(event.message);
          if (event.type === "clip_result" && event.result) {
            if (!resultBuffer.current.some((item) => item.output === event.result?.output)) resultBuffer.current.push(event.result);
            setReadyCount(resultBuffer.current.length);
          }
          if (event.step === "complete") {
            const completeResults = event.results?.length ? event.results : resultBuffer.current;
            if (!completeResults.length) throw new Error("Rendering completed without any clips");
            setResults(completeResults);
            setSelectedId(completeResults[0].id);
            setSelectedResults(new Set());
            setProgress(100);
            setView("results");
            return;
          }
        }
      }
      throw new Error("Processing stopped before the clips were returned");
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      setError(cause instanceof Error ? cause.message : String(cause));
      setView("create");
    } finally {
      if (task.current === controller) task.current = null;
    }
  }, [draft, objective, onEngaged, sourceReady]);

  const filteredResults = useMemo(() => {
    const query = search.trim().toLowerCase();
    const next = results.filter((result) => !query || `${result.title} ${result.caption} ${result.reason}`.toLowerCase().includes(query));
    next.sort((left, right) => sortMode === "duration"
      ? parseDuration(right.clip_duration) - parseDuration(left.clip_duration)
      : sortMode === "source"
        ? String(left.source_start || "").localeCompare(String(right.source_start || ""))
        : (right.score ?? (right.virality_score || 0) * 10) - (left.score ?? (left.virality_score || 0) * 10));
    return next;
  }, [results, search, sortMode]);

  const selected = results.find((result) => result.id === selectedId) || results[0];

  const bulkExport = () => {
    const items = results.filter((result) => selectedResults.has(result.id));
    items.forEach((result, index) => {
      window.setTimeout(() => {
        const anchor = document.createElement("a");
        anchor.href = outputUrl(result.output);
        anchor.download = "";
        anchor.click();
      }, index * 220);
    });
  };

  const wizardMeta = [
    { title: "Add your source", detail: "Paste a public video link or upload a local file." },
    { title: "Choose the moments", detail: "Tell Clyra what makes a moment worth keeping." },
    { title: "Style the subtitles", detail: "Set the framing and caption treatment used in every render." },
    { title: "Set the output", detail: "Choose clip length and how many distinct moments to create." },
  ];
  const canContinue = wizardStep === 0 ? sourceReady && !uploading : wizardStep === 1 ? hasChosenObjective && Boolean(objective) : true;
  const createView = (
    <div className="clyra-clipper-workspace mx-auto flex h-full max-h-full w-full max-w-[820px] flex-col overflow-hidden px-5 py-5 sm:px-7 sm:py-7">
      <header className="flex shrink-0 items-center justify-between pb-4">
        <div><p className="text-[10px] font-bold uppercase tracking-[0.12em] text-blue-600">AI Clip</p><h1 className="mt-1.5 text-[24px] font-semibold tracking-[-0.02em] text-slate-950 sm:text-[27px]">Create polished clips</h1><p className="mt-1.5 text-[12px] text-slate-500">Turn a source video into focused, share-ready moments.</p></div>
        {results.length ? <button type="button" onClick={() => setView("results")} className="flex h-9 items-center gap-2 rounded-full border border-slate-200 bg-white px-3.5 text-[9px] font-semibold text-slate-600 transition-colors hover:bg-slate-50"><Clock3 className="h-3.5 w-3.5" />Recent</button> : null}
      </header>

      <nav className="grid shrink-0 grid-cols-4 gap-2 pb-4" aria-label="Clip setup progress">
        {wizardMeta.map((item, index) => {
          const complete = index < wizardStep;
          const current = index === wizardStep;
          return <button key={item.title} type="button" onClick={() => index <= wizardStep || (index === wizardStep + 1 && canContinue) ? setWizardStep(index) : undefined} className="group text-left"><span className={cn("block h-1 rounded-full transition-colors duration-200", current ? "bg-blue-600" : complete ? "bg-slate-900" : "bg-slate-200")} /><span className={cn("mt-1.5 hidden text-[8px] font-semibold transition-colors sm:block", current ? "text-blue-700" : complete ? "text-slate-700" : "text-slate-400")}>{complete ? "Done" : `${index + 1}.`} {item.title.replace(/^Set |^Add |^Choose |^Style /, "")}</span></button>;
        })}
      </nav>

      <div className="flex min-h-0 flex-1 flex-col">
        <motion.section layout className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[22px] border border-slate-200/80 bg-white shadow-[0_14px_34px_rgba(15,23,42,.055)] pointer-events-auto">
          <div className="shrink-0 border-b border-slate-100 px-6 py-5 sm:px-8 sm:py-6"><p className="text-[10px] font-bold uppercase tracking-[0.1em] text-blue-600">Step {wizardStep + 1} of 4</p><h2 className="mt-1.5 text-[20px] font-semibold tracking-[-0.02em] text-slate-950">{wizardMeta[wizardStep].title}</h2><p className="mt-1.5 text-[12px] leading-5 text-slate-500">{wizardMeta[wizardStep].detail}</p></div>
          <AnimatePresence mode="wait" initial={false}>
            <motion.div key={wizardStep} initial={{ opacity: 0, x: 10 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -8 }} transition={{ duration: 0.2, ease: [0.2, .82, .2, 1] }} className="min-h-0 flex-1 overflow-hidden p-6 sm:p-8">
              {wizardStep === 0 ? <div className="h-full overflow-y-auto pr-1"><SourcePicker source={draft.source} onSource={(source) => updateDraft("source", source)} onFile={(file) => void handleFile(file)} uploading={uploading} uploadProgress={uploadProgress} /></div> : null}
              {wizardStep === 1 ? (
                <div className="h-full overflow-y-auto pr-1">
                  <div className="grid gap-3 sm:grid-cols-2">
                    {OBJECTIVES.map(([id, label]) => {
                      const meta = OBJECTIVE_DETAILS[id];
                      const Icon = meta.icon;
                      const selected = draft.objective === id;
                      return (
                        <motion.button
                          key={id}
                          type="button"
                          onClick={() => {
                            setHasChosenObjective(true);
                            updateDraft("objective", id);
                          }}
                          whileTap={{ scale: 0.985 }}
                          className={cn(
                            "relative min-h-[88px] rounded-[16px] border p-4 text-left transition-[border-color,background-color,box-shadow,transform] duration-200",
                            selected
                              ? "border-blue-300 bg-blue-50/80 text-slate-900 shadow-[0_8px_20px_rgba(37,99,235,.08)]"
                              : "border-slate-200 bg-white text-slate-700 hover:-translate-y-px hover:border-slate-300 hover:shadow-[0_8px_18px_rgba(15,23,42,.05)]",
                          )}
                        >
                          <div className="flex items-start gap-3">
                            <span className={cn("grid h-8 w-8 shrink-0 place-items-center rounded-[10px]", selected ? "bg-blue-100 text-blue-700" : "bg-slate-100 text-slate-500")}><Icon className="h-4 w-4" /></span>
                            <span className="min-w-0 flex-1"><span className="block text-[12px] font-semibold">{id === "custom" ? "Describe it yourself" : label}</span><span className="mt-1 block text-[10px] leading-4 text-slate-500">{meta.detail}</span></span>
                            {selected ? <span className="grid h-5 w-5 place-items-center rounded-full bg-blue-600 text-white"><Check className="h-3 w-3" /></span> : null}
                          </div>
                          {meta.recommended ? <span className="absolute right-4 top-3 rounded-full bg-blue-100 px-2 py-0.5 text-[8px] font-bold uppercase tracking-[.08em] text-blue-700">Recommended</span> : null}
                        </motion.button>
                      );
                    })}
                  </div>
                  <AnimatePresence initial={false}>
                    {draft.objective === "custom" ? (
                      <motion.label initial={{ opacity: 0, height: 0, y: -6 }} animate={{ opacity: 1, height: "auto", y: 0 }} exit={{ opacity: 0, height: 0, y: -6 }} transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }} className="mt-4 block overflow-hidden">
                        <span className="mb-2 flex items-center gap-2 text-[10px] font-semibold text-slate-600"><Sparkles className="h-3.5 w-3.5 text-blue-600" />Custom direction</span>
                        <div className="rounded-[16px] border border-slate-200 bg-white p-3 shadow-[0_6px_18px_rgba(15,23,42,.04)] focus-within:border-blue-300 focus-within:ring-2 focus-within:ring-blue-50">
                          <textarea value={draft.customObjective} onChange={(event) => updateDraft("customObjective", event.target.value.slice(0, 500))} rows={3} placeholder="Find clear moments where the speaker explains a surprising idea with a useful takeaway..." className="w-full resize-none bg-transparent text-[11px] leading-5 text-slate-700 outline-none placeholder:text-slate-400" />
                          <div className="mt-2 flex items-center justify-between border-t border-slate-100 pt-2 text-[9px]"><button type="button" onClick={() => updateDraft("customObjective", "Find self-contained, high-retention moments with a strong hook and clear payoff.")} className="font-semibold text-blue-600 hover:text-blue-700">Improve prompt</button><span className="text-slate-400">{draft.customObjective.length}/500</span></div>
                        </div>
                      </motion.label>
                    ) : null}
                  </AnimatePresence>
                  <p className="mt-4 flex items-center gap-2 text-[10px] leading-4 text-slate-500"><Sparkles className="h-3.5 w-3.5 text-blue-600" />Clyra will analyse pacing, emotion, clarity and audience retention.</p>
                </div>
              ) : null}
              {wizardStep === 2 ? <div className="grid h-full gap-4 overflow-y-auto md:grid-cols-[minmax(0,1fr)_180px]"><div><Toggle label="Dynamic captions" detail="Burn word-timed captions into every exported MP4." checked={draft.captionsEnabled} onChange={(value) => updateDraft("captionsEnabled", value)} /><Toggle label="Remove filler words" detail="Hide common filler words without cutting the source audio." checked={draft.removeFillers} onChange={(value) => updateDraft("removeFillers", value)} /><div className="mt-3 grid gap-3 sm:grid-cols-2"><label className="text-[8px] font-semibold text-slate-500">Caption font<select value={draft.font} onChange={(event) => updateDraft("font", event.target.value)} className="mt-1 h-9 w-full rounded-md border border-slate-200 bg-white px-2.5 text-[9px] outline-none"><option>Impact</option><option>Arial Black</option><option>Helvetica</option></select></label><label className="text-[8px] font-semibold text-slate-500">Position<select value={draft.position} onChange={(event) => updateDraft("position", event.target.value as CaptionPosition)} className="mt-1 h-9 w-full rounded-md border border-slate-200 bg-white px-2.5 text-[9px] outline-none"><option value="top">Top</option><option value="centre">Middle</option><option value="bottom">Bottom safe zone</option></select></label><div><p className="mb-1.5 text-[8px] font-semibold text-slate-500">Aspect ratio</p><div className="flex rounded-md border border-slate-200 bg-slate-50 p-1">{(["9:16", "1:1", "16:9"] as ClipAspect[]).map((value) => <Segment key={value} value={value} current={draft.aspect} onClick={(next) => updateDraft("aspect", next)}>{value}</Segment>)}</div></div><div><p className="mb-1.5 text-[8px] font-semibold text-slate-500">Subject focus</p><div className="flex rounded-md border border-slate-200 bg-slate-50 p-1">{(["left", "center", "right"] as CropFocus[]).map((value) => <Segment key={value} value={value} current={draft.cropFocus} onClick={(next) => updateDraft("cropFocus", next)}>{value}</Segment>)}</div></div></div></div><div className={cn("relative mx-auto w-full overflow-hidden rounded-md bg-[#111318] shadow-[0_12px_28px_rgba(15,23,42,.14)]", draft.aspect === "9:16" ? "aspect-[9/16] max-h-[220px]" : draft.aspect === "1:1" ? "aspect-square max-h-[220px]" : "aspect-video max-h-[180px]")}><div className="absolute inset-0 bg-[linear-gradient(145deg,#3b4350,#090a0d_72%)]" />{draft.captionsEnabled ? <p className={cn("absolute left-[7%] right-[7%] text-center font-black uppercase leading-none text-white [text-shadow:-2px_-2px_0_#000,2px_-2px_0_#000,-2px_2px_0_#000,2px_2px_0_#000]", draft.position === "top" ? "top-[18%]" : draft.position === "centre" ? "top-1/2 -translate-y-1/2" : "bottom-[16%]")} style={{ fontFamily: draft.font, fontSize: `${Math.min(18, draft.fontSize * .2)}px`, color: draft.colour }}>YOUR BEST MOMENT</p> : null}</div></div> : null}
              {wizardStep === 3 ? <div className="h-full overflow-y-auto"><div className="grid gap-4 sm:grid-cols-2"><div><p className="mb-1.5 text-[8px] font-semibold text-slate-500">Clip length</p><div className="flex rounded-md border border-slate-200 bg-slate-50 p-1">{[15, 30, 45, 60].map((value) => <Segment key={value} value={value} current={draft.clipLength} onClick={(next) => updateDraft("clipLength", next)}>{value}s</Segment>)}</div></div><div><p className="mb-1.5 text-[8px] font-semibold text-slate-500">Number of clips</p><div className="flex rounded-md border border-slate-200 bg-slate-50 p-1">{[1, 3, 5, 8].map((value) => <Segment key={value} value={value} current={draft.clipCount} onClick={(next) => updateDraft("clipCount", next)}>{value}</Segment>)}</div></div></div><dl className="mt-5 divide-y divide-slate-100 rounded-md border border-slate-200 px-3 text-[8px]">{[["Source", draft.source.name || draft.source.url || "Ready"], ["Moments", objective], ["Output", `${draft.clipCount} distinct clips · ${draft.clipLength}s each`], ["Format", `${draft.aspect} · ${draft.captionsEnabled ? "word-timed captions" : "clean video"}`]].map(([label, value]) => <div key={label} className="flex justify-between gap-4 py-2.5"><dt className="text-slate-400">{label}</dt><dd className="max-w-[70%] truncate text-right font-semibold text-slate-700">{value}</dd></div>)}</dl></div> : null}
              {error ? <p className="mt-3 flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[8px] leading-4 text-red-600"><AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />{error}</p> : null}
            </motion.div>
          </AnimatePresence>
          <div className="flex shrink-0 items-center border-t border-slate-100 px-6 py-4 sm:px-8"><button type="button" disabled={wizardStep === 0} onClick={() => setWizardStep((step) => Math.max(0, step - 1))} className="flex h-10 items-center gap-1.5 rounded-full px-4 text-[11px] font-semibold text-slate-500 transition-colors hover:bg-slate-100 disabled:opacity-0"><ChevronLeft className="h-3.5 w-3.5" />Back</button>{wizardStep < 3 ? <button type="button" disabled={!canContinue} onClick={() => setWizardStep((step) => Math.min(3, step + 1))} className="ml-auto flex h-10 items-center gap-1.5 rounded-full bg-slate-950 px-5 text-[11px] font-semibold text-white transition-transform active:scale-[.98] disabled:opacity-35">Continue<ChevronRight className="h-3.5 w-3.5" /></button> : <button type="button" disabled={!sourceReady || !objective} onClick={() => void run()} className="ml-auto flex h-10 items-center gap-2 rounded-full bg-blue-600 px-5 text-[11px] font-semibold text-white shadow-[0_8px_20px_rgba(37,99,235,.22)] transition-transform active:scale-[.98] disabled:opacity-35"><WandSparkles className="h-3.5 w-3.5" />Generate clips</button>}</div>
        </motion.section>
      </div>
    </div>
  );

  const resultsView = (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-[1080px] flex-col overflow-hidden rounded-[22px] border border-slate-200/80 bg-[#f8fafc] shadow-[0_14px_34px_rgba(15,23,42,.045)]">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-slate-200/80 bg-white px-4 sm:px-5">
        <button type="button" onClick={() => setView("create")} className="flex h-8 items-center gap-2 rounded-md px-2 text-[9px] font-semibold text-slate-500 hover:bg-slate-100 hover:text-slate-950"><Plus className="h-3.5 w-3.5" />New generation</button>
        <span className="hidden text-[8px] text-slate-300 sm:block">/</span>
        <span className="hidden text-[9px] font-semibold text-slate-700 sm:block">{results.length} ranked clips</span>
        <div className="ml-auto flex items-center gap-1">
          <button type="button" onClick={() => void run()} className="hidden h-8 items-center gap-1.5 rounded-md px-2 text-[9px] font-semibold text-slate-500 hover:bg-slate-100 sm:flex"><RefreshCw className="h-3.5 w-3.5" />Generate more</button>
          <button type="button" disabled={!selectedResults.size} onClick={bulkExport} className="flex h-8 items-center gap-1.5 rounded-md bg-slate-950 px-3 text-[9px] font-semibold text-white disabled:opacity-30"><Download className="h-3.5 w-3.5" />Export selected</button>
        </div>
      </header>
      <div className="grid min-h-0 flex-1 lg:grid-cols-[190px_minmax(0,1fr)_260px]">
        <aside className="hidden min-h-0 border-r border-slate-200/80 bg-white p-4 lg:block">
          <p className="text-[9px] font-bold uppercase tracking-[.12em] text-slate-400">Review clips</p>
          <label className="mt-4 flex h-9 items-center gap-2 rounded-md border border-slate-200 px-2">
            <Search className="h-3.5 w-3.5 text-slate-400" />
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search transcript" className="min-w-0 flex-1 text-[9px] outline-none" />
          </label>
          <label className="mt-4 block text-[9px] font-semibold text-slate-500">
            Sort by
            <select value={sortMode} onChange={(event) => setSortMode(event.target.value as SortMode)} className="mt-1.5 h-9 w-full rounded-md border border-slate-200 bg-white px-2 text-[9px] outline-none">
              <option value="score">Viral score</option>
              <option value="duration">Duration</option>
              <option value="source">Source position</option>
            </select>
          </label>
          <div className="mt-5 border-t border-slate-200 pt-4">
            <p className="text-[8px] font-semibold text-slate-400">Batch selection</p>
            <button type="button" onClick={() => setSelectedResults(selectedResults.size === results.length ? new Set() : new Set(results.map((result) => result.id)))} className="mt-2 text-[9px] font-semibold text-slate-700 hover:text-slate-950">{selectedResults.size === results.length ? "Clear all" : "Select all clips"}</button>
          </div>
          <div className="mt-5 border-t border-slate-200 pt-4 text-[8px] leading-4 text-slate-400">
            Scores combine transcript density and the connected LLM's assessment of hook, clarity, payoff, and shareability.
          </div>
        </aside>

        <main className="min-h-0 overflow-y-auto p-3 sm:p-4">
          <div className="mb-3 flex items-center justify-between">
            <div>
              <p className="text-[12px] font-semibold text-slate-900">Generated clips</p>
              <p className="mt-0.5 text-[8px] text-slate-400">Distinct source moments, already captioned and exported</p>
            </div>
            <div className="flex rounded-md border border-slate-200 bg-white p-1">
              <button type="button" onClick={() => setResultLayout("grid")} className={cn("grid h-7 w-7 place-items-center rounded", resultLayout === "grid" ? "bg-slate-100 text-slate-950" : "text-slate-400")} aria-label="Grid view"><Grid2X2 className="h-3.5 w-3.5" /></button>
              <button type="button" onClick={() => setResultLayout("list")} className={cn("grid h-7 w-7 place-items-center rounded", resultLayout === "list" ? "bg-slate-100 text-slate-950" : "text-slate-400")} aria-label="List view"><List className="h-3.5 w-3.5" /></button>
            </div>
          </div>
          <div className={cn(resultLayout === "grid" ? "grid gap-3 sm:grid-cols-2 xl:grid-cols-3" : "space-y-2")}>
            {filteredResults.map((result) => (
              <div key={result.id} className="relative">
                <label className="absolute right-2 top-2 z-20 grid h-5 w-5 place-items-center rounded bg-white/90 shadow-sm">
                  <input type="checkbox" checked={selectedResults.has(result.id)} onChange={() => setSelectedResults((current) => { const next = new Set(current); if (next.has(result.id)) next.delete(result.id); else next.add(result.id); return next; })} className="h-3 w-3 accent-slate-950" aria-label={`Select ${result.title}`} />
                </label>
                <ClipCard result={result} selected={selected?.id === result.id} layout={resultLayout} liked={liked.has(result.id)} onSelect={() => setSelectedId(result.id)} onLike={() => setLiked((current) => { const next = new Set(current); if (next.has(result.id)) next.delete(result.id); else next.add(result.id); return next; })} onDelete={() => setResults((items) => items.filter((item) => item.id !== result.id))} />
              </div>
            ))}
          </div>
        </main>

        <aside className="hidden min-h-0 border-l border-slate-200/80 bg-white lg:flex lg:flex-col">
          {selected ? (
            <>
              <div className="min-h-0 flex-1 overflow-y-auto p-4">
                <p className="text-[9px] font-bold uppercase tracking-[.12em] text-slate-400">Selected clip</p>
                <div className="mx-auto mt-4 aspect-[9/16] max-h-[390px] overflow-hidden rounded-md bg-black shadow-[0_16px_36px_rgba(15,23,42,.2)]">
                  <video key={selected.output} controls playsInline preload="metadata" src={outputUrl(selected.output)} className="h-full w-full object-cover" />
                </div>
                <div className="mt-4 flex items-center justify-between">
                  <span className="text-[10px] font-bold text-emerald-600">{selected.score ?? Math.round((selected.virality_score || 0) * 10)}/100</span>
                  <span className="text-[8px] text-slate-400">{selected.clip_duration} · {fileSize(selected.file_size)}</span>
                </div>
                <h2 className="mt-2 text-[13px] font-semibold leading-5 text-slate-900">{selected.title}</h2>
                <p className="mt-2 text-[9px] leading-5 text-slate-500">{selected.reason}</p>
                {selected.caption ? (
                  <div className="mt-4 border-y border-slate-200 py-3">
                    <p className="text-[8px] font-bold uppercase tracking-[.1em] text-slate-400">Transcript excerpt</p>
                    <p className="mt-2 text-[9px] leading-5 text-slate-600">{selected.caption}</p>
                  </div>
                ) : null}
                <dl className="mt-3 divide-y divide-slate-100 text-[8px]">
                  <div className="flex justify-between py-2"><dt className="text-slate-400">Source range</dt><dd className="font-semibold text-slate-600">{selected.source_start}–{selected.source_end}</dd></div>
                  <div className="flex justify-between py-2"><dt className="text-slate-400">Timing</dt><dd className="font-semibold text-slate-600">{selected.timing_source}</dd></div>
                  <div className="flex justify-between py-2"><dt className="text-slate-400">Output</dt><dd className="max-w-[160px] truncate font-semibold text-slate-600">{selected.output_quality}</dd></div>
                </dl>
              </div>
              <div className="grid gap-2 border-t border-slate-200 p-3">
                <a href={outputUrl(selected.output)} download className="flex h-9 items-center justify-center gap-2 rounded-md bg-slate-950 text-[9px] font-semibold text-white"><Download className="h-3.5 w-3.5" />Download MP4</a>
                <button type="button" onClick={() => setView("create")} className="flex h-9 items-center justify-center gap-2 rounded-md border border-slate-200 text-[9px] font-semibold text-slate-600 hover:bg-slate-50"><SlidersHorizontal className="h-3.5 w-3.5" />Refine and render again</button>
              </div>
            </>
          ) : null}
        </aside>
      </div>
    </div>
  );

  const content = (
    <div className={cn("overflow-hidden bg-[#f8fafc] text-slate-950", embedded ? "relative h-full w-full" : "fixed inset-0 z-[600]")}>
      <AnimatePresence>{view === "processing" ? <ProcessingScreen progress={progress} status={status} activeStep={activeStep} readyCount={readyCount} elapsed={elapsed} onCancel={cancel} /> : null}</AnimatePresence>
      <div className={cn("h-full", view === "create" ? "overflow-hidden" : "overflow-y-auto")}>{view === "results" ? resultsView : createView}</div>
    </div>
  );
  return embedded ? content : createPortal(content, document.body);
}
