import {
  AlertCircle,
  AudioLines,
  ChevronsLeft,
  ChevronsRight,
  Copy,
  Crop,
  Download,
  Link2,
  Minus,
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
  Video,
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
import { cn } from "../../lib/utils";
import SubtitleOverlay, { type CaptionStyle, type OverlayWord } from "./SubtitleOverlay";
import { CLIP_EDITOR, CLIP_EDITOR_FONT, CLIP_EDITOR_MONO, formatEditorTime } from "./tokens";

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
}) {
  const [zoom, setZoom] = useState(1);
  const [snapping, setSnapping] = useState(true);
  const [sections, setSections] = useState(() => [{ id: "source", start: 0, end: duration }]);
  const [keyframes, setKeyframes] = useState(() => cropKeyframes.map((keyframe, index) => ({ id: `${keyframe.timeMs}-${index}`, time: keyframe.timeMs / 1000 })));
  const [selectedItem, setSelectedItem] = useState<string>("source");
  const [history, setHistory] = useState<TimelineSnapshot[]>([]);
  const [future, setFuture] = useState<TimelineSnapshot[]>([]);
  const [thumbs, setThumbs] = useState<string[]>([]);
  const [peaks, setPeaks] = useState<number[]>([]);
  const [waveState, setWaveState] = useState<"loading" | "ready" | "error">("loading");
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const waveCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const dragRef = useRef<{ kind: "playhead" } | { kind: "keyframe"; id: string } | null>(null);
  const thumbCacheRef = useRef<Map<string, string[]>>(new Map());

  useEffect(() => {
    setSections([{ id: "source", start: 0, end: duration }]);
  }, [clipId, duration]);
  useEffect(() => {
    setKeyframes(cropKeyframes.map((keyframe, index) => ({ id: `${keyframe.timeMs}-${index}`, time: keyframe.timeMs / 1000 })));
    // Keyframe positions come from real crop-plan data for this clip.
  }, [clipId, cropKeyframes]);
  useEffect(() => {
    const saved = localStorage.getItem(`clyra.timeline.${clipId}`);
    if (!saved) return;
    try {
      const value = JSON.parse(saved);
      if (Array.isArray(value.sections) && value.sections.length) setSections(value.sections);
      if (Array.isArray(value.keyframes) && value.keyframes.length) setKeyframes(value.keyframes);
    } catch { /* Ignore an older draft. */ }
  }, [clipId]);
  useEffect(() => {
    localStorage.setItem(`clyra.timeline.${clipId}`, JSON.stringify({ sections, keyframes }));
  }, [clipId, sections, keyframes]);

  const snapshot = useCallback(() => {
    setHistory((value) => [...value.slice(-24), { sections, keyframes }]);
    setFuture([]);
  }, [sections, keyframes]);

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

  /* Real waveform decoded with WebAudio; skeleton while loading, quiet error only on failure. */
  useEffect(() => {
    if (!videoSrc) { setWaveState("error"); setPeaks([]); return; }
    let cancelled = false;
    setWaveState("loading");
    setPeaks([]);
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
          const audio = await context.decodeAudioData(buffer);
          const data = audio.getChannelData(0);
          const buckets = 240;
          const step = Math.max(1, Math.floor(data.length / buckets));
          const next = Array.from({ length: buckets }, (_, index) => {
            let max = 0;
            for (let cursor = index * step; cursor < Math.min(data.length, (index + 1) * step); cursor += 1) {
              max = Math.max(max, Math.abs(data[cursor]));
            }
            return max;
          });
          if (!cancelled) { setPeaks(next); setWaveState("ready"); }
        } finally {
          await context.close().catch(() => undefined);
        }
      })
      .catch(() => { if (!cancelled) { setPeaks([]); setWaveState("error"); } });
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
      if (event.key.toLowerCase() === "s") setSnapping((value) => !value);
      if (event.key.toLowerCase() === "f") setZoom(1);
      if (event.key === "-") setZoom((value) => Math.max(1, value - 0.25));
      if (event.key === "+" || event.key === "=") setZoom((value) => Math.min(5, value + 0.25));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [currentTime, onTogglePlay, seek]);

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
    if (!selectedItem.startsWith("key")) return;
    snapshot();
    setKeyframes((value) => value.filter((keyframe) => keyframe.id !== selectedItem));
  };
  const undo = () => {
    const previous = history.at(-1);
    if (!previous) return;
    setFuture((value) => [...value, { sections, keyframes }]);
    setSections(previous.sections);
    setKeyframes(previous.keyframes);
    setHistory((value) => value.slice(0, -1));
  };
  const redo = () => {
    const next = future.at(-1);
    if (!next) return;
    setHistory((value) => [...value, { sections, keyframes }]);
    setSections(next.sections);
    setKeyframes(next.keyframes);
    setFuture((value) => value.slice(0, -1));
  };

  const onTrackPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    dragRef.current = { kind: "playhead" };
    event.currentTarget.setPointerCapture(event.pointerId);
    seek(timeAtClientX(event.clientX));
  };
  const onTrackPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const time = timeAtClientX(event.clientX);
    if (drag.kind === "playhead") {
      seek(time);
      return;
    }
    setKeyframes((value) => value.map((keyframe) => (keyframe.id === drag.id
      ? { ...keyframe, time: snapping ? Math.round(time * 10) / 10 : time }
      : keyframe)));
  };
  const onTrackPointerUp = () => { dragRef.current = null; };

  const transportButton = "grid h-8 w-8 place-items-center rounded-[8px] transition-colors duration-150 hover:bg-[#F4F7FB] disabled:opacity-30";
  const rulerTickSeconds = duration > 90 ? 15 : duration > 40 ? 5 : duration > 16 ? 4 : 2;
  const rulerTicks = useMemo(() => {
    const ticks: number[] = [];
    for (let time = 0; time <= duration + 0.001; time += rulerTickSeconds) ticks.push(Math.min(time, duration));
    return ticks;
  }, [duration, rulerTickSeconds]);

  const playheadLeft = duration > 0 ? `${(currentTime / duration) * 100}%` : "0%";
  const trackHeights = { ruler: 30, video: 56, captions: 42, audio: 64, crop: 70 } as const;
  const rowSeparator = { borderBottom: `1px solid ${CLIP_EDITOR.separator}` } as const;

  return (
    <section
      aria-label="Video timeline"
      className="flex shrink-0 flex-col overflow-hidden rounded-[13px] bg-white"
      style={{ border: `1px solid #E2E8F0`, boxShadow: "0 3px 12px rgba(20,35,60,0.05)", height: 350 }}
    >
      {/* Control bar */}
      <div className="flex h-[60px] shrink-0 items-center pl-3 pr-[15px]" style={{ borderBottom: "1px solid #E8ECF2" }}>
        <div className="flex items-center gap-[6px]" style={{ color: CLIP_EDITOR.textPrimary }}>
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
        <div className="flex items-center gap-[6px]" style={{ color: CLIP_EDITOR.textPrimary }}>
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

      {/* Track labels + tracks */}
      <div className="grid min-h-0 flex-1 grid-cols-[120px_minmax(0,1fr)]">
        <div className="bg-white" style={{ borderRight: `1px solid ${CLIP_EDITOR.border}` }}>
          <div style={{ height: trackHeights.ruler, ...rowSeparator }} />
          {([
            ["Video", Video, trackHeights.video],
            ["Captions", Type, trackHeights.captions],
            ["Audio", AudioLines, trackHeights.audio],
            ["Crop", Crop, trackHeights.crop],
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
                  className="absolute top-[9px] -translate-x-1/2 text-[10.5px] tabular-nums"
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

            {/* Audio waveform */}
            <div className="relative flex items-center bg-white" style={{ height: trackHeights.audio, ...rowSeparator }}>
              {waveState === "ready" ? (
                <canvas ref={waveCanvasRef} className="pointer-events-none block w-full" />
              ) : waveState === "loading" ? (
                <span className="flex h-full w-full animate-pulse items-center gap-[3px] px-2" aria-label="Loading waveform">
                  {Array.from({ length: 90 }, (_, index) => (
                    <span key={index} className="w-full rounded-full" style={{ height: `${8 + ((index * 37) % 26)}px`, background: "#E6EDF6" }} />
                  ))}
                </span>
              ) : (
                <span className="px-3 text-[10.5px]" style={{ color: CLIP_EDITOR.textMuted }}>Audio could not be decoded for this clip</span>
              )}
            </div>

            {/* Crop keyframes: thin neutral line + blue diamonds */}
            <div
              className="relative"
              style={{ height: trackHeights.crop }}
              onDoubleClick={(event) => { snapshot(); const time = timeAtClientX(event.clientX); setKeyframes((value) => [...value, { id: `key-${Date.now()}`, time }]); }}
            >
              <span className="pointer-events-none absolute left-0 right-0 top-1/2 -translate-y-1/2" style={{ height: 1.5, background: "#D8DEE8" }} />
              {keyframes.map((keyframe) => {
                const active = selectedItem === keyframe.id;
                return (
                  <button
                    key={keyframe.id}
                    type="button"
                    title={formatEditorTime(keyframe.time)}
                    onClick={(event) => { event.stopPropagation(); setSelectedItem(keyframe.id); seek(keyframe.time); }}
                    onPointerDown={(event) => {
                      event.stopPropagation();
                      snapshot();
                      setSelectedItem(keyframe.id);
                      dragRef.current = { kind: "keyframe", id: keyframe.id };
                      scrollerRef.current?.setPointerCapture(event.pointerId);
                    }}
                    className="absolute top-1/2 h-[10px] w-[10px] -translate-x-1/2 -translate-y-1/2 rotate-45 rounded-[2px] transition-colors duration-150"
                    style={{
                      left: `${duration > 0 ? (keyframe.time / duration) * 100 : 0}%`,
                      background: active ? "#D7E7FF" : "#F0F6FF",
                      border: `1.5px solid ${active ? "#0E62E6" : CLIP_EDITOR.blue}`,
                      cursor: "ew-resize",
                    }}
                    aria-label={`Crop keyframe at ${formatEditorTime(keyframe.time)}`}
                  />
                );
              })}
              {!keyframes.length ? (
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-[calc(50%+14px)] text-[10.5px]" style={{ color: CLIP_EDITOR.textMuted }}>
                  Double-click to add a crop keyframe
                </span>
              ) : null}
            </div>

            {/* Playhead: ruler through crop track, above content */}
            <div className="pointer-events-none absolute bottom-0 top-0 z-30" style={{ left: playheadLeft }}>
              <span className="absolute bottom-0 top-[22px] w-[2px] -translate-x-1/2" style={{ background: CLIP_EDITOR.blue }} />
              <span
                className="absolute top-[13px] h-[10px] w-[10px] -translate-x-1/2 rounded-[3px]"
                style={{ background: CLIP_EDITOR.blue, clipPath: "polygon(0 0, 100% 0, 100% 55%, 50% 100%, 0 55%)" }}
              />
            </div>
          </div>
        </div>
      </div>
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
  onExport,
  exportBusy,
  onSeekWord,
}: {
  words: EditorWord[];
  activeIndex: number;
  onSelect: (index: number) => void;
  onChangeWord: (index: number, text: string) => void;
  onRegenerate: () => void;
  regenerateBusy: boolean;
  canRegenerate: boolean;
  onExport: () => void;
  exportBusy: boolean;
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
      style={{ borderLeft: `1px solid ${CLIP_EDITOR.border}`, padding: 22 }}
      aria-label="Word timing"
    >
      <div className="flex shrink-0 items-center gap-2 pt-[10px]">
        <Sparkles size={15} strokeWidth={ICON_STROKE} style={{ color: CLIP_EDITOR.textPrimary }} />
        <p className="text-[14px]" style={{ fontWeight: 650, color: CLIP_EDITOR.textPrimary }}>Word timing</p>
      </div>

      <button
        type="button"
        onClick={() => void copyTimestamp()}
        aria-label="Copy current timestamp"
        className="mt-4 flex h-[44px] w-full shrink-0 items-center rounded-[9px] px-4 transition-colors duration-150 hover:bg-[#F5F8FC]"
        style={{ background: "#FAFBFD" }}
      >
        <span className="flex-1 text-center text-[14px] tabular-nums" style={{ fontFamily: CLIP_EDITOR_MONO, color: CLIP_EDITOR.textPrimary }}>
          {formatEditorTime(activeWord?.start || 0)}
        </span>
        <Copy size={15} strokeWidth={ICON_STROKE} style={{ color: CLIP_EDITOR.textMuted }} />
      </button>

      <div className="mt-3 flex shrink-0 items-center justify-between">
        <p className="text-[12px]" style={{ color: "#65748C" }}>Edit each word and its timing.</p>
        <button type="button" onClick={() => setAllSelected((value) => !value)} className="text-[12px] font-medium transition-colors duration-150 hover:opacity-80" style={{ color: CLIP_EDITOR.blue }}>
          {allSelected ? "Clear" : "Select all"}
        </button>
      </div>

      <div className="scrollbar-none mt-3 min-h-0 flex-1 space-y-[3px] overflow-y-auto">
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
                border: `1px solid ${selected ? CLIP_EDITOR.blue : CLIP_EDITOR.border}`,
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
          className="mt-3 flex h-[47px] w-full items-center justify-center gap-2 rounded-[10px] bg-white text-[13px] font-medium transition-colors duration-150 hover:bg-[#F5F8FC] disabled:opacity-40"
          style={{ border: "1px solid #E1E7F0", color: CLIP_EDITOR.blue }}
        >
          <Sparkles size={15} strokeWidth={ICON_STROKE} />
          {regenerateBusy ? "Regenerating…" : "Regenerate subtitles"}
        </button>
        <button
          type="button"
          onClick={onExport}
          disabled={exportBusy}
          className="mt-2 flex h-[44px] w-full items-center justify-center gap-2 rounded-[10px] text-[13px] font-semibold text-white transition-colors duration-150 hover:opacity-95 disabled:opacity-40"
          style={{ background: CLIP_EDITOR.blue }}
        >
          <Download size={15} strokeWidth={ICON_STROKE} />
          {exportBusy ? "Exporting…" : "Export clip"}
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
}) {
  const [editingTitle, setEditingTitle] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [videoDuration, setVideoDuration] = useState(0);
  const backdropRef = useRef<HTMLVideoElement | null>(null);
  const rafRef = useRef(0);

  const duration = videoDuration || parseSeconds(selected?.clip_duration) || 1;
  const videoSrc = selected ? srcFor(selected) : "";

  /* Smooth playhead: read video time each animation frame while playing. */
  useEffect(() => {
    if (!playing) return;
    const tick = () => {
      const node = videoRef.current;
      if (node) onTimeChange(node.currentTime);
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

  return (
    <div
      data-testid="clipper-results"
      className="fixed inset-0 z-[10000] flex flex-col overflow-hidden bg-white"
      style={{ fontFamily: CLIP_EDITOR_FONT, color: CLIP_EDITOR.textPrimary }}
    >
      {/* Thin active-page indicator at the very top edge. */}
      <span aria-hidden className="h-[2px] w-full shrink-0" style={{ background: CLIP_EDITOR.blue }} />
      {error ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-amber-200 bg-amber-50 px-4 py-2 text-[12px] text-amber-800">
          <AlertCircle size={14} strokeWidth={ICON_STROKE} />
          <span className="min-w-0 flex-1 truncate">{error}</span>
          <button type="button" onClick={onDismissError} className="font-medium hover:text-amber-950">Dismiss</button>
        </div>
      ) : null}

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_377px] max-[1450px]:grid-cols-[minmax(0,1fr)_340px]">
        {/* Left region: sidebar + centre stage on top, shared timeline strip below. */}
        <div className="flex min-h-0 min-w-0 flex-col">
          <div className="grid min-h-0 flex-1 grid-cols-[286px_minmax(0,1fr)] max-[1450px]:grid-cols-[248px_minmax(0,1fr)]">
            {/* Clips sidebar */}
            <aside className="flex min-h-0 flex-col overflow-hidden pl-[22px] pr-[18px] pt-[18px]" style={{ borderRight: `1px solid ${CLIP_EDITOR.border}` }} aria-label="Clips">
              <div className="flex shrink-0 items-center justify-between">
                <p className="text-[15px]" style={{ fontWeight: 700, color: CLIP_EDITOR.textPrimary }}>Clips</p>
                <button type="button" onClick={onNewClip} className="grid h-7 w-7 place-items-center rounded-[8px] transition-colors duration-150 hover:bg-[#F5F8FC]" aria-label="New clip">
                  <Plus size={18} strokeWidth={ICON_STROKE} style={{ color: CLIP_EDITOR.textPrimary }} />
                </button>
              </div>
              <p className="mt-0.5 shrink-0 text-[12px]" style={{ color: CLIP_EDITOR.textMuted }}>
                {filteredClips.length} clip{filteredClips.length === 1 ? "" : "s"}
              </p>
              <label className="mt-3 flex h-[42px] w-full shrink-0 items-center gap-2 rounded-[10px] bg-white px-3" style={{ border: "1px solid #E1E7F0", maxWidth: 240 }}>
                <Search size={15} strokeWidth={ICON_STROKE} style={{ color: CLIP_EDITOR.textMuted }} />
                <input
                  value={search}
                  onChange={(event) => onSearch(event.target.value)}
                  placeholder="Search clips"
                  className="min-w-0 flex-1 bg-transparent text-[12.5px] outline-none"
                  style={{ color: CLIP_EDITOR.textPrimary }}
                />
              </label>
              <div className="scrollbar-none mt-3 min-h-0 flex-1 space-y-2 overflow-y-auto pb-4">
                {filteredClips.map((clip) => {
                  const active = selected?.id === clip.id;
                  return (
                    <button
                      key={clip.id}
                      type="button"
                      onClick={() => onSelectClip(clip.id)}
                      className="relative flex h-[90px] w-full items-center gap-3 rounded-[10px] px-3 text-left transition-colors duration-150"
                      style={{ background: active ? CLIP_EDITOR.selected : "transparent", maxWidth: 242 }}
                      onMouseEnter={(event) => { if (!active) (event.currentTarget as HTMLElement).style.background = CLIP_EDITOR.hover; }}
                      onMouseLeave={(event) => { if (!active) (event.currentTarget as HTMLElement).style.background = "transparent"; }}
                    >
                      {active ? <span className="absolute bottom-[12px] left-0 top-[12px] w-[3px] rounded-full" style={{ background: CLIP_EDITOR.blue }} /> : null}
                      <video muted preload="metadata" src={srcFor(clip)} className="h-[68px] w-[44px] shrink-0 rounded-[7px] bg-slate-900 object-cover" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px]" style={{ fontWeight: 600, color: CLIP_EDITOR.textPrimary }}>{clip.title}</span>
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

            {/* Centre stage */}
            <main className="flex min-h-0 min-w-0 flex-col overflow-hidden">
              {selected ? (
                <>
                  <header className="flex h-[88px] shrink-0 items-start justify-between px-7 pt-[20px]">
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
                      </div>
                      <p className="mt-1 text-[12px]" style={{ color: "#65748C" }}>
                        {selected.clip_duration || `${Math.round(duration)}s`} · {qualityLabel} · Auto-reframed
                      </p>
                    </div>
                    <div
                      className="flex h-[38px] shrink-0 items-center justify-center rounded-[10px] bg-white px-3"
                      style={{ border: "1px solid #E7EDF5", minWidth: 74 }}
                      aria-label={`Clip score ${scoreFor(selected)} out of 100`}
                    >
                      <span className="text-[15px] tabular-nums" style={{ fontWeight: 700, color: CLIP_EDITOR.blue }}>{scoreFor(selected)}</span>
                      <span className="ml-1 text-[12px]" style={{ color: "#7FAFFF" }}>/100</span>
                    </div>
                  </header>

                  {/* Preview stage with blurred duplicated side-fill */}
                  <div className="flex min-h-0 flex-1 items-center justify-center px-7 pb-[28px]">
                    <div
                      data-testid="clipper-preview"
                      className="relative h-full max-h-[440px] w-full max-w-[812px] overflow-hidden rounded-[12px]"
                      style={{ boxShadow: "0 5px 16px rgba(20,35,60,0.10)", background: "#040A18" }}
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
                      <div className="relative flex h-full items-center justify-center">
                        <div className="relative h-full">
                          <video
                            key={videoSrc}
                            ref={videoRef}
                            playsInline
                            preload="metadata"
                            src={videoSrc}
                            onLoadedMetadata={(event) => setVideoDuration(event.currentTarget.duration || 0)}
                            onTimeUpdate={(event) => { if (!playing) onTimeChange(event.currentTarget.currentTime); }}
                            className="mx-auto h-full w-auto object-contain"
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
                        </div>
                      </div>
                      {!playing ? (
                        <span className="pointer-events-none absolute inset-0 grid place-items-center">
                          <span className="grid h-12 w-12 place-items-center rounded-full bg-white/92" style={{ color: CLIP_EDITOR.textPrimary }}>
                            <Play size={18} strokeWidth={ICON_STROKE} className="ml-0.5" />
                          </span>
                        </span>
                      ) : null}
                    </div>
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
          </div>

          {/* Shared lower editor region: the timeline extends left beneath the clips sidebar. */}
          {selected ? (
            <div className="shrink-0 pb-[32px] pl-[22px] pr-[22px]">
              <div className="ml-auto w-full max-w-[996px]">
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
                />
              </div>
            </div>
          ) : null}
        </div>

        {/* Right word-timing inspector */}
        <WordTimingInspector
          words={words}
          activeIndex={activeWordIndex}
          onSelect={onActiveWordIndex}
          onChangeWord={onWordChange}
          onRegenerate={onRegenerate}
          regenerateBusy={regenerateBusy}
          canRegenerate={Boolean(selected?.artifact_id) || words.length > 0}
          onExport={onExport}
          exportBusy={exportBusy}
          onSeekWord={(index) => {
            const word = words[index];
            if (word && videoRef.current) videoRef.current.currentTime = Math.max(0, word.start);
            if (word) onTimeChange(Math.max(0, word.start));
          }}
        />
      </div>
    </div>
  );
}
