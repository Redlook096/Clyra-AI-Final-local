"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ChevronDown, Terminal } from "lucide-react";
import { ShiningText } from "@/components/ShiningText";
import { cn } from "@/lib/utils";

const HOLD_MS = 520;

/**
 * Single-row "Run Command" card. Same shape/look as a collapsed VibeMiniCodeBox so the
 * timeline reads consistently. No expandable body.
 *
 * - While active: shimmer the command text.
 * - After 2s while active and the segment is complete, signals onCollapsed so the next step starts.
 */
export function VibeRunBlock({
  body,
  active,
  segmentComplete,
  onCollapsed,
  archived = false,
}: {
  body: string;
  active: boolean;
  segmentComplete?: boolean;
  onCollapsed?: () => void;
  archived?: boolean;
}) {
  const [done, setDone] = useState(() => !!archived);
  const [expanded, setExpanded] = useState(() => !archived);
  const notifiedRef = useRef(false);

  // Pull the actual command line out of the body (model emits "$ npm run lint\nPurpose: ...").
  const command = useMemo(() => {
    const line = body.split("\n").find((l) => l.trim().startsWith("$"));
    if (line) return line.replace(/^\s*\$\s*/, "").trim();
    return body.split("\n")[0]?.trim() || "command";
  }, [body]);

  useEffect(() => {
    if (archived) {
      setDone(true);
      setExpanded(false);
      return;
    }
    if (!active || done) return;
    // Advance after hold even if the stream is slow to close the segment.
    const hold = segmentComplete === false ? Math.min(HOLD_MS, 1400) : HOLD_MS;
    const id = window.setTimeout(() => setDone(true), hold);
    return () => window.clearTimeout(id);
  }, [archived, active, done, segmentComplete]);

  useEffect(() => {
    if (archived) return;
    if (!done || notifiedRef.current) return;
    notifiedRef.current = true;
    onCollapsed?.();
  }, [done, onCollapsed]);

  const open = !done || expanded;

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 10, scale: 0.992 }}
      animate={{ opacity: active || archived ? 1 : 0.76, y: 0 }}
      transition={{ duration: 0.36, ease: [0.22, 1, 0.36, 1] }}
      className={cn(
        "clyra-vibe-agent-card w-full max-w-[640px] overflow-hidden rounded-xl backdrop-blur-md backdrop-saturate-125",
        active && !done && "ring-1 ring-blue-500/10",
      )}
      data-invert-ignore
      style={{ contain: "layout paint" }}
    >
      <button
        type="button"
        onClick={() => done && setExpanded((value) => !value)}
        className="flex w-full items-center gap-2 px-3.5 py-2 text-left text-[13px] transition-colors hover:bg-slate-50/90"
        aria-expanded={open}
      >
        <Terminal className="h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden />
        <span className="shrink-0 text-slate-500 font-medium">Executing</span>
        {active && !done ? (
          <ShiningText
            text={command}
            preset="thinkingChat"
            play
            className="max-w-[420px] truncate font-mono text-[12.5px]"
          />
        ) : (
          <span className="font-mono text-[12.5px] text-slate-700 truncate">{command}</span>
        )}
        <motion.span
          animate={{ rotate: open ? 0 : -90 }}
          transition={{ type: "spring", stiffness: 380, damping: 36, mass: 0.32 }}
          className="ml-auto shrink-0 text-slate-400"
          aria-hidden
        >
          <ChevronDown className="h-3.5 w-3.5" />
        </motion.span>
      </button>
      <AnimatePresence initial={false}>
        {open ? (
          <motion.div
            key="run-details"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.34, ease: [0.22, 1, 0.36, 1] }}
            className="overflow-hidden border-t border-slate-100/70 bg-white/35"
          >
            <pre className="max-h-44 overflow-auto whitespace-pre-wrap px-4 py-3 font-mono text-[11.5px] leading-relaxed text-slate-600 scrollbar-none">
              {body.trim()}
            </pre>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </motion.div>
  );
}
