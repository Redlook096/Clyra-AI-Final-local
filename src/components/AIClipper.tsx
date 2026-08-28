import {
  AlertCircle,
  Check,
  CheckCircle2,
  Copy,
  Crop,
  ChevronsLeft,
  ChevronsRight,
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
  MoreHorizontal,
  Maximize2,
  Pause,
  Pencil,
  Play,
  Plus,
  Minus,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Scissors,
  Magnet,
  Sparkles,
  Trash2,
  Undo2,
  Redo2,
  Upload,
  Video,
  Volume2,
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
  type MouseEvent,
  type MutableRefObject,
  type PointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "../lib/utils";
import { Bloub } from "./bloub/Bloub";
import ClipperEditor from "./clipper/ClipperEditor";
import ProgressRing from "./clipper/ProgressRing";
import { type CaptionStyle } from "./clipper/SubtitleOverlay";

interface Props {
  onClose: () => void;
  initialUrl?: string;
  embedded?: boolean;
  onEngaged?: () => void;
}

type WorkspaceView = "home" | "projects" | "create" | "processing" | "results";
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
type InspectorTab = "captions" | "crop" | "face" | "audio" | "export";

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
  /** Style contract emitted by the pipeline so the live overlay matches the burn-in. */
  caption_style?: CaptionStyle;
  /** True when subtitles are already composited into this MP4's pixels. */
  subtitles_burned?: boolean;
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

/**
 * True when this clip's MP4 is clean and captions live in the detached
 * overlay. Results from before the overlay overhaul carry neither the
 * explicit `subtitles_burned: false` flag nor a `caption_style` contract —
 * their pixels already contain captions, so no overlay (and no second burn).
 *
 * Prefer showing the overlay whenever we have timed words and the clip is
 * not explicitly marked as already burned — caption_style is optional.
 */
function hasDetachedCaptions(result?: ClipResult | null): boolean {
  if (!result) return false;
  if (result.subtitles_burned === true) return false;
  if (result.subtitles_burned === false) return true;
  if (result.caption_style) return true;
  // Untagged modern results still get an overlay when word timings exist.
  return Array.isArray(result.words) && result.words.length > 0;
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
  // Transcript-first clipping should remain fast by default. Continuous
  // person tracking is optional and can be selected in Look when a moving
  // subject crop is worth the extra local analysis time.
  faceTracking: "responsive",
  trackingPreset: "auto",
  sceneMode: "flexible",
  selectedPersonId: "",
  captionsEnabled: true,
  removeFillers: false,
  font: "Impact",
  fontSize: 74,
  colour: "#FFFFFF",
  position: "bottom",
  captionX: 50,
  captionY: 78,
  subtitleStyle: "phrase-highlight",
  // Never stack Clyra captions over captions that are already part of the
  // source unless the editor deliberately opts into a second layer.
  captionCollisionMode: "keep-existing",
  // Keep the default practical for local 8 GB machines. Premium remains an
  // explicit option, but should not make every first render look frozen.
  renderQuality: "balanced" as RenderQuality,
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
  if (!value) return "";
  // Absolute public/demo paths pass through so visual fixtures can load without
  // living under the clipper media API.
  if (/^(https?:)?\/\//i.test(value) || value.startsWith("/media/") || value.startsWith("/api/")) return value;
  const filename = clipFilename(value);
  return filename ? `/api/clipper/media/${encodeURIComponent(filename)}` : "";
}

/** Visual-QA fixture used when `?clipDemo=1` is present. */
function demoClipFixture(): ClipResult {
  const words = [
    "YOU", "IF", "IT'S", "MY", "TURN", "THEN", "WE", "GOTTA", "GO", "NOW",
    "AND", "KEEP", "IT", "MOVING", "THROUGH", "THE", "ROUND", "WITHOUT", "SLOWING", "DOWN",
  ].map((word, index) => {
    const start = index * 0.42;
    return { word, text: word, start, end: start + 0.36 };
  });
  return {
    id: "demo-clip-editor",
    rank: 1,
    title: "Rust Bucket Chaos: Blackjack and Laughs",
    output: "/media/fake-text/gameplay/gta/gta-01.mp4",
    clip_duration: "32s",
    artifact_id: "demo-clip-editor",
    captions_enabled: true,
    subtitles_burned: false,
    words,
    crop_keyframes: [
      { timeMs: 0 },
      { timeMs: 4200 },
      { timeMs: 9600 },
      { timeMs: 16800 },
      { timeMs: 24100 },
      { timeMs: 30000 },
    ],
    caption_style: {
      font: "Montserrat",
      font_size: 62,
      text_colour: "#FFFFFF",
      position: "bottom",
      caption_x: 50,
      caption_y: 82,
      subtitle_style: "phrase-highlight",
    },
    score: 74,
    clip_potential_score: 74,
  };
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

function youtubeVideoId(value: string) {
  try {
    const url = new URL(value.trim());
    const id = url.hostname.includes("youtu.be")
      ? url.pathname.split("/").filter(Boolean)[0]
      : url.searchParams.get("v") || url.pathname.match(/\/(?:embed|shorts|live)\/([^/?#]+)/)?.[1];
    return id && /^[\w-]{6,}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

function youtubeEmbedUrl(value: string) {
  const id = youtubeVideoId(value);
  return id ? `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}?rel=0` : null;
}

function youtubeThumbnailUrl(value: string) {
  const id = youtubeVideoId(value);
  return id ? `https://i.ytimg.com/vi/${encodeURIComponent(id)}/hqdefault.jpg` : null;
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
  showPreview = true,
}: {
  source: ClipSource;
  onSource: (source: ClipSource) => void;
  onFile: (file: File) => void;
  uploading: boolean;
  uploadProgress: number;
  showPreview?: boolean;
}) {
  const fileInput = useRef<HTMLInputElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const previewThumb = useMemo(() => source.mode === "url" ? youtubeThumbnailUrl(source.url) : null, [source.mode, source.url]);
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
            {showPreview && previewThumb ? (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
                className="mt-3 overflow-hidden rounded-xl border border-slate-200/90 bg-slate-950"
              >
                {/* Thumbnail card instead of YouTube iframe: embeds often hit
                    bot challenges in automation / cloud environments. */}
                <div className="relative aspect-video w-full overflow-hidden bg-slate-900">
                  <img src={previewThumb} alt="" className="h-full w-full object-cover opacity-95" />
                  <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/55 via-transparent to-black/10" />
                  <span className="absolute bottom-3 left-3 rounded-md bg-black/55 px-2 py-1 text-[10px] font-medium text-white/90 backdrop-blur-sm">
                    Preview · opens on generate
                  </span>
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

/** A deliberately neutral dark device frame: this previews caption/layout
 * decisions without pretending to be the source video before it is rendered. */
function ClipperMockVideoFrame({
  aspect,
  clipCount,
  quality,
  captionsEnabled,
  captionX,
  captionY,
  subtitleStyle,
  font,
  fontSize,
  colour,
  copy = "THIS IS YOUR SUBTITLE",
}: {
  aspect: ClipAspect;
  clipCount?: number;
  quality?: string;
  captionsEnabled: boolean;
  captionX: number;
  captionY: number;
  subtitleStyle: SubtitleStyle;
  font: string;
  fontSize: number;
  colour: string;
  copy?: string;
}) {
  return (
    <div className="relative h-full min-h-0 overflow-hidden rounded-[20px] border border-slate-800 bg-[#050609] shadow-[0_18px_36px_rgba(15,23,42,.18)]" style={{ aspectRatio: aspect.replace(":", "/"), height: "min(390px, calc(100vh - 410px))" }}>
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_48%,rgba(50,61,77,.28),transparent_31%),linear-gradient(180deg,rgba(255,255,255,.035),transparent_26%,rgba(0,0,0,.42))]" />
      <div className="absolute inset-x-[11%] top-[12%] bottom-[16%] rounded-[15px] border border-dashed border-white/[.12]" />
      <div className="absolute left-3 top-3 flex items-center gap-1.5 text-[8px] font-semibold uppercase tracking-[.14em] text-white/58"><span className="h-1.5 w-1.5 rounded-full bg-[#ff5f57]" />Preview</div>
      <div className="absolute right-3 top-3 flex items-center gap-1.5 text-[9px] font-medium text-white/58">{quality || "1080p"}{clipCount ? <span className="rounded border border-white/15 px-1.5 py-0.5 text-white/75">×{clipCount}</span> : <span>{aspect}</span>}</div>
      <div className="absolute left-1/2 top-1/2 grid h-9 w-9 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border border-white/15 bg-white/[.08] text-white/70 shadow-sm"><Play className="ml-0.5 h-3.5 w-3.5" fill="currentColor" /></div>
      {captionsEnabled ? <p className={cn("absolute w-[84%] -translate-x-1/2 -translate-y-1/2 text-center font-black uppercase leading-[1.1]", subtitleStyle === "word" ? "tracking-[.03em]" : "tracking-[-.02em]")} style={{ left: `${captionX}%`, top: `${captionY}%`, fontFamily: font, fontSize: `${Math.min(25, fontSize * .28)}px`, color: colour, textShadow: "0 2px 8px rgba(0,0,0,.88)" }}>{copy}</p> : <p className="absolute left-1/2 top-1/2 mt-9 w-full -translate-x-1/2 text-center text-[10px] font-medium text-white/32">Subtitles off</p>}
      <div className="absolute inset-x-3 bottom-3 flex items-center gap-2 text-white/65"><span className="grid h-5 w-5 place-items-center rounded-full bg-white/12"><Play className="ml-px h-2.5 w-2.5" fill="currentColor" /></span><div className="h-px flex-1 bg-white/20"><span className="block h-full w-[38%] bg-white/75" /></div><span className="font-mono text-[8px] text-white/60">00:08</span><Volume2 className="h-3 w-3" /><Maximize2 className="h-3 w-3" /></div>
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
  sourceName,
}: {
  progress: number;
  status: string;
  activeStep: PipelineStageId;
  activities: AnalysisActivity[];
  readyCount: number;
  elapsed: number;
  onCancel: () => void;
  sourceName?: string;
}) {
  const finishing = progress >= 96 || activeStep === "complete";
  const pipelineIndex = Math.max(0, PIPELINE.findIndex((stage) => stage.id === activeStep));
  const loaderStage = activeStep === "complete" ? 4 : pipelineIndex < 5 ? 0 : pipelineIndex < 8 ? 1 : pipelineIndex < 10 ? 2 : 3;
  const loaderStages = [
    `Finding viral moment in ${sourceName?.trim() || "your YouTube video"}`,
    "Extracting transcript",
    "Applying subtitles",
    "Finalising",
  ];
  const loaderIcons = [Search, FileVideo2, WandSparkles, Check];
  return createPortal(
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.25 }}
      className="fixed inset-0 z-[9999] grid place-items-center bg-[#f7f8fa] px-5 py-8"
    >
      <motion.section
        data-testid="clipper-processing"
        initial={{ opacity: 0, y: 20, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
        className="w-full max-w-[460px] overflow-hidden rounded-[28px] border border-[#e7eaf0] bg-white shadow-[0_18px_52px_rgba(15,23,42,.08)]"
      >
        <div className="flex flex-col items-center px-8 pb-8 pt-10">
          <div className="relative mb-7"><ProgressRing percent={progress} size={108} strokeWidth={6} color={finishing ? "#10b981" : "#4169f6"} /></div>
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-[.14em] text-[#4169f6]">Clyra AI Clipper</p>
          <h2 className="text-[17px] font-semibold tracking-[-.02em] text-slate-900">{finishing ? "Finalising your clips" : "Creating your best clips"}</h2>
          <div className="mt-5 flex items-center gap-2 text-[12px] font-medium text-slate-400"><Clock3 className="h-3.5 w-3.5" /><span className="tabular-nums">{elapsed}s</span>{readyCount > 0 ? <><span className="text-slate-300">·</span><span>{readyCount} clip{readyCount !== 1 ? "s" : ""} ready</span></> : null}</div>
        </div>
        <div className="border-t border-slate-100 px-6 py-4"><div className="space-y-2">{loaderStages.map((label, index) => { const done = index < loaderStage || finishing; const active = index === loaderStage && !finishing; const Icon = loaderIcons[index]; return <motion.div key={label} initial={{ opacity: 0, y: 3 }} animate={{ opacity: done || active ? 1 : .4, y: 0 }} transition={{ duration: .2 }} className="flex items-center gap-3"><motion.span animate={active ? (index === 0 ? { scale: [1, 1.14, 1], rotate: [0, -6, 6, 0] } : index === 1 ? { y: [0, 2, 0] } : index === 2 ? { scale: [1, 1.12, 1] } : { rotate: [0, 90, 180] }) : { scale: 1, rotate: 0, y: 0 }} transition={{ duration: .75, repeat: active ? Infinity : 0, ease: "easeInOut" }} className={cn("grid h-6 w-6 place-items-center rounded-lg", done ? "bg-emerald-500 text-white" : active ? "bg-blue-50 text-blue-600" : "bg-slate-100 text-slate-300")}>{done ? <Check className="h-3.5 w-3.5" /> : <Icon className="h-3.5 w-3.5" />}</motion.span><span className="text-[12px] font-medium text-slate-700">{label}</span></motion.div>; })}</div></div>
        {!finishing ? <div className="border-t border-slate-100 px-6 py-4"><button type="button" onClick={onCancel} className="flex h-10 w-full items-center justify-center rounded-xl border border-slate-200 bg-white text-[13px] font-medium text-slate-600 transition-colors hover:bg-slate-50 hover:text-slate-900">Cancel analysis</button></div> : null}
      </motion.section>
    </motion.div>,
    document.body,
  );
}

function ExportScreen({ state, mode = "export", percent = 0 }: { state: "exporting" | "done"; mode?: "export" | "subtitles"; percent?: number }) {
  const complete = state === "done";
  const rerenderingSubtitles = mode === "subtitles";
  return createPortal(
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }} className="fixed inset-0 z-[10001] grid place-items-center bg-[#f7f8fa]/92 px-5 backdrop-blur-sm">
      <motion.section initial={{ opacity: 0, y: 12, scale: .98 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ duration: .32, ease: [0.16, 1, .3, 1] }} className="w-full max-w-[360px] rounded-[26px] border border-slate-200/80 bg-white px-8 py-9 text-center shadow-[0_18px_52px_rgba(15,23,42,.10)]">
        {complete ? (
          <motion.div className="mx-auto grid h-[88px] w-[88px] place-items-center rounded-full bg-emerald-50 text-emerald-500" animate={{ scale: [1, 1.06, 1] }} transition={{ duration: .35 }}>
            <Check className="h-8 w-8" />
          </motion.div>
        ) : (
          <div className="mx-auto grid place-items-center"><ProgressRing percent={percent} size={96} strokeWidth={6} /></div>
        )}
        <h2 className="mt-5 text-[17px] font-semibold tracking-[-.025em] text-slate-900">{complete ? "Export ready" : rerenderingSubtitles ? "Updating your clip" : "Exporting your clip"}</h2>
        <p className="mt-2 text-[12px] leading-5 text-slate-500">{complete ? "Your MP4 download is starting now." : rerenderingSubtitles ? "Applying your framing changes to the preview." : "Burning your edited subtitles into a share-ready MP4."}</p>
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

function formatTimelineTime(seconds: number) {
  const safe = Math.max(0, seconds || 0);
  return `${String(Math.floor(safe / 60)).padStart(2, "0")}:${String(Math.floor(safe % 60)).padStart(2, "0")}.${String(Math.floor((safe % 1) * 1000)).padStart(3, "0")}`;
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
  const [view, setView] = useState<WorkspaceView>("home");
  const [advanced, setAdvanced] = useState(false);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("captions");
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
  const [activeCaptionIndex, setActiveCaptionIndex] = useState(0);
  const [rewriteBusy, setRewriteBusy] = useState(false);
  const [refineBusy, setRefineBusy] = useState(false);
  const [refineProgress, setRefineProgress] = useState(0);
  const [exportProgress, setExportProgress] = useState(0);
  const [selectedFaceId, setSelectedFaceId] = useState<string>("");
  const [previewTimeMs, setPreviewTimeMs] = useState(0);
  const [wizardPeople, setWizardPeople] = useState<AvailableFace[]>([]);
  const [peopleScanning, setPeopleScanning] = useState(false);
  const [autoclipStatus, setAutoclipStatus] = useState<AutoClipRunnerStatus | null>(null);
  const [sourceTitle, setSourceTitle] = useState("");
  const [exportState, setExportState] = useState<"idle" | "exporting" | "done">("idle");
  const previewVideoRef = useRef<HTMLVideoElement | null>(null);
  const task = useRef<AbortController | null>(null);
  // Guards against a rapid double-click on "Generate clips": the view only
  // switches away from the button on the next render, so a second physical
  // click landing before that repaint would otherwise start a second real
  // pipeline run (confirmed via a live double POST to /api/clipper/start).
  const starting = useRef(false);
  const resultBuffer = useRef<ClipResult[]>([]);
  void onClose;

  useEffect(() => {
    if (!initialUrl) return;
    setDraft((current) => ({ ...current, source: { mode: "url", url: initialUrl } }));
  }, [initialUrl]);

  useEffect(() => {
    // Visual QA fixture: `?clipDemo=1` opens the desktop editor with a real
    // local video + synthetic word timings so layout can be screenshot-checked
    // without running the Python pipeline.
    const params = new URLSearchParams(window.location.search);
    if (params.get("clipDemo") !== "1") return;
    const fixture = demoClipFixture();
    setResults([fixture]);
    setSelectedId(fixture.id);
    setView("results");
    window.dispatchEvent(new CustomEvent("clyra:workflow-tabs-hide"));
  }, []);

  useEffect(() => {
    const url = draft.source.url.trim();
    if (draft.source.mode !== "url" || !youtubeEmbedUrl(url)) {
      setSourceTitle("");
      return;
    }
    const controller = new AbortController();
    setSourceTitle("");
    void fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`, { signal: controller.signal })
      .then((response) => response.ok ? response.json() as Promise<{ title?: string }> : null)
      .then((data) => {
        if (data?.title) setSourceTitle(data.title);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [draft.source.mode, draft.source.url]);

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
  const sourceReady = draft.source.mode === "url" ? /^https?:\/\//i.test(draft.source.url.trim()) : Boolean(draft.source.uploadId);
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
    if (!sourceReady) {
      setError("Add a valid video source before generating clips.");
      return;
    }
    if (starting.current) return;
    starting.current = true;
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
              smartReframe: draft.faceTracking !== "off",
              reframeMode: reframeModeFor(draft),
              speakerMode: speakerModeFor(draft),
              trackingQuality: draft.faceTracking === "off" ? "low_memory" : "balanced",
              splitScreen: false,
            },
            captions_enabled: draft.captionsEnabled,
            caption_collision_mode: draft.captionCollisionMode || "keep-existing",
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
            progress?: number;
            overall?: number;
          };
          if (event.type === "error") throw new Error(event.message || "Clip rendering failed");
          // The pipeline reports a monotonic stage-weighted overall percent;
          // use it directly so the ring fills smoothly and honestly.
          const overall = Number(event.overall);
          if (Number.isFinite(overall) && overall > 0) {
            setProgress((current) => Math.max(current, Math.min(99, overall)));
          }
          const stage = pipelineStageFor(event.step);
          if (stage) {
            setActiveStep(stage);
            const index = Math.max(0, PIPELINE.findIndex((item) => item.id === stage));
            const stageWidth = 72 / Math.max(1, PIPELINE.length - 1);
            const stageProgress = 8 + (index * stageWidth);
            const candidateProgress = Math.min(18, resultBuffer.current.length / Math.max(1, draft.clipCount) * 18);
            // When the worker reports sampled-frame completion, map that real
            // measurement into the current stage. No timed or simulated
            // percentages are used, so a long visual pass remains honest while
            // still visibly advancing.
            const workerProgress = Number(event.progress);
            const measuredProgress = Number.isFinite(workerProgress)
              ? stageProgress + Math.max(0, Math.min(1, workerProgress)) * stageWidth
              : stageProgress;
            setProgress((current) => stage === "complete" ? 100 : Math.min(98, Math.max(current, Math.round(measuredProgress + candidateProgress))));
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
          // Process stderr is retained in the activity trail for diagnostics,
          // but must never replace the user-facing pipeline stage. Native
          // libraries (for example MediaPipe) routinely emit warnings while
          // framing continues; showing one as the headline makes a healthy
          // render look frozen or failed.
          if (event.message && event.type !== "log") setStatus(event.message);
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
      starting.current = false;
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
    setActiveCaptionIndex(0);
  // A different clip gets a fresh committed subtitle state. Subtitle edits
  // never block playback: the detached overlay renders them instantly.
  }, [selected?.id]);

  // Hydrate word timing from the artifact store when a stored project has an
  // artifact id but its result payload lost the word array (older sessions).
  useEffect(() => {
    if (!selected?.artifact_id || selected.words?.length || captionWords.length) return;
    const controller = new AbortController();
    void fetch(`/api/clipper/artifact/${encodeURIComponent(selected.artifact_id)}/words.json`, { signal: controller.signal })
      .then((response) => (response.ok ? response.json() as Promise<CaptionWord[]> : null))
      .then((value) => {
        if (!Array.isArray(value) || !value.length) return;
        const hydrated = value.map((item) => ({ ...item, word: wordText(item), text: wordText(item) }));
        setCaptionWords(hydrated);
        setResults((items) => items.map((item) => (item.id === selected.id ? { ...item, words: hydrated } : item)));
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [selected?.id, selected?.artifact_id]);

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
    setRefineProgress(0);
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
          captionCollisionMode: draft.captionCollisionMode || "keep-existing",
          font: draft.font,
          fontSize: draft.fontSize,
          textColour: draft.colour,
          position: draft.position,
          captionX: draft.captionX,
          captionY: draft.captionY,
          renderQuality: draft.renderQuality,
          words: payloadWords,
          // Editor pin-zoom effects (preview applies to video only; captions stay fixed).
          zoomEffects: (() => {
            try {
              const saved = JSON.parse(localStorage.getItem(`clyra.timeline.${selected.id}`) || "null");
              return Array.isArray(saved?.zoomEffects) ? saved.zoomEffects : [];
            } catch {
              return [];
            }
          })(),
          // Sound FX clips dragged onto the Audio timeline (mixed into final AAC).
          sfxTracks: (() => {
            try {
              const saved = JSON.parse(localStorage.getItem(`clyra.timeline.${selected.id}`) || "null");
              return Array.isArray(saved?.sfxClips) ? saved.sfxClips : [];
            } catch {
              return [];
            }
          })(),
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
          const event = JSON.parse(line.slice(6)) as { type?: string; message?: string; result?: ClipResult; overall?: number };
          if (event.type === "error") throw new Error(event.message || "Re-render failed");
          const overall = Number(event.overall);
          if (Number.isFinite(overall) && overall > 0) setRefineProgress((current) => Math.max(current, Math.min(99, overall)));
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

  // "Regenerate subtitles" is near-instant: it re-reads the pipeline's word
  // timing from the artifact store (overlay JSON only) and normalises it. No
  // FFmpeg re-encode happens until an explicit export.
  const rewriteSelectedCaption = async () => {
    if (!selected || rewriteBusy) return;
    setRewriteBusy(true);
    try {
      let source = captionWords;
      if (selected.artifact_id) {
        try {
          const response = await fetch(`/api/clipper/artifact/${encodeURIComponent(selected.artifact_id)}/words.json`);
          const value = response.ok ? await response.json() as CaptionWord[] : null;
          if (Array.isArray(value) && value.length) source = value;
        } catch { /* Fall back to cleaning the in-memory words. */ }
      }
      const cleaned = rewriteTimedWords(source);
      setCaptionWords(cleaned);
      setResults((items) => items.map((item) => (item.id === selected.id ? { ...item, words: cleaned, caption: cleaned.map(wordText).filter(Boolean).join(" ").slice(0, 220) } : item)));
    } finally {
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

  // Export is the ONLY step that burns subtitles into pixels: the edited
  // word-timing JSON is sent to the Python/FFmpeg burn-in, which composites
  // the caption layer onto the already-rendered clean clip in one encode.
  const exportSelectedClip = async () => {
    if (!selected || exportState !== "idle") return;
    persistSelectedEdits();
    const downloadFile = (href: string) => {
      const anchor = document.createElement("a");
      anchor.href = href;
      anchor.download = "";
      anchor.click();
    };
    const wantsCaptionBurn = selected.captions_enabled !== false && captionWords.length > 0 && hasDetachedCaptions(selected);
    if (!selected.artifact_id || !wantsCaptionBurn) {
      // Nothing to composite (captions off, already burned, or no artifacts):
      // the rendered MP4 is already the export.
      setExportState("exporting");
      setExportProgress(100);
      window.setTimeout(() => {
        setExportState("done");
        downloadFile(outputUrl(selected.output));
        window.setTimeout(() => setExportState("idle"), 1_000);
      }, 320);
      return;
    }
    setExportState("exporting");
    setExportProgress(0);
    setError("");
    try {
      const style = selected.caption_style;
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
          subtitlesOnly: true,
          burnCaptions: true,
          captionsEnabled: true,
          words: payloadWords,
          font: style?.font ?? draft.font,
          fontSize: style?.font_size ?? draft.fontSize,
          textColour: style?.text_colour ?? draft.colour,
          position: style?.position ?? draft.position,
          captionX: style?.caption_x ?? draft.captionX,
          captionY: style?.caption_y ?? draft.captionY,
          subtitleStyle: style?.subtitle_style ?? draft.subtitleStyle,
          renderQuality: draft.renderQuality,
          sfxTracks: (() => {
            try {
              const saved = JSON.parse(localStorage.getItem(`clyra.timeline.${selected.id}`) || "null");
              return Array.isArray(saved?.sfxClips) ? saved.sfxClips : [];
            } catch {
              return [];
            }
          })(),
        }),
      });
      if (!response.ok) {
        const detail = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(detail.error || `Export failed (${response.status})`);
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Export returned no stream");
      const decoder = new TextDecoder();
      let buffer = "";
      let exported: ClipResult | null = null;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line.startsWith("data: ")) continue;
          const event = JSON.parse(line.slice(6)) as { type?: string; message?: string; result?: ClipResult; overall?: number };
          if (event.type === "error") throw new Error(event.message || "Export failed");
          const overall = Number(event.overall);
          if (Number.isFinite(overall) && overall > 0) setExportProgress((current) => Math.max(current, Math.min(99, overall)));
          if (event.result?.output) exported = event.result;
        }
      }
      if (!exported?.output) throw new Error("Export finished without a downloadable MP4");
      setExportProgress(100);
      setExportState("done");
      downloadFile(outputUrl(exported.output));
      window.setTimeout(() => setExportState("idle"), 1_100);
    } catch (cause) {
      setExportState("idle");
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const wizardMeta = [
    { id: "source" as const, title: "Source", detail: "Paste a link or upload a file" },
    { id: "subtitles" as const, title: "Subtitles", detail: "Captions, framing and safe placement" },
    { id: "output" as const, title: "Output", detail: "Length and clip count" },
  ];
  const canContinue = wizardStep === 0 ? sourceReady && !uploading : true;
  const legacyCreateView = (
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
                      <p className="mt-0.5 text-[10px] leading-4 text-slate-400">Clyra uses one caption layer by default. If the source already has captions, it preserves them instead of stacking another set on top.</p>
                      <div className="mt-3 grid grid-cols-3 gap-1 rounded-lg border border-slate-200 bg-slate-50 p-1" role="radiogroup" aria-label="Existing caption handling">
                        {([
                          ["keep-existing", "Keep source"],
                          ["auto", "Move Clyra"],
                          ["allow-overlap", "Allow overlap"],
                        ] as Array<[CaptionCollisionMode, string]>).map(([mode, label]) => (
                          <button
                            key={mode}
                            type="button"
                            role="radio"
                            aria-checked={(draft.captionCollisionMode || "keep-existing") === mode}
                            onClick={() => updateDraft("captionCollisionMode", mode)}
                            className={cn(
                              "h-8 rounded-md px-2 text-[10px] font-medium transition-colors",
                              (draft.captionCollisionMode || "keep-existing") === mode ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700",
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
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-[12px] font-medium text-slate-800">Face tracking</p>
                        <p className="mt-0.5 text-[10px] leading-4 text-slate-400">
                          Centres the vertical frame on the subject and follows nods and pans smoothly with MediaPipe (open source). No lag in preview.
                        </p>
                      </div>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={draft.faceTracking !== "off"}
                        aria-label="Face tracking"
                        onClick={() => setFaceTrackingPreset(draft.faceTracking === "off" ? "auto" : "none")}
                        className={cn(
                          "relative mt-0.5 h-[22px] w-[40px] shrink-0 rounded-full transition-colors duration-150",
                          draft.faceTracking !== "off" ? "bg-[#4169f6]" : "bg-slate-200",
                        )}
                      >
                        <span
                          className="absolute top-[3px] h-[16px] w-[16px] rounded-full bg-white shadow-sm transition-[left] duration-150"
                          style={{ left: draft.faceTracking !== "off" ? 21 : 3 }}
                        />
                      </button>
                    </div>
                    {draft.faceTracking !== "off" && draft.source.mode === "upload" ? (
                      <button
                        type="button"
                        disabled={!draft.source.uploadId || peopleScanning}
                        onClick={() => void scanPeopleForUpload(draft.source.uploadId)}
                        className="mt-3 h-9 rounded-lg border border-slate-200 bg-white px-3 text-[10px] font-semibold text-slate-700 transition-colors hover:border-slate-400 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {peopleScanning ? "Scanning people…" : "Scan people in upload"}
                      </button>
                    ) : null}
                    {draft.faceTracking !== "off" && wizardPeople.length ? (
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
                        <option value="premium">Premium 1080p 30fps · best quality</option><option value="balanced">Balanced 720p · fastest delivery</option><option value="master">Master 1080p · maximum detail</option>
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
                <button type="button" disabled={!sourceReady} onClick={() => void run()} className="flex h-11 items-center gap-2 rounded-full bg-slate-950 px-6 text-[10px] font-semibold text-white transition-transform active:scale-[.98] disabled:opacity-35">
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

  const legacyResultsView = (
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

  const createView = (
    <div className="h-full overflow-hidden bg-[#f7f8fa] p-4 sm:p-6">
      <div className="mx-auto flex h-full w-full max-w-[1660px] flex-col overflow-hidden rounded-[26px] border border-[#e7eaf0] bg-white shadow-[0_16px_48px_rgba(15,23,42,.055)]">
        <header className="flex h-14 shrink-0 items-center border-b border-[#eff1f5] px-6">
          <div className="flex items-center gap-2 text-[16px] font-semibold tracking-[-.03em] text-[#111318]"><Bloub state="idle" size={24} color="#4169f6" background="#ffffff" />Clyra</div>
        </header>
        <div className="mx-auto flex min-h-0 w-full max-w-[1360px] flex-1 flex-col px-8 py-5">
        <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-[#e7eaf0] bg-white">
          <motion.div
            key={wizardStep}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
            className="min-h-0 flex-1 overflow-hidden p-4 sm:p-5"
          >
            <div className="mb-4 flex items-start justify-between gap-4">
              <div>
                <h2 className="text-[clamp(20px,2vw,26px)] font-semibold tracking-0 text-[#111318]">
                  {wizardStep === 0 ? "Video source" : wizardStep === 1 ? "Caption appearance" : "Output settings"}
                </h2>
                <p className="mt-1 text-[13px] leading-5 text-slate-500 max-w-sm">
                  {wizardStep === 0 ? "Clyra uses the full source, transcript, audio and visuals together." : wizardStep === 1 ? "Both word-by-word and dynamic phrase captions remain available." : "Clyra will preserve context and avoid abrupt sentence cuts."}
                </p>
              </div>
            </div>

            {wizardStep === 0 ? (
              <div className="grid h-full min-h-0 gap-7 lg:grid-cols-[minmax(0,.82fr)_minmax(0,1.18fr)]">
                <div>
                  <SourcePicker
                  source={draft.source}
                  onSource={(source) => updateDraft("source", source)}
                  onFile={(file) => void handleFile(file)}
                  uploading={uploading}
                  uploadProgress={uploadProgress}
                  showPreview={false}
                />
                <p className="mt-5 text-[11px] leading-4 text-slate-400">Clyra Vision automatically combines transcript, audio and visual evidence for each project.</p>
                </div>
                <div className="self-start overflow-hidden rounded-2xl border border-[#e7eaf0] bg-[#f7f8fa] p-3 lg:-mt-5">
                  {youtubeThumbnailUrl(draft.source.url) ? (
                    <div className="relative aspect-video w-full overflow-hidden rounded-xl bg-slate-900">
                      <img src={youtubeThumbnailUrl(draft.source.url) || ""} alt="" className="h-full w-full object-cover" />
                      <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/50 via-transparent to-black/10" />
                      {sourceTitle ? (
                        <p className="absolute inset-x-3 bottom-3 line-clamp-2 text-[12px] font-medium leading-4 text-white drop-shadow">{sourceTitle}</p>
                      ) : (
                        <span className="absolute bottom-3 left-3 rounded-md bg-black/55 px-2 py-1 text-[10px] font-medium text-white/90">YouTube source</span>
                      )}
                    </div>
                  ) : (
                    <div className="grid aspect-video place-items-center rounded-xl border border-dashed border-slate-200 bg-white text-center">
                      <div>
                        <Video className="mx-auto h-5 w-5 text-slate-300" />
                        <p className="mt-3 text-[13px] font-medium text-slate-600">Your video preview will appear here</p>
                        <p className="mt-1 text-[11px] text-slate-400">Paste a supported YouTube URL to continue.</p>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            ) : null}

            {false ? (
              <div className="grid h-full place-items-center">
                <div className="max-w-md text-center">
                  <span className="mx-auto flex w-fit"><Bloub state="idle" size={44} color="#4169f6" background="#ffffff" /></span>
                  <h3 className="mt-4 text-[17px] font-semibold tracking-[-.02em] text-slate-900">Clyra will find the strongest moments automatically</h3>
                  <p className="mt-2 text-[13px] leading-5 text-slate-500">It ranks hooks, clarity, pacing and emotional lift, then keeps each clip complete and ready to watch.</p>
                  <div className="mt-6 grid grid-cols-3 gap-2 text-left">{[["Hook","Strong opening"],["Context","Complete thought"],["Pacing","No dead space"]].map(([label,detail]) => <div key={label} className="rounded-xl border border-slate-200/80 bg-slate-50/60 p-3"><p className="text-[11px] font-semibold text-slate-800">{label}</p><p className="mt-1 text-[10px] leading-4 text-slate-400">{detail}</p></div>)}</div>
                </div>
              </div>
            ) : null}

            {wizardStep === 1 ? (
              <div className="grid h-full min-h-0 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(320px,.9fr)]">
              <div className="grid content-start gap-3">
                <div className="rounded-xl border border-slate-200/80 bg-slate-50/60 p-4">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="block"><span className="mb-1.5 block text-[11px] font-medium text-slate-500">Subtitle mode</span><select value={draft.captionsEnabled ? draft.subtitleStyle : "off"} onChange={(event) => { const value = event.target.value; updateDraft("captionsEnabled", value !== "off"); if (value !== "off") updateDraft("subtitleStyle", value as SubtitleStyle); }} className="h-10 w-full rounded-lg border border-slate-200/80 bg-white px-3 text-[12px] font-medium outline-none focus:border-blue-400"><option value="phrase-highlight">Dynamic phrase</option><option value="word">One word</option><option value="off">No subtitles</option></select></label>
                    <label className="block"><span className="mb-1.5 block text-[11px] font-medium text-slate-500">Font</span><select value={draft.font} onChange={(event) => updateDraft("font", event.target.value)} className="h-10 w-full rounded-lg border border-slate-200/80 bg-white px-3 text-[12px] font-medium outline-none focus:border-blue-400"><option>Impact</option><option>Arial Black</option><option>Helvetica</option></select></label>
                    <label className="block"><span className="mb-1.5 block text-[11px] font-medium text-slate-500">Position</span><select value={draft.position} onChange={(event) => updateDraft("position", event.target.value as CaptionPosition)} className="h-10 w-full rounded-lg border border-slate-200/80 bg-white px-3 text-[12px] font-medium outline-none focus:border-blue-400"><option value="top">Top</option><option value="centre">Middle</option><option value="bottom">Bottom</option></select></label>
                    <label className="block"><span className="mb-1.5 block text-[11px] font-medium text-slate-500">Colour</span><div className="flex h-10 items-center gap-2 rounded-lg border border-slate-200/80 bg-white px-3"><span className="h-4 w-4 rounded-full border border-slate-300 shadow-sm" style={{ backgroundColor: draft.colour }} /><input aria-label="Subtitle colour" type="color" value={draft.colour} onChange={(event) => updateDraft("colour", event.target.value)} className="h-6 min-w-0 flex-1 cursor-pointer bg-transparent outline-none" /></div></label>
                  </div>
                  <div className="mt-3"><span className="mb-1.5 block text-[11px] font-medium text-slate-500">Colour presets</span><div className="flex h-8 items-center gap-2">{['#FFFFFF','#4169f6','#F4D35E','#5DBB7A','#C58AF9','#F28BAE'].map((colour) => <button key={colour} type="button" onClick={() => updateDraft("colour", colour)} aria-label={`Use ${colour} subtitles`} className={cn("h-6 w-6 rounded-full border-2", draft.colour === colour ? "border-[#4169f6] ring-2 ring-[#edf2ff]" : "border-white shadow-sm")} style={{ backgroundColor: colour }} />)}</div></div>
                </div>
              </div>
              <aside className="flex min-h-0 flex-col items-center justify-start overflow-hidden p-0 lg:-mt-5">
                <ClipperMockVideoFrame aspect="9:16" captionsEnabled={draft.captionsEnabled} captionX={draft.captionX} captionY={draft.captionY} subtitleStyle={draft.subtitleStyle} font={draft.font} fontSize={draft.fontSize} colour={draft.colour} />
                <p className="mt-2 text-[11px] text-slate-400">Live subtitle preview</p>
              </aside>
              </div>
            ) : null}

            {wizardStep === 2 ? (
              <div className="grid h-full min-h-0 gap-8 lg:grid-cols-[minmax(0,.9fr)_minmax(320px,1.1fr)]">
                <div className="grid content-start gap-4">
                  <div><p className="mb-2 text-[12px] font-medium text-slate-600">Amount of videos</p><div className="grid grid-cols-3 rounded-xl border border-slate-200 bg-slate-50 p-1">{[1,2,3].map((count) => <button key={count} type="button" onClick={() => updateDraft("clipCount", count)} className={cn("h-10 rounded-lg text-[13px] font-semibold transition-colors", draft.clipCount === count ? "bg-white text-[#4169f6] shadow-sm ring-1 ring-slate-200" : "text-slate-500 hover:text-slate-800")}>{count}</button>)}</div></div>
                  <label className="block"><span className="mb-2 block text-[12px] font-medium text-slate-600">Aspect ratio</span><select value={draft.aspect} onChange={(event) => updateDraft("aspect", event.target.value as ClipAspect)} className="h-11 w-full rounded-xl border border-slate-200/80 bg-white px-3.5 text-[13px] font-medium text-slate-800 outline-none focus:border-blue-400"><option value="9:16">9:16 · Vertical</option><option value="1:1">1:1 · Square</option><option value="16:9">16:9 · Landscape</option></select></label>
                  <label className="block"><span className="mb-2 block text-[12px] font-medium text-slate-600">Clip length</span><select value={draft.clipLength} onChange={(event) => updateDraft("clipLength", Number(event.target.value))} className="h-11 w-full rounded-xl border border-slate-200/80 bg-white px-3.5 text-[13px] font-medium text-slate-800 outline-none focus:border-blue-400"><option value={15}>15 seconds</option><option value={30}>30 seconds</option><option value={45}>45 seconds</option><option value={60}>60 seconds</option></select></label>
                  <label className="block"><span className="mb-2 block text-[12px] font-medium text-slate-600">Render quality</span><select value={draft.renderQuality === "premium" || draft.renderQuality === "master" ? "1080" : "720"} onChange={(event) => updateDraft("renderQuality", event.target.value === "1080" ? "premium" : "balanced")} className="h-11 w-full rounded-xl border border-slate-200/80 bg-white px-3.5 text-[13px] font-medium text-slate-800 outline-none focus:border-blue-400"><option value="1080">1080p · recommended</option><option value="720">720p · faster export</option></select></label>
                </div>
                <aside className="flex min-h-0 items-start justify-center p-0">
                  <ClipperMockVideoFrame aspect={draft.aspect} clipCount={draft.clipCount} quality={draft.renderQuality === "balanced" ? "720p" : "1080p"} captionsEnabled={draft.captionsEnabled} captionX={draft.captionX} captionY={draft.captionY} subtitleStyle={draft.subtitleStyle} font={draft.font} fontSize={draft.fontSize} colour={draft.colour} copy="YOUR CLIP STARTS HERE" />
                </aside>
              </div>
            ) : null}

            {error ? (
              <p className="mt-5 rounded-xl bg-red-50 px-4 py-3 text-[12px] font-medium text-red-600">
                {error}
              </p>
            ) : null}
          </motion.div>
        </section>

        <footer className="mt-4 shrink-0">
          <div className="flex min-h-[88px] items-center gap-2 rounded-[22px] border border-[#e2e5ea] bg-white px-5 shadow-[0_12px_38px_rgba(15,23,42,.05)] sm:px-7">
            {wizardMeta.map((item, index) => {
              const StepIcon = item.id === "source" ? Video : item.id === "subtitles" ? MessageSquare : SlidersHorizontal;
              const active = wizardStep === index;
              return (
                <div key={item.id} className="flex items-center">
                  <button
                    type="button"
                    onClick={() => setWizardStep(index)}
                    className={cn(
                      "flex h-12 items-center gap-3 rounded-2xl px-3 text-[15px] font-medium transition-colors",
                      active ? "text-[#111318]" : "text-[#68707c] hover:bg-[#f6f8fc] hover:text-[#303642]",
                    )}
                  >
                    <span className={cn("grid h-10 w-10 place-items-center rounded-full", active ? "bg-[#4169f6] text-white" : "bg-[#edf2ff] text-[#4169f6]")}>
                      <StepIcon className="h-[19px] w-[19px]" />
                    </span>
                    {item.title}
                  </button>
                  {index < wizardMeta.length - 1 ? <span className="px-1 text-[22px] font-light text-[#a1a8b3]">›</span> : null}
                </div>
              );
            })}
            {wizardStep < 2 ? (
              <button
                type="button"
                disabled={!canContinue}
                onClick={() => setWizardStep((step) => Math.min(2, step + 1))}
                className="ml-auto flex h-[52px] min-w-[145px] items-center justify-center gap-3 rounded-full bg-[#4169f6] px-7 text-[16px] font-medium text-white shadow-[0_10px_22px_rgba(65,105,246,.25)] transition-[transform,background-color] hover:bg-[#3158ea] active:scale-[.98] disabled:cursor-not-allowed disabled:opacity-40"
              >
                Continue
                <ChevronRight className="h-5 w-5" />
              </button>
            ) : (
              <button
                type="button"
                disabled={!sourceReady || uploading}
                onClick={() => void run()}
                className="ml-auto flex h-[52px] min-w-[170px] items-center justify-center gap-3 rounded-full bg-[#4169f6] px-7 text-[16px] font-medium text-white shadow-[0_10px_22px_rgba(65,105,246,.25)] transition-[transform,background-color] hover:bg-[#3158ea] active:scale-[.98] disabled:cursor-not-allowed disabled:opacity-40"
              >
                <WandSparkles className="h-5 w-5" />
                Generate clips
              </button>
            )}
          </div>
        </footer>
        </div>
      </div>
    </div>
  );

  // Caption style used by the detached overlay: the pipeline's exact burn-in
  // contract when available, otherwise the draft settings.
  const selectedCaptionStyle: CaptionStyle = selected?.caption_style || {
    font: draft.font,
    font_size: draft.fontSize,
    text_colour: draft.colour,
    position: draft.position,
    caption_x: draft.captionX,
    caption_y: draft.captionY,
    subtitle_style: draft.subtitleStyle,
  };

  const changeCaptionWord = (index: number, text: string) => {
    const next = captionWords.map((word, wordIndex) => (wordIndex === index ? { ...word, word: text, text } : word));
    setCaptionWords(next);
    if (selected) {
      setResults((items) => items.map((item) => (item.id === selected.id ? { ...item, words: next } : item)));
    }
  };

  const changeCaptionStyle = (change: Partial<CaptionStyle>) => {
    if (selected) {
      setResults((items) => items.map((item) => item.id === selected.id
        ? { ...item, caption_style: { ...(item.caption_style || selectedCaptionStyle), ...change } }
        : item));
      return;
    }
    setDraft((current) => ({
      ...current,
      ...(change.font ? { font: change.font } : {}),
      ...(change.text_colour ? { colour: change.text_colour } : {}),
      ...(change.subtitle_style ? { subtitleStyle: change.subtitle_style as SubtitleStyle } : {}),
    }));
  };

  const resultsView = (
    <ClipperEditor
      clips={filteredResults}
      selected={selected}
      onSelectClip={setSelectedId}
      onRenameClip={(id, title) => setResults((current) => current.map((item) => (item.id === id ? { ...item, title } : item)))}
      onNewClip={() => { setView("create"); setWizardStep(2); }}
      search={search}
      onSearch={setSearch}
      qualityLabel={draft.renderQuality === "balanced" ? "720p" : "1080p"}
      scoreFor={(clip) => clipPotentialScore(results.find((item) => item.id === clip.id) || (clip as ClipResult))}
      // The editable preview always uses the caption-free plate when the
      // project owns a detached caption layer. This prevents a burned legacy
      // output plus the live editor overlay from ever creating two subtitle
      // sets, and keeps captions fixed while a face crop moves underneath.
      srcFor={(clip) => {
        const result = clip as ClipResult;
        return result.plate_url && hasDetachedCaptions(result)
          ? result.plate_url
          : outputUrl(clip.output);
      }}
      words={captionWords}
      onWordChange={changeCaptionWord}
      activeWordIndex={activeCaptionIndex}
      onActiveWordIndex={setActiveCaptionIndex}
      captionStyle={selectedCaptionStyle}
      onCaptionStyleChange={changeCaptionStyle}
      captionsVisible={Boolean(
        selected
        && selected.captions_enabled !== false
        && captionWords.length > 0
        && hasDetachedCaptions(selected)
      )}
      videoRef={previewVideoRef}
      currentTime={previewTimeMs / 1000}
      onTimeChange={(seconds) => setPreviewTimeMs(Math.round(seconds * 1000))}
      onRegenerate={() => void rewriteSelectedCaption()}
      regenerateBusy={rewriteBusy}
      onExport={() => void exportSelectedClip()}
      exportBusy={exportState !== "idle"}
      error={error}
      onDismissError={() => setError("")}
      faceTrackingEnabled={draft.faceTracking !== "off"}
    />
  );

  const projectsView = (
    <div className="h-full overflow-hidden bg-[#f7f8fa] p-5 sm:p-7">
      <div className="mx-auto flex h-full max-w-[1500px] flex-col rounded-[26px] border border-[#e7eaf0] bg-white shadow-[0_16px_48px_rgba(15,23,42,.055)]">
        <header className="flex h-14 shrink-0 items-center border-b border-[#eff1f5] px-6"><div className="flex items-center gap-2 text-[16px] font-semibold tracking-[-.03em]"><Bloub state="idle" size={24} color="#4169f6" background="#ffffff" />Clyra</div><div className="ml-auto flex items-center gap-2"><button type="button" onClick={() => setView("home")} className="h-8 rounded-lg px-3 text-[12px] font-medium text-slate-500 hover:bg-slate-50">Home</button><button type="button" onClick={() => setView("create")} className="flex h-9 items-center gap-1.5 rounded-xl bg-[#4169f6] px-3.5 text-[12px] font-semibold text-white hover:bg-[#3158ea]"><Plus className="h-3.5 w-3.5" />New clip</button></div></header>
        <div className="min-h-0 flex-1 p-6 sm:p-8"><div className="flex items-end justify-between gap-4"><div><h1 className="text-[25px] font-semibold tracking-[-.04em] text-[#111318]">Projects</h1><p className="mt-1 text-[13px] text-slate-500">Your generated clips, ready to review or refine.</p></div><label className="flex h-10 w-full max-w-[280px] items-center gap-2 rounded-xl border border-slate-200 px-3"><Search className="h-4 w-4 text-slate-400" /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search projects" className="min-w-0 flex-1 bg-transparent text-[12px] outline-none" /></label></div>
          <div className="mt-7 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{filteredResults.length ? filteredResults.map((result) => <button key={result.id} type="button" onClick={() => { setSelectedId(result.id); setView("results"); }} className="group overflow-hidden rounded-2xl border border-slate-200/80 bg-white text-left transition-[transform,box-shadow,border-color] duration-200 hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-[0_12px_28px_rgba(15,23,42,.08)]"><div className="relative aspect-video bg-[#111318]"><video muted preload="metadata" src={outputUrl(result.output)} className="h-full w-full object-cover" /><span className="absolute right-3 top-3 rounded-md bg-black/55 px-2 py-1 text-[10px] font-semibold text-white">{result.clip_duration || "Ready"}</span></div><div className="p-4"><p className="truncate text-[13px] font-semibold text-slate-900">{result.title}</p><p className="mt-1 text-[11px] text-slate-400">{result.source_title || "Clyra clip"}</p><div className="mt-3 flex items-center justify-between"><span className="text-[11px] font-medium text-[#4169f6]">{clipPotentialScore(result)} score</span><span className="text-[11px] font-medium text-slate-500">Open editor →</span></div></div></button>) : <div className="col-span-full grid min-h-[260px] place-items-center rounded-2xl border border-dashed border-slate-200 text-center"><div><FileVideo2 className="mx-auto h-5 w-5 text-slate-300" /><p className="mt-3 text-[13px] font-medium text-slate-600">No projects yet</p><button type="button" onClick={() => setView("create")} className="mt-3 text-[12px] font-semibold text-[#4169f6]">Make your first clip</button></div></div>}</div>
        </div>
      </div>
    </div>
  );

  const homeView = (
    <div className="grid h-full place-items-center overflow-hidden bg-[#f6f7f9] p-5 sm:p-7"><section className="w-full max-w-[680px] rounded-[30px] border border-white/90 bg-white p-7 shadow-[0_20px_60px_rgba(15,23,42,.08)] sm:p-10"><div className="text-center"><span className="mx-auto flex w-fit"><Bloub state="idle" size={44} color="#4169f6" background="#ffffff" /></span><p className="mt-4 text-[11px] font-semibold uppercase tracking-[.14em] text-[#4169f6]">Clyra AI Clipper</p><h1 className="mt-2 text-[27px] font-semibold tracking-[-.045em] text-[#111318]">Start with a video.</h1><p className="mx-auto mt-2 max-w-md text-[13px] leading-6 text-slate-500">Create a fresh clip, or return to a finished project when you are ready to refine it.</p></div><div className="mt-8 grid gap-3 sm:grid-cols-2"><button type="button" onClick={() => setView("create")} className="group flex min-h-[132px] flex-col justify-between rounded-2xl border border-blue-100 bg-[#f7f9ff] p-5 text-left transition-[background-color,box-shadow,transform] duration-200 hover:-translate-y-px hover:bg-[#edf2ff] hover:shadow-[0_10px_26px_rgba(65,105,246,.10)] active:scale-[.99]"><span className="grid h-8 w-8 place-items-center rounded-xl bg-[#4169f6] text-white shadow-sm"><Plus className="h-4 w-4" /></span><span><span className="block text-[14px] font-semibold text-slate-900">New clip</span><span className="mt-1 block text-[11px] text-slate-500">Use a YouTube link or a video file.</span></span></button><button type="button" onClick={() => setView("projects")} className="group flex min-h-[132px] flex-col justify-between rounded-2xl border border-slate-200 bg-white p-5 text-left transition-[background-color,box-shadow,transform] duration-200 hover:-translate-y-px hover:bg-slate-50 hover:shadow-[0_10px_26px_rgba(15,23,42,.07)] active:scale-[.99]"><span className="grid h-8 w-8 place-items-center rounded-xl bg-slate-100 text-slate-600"><FileVideo2 className="h-4 w-4" /></span><span><span className="block text-[14px] font-semibold text-slate-900">View projects</span><span className="mt-1 block text-[11px] text-slate-500">Play, edit, or export a completed clip.</span></span></button></div></section></div>
  );

  const content = (
    <div data-testid="ai-clipper-root" className={cn("overflow-hidden bg-[#f8fafc] text-slate-950", embedded ? "relative h-full w-full" : "fixed inset-0 z-[600]")}>
      <AnimatePresence>{view === "processing" ? <ProcessingScreen progress={progress} status={status} activeStep={activeStep} activities={analysisActivities} readyCount={readyCount} elapsed={elapsed} onCancel={cancel} sourceName={sourceTitle || draft.source.name || "your YouTube video"} /> : null}{refineBusy ? <ExportScreen state="exporting" mode="subtitles" percent={refineProgress} /> : exportState !== "idle" ? <ExportScreen state={exportState} percent={exportProgress} /> : null}</AnimatePresence>
      <div className={cn("h-full", view === "create" || view === "home" || view === "projects" ? "overflow-hidden" : "overflow-y-auto")}>{view === "home" ? homeView : view === "projects" ? projectsView : view === "results" ? resultsView : createView}</div>
    </div>
  );
  return embedded ? content : createPortal(content, document.body);
}
