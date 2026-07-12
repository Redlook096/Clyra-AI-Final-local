import { motion } from "motion/react";
import { Brain } from "lucide-react";
import { cn } from "../lib/utils";

type ShiningPreset = "default" | "thinkingChat";

export function ShiningBrainIcon({ className }: { className?: string }) {
  return (
    <span className={cn("relative inline-flex items-center justify-center", className)} aria-hidden>
      <svg width="0" height="0" className="absolute">
        <defs>
          <motion.linearGradient
            id="brain-shimmer"
            initial={{ x1: "200%", y1: "0%", x2: "300%", y2: "0%" }}
            animate={{ x1: "-100%", y1: "0%", x2: "0%", y2: "0%" }}
            transition={{
              repeat: Infinity,
              duration: 2.5,
              ease: "linear",
            }}
          >
            <stop offset="0%" stopColor="#606060" />
            <stop offset="35%" stopColor="#606060" />
            <stop offset="50%" stopColor="#b0b0b0" />
            <stop offset="75%" stopColor="#606060" />
            <stop offset="100%" stopColor="#606060" />
          </motion.linearGradient>
        </defs>
      </svg>
      <Brain className="h-[15px] w-[15px] shrink-0" stroke="url(#brain-shimmer)" strokeWidth={1.5} />
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

  if (preset === "thinkingChat") {
    return (
      <span
        data-text={text}
        className={cn(
          "clyra-shimmer-text relative inline-block text-[15px] sm:text-[16px] font-medium leading-none",
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
        "inline-block bg-[linear-gradient(110deg,#000,48.5%,#fff,50%,#000,51.5%)] bg-[length:200%_100%] bg-clip-text text-transparent",
        className,
      )}
      initial={{ backgroundPosition: "100% 0" }}
      animate={{ backgroundPosition: "0% 0" }}
      transition={{
        repeat: Infinity,
        duration: 3.5,
        ease: "linear",
      }}
    >
      {text}
    </motion.span>
  );
}
