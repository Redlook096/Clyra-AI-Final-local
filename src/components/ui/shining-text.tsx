"use client";

import * as React from "react";
import { motion } from "motion/react";

type ShiningTextProps = {
  text: string;
  className?: string;
};

export function ShiningText({ text, className }: ShiningTextProps) {
  return (
    <motion.span
      className={[
        "bg-[linear-gradient(110deg,#404040,35%,#fff,50%,#404040,75%,#404040)]",
        "bg-[length:200%_100%]",
        "bg-clip-text",
        "inline-block whitespace-nowrap py-[1px]",
        "text-base",
        "font-medium",
        "text-transparent",
        className ?? "",
      ].join(" ")}
      initial={{ backgroundPosition: "200% 0" }}
      animate={{ backgroundPosition: "-200% 0" }}
      transition={{
        repeat: Infinity,
        duration: 3.2,
        ease: "linear",
      }}
    >
      {text}
    </motion.span>
  );
}
