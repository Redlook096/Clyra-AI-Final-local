import {
  AlertCircle,
  AudioLines,
  ChevronsLeft,
  ChevronsRight,
  Copy,
  Download,
  Link2,
  Minus,
  MoreHorizontal,
  Pencil,
  Play,
  Pause,
  Plus,
  Redo2,
  Scissors,
  Search,
  SkipBack,
  SkipForward,
  Sparkles,
  Trash2,
  Type,
  Undo2,
  ScanFace,
  Video,
  ZoomIn,
  ZoomOut,
  MapPin,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "../../lib/utils";
import {
  createZoomPinEffect,
  evaluateZoomAtTime,
  normalizeZoomEffect,
  suggestZoomEnd,
  type ZoomPinEffect,
} from "../../lib/clipZoomEffect";
import {
  CLIP_SFX_ASSETS,
  clampSfxSpeed,
  clampSfxVolume,
  createSfxClip,
  isSfxActiveAt,
  normalizeSfxClips,
  sfxEnd,
  sfxSourceTimeAt,
  sfxTimelineDuration,
  type ClipSfxAssetId,
  type ClipSfxClip,
} from "../../lib/clipSfxTimeline";
import SubtitleOverlay, { type CaptionStyle, type OverlayWord } from "./SubtitleOverlay";
import { CLIP_EDITOR, CLIP_EDITOR_FONT, CLIP_EDITOR_MONO, formatEditorTime } from "./tokens";
import { useLiveFaceTrack } from "./useLiveFaceTrack";

const SFX_DRAG_MIME = "application/x-clyra-clipper-sfx";
const SFX_BLOCK_COLORS: Record<ClipSfxAssetId, { fill: string; border: string; text: string }> = {
  thud: { fill: "rgba(245, 158, 11, 0.22)", border: "rgba(217, 119, 6, 0.55)", text: "#B45309" },
  sus: { fill: "rgba(14, 165, 233, 0.20)", border: "rgba(2, 132, 199, 0.55)", text: "#0369A1" },
  fahh_long: { fill: "rgba(16, 185, 129, 0.20)", border: "rgba(5, 150, 105, 0.55)", text: "#047857" },
  fahh_short: { fill: "rgba(244, 63, 94, 0.18)", border: "rgba(225, 29, 72, 0.5)", text: "#BE123C" },
};

/** Structural clip shape the editor needs; AIClipper's ClipResult satisfies it. */
export type EditorClip = {
  id: string;
  output: string;
  title: string;
  clip_duration?: string;
  artifact_id?: string;
  crop_keyframes?: Array<{ timeMs: number }>;
};

export type EditorWord = OverlayWord;

const ICON_STROKE = 1.7;

function wordLabel(item: EditorWord) {
  return String(item.word || item.text || "").trim();
}

function parseSeconds(value?: string) {
  return Number(String(value || "").replace(/[^0-9.]/g, "")) || 0;
}

/* ------------------------------------------------------------------ */
/* Timeline                                                            */
/* ------------------------------------------------------------------ */

type TimelineSnapshot = {
  sections: Array<{ id: string; start: number; end: number }>;
  keyframes: Array<{ id: string; time: number }>;
  zoomEffects: ZoomPinEffect[];
  sfxClips: ClipSfxClip[];
};

function EditorTimeline({
  clipId,
  videoSrc,
  duration,
  currentTime,
  playing,
  video,
  onSeek,
  onTogglePlay,
  words,
  cropKeyframes,
  onWordSelect,
  onZoomEffectsChange,
}: {
  clipId: string;
  videoSrc: string;
  duration: number;
  currentTime: number;
  playing: boolean;
  video: MutableRefObject<HTMLVideoElement | null>;
  onSeek: (time: number) => void;
  onTogglePlay: () => void;
  words: EditorWord[];
  cropKeyframes: Array<{ timeMs: number }>;
  onWordSelect?: (index: number) => void;
  onZoomEffectsChange?: (effects: ZoomPinEffect[]) => void;
}) {
  const [zoom, setZoom] = useState(1);
  const [snapping, setSnapping] = useState(true);
  const [sections, setSections] = useState(() => [{ id: "source", start: 0, end: duration }]);
  const [keyframes, setKeyframes] = useState(() => cropKeyframes.map((keyframe, index) => ({ id: `${keyframe.timeMs}-${index}`, time: keyframe.timeMs / 1000 })));
  const [zoomEffects, setZoomEffects] = useState<ZoomPinEffect[]>([]);
  const [sfxClips, setSfxClips] = useState<ClipSfxClip[]>([]);
  const [selectedItem, setSelectedItem] = useState<string>("source");
  const [history, setHistory] = useState<TimelineSnapshot[]>([]);
  const [future, setFuture] = useState<TimelineSnapshot[]>([]);
  const [thumbs, setThumbs] = useState<string[]>([]);
  const [peaks, setPeaks] = useState<number[]>([]);
  const [waveState, setWaveState] = useState<"loading" | "ready">("loading");
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const waveCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const sfxAudioRef = useRef<Map<string, HTMLAudioElement>>(new Map());
  const dragRef = useRef<
    | { kind: "playhead" }
    | { kind: "keyframe"; id: string }
    | { kind: "zoom-pin"; effectId: string; pin: "start" | "end" }
    | { kind: "sfx-move"; id: string; grabOffset: number }
    | null
  >(null);
  const thumbCacheRef = useRef<Map<string, string[]>>(new Map());
  const pendingZoomStartRef = useRef<number | null>(null);

  useEffect(() => {
    // Track real media duration once metadata loads, but keep user splits.
    setSections((current) => (current.length === 1 && current[0].id === "source"
      ? [{ id: "source", start: 0, end: duration }]
      : current));
  }, [duration]);
  useEffect(() => {
    // A different clip starts from its real crop-plan keyframes and a single
    // source section, then restores that clip's saved timeline edits.
    let sectionsNext: TimelineSnapshot["sections"] = [{ id: "source", start: 0, end: duration }];
    let keyframesNext: TimelineSnapshot["keyframes"] = cropKeyframes.map((keyframe, index) => ({ id: `${keyframe.timeMs}-${index}`, time: keyframe.timeMs / 1000 }));
    let zoomEffectsNext: ZoomPinEffect[] = [];
    let sfxClipsNext: ClipSfxClip[] = [];
    try {
      const saved = JSON.parse(localStorage.getItem(`clyra.timeline.${clipId}`) || "null");
      if (Array.isArray(saved?.sections) && saved.sections.length) sectionsNext = saved.sections;
      if (Array.isArray(saved?.keyframes) && saved.keyframes.length) keyframesNext = saved.keyframes;
      if (Array.isArray(saved?.zoomEffects)) zoomEffectsNext = saved.zoomEffects;
      if (Array.isArray(saved?.sfxClips)) sfxClipsNext = normalizeSfxClips(saved.sfxClips, duration);
    } catch { /* Ignore an older draft. */ }
    setSections(sectionsNext);
    setKeyframes(keyframesNext);
    setZoomEffects(zoomEffectsNext);
    setSfxClips(sfxClipsNext);
    setHistory([]);
    setFuture([]);
    setSelectedItem("source");
    pendingZoomStartRef.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clipId, cropKeyframes]);
  useEffect(() => {
    localStorage.setItem(`clyra.timeline.${clipId}`, JSON.stringify({ sections, keyframes, zoomEffects, sfxClips }));
  }, [clipId, sections, keyframes, zoomEffects, sfxClips]);
  useEffect(() => {
    onZoomEffectsChange?.(zoomEffects);
  }, [zoomEffects, onZoomEffectsChange]);

  const snapshot = useCallback(() => {
    setHistory((value) => [...value.slice(-24), { sections, keyframes, zoomEffects, sfxClips }]);
    setFuture([]);
  }, [sections, keyframes, zoomEffects, sfxClips]);

  const seek = useCallback((time: number) => {
    const next = Math.max(0, Math.min(duration, time));
    if (video.current) video.current.currentTime = next;
    onSeek(next);
  }, [duration, onSeek, video]);

  const timeAtClientX = useCallback((clientX: number) => {
    const scroller = scrollerRef.current;
    if (!scroller || duration <= 0) return 0;
    const rect = scroller.getBoundingClientRect();
    const contentWidth = Math.max(1, scroller.scrollWidth);
    const x = scroller.scrollLeft + clientX - rect.left;
    return Math.max(0, Math.min(duration, (x / contentWidth) * duration));
  }, [duration]);

  /* Filmstrip: lightweight canvas captures from an offscreen <video>, cached per source+count. */
  const thumbCount = Math.max(8, Math.min(20, Math.round((10 * zoom))));
  useEffect(() => {
    if (!videoSrc || duration <= 0) { setThumbs([]); return; }
    const cacheKey = `${videoSrc}::${thumbCount}`;
    const cached = thumbCacheRef.current.get(cacheKey);
    if (cached) { setThumbs(cached); return; }
    let cancelled = false;
    const sampler = document.createElement("video");
    sampler.src = videoSrc;
    sampler.muted = true;
    sampler.playsInline = true;
    sampler.preload = "auto";
    sampler.crossOrigin = "anonymous";
    const capture = async () => {
      try {
        await new Promise<void>((resolve, reject) => {
          sampler.onloadedmetadata = () => resolve();
          sampler.onerror = () => reject(new Error("thumbnail source failed"));
        });
        const canvas = document.createElement("canvas");
        canvas.width = 96;
        canvas.height = 170;
        const context = canvas.getContext("2d");
        if (!context) return;
        const next: string[] = [];
        for (let index = 0; index < thumbCount; index += 1) {
          if (cancelled) return;
          await new Promise<void>((resolve) => {
            sampler.onseeked = () => resolve();
            sampler.currentTime = Math.min(Math.max(0.05, ((index + 0.5) / thumbCount) * duration), Math.max(0.05, duration - 0.05));
          });
          const scale = Math.max(canvas.width / sampler.videoWidth, canvas.height / sampler.videoHeight);
          const drawWidth = sampler.videoWidth * scale;
          const drawHeight = sampler.videoHeight * scale;
          context.drawImage(sampler, (canvas.width - drawWidth) / 2, (canvas.height - drawHeight) / 2, drawWidth, drawHeight);
          next.push(canvas.toDataURL("image/jpeg", 0.66));
        }
        if (!cancelled) {
          thumbCacheRef.current.set(cacheKey, next);
          setThumbs(next);
        }
      } catch {
        if (!cancelled) setThumbs([]);
      }
    };
    void capture();
    return () => { cancelled = true; sampler.removeAttribute("src"); sampler.load(); };
  }, [videoSrc, duration, thumbCount]);

  /* Real waveform decoded with WebAudio; skeleton while loading.
     Silent / audio-less clips get a quiet flat line — never a loud error. */
  useEffect(() => {
    if (!videoSrc) { setWaveState("ready"); setPeaks(Array.from({ length: 240 }, () => 0.04)); return; }
    let cancelled = false;
    setWaveState("loading");
    setPeaks([]);
    const quietPeaks = () => Array.from({ length: 240 }, (_, index) => 0.03 + ((index % 17) === 0 ? 0.02 : 0));
    void fetch(videoSrc)
      .then((response) => {
        if (!response.ok) throw new Error(`waveform source ${response.status}`);
        return response.arrayBuffer();
      })
      .then(async (buffer) => {
        const AudioContextCtor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!AudioContextCtor) throw new Error("WebAudio unavailable");
        const context = new AudioContextCtor();
        try {
          const audio = await context.decodeAudioData(buffer.slice(0));
          if (!audio.numberOfChannels || audio.length < 32) {
            if (!cancelled) { setPeaks(quietPeaks()); setWaveState("ready"); }
            return;
          }
          const data = audio.getChannelData(0);
          const buckets = 240;
          const step = Math.max(1, Math.floor(data.length / buckets));
          let peakMax = 0;
          const next = Array.from({ length: buckets }, (_, index) => {
            let max = 0;
            for (let cursor = index * step; cursor < Math.min(data.length, (index + 1) * step); cursor += 1) {
              max = Math.max(max, Math.abs(data[cursor]));
            }
            peakMax = Math.max(peakMax, max);
            return max;
          });
          if (!cancelled) {
            // Near-silent sources still draw a restrained baseline so the track
            // never looks unfinished.
            setPeaks(peakMax < 0.002 ? quietPeaks() : next);
            setWaveState("ready");
          }
        } finally {
          await context.close().catch(() => undefined);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setPeaks(quietPeaks());
          setWaveState("ready");
        }
      });
    return () => { cancelled = true; };
  }, [videoSrc]);

  useEffect(() => {
    const canvas = waveCanvasRef.current;
    if (!canvas || waveState !== "ready" || !peaks.length) return;
    const parent = canvas.parentElement;
    const width = Math.max(1, parent?.clientWidth || canvas.clientWidth || 600);
    const height = 64;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.scale(ratio, ratio);
    context.clearRect(0, 0, width, height);
    context.strokeStyle = "rgba(22, 119, 255, 0.55)";
    context.lineWidth = 1.4;
    context.lineCap = "round";
    const mid = height / 2;
    const stride = width / peaks.length;
    context.beginPath();
    peaks.forEach((peak, index) => {
      const x = index * stride + stride / 2;
      const extent = Math.max(1.2, peak * (height / 2 - 5));
      context.moveTo(x, mid - extent);
      context.lineTo(x, mid + extent);
    });
    context.stroke();
  }, [peaks, waveState, zoom]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement)?.matches("input,textarea,select,[contenteditable]")) return;
      if (event.code === "Space") { event.preventDefault(); onTogglePlay(); }
      if (event.key === "ArrowLeft") seek(currentTime - (event.shiftKey ? 1 / 30 : 1));
      if (event.key === "ArrowRight") seek(currentTime + (event.shiftKey ? 1 / 30 : 1));
      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        if (zoomEffects.some((effect) => effect.id === selectedItem)) {
          snapshot();
          setZoomEffects((value) => value.filter((effect) => effect.id !== selectedItem));
          setSelectedItem("source");
          return;
        }
        if (sfxClips.some((clip) => clip.id === selectedItem)) {
          snapshot();
          setSfxClips((value) => value.filter((clip) => clip.id !== selectedItem));
          setSelectedItem("source");
          return;
        }
        if (selectedItem.startsWith("key")) {
          snapshot();
          setKeyframes((value) => value.filter((keyframe) => keyframe.id !== selectedItem));
        }
      }
      if (event.key.toLowerCase() === "s") setSnapping((value) => !value);
      if (event.key.toLowerCase() === "f") setZoom(1);
      if (event.key === "-") setZoom((value) => Math.max(1, value - 0.25));
      if (event.key === "+" || event.key === "=") setZoom((value) => Math.min(5, value + 0.25));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [currentTime, onTogglePlay, seek, selectedItem, snapshot, sfxClips, zoomEffects]);

  const split = () => {
    const target = sections.find((section) => currentTime > section.start + 0.15 && currentTime < section.end - 0.15);
    if (!target) return;
    snapshot();
    setSections((value) => value.flatMap((section) => section.id === target.id
      ? [{ ...section, id: `${section.id}-a`, end: currentTime }, { ...section, id: `${section.id}-b`, start: currentTime }]
      : section));
    setSelectedItem(`${target.id}-b`);
  };
  const removeSelected = () => {
    if (zoomEffects.some((effect) => effect.id === selectedItem)) {
      snapshot();
      setZoomEffects((value) => value.filter((effect) => effect.id !== selectedItem));
      setSelectedItem("source");
      return;
    }
    if (sfxClips.some((clip) => clip.id === selectedItem)) {
      snapshot();
      setSfxClips((value) => value.filter((clip) => clip.id !== selectedItem));
      setSelectedItem("source");
      return;
    }
    if (!selectedItem.startsWith("key")) return;
    snapshot();
    setKeyframes((value) => value.filter((keyframe) => keyframe.id !== selectedItem));
  };
  const undo = () => {
    const previous = history.at(-1);
    if (!previous) return;
    setFuture((value) => [...value, { sections, keyframes, zoomEffects, sfxClips }]);
    setSections(previous.sections);
    setKeyframes(previous.keyframes);
    setZoomEffects(previous.zoomEffects || []);
    setSfxClips(previous.sfxClips || []);
    setHistory((value) => value.slice(0, -1));
  };
  const redo = () => {
    const next = future.at(-1);
    if (!next) return;
    setHistory((value) => [...value, { sections, keyframes, zoomEffects, sfxClips }]);
    setSections(next.sections);
    setKeyframes(next.keyframes);
    setZoomEffects(next.zoomEffects || []);
    setSfxClips(next.sfxClips || []);
    setFuture((value) => value.slice(0, -1));
  };

  const placeSfxAt = useCallback((assetId: ClipSfxAssetId, atTime: number) => {
    snapshot();
    const clip = createSfxClip({ assetId, start: atTime });
    setSfxClips((value) => [...value, clip]);
    setSelectedItem(clip.id);
    seek(atTime);
  }, [seek, snapshot]);

  const addZoomAtPlayhead = (direction: "in" | "out") => {
    snapshot();
    const start = snapping ? Math.round(currentTime * 10) / 10 : currentTime;
    const end = snapping
      ? Math.round(suggestZoomEnd(start, duration) * 10) / 10
      : suggestZoomEnd(start, duration);
    const effect = normalizeZoomEffect(
      createZoomPinEffect({ start, end, direction }),
      duration,
    );
    setZoomEffects((value) => [...value, effect]);
    setSelectedItem(effect.id);
    seek(start);
  };

  const onTrackPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    dragRef.current = { kind: "playhead" };
    event.currentTarget.setPointerCapture(event.pointerId);
    seek(timeAtClientX(event.clientX));
  };
  const onTrackPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const raw = timeAtClientX(event.clientX);
    const time = snapping ? Math.round(raw * 10) / 10 : raw;
    if (drag.kind === "playhead") {
      seek(time);
      return;
    }
    if (drag.kind === "keyframe") {
      setKeyframes((value) => value.map((keyframe) => (keyframe.id === drag.id
        ? { ...keyframe, time }
        : keyframe)));
      return;
    }
    if (drag.kind === "zoom-pin") {
      setZoomEffects((value) => value.map((effect) => {
        if (effect.id !== drag.effectId) return effect;
        const next = drag.pin === "start"
          ? { ...effect, start: Math.min(time, effect.end - 0.05) }
          : { ...effect, end: Math.max(time, effect.start + 0.05) };
        return normalizeZoomEffect(next, duration);
      }));
      return;
    }
    if (drag.kind === "sfx-move") {
      const nextStart = Math.max(0, Math.min(duration, time - drag.grabOffset));
      setSfxClips((value) => value.map((clip) => (clip.id === drag.id
        ? { ...clip, start: snapping ? Math.round(nextStart * 10) / 10 : nextStart }
        : clip)));
    }
  };
  const onTrackPointerUp = () => { dragRef.current = null; };

  /* Keep HTMLAudioElements in sync with the main video for editor preview. */
  useEffect(() => {
    const pool = sfxAudioRef.current;
    const liveIds = new Set(sfxClips.map((clip) => clip.id));
    for (const [id, audio] of pool) {
      if (!liveIds.has(id)) {
        audio.pause();
        audio.src = "";
        pool.delete(id);
      }
    }
    for (const clip of sfxClips) {
      const asset = CLIP_SFX_ASSETS.find((item) => item.id === clip.assetId);
      if (!asset) continue;
      let audio = pool.get(clip.id);
      if (!audio) {
        audio = new Audio(asset.url);
        audio.preload = "auto";
        pool.set(clip.id, audio);
      } else if (!audio.src.includes(asset.file)) {
        audio.src = asset.url;
      }
      audio.playbackRate = clampSfxSpeed(clip.speed);
      audio.volume = Math.min(1, clampSfxVolume(clip.volume));
    }
  }, [sfxClips]);

  useEffect(() => {
    const media = video.current;
    if (!media) return;
    let raf = 0;
    const sync = () => {
      const t = media.currentTime || 0;
      const isPlaying = !media.paused && !media.ended;
      for (const clip of sfxClips) {
        const audio = sfxAudioRef.current.get(clip.id);
        if (!audio) continue;
        const active = isSfxActiveAt(clip, t);
        if (!active || !isPlaying) {
          if (!audio.paused) audio.pause();
          continue;
        }
        const sourceTime = sfxSourceTimeAt(clip, t);
        if (Math.abs(audio.currentTime - sourceTime) > 0.12) {
          try { audio.currentTime = sourceTime; } catch { /* ignore seek race */ }
        }
        audio.playbackRate = clampSfxSpeed(clip.speed);
        audio.volume = Math.min(1, clampSfxVolume(clip.volume));
        if (audio.paused) void audio.play().catch(() => undefined);
      }
      raf = requestAnimationFrame(sync);
    };
    const kick = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(sync); };
    const stopAll = () => {
      for (const audio of sfxAudioRef.current.values()) {
        if (!audio.paused) audio.pause();
      }
    };
    media.addEventListener("play", kick);
    media.addEventListener("pause", stopAll);
    media.addEventListener("seeked", kick);
    media.addEventListener("ended", stopAll);
    if (!media.paused) kick();
    return () => {
      cancelAnimationFrame(raf);
      media.removeEventListener("play", kick);
      media.removeEventListener("pause", stopAll);
      media.removeEventListener("seeked", kick);
      media.removeEventListener("ended", stopAll);
      stopAll();
    };
  }, [sfxClips, video, videoSrc]);

  useEffect(() => () => {
    for (const audio of sfxAudioRef.current.values()) {
      audio.pause();
      audio.src = "";
    }
    sfxAudioRef.current.clear();
  }, []);

  const transportButton = "grid h-8 w-8 place-items-center rounded-[8px] transition-colors duration-150 hover:bg-[#F4F7FB] disabled:opacity-30";
  const transportGroup = "flex items-center gap-[5px]";
  const rulerTickSeconds = duration > 90 ? 15 : duration > 40 ? 5 : duration > 16 ? 4 : 2;
  const rulerTicks = useMemo(() => {
    const ticks: number[] = [];
    for (let time = 0; time <= duration + 0.001; time += rulerTickSeconds) ticks.push(Math.min(time, duration));
    return ticks;
  }, [duration, rulerTickSeconds]);

  const playheadLeft = duration > 0 ? `${(currentTime / duration) * 100}%` : "0%";
  const trackHeights = { ruler: 40, video: 58, captions: 42, audio: 66, zoom: 72 } as const;
  const rowSeparator = { borderBottom: `1px solid ${CLIP_EDITOR.separator}` } as const;
  const selectedZoom = zoomEffects.find((effect) => effect.id === selectedItem);
  const selectedSfx = sfxClips.find((clip) => clip.id === selectedItem);

  return (
    <section
      aria-label="Video timeline"
      className="flex h-full min-h-0 w-full shrink-0 flex-col overflow-hidden bg-white"
      style={{ borderTop: `1px solid #E2E8F0` }}
    >
      {/* Control bar */}
      <div className="flex h-[60px] shrink-0 items-center pl-3 pr-[15px]" style={{ borderBottom: "1px solid #E8ECF2" }}>
        <div className={transportGroup} style={{ color: CLIP_EDITOR.textPrimary }}>
          <button type="button" onClick={() => seek(0)} className={transportButton} aria-label="Jump to beginning"><ChevronsLeft size={16} strokeWidth={ICON_STROKE} /></button>
          <button type="button" onClick={() => seek(currentTime - 1)} className={transportButton} aria-label="Previous second"><SkipBack size={15} strokeWidth={ICON_STROKE} /></button>
          <button type="button" onClick={onTogglePlay} className={transportButton} aria-label={playing ? "Pause" : "Play"}>
            {playing ? <Pause size={17} strokeWidth={ICON_STROKE} /> : <Play size={17} strokeWidth={ICON_STROKE} className="ml-0.5" />}
          </button>
          <button type="button" onClick={() => seek(currentTime + 1)} className={transportButton} aria-label="Next second"><SkipForward size={15} strokeWidth={ICON_STROKE} /></button>
          <button type="button" onClick={() => seek(duration)} className={transportButton} aria-label="Jump to end"><ChevronsRight size={16} strokeWidth={ICON_STROKE} /></button>
        </div>
        <span className="mx-3 h-5 w-px" style={{ background: CLIP_EDITOR.separator }} />
        <span className="tabular-nums text-[11.5px]" style={{ fontFamily: CLIP_EDITOR_MONO, color: CLIP_EDITOR.textPrimary }}>
          {formatEditorTime(currentTime)} / {formatEditorTime(duration)}
        </span>
        <span className="mx-3 h-5 w-px" style={{ background: CLIP_EDITOR.separator }} />
        <div className={transportGroup} style={{ color: CLIP_EDITOR.textPrimary }}>
          <button type="button" onClick={split} className={transportButton} aria-label="Split at playhead"><Scissors size={15} strokeWidth={ICON_STROKE} /></button>
          <button type="button" onClick={removeSelected} className={transportButton} aria-label="Delete selected item"><Trash2 size={15} strokeWidth={ICON_STROKE} /></button>
          <button
            type="button"
            onClick={() => setSnapping((value) => !value)}
            className={cn("grid h-8 w-8 place-items-center rounded-[8px] transition-colors duration-150", !snapping && "hover:bg-[#F4F7FB]")}
            style={snapping ? { background: CLIP_EDITOR.selected, color: CLIP_EDITOR.blue } : { color: CLIP_EDITOR.textPrimary }}
            aria-label="Toggle snapping"
            aria-pressed={snapping}
          >
            <Link2 size={15} strokeWidth={ICON_STROKE} />
          </button>
          <button type="button" disabled={!history.length} onClick={undo} className={transportButton} aria-label="Undo"><Undo2 size={15} strokeWidth={ICON_STROKE} /></button>
          <button type="button" disabled={!future.length} onClick={redo} className={transportButton} aria-label="Redo"><Redo2 size={15} strokeWidth={ICON_STROKE} /></button>
        </div>
        <span className="mx-3 h-5 w-px" style={{ background: CLIP_EDITOR.separator }} />
        <div className={transportGroup} style={{ color: CLIP_EDITOR.textPrimary }}>
          <button
            type="button"
            onClick={() => addZoomAtPlayhead("in")}
            className={transportButton}
            title="Drop zoom-in pins at playhead (drag ends to set speed)"
            aria-label="Add zoom-in effect"
          >
            <ZoomIn size={15} strokeWidth={ICON_STROKE} />
          </button>
          <button
            type="button"
            onClick={() => addZoomAtPlayhead("out")}
            className={transportButton}
            title="Drop zoom-out pins at playhead (drag ends to set speed)"
            aria-label="Add zoom-out effect"
          >
            <ZoomOut size={15} strokeWidth={ICON_STROKE} />
          </button>
        </div>
        <div className="ml-auto flex items-center gap-2" style={{ color: CLIP_EDITOR.textPrimary }}>
          <button type="button" onClick={() => setZoom((value) => Math.max(1, value - 0.25))} className={transportButton} aria-label="Zoom out"><Minus size={15} strokeWidth={ICON_STROKE} /></button>
          <input
            aria-label="Timeline zoom"
            type="range"
            min="1"
            max="5"
            step="0.25"
            value={zoom}
            onChange={(event) => setZoom(Number(event.target.value))}
            className="clipper-zoom-slider w-[92px]"
          />
          <button type="button" onClick={() => setZoom((value) => Math.min(5, value + 0.25))} className={transportButton} aria-label="Zoom in"><Plus size={15} strokeWidth={ICON_STROKE} /></button>
          <button
            type="button"
            onClick={() => setZoom(1)}
            className="h-[34px] w-[44px] rounded-[9px] bg-white text-[12px] font-medium transition-colors duration-150 hover:bg-[#F5F8FC]"
            style={{ border: `1px solid ${CLIP_EDITOR.border}`, color: CLIP_EDITOR.textPrimary }}
          >
            Fit
          </button>
        </div>
      </div>

      {/* Sound FX palette — drag onto the Audio track or click to drop at playhead */}
      <div
        className="flex shrink-0 items-center gap-2 overflow-x-auto px-3 py-2"
        style={{ borderBottom: `1px solid ${CLIP_EDITOR.separator}`, background: "#F8FAFD" }}
        aria-label="Sound effects"
      >
        <span className="shrink-0 text-[11px] font-semibold uppercase tracking-wide" style={{ color: CLIP_EDITOR.textMuted }}>
          Sound FX
        </span>
        {CLIP_SFX_ASSETS.map((asset) => {
          const colors = SFX_BLOCK_COLORS[asset.id];
          return (
            <button
              key={asset.id}
              type="button"
              draggable
              title={`${asset.label}: ${asset.hint}. Drag onto Audio or click to place at playhead.`}
              onDragStart={(event) => {
                event.dataTransfer.setData(SFX_DRAG_MIME, asset.id);
                event.dataTransfer.effectAllowed = "copy";
              }}
              onClick={() => placeSfxAt(asset.id, snapping ? Math.round(currentTime * 10) / 10 : currentTime)}
              className="flex h-[30px] shrink-0 items-center gap-1.5 rounded-[8px] px-2.5 text-[11px] font-semibold transition-colors duration-150 hover:brightness-[0.98]"
              style={{
                background: colors.fill,
                color: colors.text,
                boxShadow: `inset 0 0 0 1px ${colors.border}`,
              }}
            >
              <AudioLines size={13} strokeWidth={ICON_STROKE} />
              {asset.label}
            </button>
          );
        })}
        <span className="ml-1 shrink-0 text-[10.5px]" style={{ color: CLIP_EDITOR.textMuted }}>
          Drag onto Audio · customise speed below
        </span>
      </div>

      {/* Track labels + tracks */}
      <div className="grid min-h-0 flex-1 grid-cols-[120px_minmax(0,1fr)]">
        <div className="bg-white" style={{ borderRight: `1px solid ${CLIP_EDITOR.border}` }}>
          <div style={{ height: trackHeights.ruler, ...rowSeparator }} />
          {([
            ["Video", Video, trackHeights.video],
            ["Captions", Type, trackHeights.captions],
            ["Audio", AudioLines, trackHeights.audio],
            ["Zoom", ZoomIn, trackHeights.zoom],
          ] as const).map(([label, Icon, height]) => (
            <div key={label} className="flex items-center gap-[10px] px-3" style={{ height, ...rowSeparator, color: "#53637D" }}>
              <Icon size={15} strokeWidth={ICON_STROKE} />
              <span className="text-[12px]" style={{ fontWeight: 550 }}>{label}</span>
            </div>
          ))}
        </div>

        <div
          ref={scrollerRef}
          className="scrollbar-none relative overflow-x-auto overflow-y-hidden"
          onPointerDown={onTrackPointerDown}
          onPointerMove={onTrackPointerMove}
          onPointerUp={onTrackPointerUp}
        >
          <div className="relative min-w-full" style={{ width: `${zoom * 100}%` }}>
            {/* Ruler */}
            <div className="relative" style={{ height: trackHeights.ruler, ...rowSeparator }}>
              {rulerTicks.map((time) => (
                <span
                  key={time}
                  className="absolute top-[13px] -translate-x-1/2 text-[10.5px] tabular-nums"
                  style={{ left: `${duration > 0 ? (time / duration) * 100 : 0}%`, color: CLIP_EDITOR.textMuted, fontFamily: CLIP_EDITOR_MONO }}
                >
                  {`${Math.floor(time / 60)}:${String(Math.floor(time % 60)).padStart(2, "0")}`}
                </span>
              ))}
            </div>

            {/* Video filmstrip */}
            <div className="relative" style={{ height: trackHeights.video, ...rowSeparator }}>
              {sections.map((section) => (
                <button
                  key={section.id}
                  type="button"
                  onClick={(event) => { event.stopPropagation(); setSelectedItem(section.id); }}
                  onPointerDown={(event) => event.stopPropagation()}
                  className="absolute bottom-[3px] top-[3px] overflow-hidden rounded-[6px] text-left transition-[box-shadow] duration-150"
                  style={{
                    left: `${duration > 0 ? (section.start / duration) * 100 : 0}%`,
                    width: `${duration > 0 ? ((section.end - section.start) / duration) * 100 : 100}%`,
                    boxShadow: selectedItem === section.id ? `inset 0 0 0 1.5px #A9CBFF` : `inset 0 0 0 1px ${CLIP_EDITOR.separator}`,
                  }}
                >
                  {thumbs.length ? (
                    <span className="flex h-full w-full">
                      {thumbs.map((thumb, index) => (
                        <img key={index} src={thumb} alt="" draggable={false} className="h-full min-w-0 flex-1 select-none object-cover" style={{ marginLeft: index ? 1 : 0 }} />
                      ))}
                    </span>
                  ) : (
                    <span className="flex h-full w-full animate-pulse gap-px">
                      {Array.from({ length: 10 }, (_, index) => <span key={index} className="h-full min-w-0 flex-1" style={{ background: "#EBF0F6" }} />)}
                    </span>
                  )}
                </button>
              ))}
            </div>

            {/* Caption word chips from real word durations */}
            <div className="relative" style={{ height: trackHeights.captions, ...rowSeparator }}>
              {words.map((word, index) => {
                const label = wordLabel(word);
                if (!label || duration <= 0) return null;
                const left = (Math.max(0, word.start) / duration) * 100;
                const width = Math.max(0.6, ((Math.max(0.08, word.end - word.start)) / duration) * 100 - 0.18);
                return (
                  <button
                    key={`${index}-${word.start}`}
                    type="button"
                    title={label}
                    onClick={(event) => { event.stopPropagation(); onWordSelect?.(index); seek(word.start); }}
                    onPointerDown={(event) => event.stopPropagation()}
                    className="absolute top-1/2 h-[33px] -translate-y-1/2 truncate rounded-[6px] bg-white px-[5px] text-left text-[10px] font-medium transition-colors duration-150 hover:bg-[#F5F8FC]"
                    style={{ left: `${left}%`, width: `${width}%`, minWidth: 12, border: `1px solid ${CLIP_EDITOR.border}`, color: CLIP_EDITOR.textSecondary }}
                  >
                    {label}
                  </button>
                );
              })}
            </div>

            {/* Audio waveform + draggable sound FX clips */}
            <div
              className="relative flex items-center bg-white"
              style={{ height: trackHeights.audio, ...rowSeparator }}
              onDragOver={(event) => {
                if (event.dataTransfer.types.includes(SFX_DRAG_MIME)) {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "copy";
                }
              }}
              onDrop={(event) => {
                const assetId = event.dataTransfer.getData(SFX_DRAG_MIME) as ClipSfxAssetId;
                if (!CLIP_SFX_ASSETS.some((asset) => asset.id === assetId)) return;
                event.preventDefault();
                event.stopPropagation();
                const at = snapping ? Math.round(timeAtClientX(event.clientX) * 10) / 10 : timeAtClientX(event.clientX);
                placeSfxAt(assetId, at);
              }}
            >
              {waveState === "ready" ? (
                <canvas ref={waveCanvasRef} className="pointer-events-none block w-full" />
              ) : (
                <span className="flex h-full w-full animate-pulse items-center gap-[3px] px-2" aria-label="Loading waveform">
                  {Array.from({ length: 90 }, (_, index) => (
                    <span key={index} className="w-full rounded-full" style={{ height: `${8 + ((index * 37) % 26)}px`, background: "#E6EDF6" }} />
                  ))}
                </span>
              )}
              {sfxClips.map((clip) => {
                const asset = CLIP_SFX_ASSETS.find((item) => item.id === clip.assetId);
                if (!asset || duration <= 0) return null;
                const colors = SFX_BLOCK_COLORS[clip.assetId];
                const left = (clip.start / duration) * 100;
                const width = (sfxTimelineDuration(clip) / duration) * 100;
                const active = selectedItem === clip.id;
                return (
                  <button
                    key={clip.id}
                    type="button"
                    title={`${asset.label} · ${clip.speed.toFixed(2)}× · ${formatEditorTime(clip.start)}`}
                    onClick={(event) => { event.stopPropagation(); setSelectedItem(clip.id); seek(clip.start); }}
                    onPointerDown={(event) => {
                      event.stopPropagation();
                      snapshot();
                      setSelectedItem(clip.id);
                      const grab = Math.max(0, timeAtClientX(event.clientX) - clip.start);
                      dragRef.current = { kind: "sfx-move", id: clip.id, grabOffset: grab };
                      scrollerRef.current?.setPointerCapture(event.pointerId);
                    }}
                    className="absolute top-1/2 z-[5] flex h-[34px] -translate-y-1/2 items-center overflow-hidden rounded-[7px] px-2 text-left text-[10px] font-semibold"
                    style={{
                      left: `${left}%`,
                      width: `${Math.max(width, 1.2)}%`,
                      minWidth: 28,
                      background: colors.fill,
                      color: colors.text,
                      boxShadow: active ? `inset 0 0 0 1.5px ${colors.border}, 0 1px 4px rgba(15,23,42,0.12)` : `inset 0 0 0 1px ${colors.border}`,
                      cursor: "grab",
                    }}
                    aria-label={`${asset.label} sound effect at ${formatEditorTime(clip.start)}`}
                  >
                    <span className="truncate">{asset.label} · {clip.speed.toFixed(2)}×</span>
                  </button>
                );
              })}
              {!sfxClips.length ? (
                <span className="pointer-events-none absolute left-3 top-2 z-[1] text-[10.5px]" style={{ color: CLIP_EDITOR.textMuted }}>
                  Drag a Sound FX here
                </span>
              ) : null}
            </div>

            {/* Zoom pins: start → end band; drag pins to set duration/speed */}
            <div
              className="relative"
              style={{ height: trackHeights.zoom }}
              onDoubleClick={(event) => {
                event.stopPropagation();
                const time = snapping ? Math.round(timeAtClientX(event.clientX) * 10) / 10 : timeAtClientX(event.clientX);
                if (pendingZoomStartRef.current == null) {
                  pendingZoomStartRef.current = time;
                  return;
                }
                snapshot();
                const start = Math.min(pendingZoomStartRef.current, time);
                const end = Math.max(pendingZoomStartRef.current, time);
                pendingZoomStartRef.current = null;
                const effect = normalizeZoomEffect(
                  createZoomPinEffect({ start, end: Math.max(end, start + 0.05), direction: "in" }),
                  duration,
                );
                setZoomEffects((value) => [...value, effect]);
                setSelectedItem(effect.id);
              }}
            >
              <span className="pointer-events-none absolute left-0 right-0 top-1/2 -translate-y-1/2" style={{ height: 1.5, background: "#D8DEE8" }} />
              {zoomEffects.map((effect) => {
                const active = selectedItem === effect.id;
                const left = duration > 0 ? (effect.start / duration) * 100 : 0;
                const width = duration > 0 ? ((effect.end - effect.start) / duration) * 100 : 0;
                return (
                  <div key={effect.id} className="contents">
                    <button
                      type="button"
                      title={`${effect.direction === "in" ? "Zoom in" : "Zoom out"} · ${formatEditorTime(effect.end - effect.start)}`}
                      onClick={(event) => { event.stopPropagation(); setSelectedItem(effect.id); }}
                      onPointerDown={(event) => event.stopPropagation()}
                      className="absolute top-[18px] h-[22px] -translate-y-1/2 overflow-hidden rounded-[6px]"
                      style={{
                        left: `${left}%`,
                        width: `${Math.max(width, 0.4)}%`,
                        background: effect.direction === "in"
                          ? "linear-gradient(90deg, rgba(79,124,255,0.12), rgba(79,124,255,0.32))"
                          : "linear-gradient(90deg, rgba(16,185,129,0.32), rgba(16,185,129,0.12))",
                        boxShadow: active ? `inset 0 0 0 1.5px ${CLIP_EDITOR.blue}` : "inset 0 0 0 1px rgba(79,124,255,0.25)",
                      }}
                      aria-label={`Zoom ${effect.direction} from ${formatEditorTime(effect.start)} to ${formatEditorTime(effect.end)}`}
                    >
                      <span className="pointer-events-none absolute inset-x-1 top-1/2 -translate-y-1/2 truncate text-left text-[9px] font-semibold uppercase tracking-wide" style={{ color: CLIP_EDITOR.blue }}>
                        {effect.direction === "in" ? "In" : "Out"}
                      </span>
                    </button>
                    {(["start", "end"] as const).map((pin) => {
                      const pinTime = pin === "start" ? effect.start : effect.end;
                      const pinSelected = selectedItem === effect.id;
                      return (
                        <button
                          key={`${effect.id}-${pin}`}
                          type="button"
                          title={`${pin === "start" ? "Start" : "End"} pin · ${formatEditorTime(pinTime)}`}
                          onClick={(event) => { event.stopPropagation(); setSelectedItem(effect.id); seek(pinTime); }}
                          onPointerDown={(event) => {
                            event.stopPropagation();
                            snapshot();
                            setSelectedItem(effect.id);
                            dragRef.current = { kind: "zoom-pin", effectId: effect.id, pin };
                            scrollerRef.current?.setPointerCapture(event.pointerId);
                          }}
                          className="absolute top-1/2 z-10 flex h-7 w-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center"
                          style={{ left: `${duration > 0 ? (pinTime / duration) * 100 : 0}%`, cursor: "ew-resize" }}
                          aria-label={`Zoom ${pin} pin at ${formatEditorTime(pinTime)}`}
                        >
                          <span
                            className="grid h-[18px] w-[14px] place-items-center rounded-[4px] text-white shadow-sm"
                            style={{
                              background: pinSelected ? CLIP_EDITOR.blue : effect.direction === "in" ? "#4F7CFF" : "#10B981",
                              boxShadow: pinSelected ? "0 0 0 2px rgba(79,124,255,0.28)" : undefined,
                            }}
                          >
                            <MapPin size={10} strokeWidth={2.4} />
                          </span>
                        </button>
                      );
                    })}
                  </div>
                );
              })}
              {!zoomEffects.length ? (
                <span className="pointer-events-none absolute left-3 top-2 text-[10.5px]" style={{ color: CLIP_EDITOR.textMuted }}>
                  {pendingZoomStartRef.current != null
                    ? "Double-click again to drop the end pin"
                    : "Zoom In / Out, or double-click start then end pin"}
                </span>
              ) : null}
            </div>

            {/* Playhead: ruler through zoom track, above content */}
            <div className="pointer-events-none absolute bottom-0 top-0 z-30" style={{ left: playheadLeft }}>
              <span className="absolute bottom-0 top-[30px] w-[2px] -translate-x-1/2" style={{ background: CLIP_EDITOR.blue }} />
              <span
                className="absolute top-[21px] h-[10px] w-[10px] -translate-x-1/2 rounded-[3px]"
                style={{ background: CLIP_EDITOR.blue, clipPath: "polygon(0 0, 100% 0, 100% 55%, 50% 100%, 0 55%)" }}
              />
            </div>
          </div>
        </div>
      </div>
      {selectedZoom ? (
        <div
          className="flex h-9 shrink-0 items-center gap-3 px-3 text-[11px]"
          style={{ borderTop: `1px solid ${CLIP_EDITOR.separator}`, color: CLIP_EDITOR.textSecondary, background: "#F8FAFD" }}
        >
          <span className="font-semibold" style={{ color: CLIP_EDITOR.blue }}>
            Zoom {selectedZoom.direction}
          </span>
          <span className="tabular-nums" style={{ fontFamily: CLIP_EDITOR_MONO }}>
            {formatEditorTime(selectedZoom.start)} → {formatEditorTime(selectedZoom.end)}
          </span>
          <span>· speed from pin gap ({(selectedZoom.end - selectedZoom.start).toFixed(2)}s)</span>
          <label className="ml-auto flex items-center gap-2">
            <span>Intensity</span>
            <input
              type="range"
              min="1.2"
              max="2.4"
              step="0.05"
              value={selectedZoom.direction === "in" ? selectedZoom.toZoom : selectedZoom.fromZoom}
              onChange={(event) => {
                const intensity = Number(event.target.value);
                snapshot();
                setZoomEffects((value) => value.map((effect) => {
                  if (effect.id !== selectedZoom.id) return effect;
                  return effect.direction === "in"
                    ? { ...effect, fromZoom: 1, toZoom: intensity }
                    : { ...effect, fromZoom: intensity, toZoom: 1 };
                }));
              }}
              className="clipper-zoom-slider w-[100px]"
              aria-label="Zoom intensity"
            />
          </label>
        </div>
      ) : null}
      {selectedSfx ? (
        <div
          className="flex h-9 shrink-0 items-center gap-3 px-3 text-[11px]"
          style={{ borderTop: `1px solid ${CLIP_EDITOR.separator}`, color: CLIP_EDITOR.textSecondary, background: "#F8FAFD" }}
        >
          <span className="font-semibold" style={{ color: SFX_BLOCK_COLORS[selectedSfx.assetId].text }}>
            {CLIP_SFX_ASSETS.find((asset) => asset.id === selectedSfx.assetId)?.label || "SFX"}
          </span>
          <span className="tabular-nums" style={{ fontFamily: CLIP_EDITOR_MONO }}>
            {formatEditorTime(selectedSfx.start)} → {formatEditorTime(sfxEnd(selectedSfx))}
          </span>
          <label className="flex items-center gap-2">
            <span>Speed {selectedSfx.speed.toFixed(2)}×</span>
            <input
              type="range"
              min="0.5"
              max="2"
              step="0.05"
              value={selectedSfx.speed}
              onChange={(event) => {
                const speed = clampSfxSpeed(Number(event.target.value));
                snapshot();
                setSfxClips((value) => value.map((clip) => (clip.id === selectedSfx.id ? { ...clip, speed } : clip)));
              }}
              className="clipper-zoom-slider w-[110px]"
              aria-label="Sound effect speed"
            />
          </label>
          <label className="flex items-center gap-2">
            <span>Volume</span>
            <input
              type="range"
              min="0"
              max="1.5"
              step="0.05"
              value={selectedSfx.volume}
              onChange={(event) => {
                const volume = clampSfxVolume(Number(event.target.value));
                snapshot();
                setSfxClips((value) => value.map((clip) => (clip.id === selectedSfx.id ? { ...clip, volume } : clip)));
              }}
              className="clipper-zoom-slider w-[90px]"
              aria-label="Sound effect volume"
            />
          </label>
          <button
            type="button"
            onClick={() => {
              snapshot();
              setSfxClips((value) => value.filter((clip) => clip.id !== selectedSfx.id));
              setSelectedItem("source");
            }}
            className="ml-auto text-[11px] font-medium transition-opacity hover:opacity-80"
            style={{ color: CLIP_EDITOR.blue }}
          >
            Remove
          </button>
        </div>
      ) : null}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Word-timing inspector                                               */
/* ------------------------------------------------------------------ */

function WordTimingInspector({
  words,
  activeIndex,
  onSelect,
  onChangeWord,
  onRegenerate,
  regenerateBusy,
  canRegenerate,
  onSeekWord,
}: {
  words: EditorWord[];
  activeIndex: number;
  onSelect: (index: number) => void;
  onChangeWord: (index: number, text: string) => void;
  onRegenerate: () => void;
  regenerateBusy: boolean;
  canRegenerate: boolean;
  onSeekWord: (index: number) => void;
}) {
  const [allSelected, setAllSelected] = useState(false);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const activeWord = words[activeIndex];
  const totalSeconds = words.length ? Math.max(0, Math.max(...words.map((word) => word.end)) - Math.min(...words.map((word) => word.start))) : 0;
  const uppercaseTranscript = words.some((word) => /[A-Z]/.test(wordLabel(word))) && !words.some((word) => /[a-z]/.test(wordLabel(word)));

  const copyTimestamp = async () => {
    try { await navigator.clipboard?.writeText(formatEditorTime(activeWord?.start || 0)); } catch { /* Clipboard access is optional. */ }
  };

  return (
    <aside
      className="flex h-full min-h-0 flex-col bg-white"
      style={{ borderLeft: `1px solid ${CLIP_EDITOR.border}`, paddingLeft: 22, paddingRight: 22, paddingBottom: 22 }}
      aria-label="Word timing"
    >
      <div className="flex shrink-0 items-center gap-2" style={{ paddingTop: 34 }}>
        <Sparkles size={15} strokeWidth={ICON_STROKE} style={{ color: CLIP_EDITOR.textPrimary }} />
        <p className="text-[14px]" style={{ fontWeight: 650, color: CLIP_EDITOR.textPrimary }}>Word timing</p>
      </div>

      <button
        type="button"
        onClick={() => void copyTimestamp()}
        aria-label="Copy current timestamp"
        className="mt-[17px] flex h-[45px] w-full shrink-0 items-center rounded-[9px] px-4 transition-colors duration-150 hover:bg-[#F5F8FC]"
        style={{ background: "#FAFBFD" }}
      >
        <span className="flex-1 text-center text-[14px] tabular-nums" style={{ fontFamily: CLIP_EDITOR_MONO, color: CLIP_EDITOR.textPrimary }}>
          {formatEditorTime(activeWord?.start || 0)}
        </span>
        <Copy size={15} strokeWidth={ICON_STROKE} style={{ color: CLIP_EDITOR.textMuted }} />
      </button>

      <div className="mt-[15px] flex shrink-0 items-center justify-between">
        <p className="text-[12px]" style={{ color: "#65748C" }}>Edit each word and its timing.</p>
        <button type="button" onClick={() => setAllSelected((value) => !value)} className="text-[12px] font-medium transition-colors duration-150 hover:opacity-80" style={{ color: CLIP_EDITOR.blue }}>
          {allSelected ? "Clear" : "Select all"}
        </button>
      </div>

      <div className="scrollbar-none mt-[16px] min-h-0 flex-1 space-y-[3px] overflow-y-auto">
        {words.length ? words.map((word, index) => {
          const selected = activeIndex === index || allSelected;
          const editing = editingIndex === index;
          return (
            <div
              key={`${index}-${word.start}`}
              role="button"
              tabIndex={0}
              onClick={() => { setAllSelected(false); onSelect(index); onSeekWord(index); }}
              onDoubleClick={() => setEditingIndex(index)}
              onKeyDown={(event) => { if (event.key === "Enter") setEditingIndex(index); }}
              className="grid h-[37px] w-full cursor-pointer grid-cols-[96px_minmax(0,1fr)_58px] items-center rounded-[8px] bg-white px-2.5 text-left transition-colors duration-150"
              style={{
                border: `1px solid ${selected ? "#B7D2FF" : CLIP_EDITOR.border}`,
                background: selected ? CLIP_EDITOR.selected : "#FFFFFF",
              }}
              onMouseEnter={(event) => { if (!selected) (event.currentTarget as HTMLElement).style.background = "#F6F9FC"; }}
              onMouseLeave={(event) => { if (!selected) (event.currentTarget as HTMLElement).style.background = "#FFFFFF"; }}
            >
              <span className="tabular-nums text-[11px] font-medium" style={{ fontFamily: CLIP_EDITOR_MONO, color: CLIP_EDITOR.blue }}>
                {formatEditorTime(word.start)}
              </span>
              {editing ? (
                <input
                  autoFocus
                  defaultValue={wordLabel(word)}
                  onClick={(event) => event.stopPropagation()}
                  onBlur={(event) => { onChangeWord(index, event.target.value); setEditingIndex(null); }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") { onChangeWord(index, (event.target as HTMLInputElement).value); setEditingIndex(null); }
                    if (event.key === "Escape") setEditingIndex(null);
                  }}
                  className="h-[26px] w-full rounded-[6px] bg-white px-1.5 text-center text-[12px] outline-none"
                  style={{ border: `1px solid ${CLIP_EDITOR.blue}`, color: CLIP_EDITOR.textPrimary, fontWeight: 650 }}
                  aria-label={`Edit word ${wordLabel(word)}`}
                />
              ) : (
                <span className={cn("truncate text-center text-[12px]", uppercaseTranscript && "uppercase")} style={{ fontWeight: 650, color: CLIP_EDITOR.textPrimary }}>
                  {wordLabel(word) || "—"}
                </span>
              )}
              <span className="text-right text-[10.5px] tabular-nums" style={{ color: CLIP_EDITOR.textMuted }}>
                {Math.max(0, word.end - word.start).toFixed(2)}s
              </span>
            </div>
          );
        }) : (
          <p className="px-1 py-3 text-[12px]" style={{ color: CLIP_EDITOR.textMuted }}>Timed subtitle words will appear here once a clip is generated with captions.</p>
        )}
      </div>

      <div className="shrink-0" style={{ marginTop: 17 }}>
        <p className="text-[12px]" style={{ color: CLIP_EDITOR.textMuted }}>
          {words.length} word{words.length === 1 ? "" : "s"} · {formatEditorTime(totalSeconds)} total
        </p>
        <button
          type="button"
          onClick={onRegenerate}
          disabled={regenerateBusy || !canRegenerate}
          className="mt-[18px] flex h-[47px] w-full items-center justify-center gap-2 rounded-[10px] bg-white text-[13px] font-medium transition-colors duration-150 hover:bg-[#F5F8FC] disabled:opacity-40"
          style={{ border: "1px solid #E1E7F0", color: CLIP_EDITOR.blue, fontWeight: 550 }}
        >
          <Sparkles size={15} strokeWidth={ICON_STROKE} />
          {regenerateBusy ? "Regenerating…" : "Regenerate subtitles"}
        </button>
      </div>
    </aside>
  );
}

/* ------------------------------------------------------------------ */
/* Editor shell                                                        */
/* ------------------------------------------------------------------ */

export default function ClipperEditor({
  clips,
  selected,
  onSelectClip,
  onRenameClip,
  onNewClip,
  search,
  onSearch,
  qualityLabel,
  scoreFor,
  srcFor,
  words,
  onWordChange,
  activeWordIndex,
  onActiveWordIndex,
  captionStyle,
  captionsVisible,
  videoRef,
  currentTime,
  onTimeChange,
  onRegenerate,
  regenerateBusy,
  onExport,
  exportBusy,
  error,
  onDismissError,
  faceTrackingEnabled = false,
  onFaceTrackingChange,
}: {
  clips: EditorClip[];
  selected: EditorClip | undefined;
  onSelectClip: (id: string) => void;
  onRenameClip: (id: string, title: string) => void;
  onNewClip: () => void;
  search: string;
  onSearch: (value: string) => void;
  qualityLabel: string;
  scoreFor: (clip: EditorClip) => number;
  srcFor: (clip: EditorClip) => string;
  words: EditorWord[];
  onWordChange: (index: number, text: string) => void;
  activeWordIndex: number;
  onActiveWordIndex: (index: number) => void;
  captionStyle: CaptionStyle | null;
  captionsVisible: boolean;
  videoRef: MutableRefObject<HTMLVideoElement | null>;
  currentTime: number;
  onTimeChange: (seconds: number) => void;
  onRegenerate: () => void;
  regenerateBusy: boolean;
  onExport: () => void;
  exportBusy: boolean;
  error: string;
  onDismissError: () => void;
  /** Live MediaPipe face follow in the preview + render preference. */
  faceTrackingEnabled?: boolean;
  onFaceTrackingChange?: (enabled: boolean) => void;
}) {
  const [editingTitle, setEditingTitle] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [videoDuration, setVideoDuration] = useState(0);
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null);
  const [zoomEffects, setZoomEffects] = useState<ZoomPinEffect[]>([]);
  const backdropRef = useRef<HTMLVideoElement | null>(null);
  const rafRef = useRef(0);
  const zoomRafRef = useRef(0);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const zoomEffectsRef = useRef<ZoomPinEffect[]>([]);
  const faceTrack = useLiveFaceTrack(videoEl, faceTrackingEnabled && Boolean(selected));
  const faceTrackRef = useRef(faceTrack);
  faceTrackRef.current = faceTrack;
  zoomEffectsRef.current = zoomEffects;

  const onZoomEffectsChange = useCallback((effects: ZoomPinEffect[]) => {
    setZoomEffects(effects);
  }, []);

  useEffect(() => {
    // Cover the Clyra shell chrome while the desktop editor is open.
    window.dispatchEvent(new CustomEvent("clyra:workflow-tabs-hide"));
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const onPointer = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    window.addEventListener("mousedown", onPointer);
    return () => window.removeEventListener("mousedown", onPointer);
  }, [menuOpen]);

  const duration = videoDuration || parseSeconds(selected?.clip_duration) || 1;
  const videoSrc = selected ? srcFor(selected) : "";

  /* Butter-smooth pin zoom on the VIDEO only — subtitles stay siblings
     and never inherit the scale transform. */
  useEffect(() => {
    const apply = () => {
      const node = videoRef.current;
      if (!node) return;
      const time = node.currentTime || 0;
      const sample = evaluateZoomAtTime(zoomEffectsRef.current, time);
      const face = faceTrackingEnabled ? faceTrackRef.current : null;
      const baseZoom = face?.zoom ?? 1;
      const pinZoom = sample.zoom;
      const finalZoom = Math.min(2.8, Math.max(1, baseZoom * pinZoom));
      const originX = sample.effectId || sample.progress > 0 ? sample.originX : (face?.x ?? 50);
      const originY = sample.effectId || sample.progress > 0 ? sample.originY : (face?.y ?? 50);
      if (face) {
        node.style.objectFit = "cover";
        node.style.objectPosition = `${face.x}% ${face.y}%`;
      } else if (pinZoom !== 1 || sample.progress > 0) {
        node.style.objectFit = "cover";
        node.style.objectPosition = `${originX}% ${originY}%`;
      } else {
        node.style.objectFit = "contain";
        node.style.objectPosition = "50% 50%";
      }
      node.style.transformOrigin = `${originX}% ${originY}%`;
      node.style.transform = `scale(${finalZoom})`;
      node.style.willChange = "transform";
    };

    const tick = () => {
      apply();
      zoomRafRef.current = requestAnimationFrame(tick);
    };
    apply();
    zoomRafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(zoomRafRef.current);
  }, [faceTrackingEnabled, videoSrc, videoRef, zoomEffects]);

  /* Smooth playhead: read video time on animation frames while playing.
     Updates are throttled to ~30fps so state churn never lags playback. */
  useEffect(() => {
    if (!playing) return;
    let lastPushed = -1;
    const tick = () => {
      const node = videoRef.current;
      if (node && Math.abs(node.currentTime - lastPushed) >= 0.033) {
        lastPushed = node.currentTime;
        onTimeChange(node.currentTime);
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [playing, onTimeChange, videoRef]);

  /* Blurred side-fill stays frame-synced with the main preview. */
  useEffect(() => {
    const main = videoRef.current;
    const backdrop = backdropRef.current;
    if (!main || !backdrop) return;
    const sync = () => {
      if (Math.abs(backdrop.currentTime - main.currentTime) > 0.12) backdrop.currentTime = main.currentTime;
    };
    const onPlay = () => { sync(); void backdrop.play().catch(() => undefined); setPlaying(true); };
    const onPause = () => { backdrop.pause(); sync(); setPlaying(false); };
    const onSeeked = sync;
    main.addEventListener("play", onPlay);
    main.addEventListener("pause", onPause);
    main.addEventListener("seeked", onSeeked);
    main.addEventListener("ended", onPause);
    return () => {
      main.removeEventListener("play", onPlay);
      main.removeEventListener("pause", onPause);
      main.removeEventListener("seeked", onSeeked);
      main.removeEventListener("ended", onPause);
    };
  }, [videoSrc, videoRef]);

  const togglePlay = useCallback(() => {
    const node = videoRef.current;
    if (!node) return;
    if (node.paused) void node.play().catch(() => undefined);
    else node.pause();
  }, [videoRef]);

  const seekTo = useCallback((time: number) => {
    const node = videoRef.current;
    const next = Math.max(0, Math.min(duration, time));
    if (node) node.currentTime = next;
    onTimeChange(next);
  }, [duration, onTimeChange, videoRef]);

  const filteredClips = useMemo(() => {
    const query = search.trim().toLowerCase();
    return clips.filter((clip) => !query || clip.title.toLowerCase().includes(query));
  }, [clips, search]);

  const shell = (
    <div
      data-testid="clipper-results"
      className="fixed inset-0 z-[10000] flex flex-col overflow-hidden bg-white"
      style={{ fontFamily: CLIP_EDITOR_FONT, color: CLIP_EDITOR.textPrimary }}
    >
      <span aria-hidden className="h-[2px] w-full shrink-0" style={{ background: CLIP_EDITOR.blue }} />
      {error ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-amber-200 bg-amber-50 px-4 py-2 text-[12px] text-amber-800">
          <AlertCircle size={14} strokeWidth={ICON_STROKE} />
          <span className="min-w-0 flex-1 truncate">{error}</span>
          <button type="button" onClick={onDismissError} className="font-medium hover:text-amber-950">Dismiss</button>
        </div>
      ) : null}

      {/* Three full-height columns. Timeline lives ONLY in the centre column, flush to the bottom. */}
      <div className="grid min-h-0 flex-1 grid-cols-[286px_minmax(0,1fr)_377px] max-[1450px]:grid-cols-[248px_minmax(0,1fr)_340px]">
        <aside
          className="flex min-h-0 flex-col overflow-hidden"
          style={{ borderRight: `1px solid ${CLIP_EDITOR.border}`, paddingLeft: 24, paddingRight: 20, paddingTop: 29 }}
          aria-label="Clips"
        >
          <div className="flex shrink-0 items-center justify-between pr-1">
            <p className="text-[15px]" style={{ fontWeight: 700, color: CLIP_EDITOR.textPrimary }}>Clips</p>
            <button type="button" onClick={onNewClip} className="grid h-7 w-7 place-items-center rounded-[8px] transition-colors duration-150 hover:bg-[#F5F8FC]" aria-label="New clip">
              <Plus size={18} strokeWidth={ICON_STROKE} style={{ color: CLIP_EDITOR.textPrimary }} />
            </button>
          </div>
          <p className="mt-[6px] shrink-0 text-[12px]" style={{ color: CLIP_EDITOR.textMuted }}>
            {filteredClips.length} clip{filteredClips.length === 1 ? "" : "s"}
          </p>
          <label className="mt-5 flex h-[42px] w-full shrink-0 items-center gap-2 rounded-[10px] bg-white pl-[13px] pr-3" style={{ border: "1px solid #E1E7F0", maxWidth: 240 }}>
            <Search size={15} strokeWidth={ICON_STROKE} style={{ color: CLIP_EDITOR.textMuted }} />
            <input
              value={search}
              onChange={(event) => onSearch(event.target.value)}
              placeholder="Search clips"
              className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-[#8A96AA]"
              style={{ color: CLIP_EDITOR.textPrimary }}
            />
          </label>
          <div className="scrollbar-none mt-[18px] min-h-0 flex-1 space-y-2 overflow-y-auto pb-4">
            {filteredClips.map((clip) => {
              const active = selected?.id === clip.id;
              return (
                <button
                  key={clip.id}
                  type="button"
                  onClick={() => onSelectClip(clip.id)}
                  className="relative flex h-[90px] w-full items-center text-left transition-colors duration-150"
                  style={{
                    background: active ? CLIP_EDITOR.selected : "transparent",
                    maxWidth: 242,
                    borderRadius: 10,
                    paddingLeft: 14,
                    paddingRight: 12,
                    gap: 13,
                  }}
                  onMouseEnter={(event) => { if (!active) (event.currentTarget as HTMLElement).style.background = CLIP_EDITOR.hover; }}
                  onMouseLeave={(event) => { if (!active) (event.currentTarget as HTMLElement).style.background = "transparent"; }}
                >
                  {active ? <span className="absolute bottom-[10px] left-0 top-[10px] w-[3px] rounded-full" style={{ background: CLIP_EDITOR.blue }} /> : null}
                  <video muted preload="metadata" src={srcFor(clip)} className="h-[68px] w-[44px] shrink-0 rounded-[7px] bg-[#0B1220] object-cover" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px]" style={{ fontWeight: 650, color: CLIP_EDITOR.textPrimary }}>{clip.title}</span>
                    <span className="mt-1 block text-[12px]" style={{ color: CLIP_EDITOR.textMuted }}>
                      {clip.clip_duration || "Clip"} · {qualityLabel}
                    </span>
                    <span className="mt-1 flex items-center gap-1.5 text-[12px] font-medium" style={{ color: CLIP_EDITOR.blue }}>
                      <span className="h-[6px] w-[6px] rounded-full" style={{ background: CLIP_EDITOR.blue }} />
                      Ready
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </aside>

        <main className="flex min-h-0 min-w-0 flex-col overflow-hidden" style={{ borderRight: `1px solid ${CLIP_EDITOR.border}` }}>
          {selected ? (
            <>
              <header className="flex h-[90px] shrink-0 items-start justify-between" style={{ paddingLeft: 30, paddingRight: 25, paddingTop: 30 }}>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    {editingTitle ? (
                      <input
                        autoFocus
                        value={selected.title}
                        onChange={(event) => onRenameClip(selected.id, event.target.value)}
                        onBlur={() => setEditingTitle(false)}
                        onKeyDown={(event) => { if (event.key === "Enter") setEditingTitle(false); }}
                        className="h-7 w-[300px] max-w-[42vw] rounded-[8px] bg-white px-2 text-[15px] outline-none"
                        style={{ border: `1px solid ${CLIP_EDITOR.blue}`, fontWeight: 700, color: CLIP_EDITOR.textPrimary }}
                        aria-label="Clip title"
                      />
                    ) : (
                      <h1 className="truncate text-[15px]" style={{ fontWeight: 700, color: CLIP_EDITOR.textPrimary }}>{selected.title}</h1>
                    )}
                    <button type="button" onClick={() => setEditingTitle(true)} className="grid h-6 w-6 shrink-0 place-items-center rounded-[6px] transition-colors duration-150 hover:bg-[#F5F8FC]" aria-label="Rename clip">
                      <Pencil size={15} strokeWidth={ICON_STROKE} style={{ color: CLIP_EDITOR.textMuted }} />
                    </button>
                    <div className="relative" ref={menuRef}>
                      <button
                        type="button"
                        onClick={() => setMenuOpen((value) => !value)}
                        className="grid h-6 w-6 shrink-0 place-items-center rounded-[6px] transition-colors duration-150 hover:bg-[#F5F8FC]"
                        aria-label="Clip actions"
                        aria-expanded={menuOpen}
                      >
                        <MoreHorizontal size={15} strokeWidth={ICON_STROKE} style={{ color: CLIP_EDITOR.textMuted }} />
                      </button>
                      {menuOpen ? (
                        <div
                          className="absolute left-0 top-[calc(100%+6px)] z-20 min-w-[148px] overflow-hidden rounded-[10px] bg-white py-1"
                          style={{ border: `1px solid ${CLIP_EDITOR.border}`, boxShadow: "0 8px 24px rgba(20,35,60,0.10)" }}
                        >
                          <button
                            type="button"
                            disabled={exportBusy}
                            onClick={() => { setMenuOpen(false); onExport(); }}
                            className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12.5px] transition-colors duration-150 hover:bg-[#F5F8FC] disabled:opacity-40"
                            style={{ color: CLIP_EDITOR.textPrimary }}
                          >
                            <Download size={14} strokeWidth={ICON_STROKE} />
                            {exportBusy ? "Exporting…" : "Export clip"}
                          </button>
                        </div>
                      ) : null}
                    </div>
                  </div>
                  <p className="mt-[7px] text-[12px]" style={{ color: "#65748C" }}>
                    {selected.clip_duration || `${Math.round(duration)}s`} · {qualityLabel}
                    {faceTrackingEnabled ? " · Face tracking" : " · Auto-reframed"}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2.5">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={faceTrackingEnabled}
                    aria-label="Face tracking"
                    onClick={() => onFaceTrackingChange?.(!faceTrackingEnabled)}
                    className="flex h-[34px] items-center gap-2 rounded-[9px] px-2.5 text-[12px] font-medium transition-colors duration-150"
                    style={{
                      border: `1px solid ${faceTrackingEnabled ? CLIP_EDITOR.blue : "#E7EDF5"}`,
                      background: faceTrackingEnabled ? CLIP_EDITOR.selected : "#fff",
                      color: faceTrackingEnabled ? CLIP_EDITOR.blue : CLIP_EDITOR.textSecondary,
                    }}
                    title="Centre the frame on the face and follow smoothly with MediaPipe (no lag)"
                  >
                    <ScanFace size={15} strokeWidth={ICON_STROKE} />
                    Face tracking
                    <span
                      className="relative ml-0.5 h-[16px] w-[28px] rounded-full transition-colors duration-150"
                      style={{ background: faceTrackingEnabled ? CLIP_EDITOR.blue : "#D5DCE8" }}
                    >
                      <span
                        className="absolute top-[2px] h-[12px] w-[12px] rounded-full bg-white transition-[left] duration-150"
                        style={{ left: faceTrackingEnabled ? 14 : 2 }}
                      />
                    </span>
                  </button>
                  <div
                    className="flex h-[38px] w-[74px] shrink-0 items-center justify-center rounded-[10px] bg-white"
                    style={{ border: "1px solid #E7EDF5" }}
                    aria-label={`Clip score ${scoreFor(selected)} out of 100`}
                  >
                    <span className="text-[15px] tabular-nums" style={{ fontWeight: 700, color: CLIP_EDITOR.blue }}>{scoreFor(selected)}</span>
                    <span className="ml-1 text-[12px]" style={{ color: "#7FAFFF" }}>/100</span>
                  </div>
                </div>
              </header>

              <div className="flex min-h-0 flex-1 items-center justify-center px-6 pb-4">
                <div
                  data-testid="clipper-preview"
                  className="relative w-full max-w-[812px] overflow-hidden rounded-[12px]"
                  style={{ height: "min(440px, 100%)", maxHeight: 440, aspectRatio: "16 / 9", boxShadow: "0 5px 16px rgba(20,35,60,0.10)", background: "#040A18" }}
                  onClick={togglePlay}
                >
                  <video
                    key={`${videoSrc}-backdrop`}
                    ref={backdropRef}
                    muted
                    playsInline
                    preload="metadata"
                    src={videoSrc}
                    aria-hidden
                    className="absolute inset-0 h-full w-full object-cover"
                    style={{ filter: "blur(28px) brightness(0.28) saturate(0.75)", transform: "scale(1.08)" }}
                  />
                  <span aria-hidden className="absolute inset-0" style={{ background: "rgba(3,10,29,0.44)" }} />
                  <div className="absolute inset-0 z-[1] flex items-center justify-center">
                    <div className="relative h-full max-h-full overflow-hidden" style={{ aspectRatio: "9 / 16", maxWidth: "100%" }}>
                      <video
                        key={videoSrc}
                        ref={(node) => {
                          videoRef.current = node;
                          setVideoEl(node);
                        }}
                        playsInline
                        preload="metadata"
                        crossOrigin="anonymous"
                        src={videoSrc}
                        onLoadedMetadata={(event) => setVideoDuration(event.currentTarget.duration || 0)}
                        onTimeUpdate={(event) => { if (!playing) onTimeChange(event.currentTarget.currentTime); }}
                        className="absolute inset-0 h-full w-full will-change-transform"
                        style={{ objectFit: "contain" }}
                      />
                      {captionsVisible ? (
                        <SubtitleOverlay
                          words={words}
                          style={captionStyle}
                          currentTime={currentTime}
                          activeWordIndex={activeWordIndex}
                          onWordClick={(index) => onActiveWordIndex(index)}
                        />
                      ) : null}
                      {faceTrackingEnabled ? (
                        <span className="pointer-events-none absolute left-2 top-2 z-[3] flex items-center gap-1 rounded-md bg-black/55 px-1.5 py-0.5 text-[10px] font-medium text-white">
                          <ScanFace size={11} strokeWidth={2} />
                          {faceTrack ? "Tracking" : "Finding face…"}
                        </span>
                      ) : null}
                    </div>
                  </div>
                  {!playing ? (
                    <span className="pointer-events-none absolute inset-0 z-[2] grid place-items-center">
                      <span className="grid h-12 w-12 place-items-center rounded-full bg-white/92" style={{ color: CLIP_EDITOR.textPrimary }}>
                        <Play size={18} strokeWidth={ICON_STROKE} className="ml-0.5" />
                      </span>
                    </span>
                  ) : null}
                </div>
              </div>

              <div className="h-[350px] w-full shrink-0">
                <EditorTimeline
                  clipId={selected.id}
                  videoSrc={videoSrc}
                  duration={duration}
                  currentTime={currentTime}
                  playing={playing}
                  video={videoRef}
                  onSeek={seekTo}
                  onTogglePlay={togglePlay}
                  words={words}
                  cropKeyframes={selected.crop_keyframes || []}
                  onWordSelect={onActiveWordIndex}
                  onZoomEffectsChange={onZoomEffectsChange}
                />
              </div>
            </>
          ) : (
            <div className="grid flex-1 place-items-center text-center">
              <div>
                <Video size={22} strokeWidth={ICON_STROKE} className="mx-auto" style={{ color: CLIP_EDITOR.textMuted }} />
                <p className="mt-3 text-[13px]" style={{ color: CLIP_EDITOR.textSecondary }}>Select a clip to edit</p>
              </div>
            </div>
          )}
        </main>

        <WordTimingInspector
          words={words}
          activeIndex={activeWordIndex}
          onSelect={onActiveWordIndex}
          onChangeWord={onWordChange}
          onRegenerate={onRegenerate}
          regenerateBusy={regenerateBusy}
          canRegenerate={Boolean(selected?.artifact_id) || words.length > 0}
          onSeekWord={(index) => {
            const word = words[index];
            if (word && videoRef.current) videoRef.current.currentTime = Math.max(0, word.start);
            if (word) onTimeChange(Math.max(0, word.start));
          }}
        />
      </div>
    </div>
  );

  return createPortal(shell, document.body);
}
