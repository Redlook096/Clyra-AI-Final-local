import {
  AnimatePresence,
  motion,
  useReducedMotion,
} from "framer-motion";
import { type LucideIcon } from "lucide-react";
import { createContext, useContext, useEffect, useState, type MouseEvent, type ReactNode } from "react";
import { cn } from "../../lib/utils";

type DockContextValue = {
  reducedMotion: boolean | null;
};

const DockContext = createContext<DockContextValue | null>(null);

function useDock() {
  const value = useContext(DockContext);
  if (!value) throw new Error("StudyDockItem must be used inside StudyDock");
  return value;
}

/**
 * The dock intentionally preserves a fixed slot for every control. Hovering
 * gives the icon feedback without magnifying or pushing neighbouring tools.
 */
export function StudyDock({ children }: { children: ReactNode }) {
  const reducedMotion = useReducedMotion();

  return (
    <nav
      className="study-dock fixed bottom-0 left-0 top-0 z-40 flex w-[220px] flex-col border-r border-gray-200 bg-gray-50 px-2.5 py-3"
      aria-label="Study Pal navigation"
    >
      <DockContext.Provider value={{ reducedMotion }}>{children}</DockContext.Provider>
    </nav>
  );
}

export function StudyDockGroup({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("flex w-full flex-col items-stretch gap-0.5", className)}>{children}</div>;
}

export function StudyDockSpacer() {
  return <div className="min-h-2 flex-1" aria-hidden="true" />;
}

export function StudyDockSeparator() {
  return <div className="my-2 h-px w-full bg-black/[.06]" aria-hidden="true" />;
}

export function StudyDockItem({
  label,
  icon: Icon,
  active = false,
  onClick,
  shortcut,
  hasPopup = false,
  expanded,
  children,
  accent = false,
}: {
  label: string;
  icon: LucideIcon;
  active?: boolean;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  shortcut?: string;
  hasPopup?: boolean;
  expanded?: boolean;
  children?: ReactNode;
  accent?: boolean;
}) {
  const { reducedMotion } = useDock();
  const [hovered, setHovered] = useState(false);
  const [tooltipVisible, setTooltipVisible] = useState(false);

  useEffect(() => {
    if (!hovered) {
      setTooltipVisible(false);
      return;
    }
    const timer = window.setTimeout(() => setTooltipVisible(true), 340);
    return () => window.clearTimeout(timer);
  }, [hovered]);

  return (
    <div className="relative flex h-[34px] w-full shrink-0 items-center">
      <button
        type="button"
        onClick={onClick}
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
        onFocus={() => { setHovered(true); setTooltipVisible(true); }}
        onBlur={() => { setHovered(false); setTooltipVisible(false); }}
        className={cn(
          "study-dock-item relative flex h-[32px] w-full items-center gap-2 rounded-[8px] px-2 text-left text-[#62646a] outline-none",
          active && "study-dock-item--active text-[#1d1d1f]",
          accent && "study-dock-item--accent text-[color:var(--clyra-accent)]",
        )}
        aria-label={label}
        aria-pressed={hasPopup ? undefined : active}
        aria-haspopup={hasPopup ? "dialog" : undefined}
        aria-expanded={hasPopup ? expanded : undefined}
      >
        <motion.span
          // Keep every dock slot optically fixed. A quiet tint change is more
          // useful here than magnification, which makes the vertical rail feel
          // unsettled while a user scans between study tools.
          animate={reducedMotion ? undefined : { opacity: hovered ? 0.96 : 1 }}
          transition={{ duration: 0.14, ease: [0.22, 1, 0.36, 1] }}
          className="grid h-5 w-5 shrink-0 place-items-center"
        >
          <Icon className="h-[15px] w-[15px]" strokeWidth={1.7} />
        </motion.span>
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">{label}</span>
      </button>
      <AnimatePresence>
        {tooltipVisible ? (
          <motion.span
            initial={{ opacity: 0, x: -5, scale: 0.985 }}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            exit={{ opacity: 0, x: -3, scale: 0.985 }}
            transition={{ type: "spring", stiffness: 560, damping: 40, mass: 0.42 }}
            className="pointer-events-none absolute left-[calc(100%+9px)] z-50 hidden h-7 items-center gap-3 whitespace-nowrap rounded-[8px] border border-[#e5e7eb] bg-white px-2.5 text-[11px] font-medium text-[#4b5563] shadow-[0_6px_18px_rgba(15,23,42,.10)]"
            role="tooltip"
          >
            {label}{shortcut ? <span className="text-[#9aa1aa]">{shortcut}</span> : null}
          </motion.span>
        ) : null}
      </AnimatePresence>
      {children}
    </div>
  );
}
