import {
  ArrowUpRight,
  Clapperboard,
  Clock3,
  Code2,
  Globe2,
  GraduationCap,
  Grid2X2,
  Heart,
  MessageCircle,
  MessagesSquare,
} from "lucide-react";
import { AnimatePresence, motion, useMotionValue, useReducedMotion, useSpring } from "motion/react";
import { type PointerEvent, useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { AiOrb, type OrbColorTheme } from "./AiOrb";

export type LauncherToolId =
  | "chat"
  | "vibe"
  | "clip"
  | "browser"
  | "study"
  | "would-rather"
  | "fake-text";

interface AppLauncherProps {
  orbColorTheme?: OrbColorTheme;
  onOpenTool: (tool: LauncherToolId) => void;
  onClose: () => void;
}

interface LauncherTool {
  id: LauncherToolId;
  label: string;
  shortLabel: string;
  detail: string;
  icon: ComponentType<{ className?: string }>;
  accent: string;
}

const tools: LauncherTool[] = [
  { id: "vibe", label: "Vibe Coder", shortLabel: "Vibe Coder", detail: "Build and preview production applications", icon: Code2, accent: "#4f46e5" },
  { id: "chat", label: "Chat", shortLabel: "Chat", detail: "Think, write and reason with Clyra", icon: MessageCircle, accent: "#2563eb" },
  { id: "clip", label: "AI Clipper", shortLabel: "Clip", detail: "Turn long videos into polished social clips", icon: Clapperboard, accent: "#e11d48" },
  { id: "fake-text", label: "Message Story", shortLabel: "Text Story", detail: "Create narrated iMessage story videos", icon: MessagesSquare, accent: "#0891b2" },
  { id: "study", label: "Study Pal", shortLabel: "Study Pal", detail: "Research, connect evidence, and learn on a visual canvas", icon: GraduationCap, accent: "#0f766e" },
  { id: "would-rather", label: "Would You Rather", shortLabel: "Would You Rather", detail: "Make narrated choice and poll videos", icon: Heart, accent: "#c026d3" },
  { id: "browser", label: "AI Browser", shortLabel: "Browser", detail: "Research and act across live websites", icon: Globe2, accent: "#059669" },
];

const CENTER = 320;
const OUTER_RADIUS = 294;
const INNER_RADIUS = 124;
const SLICE_ANGLE = 360 / tools.length;
const barActions = ["resume", "open", "chat"] as const;
type BarAction = (typeof barActions)[number];

function point(radius: number, degrees: number) {
  const radians = (degrees - 90) * Math.PI / 180;
  return [CENTER + radius * Math.cos(radians), CENTER + radius * Math.sin(radians)];
}

function normalizeDegrees(degrees: number) {
  return ((degrees % 360) + 360) % 360;
}

function closestRotation(current: number, target: number) {
  const normalized = normalizeDegrees(current);
  let delta = target - normalized;
  if (delta > 180) delta -= 360;
  if (delta < -180) delta += 360;
  return current + delta;
}

function wedgePath(start: number, end: number) {
  const [outerStartX, outerStartY] = point(OUTER_RADIUS, start);
  const [outerEndX, outerEndY] = point(OUTER_RADIUS, end);
  const [innerEndX, innerEndY] = point(INNER_RADIUS, end);
  const [innerStartX, innerStartY] = point(INNER_RADIUS, start);
  const largeArc = end - start > 180 ? 1 : 0;
  return [
    `M ${outerStartX} ${outerStartY}`,
    `A ${OUTER_RADIUS} ${OUTER_RADIUS} 0 ${largeArc} 1 ${outerEndX} ${outerEndY}`,
    `L ${innerEndX} ${innerEndY}`,
    `A ${INNER_RADIUS} ${INNER_RADIUS} 0 ${largeArc} 0 ${innerStartX} ${innerStartY}`,
    "Z",
  ].join(" ");
}

function readLastTool(): LauncherToolId {
  const stored = localStorage.getItem("clyra-launcher-last-tool") as LauncherToolId | null;
  return tools.some((tool) => tool.id === stored) ? stored! : "chat";
}

export function AppLauncher({ orbColorTheme = "default", onOpenTool, onClose }: AppLauncherProps) {
  const reduceMotion = useReducedMotion();
  const initialToolIndex = Math.max(0, tools.findIndex((tool) => tool.id === readLastTool()));
  const [activeIndex, setActiveIndex] = useState(initialToolIndex);
  const highlightTarget = useMotionValue(initialToolIndex * SLICE_ANGLE);
  const highlightRotation = useSpring(highlightTarget, {
    stiffness: 2600,
    damping: 58,
    mass: 0.035,
  });
  const [hoveredBarAction, setHoveredBarAction] = useState<BarAction | null>(null);
  const pointerFrame = useRef<number | null>(null);
  const pendingPointer = useRef<{ x: number; y: number; width: number; height: number } | null>(null);
  const activeTool = tools[activeIndex];
  const quickTool = tools.find((tool) => tool.id === (activeTool.id === "chat" ? "browser" : "chat"))!;
  const QuickToolIcon = quickTool.icon;
  const highlightPath = useMemo(() => wedgePath(-SLICE_ANGLE / 2, SLICE_ANGLE / 2), []);

  const selectTool = useCallback((index: number, rotation = index * SLICE_ANGLE) => {
    setActiveIndex(index);
    highlightTarget.set(closestRotation(highlightTarget.get(), rotation));
  }, [highlightTarget]);

  const followPointer = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    pendingPointer.current = {
      x: event.clientX - rect.left - rect.width / 2,
      y: event.clientY - rect.top - rect.height / 2,
      width: rect.width,
      height: rect.height,
    };
    if (pointerFrame.current != null) return;
    pointerFrame.current = window.requestAnimationFrame(() => {
      pointerFrame.current = null;
      const next = pendingPointer.current;
      if (!next) return;
      const distance = Math.hypot(next.x, next.y);
      if (distance < next.width * 0.18) return;
      const angle = normalizeDegrees(Math.atan2(next.y, next.x) * 180 / Math.PI + 90);
      const index = Math.floor(normalizeDegrees(angle + SLICE_ANGLE / 2) / SLICE_ANGLE) % tools.length;
      selectTool(index, angle);
    });
  };

  const openTool = (tool: LauncherTool) => {
    localStorage.setItem("clyra-launcher-last-tool", tool.id);
    onOpenTool(tool.id);
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      if (pointerFrame.current != null) window.cancelAnimationFrame(pointerFrame.current);
    };
  }, [onClose]);

  return (
    <motion.div
      className="fixed inset-0 z-[260] overflow-hidden bg-[rgba(248,250,252,0.96)] text-slate-950"
      initial={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.992 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 1.008 }}
      transition={{ duration: reduceMotion ? 0 : 0.15, ease: [0.22, 1, 0.36, 1] }}
      role="dialog"
      aria-modal="true"
      aria-label="Clyra app launcher"
      onClick={onClose}
    >
      <div className="pointer-events-none absolute inset-0 opacity-40 [background-image:linear-gradient(rgba(15,23,42,.02)_1px,transparent_1px),linear-gradient(90deg,rgba(15,23,42,.02)_1px,transparent_1px)] [background-size:44px_44px]" />
      <div
        className="relative z-10 mx-auto flex h-dvh max-w-[1120px] flex-col items-center px-4 pb-5 pt-7 sm:pt-8"
        onClick={(event) => event.stopPropagation()}
      >
        <motion.header initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: reduceMotion ? 0 : 0.02, duration: 0.16, ease: [0.22, 1, 0.36, 1] }} className="shrink-0 text-center">
          <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-slate-400">Clyra workspace</p>
          <h1 className="mt-2 text-[30px] font-semibold leading-none text-slate-950 sm:text-[40px]">Launch your tools</h1>
          <p className="mt-2 text-[12px] text-slate-500 sm:text-[13px]">Smart AI tools to build, create and solve, all in one place.</p>
        </motion.header>

        <div className="relative flex min-h-0 flex-1 items-center justify-center">
          <motion.div
            className="relative aspect-square w-[min(70vh,690px,94vw)]"
            onPointerMove={followPointer}
            initial={{ opacity: 0, scale: 0.78, rotate: -4 }}
            animate={{ opacity: 1, scale: 1, rotate: 0 }}
            exit={{ opacity: 0, scale: 0.88, rotate: 3 }}
            transition={reduceMotion ? { duration: 0 } : { type: "spring", stiffness: 620, damping: 36, mass: 0.34 }}
          >
            <svg viewBox="0 0 640 640" className="absolute inset-0 h-full w-full overflow-visible drop-shadow-[0_28px_70px_rgba(15,23,42,0.10)]" aria-hidden="true">
              <circle cx="320" cy="320" r="302" fill="rgba(255,255,255,.72)" stroke="rgba(148,163,184,.22)" />
              <circle cx="320" cy="320" r={OUTER_RADIUS} fill="rgba(255,255,255,.34)" />
              {tools.map((tool, index) => {
                const start = index * SLICE_ANGLE - SLICE_ANGLE / 2;
                const end = (index + 1) * SLICE_ANGLE - SLICE_ANGLE / 2;
                return (
                  <path
                    key={tool.id}
                    d={wedgePath(start, end)}
                    fill="rgba(255,255,255,.001)"
                    stroke="transparent"
                    strokeWidth="0"
                    onClick={() => openTool(tool)}
                    className="cursor-pointer"
                  />
                );
              })}
              <motion.g
                initial={false}
                style={{ transformBox: "view-box", transformOrigin: "center", pointerEvents: "none", rotate: reduceMotion ? highlightTarget : highlightRotation }}
              >
                <path
                  d={highlightPath}
                  fill="rgba(226,232,240,.62)"
                  stroke="#cbd5e1"
                  strokeWidth="1.25"
                />
              </motion.g>
              <circle cx="320" cy="320" r="124" fill="rgba(255,255,255,.84)" stroke="rgba(148,163,184,.24)" />
            </svg>

            {tools.map((tool, index) => {
              const Icon = tool.icon;
              const angle = index * SLICE_ANGLE;
              const [x, y] = point(212, angle);
              const selected = index === activeIndex;
              return (
                <motion.button
                  key={tool.id}
                  type="button"
                  onFocus={() => selectTool(index)}
                  onClick={() => openTool(tool)}
                  initial={reduceMotion ? false : { opacity: 0, scale: 0.7, y: 4 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.8, y: 2 }}
                  transition={reduceMotion ? { duration: 0 } : { delay: 0.02 + index * 0.006, type: "spring", stiffness: 880, damping: 40, mass: 0.28 }}
                  className="absolute z-10 flex w-[116px] -translate-x-1/2 -translate-y-1/2 flex-col items-center text-center outline-none"
                  style={{ left: `${x / 6.4}%`, top: `${y / 6.4}%` }}
                  aria-label={`Open ${tool.label}`}
                >
                  <span className={selected ? "relative grid h-10 w-10 place-items-center rounded-full bg-white text-slate-950 shadow-[0_0_0_1px_rgba(79,70,229,.12),0_8px_22px_rgba(79,70,229,.14)]" : "relative grid h-10 w-10 place-items-center text-[#52617b]"}>
                    <Icon className={selected ? "h-7 w-7 stroke-[2.05] text-slate-900" : "h-7 w-7 stroke-[1.65]"} />
                  </span>
                  <span className={selected ? "mt-1.5 text-[11px] font-bold leading-tight text-slate-950 sm:text-[12px]" : "mt-1.5 text-[11px] font-semibold leading-tight text-slate-800 sm:text-[12px]"}>{tool.shortLabel}</span>
                </motion.button>
              );
            })}

            <div className="clyra-launcher-orb absolute left-1/2 top-1/2 z-20 grid h-[24%] w-[24%] -translate-x-1/2 -translate-y-1/2 place-items-center">
              <motion.div
                initial={{ scale: 0.92, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.95, opacity: 0 }}
                transition={{ delay: reduceMotion ? 0 : 0.01, type: "spring", stiffness: 760, damping: 40, mass: 0.24 }}
                className="scale-[0.92]"
              >
                <AiOrb colorTheme={orbColorTheme} introActive={false} />
              </motion.div>
            </div>
          </motion.div>
        </div>

        <motion.div
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: reduceMotion ? 0 : 0.08, duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
          className="mb-3 flex shrink-0 items-center justify-center px-2 py-1 text-[10px] font-medium text-slate-400"
        >
          Press <kbd className="mx-1 rounded-md border border-slate-200 bg-white/80 px-1.5 py-0.5 text-[9px] text-slate-600 shadow-[inset_0_1px_0_rgba(255,255,255,.9)]">Ctrl/⌘K</kbd> to close
        </motion.div>

        <motion.nav
          initial={{ opacity: 0, y: 8, scaleX: 0.86 }}
          animate={{ opacity: 1, y: 0, scaleX: 1 }}
          exit={{ opacity: 0, y: 6, scaleX: 0.92 }}
          transition={reduceMotion ? { duration: 0 } : { delay: 0.03, type: "spring", stiffness: 720, damping: 40, mass: 0.3 }}
          onPointerMove={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            const index = Math.max(0, Math.min(barActions.length - 1, Math.floor(((event.clientX - rect.left) / rect.width) * barActions.length)));
            setHoveredBarAction(barActions[index]);
          }}
          onPointerLeave={() => setHoveredBarAction(null)}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setHoveredBarAction(null);
          }}
          className="relative grid w-full max-w-[650px] shrink-0 grid-cols-3 items-center overflow-hidden rounded-full border border-slate-200 bg-white/82 p-1.5 shadow-[0_18px_50px_rgba(15,23,42,.10)] backdrop-blur-xl"
        >
          <AnimatePresence>
            {hoveredBarAction ? (
              <motion.div
                className="clyra-workflow-tab__hover pointer-events-none absolute bottom-1.5 top-1.5 rounded-full"
                initial={{ opacity: 0, scale: 0.85 }}
                animate={{ opacity: 1, scale: 1, x: `calc(${barActions.indexOf(hoveredBarAction)} * 100%)` }}
                exit={{ opacity: 0, scale: 0.95, transition: { duration: 0.12 } }}
                transition={reduceMotion ? { duration: 0 } : { type: "spring", stiffness: 980, damping: 54, mass: 0.09 }}
                style={{ left: 6, top: 6, bottom: 6, height: "auto", width: "calc((100% - 12px) / 3)", zIndex: 0, translate: "none" }}
              />
            ) : null}
          </AnimatePresence>
          <button type="button" onMouseEnter={() => setHoveredBarAction("resume")} onFocus={() => setHoveredBarAction("resume")} onClick={() => openTool(tools.find((tool) => tool.id === readLastTool()) || tools[0])} className="relative z-10 flex h-11 items-center justify-center gap-2 rounded-full text-[10px] font-semibold text-slate-500 transition-[color,transform] duration-200 hover:text-slate-950 active:scale-[.98]"><Clock3 className="h-4 w-4" />Resume</button>
          <button type="button" onMouseEnter={() => setHoveredBarAction("open")} onFocus={() => setHoveredBarAction("open")} onClick={() => openTool(activeTool)} className="relative z-10 flex h-11 items-center justify-center gap-2 rounded-full text-[10px] font-semibold text-slate-600 transition-[color,transform] duration-200 hover:text-slate-950 active:scale-[.98]"><Grid2X2 className="h-4 w-4" />Open {activeTool.shortLabel}<ArrowUpRight className="h-3.5 w-3.5" /></button>
          <button type="button" onMouseEnter={() => setHoveredBarAction("chat")} onFocus={() => setHoveredBarAction("chat")} onClick={() => openTool(quickTool)} className="relative z-10 flex h-11 items-center justify-center gap-2 rounded-full text-[10px] font-semibold text-slate-500 transition-[color,transform] duration-200 hover:text-slate-950 active:scale-[.98]"><QuickToolIcon className="h-4 w-4" />Open {quickTool.shortLabel}</button>
        </motion.nav>
      </div>
    </motion.div>
  );
}
