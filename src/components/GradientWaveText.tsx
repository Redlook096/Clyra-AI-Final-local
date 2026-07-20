"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";

type Align = "left" | "center" | "right";

const defaultColors = ["#8d6869", "#5a8ea6", "#b9c96e", "#c7c571", "#cb706f", "#7e5e5f"];

interface GradientWaveTextProps {
  children?: React.ReactNode;
  align?: Align;
  className?: string;
  speed?: number;
  paused?: boolean;
  delay?: number;
  repeat?: boolean;
  inView?: boolean;
  once?: boolean;
  radial?: boolean;
  bottomOffset?: number;
  bandGap?: number;
  bandCount?: number;
  customColors?: string[];
  onClick?: (e: React.MouseEvent) => void;
  onMouseEnter?: (e: React.MouseEvent) => void;
  onMouseLeave?: (e: React.MouseEvent) => void;
  ariaLabel?: string;
  /** Called once the one-shot reveal has fully crossed the label. */
  onRevealComplete?: () => void;
  /** Continue on the same text node with the calm status shimmer. */
  shimmer?: boolean;
}

export function GradientWaveText({
  children,
  align = "left",
  className,
  speed = 1.45,
  paused = false,
  delay = 0,
  repeat = false,
  inView = false,
  once = true,
  radial = true,
  bottomOffset = 10,
  bandGap = 4,
  bandCount = 8,
  customColors,
  onClick,
  onMouseEnter,
  onMouseLeave,
  ariaLabel,
  onRevealComplete,
  shimmer = false,
}: GradientWaveTextProps) {
  const elRef = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef(0);
  const tRef = useRef(-52);
  const cyclesDoneRef = useRef(0);
  const finishedRef = useRef(false);
  const startedRef = useRef(false);
  const startAtRef = useRef(0);
  const hasPlayedRef = useRef(false);
  const onRevealCompleteRef = useRef(onRevealComplete);
  const [isInView, setIsInView] = useState(!inView);
  const cycles = repeat ? 0 : 1;

  useEffect(() => {
    onRevealCompleteRef.current = onRevealComplete;
  }, [onRevealComplete]);

  useEffect(() => {
    if (!inView) {
      setIsInView(true);
      return;
    }
    const node = elRef.current;
    if (!node) return;
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          if (once && hasPlayedRef.current) return;
          setIsInView(true);
          hasPlayedRef.current = true;
        } else if (!once) {
          setIsInView(false);
        }
      });
    }, { threshold: 0.1 });
    observer.observe(node);
    return () => observer.disconnect();
  }, [inView, once]);

  const resolvedColors = useMemo(
    () => (customColors?.length ? customColors : defaultColors),
    [customColors],
  );

  const stops = useMemo(() => {
    const arr: string[] = [];
    const baseColor = "var(--gradient-wave-base, rgb(29,29,31))";
    const hiddenColor = "rgba(29,29,31,0)";
    arr.push(`${baseColor} calc((var(--gi) + 0) * 1%)`);
    for (let i = 0; i < bandCount && i < resolvedColors.length * 2; i += 1) {
      const color = resolvedColors[i % resolvedColors.length];
      const offset = (i + 2) * bandGap;
      arr.push(`${color} calc((var(--gi) + ${offset}) * 1%)`);
    }
    const endOffset = (bandCount + 2) * bandGap;
    const appliedBandCount = Math.min(bandCount, resolvedColors.length * 2);
    const finalBandColor = resolvedColors[Math.max(0, appliedBandCount - 1) % resolvedColors.length] ?? baseColor;
    // A sub-pixel-tight transparent edge makes the rainbow front itself expose
    // each glyph pixel. Behind it, the first stop leaves permanent black text.
    arr.push(`${finalBandColor} calc((var(--gi) + ${endOffset - 0.45}) * 1%)`);
    arr.push(`${hiddenColor} calc((var(--gi) + ${endOffset}) * 1%)`);
    return arr.join(", ");
  }, [bandCount, bandGap, resolvedColors]);

  const gradient = useMemo(
    () => radial ? `radial-gradient(circle at 50% bottom, ${stops})` : `linear-gradient(0deg, ${stops})`,
    [radial, stops],
  );

  useEffect(() => {
    const node = elRef.current;
    if (node) node.style.setProperty("--gi", "-52");
  }, []);

  useEffect(() => {
    if (!isInView) return;
    const node = elRef.current;
    if (!node) return;
    tRef.current = -52;
    cyclesDoneRef.current = 0;
    finishedRef.current = false;
    startedRef.current = false;
    startAtRef.current = performance.now() + Math.max(0, delay * 1000);
    node.style.setProperty("--gi", "-52");
  }, [delay, isInView]);

  useEffect(() => {
    const node = elRef.current;
    if (!node || !isInView) return;
    const RANGE = 200;
    let last = performance.now();
    const tick = (now: number) => {
      if (finishedRef.current) return;
      if (!startedRef.current) {
        if (now >= startAtRef.current) {
          startedRef.current = true;
          last = now;
        } else {
          rafRef.current = requestAnimationFrame(tick);
          return;
        }
      }
      const dt = Math.min(64, now - last);
      last = now;
      if (!paused) {
        const increment = (dt * speed) / 16.6667;
        let next = tRef.current + increment;
        if (cycles === 0) {
          if (next >= RANGE) next %= RANGE;
          tRef.current = next;
          node.style.setProperty("--gi", String(next));
        } else {
          while (next >= RANGE && cyclesDoneRef.current < cycles) {
            next -= RANGE;
            cyclesDoneRef.current += 1;
          }
          if (cyclesDoneRef.current >= cycles) {
            tRef.current = RANGE;
            node.style.setProperty("--gi", String(RANGE));
            finishedRef.current = true;
            onRevealCompleteRef.current?.();
            return;
          }
          tRef.current = next;
          node.style.setProperty("--gi", String(next));
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [cycles, isInView, paused, speed]);

  const justifyContent = align === "left" ? "flex-start" : align === "right" ? "flex-end" : "center";
  const handleClick = useCallback((e: React.MouseEvent) => onClick?.(e), [onClick]);
  const handleMouseEnter = useCallback((e: React.MouseEvent) => onMouseEnter?.(e), [onMouseEnter]);
  const handleMouseLeave = useCallback((e: React.MouseEvent) => onMouseLeave?.(e), [onMouseLeave]);

  return (
    <div
      ref={elRef}
      className={cn("inline-flex max-w-full items-center [--gradient-wave-base:rgb(29,29,31)]", className)}
      style={{ justifyContent, "--gi": -52 } as React.CSSProperties}
      aria-label={ariaLabel}
      role={ariaLabel ? "status" : undefined}
      onClick={handleClick}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <span
        style={{
          textAlign: align,
          backgroundImage: shimmer
            ? "linear-gradient(105deg, #1d1d1f 0%, #1d1d1f 38%, #657f9b 45%, #dce9f4 50%, #7896b5 55%, #1d1d1f 62%, #1d1d1f 100%)"
            : gradient,
          backgroundSize: shimmer ? "280% 100%" : undefined,
          backgroundPosition: shimmer ? "115% 50%" : undefined,
          animation: shimmer ? "clyra-status-text-shimmer 1.85s linear infinite" : undefined,
          WebkitBackgroundClip: "text",
          backgroundClip: "text",
          WebkitTextFillColor: "transparent",
          color: "transparent",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          display: "inline-block",
          WebkitFontSmoothing: "antialiased",
          MozOsxFontSmoothing: "grayscale",
          WebkitBackfaceVisibility: "hidden",
          backfaceVisibility: "hidden",
          transform: "translateZ(0)",
          paddingBottom: `${bottomOffset}%`,
          marginBottom: `-${bottomOffset}%`,
          paddingInline: 2,
        }}
      >
        {children}
      </span>
    </div>
  );
}

export default GradientWaveText;
