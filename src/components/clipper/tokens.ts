/**
 * Shared design tokens for the AI Clipper desktop editor.
 *
 * Every editor surface (clips sidebar, centre stage, timeline, word-timing
 * inspector) reads from this single palette so the layout stays cohesive.
 * No gradients, no glassmorphism — flat white surfaces with 1px hairlines.
 */
export const CLIP_EDITOR = {
  /** Base page background. */
  bg: "#FFFFFF",
  /** Secondary panel background (fields, quiet wells). */
  panel: "#FBFCFE",
  /** Primary text — dark navy. */
  textPrimary: "#17213A",
  /** Secondary text. */
  textSecondary: "#697790",
  /** Muted/metadata text. */
  textMuted: "#8A96AA",
  /** Standard 1px border. */
  border: "#E3E8F0",
  /** Extra-light separator for row dividers. */
  separator: "#EDF0F5",
  /** Primary action blue. */
  blue: "#1677FF",
  /** Selected surface — pale blue. */
  selected: "#EAF2FF",
  /** Hover surface. */
  hover: "#F5F8FC",
  /** Karaoke active-word highlight used by the FFmpeg burn-in. */
  karaoke: "#FFD54A",
} as const;

/** Inter-first UI stack; monospace is reserved for timecodes. */
export const CLIP_EDITOR_FONT =
  'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

export const CLIP_EDITOR_MONO =
  'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';

/** mm:ss.mmm — the monospace timecode used across the timeline + inspector. */
export function formatEditorTime(seconds: number) {
  const safe = Math.max(0, seconds || 0);
  const mins = Math.floor(safe / 60);
  const secs = Math.floor(safe % 60);
  const millis = Math.floor((safe % 1) * 1000);
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}
