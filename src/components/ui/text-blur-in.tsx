"use client";

import { motion, type HTMLMotionProps } from "motion/react";
import { cn } from "@/lib/utils";

export interface TextBlurInProps
  extends Omit<HTMLMotionProps<"p">, "children"> {
  children: string;
  duration?: number;
  delay?: number;
  by?: "character" | "word";
  staggerDelay?: number;
}

/** A small, GPU-friendly reveal for completed assistant responses. */
export function TextBlurIn({
  children,
  className,
  duration = 0.45,
  delay = 0,
  by = "word",
  staggerDelay = 0.018,
  ...props
}: TextBlurInProps) {
  const units = by === "word" ? children.split(" ") : children.split("");

  return (
    <motion.p className={cn("whitespace-pre-wrap", className)} {...props}>
      {units.map((unit, index) => (
        <motion.span
          key={`${index}-${unit}`}
          initial={{ opacity: 0, filter: "blur(8px)", y: 2 }}
          animate={{ opacity: 1, filter: "blur(0px)", y: 0 }}
          transition={{
            duration,
            delay: delay + index * staggerDelay,
            ease: [0.22, 1, 0.36, 1],
          }}
          style={{ display: "inline-block", whiteSpace: "pre" }}
        >
          {unit === "" ? "\u00A0" : unit}
          {by === "word" && index < units.length - 1 ? "\u00A0" : null}
        </motion.span>
      ))}
    </motion.p>
  );
}

export default TextBlurIn;
