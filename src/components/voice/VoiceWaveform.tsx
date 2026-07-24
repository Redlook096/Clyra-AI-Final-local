import { useEffect, useRef } from "react";
import { cn } from "../../lib/utils";

const BAR_COUNT = 27;

export function VoiceWaveform({
  level,
  active,
  muted = false,
  className,
}: {
  level: number;
  active: boolean;
  muted?: boolean;
  className?: string;
}) {
  const barsRef = useRef<Array<HTMLSpanElement | null>>([]);
  const levelRef = useRef(level);
  const activeRef = useRef(active);
  const mutedRef = useRef(muted);
  const frameRef = useRef<number | null>(null);
  const phaseRef = useRef(0);
  const volumeRef = useRef(0);

  levelRef.current = level;
  activeRef.current = active;
  mutedRef.current = muted;

  useEffect(() => {
    let previous = performance.now();
    const render = (now: number) => {
      const elapsed = Math.min(34, now - previous);
      previous = now;
      phaseRef.current += elapsed * 0.012;
      const target = activeRef.current && !mutedRef.current
        ? Math.min(1, Math.max(0.025, levelRef.current))
        : 0;
      const response = target > volumeRef.current ? 0.34 : 0.11;
      volumeRef.current += (target - volumeRef.current) * response;
      const middle = (BAR_COUNT - 1) / 2;

      barsRef.current.forEach((bar, index) => {
        if (!bar) return;
        const distance = Math.abs(index - middle) / middle;
        const bell = Math.exp(-(distance * distance) * 2.6);
        const waves = (
          Math.sin(phaseRef.current + index * 0.4)
          + Math.sin(phaseRef.current * 0.7 - index * 0.2)
          + 2
        ) / 4;
        const height = 4 + bell * (3 + waves * (8 + volumeRef.current * 26));
        bar.style.height = `${height.toFixed(2)}px`;
        bar.style.opacity = mutedRef.current
          ? "0.18"
          : String(0.32 + bell * (0.32 + Math.min(0.36, volumeRef.current * 0.55)));
      });
      frameRef.current = requestAnimationFrame(render);
    };
    frameRef.current = requestAnimationFrame(render);
    return () => {
      if (frameRef.current != null) cancelAnimationFrame(frameRef.current);
    };
  }, []);

  return (
    <div
      className={cn("clyra-voice-waveform", className)}
      role="meter"
      aria-label="Microphone level"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(level * 100)}
    >
      {Array.from({ length: BAR_COUNT }, (_, index) => (
        <span
          key={index}
          ref={(node) => { barsRef.current[index] = node; }}
          className="clyra-voice-waveform__bar"
        />
      ))}
    </div>
  );
}
