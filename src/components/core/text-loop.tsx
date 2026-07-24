import { AnimatePresence, motion } from "motion/react";
import { Children, useEffect, useState, type ReactNode } from "react";

type TextLoopProps = {
  children: ReactNode;
  className?: string;
  interval?: number;
};

/** A small, layout-stable vertical text loop for concise status messages. */
export function TextLoop({ children, className, interval = 1800 }: TextLoopProps) {
  const items = Children.toArray(children);
  const [activeIndex, setActiveIndex] = useState(0);

  useEffect(() => {
    if (items.length < 2) return;
    const timer = window.setInterval(
      () => setActiveIndex((index) => (index + 1) % items.length),
      interval,
    );
    return () => window.clearInterval(timer);
  }, [interval, items.length]);

  return (
    <span className={className} aria-live="polite">
      <AnimatePresence initial={false} mode="wait">
        <motion.span
          key={activeIndex}
          initial={{ opacity: 0, y: 7, filter: "blur(2px)" }}
          animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
          exit={{ opacity: 0, y: -7, filter: "blur(2px)" }}
          transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
        >
          {items[activeIndex]}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}
