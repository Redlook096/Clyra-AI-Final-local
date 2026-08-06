import { useEffect, useRef } from "react";
import { cn } from "../../lib/utils";

/** Soft Siri-style bar count — odd so the centre peak reads clearly. */
const BAR_COUNT = 31;

/**
 * Premium Apple-style mic waveform.
 * Driven only by real mic RMS (no random noise). Fast attack / soft release
 * so it feels reactive while staying calm and professional.
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
  const breathRef = useRef(0);

  levelRef.current = level;
  activeRef.current = active;
  mutedRef.current = muted;

  useEffect(() => {
    let previous = performance.now();
    const render = (now: number) => {
      const elapsed = Math.min(32, Math.max(8, now - previous));
      previous = now;
      phaseRef.current += elapsed * 0.014;
      breathRef.current += elapsed * 0.0022;

      const speaking = activeRef.current && !mutedRef.current;
      // Soft idle breath so the wave never looks frozen while listening.
      const idleFloor = speaking ? 0.04 + Math.sin(breathRef.current) * 0.018 : 0;
      const raw = speaking ? Math.min(1, Math.max(0, levelRef.current)) : 0;
      // Gentle perceptual curve — quiet speech still moves the centre bars.
      const shaped = Math.pow(raw, 0.72);
      const target = speaking ? Math.max(idleFloor, shaped) : 0;
      // Fast attack, softer release (Apple Voice Memos feel).
      const response = target > volumeRef.current ? 0.48 : 0.14;
      volumeRef.current += (target - volumeRef.current) * response;

      const middle = (BAR_COUNT - 1) / 2;
      const volume = volumeRef.current;
      const maxH = compact ? 26 : 34;
      const minH = compact ? 3 : 4;

      barsRef.current.forEach((bar, index) => {
        if (!bar) return;
        const distance = Math.abs(index - middle) / middle;
        const bell = Math.exp(-(distance * distance) * 2.35);
        // Two soft travelling envelopes — asymmetric like Siri.
        const waveA = Math.sin(phaseRef.current * 1.05 + index * 0.38);
        const waveB = Math.sin(phaseRef.current * 0.62 - index * 0.22 + 0.4);
        const waves = (waveA * 0.55 + waveB * 0.45 + 2) / 3;
        const height = minH + bell * (2.5 + waves * (6 + volume * (maxH - 8)));
        const opacity = mutedRef.current
          ? 0.16
          : 0.28 + bell * (0.28 + Math.min(0.42, volume * 0.62));
        bar.style.height = `${height.toFixed(2)}px`;
        bar.style.opacity = String(opacity);
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
