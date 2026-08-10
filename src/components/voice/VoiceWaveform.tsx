import { useEffect, useRef } from "react";
import { cn } from "../../lib/utils";

/** Odd count so the centre peak reads clearly. */
const BAR_COUNT = 39;

/**
 * Premium mic waveform — GPU-friendly scaleY bars, critically-damped volume,
 * soft travelling envelopes. Driven only by real mic RMS (no random noise).
 */
export function VoiceWaveform({
  level,
  active,
  muted = false,
  compact = false,
  className,
}: {
  level: number;
  active: boolean;
  muted?: boolean;
  /** Narrower bars for composer / dictation pills. */
  compact?: boolean;
  className?: string;
}) {
  const barsRef = useRef<Array<HTMLSpanElement | null>>([]);
  const levelRef = useRef(level);
  const activeRef = useRef(active);
  const mutedRef = useRef(muted);
  const frameRef = useRef<number | null>(null);
  const phaseRef = useRef(0);
  const volumeRef = useRef(0);
  const velocityRef = useRef(0);
  const breathRef = useRef(0);

  levelRef.current = level;
  activeRef.current = active;
  mutedRef.current = muted;

  useEffect(() => {
    let previous = performance.now();
    const reduce =
      typeof matchMedia === "function" &&
      matchMedia("(prefers-reduced-motion: reduce)").matches;

    const render = (now: number) => {
      const dtMs = Math.min(40, Math.max(6, now - previous));
      previous = now;
      const dt = dtMs / 16.67;

      phaseRef.current += dtMs * (reduce ? 0.006 : 0.011);
      breathRef.current += dtMs * 0.00185;

      const speaking = activeRef.current && !mutedRef.current;
      const idleFloor = speaking
        ? 0.035 + Math.sin(breathRef.current) * 0.014 + Math.sin(breathRef.current * 0.37) * 0.006
        : 0;
      const raw = speaking ? Math.min(1, Math.max(0, levelRef.current)) : 0;
      // Perceptual curve — quiet speech still moves the centre.
      const shaped = Math.pow(raw, 0.68);
      const target = speaking ? Math.max(idleFloor, shaped * 0.92 + idleFloor * 0.08) : 0;

      // Critically-damped spring toward target (butter-smooth, no overshoot bounce).
      const stiffness = target > volumeRef.current ? 0.38 : 0.16;
      const damping = 0.72;
      const force = (target - volumeRef.current) * stiffness;
      velocityRef.current = (velocityRef.current + force * dt) * Math.pow(damping, dt);
      volumeRef.current = Math.max(0, Math.min(1.15, volumeRef.current + velocityRef.current * dt));
      if (!speaking && volumeRef.current < 0.008) {
        volumeRef.current = 0;
        velocityRef.current = 0;
      }

      const middle = (BAR_COUNT - 1) / 2;
      const volume = volumeRef.current;
      const maxScale = compact ? 1 : 1;

      barsRef.current.forEach((bar, index) => {
        if (!bar) return;
        const t = (index - middle) / middle;
        const distance = Math.abs(t);
        // Soft Gaussian bell + slight outer lift so edges stay alive.
        const bell = Math.exp(-(distance * distance) * 2.1) * (1 - distance * 0.08);
        // Two slow travelling envelopes (asymmetric, Siri-like).
        const waveA = Math.sin(phaseRef.current * 0.92 + index * 0.34);
        const waveB = Math.sin(phaseRef.current * 0.48 - index * 0.19 + 0.55);
        const waveC = Math.sin(phaseRef.current * 1.35 + index * 0.11);
        const waves = (waveA * 0.48 + waveB * 0.36 + waveC * 0.16 + 2.05) / 3.05;
        // Map to scaleY — compositor-friendly vs rewriting height every frame.
        const energy = 0.12 + waves * (0.22 + volume * 0.78);
        const scale = Math.max(0.08, Math.min(1, bell * energy * maxScale));
        const opacity = mutedRef.current
          ? 0.14
          : 0.22 + bell * (0.3 + Math.min(0.48, volume * 0.7));

        bar.style.transform = `scaleY(${scale.toFixed(4)})`;
        bar.style.opacity = opacity.toFixed(3);
      });
      frameRef.current = requestAnimationFrame(render);
    };
    frameRef.current = requestAnimationFrame(render);
    return () => {
      if (frameRef.current != null) cancelAnimationFrame(frameRef.current);
    };
  }, [compact]);

  return (
    <div
      className={cn(
        "clyra-voice-waveform",
        compact && "clyra-voice-waveform--compact",
        muted && "clyra-voice-waveform--muted",
        className,
      )}
      role="meter"
      aria-label="Microphone level"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(Math.min(1, Math.max(0, level)) * 100)}
    >
      {Array.from({ length: BAR_COUNT }, (_, index) => (
        <span
          key={index}
          ref={(node) => {
            barsRef.current[index] = node;
          }}
          className="clyra-voice-waveform__bar"
        />
      ))}
    </div>
  );
}
