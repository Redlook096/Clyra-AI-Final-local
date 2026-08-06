import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { CLIP_EDITOR } from "./tokens";

export type OverlayWord = { word?: string; text?: string; start: number; end: number };

/**
 * Style contract mirrored from the pipeline's ASS burn-in (`write_subtitles`).
 * The pipeline emits this as `caption_style` on every clip result so the
 * live overlay and the exported pixels look identical.
 */
export type CaptionStyle = {
  font?: string;
  font_size?: number;
  text_colour?: string;
  position?: string;
  caption_x?: number | null;
  caption_y?: number | null;
  subtitle_style?: string;
  active_colour?: string;
  canvas_width?: number;
  canvas_height?: number;
};

const DEFAULT_STYLE: Required<CaptionStyle> = {
  font: "Impact",
  font_size: 74,
  text_colour: "#FFFFFF",
  position: "bottom",
  caption_x: 50,
  caption_y: 78,
  subtitle_style: "phrase-highlight",
  active_colour: "#FFD54A",
  canvas_width: 1080,
  canvas_height: 1920,
};

function overlayWordText(item: OverlayWord) {
  return String(item.word || item.text || "").trim();
}

/** Mirror of the pipeline's `normalise_caption_words` end-capping. */
function normaliseWords(words: OverlayWord[]) {
  const ordered = words
    .map((item, index) => ({ index, text: overlayWordText(item), start: Number(item.start) || 0, end: Math.max(Number(item.start) || 0, Number(item.end) || 0) }))
    .filter((item) => item.text.length > 0)
    .sort((left, right) => left.start - right.start);
  return ordered.map((item, position) => {
    const next = ordered[position + 1];
    const cappedEnd = Math.min(
      Math.max(item.start + 0.05, item.end),
      next ? Math.max(item.start + 0.05, next.start) : Number.POSITIVE_INFINITY,
      item.start + 1.2,
    );
    return { ...item, end: cappedEnd };
  });
}

/** Mirror of `subtitle_override`: named safe zones + percentage offsets on the output canvas. */
function anchorFor(style: Required<CaptionStyle>) {
  const anchors: Record<string, { align: "top" | "middle" | "bottom"; y: number }> = {
    top: { align: "top", y: 220 },
    "top-centre": { align: "top", y: 220 },
    center: { align: "middle", y: 640 },
    centre: { align: "middle", y: 640 },
    bottom: { align: "bottom", y: 1050 },
    "bottom-centre": { align: "bottom", y: 1050 },
  };
  const base = anchors[style.position] || anchors.bottom;
  const xRatio = style.caption_x === null || style.caption_x === undefined
    ? 0.5
    : Math.max(0.12, Math.min(0.88, Number(style.caption_x) / 100));
  const yRatio = style.caption_y === null || style.caption_y === undefined
    ? base.y / Math.max(1, style.canvas_height)
    : Math.max(0.08, Math.min(0.92, Number(style.caption_y) / 100));
  return { align: base.align, xRatio, yRatio };
}

/**
 * Detached subtitle overlay rendered on top of the clean preview video.
 *
 * Reproduces the FFmpeg/ASS burn-in exactly (font, bold, outline+shadow,
 * anchor position, word/karaoke timing) from live word-timing JSON, so
 * caption edits are visible instantly with no re-encode. Only an explicit
 * export burns these words into pixels.
 */
export default function SubtitleOverlay({
  words,
  style,
  currentTime,
  activeWordIndex,
  onWordClick,
}: {
  words: OverlayWord[];
  style?: CaptionStyle | null;
  currentTime: number;
  /** Word currently selected in the inspector (subtle ring). */
  activeWordIndex?: number;
  onWordClick?: (wordIndex: number) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const measure = () => {
      const rect = node.getBoundingClientRect();
      setBox({ width: rect.width, height: rect.height });
    };
    measure();
    const observer = new ResizeObserver(() => measure());
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const resolved = useMemo<Required<CaptionStyle>>(() => ({ ...DEFAULT_STYLE, ...(style || {}) } as Required<CaptionStyle>), [style]);
  const timed = useMemo(() => normaliseWords(words), [words]);

  const phraseMode = /phrase/.test(String(resolved.subtitle_style || "").toLowerCase());

  const display = useMemo(() => {
    if (!timed.length) return null;
    if (!phraseMode) {
      // Word-at-a-time: mirror `subtitle_beats` (>=0.05s, <=0.72s, capped at next start).
      for (let index = timed.length - 1; index >= 0; index -= 1) {
        const word = timed[index];
        if (currentTime < word.start) continue;
        const next = timed[index + 1];
        const hardEnd = Math.min(word.start + 0.72, next ? next.start : Number.POSITIVE_INFINITY);
        const end = Math.min(Math.max(word.end, word.start + 0.05), Math.max(word.start + 0.05, hardEnd));
        if (currentTime < end) return { tokens: [{ ...word, active: true }] };
        return null;
      }
      return null;
    }
    // Phrase-highlight: groups of four; the phrase stays visible while only
    // the active word advances (neutral during pauses) — mirror of
    // `phrase_highlight_beats`.
    for (let groupStart = 0; groupStart < timed.length; groupStart += 4) {
      const group = timed.slice(groupStart, groupStart + 4);
      if (!group.length) continue;
      const phraseStart = group[0].start;
      const nextGroupFirst = timed[groupStart + 4];
      const phraseEnd = nextGroupFirst ? nextGroupFirst.start : Number.POSITIVE_INFINITY;
      if (currentTime < phraseStart || currentTime >= phraseEnd) continue;
      return {
        tokens: group.map((word, indexInGroup) => {
          const next = timed[groupStart + indexInGroup + 1];
          const activeEnd = Math.min(Math.max(word.end, word.start + 0.01), next ? Math.max(word.start + 0.01, next.start) : Number.POSITIVE_INFINITY);
          return { ...word, active: currentTime >= word.start && currentTime < activeEnd };
        }),
      };
    }
    return null;
  }, [timed, currentTime, phraseMode]);

  const { align, xRatio, yRatio } = anchorFor(resolved);
  // Prefer the measured overlay box; fall back to a portrait estimate so the
  // first paint never flashes empty while ResizeObserver catches up.
  const height = box.height > 0 ? box.height : 440;
  const scale = height / Math.max(1, resolved.canvas_height);
  const fontSize = Math.max(14, resolved.font_size * scale);
  const outline = Math.max(1.5, 6 * scale);
  const shadow = Math.max(0.5, 1 * scale);
  const translateY = align === "bottom" ? "-100%" : align === "middle" ? "-50%" : "0%";
  const outlineShadow = [
    `-${outline}px -${outline}px 0 #000`,
    `${outline}px -${outline}px 0 #000`,
    `-${outline}px ${outline}px 0 #000`,
    `${outline}px ${outline}px 0 #000`,
    `0 -${outline}px 0 #000`,
    `0 ${outline}px 0 #000`,
    `-${outline}px 0 0 #000`,
    `${outline}px 0 0 #000`,
    `${shadow}px ${shadow + outline}px ${shadow}px rgba(0,0,0,0.5)`,
  ].join(", ");

  return (
    <div ref={containerRef} className="pointer-events-none absolute inset-0 overflow-hidden" data-testid="subtitle-overlay">
      {display && display.tokens.length ? (
        <p
          className="absolute m-0 whitespace-pre-wrap text-center font-bold uppercase leading-[1.12]"
          style={{
            left: `${xRatio * 100}%`,
            top: `${yRatio * 100}%`,
            transform: `translate(-50%, ${translateY})`,
            width: "88%",
            maxWidth: "100%",
            fontFamily: `"${resolved.font}", Impact, "Arial Black", sans-serif`,
            fontSize: `${fontSize}px`,
            color: resolved.text_colour,
            textShadow: outlineShadow,
            zIndex: 5,
          }}
        >
          {display.tokens.map((token, position) => (
            <span key={`${token.index}-${token.start}`}>
              {position > 0 ? " " : ""}
              <span
                role={onWordClick ? "button" : undefined}
                onClick={onWordClick ? (event) => { event.stopPropagation(); onWordClick(token.index); } : undefined}
                className={onWordClick ? "pointer-events-auto cursor-pointer rounded-[3px] transition-[background-color] duration-150 hover:bg-white/10" : undefined}
                style={{
                  color: token.active && phraseMode ? resolved.active_colour : resolved.text_colour,
                  boxShadow: activeWordIndex === token.index ? `0 0 0 ${Math.max(1, 1.5 * scale * 4)}px ${CLIP_EDITOR.blue}66` : undefined,
                }}
              >
                {token.text}
              </span>
            </span>
          ))}
        </p>
      ) : null}
    </div>
  );
}
