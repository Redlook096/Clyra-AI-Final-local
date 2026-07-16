"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ChevronRight } from "lucide-react";
import { ShiningText } from "@/components/ShiningText";
import { cn } from "@/lib/utils";

const MAX_BODY_PX = 168;

/**
 * Type quickly enough to feel live, while still pacing the text through rAF so it
 * does not jump straight to a completed paragraph.
 */
const MS_PER_CHARACTER = 2;

type Phase = "shining" | "typing" | "dwell" | "folded";

/**
 * Inline Cursor-style Thought UI.
 * - Header: chevron + "Thinking" (shimmer) → typed body → 1s dwell → folds to "Thought" + chevron right.
 * - Body is the model's raw THINKING block (or a follow-up reflection beat).
 *
 * Typing uses requestAnimationFrame and advances one character at a time so the reasoning
 * feels genuinely live instead of skipping straight to the end.
 */
export function VibeThoughtPanel({
  body,
  complete,
  active,
  onCollapsed,
  archived = false,
}: {
  body: string;
  complete: boolean;
  active: boolean;
  onCollapsed?: () => void;
  /** Saved / reopened chat: show folded “Thought” with full body, no typing animation. */
  archived?: boolean;
}) {
  const [revealed, setRevealed] = useState(() => (archived ? body.length : 0));
  const [phase, setPhase] = useState<Phase>(() =>
    archived ? "folded" : "shining",
  );
  const [expanded, setExpanded] = useState(false);
  const notifiedRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number | null>(null);
  const shiningDelayRef = useRef(120 + Math.random() * 100);
  const holdMs = Math.min(5200, Math.max(2400, 1800 + body.length * 9));

  useEffect(() => {
    if (archived) {
      setRevealed(body.length);
      setPhase("folded");
      setExpanded(false);
    }
  }, [archived, body.length]);

  // Shining → typing transition after random delay.
  useEffect(() => {
    if (archived) return;
    if (!active || phase !== "shining") return;
    const id = window.setTimeout(() => {
      setPhase("typing");
      setExpanded(true);
    }, shiningDelayRef.current);
    return () => window.clearTimeout(id);
  }, [archived, active, phase]);

  // rAF-driven typing — runs only while active + still typing.
  useEffect(() => {
    if (archived) return;
    if (!active || phase !== "typing") return;
    let cancelled = false;
    let last = performance.now();
    let carry = 0;

    const tick = (now: number) => {
      if (cancelled) return;
      carry += now - last;
      last = now;
      if (carry >= MS_PER_CHARACTER) {
        carry = carry % MS_PER_CHARACTER;
        setRevealed((r) => {
          if (r >= body.length) return r;
          return Math.min(r + 6, body.length);
        });
      }
      rafRef.current = window.requestAnimationFrame(tick);
    };
    rafRef.current = window.requestAnimationFrame(tick);

    return () => {
      cancelled = true;
      if (rafRef.current != null) window.cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [archived, active, phase, body.length]);

  // Dwell only once typed AND the model has finished this thought.
  useEffect(() => {
    if (archived) return;
    if (!active || phase !== "typing") return;
    if (!complete) return;
    if (revealed >= body.length && body.length > 0) {
      setPhase("dwell");
    }
  }, [archived, active, phase, revealed, body.length, complete]);

  // Fold after dwell.
  useEffect(() => {
    if (archived) return;
    if (phase !== "dwell") return;
    const id = window.setTimeout(() => {
      setPhase("folded");
      setExpanded(false);
    }, holdMs);
    return () => window.clearTimeout(id);
  }, [archived, holdMs, phase]);

  // Notify parent so the next step can begin.
  useEffect(() => {
    if (archived) return;
    if (phase !== "folded" || notifiedRef.current) return;
    notifiedRef.current = true;
    onCollapsed?.();
  }, [archived, phase, onCollapsed]);

  // Auto-scroll while typing — smooth scroll on each tick so the viewport glides
  // with the text instead of teleporting on each character.
  useLayoutEffect(() => {
    if (archived) return;
    const el = scrollRef.current;
    if (!el) return;
    const overflow = el.scrollHeight - el.clientHeight;
    if (overflow <= 4) return;
    const targetTop = el.scrollHeight - el.clientHeight;
    if (Math.abs(el.scrollTop - targetTop) < 2) return;
    el.scrollTo({ top: targetTop, behavior: "smooth" });
  }, [archived, revealed]);

  const open =
    phase === "typing" ||
    phase === "dwell" ||
    (expanded && phase !== "shining");
  const showLiveLabel =
    phase === "shining" || phase === "typing" || phase === "dwell";
  const slice = body.slice(0, revealed);

  const chevronSpring = {
    type: "spring" as const,
    stiffness: 380,
    damping: 36,
    mass: 0.32,
  };

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: active || archived ? 1 : 0.72, y: 0 }}
      transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
      className="flex w-full max-w-[640px] flex-col gap-1 text-[14px]"
    >
      <div className="flex items-center gap-2 py-0.5" aria-live="polite">
        {showLiveLabel ? (
          <>
            <motion.span
              className="flex shrink-0 text-slate-400"
              animate={{ rotate: open ? 90 : 0 }}
              transition={chevronSpring}
            >
              <ChevronRight className="h-4 w-4" aria-hidden />
            </motion.span>
            <ShiningText
              text="Thinking"
              preset="thinkingChat"
              className="text-[13px] font-medium"
            />
          </>
        ) : (
          <button
            type="button"
            onClick={() => setExpanded((e) => !e)}
            className="group flex w-fit items-center gap-2 rounded-md py-0.5 pl-0.5 pr-2 text-left transition-colors hover:bg-slate-100/70"
          >
            <motion.span
              className="flex shrink-0 text-slate-400 transition-colors group-hover:text-slate-500"
              animate={{ rotate: expanded ? 90 : 0 }}
              transition={chevronSpring}
            >
              <ChevronRight className="h-4 w-4" />
            </motion.span>
            <span className="text-[13px] font-medium text-slate-500">
              Thought
            </span>
          </button>
        )}
      </div>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="thought-panel"
            initial={{ height: 0, opacity: 0, y: -2 }}
            animate={{ height: "auto", opacity: 1, y: 0 }}
            exit={{ height: 0, opacity: 0, y: -2 }}
            transition={{
              type: "spring",
              bounce: 0.03,
              stiffness: 180,
              damping: 34,
              opacity: { duration: 0.24 },
            }}
            className="overflow-hidden"
          >
            <div className="flex gap-3 py-2 pl-0.5 pr-1">
              <div
                aria-hidden
                className={cn(
                  "mt-0.5 w-px shrink-0 self-stretch",
                  active
                    ? "bg-gradient-to-b from-blue-400 via-slate-300 to-transparent"
                    : "bg-slate-200",
                )}
              />
              <div
                ref={scrollRef}
                className="min-h-[1.25rem] min-w-0 flex-1 overflow-y-auto whitespace-pre-wrap text-[13.5px] font-normal leading-[1.6] tracking-[-0.012em] text-slate-600 [text-rendering:optimizeLegibility] scrollbar-none"
                style={{
                  maxHeight: MAX_BODY_PX,
                  contain: "layout style paint",
                }}
              >
                {slice}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
