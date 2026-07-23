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
type FaceTrackingMode = "off" | "smooth" | "responsive";
type SceneMode = "strict" | "flexible";
type ResultLayout = "grid" | "list";
type SortMode = "score" | "duration" | "source";

type CaptionWord = { word?: string; text?: string; start: number; end: number };

type ClipSource = {
  mode: SourceMode;
  url: string;
  uploadId?: string;
  name?: string;
  size?: number;
};

type AvailableFace = {
  id: string;
  label?: string;
  personId?: string;
  bbox?: { x: number; y: number; width: number; height: number };
  confidence?: number;
  thumbnail?: string;
  thumbnailUrl?: string;
  thumbnailPath?: string;
  sampleBbox?: number[] | { x: number; y: number; width: number; height: number };
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
  clip_potential_score?: number;
  score_source?: string;
  file_size?: number;
  timing_source?: string;
  word_count?: number;
  output_quality?: string;
  artifact_id?: string;
  words?: CaptionWord[];
  available_faces?: AvailableFace[];
  face_tracking?: {
    enabled?: boolean;
    mode?: FaceTrackingMode;
    selectedTrackId?: string | null;
    selectedPersonId?: string | null;
    sceneMode?: SceneMode;
    personMode?: SceneMode;
  };
  crop_keyframes?: Array<{
    timeMs: number;
    faceBox?: { x: number; y: number; width: number; height: number } | number[];
    trackId?: string;
    personId?: string;
  }>;
  face_overlay?: Array<{
    timeMs: number;
    faces: Array<{
      id?: string;
      personId?: string;
      trackId?: string;
      bbox: { x: number; y: number; width: number; height: number };
      confidence?: number;
    }>;
  }>;
  plate_url?: string;
};

function clipPotentialScore(result: ClipResult): number {
  const raw = result.clip_potential_score ?? result.score ?? Math.round((result.virality_score || 0) * 10);
  return Math.max(1, Math.min(100, Math.round(Number(raw) || 0)));
}

type ClipDraft = {
  source: ClipSource;
  objective: string;
  customObjective: string;
  clipLength: number;
  clipCount: number;
  aspect: ClipAspect;
  cropFocus: CropFocus;
  faceTracking: FaceTrackingMode;
  sceneMode: SceneMode;
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
  faceTracking: "smooth",
  sceneMode: "strict",
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

function clipFilename(value?: string) {
  if (!value) return "";
  const filename = value.split(/[/\\]/).pop() || "";
  return /^[\w.-]+\.mp4$/i.test(filename) ? filename : "";
}

/** Serve clips through Express so Electron (CLYRA_DATA_ROOT) and web share one path. */
function outputUrl(value?: string) {
  const filename = clipFilename(value);
  return filename ? `/api/clipper/media/${encodeURIComponent(filename)}` : "";
}

function formatWordTime(seconds: number) {
  const total = Math.max(0, seconds);
  const mins = Math.floor(total / 60);
  const secs = Math.floor(total % 60);
  const cs = Math.floor((total % 1) * 100);
  return `${mins}:${String(secs).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

function fileSize(bytes?: number) {
  if (!bytes) return "MP4";
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function wordText(item: CaptionWord) {
  return String(item.word || item.text || "").trim();
}

function faceOverlayBox(face: AvailableFace, index: number) {
  if (face.bbox && Number.isFinite(face.bbox.width) && face.bbox.width > 0.02) {
    return face.bbox;
  }
  if (Array.isArray(face.sampleBbox) && face.sampleBbox.length >= 4) {
    const [x0, y0, x1, y1] = face.sampleBbox;
    return {
      x: Math.max(0, Math.min(0.92, x0)),
      y: Math.max(0, Math.min(0.92, y0)),
      width: Math.max(0.08, Math.min(1 - x0, x1 - x0)),
      height: Math.max(0.08, Math.min(1 - y0, y1 - y0)),
    };
  }
  return {
    x: 0.18 + (index % 3) * 0.22,
    y: 0.16 + Math.floor(index / 3) * 0.28,
    width: 0.28,
    height: 0.34,
  };
}

function rewriteTimedWords(words: CaptionWord[]): CaptionWord[] {
  return words
    .map((item) => {
      const cleaned = wordText(item)
        .replace(/[^A-Za-z0-9'\s-]+/g, "")
        .trim()
        .replace(/\s+/g, " ")
        .toUpperCase()
        .slice(0, 28);
      return { ...item, word: cleaned, text: cleaned };
    })
    .filter((item) => wordText(item).length > 0);
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
        "relative h-9 min-w-0 flex-1 rounded-full px-3 text-[11px] font-medium transition-colors",
        value === current ? "text-slate-900" : "text-slate-400 hover:text-slate-600",
      )}
    >
      {value === current ? (
        <motion.span layoutId="clip-segment" className="absolute inset-0 rounded-full bg-white shadow-sm ring-1 ring-slate-200/80" transition={{ type: "spring", stiffness: 650, damping: 45 }} />
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
    <button type="button" onClick={() => onChange(!checked)} className="flex w-full items-center justify-between gap-4 border-b border-slate-100 py-3.5 text-left last:border-b-0">
      <span>
        <span className="block text-[12px] font-medium text-slate-800">{label}</span>
        <span className="mt-0.5 block text-[11px] leading-4 text-slate-400">{detail}</span>
      </span>
      <span className={cn("relative h-6 w-11 shrink-0 rounded-full transition-colors duration-200", checked ? "bg-slate-900" : "bg-slate-200")}>
        <motion.span animate={{ x: checked ? 22 : 2 }} transition={{ type: "spring", stiffness: 700, damping: 42 }} className="absolute top-0.5 h-5 w-5 rounded-full bg-white shadow-sm" />
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
      <div className="grid grid-cols-2 rounded-full border border-slate-200/80 bg-slate-100/70 p-1.5">
        {([
          { mode: "url" as const, label: "Video URL", icon: Link2 },
          { mode: "upload" as const, label: "Upload", icon: Upload },
        ]).map((option) => {
          const Icon = option.icon;
          return (
            <button key={option.mode} type="button" onClick={() => onSource({ ...source, mode: option.mode })} className={cn("flex h-10 items-center justify-center gap-2 rounded-full text-[12px] font-medium transition-[background-color,color,box-shadow,transform] duration-200 active:scale-[.985]", source.mode === option.mode ? "bg-white text-slate-900 shadow-sm ring-1 ring-slate-200/80" : "text-slate-400 hover:text-slate-600")}>
              <Icon className="h-3.5 w-3.5" />
              {option.label}
            </button>
          );
        })}
      </div>
      {source.mode === "url" ? (
        <>
          <label className="mt-5 block text-[11px] font-medium text-slate-500">
            YouTube or public video URL
            <div className="mt-2 flex h-12 items-center rounded-2xl border border-slate-200/80 bg-white px-4 shadow-sm transition-[border-color,box-shadow] duration-200 focus-within:border-slate-300 focus-within:ring-2 focus-within:ring-slate-200">
              <Link2 className="h-4 w-4 shrink-0 text-slate-400" />
              <input value={source.url} onChange={(event) => onSource({ mode: "url", url: event.target.value })} placeholder="Paste a YouTube or public video link" className="h-full min-w-0 flex-1 bg-transparent px-3 text-[13px] font-medium outline-none placeholder:text-slate-400" />
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
                className="clyra-clip-source-preview mt-5 overflow-hidden rounded-2xl border border-slate-200/80 bg-slate-950 shadow-sm"
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
          className={cn("mt-5 flex min-h-[180px] flex-col items-center justify-center rounded-2xl border border-dashed px-6 text-center transition-colors duration-200", dragging ? "border-slate-300 bg-slate-50/60" : "border-slate-300 bg-white")}
        >
          {uploading ? (
            <>
              <Loader2 className="h-5 w-5 animate-spin text-slate-500" />
              <p className="mt-3 text-[12px] font-medium text-slate-700">Uploading {Math.round(uploadProgress * 100)}%</p>
              <div className="mt-3 h-1.5 w-44 overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full bg-slate-900 transition-[width] duration-200" style={{ width: `${uploadProgress * 100}%` }} /></div>
            </>
          ) : source.uploadId ? (
            <>
              <CheckCircle2 className="h-5 w-5 text-emerald-500" />
              <p className="mt-3 max-w-full truncate text-[12px] font-medium text-slate-800">{source.name}</p>
              <p className="mt-1 text-[11px] text-slate-400">{fileSize(source.size)} · ready to analyse</p>
              <button type="button" onClick={() => fileInput.current?.click()} className="mt-3 text-[11px] font-medium text-slate-500 transition-colors hover:text-slate-900">Replace video</button>
            </>
          ) : (
            <>
              <FileVideo2 className="h-6 w-6 text-slate-400" />
              <p className="mt-3 text-[12px] font-medium text-slate-800">Drop a video here</p>
              <p className="mt-1 text-[11px] text-slate-400">MP4, MOV, WebM or MKV up to 1.25 GB</p>
              <button type="button" onClick={() => fileInput.current?.click()} className="mt-4 h-9 rounded-full border border-slate-200/80 bg-white px-5 text-[11px] font-medium text-slate-600 shadow-sm transition-colors hover:bg-slate-50">Choose video</button>
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
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[9999] overflow-y-auto bg-white px-5 py-8">
      <div className="mx-auto flex min-h-full w-full max-w-[760px] flex-col justify-center">
        <section className="rounded-3xl border border-slate-200/80 bg-white p-6 shadow-[0_16px_44px_rgba(15,23,42,.06)] sm:p-8">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-600">AI Clip</p>
            <h2 className="mt-3 text-[clamp(26px,5vw,40px)] font-semibold tracking-[-0.02em] text-slate-950">Finding your strongest moments</h2>
            <p className="mt-2 text-[13px] text-slate-500">{status || "Preparing the source"}</p>
          </div>
          <button type="button" onClick={onCancel} className="grid h-10 w-10 place-items-center rounded-full border border-slate-200/80 bg-white text-slate-500 shadow-sm transition-colors duration-200 hover:bg-slate-50" aria-label="Cancel processing"><X className="h-4 w-4" /></button>
        </div>
        <div className="relative mt-10 h-2 overflow-hidden rounded-full bg-slate-100">
          <motion.div className="relative h-full overflow-hidden rounded-full bg-slate-900" animate={{ width: `${Math.max(2, progress)}%` }} transition={{ duration: 0.22 }}><motion.span className="absolute inset-y-0 w-24 bg-white/35 blur-sm" animate={{ x: [-100, 760] }} transition={{ repeat: Infinity, duration: 1.5, ease: "linear" }} /></motion.div>
        </div>
        <div className="mt-3 flex items-center justify-between text-[11px] font-medium text-slate-400">
          <span>{readyCount ? `${readyCount} clip${readyCount === 1 ? "" : "s"} ready` : "Analysing source"}</span>
          <span className="tabular-nums">{progress}% · {elapsed}s</span>
        </div>
        <ol className="mt-8 grid gap-2 sm:grid-cols-2">
          {PIPELINE.slice(0, -1).map(([id, label]) => {
            const activeIndex = PIPELINE.findIndex(([step]) => step === activeStep);
            const index = PIPELINE.findIndex(([step]) => step === id);
            const complete = activeIndex > index || activeStep === "complete";
            const active = activeStep === id;
            return (
              <li key={id} className={cn("flex h-[54px] items-center gap-3 rounded-2xl border px-4 transition-colors duration-200", active ? "border-slate-200 bg-slate-50/70 text-slate-900 shadow-sm" : complete ? "border-emerald-100 bg-emerald-50/35 text-slate-500" : "border-transparent text-slate-400")}>
                <span className={cn("grid h-6 w-6 place-items-center rounded-full border", complete ? "border-emerald-200 bg-emerald-50 text-emerald-600" : active ? "border-slate-900 bg-slate-900 text-white" : "border-slate-200 bg-white")}>
                  {complete ? <Check className="h-3 w-3" /> : active ? <Loader2 className="h-3 w-3 animate-spin" /> : <span className="h-1.5 w-1.5 rounded-full bg-slate-300" />}
                </span>
                <span className={cn("text-[12px] font-medium", active && "text-slate-900")}>{label}</span>
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
    <article className={cn("group border bg-white transition-[border-color,box-shadow,transform] duration-200 hover:-translate-y-0.5 hover:shadow-md", layout === "grid" ? "rounded-2xl" : "grid grid-cols-[112px_minmax(0,1fr)_auto] items-center gap-4 rounded-2xl p-2", selected ? "border-slate-900 ring-1 ring-slate-900 shadow-sm" : "border-slate-200/80 hover:border-slate-300")}>
      <button type="button" onClick={onSelect} className={cn("relative overflow-hidden bg-slate-950", layout === "grid" ? "aspect-video w-full rounded-t-[15px]" : "aspect-[9/16] h-24 rounded-xl")}>
        <video preload="metadata" muted playsInline src={outputUrl(result.output)} className="h-full w-full object-cover" />
        <span className="absolute left-2 top-2 rounded-full bg-black/72 px-2 py-1 text-[10px] font-semibold text-white">#{result.rank}</span>
        <span className="absolute inset-0 grid place-items-center bg-black/0 transition-colors duration-200 group-hover:bg-black/15"><span className="grid h-9 w-9 place-items-center rounded-full bg-white/90 text-slate-950 opacity-0 shadow-sm transition-opacity duration-200 group-hover:opacity-100"><Play className="ml-0.5 h-3.5 w-3.5" /></span></span>
      </button>
      <div className={cn("min-w-0", layout === "grid" ? "p-4" : "")}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-emerald-700/80">Clip Potential</p>
            <p className="mt-0.5 text-[22px] font-semibold leading-none tracking-tight text-emerald-600">{clipPotentialScore(result)}</p>
          </div>
          <span className="shrink-0 text-[11px] text-slate-400">{result.clip_duration}</span>
        </div>
        <h3 className="mt-2.5 line-clamp-2 text-[13px] font-semibold leading-5 text-slate-900">{result.title}</h3>
        {result.reason ? (
          <p className="mt-1.5 line-clamp-3 text-[11px] leading-4 text-slate-500">{result.reason}</p>
        ) : null}
        <div className="mt-3 flex items-center gap-1">
          <button type="button" onClick={onLike} aria-label={liked ? "Unlike clip" : "Like clip"} className={cn("grid h-8 w-8 place-items-center rounded-full text-slate-400 transition-colors hover:bg-slate-100", liked && "text-rose-500")}><Heart className={cn("h-3.5 w-3.5", liked && "fill-current")} /></button>
          <a href={outputUrl(result.output)} download className="flex h-8 items-center gap-1.5 rounded-full px-3 text-[11px] font-medium text-slate-600 transition-colors hover:bg-slate-100"><Download className="h-3 w-3" />Export</a>
          <button type="button" onClick={onDelete} aria-label="Delete clip" className="ml-auto grid h-8 w-8 place-items-center rounded-full text-slate-300 transition-colors hover:bg-red-50 hover:text-red-500"><Trash2 className="h-3.5 w-3.5" /></button>
        </div>
      </div>
      {layout === "list" ? <a href={outputUrl(result.output)} download className="mr-3 grid h-9 w-9 place-items-center rounded-full bg-slate-800 text-white shadow-sm transition-colors hover:bg-slate-900" aria-label="Download MP4"><Download className="h-3.5 w-3.5" /></a> : null}
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
  const [captionWords, setCaptionWords] = useState<CaptionWord[]>([]);
  const [rewriteBusy, setRewriteBusy] = useState(false);
  const [refineBusy, setRefineBusy] = useState(false);
  const [selectedFaceId, setSelectedFaceId] = useState<string>("");
  const [previewTimeMs, setPreviewTimeMs] = useState(0);
  const previewVideoRef = useRef<HTMLVideoElement | null>(null);
  const task = useRef<AbortController | null>(null);
  const resultBuffer = useRef<ClipResult[]>([]);
  void onClose;
  void advanced;
  void setAdvanced;

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
            face_tracking: {
              enabled: draft.faceTracking !== "off",
              mode: draft.faceTracking,
              sceneMode: draft.sceneMode,
              personMode: draft.sceneMode,
              allowZoom: true,
            },
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
        : clipPotentialScore(right) - clipPotentialScore(left));
    return next;
  }, [results, search, sortMode]);

  const selected = results.find((result) => result.id === selectedId) || results[0];

  useEffect(() => {
    if (!selected) {
      setCaptionWords([]);
      setSelectedFaceId("");
      return;
    }
    if (selected.words?.length) {
      setCaptionWords(selected.words.map((item) => ({ ...item, word: wordText(item), text: wordText(item) })));
    } else if (selected.caption) {
      const duration = Math.max(1, parseDuration(selected.clip_duration) || 4);
      const tokens = selected.caption.split(/\s+/).filter(Boolean);
      const step = duration / Math.max(1, tokens.length);
      setCaptionWords(tokens.map((token, index) => ({
        word: token,
        text: token,
        start: index * step,
        end: Math.min(duration, (index + 1) * step),
      })));
    } else {
      setCaptionWords([]);
    }
    setSelectedFaceId(
      selected.face_tracking?.selectedPersonId
      || selected.face_tracking?.selectedTrackId
      || selected.available_faces?.[0]?.id
      || "",
    );
    setPreviewTimeMs(0);
  }, [selected?.id, selected?.caption, selected?.words, selected?.clip_duration, selected?.face_tracking?.selectedTrackId, selected?.face_tracking?.selectedPersonId, selected?.available_faces]);

  const liveOverlayFaces = useMemo(() => {
    const tracks = selected?.face_overlay;
    if (!tracks?.length) {
      return (selected?.available_faces || []).map((face, index) => ({
        id: face.id,
        label: face.label || face.id,
        bbox: faceOverlayBox(face, index),
      }));
    }
    let best = tracks[0]!;
    let bestDist = Math.abs(best.timeMs - previewTimeMs);
    for (const row of tracks) {
      const dist = Math.abs(row.timeMs - previewTimeMs);
      if (dist < bestDist) {
        best = row;
        bestDist = dist;
      }
    }
    return (best.faces || []).map((face) => ({
      id: String(face.personId || face.id || face.trackId || "face"),
      label: String(face.personId || face.id || face.trackId || "Face"),
      bbox: face.bbox,
    }));
  }, [selected?.available_faces, selected?.face_overlay, previewTimeMs]);

  const persistSelectedEdits = () => {
    if (!selected) return;
    setResults((items) =>
      items.map((item) =>
        item.id === selected.id
          ? {
              ...item,
              caption: captionWords.map(wordText).filter(Boolean).join(" ").slice(0, 220),
              words: captionWords,
              face_tracking: {
                ...(item.face_tracking || { enabled: draft.faceTracking !== "off", mode: draft.faceTracking }),
                selectedTrackId: selectedFaceId || null,
                selectedPersonId: selectedFaceId || null,
                sceneMode: draft.sceneMode,
                personMode: draft.sceneMode,
              },
            }
          : item,
      ),
    );
  };

  const refineSelected = async () => {
    if (!selected?.artifact_id || refineBusy) return;
    persistSelectedEdits();
    setRefineBusy(true);
    setError("");
    try {
      const payloadWords = captionWords
        .map((word) => {
          const text = wordText(word);
          if (!text) return null;
          return { word: text, text, start: Number(word.start) || 0, end: Math.max((Number(word.start) || 0) + 0.05, Number(word.end) || 0.2) };
        })
        .filter(Boolean);
      const response = await fetch("/api/clipper/rerender", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          artifactId: selected.artifact_id,
          faceTrackingMode: draft.faceTracking,
          selectedTrackId: selectedFaceId || null,
          selectedPersonId: selectedFaceId || null,
          sceneMode: draft.sceneMode,
          personMode: draft.sceneMode,
          allowZoom: true,
          cropFocus: draft.cropFocus,
          aspectRatio: draft.aspect,
          captionsEnabled: draft.captionsEnabled,
          font: draft.font,
          fontSize: draft.fontSize,
          textColour: draft.colour,
          position: draft.position,
          words: payloadWords,
        }),
      });
      if (!response.ok) {
        const detail = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(detail.error || `Re-render failed (${response.status})`);
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Re-render returned no stream");
      const decoder = new TextDecoder();
      let buffer = "";
      let updated: ClipResult | null = null;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line.startsWith("data: ")) continue;
          const event = JSON.parse(line.slice(6)) as { type?: string; message?: string; result?: ClipResult };
          if (event.type === "error") throw new Error(event.message || "Re-render failed");
          if (event.result) updated = event.result;
        }
      }
      if (updated) {
        setResults((items) => items.map((item) => (item.id === selected.id ? { ...item, ...updated, id: selected.id } : item)));
        if (updated.words?.length) setCaptionWords(updated.words);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRefineBusy(false);
    }
  };

  const rewriteSelectedCaption = async () => {
    if (!selected || rewriteBusy) return;
    setRewriteBusy(true);
    setError("");
    try {
      const cleaned = rewriteTimedWords(captionWords);
      setCaptionWords(cleaned);
      setResults((items) =>
        items.map((item) =>
          item.id === selected.id
            ? { ...item, words: cleaned, caption: cleaned.map(wordText).join(" ").slice(0, 220) }
            : item,
        ),
      );
      // Re-render with cleaned words immediately (avoid stale React state).
      setRefineBusy(true);
      const response = await fetch("/api/clipper/rerender", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          artifactId: selected.artifact_id,
          faceTrackingMode: draft.faceTracking,
          selectedTrackId: selectedFaceId || null,
          selectedPersonId: selectedFaceId || null,
          sceneMode: draft.sceneMode,
          personMode: draft.sceneMode,
          allowZoom: true,
          cropFocus: draft.cropFocus,
          aspectRatio: draft.aspect,
          captionsEnabled: draft.captionsEnabled,
          font: draft.font,
          fontSize: draft.fontSize,
          textColour: draft.colour,
          position: draft.position,
          words: cleaned.map((word) => ({
            word: wordText(word),
            text: wordText(word),
            start: Number(word.start) || 0,
            end: Math.max((Number(word.start) || 0) + 0.05, Number(word.end) || 0.2),
          })),
        }),
      });
      if (!response.ok) {
        const detail = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(detail.error || `Re-render failed (${response.status})`);
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Re-render returned no stream");
      const decoder = new TextDecoder();
      let buffer = "";
      let updated: ClipResult | null = null;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line.startsWith("data: ")) continue;
          const event = JSON.parse(line.slice(6)) as { type?: string; message?: string; result?: ClipResult };
          if (event.type === "error") throw new Error(event.message || "Re-render failed");
          if (event.result) updated = event.result;
        }
      }
      if (updated) {
        setResults((items) => items.map((item) => (item.id === selected.id ? { ...item, ...updated, id: selected.id } : item)));
        if (updated.words?.length) setCaptionWords(updated.words);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRefineBusy(false);
      setRewriteBusy(false);
    }
  };

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
    { id: "source" as const, title: "Source", detail: "Paste a link or upload a file" },
    { id: "moments" as const, title: "Moments", detail: "What Clyra should keep" },
    { id: "look" as const, title: "Look", detail: "Captions, crop and face tracking" },
    { id: "output" as const, title: "Output", detail: "Length and clip count" },
  ];
  const canContinue = wizardStep === 0 ? sourceReady && !uploading : wizardStep === 1 ? hasChosenObjective && Boolean(objective) : true;
  const createView = (
    <div className="relative h-full overflow-y-auto bg-[#f8fafc] px-5 py-8 sm:px-8 lg:px-12">
      <div className="mx-auto flex min-h-full w-full max-w-[1120px] flex-col justify-center">
        <div className="mb-7 flex items-end justify-between gap-6 border-b border-slate-200 pb-6">
          <div>
            <div className="mb-4 flex items-center gap-2">
              <span className="h-1.5 w-1.5 rounded-full bg-slate-900" />
              <span className="text-[10px] font-bold uppercase tracking-[.17em] text-slate-400">AI Clipper</span>
            </div>
            <h1 className="text-[clamp(30px,4vw,48px)] font-semibold tracking-[-.035em] text-slate-950">Create vertical clips</h1>
            <p className="mt-2 max-w-xl text-[13px] leading-6 text-slate-500">
              Turn a YouTube link or local file into share-ready moments with timed captions and optional face tracking.
            </p>
          </div>
          {results.length ? (
            <button
              type="button"
              onClick={() => setView("results")}
              className="hidden h-10 shrink-0 items-center gap-2 rounded-md border border-slate-200 bg-white px-4 text-[10px] font-semibold text-slate-700 shadow-sm transition-colors hover:border-slate-400 sm:flex"
            >
              <Clock3 className="h-3.5 w-3.5" />
              Recent clips
            </button>
          ) : null}
        </div>

        <div className="creator-setup-layout grid gap-5">
          <ol className="space-y-2" aria-label="Clip setup">
            {wizardMeta.map((item, index) => {
              const current = index === wizardStep;
              const complete = index < wizardStep;
              const clickable = index <= wizardStep || (index === wizardStep + 1 && canContinue);
              return (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => (clickable ? setWizardStep(index) : undefined)}
                    className={cn(
                      "flex w-full items-start gap-3 rounded-md px-3 py-3 text-left transition-colors",
                      current ? "bg-white text-slate-950 shadow-sm ring-1 ring-slate-200" : "text-slate-400 hover:bg-white/70",
                    )}
                  >
                    <span className={cn(
                      "grid h-6 w-6 shrink-0 place-items-center rounded-full border text-[9px] font-bold",
                      current || complete ? "border-slate-900 bg-slate-950 text-white" : "border-slate-200 bg-white",
                    )}>
                      {complete ? <Check className="h-3 w-3" /> : index + 1}
                    </span>
                    <span>
                      <span className="block text-[11px] font-semibold">{item.title}</span>
                      <span className="mt-0.5 block text-[8px] leading-4 text-slate-400">{item.detail}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>

          <motion.section
            key={wizardStep}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.24, ease: [0.2, 0.8, 0.2, 1] }}
            className="border-t border-slate-200 pt-6 lg:border-l lg:border-t-0 lg:pl-8 lg:pt-0"
          >
            <p className="text-[10px] font-bold uppercase tracking-[.14em] text-slate-400">Step {wizardStep + 1} of 4</p>
            <h2 className="mt-2 text-[22px] font-semibold text-slate-950">{wizardMeta[wizardStep].title}</h2>
            <p className="mt-1.5 max-w-lg text-[12px] leading-5 text-slate-500">{wizardMeta[wizardStep].detail}</p>

            <div className="mt-6">
              {wizardStep === 0 ? <SourcePicker source={draft.source} onSource={(source) => updateDraft("source", source)} onFile={(file) => void handleFile(file)} uploading={uploading} uploadProgress={uploadProgress} /> : null}
              {wizardStep === 1 ? (
                <div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {OBJECTIVES.map(([id, label]) => {
                      const meta = OBJECTIVE_DETAILS[id];
                      const Icon = meta.icon;
                      const selected = draft.objective === id;
                      return (
                        <button
                          key={id}
                          type="button"
                          onClick={() => {
                            setHasChosenObjective(true);
                            updateDraft("objective", id);
                          }}
                          className={cn(
                            "min-h-[120px] rounded-md border p-4 text-left transition-[border-color,background-color,transform] duration-150 active:scale-[.99]",
                            selected ? "border-slate-900 bg-white shadow-sm" : "border-slate-200 bg-white/60 hover:border-slate-400",
                          )}
                        >
                          <div className="flex items-center justify-between">
                            <span className="grid h-9 w-9 place-items-center rounded-md bg-slate-100 text-slate-700"><Icon className="h-4 w-4" /></span>
                            {selected ? <Check className="h-4 w-4 text-slate-950" /> : null}
                          </div>
                          <p className="mt-4 text-[13px] font-semibold text-slate-950">{id === "custom" ? "Describe it yourself" : label}</p>
                          <p className="mt-1.5 text-[10px] leading-5 text-slate-500">{meta.detail}</p>
                        </button>
                      );
                    })}
                  </div>
                  {draft.objective === "custom" ? (
                    <label className="mt-4 block">
                      <span className="mb-2 block text-[10px] font-semibold text-slate-500">Custom direction</span>
                      <textarea
                        value={draft.customObjective}
                        onChange={(event) => updateDraft("customObjective", event.target.value.slice(0, 500))}
                        rows={3}
                        placeholder="Find clear moments where the speaker explains a surprising idea…"
                        className="w-full resize-none rounded-md border border-slate-200 bg-white px-3 py-3 text-[12px] leading-5 text-slate-700 outline-none focus:border-slate-400"
                      />
                    </label>
                  ) : null}
                </div>
              ) : null}
              {wizardStep === 2 ? (
                <div className="space-y-5">
                  <Toggle label="Dynamic captions" detail="Burn word-timed captions into every exported MP4." checked={draft.captionsEnabled} onChange={(value) => updateDraft("captionsEnabled", value)} />
                  <Toggle label="Remove filler words" detail="Hide common fillers without cutting the audio." checked={draft.removeFillers} onChange={(value) => updateDraft("removeFillers", value)} />
                  <Toggle
                    label="Face tracking"
                    detail="Lock the 9:16 crop to one selected person and skip shots without them."
                    checked={draft.faceTracking !== "off"}
                    onChange={(value) => updateDraft("faceTracking", value ? "smooth" : "off")}
                  />
                  {draft.faceTracking !== "off" ? (
                    <div className="grid gap-4 sm:grid-cols-2">
                      <div>
                        <p className="mb-1.5 text-[10px] font-semibold text-slate-500">Tracking feel</p>
                        <div className="flex rounded-md border border-slate-200 bg-slate-100/70 p-1">
                          {(["smooth", "responsive"] as FaceTrackingMode[]).map((value) => (
                            <Segment key={value} value={value} current={draft.faceTracking} onClick={(next) => updateDraft("faceTracking", next)}>
                              {value === "smooth" ? "Smooth" : "Responsive"}
                            </Segment>
                          ))}
                        </div>
                      </div>
                      <div>
                        <p className="mb-1.5 text-[10px] font-semibold text-slate-500">Scene mode</p>
                        <div className="flex rounded-md border border-slate-200 bg-slate-100/70 p-1">
                          {(["strict", "flexible"] as SceneMode[]).map((value) => (
                            <Segment key={value} value={value} current={draft.sceneMode} onClick={(next) => updateDraft("sceneMode", next)}>
                              {value === "strict" ? "Strict" : "Flexible"}
                            </Segment>
                          ))}
                        </div>
                      </div>
                    </div>
                  ) : null}
                  <div className="grid gap-4 sm:grid-cols-2">
                    <label className="text-[10px] font-semibold text-slate-500">Caption font
                      <select value={draft.font} onChange={(event) => updateDraft("font", event.target.value)} className="mt-1.5 h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-[11px] font-medium outline-none">
                        <option>Impact</option><option>Arial Black</option><option>Helvetica</option>
                      </select>
                    </label>
                    <label className="text-[10px] font-semibold text-slate-500">Position
                      <select value={draft.position} onChange={(event) => updateDraft("position", event.target.value as CaptionPosition)} className="mt-1.5 h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-[11px] font-medium outline-none">
                        <option value="top">Top</option><option value="centre">Middle</option><option value="bottom">Bottom safe zone</option>
                      </select>
                    </label>
                    <div>
                      <p className="mb-1.5 text-[10px] font-semibold text-slate-500">Aspect ratio</p>
                      <div className="flex rounded-md border border-slate-200 bg-slate-100/70 p-1">
                        {(["9:16", "1:1", "16:9"] as ClipAspect[]).map((value) => <Segment key={value} value={value} current={draft.aspect} onClick={(next) => updateDraft("aspect", next)}>{value}</Segment>)}
                      </div>
                    </div>
                    <div>
                      <p className="mb-1.5 text-[10px] font-semibold text-slate-500">Subject focus</p>
                      <div className="flex rounded-md border border-slate-200 bg-slate-100/70 p-1">
                        {(["left", "center", "right"] as CropFocus[]).map((value) => <Segment key={value} value={value} current={draft.cropFocus} onClick={(next) => updateDraft("cropFocus", next)}>{value}</Segment>)}
                      </div>
                    </div>
                  </div>
                  <div className={cn("relative mx-auto w-full overflow-hidden rounded-md bg-[#111318] shadow-sm", draft.aspect === "9:16" ? "aspect-[9/16] max-h-[220px]" : draft.aspect === "1:1" ? "aspect-square max-h-[220px]" : "aspect-video max-h-[180px]")}>
                    <div className="absolute inset-0 bg-[linear-gradient(145deg,#3b4350,#090a0d_72%)]" />
                    {draft.captionsEnabled ? (
                      <p className={cn("absolute left-[7%] right-[7%] text-center font-black uppercase leading-none text-white [text-shadow:-2px_-2px_0_#000,2px_-2px_0_#000,-2px_2px_0_#000,2px_2px_0_#000]", draft.position === "top" ? "top-[18%]" : draft.position === "centre" ? "top-1/2 -translate-y-1/2" : "bottom-[16%]")} style={{ fontFamily: draft.font, fontSize: `${Math.min(18, draft.fontSize * .2)}px`, color: draft.colour }}>
                        YOUR BEST MOMENT
                      </p>
                    ) : null}
                  </div>
                </div>
              ) : null}
              {wizardStep === 3 ? (
                <div>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div>
                      <p className="mb-1.5 text-[10px] font-semibold text-slate-500">Clip length</p>
                      <div className="flex rounded-md border border-slate-200 bg-slate-100/70 p-1">
                        {[15, 30, 45, 60].map((value) => <Segment key={value} value={value} current={draft.clipLength} onClick={(next) => updateDraft("clipLength", next)}>{value}s</Segment>)}
                      </div>
                    </div>
                    <div>
                      <p className="mb-1.5 text-[10px] font-semibold text-slate-500">Number of clips</p>
                      <div className="flex rounded-md border border-slate-200 bg-slate-100/70 p-1">
                        {[1, 3, 5, 8].map((value) => <Segment key={value} value={value} current={draft.clipCount} onClick={(next) => updateDraft("clipCount", next)}>{value}</Segment>)}
                      </div>
                    </div>
                  </div>
                  <dl className="mt-6 divide-y divide-slate-100 rounded-md border border-slate-200 bg-white px-4 text-[11px]">
                    {[["Source", draft.source.name || draft.source.url || "Ready"], ["Moments", objective], ["Output", `${draft.clipCount} clips · ${draft.clipLength}s`], ["Face tracking", draft.faceTracking === "off" ? "Off" : `${draft.faceTracking} · ${draft.sceneMode}`]].map(([label, value]) => (
                      <div key={label} className="flex justify-between gap-4 py-3">
                        <dt className="text-slate-400">{label}</dt>
                        <dd className="max-w-[70%] truncate text-right font-medium text-slate-700">{value}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
              ) : null}
              {error ? <p className="mt-4 text-[10px] font-medium text-red-600">{error}</p> : null}
            </div>

            <div className="mt-7 flex items-center justify-between">
              <button type="button" disabled={wizardStep === 0} onClick={() => setWizardStep((step) => Math.max(0, step - 1))} className="text-[10px] font-semibold text-slate-400 hover:text-slate-950 disabled:opacity-0">
                Back
              </button>
              {wizardStep < 3 ? (
                <button type="button" disabled={!canContinue} onClick={() => setWizardStep((step) => Math.min(3, step + 1))} className="h-10 rounded-md bg-slate-950 px-5 text-[10px] font-semibold text-white transition-transform active:scale-[.98] disabled:opacity-35">
                  Continue
                </button>
              ) : (
                <button type="button" disabled={!sourceReady || !objective} onClick={() => void run()} className="flex h-11 items-center gap-2 rounded-md bg-slate-950 px-6 text-[10px] font-semibold text-white transition-transform active:scale-[.98] disabled:opacity-35">
                  <WandSparkles className="h-3.5 w-3.5" />
                  Generate clips
                </button>
              )}
            </div>
          </motion.section>
        </div>
      </div>
    </div>
  );

  const resultsView = (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-[1280px] flex-col overflow-hidden rounded-3xl border border-slate-200/80 bg-[#f8fafc] shadow-sm">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-slate-200/80 bg-white px-4 sm:px-5">
        <button type="button" onClick={() => setView("create")} className="flex h-8 items-center gap-2 rounded-full px-3 text-[11px] font-medium text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900"><Plus className="h-3.5 w-3.5" />New generation</button>
        <span className="hidden text-[11px] text-slate-300 sm:block">/</span>
        <span className="hidden text-[11px] font-medium text-slate-700 sm:block">{results.length} ranked clips</span>
        <div className="ml-auto flex items-center gap-1.5">
          <button type="button" onClick={() => void run()} className="hidden h-8 items-center gap-1.5 rounded-full px-3 text-[11px] font-medium text-slate-500 transition-colors hover:bg-slate-100 sm:flex"><RefreshCw className="h-3.5 w-3.5" />Generate more</button>
          <button type="button" disabled={!selectedResults.size} onClick={bulkExport} className="flex h-8 items-center gap-1.5 rounded-full bg-slate-900 px-4 text-[11px] font-semibold text-white shadow-sm transition-colors hover:bg-slate-800 disabled:opacity-30"><Download className="h-3.5 w-3.5" />Export selected</button>
        </div>
      </header>
      {error ? (
        <div className="flex items-start gap-2 border-b border-amber-200 bg-amber-50 px-4 py-2.5 text-[11px] leading-4 text-amber-800 sm:px-5">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1">{error}</span>
          <button type="button" onClick={() => setError("")} className="shrink-0 font-medium text-amber-900/70 hover:text-amber-950">Dismiss</button>
        </div>
      ) : null}
      <div className="grid min-h-0 flex-1 lg:grid-cols-[170px_minmax(0,1fr)]">
        <aside className="hidden min-h-0 border-r border-slate-200/80 bg-white p-4 lg:block">
          <p className="text-[10px] font-semibold uppercase tracking-[.12em] text-slate-400">Review clips</p>
          <label className="mt-4 flex h-10 items-center gap-2 rounded-2xl border border-slate-200/80 bg-white px-3 shadow-sm transition-[border-color,box-shadow] duration-200 focus-within:border-slate-300 focus-within:ring-2 focus-within:ring-slate-200">
            <Search className="h-3.5 w-3.5 text-slate-400" />
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search transcript" className="min-w-0 flex-1 bg-transparent text-[11px] outline-none placeholder:text-slate-400" />
          </label>
          <label className="mt-4 block text-[11px] font-medium text-slate-500">
            Sort by
            <select value={sortMode} onChange={(event) => setSortMode(event.target.value as SortMode)} className="mt-1.5 h-10 w-full rounded-2xl border border-slate-200/80 bg-white px-3 text-[11px] shadow-sm outline-none transition-[border-color,box-shadow] duration-200 focus:border-slate-300 focus:ring-2 focus:ring-slate-200">
              <option value="score">Clip Potential</option>
              <option value="duration">Duration</option>
              <option value="source">Source position</option>
            </select>
          </label>
          <div className="mt-5 border-t border-slate-200 pt-4">
            <p className="text-[10px] font-medium uppercase tracking-[0.06em] text-slate-400">Batch selection</p>
            <button type="button" onClick={() => setSelectedResults(selectedResults.size === results.length ? new Set() : new Set(results.map((result) => result.id)))} className="mt-2 text-[11px] font-medium text-slate-700 transition-colors hover:text-slate-950">{selectedResults.size === results.length ? "Clear all" : "Select all clips"}</button>
          </div>
        </aside>

        <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(0,1fr)_minmax(320px,0.95fr)]">
          <main className="min-h-0 overflow-y-auto p-3 sm:p-4">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <p className="text-[13px] font-semibold text-slate-900">Generated clips</p>
                <p className="mt-0.5 text-[11px] text-slate-400">Distinct source moments, already captioned and exported</p>
              </div>
              <div className="flex rounded-full border border-slate-200/80 bg-white p-1 shadow-sm">
                <button type="button" onClick={() => setResultLayout("grid")} className={cn("grid h-7 w-7 place-items-center rounded-full transition-colors", resultLayout === "grid" ? "bg-slate-100 text-slate-950" : "text-slate-400 hover:text-slate-600")} aria-label="Grid view"><Grid2X2 className="h-3.5 w-3.5" /></button>
                <button type="button" onClick={() => setResultLayout("list")} className={cn("grid h-7 w-7 place-items-center rounded-full transition-colors", resultLayout === "list" ? "bg-slate-100 text-slate-950" : "text-slate-400 hover:text-slate-600")} aria-label="List view"><List className="h-3.5 w-3.5" /></button>
              </div>
            </div>
            <div className={cn(resultLayout === "grid" ? "grid gap-3 sm:grid-cols-2 xl:grid-cols-3" : "space-y-2")}>
              {filteredResults.map((result) => (
                <div key={result.id} className="relative">
                  <label className="absolute right-2 top-2 z-20 grid h-6 w-6 place-items-center rounded-full bg-white/90 shadow-sm">
                    <input type="checkbox" checked={selectedResults.has(result.id)} onChange={() => setSelectedResults((current) => { const next = new Set(current); if (next.has(result.id)) next.delete(result.id); else next.add(result.id); return next; })} className="h-3.5 w-3.5 accent-slate-800" aria-label={`Select ${result.title}`} />
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
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-[10px] font-semibold uppercase tracking-[.12em] text-slate-400">Clip studio</p>
                    <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">
                      Score {clipPotentialScore(selected)}
                    </span>
                  </div>

                  <div className="mt-3 grid gap-3 xl:grid-cols-[minmax(0,220px)_minmax(0,1fr)]">
                    <div className="overflow-hidden rounded-md border border-slate-200 bg-slate-950 shadow-[0_12px_28px_rgba(15,23,42,.12)]">
                      <div className="relative aspect-[9/16] max-h-[360px]">
                        <video
                          key={selected.output}
                          ref={previewVideoRef}
                          controls
                          playsInline
                          preload="metadata"
                          src={outputUrl(selected.output)}
                          onTimeUpdate={(event) => setPreviewTimeMs(Math.round(event.currentTarget.currentTime * 1000))}
                          className="h-full w-full object-cover"
                        />
                        {liveOverlayFaces.length && draft.faceTracking !== "off" ? (
                          <div className="pointer-events-none absolute inset-0">
                            {liveOverlayFaces.map((face) => {
                              const active = selectedFaceId === face.id || (!selectedFaceId && face.id === liveOverlayFaces[0]?.id);
                              return (
                                <button
                                  key={face.id}
                                  type="button"
                                  onClick={() => setSelectedFaceId(face.id)}
                                  className={cn(
                                    "pointer-events-auto absolute rounded-md border-2 transition-[left,top,width,height,border-color,box-shadow] duration-200 ease-[cubic-bezier(0.16,1,0.3,1)]",
                                    active
                                      ? "border-sky-300 shadow-[0_0_0_1px_rgba(125,211,252,.55)]"
                                      : "border-white/50 hover:border-white",
                                  )}
                                  style={{
                                    left: `${face.bbox.x * 100}%`,
                                    top: `${face.bbox.y * 100}%`,
                                    width: `${face.bbox.width * 100}%`,
                                    height: `${face.bbox.height * 100}%`,
                                  }}
                                  aria-label={`Select ${face.label}`}
                                >
                                  <span className={cn(
                                    "absolute -top-5 left-0 rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.06em]",
                                    active ? "bg-sky-300 text-slate-900" : "bg-black/55 text-white",
                                  )}>
                                    {active ? "Primary" : face.label}
                                  </span>
                                </button>
                              );
                            })}
                          </div>
                        ) : null}
                      </div>
                    </div>

                    <div className="min-w-0">
                      <h2 className="text-[15px] font-semibold leading-5 text-slate-900">{selected.title}</h2>
                      {selected.reason ? <p className="mt-1.5 text-[11px] leading-5 text-slate-500">{selected.reason}</p> : null}

                      <div className="mt-4">
                        <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-400">Face tracking</p>
                        <div className="mt-2 flex rounded-md border border-slate-200 bg-slate-100/70 p-1">
                          {(["off", "smooth", "responsive"] as FaceTrackingMode[]).map((value) => (
                            <Segment key={value} value={value} current={draft.faceTracking} onClick={(next) => updateDraft("faceTracking", next)}>
                              {value === "off" ? "Off" : value === "smooth" ? "Smooth" : "Responsive"}
                            </Segment>
                          ))}
                        </div>
                        <div className="mt-2 flex rounded-md border border-slate-200 bg-slate-100/70 p-1">
                          {(["strict", "flexible"] as SceneMode[]).map((value) => (
                            <Segment key={value} value={value} current={draft.sceneMode} onClick={(next) => updateDraft("sceneMode", next)}>
                              {value === "strict" ? "Strict" : "Flexible"}
                            </Segment>
                          ))}
                        </div>
                        <p className="mt-2 text-[10px] leading-4 text-slate-400">Tap a face square in the preview to set the primary person, then re-render.</p>
                        {(selected.available_faces?.length || 0) > 0 ? (
                          <div className="mt-2 flex flex-wrap gap-2">
                            {selected.available_faces!.map((face) => {
                              const thumb = face.thumbnailUrl || face.thumbnail || (selected.artifact_id ? `/api/clipper/artifact/${selected.artifact_id}/faces/${face.id}.jpg` : "");
                              const active = selectedFaceId === face.id;
                              return (
                                <button
                                  key={face.id}
                                  type="button"
                                  onClick={() => setSelectedFaceId(face.id)}
                                  className={cn(
                                    "group flex items-center gap-2 rounded-md border px-1.5 py-1.5 text-[10px] font-medium transition-[border-color,background-color,transform] duration-200",
                                    active
                                      ? "border-slate-900 bg-slate-900 text-white"
                                      : "border-slate-200 bg-white text-slate-600 hover:border-slate-300",
                                  )}
                                >
                                  <span className={cn("relative h-8 w-8 overflow-hidden rounded bg-slate-200", active && "ring-1 ring-white/70")}>
                                    {thumb ? (
                                      <img src={thumb} alt="" className="h-full w-full object-cover" />
                                    ) : (
                                      <span className="grid h-full w-full place-items-center text-[9px] text-slate-400">Face</span>
                                    )}
                                  </span>
                                  <span className="pr-1">{face.label || face.personId || face.id}</span>
                                </button>
                              );
                            })}
                          </div>
                        ) : null}
                      </div>

                      <div className="mt-4 grid grid-cols-2 gap-2 text-[11px]">
                        <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
                          <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-400">Start</p>
                          <p className="mt-1 font-medium text-slate-700">{selected.source_start || "—"}</p>
                        </div>
                        <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
                          <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-400">End</p>
                          <p className="mt-1 font-medium text-slate-700">{selected.source_end || "—"}</p>
                        </div>
                      </div>

                      <div className="mt-4">
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-400">Timed subtitles</p>
                          <span className="text-[10px] text-slate-400">{selected.clip_duration || "—"} · {fileSize(selected.file_size)}</span>
                        </div>
                        <div className="mt-2 max-h-[260px] space-y-1 overflow-y-auto rounded-2xl border border-slate-200 bg-slate-50/80 p-2">
                          {captionWords.length ? captionWords.map((word, index) => {
                            const label = wordText(word);
                            return (
                              <div key={`${word.start}-${index}`} className="grid grid-cols-[64px_minmax(0,1fr)] items-center gap-2 rounded-xl bg-white px-2.5 py-1.5 text-[11px] shadow-sm">
                                <span className="font-mono text-[10px] text-slate-400">{Number(word.start).toFixed(1)}s</span>
                                <input
                                  value={label}
                                  onChange={(event) => {
                                    const value = event.target.value;
                                    setCaptionWords((current) => current.map((item, itemIndex) => (
                                      itemIndex === index ? { ...item, word: value, text: value } : item
                                    )));
                                  }}
                                  onBlur={persistSelectedEdits}
                                  className="w-full bg-transparent text-[12px] leading-4 text-slate-700 outline-none"
                                />
                              </div>
                            );
                          }) : (
                            <p className="px-2 py-3 text-[11px] text-slate-400">No timed words yet — generate a clip with captions enabled.</p>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
                <div className="grid gap-2 border-t border-slate-200 p-3">
                  <a href={outputUrl(selected.output)} download className="flex h-10 items-center justify-center gap-2 rounded-full bg-slate-900 text-[11px] font-semibold text-white shadow-sm transition-colors hover:bg-slate-800"><Download className="h-3.5 w-3.5" />Download MP4</a>
                  <button type="button" onClick={() => void rewriteSelectedCaption()} disabled={rewriteBusy || refineBusy || !selected.artifact_id} className="flex h-10 items-center justify-center gap-2 rounded-full border border-slate-200 bg-white text-[11px] font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-50">
                    <WandSparkles className="h-3.5 w-3.5" />{rewriteBusy || refineBusy ? "Rendering…" : "Rewrite & re-render"}
                  </button>
                  <button type="button" onClick={() => void refineSelected()} disabled={refineBusy || !selected.artifact_id} className="flex h-10 items-center justify-center gap-2 rounded-full text-[11px] font-medium text-slate-600 transition-colors hover:bg-slate-100 disabled:opacity-50">
                    <SlidersHorizontal className="h-3.5 w-3.5" />{refineBusy ? "Updating crop…" : "Apply face tracking & re-render"}
                  </button>
                </div>
              </>
            ) : (
              <div className="grid flex-1 place-items-center p-8 text-center">
                <div>
                  <p className="text-[13px] font-semibold text-slate-800">Select a clip</p>
                  <p className="mt-1 text-[11px] text-slate-400">Preview, edit timed subtitles, and refine tracking here.</p>
                </div>
              </div>
            )}
          </aside>
        </div>
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
