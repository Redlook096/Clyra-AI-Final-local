"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  AnimatePresence,
  type MotionValue,
  motion,
  useSpring,
  useTransform,
} from "motion/react";
import { ChevronDown } from "lucide-react";
import { ShiningText } from "@/components/ShiningText";
import { cn } from "@/lib/utils";

const LINE_PX = 20;
const VISIBLE_LINES_TYPING = 4;
const VISIBLE_LINES_REOPENED = 4;
const MAX_CODE_H_TYPING = LINE_PX * VISIBLE_LINES_TYPING;
const MAX_CODE_H_REOPENED = LINE_PX * VISIBLE_LINES_REOPENED;
const START_HOLD_MS = 500;
const COLLAPSE_HOLD_MS = 500;
const COUNTER_FONT_SIZE = 12;
const COUNTER_HEIGHT = COUNTER_FONT_SIZE + 3;

function lineCountFromSource(src: string): number {
  if (src.length === 0) return 0;
  return src.split("\n").length;
}

function RollingCounter({ value }: { value: number }) {
  const safeValue = Math.max(0, Math.round(value));
  const digits = String(safeValue).split("").map(Number);

  return (
    <span
      className="inline-flex items-center overflow-hidden leading-none tabular-nums"
      style={{ fontSize: COUNTER_FONT_SIZE, height: COUNTER_HEIGHT }}
      aria-label={String(safeValue)}
    >
      {digits.map((_, index) => {
        const place = 10 ** (digits.length - index - 1);
        return (
          <RollingDigit
            key={`${digits.length}-${place}`}
            place={place}
            value={safeValue}
          />
        );
      })}
    </span>
  );
}

function CounterPill({
  sign,
  value,
  className,
}: {
  sign: "+" | "-";
  value: number;
  className: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-[18px] min-w-[30px] shrink-0 items-center gap-[1px] rounded-full px-1 font-mono text-[12px] font-semibold leading-none tabular-nums",
        className,
      )}
    >
      <span className="inline-flex h-full w-[0.65ch] items-center justify-center leading-none">
        {sign}
      </span>
      <RollingCounter value={value} />
    </span>
  );
}

function RollingDigit({ place, value }: { place: number; value: number }) {
  const valueRoundedToPlace = Math.floor(value / place);
  const animatedValue = useSpring(valueRoundedToPlace, {
    stiffness: 180,
    damping: 24,
    mass: 0.45,
  });

  useEffect(() => {
    animatedValue.set(valueRoundedToPlace);
  }, [animatedValue, valueRoundedToPlace]);

  return (
    <span
      className="relative inline-block w-[1ch] overflow-hidden"
      style={{ height: COUNTER_HEIGHT }}
    >
      {Array.from({ length: 10 }, (_, number) => (
        <RollingNumber key={number} mv={animatedValue} number={number} />
      ))}
    </span>
  );
}

function RollingNumber({
  mv,
  number,
}: {
  mv: MotionValue<number>;
  number: number;
}) {
  const y = useTransform(mv, (latest) => {
    const placeValue = latest % 10;
    let offset = (10 + number - placeValue) % 10;
    let nextY = offset * COUNTER_HEIGHT;
    if (offset > 5) nextY -= 10 * COUNTER_HEIGHT;
    return nextY;
  });

  return (
    <motion.span
      style={{ y }}
      className="absolute inset-0 flex items-center justify-center"
    >
      {number}
    </motion.span>
  );
}

/**
 * Cursor-style mini code card.
 *
 * Lifecycle:
 *  - Mounted with `revealed = 0`.
 *  - Reveals 1 char per tick; tiny burst on huge files so the UI stays responsive.
 *  - Once typing finishes AND the segment is complete, holds 2s and auto-collapses to a
 *    single-row header. Fires `onCollapsed` so the parent timeline can advance.
 *  - The header is always clickable. Clicking after auto-collapse re-expands the box
 *    showing up to 4 lines of code with line numbers. Click again to collapse smoothly.
 */
export function VibeMiniCodeBox({
  file,
  added,
  removed,
  code,
  segmentComplete,
  active,
  onCollapsed,
  archived = false,
}: {
  file: string;
  added: number;
  removed: number;
  code: string;
  segmentComplete: boolean;
  active: boolean;
  onCollapsed?: () => void;
  archived?: boolean;
}) {
  const [revealed, setRevealed] = useState(() => (archived ? code.length : 0));
  const [collapsed, setCollapsed] = useState(() => !!archived);
  const [started, setStarted] = useState(() => !!archived);
  const [manuallyOpen, setManuallyOpen] = useState(false);
  const collapsedNotifiedRef = useRef(!!archived);
  const scrollRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (archived) {
      setRevealed(code.length);
      setCollapsed(true);
      setStarted(true);
      collapsedNotifiedRef.current = true;
      return;
    }
    if (!active || collapsed) return;
    if (!started) {
      const id = window.setTimeout(() => setStarted(true), START_HOLD_MS);
      return () => window.clearTimeout(id);
    }
    if (revealed < code.length) {
      const left = code.length - revealed;
      const step =
        left > 8000 ? 260 : left > 3500 ? 150 : left > 1500 ? 82 : 34;
      rafRef.current = window.requestAnimationFrame(() => {
        setRevealed((r) => Math.min(r + step, code.length));
      });
      return () => {
        if (rafRef.current != null) window.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      };
    }
    // Don't stall the timeline if the stream never closes the code fence.
    const hold = segmentComplete ? COLLAPSE_HOLD_MS : Math.min(COLLAPSE_HOLD_MS, 1100);
    const id = window.setTimeout(() => setCollapsed(true), hold);
    return () => window.clearTimeout(id);
  }, [archived, active, collapsed, revealed, code.length, segmentComplete, started]);

  useEffect(() => {
    if (archived) return;
    if (!collapsed || collapsedNotifiedRef.current) return;
    collapsedNotifiedRef.current = true;
    onCollapsed?.();
  }, [archived, collapsed, onCollapsed]);

  useLayoutEffect(() => {
    if (archived) return;
    const el = scrollRef.current;
    if (!el || collapsed || !active) return;
    const overflow = el.scrollHeight - el.clientHeight;
    if (overflow <= 4) return;
    const targetTop = el.scrollHeight - el.clientHeight;
    if (Math.abs(el.scrollTop - targetTop) < 2) return;
    el.scrollTo({ top: targetTop, behavior: "smooth" });
  }, [archived, revealed, collapsed, active]);

  const shown = code.slice(0, revealed);
  const isOpen = !collapsed || manuallyOpen;
  const headerInteractive = collapsed;
  const maxBodyPx = collapsed ? MAX_CODE_H_REOPENED : MAX_CODE_H_TYPING;

  const lines = useMemo(() => {
    if (shown.length === 0) return [] as string[];
    return shown.split("\n");
  }, [shown]);

  const actualAdded = useMemo(() => lineCountFromSource(code), [code]);
  const finalAdded = actualAdded || added;
  const shownLineCount = lineCountFromSource(shown);
  const targetPlus =
    archived || (segmentComplete && revealed >= code.length)
      ? finalAdded
      : Math.min(finalAdded, shownLineCount);
  const finalRemoved = removed === finalAdded && removed > 0 ? 0 : removed;
  const targetMinus =
    archived || (segmentComplete && revealed >= code.length) ? finalRemoved : 0;

  const plusAnimRef = useRef(archived ? finalAdded : 0);
  const minusAnimRef = useRef(archived ? finalRemoved : 0);
  const [displayAdded, setDisplayAdded] = useState(() =>
    archived ? finalAdded : 0,
  );
  const [displayRemoved, setDisplayRemoved] = useState(() =>
    archived ? finalRemoved : 0,
  );

  useEffect(() => {
    if (!archived) return;
    plusAnimRef.current = finalAdded;
    minusAnimRef.current = finalRemoved;
    setDisplayAdded(finalAdded);
    setDisplayRemoved(finalRemoved);
  }, [archived, finalAdded, finalRemoved]);

  useEffect(() => {
    if (archived) return;
    let cancelled = false;
    let raf = 0;
    const tick = () => {
      if (cancelled) return;
      const tgtA = targetPlus;
      const tgtR = targetMinus;
      const curA = plusAnimRef.current;
      const curR = minusAnimRef.current;
      const nextA = curA + (tgtA - curA) * 0.32;
      const nextR = curR + (tgtR - curR) * 0.35;
      plusAnimRef.current = nextA;
      minusAnimRef.current = nextR;
      const rA = Math.round(nextA);
      const rR = Math.round(nextR);
      setDisplayAdded((p) => (p === rA ? p : rA));
      setDisplayRemoved((p) => (p === rR ? p : rR));
      if (Math.abs(tgtA - nextA) > 0.04 || Math.abs(tgtR - nextR) > 0.04) {
        raf = requestAnimationFrame(tick);
      }
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [targetPlus, targetMinus, archived]);

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 12, scale: 0.988 }}
      animate={{ opacity: active || archived ? 1 : 0.76, y: 0, scale: 1 }}
      transition={{ duration: 0.48, ease: [0.16, 1, 0.3, 1] }}
      className="w-full max-w-[640px]"
    >
      <motion.div
        transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
        className={cn(
          "clyra-vibe-agent-card overflow-hidden rounded-xl backdrop-blur-md backdrop-saturate-125",
          active && !collapsed && "ring-1 ring-blue-500/10",
        )}
        style={{ contain: "layout paint" }}
      >
        <div
          role={headerInteractive ? "button" : undefined}
          tabIndex={headerInteractive ? 0 : -1}
          aria-expanded={headerInteractive ? isOpen : undefined}
          onClick={
            headerInteractive ? () => setManuallyOpen((o) => !o) : undefined
          }
          onKeyDown={
            headerInteractive
              ? (e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setManuallyOpen((o) => !o);
                  }
                }
              : undefined
          }
          className={
            "flex items-center justify-between gap-2 bg-white/35 px-3.5 py-2 text-left text-[13px] transition-colors select-none " +
            (headerInteractive
              ? "cursor-pointer hover:bg-slate-50/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-200"
              : "")
          }
        >
          <span className="flex min-w-0 flex-1 items-baseline gap-2 truncate">
            {!collapsed ? (
              <>
                <ShiningText
                  text="Editing"
                  preset="thinkingChat"
                  play
                  className="shrink-0 text-[13px] font-medium"
                />
                <span className="max-w-[180px] truncate text-[13px] font-medium text-blue-600 sm:max-w-[280px]">
                  {file}
                </span>
              </>
            ) : (
              <span className="truncate text-[13px] font-medium text-slate-700">
                {file}
              </span>
            )}
            <CounterPill
              sign="+"
              value={displayAdded}
              className="text-emerald-600"
            />
            <CounterPill
              sign="-"
              value={displayRemoved}
              className="text-rose-500"
            />
          </span>
          {headerInteractive ? (
            <motion.span
              animate={{ rotate: isOpen ? 0 : -90 }}
              transition={{
                type: "spring",
                stiffness: 380,
                damping: 36,
                mass: 0.32,
              }}
              className="shrink-0 text-slate-400"
              aria-hidden
            >
              <ChevronDown className="h-3.5 w-3.5" />
            </motion.span>
          ) : null}
        </div>

        <AnimatePresence initial={false}>
          {isOpen && (
            <motion.div
              key="code"
              initial={{ height: 0, opacity: 0, y: -2 }}
              animate={{ height: "auto", opacity: 1, y: 0 }}
              exit={{ height: 0, opacity: 0, y: -2 }}
              transition={{
                height: { duration: 0.42, ease: [0.22, 1, 0.36, 1] },
                opacity: { duration: 0.24 },
              }}
              className="overflow-hidden border-t border-slate-100/70 bg-white/35"
            >
              <div
                ref={scrollRef}
                className="clyra-visible-scrollbar overflow-x-hidden overflow-y-auto scroll-smooth px-2 pb-2.5 pt-1.5"
                style={{
                  maxHeight: maxBodyPx,
                  scrollBehavior: "smooth",
                  contain: "layout style paint",
                  maskImage:
                    "linear-gradient(to bottom, transparent 0%, #000 10px, #000 calc(100% - 10px), transparent 100%)",
                  WebkitMaskImage:
                    "linear-gradient(to bottom, transparent 0%, #000 10px, #000 calc(100% - 10px), transparent 100%)",
                }}
              >
                {lines.length === 0 ? (
                  <div className="min-h-[20px]" aria-hidden />
                ) : (
                  lines.map((line, i) => (
                    <motion.div
                      key={`line-${i}`}
                      layout="position"
                      initial={{ opacity: 0, y: 5 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
                      className="flex min-h-[20px] gap-2"
                    >
                      <span className="w-8 shrink-0 select-none text-right font-mono text-[10px] tabular-nums leading-[20px] text-slate-400">
                        {i + 1}
                      </span>
                      <span className="min-w-0 flex-1 break-words font-mono text-[12px] leading-[20px] text-slate-700 whitespace-pre-wrap">
                        {line}
                      </span>
                    </motion.div>
                  ))
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </motion.div>
  );
}
