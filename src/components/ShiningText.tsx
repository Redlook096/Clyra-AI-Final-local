import { useId } from "react";
import { motion } from "motion/react";
import { Brain } from "lucide-react";
import { cn } from "../lib/utils";

type ShiningPreset = "default" | "thinkingChat";

export function ShiningBrainIcon({ className }: { className?: string }) {
  const gradientId = useId().replace(/:/g, "");

  return (
    <span className={cn("relative inline-flex items-center justify-center", className)} aria-hidden>
      <svg width="0" height="0" className="absolute">
        <defs>
          <motion.linearGradient
            id={gradientId}
            initial={{ x1: "200%", y1: "0%", x2: "300%", y2: "0%" }}
            animate={{ x1: "-100%", y1: "0%", x2: "0%", y2: "0%" }}
            transition={{
              repeat: Infinity,
              duration: 1.8,
              ease: "linear",
            }}
          >
            <stop offset="0%" stopColor="#94a3b8" />
            <stop offset="38%" stopColor="#94a3b8" />
            <stop offset="50%" stopColor="#64748b" />
            <stop offset="62%" stopColor="#94a3b8" />
            <stop offset="100%" stopColor="#94a3b8" />
          </motion.linearGradient>
        </defs>
      </svg>
      <Brain className="h-[15px] w-[15px] shrink-0" stroke={`url(#${gradientId})`} strokeWidth={1.5} />
    </span>
  );
}

export function ThinkingDots({ className }: { className?: string }) {
  return (
    <span className={cn("clyra-thinking-dots", className)} aria-hidden>
      <i />
      <i />
      <i />
    </span>
  );
}

export function ShiningText({
  text,
  className,
  preset = "default",
  /** When false, show static text (shine stops). */
  play = true,
}: {
  text: string;
  className?: string;
  preset?: ShiningPreset;
  play?: boolean;
}) {
  if (!play) {
    return (
      <span
        className={cn(
          "inline-block",
          preset === "thinkingChat"
            ? "text-[15px] sm:text-[16px] font-medium text-slate-700"
            : "font-medium text-slate-800",
          className,
        )}
      >
        {text}
      </span>
    );
  }

  return (
    <motion.span
      className={cn(
        "inline-block bg-clip-text text-transparent",
        preset === "thinkingChat"
          ? "clyra-thinking-shimmer text-[12.5px] font-medium leading-none tracking-[-0.01em] sm:text-[13px]"
          : "clyra-shining-text bg-[linear-gradient(110deg,#52525b,35%,#94a3b8,50%,#52525b,75%,#52525b)] bg-[length:200%_100%]",
        className,
      )}
      initial={false}
    >
      {text}
    </motion.span>
  );
}
