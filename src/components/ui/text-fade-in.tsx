import { motion, type HTMLMotionProps } from "motion/react";
import { cn } from "@/lib/utils";

export interface TextFadeInProps extends Omit<HTMLMotionProps<"p">, "children"> {
  children: string;
  duration?: number;
  delay?: number;
  by?: "character" | "word";
  staggerDelay?: number;
}

/** Lightweight progressive reveal for completed plain-text assistant replies. */
export function TextFadeIn({
  children,
  className,
  duration = 0.35,
  delay = 0.05,
  by = "character",
  staggerDelay = 0.02,
  ...props
}: TextFadeInProps) {
  const units = by === "word" ? children.split(" ") : children.split("");

  return (
    <motion.p
      initial="hidden"
      animate="show"
      variants={{
        hidden: { opacity: 0 },
        show: { opacity: 1, transition: { staggerChildren: staggerDelay, delayChildren: delay } },
      }}
      className={cn("whitespace-pre-wrap", className)}
      style={{ contain: "content" }}
      {...props}
    >
      {units.map((unit, index) => (
        <motion.span
          key={`${index}-${unit}`}
          variants={{
            hidden: { opacity: 0, filter: "blur(6px)", y: 6 },
            show: { opacity: 1, filter: "blur(0px)", y: 0 },
          }}
          transition={{
            duration,
            ease: [0.25, 0.1, 0.25, 1],
          }}
          style={{ display: "inline-block", whiteSpace: "pre", backfaceVisibility: "hidden", transform: "translateZ(0)" }}
        >
          {unit}
          {by === "word" && index < units.length - 1 ? "\u00A0" : null}
        </motion.span>
      ))}
    </motion.p>
  );
}

export default TextFadeIn;
