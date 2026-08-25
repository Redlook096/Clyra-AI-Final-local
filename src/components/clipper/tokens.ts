/**
 * Shared design tokens for the AI Clipper desktop editor.
 *
 * Every editor surface (clips sidebar, centre stage, timeline, word-timing
 * inspector) reads from this single palette so the layout stays cohesive.
 * No gradients, no glassmorphism — flat white surfaces with 1px hairlines.
 */
export const CLIP_EDITOR = {
  /** Base page background — matches the app's slate-50 shell. */
  bg: "#F8FAFC",
  /** Secondary panel background (fields, quiet wells). */
  panel: "#F6F8FC",
  /** Primary text — near-black, matches text-slate-950 elsewhere in the app. */
  textPrimary: "#111318",
  /** Secondary text. */
  textSecondary: "#68707C",
  /** Muted/metadata text. */
  textMuted: "#8A909A",
  /** Standard 1px border. */
  border: "#E2E5EA",
  /** Extra-light separator for row dividers. */
  separator: "#ECEEF2",
  /** Primary action blue — the same accent used across Clyra's other workspaces. */
  blue: "#4169F6",
  /** Selected surface — pale blue. */
  selected: "#EDF2FF",
  /** Hover surface. */
  hover: "#F3F4F6",
  /** Karaoke active-word highlight used by the FFmpeg burn-in (unrelated to app chrome). */
  karaoke: "#FFD54A",
} as const;

/** Native desktop typography — matches the app's global body font stack. */
export const CLIP_EDITOR_FONT =
  '-apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", sans-serif';

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
