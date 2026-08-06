import { useEffect, useRef } from "react";
import { cn } from "../../lib/utils";

/** Compact animated wave icon for the composer start-call button. */
export function VoiceWaveIcon({
  className,
  active = false,
}: {
  className?: string;
  active?: boolean;
}) {
  const barsRef = useRef<Array<HTMLSpanElement | null>>([]);
  const frameRef = useRef<number | null>(null);
  const phaseRef = useRef(0);
  const scales = [0.38, 0.62, 1, 0.62, 0.38];

  useEffect(() => {
    if (!active) {
      barsRef.current.forEach((bar, index) => {
        if (!bar) return;
        bar.style.height = `${Math.round(14 * scales[index]!)}px`;
        bar.style.opacity = "1";
      });
      return;
    }
    let previous = performance.now();
    const render = (now: number) => {
      const elapsed = Math.min(32, now - previous);
      previous = now;
      phaseRef.current += elapsed * 0.018;
      barsRef.current.forEach((bar, index) => {
        if (!bar) return;
        const wave = (Math.sin(phaseRef.current + index * 0.7) + 1) / 2;
        const scale = 0.35 + scales[index]! * (0.45 + wave * 0.55);
        bar.style.height = `${Math.max(3, Math.round(14 * scale))}px`;
        bar.style.opacity = String(0.55 + wave * 0.45);
      });
      frameRef.current = requestAnimationFrame(render);
    };
    frameRef.current = requestAnimationFrame(render);
    return () => {
      if (frameRef.current != null) cancelAnimationFrame(frameRef.current);
    };
  }, [active]);

  return (
    <span
      className={cn(
        "inline-flex h-[14px] w-[14px] items-center justify-center gap-[1.5px]",
        className,
      )}
      aria-hidden
    >
      {scales.map((_, index) => (
        <span
          key={index}
          ref={(node) => {
            barsRef.current[index] = node;
          }}
          className="w-[2px] rounded-full bg-current"
          style={{ height: `${Math.round(14 * scales[index]!)}px` }}
        />
      ))}
    </span>
  );
}
