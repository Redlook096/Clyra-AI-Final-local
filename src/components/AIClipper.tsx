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
type ClipperEngine = "clyra-vision" | "autoclip";
type ClipAspect = "9:16" | "1:1" | "16:9";
type CaptionPosition = "top" | "centre" | "bottom";
type SubtitleStyle = "word" | "phrase-highlight";
type CaptionCollisionMode = "auto" | "keep-existing" | "allow-overlap";
type RenderQuality = "premium" | "balanced" | "master";
type CropFocus = "left" | "center" | "right";
type FaceTrackingMode = "off" | "smooth" | "responsive";
type FaceTrackingPreset = "auto" | "follow" | "select" | "locked" | "none";
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

type AutoClipRunnerStatus = {
  configured: boolean;
  available: boolean;
  detail: string;
  version?: string;
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
  captions_enabled?: boolean;
  caption_position?: CaptionPosition;
  caption_collision?: {
    detected?: boolean;
    action?: "relocated" | "kept-existing" | "preserved";
    placement?: CaptionPosition;
    reason?: string;
  };
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
  /** Clyra Vision stays default because it verifies visual event evidence. */
  engine: ClipperEngine;
  objective: string;
  customObjective: string;
  clipLength: number;
  clipCount: number;
  aspect: ClipAspect;
  cropFocus: CropFocus;
  faceTracking: FaceTrackingMode;
  /** Local-only framing intent. The backend continues to receive the established tracking fields. */
  trackingPreset?: FaceTrackingPreset;
  sceneMode: SceneMode;
  selectedPersonId: string;
  captionsEnabled: boolean;
  removeFillers: boolean;
  font: string;
  fontSize: number;
  colour: string;
  position: CaptionPosition;
  /** Percentage coordinates on the logical output canvas. */
  captionX: number;
  captionY: number;
  subtitleStyle: SubtitleStyle;
  captionCollisionMode: CaptionCollisionMode;
  renderQuality: RenderQuality;
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
  { id: "captions", label: "Source & transcript", detail: "Read source metadata and available spoken context" },
  { id: "audio", label: "Audio intelligence", detail: "Measure energy, silence and pacing from the real source" },
  { id: "vision", label: "Visual intelligence", detail: "Adaptively sample motion and scene-change evidence" },
  { id: "ocr", label: "On-screen text", detail: "Read useful text from sampled visual moments" },
  { id: "timeline", label: "Timeline knowledge graph", detail: "Combine transcript, audio and visual evidence by second" },
  { id: "analyze", label: "Moment analysis", detail: "Find complete candidate moments using the available evidence" },
  { id: "rank", label: "Multi-modal ranking", detail: "Compare candidates across transcript, audio and visual signals" },
  { id: "verify", label: "Event verification", detail: "Confirm requested visual events before any clip is created" },
  { id: "clip", label: "Clip & framing", detail: "Extract candidates and apply the requested crop" },
  { id: "transcribe", label: "Word timing", detail: "Align spoken words for accurate captions" },
  { id: "subtitles", label: "Caption layout", detail: "Build frame-safe caption beats" },
  { id: "render", label: "Render & validate", detail: "Encode playable MP4 clips" },
  { id: "complete", label: "Ready to review", detail: "Open the ranked clips in the studio" },
] as const;

type PipelineStageId = (typeof PIPELINE)[number]["id"];

type AnalysisActivity = {
  id: string;
  stage: PipelineStageId;
  status: string;
  message: string;
  metadata?: string;
};

const PIPELINE_STEP_ALIASES: Record<string, PipelineStageId> = {
  captions: "captions",
  source: "captions",
  source_audit: "captions",
  download: "captions",
  metadata: "captions",
  transcript: "captions",
  audio: "audio",
  analyze: "analyze",
  analysis: "analyze",
  scenes: "vision",
  scene: "vision",
  vision: "vision",
  ocr: "ocr",
  objects: "vision",
  timeline: "timeline",
  rank: "rank",
  ranking: "rank",
  verify: "verify",
  verification: "verify",
  event_verification: "verify",
  candidates: "analyze",
  clip: "clip",
  crop: "clip",
  face: "clip",
  faces: "clip",
  tracking: "clip",
  reframe: "clip",
  transcribe: "transcribe",
  timing: "transcribe",
  subtitles: "subtitles",
  captions_layout: "subtitles",
  render: "render",
  encode: "render",
  result: "render",
  complete: "complete",
};

const FACE_TRACKING_PRESETS: Array<{ id: FaceTrackingPreset; label: string; detail: string }> = [
  { id: "auto", label: "Auto", detail: "Let Clyra adapt to the dominant subject." },
  { id: "follow", label: "Follow Main Speaker", detail: "Keep a steady lock on the primary speaker." },
  { id: "select", label: "Select Face", detail: "Choose the person Clyra should prioritise." },
  { id: "locked", label: "Locked Crop", detail: "Frame the subject once, then keep the shot still." },
  { id: "none", label: "No Follow", detail: "Hold the composition; snap only for a verified speaker or exit change." },
];

const DEFAULT_DRAFT: ClipDraft = {
  source: { mode: "url", url: "" },
  engine: "clyra-vision",
  objective: "viral",
  customObjective: "",
  clipLength: 30,
  clipCount: 3,
  aspect: "9:16",
  cropFocus: "center",
  // Default to a stable, one-time composition. Clyra uses face detection to
  // frame the subject, then deliberately keeps the crop still unless the user
  // opts into a Follow/Select tracking mode.
  // Auto is the production default: it builds an offline per-frame camera path
  // after the moment is selected. Locked remains an explicit user choice.
  faceTracking: "responsive",
  trackingPreset: "auto",
  sceneMode: "flexible",
  selectedPersonId: "",
  captionsEnabled: true,
  removeFillers: true,
  font: "Impact",
  fontSize: 74,
  colour: "#FFFFFF",
  position: "bottom",
  captionX: 50,
  captionY: 78,
  subtitleStyle: "phrase-highlight",
  captionCollisionMode: "auto",
  renderQuality: "premium",
};

const DRAFT_KEY = "clyra.clip.draft.v2";
const RESULT_KEY = "clyra.clip.results.v2";

function pipelineStageFor(step?: string): PipelineStageId | null {
  const normalized = String(step || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  return PIPELINE_STEP_ALIASES[normalized] || null;
}

function faceTrackingPresetFor(draft: Pick<ClipDraft, "faceTracking" | "trackingPreset" | "sceneMode" | "selectedPersonId">): FaceTrackingPreset {
  if (draft.trackingPreset === "locked") return "locked";
  if (draft.faceTracking === "off") return "none";
  if (draft.trackingPreset === "select") return "select";
  if (draft.trackingPreset === "follow") return "follow";
  if (draft.trackingPreset === "auto") return "auto";
  if (draft.selectedPersonId) return "select";
  if (draft.sceneMode === "strict") return "follow";
  return "auto";
}

function applyFaceTrackingPreset(preset: FaceTrackingPreset, current: ClipDraft): ClipDraft {
  if (preset === "auto") {
    return { ...current, trackingPreset: preset, faceTracking: "responsive", sceneMode: "flexible", selectedPersonId: "" };
  }
  if (preset === "follow") {
    return { ...current, trackingPreset: preset, faceTracking: "smooth", sceneMode: "strict", selectedPersonId: "" };
  }
  if (preset === "select") {
    return { ...current, trackingPreset: preset, faceTracking: "smooth", sceneMode: "strict" };
  }
  if (preset === "locked") {
    return { ...current, trackingPreset: preset, faceTracking: "smooth", sceneMode: "flexible", selectedPersonId: "" };
  }
  return { ...current, trackingPreset: preset, faceTracking: "off", sceneMode: "flexible", selectedPersonId: "" };
}

function faceTrackingLabel(draft: Pick<ClipDraft, "faceTracking" | "trackingPreset" | "sceneMode" | "selectedPersonId">) {
  return FACE_TRACKING_PRESETS.find((preset) => preset.id === faceTrackingPresetFor(draft))?.label || "Auto";
}

function reframeModeFor(draft: Pick<ClipDraft, "faceTracking" | "trackingPreset" | "selectedPersonId">) {
  // "No Follow" disables continuous face/body camera movement, not visual
  // understanding.  Keep the smart scene mode enabled so a person leaving
  // the crop or a verified speaker change can recompose the vertical shot.
  if (draft.faceTracking === "off") return "auto" as const;
  if (draft.trackingPreset === "locked") return "locked_subject" as const;
  if (draft.trackingPreset === "follow" || draft.trackingPreset === "select" || draft.selectedPersonId) return "single_speaker" as const;
  return "auto" as const;
}

function speakerModeFor(draft: Pick<ClipDraft, "trackingPreset" | "selectedPersonId">) {
  return draft.trackingPreset === "select" || Boolean(draft.selectedPersonId) ? "locked" as const : "auto" as const;
}

function FaceTrackingPresetControl({
  value,
  onChange,
  compact = false,
}: {
  value: FaceTrackingPreset;
  onChange: (preset: FaceTrackingPreset) => void;
  compact?: boolean;
}) {
  return (
    <div className={cn("flex flex-wrap gap-1.5", compact ? "gap-1" : "gap-1.5") } role="radiogroup" aria-label="Face tracking mode">
      {FACE_TRACKING_PRESETS.map((preset) => {
        const active = value === preset.id;
        return (
          <button
            key={preset.id}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(preset.id)}
            title={preset.detail}
            className={cn(
              "min-w-0 rounded-full border px-3 py-1.5 text-left text-[10px] font-semibold transition-[border-color,background-color,color,transform] duration-150 active:scale-[.98]",
              active
                ? "border-slate-900 bg-slate-950 text-white"
                : "border-slate-200 bg-white text-slate-500 hover:border-slate-300 hover:bg-slate-50 hover:text-slate-800",
            )}
          >
            <span className="block truncate">{preset.label}</span>
          </button>
        );
      })}
      {!compact ? <p className="basis-full pt-1 text-[10px] leading-4 text-slate-400">Choose a steady tracking behaviour. You can refine the selected face after clips are ready.</p> : null}
    </div>
  );
}

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
      <div className="grid grid-cols-2 rounded-full border border-slate-200/90 bg-slate-100/80 p-1">
        {([
          { mode: "url" as const, label: "Video URL", icon: Link2 },
          { mode: "upload" as const, label: "Upload", icon: Upload },
        ]).map((option) => {
          const Icon = option.icon;
          return (
            <button key={option.mode} type="button" onClick={() => onSource({ ...source, mode: option.mode })} className={cn("flex h-9 items-center justify-center gap-2 rounded-full text-[11px] font-medium transition-[background-color,color,transform] duration-200 active:scale-[.985]", source.mode === option.mode ? "bg-white text-slate-900 ring-1 ring-slate-200/80" : "text-slate-400 hover:text-slate-600")}>
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
            <div className="mt-2 flex h-11 items-center rounded-xl border border-slate-200/90 bg-white px-3.5 transition-[border-color,box-shadow] duration-200 focus-within:border-slate-400 focus-within:ring-2 focus-within:ring-slate-100">
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
                className="clyra-clip-source-preview mt-4 overflow-hidden rounded-xl border border-slate-200/90 bg-slate-950"
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
          className={cn("mt-4 flex min-h-[180px] flex-col items-center justify-center rounded-xl border border-dashed px-6 text-center transition-colors duration-200", dragging ? "border-slate-400 bg-slate-50/60" : "border-slate-300 bg-white")}
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
              <button type="button" onClick={() => fileInput.current?.click()} className="mt-4 h-9 rounded-full border border-slate-200/90 bg-white px-5 text-[11px] font-medium text-slate-600 transition-colors hover:bg-slate-50">Choose video</button>
            </>
          )}
          <input ref={fileInput} type="file" accept="video/mp4,video/quicktime,video/webm,video/x-matroska,.m4v" className="hidden" onChange={(event) => acceptFile(event.target.files?.[0])} />
        </div>
      )}
    </div>
  );
}

function PipelineGlyph({ stage, className }: { stage: PipelineStageId; className?: string }) {
  const Icon = stage === "captions"
    ? FileVideo2
    : stage === "audio"
      ? MessageSquare
      : stage === "vision"
        ? Video
        : stage === "ocr"
          ? Search
          : stage === "timeline"
            ? SlidersHorizontal
            : stage === "analyze" || stage === "rank"
      ? Search
      : stage === "clip"
        ? Video
        : stage === "transcribe"
          ? MessageSquare
          : stage === "subtitles"
            ? WandSparkles
            : stage === "render"
              ? SlidersHorizontal
              : Check;
  return <Icon className={className} />;
}

function ProcessingScreen({
  progress,
  status,
  activeStep,
  activities,
  readyCount,
  elapsed,
  onCancel,
}: {
  progress: number;
  status: string;
  activeStep: PipelineStageId;
  activities: AnalysisActivity[];
  readyCount: number;
  elapsed: number;
  onCancel: () => void;
}) {
  const activeIndex = Math.max(0, PIPELINE.findIndex((stage) => stage.id === activeStep));
  const activeStage = PIPELINE[activeIndex] || PIPELINE[0];
  const finishing = progress >= 96 || activeStep === "complete";
  const latestActivity = activities.at(-1);

  return createPortal(
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[9999] grid place-items-center bg-[#f7f8fa]/78 px-4 py-5 backdrop-blur-[10px] sm:px-6"
    >
      <motion.section
        data-testid="clipper-processing"
        initial={{ opacity: 0, y: 12, scale: 0.985 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
        className="w-full max-w-[720px] overflow-hidden rounded-[20px] border border-slate-200/90 bg-white shadow-[0_20px_54px_rgba(15,23,42,.10)]"
      >
        <div className="border-b border-slate-100 px-5 py-5 sm:px-6 sm:py-5">
          <div className="flex items-start gap-3.5">
            <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-slate-950 text-white">
              {finishing ? <Check className="h-4 w-4" /> : <Loader2 className="h-4 w-4 animate-spin" />}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400">Clyra video intelligence</p>
                <span className="h-1 w-1 rounded-full bg-slate-300" />
                <span className="text-[10px] font-medium tabular-nums text-slate-400">{elapsed}s elapsed</span>
              </div>
              <h2 className="mt-1 text-[19px] font-semibold tracking-[-0.035em] text-slate-950 sm:text-[21px]">
                {finishing ? "Finalising your clips" : activeStage.label}
              </h2>
              <p role="status" className="mt-1.5 max-w-2xl text-[12px] leading-5 text-slate-500">
                {latestActivity?.message || status || "Waiting for the source pipeline to report progress…"}
              </p>
            </div>
            <div className="shrink-0 text-right">
              <p className="text-[18px] font-semibold tabular-nums tracking-[-0.04em] text-slate-900">{Math.round(progress)}%</p>
              <p className="mt-0.5 text-[9px] font-medium uppercase tracking-[0.1em] text-slate-400">{readyCount ? `${readyCount} ready` : "in progress"}</p>
            </div>
          </div>
          <div className="relative mt-4 h-1 overflow-hidden rounded-full bg-slate-100">
            <motion.div
              className="relative h-full overflow-hidden rounded-full bg-slate-950"
              animate={{ width: `${Math.max(3, Math.min(100, progress))}%` }}
              transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
            >
              {!finishing ? <motion.span className="absolute inset-y-0 w-16 bg-white/35 blur-[2px]" animate={{ x: [-42, 260] }} transition={{ repeat: Infinity, duration: 1.2, ease: "linear" }} /> : null}
            </motion.div>
          </div>
        </div>

        <div className="grid gap-0 md:grid-cols-[minmax(0,1.08fr)_minmax(225px,.92fr)]">
          <div className="border-b border-slate-100 p-5 md:border-b-0 md:border-r sm:p-5">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <p className="text-[12px] font-semibold text-slate-800">Analysis pipeline</p>
                <p className="mt-0.5 text-[10px] text-slate-400">Only completed and live stages are marked.</p>
              </div>
              <span className="rounded-full bg-slate-100 px-2 py-1 text-[9px] font-semibold text-slate-500">{activeIndex + 1} / {PIPELINE.length}</span>
            </div>
            <ol data-testid="clipper-analysis-timeline" className="space-y-0.5">
              {PIPELINE.map((stage, index) => {
                const active = stage.id === activeStep && !finishing;
                const complete = index < activeIndex || (stage.id === "complete" && finishing);
                return (
                  <li key={stage.id} className={cn("flex items-center gap-2.5 rounded-lg px-2 py-2 transition-colors", active ? "bg-slate-50" : "") }>
                    <span className={cn(
                      "grid h-6 w-6 shrink-0 place-items-center rounded-full border transition-colors",
                      complete ? "border-emerald-200 bg-emerald-50 text-emerald-600" : active ? "border-slate-900 bg-slate-950 text-white" : "border-slate-200 bg-white text-slate-300",
                    )}>
                      {complete ? <Check className="h-3.5 w-3.5" /> : active ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PipelineGlyph stage={stage.id} className="h-3.5 w-3.5" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className={cn("block text-[10px] font-semibold", active || complete ? "text-slate-800" : "text-slate-400")}>{stage.label}</span>
                      <span className="mt-0.5 block truncate text-[9px] leading-4 text-slate-400">{stage.detail}</span>
                    </span>
                    {active ? <span className="text-[9px] font-semibold text-slate-500">Live</span> : complete ? <span className="text-[9px] font-semibold text-emerald-600">Done</span> : null}
                  </li>
                );
              })}
            </ol>
          </div>

          <div className="p-5 sm:p-5">
            <p className="text-[12px] font-semibold text-slate-800">Live activity</p>
            <p className="mt-0.5 text-[10px] leading-4 text-slate-400">Updates come directly from the clip engine.</p>
            <div className="mt-3 max-h-[278px] space-y-0.5 overflow-y-auto pr-1">
              {activities.length ? activities.slice(-6).reverse().map((activity) => (
                <motion.div
                  key={activity.id}
                  initial={{ opacity: 0, y: 5 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
                  className="border-l border-slate-200 px-2.5 py-2"
                >
                  <div className="flex items-start gap-2">
                    <span className="mt-0.5 text-slate-400"><PipelineGlyph stage={activity.stage} className="h-3.5 w-3.5" /></span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[10px] font-semibold text-slate-700">{PIPELINE.find((stage) => stage.id === activity.stage)?.label}</span>
                      <span className="mt-0.5 block text-[10px] leading-4 text-slate-500">{activity.message}</span>
                    </span>
                    {activity.metadata ? <span className="shrink-0 text-[9px] font-medium text-slate-400">{activity.metadata}</span> : null}
                  </div>
                </motion.div>
              )) : (
                <div className="border-l border-slate-200 px-3 py-3 text-[10px] leading-5 text-slate-400">Connecting to the local clip engine…</div>
              )}
            </div>
            {!finishing ? <button type="button" onClick={onCancel} className="mt-5 h-9 rounded-full border border-slate-200 px-4 text-[10px] font-semibold text-slate-500 transition-colors hover:bg-slate-50 hover:text-slate-800">Cancel analysis</button> : null}
          </div>
        </div>
      </motion.section>
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
    <article className={cn("group border bg-white transition-[border-color,box-shadow,transform] duration-200 hover:-translate-y-px", layout === "grid" ? "rounded-[18px]" : "grid grid-cols-[112px_minmax(0,1fr)_auto] items-center gap-4 rounded-[18px] p-2", selected ? "border-slate-900 ring-1 ring-slate-900" : "border-slate-200/90 hover:border-slate-300 hover:shadow-[0_8px_24px_rgba(15,23,42,.05)]")}>
      <button type="button" onClick={onSelect} className={cn("relative overflow-hidden bg-slate-950", layout === "grid" ? "aspect-video w-full rounded-t-[17px]" : "aspect-[9/16] h-24 rounded-xl")}>
        <video preload="metadata" muted playsInline src={outputUrl(result.output)} className="h-full w-full object-cover" />
        <span className="absolute left-2 top-2 rounded-full bg-black/68 px-2 py-1 text-[9px] font-semibold text-white">#{result.rank}</span>
        <span className="absolute inset-0 grid place-items-center bg-black/0 transition-colors duration-200 group-hover:bg-black/10"><span className="grid h-8 w-8 place-items-center rounded-full bg-white/95 text-slate-950 opacity-0 transition-opacity duration-200 group-hover:opacity-100"><Play className="ml-0.5 h-3.5 w-3.5" /></span></span>
      </button>
      <div className={cn("min-w-0", layout === "grid" ? "p-4" : "")}>
        <div className="flex items-start justify-between gap-3">
          <span className="rounded-full bg-slate-100 px-2 py-1 text-[9px] font-semibold text-slate-600">Potential {clipPotentialScore(result)}</span>
          <span className="shrink-0 text-[11px] text-slate-400">{result.clip_duration}</span>
        </div>
        <h3 className="mt-3 line-clamp-2 text-[13px] font-semibold leading-5 text-slate-900">{result.title}</h3>
        {result.reason ? (
          <p className="mt-1.5 line-clamp-3 text-[11px] leading-4 text-slate-500">{result.reason}</p>
        ) : null}
        <div className="mt-3 flex items-center gap-1 border-t border-slate-100 pt-2">
          <button type="button" onClick={onLike} aria-label={liked ? "Unlike clip" : "Like clip"} className={cn("grid h-8 w-8 place-items-center rounded-full text-slate-400 transition-colors hover:bg-slate-100", liked && "text-rose-500")}><Heart className={cn("h-3.5 w-3.5", liked && "fill-current")} /></button>
          <a href={outputUrl(result.output)} download className="flex h-8 items-center gap-1.5 rounded-full px-3 text-[11px] font-medium text-slate-600 transition-colors hover:bg-slate-100"><Download className="h-3 w-3" />Export</a>
          <button type="button" onClick={onDelete} aria-label="Delete clip" className="ml-auto grid h-8 w-8 place-items-center rounded-full text-slate-300 transition-colors hover:bg-red-50 hover:text-red-500"><Trash2 className="h-3.5 w-3.5" /></button>
        </div>
      </div>
      {layout === "list" ? <a href={outputUrl(result.output)} download className="mr-3 grid h-9 w-9 place-items-center rounded-full bg-slate-900 text-white transition-colors hover:bg-slate-800" aria-label="Download MP4"><Download className="h-3.5 w-3.5" /></a> : null}
    </article>
  );
}

function ClipperEnginePicker({
  value,
  onChange,
  autoclip,
}: {
  value: ClipperEngine;
  onChange: (value: ClipperEngine) => void;
  autoclip: AutoClipRunnerStatus | null;
}) {
  const externalAvailable = Boolean(autoclip?.available);
  return (
    <section className="mt-5 border-t border-slate-100 pt-5" aria-label="Clip analysis engine">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold text-slate-700">Analysis engine</p>
          <p className="mt-0.5 text-[10px] leading-4 text-slate-400">Choose the local workflow that creates your review job.</p>
        </div>
        <span className={cn("rounded-full px-2 py-1 text-[9px] font-semibold", externalAvailable ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-400")}>
          {externalAvailable ? "Runner ready" : "Local only"}
        </span>
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <button
          type="button"
          aria-pressed={value === "clyra-vision"}
          onClick={() => onChange("clyra-vision")}
          className={cn(
            "rounded-xl border p-3 text-left transition-[border-color,background-color,box-shadow] duration-150",
            value === "clyra-vision" ? "border-slate-900 bg-slate-950 text-white shadow-[0_6px_18px_rgba(15,23,42,.10)]" : "border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50",
          )}
        >
          <span className="flex items-center gap-2 text-[11px] font-semibold"><Sparkles className="h-3.5 w-3.5" />Clyra Vision</span>
          <span className={cn("mt-1 block text-[9px] leading-4", value === "clyra-vision" ? "text-slate-300" : "text-slate-400")}>Visual, audio and transcript evidence. Recommended for specific moments.</span>
        </button>
        <button
          type="button"
          disabled={!externalAvailable}
          aria-pressed={value === "autoclip"}
          onClick={() => onChange("autoclip")}
          title={autoclip?.detail || "Checking local AutoClip runner…"}
          className={cn(
            "rounded-xl border p-3 text-left transition-[border-color,background-color] duration-150 disabled:cursor-not-allowed disabled:opacity-45",
            value === "autoclip" ? "border-slate-900 bg-slate-950 text-white" : "border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50",
          )}
        >
          <span className="flex items-center gap-2 text-[11px] font-semibold"><FileVideo2 className="h-3.5 w-3.5" />AutoClip local runner</span>
          <span className={cn("mt-1 block text-[9px] leading-4", value === "autoclip" ? "text-slate-300" : "text-slate-400")}>Optional local job queue for broad text-led highlights. Public YouTube URLs only.</span>
        </button>
      </div>
      {!externalAvailable ? <p className="mt-2 text-[9px] leading-4 text-slate-400">{autoclip?.detail || "Checking the optional local runner…"}</p> : null}
    </section>
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
  const [activeStep, setActiveStep] = useState<PipelineStageId>("captions");
  const [analysisActivities, setAnalysisActivities] = useState<AnalysisActivity[]>([]);
  const [progress, setProgress] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [readyCount, setReadyCount] = useState(0);
  const [captionWords, setCaptionWords] = useState<CaptionWord[]>([]);
  const [rewriteBusy, setRewriteBusy] = useState(false);
  const [refineBusy, setRefineBusy] = useState(false);
  const [selectedFaceId, setSelectedFaceId] = useState<string>("");
  const [previewTimeMs, setPreviewTimeMs] = useState(0);
  const [wizardPeople, setWizardPeople] = useState<AvailableFace[]>([]);
  const [peopleScanning, setPeopleScanning] = useState(false);
  const [autoclipStatus, setAutoclipStatus] = useState<AutoClipRunnerStatus | null>(null);
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
    const controller = new AbortController();
    void fetch("/api/clipper/autoclip/status", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Runner status unavailable");
        return response.json() as Promise<AutoClipRunnerStatus>;
      })
      .then((value) => setAutoclipStatus(value))
      .catch(() => {
        if (!controller.signal.aborted) {
          setAutoclipStatus({ configured: false, available: false, detail: "Local AutoClip runner is unavailable." });
        }
      });
    return () => controller.abort();
  }, []);

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
  const setFaceTrackingPreset = (preset: FaceTrackingPreset) => setDraft((current) => applyFaceTrackingPreset(preset, current));
  const selectTrackedFace = (personId: string) => {
    setSelectedFaceId(personId);
    setDraft((current) => ({ ...applyFaceTrackingPreset("select", current), selectedPersonId: personId }));
  };
  const externalRunnerSourceReady = draft.source.mode === "url" && Boolean(youtubeEmbedUrl(draft.source.url));
  const sourceReady = draft.engine === "autoclip"
    ? externalRunnerSourceReady && Boolean(autoclipStatus?.available)
    : draft.source.mode === "url" ? /^https?:\/\//i.test(draft.source.url.trim()) : Boolean(draft.source.uploadId);
  const objective = draft.objective === "custom" ? draft.customObjective.trim() : OBJECTIVES.find(([id]) => id === draft.objective)?.[1] || "Best viral moments";
  const trackingPreset = faceTrackingPresetFor(draft);

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
      setDraft((current) => ({
        ...current,
        source: { mode: "upload", url: "", ...uploaded },
      }));
      setWizardPeople([]);
    } catch (cause) {
      if (!(cause instanceof DOMException && cause.name === "AbortError")) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (task.current === controller) task.current = null;
      setUploading(false);
    }
  };

  const scanPeopleForUpload = async (uploadId?: string, signal?: AbortSignal) => {
    if (!uploadId) return;
    setPeopleScanning(true);
    const timeout = window.setTimeout(() => {
      // Soft wall so face scan stays near ≤2 minutes on 8GB machines.
      task.current?.abort();
    }, 110_000);
    try {
      const response = await fetch("/api/clipper/scan-people", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal,
        body: JSON.stringify({ uploadId, maxPeople: 6, duration: 90 }),
      });
      if (!response.ok) {
        const detail = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(detail.error || `People scan failed (${response.status})`);
      }
      // SSE stream — collect last people payload
      const reader = response.body?.getReader();
      if (!reader) return;
      const decoder = new TextDecoder();
      let buffer = "";
      let people: AvailableFace[] = [];
      let selectedId = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line.startsWith("data: ")) continue;
          try {
            const event = JSON.parse(line.slice(6)) as {
              type?: string;
              people?: AvailableFace[];
              selectedPersonId?: string;
              jobId?: string;
              result?: { people?: AvailableFace[]; selectedPersonId?: string; jobId?: string };
            };
            if (event.type === "error") throw new Error("People scan failed");
            const nextPeople = event.people || event.result?.people;
            const jobId = event.jobId || event.result?.jobId || "";
            if (Array.isArray(nextPeople) && nextPeople.length) {
              people = nextPeople.map((person) => {
                const id = person.personId || person.id;
                const raw = person.thumbnailUrl || person.thumbnail || person.thumbnailPath || "";
                const fileName = raw.split(/[/\\]/).pop() || "";
                const publicThumb =
                  person.thumbnailUrl?.startsWith("/api/")
                    ? person.thumbnailUrl
                    : raw.startsWith("/api/")
                      ? raw
                      : jobId && /^[\w.-]+\.jpe?g$/i.test(fileName)
                        ? `/api/clipper/face-cache/${jobId}/thumbs/${fileName}`
                        : "";
                return {
                  ...person,
                  id,
                  personId: id,
                  thumbnailUrl: publicThumb || undefined,
                  thumbnail: publicThumb || undefined,
                };
              });
            }
            selectedId = event.selectedPersonId || event.result?.selectedPersonId || selectedId;
          } catch {
            // Ignore malformed SSE chunks mid-stream.
          }
        }
      }
      if (people.length) {
        setWizardPeople(people);
        const pick = selectedId || people[0]?.id || people[0]?.personId || "";
        if (pick) {
          setDraft((current) => ({ ...current, selectedPersonId: pick }));
        }
      }
    } catch (cause) {
      if (!(cause instanceof DOMException && cause.name === "AbortError")) {
        // Non-fatal — generate still works with auto person pick.
        console.warn("People scan skipped:", cause);
      }
    } finally {
      window.clearTimeout(timeout);
      setPeopleScanning(false);
    }
  };

  const cancel = () => {
    task.current?.abort();
    task.current = null;
    setView("create");
    setProgress(0);
    setStatus("");
    setAnalysisActivities([]);
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
    setAnalysisActivities([]);
    setProgress(3);
    setElapsed(0);
    setReadyCount(0);
    onEngaged?.();
    try {
      const response = await fetch(draft.engine === "autoclip" ? "/api/clipper/autoclip/start" : "/api/clipper/start", {
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
            caption_x: draft.captionX,
            caption_y: draft.captionY,
            subtitle_style: draft.subtitleStyle,
            render_quality: draft.renderQuality,
            moment_type: objective,
            // Keep the exact natural-language intent available for the
            // backend's visual state-transition verifier.  The display label
            // is not sufficient for requests such as “leave the zoo”.
            moment_request: draft.objective === "custom" ? draft.customObjective.trim() : "",
            // The default path is deliberately bounded for an 8 GB computer.
            // A separately provisioned deep worker may be enabled server-side
            // for visual state verification; the UI never downloads models.
            video_understanding_profile: "8gb_cpu",
            clip_duration: draft.clipLength,
            clip_count: draft.clipCount,
            aspect_ratio: draft.aspect,
            crop_focus: draft.cropFocus,
            face_tracking: {
              enabled: draft.faceTracking !== "off",
              mode: draft.faceTracking,
              selectedTrackId: draft.selectedPersonId || undefined,
              selectedPersonId: draft.selectedPersonId || undefined,
              sceneMode: draft.sceneMode,
              personMode: draft.sceneMode,
              allowZoom: draft.faceTracking !== "off",
              smartReframe: true,
              reframeMode: reframeModeFor(draft),
              speakerMode: speakerModeFor(draft),
              trackingQuality: "balanced",
              splitScreen: false,
            },
            captions_enabled: draft.captionsEnabled,
            caption_collision_mode: draft.captionCollisionMode || "auto",
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
            status?: string;
            message?: string;
            result?: ClipResult;
            results?: ClipResult[];
            candidate_count?: number;
            word_count?: number;
            timing_source?: string;
          };
          if (event.type === "error") throw new Error(event.message || "Clip rendering failed");
          const stage = pipelineStageFor(event.step);
          if (stage) {
            setActiveStep(stage);
            const index = Math.max(0, PIPELINE.findIndex((item) => item.id === stage));
            const stageProgress = 8 + (index / Math.max(1, PIPELINE.length - 1)) * 72;
            const candidateProgress = Math.min(18, resultBuffer.current.length / Math.max(1, draft.clipCount) * 18);
            setProgress((current) => stage === "complete" ? 100 : Math.min(98, Math.max(current, Math.round(stageProgress + candidateProgress))));
            if (event.message) {
              const metadata = Number.isFinite(Number(event.candidate_count)) && Number(event.candidate_count) > 0
                ? `${event.candidate_count} candidates`
                : Number.isFinite(Number(event.word_count)) && Number(event.word_count) > 0
                  ? `${event.word_count} words`
                  : event.result?.rank
                    ? `Clip ${event.result.rank}`
                    : undefined;
              setAnalysisActivities((current) => [
                ...current,
                {
                  id: crypto.randomUUID(),
                  stage,
                  status: event.status || event.type || "update",
                  message: event.message,
                  metadata,
                },
              ].slice(-24));
            }
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
          selectedTrackId: selectedFaceId || draft.selectedPersonId || null,
          selectedPersonId: selectedFaceId || draft.selectedPersonId || null,
          sceneMode: draft.sceneMode,
          personMode: draft.sceneMode,
          allowZoom: draft.faceTracking !== "off",
          smartReframe: true,
          reframeMode: reframeModeFor(draft),
          speakerMode: speakerModeFor(draft),
          trackingQuality: "balanced",
          splitScreen: false,
          cropFocus: draft.cropFocus,
          aspectRatio: draft.aspect,
          captionsEnabled: draft.captionsEnabled,
          captionCollisionMode: draft.captionCollisionMode || "auto",
          font: draft.font,
          fontSize: draft.fontSize,
          textColour: draft.colour,
          position: draft.position,
          captionX: draft.captionX,
          captionY: draft.captionY,
          renderQuality: draft.renderQuality,
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
          selectedTrackId: selectedFaceId || draft.selectedPersonId || null,
          selectedPersonId: selectedFaceId || draft.selectedPersonId || null,
          sceneMode: draft.sceneMode,
          personMode: draft.sceneMode,
          allowZoom: draft.faceTracking !== "off",
          smartReframe: true,
          reframeMode: reframeModeFor(draft),
          speakerMode: speakerModeFor(draft),
          trackingQuality: "balanced",
          splitScreen: false,
          cropFocus: draft.cropFocus,
          aspectRatio: draft.aspect,
          captionsEnabled: draft.captionsEnabled,
          captionCollisionMode: draft.captionCollisionMode || "auto",
          font: draft.font,
          fontSize: draft.fontSize,
          textColour: draft.colour,
          position: draft.position,
          captionX: draft.captionX,
          captionY: draft.captionY,
          renderQuality: draft.renderQuality,
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
    { id: "look" as const, title: "Look", detail: "Captions, framing and safe placement" },
    { id: "output" as const, title: "Output", detail: "Length and clip count" },
  ];
  const canContinue = wizardStep === 0 ? sourceReady && !uploading : wizardStep === 1 ? hasChosenObjective && Boolean(objective) : true;
  const createView = (
    <div className="relative h-full overflow-hidden bg-[#f8fafc] px-4 py-5 sm:px-6">
      <div className="mx-auto flex h-full w-full max-w-[720px] flex-col">
        <div className="mb-4 flex shrink-0 items-center justify-between gap-4">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-slate-400">AI Clipper</p>
            <h1 className="mt-1 text-[22px] font-semibold tracking-[-0.035em] text-slate-950 sm:text-[26px]">Create clips</h1>
          </div>
          {results.length ? (
            <button
              type="button"
              onClick={() => setView("results")}
              className="flex h-9 shrink-0 items-center gap-2 rounded-full border border-slate-200 bg-white px-3.5 text-[10px] font-semibold text-slate-600 transition-colors hover:border-slate-300 hover:bg-slate-50"
            >
              <Clock3 className="h-3.5 w-3.5" />
              Recent
            </button>
          ) : null}
        </div>

        <div className="creator-setup-layout grid min-h-0 flex-1 gap-4 overflow-hidden">
          <ol className="clyra-visible-scrollbar space-y-1 overflow-y-auto pr-1" aria-label="Clip setup">
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
                      "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2.5 text-left transition-colors",
                      current ? "bg-white text-slate-950 ring-1 ring-slate-200" : "text-slate-400 hover:bg-white/80",
                    )}
                  >
                    <span className={cn(
                      "grid h-6 w-6 shrink-0 place-items-center rounded-full border text-[9px] font-bold",
                      current || complete ? "border-slate-900 bg-slate-950 text-white" : "border-slate-200 bg-white",
                    )}>
                      {complete ? <Check className="h-3 w-3" /> : index + 1}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-[11px] font-semibold">{item.title}</span>
                      <span className="mt-0.5 block truncate text-[9px] leading-4 text-slate-400">{item.detail}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>

          <motion.section
            key={wizardStep}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.22, ease: [0.2, 0.8, 0.2, 1] }}
            className="clyra-visible-scrollbar min-h-0 overflow-y-auto rounded-[18px] border border-slate-200/90 bg-white p-4 sm:p-5"
          >
            <p className="text-[9px] font-bold uppercase tracking-[.14em] text-slate-400">Step {wizardStep + 1} of 4</p>
            <h2 className="mt-1.5 text-[18px] font-semibold tracking-[-0.02em] text-slate-950">{wizardMeta[wizardStep].title}</h2>
            <p className="mt-1 max-w-md text-[11px] leading-5 text-slate-500">{wizardMeta[wizardStep].detail}</p>

            <div className="mt-5">
              {wizardStep === 0 ? (
                <>
                  <SourcePicker source={draft.source} onSource={(source) => updateDraft("source", source)} onFile={(file) => void handleFile(file)} uploading={uploading} uploadProgress={uploadProgress} />
                  <ClipperEnginePicker value={draft.engine} onChange={(engine) => updateDraft("engine", engine)} autoclip={autoclipStatus} />
                </>
              ) : null}
              {wizardStep === 1 ? (
                <div>
                  <div className="grid gap-2 sm:grid-cols-2">
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
                            "min-h-[92px] rounded-xl border p-3 text-left transition-[border-color,background-color,transform] duration-150 active:scale-[.99]",
                            selected ? "border-slate-900 bg-white ring-1 ring-slate-900" : "border-slate-200 bg-white hover:border-slate-400 hover:bg-slate-50/70",
                          )}
                        >
                          <div className="flex items-center justify-between">
                            <span className="grid h-7 w-7 place-items-center rounded-lg bg-slate-100 text-slate-700"><Icon className="h-3.5 w-3.5" /></span>
                            {selected ? <Check className="h-3.5 w-3.5 text-slate-950" /> : null}
                          </div>
                          <p className="mt-2.5 text-[12px] font-semibold text-slate-950">{id === "custom" ? "Describe it yourself" : label}</p>
                          <p className="mt-1 text-[9px] leading-4 text-slate-500">{meta.detail}</p>
                        </button>
                      );
                    })}
                  </div>
                  {draft.objective === "custom" ? (
                    <label className="mt-3 block">
                      <span className="mb-1.5 block text-[10px] font-semibold text-slate-500">Custom direction</span>
                      <textarea
                        value={draft.customObjective}
                        onChange={(event) => updateDraft("customObjective", event.target.value.slice(0, 500))}
                        rows={2}
                        placeholder="Find clear moments where the speaker explains a surprising idea…"
                        className="w-full resize-none rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-[12px] leading-5 text-slate-700 outline-none focus:border-slate-400"
                      />
                    </label>
                  ) : null}
                </div>
              ) : null}
              {wizardStep === 2 ? (
                <div className="space-y-5">
                  <Toggle label="Dynamic captions" detail="Burn word-timed captions into every exported MP4." checked={draft.captionsEnabled} onChange={(value) => updateDraft("captionsEnabled", value)} />
                  {draft.captionsEnabled ? (
                    <div className="border-b border-slate-100 pb-5">
                      <p className="text-[12px] font-medium text-slate-800">When source captions already exist</p>
                      <p className="mt-0.5 text-[10px] leading-4 text-slate-400">Clyra detects lower-third captions and keeps your timed captions visible rather than silently removing them.</p>
                      <div className="mt-3 grid grid-cols-3 gap-1 rounded-lg border border-slate-200 bg-slate-50 p-1" role="radiogroup" aria-label="Existing caption handling">
                        {([
                          ["auto", "Move Clyra"],
                          ["keep-existing", "Keep source"],
                          ["allow-overlap", "Allow overlap"],
                        ] as Array<[CaptionCollisionMode, string]>).map(([mode, label]) => (
                          <button
                            key={mode}
                            type="button"
                            role="radio"
                            aria-checked={(draft.captionCollisionMode || "auto") === mode}
                            onClick={() => updateDraft("captionCollisionMode", mode)}
                            className={cn(
                              "h-8 rounded-md px-2 text-[10px] font-medium transition-colors",
                              (draft.captionCollisionMode || "auto") === mode ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700",
                            )}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : null}
                  <Toggle label="Remove filler words" detail="Hide common fillers without cutting the audio." checked={draft.removeFillers} onChange={(value) => updateDraft("removeFillers", value)} />
                  <div className="border-b border-slate-100 pb-5">
                    <p className="text-[12px] font-medium text-slate-800">Subject tracking</p>
                    <p className="mt-0.5 text-[10px] leading-4 text-slate-400">Clyra plans a timestamped crop path from the detected subject. If confidence drops, it holds or widens the composition rather than jumping to another face.</p>
                    <div className="mt-3"><FaceTrackingPresetControl value={trackingPreset} onChange={setFaceTrackingPreset} /></div>
                    {trackingPreset === "select" && draft.source.mode === "upload" ? (
                      <button
                        type="button"
                        disabled={!draft.source.uploadId || peopleScanning}
                        onClick={() => void scanPeopleForUpload(draft.source.uploadId)}
                        className="mt-3 h-9 rounded-lg border border-slate-200 bg-white px-3 text-[10px] font-semibold text-slate-700 transition-colors hover:border-slate-400 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {peopleScanning ? "Scanning people…" : "Scan people in upload"}
                      </button>
                    ) : null}
                    {trackingPreset === "select" && wizardPeople.length ? (
                      <div className="mt-3 flex flex-wrap gap-2" aria-label="Detected people">
                        {wizardPeople.map((person) => {
                          const id = person.personId || person.id;
                          const active = draft.selectedPersonId === id;
                          return <button key={id} type="button" onClick={() => selectTrackedFace(id)} className={cn("rounded-lg border px-2.5 py-1.5 text-[10px] font-semibold", active ? "border-slate-900 bg-slate-950 text-white" : "border-slate-200 bg-white text-slate-600 hover:border-slate-400")}>{person.label || id}</button>;
                        })}
                      </div>
                    ) : null}
                  </div>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <label className="text-[10px] font-semibold text-slate-500">Caption font
                      <select value={draft.font} onChange={(event) => updateDraft("font", event.target.value)} className="mt-1.5 h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-[11px] font-medium outline-none focus:border-slate-400 focus:ring-2 focus:ring-slate-100">
                        <option>Impact</option><option>Arial Black</option><option>Helvetica</option>
                      </select>
                    </label>
                    <label className="text-[10px] font-semibold text-slate-500">Position
                      <select value={draft.position} onChange={(event) => updateDraft("position", event.target.value as CaptionPosition)} className="mt-1.5 h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-[11px] font-medium outline-none focus:border-slate-400 focus:ring-2 focus:ring-slate-100">
                        <option value="top">Top</option><option value="centre">Middle</option><option value="bottom">Bottom safe zone</option>
                      </select>
                    </label>
                    <label className="text-[10px] font-semibold text-slate-500">Caption style
                      <select value={draft.subtitleStyle} onChange={(event) => updateDraft("subtitleStyle", event.target.value as SubtitleStyle)} className="mt-1.5 h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-[11px] font-medium outline-none focus:border-slate-400 focus:ring-2 focus:ring-slate-100">
                        <option value="phrase-highlight">Active phrase</option><option value="word">One word</option>
                      </select>
                    </label>
                    <label className="text-[10px] font-semibold text-slate-500">Export quality
                      <select value={draft.renderQuality} onChange={(event) => updateDraft("renderQuality", event.target.value as RenderQuality)} className="mt-1.5 h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-[11px] font-medium outline-none focus:border-slate-400 focus:ring-2 focus:ring-slate-100">
                        <option value="premium">Premium 1080p — best quality</option><option value="balanced">Balanced — smaller files</option><option value="master">Master — maximum detail</option>
                      </select>
                    </label>
                    <div>
                      <p className="mb-1.5 text-[10px] font-semibold text-slate-500">Aspect ratio</p>
                      <div className="flex rounded-lg border border-slate-200 bg-slate-100/70 p-1">
                        {(["9:16", "1:1", "16:9"] as ClipAspect[]).map((value) => <Segment key={value} value={value} current={draft.aspect} onClick={(next) => updateDraft("aspect", next)}>{value}</Segment>)}
                      </div>
                    </div>
                    <div>
                      <p className="mb-1.5 text-[10px] font-semibold text-slate-500">Subject focus</p>
                      <div className="flex rounded-lg border border-slate-200 bg-slate-100/70 p-1">
                        {(["left", "center", "right"] as CropFocus[]).map((value) => <Segment key={value} value={value} current={draft.cropFocus} onClick={(next) => updateDraft("cropFocus", next)}>{value}</Segment>)}
                      </div>
                    </div>
                  </div>
                  <div className="mt-4 grid gap-3 rounded-xl border border-slate-200 bg-slate-50/80 p-3 sm:grid-cols-2">
                    <label className="text-[10px] font-semibold text-slate-500">Horizontal placement <span className="float-right tabular-nums text-slate-400">{draft.captionX}%</span>
                      <input aria-label="Caption horizontal placement" type="range" min="12" max="88" value={draft.captionX} onChange={(event) => updateDraft("captionX", Number(event.target.value))} className="mt-2 w-full accent-slate-900" />
                    </label>
                    <label className="text-[10px] font-semibold text-slate-500">Vertical placement <span className="float-right tabular-nums text-slate-400">{draft.captionY}%</span>
                      <input aria-label="Caption vertical placement" type="range" min="10" max="90" value={draft.captionY} onChange={(event) => updateDraft("captionY", Number(event.target.value))} className="mt-2 w-full accent-slate-900" />
                    </label>
                  </div>
                  <div className={cn("relative mx-auto w-full overflow-hidden rounded-xl bg-[#111318]", draft.aspect === "9:16" ? "aspect-[9/16] max-h-[220px]" : draft.aspect === "1:1" ? "aspect-square max-h-[220px]" : "aspect-video max-h-[180px]")}>
                    <div className="absolute inset-0 bg-[linear-gradient(145deg,#3b4350,#090a0d_72%)]" />
                    {draft.captionsEnabled ? (
                      <p className="absolute w-[86%] -translate-x-1/2 -translate-y-1/2 text-center font-black uppercase leading-none text-white [text-shadow:-2px_-2px_0_#000,2px_-2px_0_#000,-2px_2px_0_#000,2px_2px_0_#000]" style={{ left: `${draft.captionX}%`, top: `${draft.captionY}%`, fontFamily: draft.font, fontSize: `${Math.min(18, draft.fontSize * .2)}px`, color: draft.colour }}>
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
                      <div className="flex rounded-lg border border-slate-200 bg-slate-100/70 p-1">
                        {[15, 30, 45, 60].map((value) => <Segment key={value} value={value} current={draft.clipLength} onClick={(next) => updateDraft("clipLength", next)}>{value}s</Segment>)}
                      </div>
                    </div>
                    <div>
                      <p className="mb-1.5 text-[10px] font-semibold text-slate-500">Number of clips</p>
                      <div className="flex rounded-lg border border-slate-200 bg-slate-100/70 p-1">
                        {[1, 3, 5, 8].map((value) => <Segment key={value} value={value} current={draft.clipCount} onClick={(next) => updateDraft("clipCount", next)}>{value}</Segment>)}
                      </div>
                    </div>
                  </div>
                  <dl className="mt-6 divide-y divide-slate-100 rounded-xl border border-slate-200 bg-slate-50/60 px-4 text-[11px]">
                    {[["Source", draft.source.name || draft.source.url || "Ready"], ["Engine", draft.engine === "autoclip" ? "AutoClip local runner" : "Clyra Vision"], ["Moments", objective], ["Output", `${draft.clipCount} clips · ${draft.clipLength}s`], ["Framing", `${faceTrackingLabel(draft)}${draft.selectedPersonId ? ` · ${draft.selectedPersonId}` : ""}`]].map(([label, value]) => (
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
                <button type="button" disabled={!canContinue} onClick={() => setWizardStep((step) => Math.min(3, step + 1))} className="h-10 rounded-full bg-slate-950 px-5 text-[10px] font-semibold text-white transition-transform active:scale-[.98] disabled:opacity-35">
                  Continue
                </button>
              ) : (
                <button type="button" disabled={!sourceReady || !objective} onClick={() => void run()} className="flex h-11 items-center gap-2 rounded-full bg-slate-950 px-6 text-[10px] font-semibold text-white transition-transform active:scale-[.98] disabled:opacity-35">
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
    <div data-testid="clipper-results" className="mx-auto flex h-full min-h-0 w-full max-w-[1280px] flex-col overflow-hidden rounded-[20px] border border-slate-200/90 bg-[#f8fafc]">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-slate-200/90 bg-white px-4 sm:px-5">
        <button type="button" onClick={() => setView("create")} className="flex h-8 items-center gap-2 rounded-full px-3 text-[11px] font-medium text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900"><Plus className="h-3.5 w-3.5" />New clips</button>
        <span className="hidden text-[11px] text-slate-300 sm:block">/</span>
        <span className="hidden text-[11px] font-medium text-slate-700 sm:block">{results.length} ranked clips</span>
        <div className="ml-auto flex items-center gap-1.5">
          <button type="button" onClick={() => void run()} className="hidden h-8 items-center gap-1.5 rounded-full px-3 text-[11px] font-medium text-slate-500 transition-colors hover:bg-slate-100 sm:flex"><RefreshCw className="h-3.5 w-3.5" />Generate more</button>
          <button type="button" disabled={!selectedResults.size} onClick={bulkExport} className="flex h-8 items-center gap-1.5 rounded-full bg-slate-900 px-4 text-[11px] font-semibold text-white transition-colors hover:bg-slate-800 disabled:opacity-30"><Download className="h-3.5 w-3.5" />Export selected</button>
        </div>
      </header>
      {error ? (
        <div className="flex items-start gap-2 border-b border-amber-200 bg-amber-50 px-4 py-2.5 text-[11px] leading-4 text-amber-800 sm:px-5">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1">{error}</span>
          <button type="button" onClick={() => setError("")} className="shrink-0 font-medium text-amber-900/70 hover:text-amber-950">Dismiss</button>
        </div>
      ) : null}
      <div className="grid min-h-0 flex-1 lg:grid-cols-[174px_minmax(0,1fr)]">
        <aside className="hidden min-h-0 border-r border-slate-200/90 bg-white p-4 lg:block">
          <p className="text-[10px] font-semibold uppercase tracking-[.12em] text-slate-400">Review clips</p>
          <label className="mt-4 flex h-10 items-center gap-2 rounded-xl border border-slate-200/90 bg-white px-3 transition-[border-color,box-shadow] duration-200 focus-within:border-slate-400 focus-within:ring-2 focus-within:ring-slate-100">
            <Search className="h-3.5 w-3.5 text-slate-400" />
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search transcript" className="min-w-0 flex-1 bg-transparent text-[11px] outline-none placeholder:text-slate-400" />
          </label>
          <label className="mt-4 block text-[11px] font-medium text-slate-500">
            Sort by
            <select value={sortMode} onChange={(event) => setSortMode(event.target.value as SortMode)} className="mt-1.5 h-10 w-full rounded-xl border border-slate-200/90 bg-white px-3 text-[11px] outline-none transition-[border-color,box-shadow] duration-200 focus:border-slate-400 focus:ring-2 focus:ring-slate-100">
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
          <main className="min-h-0 overflow-y-auto p-4 sm:p-5">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <p className="text-[13px] font-semibold text-slate-900">Generated clips</p>
                <p className="mt-0.5 text-[11px] text-slate-400">Distinct source moments, already captioned and exported</p>
              </div>
              <div className="flex rounded-full border border-slate-200/90 bg-white p-1">
                <button type="button" onClick={() => setResultLayout("grid")} className={cn("grid h-7 w-7 place-items-center rounded-full transition-colors", resultLayout === "grid" ? "bg-slate-100 text-slate-950" : "text-slate-400 hover:text-slate-600")} aria-label="Grid view"><Grid2X2 className="h-3.5 w-3.5" /></button>
                <button type="button" onClick={() => setResultLayout("list")} className={cn("grid h-7 w-7 place-items-center rounded-full transition-colors", resultLayout === "list" ? "bg-slate-100 text-slate-950" : "text-slate-400 hover:text-slate-600")} aria-label="List view"><List className="h-3.5 w-3.5" /></button>
              </div>
            </div>
            <div className={cn(resultLayout === "grid" ? "grid gap-3 sm:grid-cols-2 xl:grid-cols-3" : "space-y-2")}>
              {filteredResults.map((result) => (
                <div key={result.id} className="relative">
                  <label className="absolute right-2 top-2 z-20 grid h-6 w-6 place-items-center rounded-full bg-white/92 ring-1 ring-black/5">
                    <input type="checkbox" checked={selectedResults.has(result.id)} onChange={() => setSelectedResults((current) => { const next = new Set(current); if (next.has(result.id)) next.delete(result.id); else next.add(result.id); return next; })} className="h-3.5 w-3.5 accent-slate-800" aria-label={`Select ${result.title}`} />
                  </label>
                  <ClipCard result={result} selected={selected?.id === result.id} layout={resultLayout} liked={liked.has(result.id)} onSelect={() => setSelectedId(result.id)} onLike={() => setLiked((current) => { const next = new Set(current); if (next.has(result.id)) next.delete(result.id); else next.add(result.id); return next; })} onDelete={() => setResults((items) => items.filter((item) => item.id !== result.id))} />
                </div>
              ))}
            </div>
          </main>

          <aside className="hidden min-h-0 border-l border-slate-200/90 bg-white lg:flex lg:flex-col">
            {selected ? (
              <>
                <div className="min-h-0 flex-1 overflow-y-auto p-4">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-[10px] font-semibold uppercase tracking-[.12em] text-slate-400">Clip studio</p>
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-600">
                      Potential {clipPotentialScore(selected)}
                    </span>
                  </div>

                  <div className="mt-3 grid gap-3 xl:grid-cols-[minmax(0,220px)_minmax(0,1fr)]">
                    <div data-testid="clipper-preview" className="overflow-hidden rounded-xl border border-slate-200 bg-slate-950 shadow-[0_8px_22px_rgba(15,23,42,.10)]">
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
                                  onClick={() => selectTrackedFace(face.id)}
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
                      {selected.caption_collision?.detected ? (
                        <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-100 bg-amber-50/70 px-2.5 py-2 text-[10px] leading-4 text-amber-800">
                          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                          <span>
                            {selected.captions_enabled === false
                              ? "Existing source captions were kept; Clyra captions are disabled for this render."
                              : selected.caption_position === "top"
                                ? "Existing lower-third captions detected. Clyra's timed captions were moved to the top safe zone."
                                : "Existing captions were detected; your chosen caption placement was preserved."}
                          </span>
                        </div>
                      ) : null}

                      <div className="mt-4">
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-400">Framing & tracking</p>
                          <span className="rounded-full bg-slate-100 px-2 py-1 text-[9px] font-semibold text-slate-500">{faceTrackingLabel(draft)}</span>
                        </div>
                        <div className="mt-2">
                          <FaceTrackingPresetControl value={trackingPreset} onChange={setFaceTrackingPreset} compact />
                        </div>
                        <p className="mt-2 text-[10px] leading-4 text-slate-400">
                          {trackingPreset === "select" ? "Select a face below or tap its outline in the preview, then re-render." : "Choose Select Face to lock a particular person before re-rendering."}
                        </p>
                        {trackingPreset === "select" && (selected.available_faces?.length || 0) > 0 ? (
                          <div className="mt-2 flex flex-wrap gap-2">
                            {selected.available_faces!.map((face) => {
                              const thumb = face.thumbnailUrl || face.thumbnail || (selected.artifact_id ? `/api/clipper/artifact/${selected.artifact_id}/faces/${face.id}.jpg` : "");
                              const active = selectedFaceId === face.id;
                              return (
                                <button
                                  key={face.id}
                                  type="button"
                                  onClick={() => selectTrackedFace(face.id)}
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
                        <div className="mt-2 max-h-[260px] space-y-1 overflow-y-auto rounded-xl border border-slate-200 bg-slate-50/80 p-2">
                          {captionWords.length ? captionWords.map((word, index) => {
                            const label = wordText(word);
                            return (
                              <div key={`${word.start}-${index}`} className="grid grid-cols-[64px_minmax(0,1fr)] items-center gap-2 rounded-lg bg-white px-2.5 py-1.5 text-[11px] ring-1 ring-slate-100">
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
                  <a href={outputUrl(selected.output)} download className="flex h-10 items-center justify-center gap-2 rounded-full bg-slate-900 text-[11px] font-semibold text-white transition-colors hover:bg-slate-800"><Download className="h-3.5 w-3.5" />Download MP4</a>
                  <button type="button" onClick={() => void rewriteSelectedCaption()} disabled={rewriteBusy || refineBusy || !selected.artifact_id} className="flex h-10 items-center justify-center gap-2 rounded-full border border-slate-200 bg-white text-[11px] font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-50">
                    <WandSparkles className="h-3.5 w-3.5" />{rewriteBusy || refineBusy ? "Rendering…" : "Rewrite & re-render"}
                  </button>
                  <button type="button" onClick={() => void refineSelected()} disabled={refineBusy || !selected.artifact_id} className="flex h-10 items-center justify-center gap-2 rounded-full text-[11px] font-medium text-slate-600 transition-colors hover:bg-slate-100 disabled:opacity-50">
                    <SlidersHorizontal className="h-3.5 w-3.5" />{refineBusy ? "Updating render…" : "Apply caption changes & re-render"}
                  </button>
                </div>
              </>
            ) : (
              <div className="grid flex-1 place-items-center p-8 text-center">
                <div>
                  <p className="text-[13px] font-semibold text-slate-800">Select a clip</p>
                  <p className="mt-1 text-[11px] text-slate-400">Preview and refine timed subtitles here.</p>
                </div>
              </div>
            )}
          </aside>
        </div>
      </div>
    </div>
  );

  const content = (
    <div data-testid="ai-clipper-root" className={cn("overflow-hidden bg-[#f8fafc] text-slate-950", embedded ? "relative h-full w-full" : "fixed inset-0 z-[600]")}>
      <AnimatePresence>{view === "processing" ? <ProcessingScreen progress={progress} status={status} activeStep={activeStep} activities={analysisActivities} readyCount={readyCount} elapsed={elapsed} onCancel={cancel} /> : null}</AnimatePresence>
      <div className={cn("h-full", view === "create" ? "overflow-hidden" : "overflow-y-auto")}>{view === "results" ? resultsView : createView}</div>
    </div>
  );
  return embedded ? content : createPortal(content, document.body);
}
