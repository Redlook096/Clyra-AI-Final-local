import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Bloub, type BloubHandle } from "./Bloub";

export type BloubBootPhase = "holding" | "ripple" | "complete";

interface BloubBootAvatarProps {
  /** Boot preload progress, 0–1. Eyes stay hidden until this reaches 1. */
  progress: number;
  /** Mirrors the app's boot-overlay phase. */
  phase: BloubBootPhase;
  color: string;
  /** CSS selector for the on-page slot to fly into once the overlay lifts. */
  targetSelector: string;
  size?: number;
  /** Fires the instant the fly-into-position animation finishes (or, if no
   *  target was found, once the in-place fade-out finishes). */
  onArrive?: () => void;
}

type Travel = { dx: number; dy: number; scale: number; opacity: number };

/**
 * The boot-splash avatar: bare round body while the app loads (no eyes),
 * wakes up with a blink the instant loading completes, then — while the
 * existing ripple hand-off plays — flies from its centred boot position
 * into the real chat-home avatar slot and fades out right as it lands.
 *
 * Rendered as a single persistent instance across the "holding" -> "ripple"
 * phases (same React position/key in the tree) so the in-flight FLIP
 * transform is never interrupted by a remount.
 */
export function BloubBootAvatar({
  progress,
  phase,
  color,
  targetSelector,
  size = 72,
  onArrive,
}: BloubBootAvatarProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const bloubRef = useRef<BloubHandle | null>(null);
  const [travel, setTravel] = useState<Travel | null>(null);
  const startedRef = useRef(false);
  const arrivedRef = useRef(false);
  const awake = progress >= 1;

  // Same fixed, upright, dead-centre gaze as the landed header avatar —
  // set the instant the eyes open so it never shows the state's default
  // off-axis rest look, not even for a frame.
  const wokeRef = useRef(false);
  useEffect(() => {
    if (awake && !wokeRef.current) {
      wokeRef.current = true;
      bloubRef.current?.setGaze(0, 0, 0);
    }
  }, [awake]);

  useLayoutEffect(() => {
    if (phase !== "ripple" || startedRef.current) return;
    startedRef.current = true;

    const node = wrapRef.current;
    const target = document.querySelector(targetSelector) as HTMLElement | null;
    const origin = node?.getBoundingClientRect();

    if (!node || !origin || !target) {
      // Nowhere to fly to (e.g. booted straight into an existing
      // conversation): just settle back into idle in place.
      setTravel({ dx: 0, dy: 0, scale: 1, opacity: 0 });
      return;
    }

    const targetRect = target.getBoundingClientRect();
    const dx = targetRect.left + targetRect.width / 2 - (origin.left + origin.width / 2);
    const dy = targetRect.top + targetRect.height / 2 - (origin.top + origin.height / 2);
    const scale = targetRect.width > 0 ? targetRect.width / origin.width : 1;
    setTravel({ dx, dy, scale, opacity: 0 });
  }, [phase, targetSelector]);

  return (
    <motion.div
      ref={wrapRef}
      className="clyra-boot-avatar"
      style={{ width: size, height: size }}
      initial={false}
      animate={
        travel
          ? { x: travel.dx, y: travel.dy, scale: travel.scale, opacity: travel.opacity }
          : { x: 0, y: 0, scale: 1, opacity: 1 }
      }
      transition={
        travel
          ? {
              x: { duration: 0.62, ease: [0.16, 1, 0.3, 1] },
              y: { duration: 0.62, ease: [0.16, 1, 0.3, 1] },
              scale: { duration: 0.62, ease: [0.16, 1, 0.3, 1] },
              opacity: { duration: 0.2, delay: 0.42 },
            }
          : { duration: 0 }
      }
      onAnimationComplete={() => {
        if (!travel || arrivedRef.current) return;
        arrivedRef.current = true;
        onArrive?.();
      }}
    >
      <Bloub
        ref={bloubRef}
        state="idle"
        size={size}
        color={color}
        background="#ffffff"
        eyesVisible={awake}
        respectReducedMotion={false}
      />
    </motion.div>
  );
}
