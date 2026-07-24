import { useEffect, useLayoutEffect, useState } from "react";
import { cn } from "../../lib/utils";
import { GradientWaveText } from "./gradient-wave-text";

type StatusTextRevealProps = {
  text: string;
  className?: string;
  ariaLabel?: string;
  align?: "left" | "center" | "right";
  onPhaseChange?: (phase: "reveal" | "settle" | "shimmer") => void;
};

/** A rainbow radial reveal, a quiet half-second hold, then a restrained shimmer. */
export function StatusTextReveal({
  text,
  className,
  ariaLabel,
  align = "left",
  onPhaseChange,
}: StatusTextRevealProps) {
  const [phase, setPhase] = useState<"reveal" | "settle" | "shimmer">("reveal");
  const [isPrimed, setIsPrimed] = useState(false);

  useEffect(() => {
    setPhase("reveal");
    setIsPrimed(false);
  }, [text]);

  useEffect(() => {
    onPhaseChange?.(phase);
  }, [onPhaseChange, phase]);

  // The first paint is deliberately transparent. Starting the wave on the
  // next frame avoids a visible base-text flash while the radial gradient is
  // being attached to the new status label.
  useLayoutEffect(() => {
    if (phase !== "reveal") return;
    const frame = requestAnimationFrame(() => setIsPrimed(true));
    return () => cancelAnimationFrame(frame);
  }, [phase, text]);

  useEffect(() => {
    if (phase !== "settle") return;
    const timer = window.setTimeout(() => setPhase("shimmer"), 500);
    return () => window.clearTimeout(timer);
  }, [phase]);

  return (
    <GradientWaveText
      key={text}
      className={cn("clyra-status-text-reveal", isPrimed && "is-primed", className)}
      align={align}
      speed={4}
      paused={!isPrimed}
      repeat={false}
      bottomOffset={0}
      ariaLabel={ariaLabel}
      shimmer={phase === "shimmer"}
      onRevealComplete={() => setPhase("settle")}
    >
      {text}
    </GradientWaveText>
  );
}
