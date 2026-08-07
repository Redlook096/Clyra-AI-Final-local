import { useEffect, useRef, useState } from "react";

/**
 * Smoothly interpolates a displayed integer toward its real target value.
 * Counters always start at 0 and tween toward actual diff statistics —
 * intermediate frames are interpolation of real data, never invented totals.
 */
function useTweenedNumber(target: number, durationMs = 240) {
  const [display, setDisplay] = useState(0);
  const displayRef = useRef(0);
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    const from = displayRef.current;
    const to = target;
    if (from === to) return;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
    if (reduced) {
      displayRef.current = to;
      setDisplay(to);
      return;
    }
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      const eased = 1 - Math.pow(1 - t, 3);
      const value = Math.round(from + (to - from) * eased);
      displayRef.current = value;
      setDisplay(value);
      if (t < 1) frameRef.current = requestAnimationFrame(step);
    };
    frameRef.current = requestAnimationFrame(step);
    return () => {
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
    };
  }, [target, durationMs]);

  return display;
}

export function DiffCounters({
  additions,
  deletions,
  showZero = true,
  className,
}: {
  additions?: number;
  deletions?: number;
  showZero?: boolean;
  className?: string;
}) {
  const add = useTweenedNumber(additions ?? 0);
  const del = useTweenedNumber(deletions ?? 0);
  const showAdd = additions !== undefined || showZero;
  const showDel = deletions !== undefined || showZero;
  if (!showAdd && !showDel) return null;
  return (
    <span className={`cc-counter inline-flex items-center gap-1 text-[11px] tabular-nums ${className ?? ""}`}>
      {showAdd ? (
        <span className="text-[color:var(--addition-green)]">+{add}</span>
      ) : null}
      {showDel ? (
        <span className="text-[color:var(--deletion-red)]">−{del}</span>
      ) : null}
    </span>
  );
}
