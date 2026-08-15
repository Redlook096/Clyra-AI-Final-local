import { memo, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ChevronRight } from "lucide-react";
import { cn } from "../../lib/utils";
import type { AgentAction } from "./store";
import { ShimmerText } from "./Shimmer";
import { DiffCounters } from "./AnimatedCounter";
import { computeLineDiff, linesFromPatch, type DiffLine } from "./diff";
import { AGENT_EASE, LABEL_MORPH, SUBTLE_ENTER } from "./motion";

/**
 * Lifecycle-driven streaming edit box.
 *
 * One persistent component morphs through its phases exactly once:
 *   header enters from the left → body opens slowly → real harness lines are
 *   typed character by character (line by line) → hold ~1s → smooth collapse
 *   → onClosed signals the transcript to reveal the next action.
 *
 * Historical rows (restored sessions) render settled and never replay.
 */

type Phase = "header" | "open" | "settled" | "closed" | "failed";

function linesFor(action: AgentAction): DiffLine[] {
  if (action.patch) return linesFromPatch(action.patch);
  if (action.before || action.after) {
    return computeLineDiff(action.before ?? "", action.after ?? "");
  }
  if (action.kind === "create" && action.contentAfter) {
    return action.contentAfter.split("\n").map((text, index) => ({
      kind: "add" as const,
      text,
      afterLine: index + 1,
    }));
  }
  return [];
}

const LINE_CLASSES: Record<DiffLine["kind"], { row: string; text: string }> = {
  add: { row: "bg-[rgba(46,160,90,0.085)]", text: "text-[#1c6b3d]" },
  del: { row: "bg-[rgba(195,73,73,0.075)]", text: "text-[#a53c3c]" },
  context: { row: "", text: "text-[color:var(--text-secondary)]" },
};

/** One diff line that types its real text character by character. */
const DiffBodyLine = memo(function DiffBodyLine({
  line,
  index,
  typing,
  typingDuration,
  onDone,
}: {
  line: DiffLine;
  index: number;
  /** When true, type the text progressively and call onDone at the end. */
  typing: boolean;
  typingDuration: number;
  onDone?: () => void;
}) {
  const styles = LINE_CLASSES[line.kind];
  const prefix = line.kind === "add" ? "+ " : line.kind === "del" ? "− " : "  ";
  const full = line.text.length;
  const [chars, setChars] = useState(() => (typing ? 0 : full));
  const doneRef = useRef(!typing);

  useEffect(() => {
    if (!typing || full === 0) {
      setChars(full);
      if (!doneRef.current) {
        doneRef.current = true;
        onDone?.();
      }
      return;
    }
    let frame: number;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / typingDuration);
      const eased = 1 - Math.pow(1 - t, 2);
      setChars(Math.min(full, Math.ceil(full * eased)));
      if (t < 1) {
        frame = requestAnimationFrame(tick);
      } else if (!doneRef.current) {
        doneRef.current = true;
        onDone?.();
      }
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const visible = chars >= full ? line.text : line.text.slice(0, chars);

  return (
    <div className={cn("flex items-start", styles.row)}>
      <span className="w-7 shrink-0 select-none pr-1.5 text-right text-[9px] leading-[1.65] text-[#C2C2C0]">
        {line.beforeLine ?? ""}
      </span>
      <span className="w-7 shrink-0 select-none pr-1.5 text-right text-[9px] leading-[1.65] text-[#C2C2C0]">
        {line.afterLine ?? ""}
      </span>
      <span
        className={cn(
          "cc-mono min-w-0 flex-1 whitespace-pre-wrap break-words text-[10.75px] leading-[1.55]",
          styles.text,
        )}
      >
        {prefix}
        {visible}
      </span>
    </div>
  );
});

export const AgentFileEdit = memo(function AgentFileEdit({
  action,
  onOpenFile,
  onClosed,
  settled = false,
}: {
  action: AgentAction;
  onOpenFile?: (path: string) => void;
  /** Fires once when this box's lifecycle is complete (collapsed/failed). */
  onClosed?: (id: string) => void;
  /** Expanded historical/complete phase: show static, never replay a diff. */
  settled?: boolean;
}) {
  const reducedMotion = useReducedMotion();
  const lines = useMemo(
    () => linesFor(action),
    [action.patch, action.kind, action.contentAfter, action.before, action.after],
  );
  const changeCount = useMemo(() => lines.filter((l) => l.kind !== "context").length, [lines]);

  const active = action.status === "active" || action.status === "queued";
  const completed = action.status === "success";
  const failed = action.status === "error" || action.status === "cancelled";
  const hasLines = lines.length > 0;

  // Historical rows (restored sessions / reopened tabs) render settled.
  const [historical] = useState(() => {
    if (settled) return true;
    if (active) return false;
    const ended = action.endedAt ?? action.startedAt;
    return Date.now() - ended > 4000;
  });

  const [phase, setPhase] = useState<Phase>(() => {
    if (failed) return "failed";
    if (active) return "header";
    if (completed && !historical) return "header";
    return "closed";
  });
  const [manualOpen, setManualOpen] = useState<boolean | null>(null);
  const open = manualOpen ?? (phase === "open" || phase === "settled");

  // Typing progress: number of fully typed change lines.
  const [typedCount, setTypedCount] = useState(0);
  const closedRef = useRef(false);

  const notifyClosed = () => {
    if (!closedRef.current) {
      closedRef.current = true;
      onClosed?.(action.id);
    }
  };

  /* ---------------- one-shot lifecycle ---------------- */

  // Open once: shortly after the header appears while active, or as soon as
  // the real lines arrive (write content lands at completion in this harness).
  useEffect(() => {
    if (failed || manualOpen !== null) return;
    if (phase !== "header") return;
    if (!hasLines) return;
    const delay = active ? 200 : 120;
    const timer = window.setTimeout(() => setPhase("open"), delay);
    return () => window.clearTimeout(timer);
  }, [failed, manualOpen, phase, hasLines, active]);

  // Settle once completed. Hold starts only after the typing finishes.
  useEffect(() => {
    if (!completed || manualOpen !== null) return;
    if (phase === "open" && typedCount >= changeCount) {
      const timer = window.setTimeout(() => setPhase("settled"), 60);
      return () => window.clearTimeout(timer);
    }
    if (phase === "settled") {
      const timer = window.setTimeout(() => {
        setPhase("closed");
        notifyClosed();
      }, 1000);
      return () => window.clearTimeout(timer);
    }
  }, [completed, manualOpen, phase, typedCount, changeCount, action.id]);

  // Failures collapse the body and keep the failed header.
  useEffect(() => {
    if (failed && phase !== "failed") {
      setPhase("failed");
      const timer = window.setTimeout(notifyClosed, 400);
      return () => window.clearTimeout(timer);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [failed, phase, action.id]);

  // Line-less completed edits release the transcript gate shortly after.
  useEffect(() => {
    if (historical) {
      notifyClosed();
      return;
    }
    if (completed && !hasLines && phase !== "closed" && phase !== "failed") {
      const timer = window.setTimeout(() => {
        setPhase("closed");
        notifyClosed();
      }, 600);
      return () => window.clearTimeout(timer);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historical, completed, hasLines, phase, action.id]);

  // Manual reopen shows the whole real diff instantly (no replay).
  useEffect(() => {
    if (!open) {
      if (phase !== "header") setTypedCount(0);
      return;
    }
    if (reducedMotion || manualOpen || historical) {
      setTypedCount(changeCount);
    }
  }, [open, manualOpen, reducedMotion, historical, changeCount, phase]);

  // Per-line typing budget: bounded so big files stay fluid, small files
  // still feel deliberate.
  const perLineDuration = useMemo(() => {
    if (changeCount <= 0) return 0;
    const total = Math.min(9000, Math.max(2600, changeCount * 240));
    return total / changeCount;
  }, [changeCount]);

  const advanceTyped = () => setTypedCount((current) => Math.min(changeCount, current + 1));

  /* ---------------- internal auto-follow ---------------- */
  const bodyScrollRef = useRef<HTMLDivElement | null>(null);
  const userScrolledRef = useRef(false);

  useEffect(() => {
    userScrolledRef.current = false;
  }, [open]);

  useEffect(() => {
    const node = bodyScrollRef.current;
    if (!node) return;
    const frame = requestAnimationFrame(() => {
      if (!userScrolledRef.current) {
        node.scrollTo({ top: node.scrollHeight, behavior: reducedMotion ? "auto" : "smooth" });
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [typedCount, open, lines.length, reducedMotion]);

  /* ---------------- header ---------------- */

  const verb = active
    ? "Editing"
    : failed
      ? action.status === "cancelled"
        ? "Cancelled"
        : "Failed editing"
      : "Edited";
  const verbClass = failed
    ? "text-[#B94B4B]"
    : active
      ? "text-[#55575C]"
      : "text-[#73757A]";

  const additions = action.additions ?? 0;
  const deletions = action.deletions ?? 0;

  // Change lines only (context lines render statically when the body opens).
  const typingActive = open && !reducedMotion && !historical && manualOpen !== true && phase !== "closed";

  let changeIndex = 0;
  const renderedLines = lines.map((line, index) => {
    if (line.kind === "context") {
      return <DiffBodyLine key={index} line={line} index={index} typing={false} typingDuration={0} />;
    }
    const position = changeIndex;
    changeIndex += 1;
    if (position > typedCount) return null;
    const isCurrent = position === typedCount;
    return (
      <DiffBodyLine
        key={index}
        line={line}
        index={index}
        typing={typingActive && isCurrent}
        typingDuration={perLineDuration}
        onDone={typingActive && isCurrent ? advanceTyped : undefined}
      />
    );
  });

  const toggle = () => {
    if (hasLines) {
      const next = manualOpen === null ? !open : !manualOpen;
      if (next === false && (phase === "open" || phase === "settled")) {
        // A manual collapse finishes this box's lifecycle so the transcript
        // gate can move on to the next action.
        notifyClosed();
      }
      setManualOpen(next);
      return;
    }
    if (completed && onOpenFile && action.target !== "…") {
      onOpenFile(action.target);
    }
  };

  return (
    <motion.div
      layout
      initial={historical ? false : { opacity: 0, x: -5 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{
        opacity: { duration: 0.3, ease: AGENT_EASE },
        x: { duration: 0.32, ease: AGENT_EASE },
        layout: { duration: 0.3, ease: AGENT_EASE },
      }}
      className="group min-w-0"
    >
      <motion.div
        layout
        transition={{ layout: { duration: 0.3, ease: AGENT_EASE } }}
        className={cn(
          "overflow-hidden rounded-[9px] border border-black/[0.075] bg-white shadow-[0_1px_2px_rgba(0,0,0,0.025)]",
          completed && "opacity-[0.78] transition-opacity duration-200",
        )}
      >
      <div
        className={cn(
          "flex min-h-[32px] items-center gap-2 px-[10px]",
          (hasLines || (completed && onOpenFile)) && "cursor-pointer",
          open && hasLines && "border-b border-black/[0.055]",
        )}
        onClick={toggle}
        role={(hasLines || (completed && onOpenFile)) ? "button" : undefined}
        aria-expanded={hasLines ? open : undefined}
      >
        <AnimatePresence mode="popLayout" initial={historical}>
          <motion.span
            key={verb}
            {...(historical ? {} : LABEL_MORPH)}
            className={cn(
              "inline-block min-w-[9ch] shrink-0 text-left text-[12px] font-medium leading-none",
              verbClass,
            )}
          >
            {verb}
          </motion.span>
        </AnimatePresence>
        <AnimatePresence initial={false}>
          {action.target !== "…" ? (
            <motion.span
              key="target"
              initial={historical ? false : { opacity: 0, x: -2 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.3, ease: AGENT_EASE }}
              className="flex min-w-0"
            >
              <ShimmerText
                text={action.target}
                active={active}
                tone="blue"
                mono
                className="min-w-0 text-[11px] text-[#505258]"
              />
            </motion.span>
          ) : null}
        </AnimatePresence>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          <DiffCounters
            additions={additions}
            deletions={deletions}
            showZero
            animate={!historical}
            className="text-[10.75px] font-medium"
          />
          {hasLines ? (
            <motion.span
              initial={historical ? { rotate: open ? 90 : 0 } : false}
              animate={{ rotate: open ? 90 : 0 }}
              transition={{ duration: 0.18, ease: AGENT_EASE }}
              className="flex h-5 w-5 items-center justify-center rounded-[5px] text-[#9B9DA2] transition-colors hover:bg-black/[0.04]"
            >
              <ChevronRight className="h-3.5 w-3.5" strokeWidth={1.65} />
            </motion.span>
          ) : null}
        </span>
      </div>

      {failed && action.error ? (
        <motion.div {...(historical ? {} : SUBTLE_ENTER)} className="ml-1 mt-[3px] max-w-[600px] text-[11.75px] leading-[1.5] text-[#787A7F]">
          <span className="mr-1 font-medium text-[#B94B4B]">×</span>
          {action.error}
        </motion.div>
      ) : null}

      <AnimatePresence initial={false}>
        {open && hasLines && !failed ? (
          <motion.div
            key="body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{
              height: { duration: 0.5, ease: AGENT_EASE },
              opacity: { duration: 0.25, delay: 0.08 },
            }}
            className="overflow-hidden"
          >
            <div
              ref={bodyScrollRef}
              onScroll={(event) => {
                const node = event.currentTarget;
                userScrolledRef.current =
                  node.scrollHeight - node.scrollTop - node.clientHeight > 24;
              }}
              className="cc-scroll max-h-[240px] overflow-y-auto bg-[#FAFAF9] px-1 py-1"
            >
              {renderedLines}
            </div>
            {completed && onOpenFile && action.target !== "…" ? (
              <button
                type="button"
                onClick={() => onOpenFile(action.target)}
                className="m-1 rounded-[6px] px-2 py-[2px] text-[12px] text-[#5F6368] transition-colors hover:bg-black/[0.035]"
              >
                Open diff
              </button>
            ) : null}
          </motion.div>
        ) : null}
      </AnimatePresence>
      </motion.div>
    </motion.div>
  );
});
