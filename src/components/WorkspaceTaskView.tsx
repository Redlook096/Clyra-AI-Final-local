import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { X } from "lucide-react";
import { cn } from "../lib/utils";

export type TaskViewTab = {
  id: string;
  label: string;
  icon: ReactNode;
  preview: ReactNode;
};

function gridClass(count: number) {
  if (count <= 1) return "grid-cols-1 max-w-[720px]";
  if (count === 2) return "grid-cols-1 sm:grid-cols-2 max-w-[980px]";
  if (count <= 4) return "grid-cols-1 sm:grid-cols-2 max-w-[1080px]";
  if (count <= 6) return "grid-cols-2 lg:grid-cols-3 max-w-[1180px]";
  return "grid-cols-2 md:grid-cols-3 xl:grid-cols-4 max-w-[1280px]";
}

export function WorkspaceTaskView({
  open,
  tabs,
  activeId,
  onSelect,
  onClose,
  onCloseTab,
}: {
  open: boolean;
  tabs: TaskViewTab[];
  activeId: string;
  onSelect: (id: string) => void;
  onClose: () => void;
  onCloseTab?: (id: string) => void;
}) {
  const [zoomingId, setZoomingId] = useState<string | null>(null);
  const cardRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  useEffect(() => {
    if (!open) setZoomingId(null);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const ordered = useMemo(() => {
    const active = tabs.find((tab) => tab.id === activeId);
    const rest = tabs.filter((tab) => tab.id !== activeId);
    return active ? [active, ...rest] : tabs;
  }, [activeId, tabs]);

  const selectTab = (id: string) => {
    setZoomingId(id);
    window.setTimeout(() => onSelect(id), 280);
  };

  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          key="task-view"
          className="fixed inset-0 z-[1200] flex flex-col"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
        >
          <motion.button
            type="button"
            aria-label="Close task view"
            className="absolute inset-0 bg-slate-900/35 backdrop-blur-[14px]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
          />

          <div className="relative z-10 flex min-h-0 flex-1 flex-col px-6 pb-8 pt-10 sm:px-10">
            <div className="mb-6 flex shrink-0 items-end justify-between gap-4">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-white/70">Task View</p>
                <h2 className="mt-1 text-[22px] font-semibold tracking-[-0.03em] text-white">Open tools</h2>
              </div>
              <button
                type="button"
                onClick={onClose}
                className="rounded-full border border-white/20 bg-white/10 px-3 py-1.5 text-[11px] font-semibold text-white/90 backdrop-blur-md transition-colors hover:bg-white/20"
              >
                Esc to close
              </button>
            </div>

            <div className={cn("mx-auto grid w-full flex-1 content-center gap-6", gridClass(ordered.length))}>
              {ordered.map((tab, index) => {
                const active = tab.id === activeId;
                const zooming = zoomingId === tab.id;
                return (
                  <motion.div
                    key={tab.id}
                    layout
                    initial={{ opacity: 0, y: 18, scale: 0.94 }}
                    animate={{
                      opacity: zoomingId && !zooming ? 0.35 : 1,
                      y: 0,
                      scale: zooming ? 1.06 : 1,
                      zIndex: zooming ? 20 : 1,
                    }}
                    exit={{ opacity: 0, scale: 0.92 }}
                    transition={{
                      duration: zooming ? 0.32 : 0.28,
                      delay: zooming ? 0 : Math.min(index * 0.035, 0.18),
                      ease: [0.16, 1, 0.3, 1],
                    }}
                    className="group relative flex min-h-0 flex-col"
                  >
                    <button
                      type="button"
                      ref={(node) => {
                        cardRefs.current[tab.id] = node;
                      }}
                      onClick={() => selectTab(tab.id)}
                      className={cn(
                        "relative aspect-[16/10] w-full overflow-hidden rounded-[14px] border bg-white text-left shadow-[0_18px_50px_rgba(15,23,42,.22)] transition-[transform,box-shadow,border-color] duration-200",
                        active ? "border-white/80 ring-2 ring-white/50" : "border-white/25",
                        "hover:-translate-y-1 hover:border-white/70 hover:shadow-[0_24px_60px_rgba(15,23,42,.28)]",
                        zooming && "border-white shadow-[0_30px_80px_rgba(15,23,42,.35)]",
                      )}
                    >
                      <div className="pointer-events-none absolute inset-0 overflow-hidden bg-[#f7f8fa]">
                        <div className="absolute left-0 top-0 origin-top-left scale-[0.34] sm:scale-[0.38]" style={{ width: "263%", height: "263%" }}>
                          {tab.preview}
                        </div>
                        <div className="absolute inset-0 bg-gradient-to-t from-slate-950/10 via-transparent to-transparent" />
                      </div>
                      {onCloseTab && ordered.length > 1 ? (
                        <span
                          role="button"
                          tabIndex={0}
                          aria-label={`Close ${tab.label}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            onCloseTab(tab.id);
                          }}
                          onKeyDown={(event) => {
                            if (event.key === "Enter" || event.key === " ") {
                              event.preventDefault();
                              event.stopPropagation();
                              onCloseTab(tab.id);
                            }
                          }}
                          className="absolute right-2.5 top-2.5 grid h-7 w-7 place-items-center rounded-full border border-slate-200/80 bg-white/90 text-slate-500 opacity-0 shadow-sm transition-opacity group-hover:opacity-100"
                        >
                          <X className="h-3.5 w-3.5" />
                        </span>
                      ) : null}
                    </button>
                    <div className="mt-2.5 flex items-center gap-2 px-0.5">
                      <span className="grid h-6 w-6 place-items-center rounded-md bg-white/15 text-white">{tab.icon}</span>
                      <span className="truncate text-[12px] font-semibold text-white/95">{tab.label}</span>
                      {active ? <span className="ml-auto text-[9px] font-semibold uppercase tracking-wide text-white/60">Active</span> : null}
                    </div>
                  </motion.div>
                );
              })}
            </div>
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
