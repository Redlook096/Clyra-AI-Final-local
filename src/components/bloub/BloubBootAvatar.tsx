import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Bloub, type BloubHandle, type BloubState } from "./Bloub";

export type BloubBootPhase = "holding" | "ripple" | "complete";

interface BloubBootAvatarProps {
  /** Boot preload progress, 0–1. Eyes stay hidden until this reaches 1. */
  progress: number;
  /** Mirrors the app's boot-overlay phase (kept for the caller's own visual
   *  choreography; the avatar's own wake/blink/wink/fly sequence below runs
   *  entirely on its own clock once `progress` reaches 1). */
  phase: BloubBootPhase;
  color: string;
  /** CSS selector for the on-page slot to fly into once the overlay lifts. */
  targetSelector: string;
  size?: number;
  /** Fires the instant the fly-into-position animation finishes (or, if no
   *  target was found, once the in-place fade-out finishes). */
  onArrive?: () => void;
}

type Travel = { dx: number; dy: number; scale: number };

// Every step is timed relative to the step before it: eyes stay hidden
// until loading finishes, then open -> a quick wink (short beat, not a long
// pause) -> immediately smooth fly-and-shrink into the header slot, staying
// fully visible the entire time (no fade/hide mid-flight — the clone and
// the landed avatar are pixel-identical at the exact moment they swap, so
// there is nothing to crossfade). Nothing here is tied to the parent's
// ripple/complete timing — the caller is only told "arrived" once this is
// genuinely done.
const WINK_AFTER_EYES_MS = 260;
const IDLE_AFTER_WINK_MS = 130;
const FLY_AFTER_IDLE_MS = 170;

/**
 * The boot-splash avatar: bare round body while the app loads (no eyes),
 * then — once loading completes — opens its eyes, winks once, and flies
 * from its oversized boot position into the real chat-home avatar slot,
 * shrinking down to size as it travels rather than teleporting or snapping,
 * remaining fully visible throughout (never fading out mid-flight).
 *
 * Rendered as a single persistent instance across the "holding" -> "ripple"
 * phases (same React position/key in the tree) so the in-flight FLIP
 * transform is never interrupted by a remount.
 */
export function BloubBootAvatar({
  progress,
  color,
  targetSelector,
  size = 140,
  onArrive,
}: BloubBootAvatarProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const bloubRef = useRef<BloubHandle | null>(null);
  const [travel, setTravel] = useState<Travel | null>(null);
  const [poseState, setPoseState] = useState<BloubState>("idle");
  const [arrived, setArrived] = useState(false);
  const arrivedRef = useRef(false);
  const sequenceStartedRef = useRef(false);
  const awake = progress >= 1;

  const startTravel = () => {
    const node = wrapRef.current;
    const target = document.querySelector(targetSelector) as HTMLElement | null;
    const origin = node?.getBoundingClientRect();

    if (!node || !origin || !target) {
      // Nowhere to fly to (e.g. booted straight into an existing
      // conversation): nothing to travel toward — just report arrival.
      arrivedRef.current = true;
      setArrived(true);
      onArrive?.();
      return;
    }

    const targetRect = target.getBoundingClientRect();
    const dx = targetRect.left + targetRect.width / 2 - (origin.left + origin.width / 2);
    const dy = targetRect.top + targetRect.height / 2 - (origin.top + origin.height / 2);
    const scale = targetRect.width > 0 ? targetRect.width / origin.width : 1;
    setTravel({ dx, dy, scale });
  };

  // The whole performance, run exactly once on the rising edge of `awake`.
  useEffect(() => {
    if (!awake || sequenceStartedRef.current) return;
    sequenceStartedRef.current = true;

    // Fixed, upright, dead-centre gaze the instant the eyes open — matches
    // the landed header avatar, never the state's default off-axis rest
    // look. No wander during the performance — it holds perfectly still
    // apart from the wink until it lands.
    bloubRef.current?.setGaze(0, 0, 0, 0);

    const timers: number[] = [];
    const after = (ms: number, fn: () => void) => {
      timers.push(window.setTimeout(fn, ms));
    };

    // Reveal (~0.26s) happens automatically as soon as `eyesVisible` goes
    // true. Shortly after, a quick wink, then straight into the flight.
    after(WINK_AFTER_EYES_MS, () => {
      setPoseState("wink");
      after(IDLE_AFTER_WINK_MS, () => {
        setPoseState("idle");
        // Give the un-wink blend a moment to settle before launching the
        // flight so the two motions read as one smooth handoff instead of
        // overlapping.
        after(FLY_AFTER_IDLE_MS, startTravel);
      });
    });

    return () => {
      timers.forEach((id) => window.clearTimeout(id));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [awake]);

  return (
    <motion.div
      ref={wrapRef}
      className="clyra-boot-avatar"
      style={{ width: size, height: size, opacity: arrived ? 0 : 1, transition: "opacity 80ms linear" }}
      initial={false}
      animate={travel ? { x: travel.dx, y: travel.dy, scale: travel.scale } : { x: 0, y: 0, scale: 1 }}
      transition={
        travel
          ? { duration: 0.68, ease: [0.16, 1, 0.3, 1] }
          : { duration: 0 }
      }
      onAnimationComplete={() => {
        if (!travel || arrivedRef.current) return;
        arrivedRef.current = true;
        setArrived(true);
        onArrive?.();
      }}
    >
      <Bloub
        ref={bloubRef}
        state={poseState}
        size={size}
        color={color}
        background="#ffffff"
        eyesVisible={awake}
        respectReducedMotion={false}
      />
    </motion.div>
  );
}
