/**
 * Shared motion language for the Clyra agent transcript.
 *
 * One controlled easing everywhere: actions slot into the development log
 * from the left, layout reflow glides instead of snapping, and expanding
 * bodies use measured height so text never stretches.
 */

export const AGENT_EASE = [0.22, 1, 0.36, 1] as const;

/** Reflow of surrounding rows when an action expands or collapses. */
export const LAYOUT_TRANSITION = {
  layout: { duration: 0.28, ease: AGENT_EASE },
} as const;

/** Every agent action gently slots into the transcript from the left. */
export const ROW_ENTER = {
  initial: { opacity: 0, x: -5 },
  animate: { opacity: 1, x: 0 },
  transition: {
    opacity: { duration: 0.16, ease: AGENT_EASE },
    x: { duration: 0.2, ease: AGENT_EASE },
  },
} as const;

/** Soft vertical fade for results and assistant prose. */
export const SUBTLE_ENTER = {
  initial: { opacity: 0, y: 3 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.18, ease: AGENT_EASE },
} as const;

/** Measured height open/close for diff bodies and details. */
export const HEIGHT_OPEN = {
  initial: { height: 0, opacity: 0 },
  animate: { height: "auto", opacity: 1 },
  exit: { height: 0, opacity: 0 },
  transition: {
    height: { duration: 0.3, ease: AGENT_EASE },
    opacity: { duration: 0.18, delay: 0.05 },
  },
} as const;

/** Crossfade for labels morphing in place (Running → Ran, Editing → Edited). */
export const LABEL_MORPH = {
  initial: { opacity: 0, y: 2 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -2 },
  transition: { duration: 0.16, ease: AGENT_EASE },
} as const;
