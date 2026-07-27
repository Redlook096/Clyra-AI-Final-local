import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { cn } from "../lib/utils";

export type TaskViewPreview = {
  /** A PNG captured from the real Electron surface, never reconstructed UI. */
  src: string;
  width: number;
  height: number;
  nativeLayer?: {
    src: string;
    left: number;
    top: number;
    width: number;
    height: number;
    imageWidth: number;
    imageHeight: number;
  };
};

export type TaskViewTab = {
  id: string;
  label: string;
  icon: ReactNode;
  preview?: TaskViewPreview;
};

type Rect = { left: number; top: number; width: number; height: number };

const EASE = "cubic-bezier(0.22, 1, 0.36, 1)";
const OPEN_MS = 440;
const SELECT_MS = 440;
const EXIT_MS = 210;
const REFLOW_MS = 320;
const GAP = 24;
const PAD_X = 40;
const PAD_Y = 32;
const HEADER_H = 80;
const FOOTER_H = 36;

function columnCount(count: number) {
  if (count <= 1) return 1;
  if (count === 2) return 2;
  if (count <= 4) return 2;
  if (count <= 9) return 3;
  return 4;
}

/**
 * Every card is solved before it enters the DOM. Images then use one uniform
 * contain scale, so the real captured tool never crops or reflows internally.
 */
export function computeTaskViewCards(
  tabs: Array<Pick<TaskViewTab, "preview">>,
  viewportWidth: number,
  viewportHeight: number,
): Rect[] {
  const count = tabs.length;
  if (!count) return [];
  const columns = columnCount(count);
  const rows = Math.ceil(count / columns);
  const contentLeft = PAD_X;
  const contentTop = PAD_Y + HEADER_H;
  const contentWidth = Math.max(280, viewportWidth - PAD_X * 2);
  const contentHeight = Math.max(180, viewportHeight - contentTop - PAD_Y - FOOTER_H);
  const cellWidth = (contentWidth - GAP * (columns - 1)) / columns;
  const cellHeight = Math.max(128, (contentHeight - GAP * (rows - 1)) / rows);

  return tabs.map((tab, index) => {
    const ratio = Math.max(0.25, Math.min(4, (tab.preview?.width || 16) / (tab.preview?.height || 10)));
    const col = index % columns;
    const row = Math.floor(index / columns);
    const availableHeight = Math.max(90, cellHeight - FOOTER_H);
    let width = cellWidth;
    let height = width / ratio;
    if (height > availableHeight) {
      height = availableHeight;
      width = height * ratio;
    }
    if (count === 1) {
      width = Math.min(contentWidth, Math.max(width, Math.min(980, contentWidth)));
      height = width / ratio;
      if (height > availableHeight) {
        height = availableHeight;
        width = height * ratio;
      }
    }
    const cellLeft = contentLeft + col * (cellWidth + GAP);
    const cellTop = contentTop + row * (cellHeight + GAP);
    return {
      left: Math.max(PAD_X, cellLeft + (cellWidth - width) / 2),
      top: Math.max(contentTop, cellTop + (availableHeight - height) / 2),
      width,
      height,
    };
  });
}

function rectOf(sceneRef?: RefObject<HTMLElement | null>): Rect {
  const rect = sceneRef?.current?.getBoundingClientRect();
  if (rect && rect.width > 0 && rect.height > 0) {
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  }
  return { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
}

function transformBetween(from: Rect, to: Rect) {
  return {
    x: from.left - to.left,
    y: from.top - to.top,
    scaleX: from.width / Math.max(1, to.width),
    scaleY: from.height / Math.max(1, to.height),
  };
}

function cardStyle(card: Rect, extra?: CSSProperties): CSSProperties {
  return { left: card.left, top: card.top, width: card.width, height: card.height + FOOTER_H, ...extra };
}

export type TaskViewHandle = {
  closeToActive: () => void;
};

export const WorkspaceTaskView = forwardRef<TaskViewHandle, {
  open: boolean;
  tabs: TaskViewTab[];
  activeId: string;
  sceneRef?: RefObject<HTMLElement | null>;
  onSelect: (id: string) => void;
  onClose: () => void;
  onCloseTab?: (id: string) => void;
}>(function WorkspaceTaskView({
  open,
  tabs,
  activeId,
  sceneRef,
  onSelect,
  onClose,
  onCloseTab,
}, ref) {
  const [cards, setCards] = useState<Rect[]>([]);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [closingId, setClosingId] = useState<string | null>(null);
  const [selectingId, setSelectingId] = useState<string | null>(null);
  const cardNodes = useRef(new Map<string, HTMLDivElement>());
  const previousRects = useRef(new Map<string, DOMRect>());
  const locked = useRef(false);
  const entered = useRef(false);
  const resizeTimer = useRef<number | null>(null);
  const orderedIds = useMemo(() => tabs.map((tab) => tab.id).join("|"), [tabs]);

  const updateLayout = useCallback(() => {
    setCards(computeTaskViewCards(tabs, window.innerWidth, window.innerHeight));
  }, [tabs]);

  const animateReflow = useCallback(() => {
    cardNodes.current.forEach((node, id) => {
      const previous = previousRects.current.get(id);
      const next = node.getBoundingClientRect();
      previousRects.current.set(id, next);
      if (!previous) return;
      const deltaX = previous.left - next.left;
      const deltaY = previous.top - next.top;
      if (Math.abs(deltaX) < 0.5 && Math.abs(deltaY) < 0.5) return;
      node.animate(
        [
          { transform: `translate3d(${deltaX}px, ${deltaY}px, 0)` },
          { transform: "translate3d(0, 0, 0)" },
        ],
        { duration: REFLOW_MS, easing: EASE, fill: "both" },
      ).finished.finally(() => {
        node.style.willChange = "auto";
      });
      node.style.willChange = "transform";
    });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    updateLayout();
  }, [open, orderedIds, updateLayout]);

  useLayoutEffect(() => {
    if (!open || !cards.length) return;
    const frame = requestAnimationFrame(() => {
      if (locked.current) return;
      if (!entered.current) {
        entered.current = true;
        const scene = rectOf(sceneRef);
        tabs.forEach((tab, index) => {
          const node = cardNodes.current.get(tab.id);
          const card = cards[index];
          if (!node || !card) return;
          const from = tab.id === activeId ? transformBetween(scene, card) : null;
          node.style.willChange = "transform, opacity";
          node.animate(
            tab.id === activeId && from
              ? [
                  { transform: `translate3d(${from.x}px, ${from.y}px, 0) scale(${from.scaleX}, ${from.scaleY})`, opacity: 1 },
                  { transform: "translate3d(0, 0, 0) scale(1)", opacity: 1 },
                ]
              : [
                  { transform: "translate3d(0, 10px, 0) scale(.96)", opacity: 0 },
                  { transform: "translate3d(0, 0, 0) scale(1)", opacity: 1 },
                ],
            { duration: tab.id === activeId ? OPEN_MS : OPEN_MS - 40, easing: EASE, fill: "both" },
          ).finished.finally(() => { node.style.willChange = "auto"; });
        });
        return;
      }
      animateReflow();
    });
    return () => cancelAnimationFrame(frame);
  }, [animateReflow, cards, open]);

  useEffect(() => {
    if (!open) entered.current = false;
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onResize = () => {
      if (resizeTimer.current != null) window.clearTimeout(resizeTimer.current);
      resizeTimer.current = window.setTimeout(updateLayout, 100);
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      if (resizeTimer.current != null) window.clearTimeout(resizeTimer.current);
    };
  }, [open, updateLayout]);

  const closeToActive = useCallback(() => {
    if (locked.current) return;
    locked.current = true;
    const activeIndex = tabs.findIndex((tab) => tab.id === activeId);
    const activeCard = activeIndex >= 0 ? cards[activeIndex] : undefined;
    const activePreview = activeIndex >= 0 ? tabs[activeIndex]?.preview : undefined;
    if (!activeCard || !activePreview) {
      onClose();
      locked.current = false;
      return;
    }
    const scene = rectOf(sceneRef);
    const node = cardNodes.current.get(activeId);
    if (!node) {
      onClose();
      locked.current = false;
      return;
    }
    const delta = transformBetween(scene, activeCard);
    node.style.zIndex = "4";
    node.animate(
      [
        { transform: "translate3d(0, 0, 0) scale(1)", opacity: 1 },
        { transform: `translate3d(${delta.x}px, ${delta.y}px, 0) scale(${delta.scaleX}, ${delta.scaleY})`, opacity: 1 },
      ],
      { duration: SELECT_MS, easing: EASE, fill: "both" },
    ).finished.finally(() => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          onClose();
          locked.current = false;
        });
      });
    });
  }, [activeId, cards, onClose, sceneRef, tabs]);

  const selectTab = useCallback((id: string) => {
    if (locked.current || selectingId) return;
    const index = tabs.findIndex((tab) => tab.id === id);
    const card = cards[index];
    const tab = tabs[index];
    const node = cardNodes.current.get(id);
    if (!card || !tab?.preview || !node) {
      onSelect(id);
      return;
    }
    locked.current = true;
    setSelectingId(id);
    cardNodes.current.forEach((other, otherId) => {
      if (otherId === id) return;
      other.animate(
        [{ opacity: 1, transform: "translate3d(0,0,0) scale(1)" }, { opacity: 0, transform: "translate3d(0, 6px, 0) scale(.96)" }],
        { duration: SELECT_MS * 0.7, easing: EASE, fill: "forwards" },
      );
    });
    const scene = rectOf(sceneRef);
    const delta = transformBetween(scene, card);
    node.style.zIndex = "4";
    node.animate(
      [
        { transform: "translate3d(0, 0, 0) scale(1)", opacity: 1 },
        { transform: `translate3d(${delta.x}px, ${delta.y}px, 0) scale(${delta.scaleX}, ${delta.scaleY})`, opacity: 1 },
      ],
      { duration: SELECT_MS, easing: EASE, fill: "both" },
    ).finished.finally(() => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          onSelect(id);
          locked.current = false;
          setSelectingId(null);
        });
      });
    });
  }, [cards, onSelect, sceneRef, selectingId, tabs]);

  const closeTab = useCallback((event: React.MouseEvent, id: string) => {
    event.preventDefault();
    event.stopPropagation();
    if (!onCloseTab || locked.current || tabs.length <= 1) return;
    const node = cardNodes.current.get(id);
    if (!node) {
      onCloseTab(id);
      return;
    }
    locked.current = true;
    setClosingId(id);
    node.animate(
      [
        { opacity: 1, transform: "translate3d(0,0,0) scale(1)" },
        { opacity: 0, transform: "translate3d(0,6px,0) scale(.94)" },
      ],
      { duration: EXIT_MS, easing: EASE, fill: "forwards" },
    ).finished.finally(() => {
      previousRects.current = new Map(
        [...cardNodes.current].filter(([key]) => key !== id).map(([key, value]) => [key, value.getBoundingClientRect()]),
      );
      onCloseTab(id);
      setClosingId(null);
      locked.current = false;
    });
  }, [onCloseTab, tabs.length]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeToActive();
        return;
      }
      if (!tabs.length || locked.current) return;
      const current = focusedId ?? activeId;
      const index = Math.max(0, tabs.findIndex((tab) => tab.id === current));
      if (["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"].includes(event.key)) {
        event.preventDefault();
        const direction = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1;
        setFocusedId(tabs[(index + direction + tabs.length) % tabs.length]!.id);
      } else if (event.key === "Enter") {
        event.preventDefault();
        selectTab(current);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeId, closeToActive, focusedId, open, selectTab, tabs]);

  useImperativeHandle(ref, () => ({ closeToActive }), [closeToActive]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div className="fixed inset-0 z-[1200] overflow-y-auto bg-[#707887]" role="dialog" aria-modal="true" aria-label="Task View">
      <button type="button" className="absolute inset-0 cursor-default" aria-label="Close task view" onClick={closeToActive} />
      <div className="pointer-events-none fixed inset-x-0 top-0 z-10 flex items-end justify-between gap-4 px-8 pb-2 pt-8 sm:px-10">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-white/70">Task View</p>
          <h2 className="mt-1 text-[22px] font-semibold tracking-[-0.03em] text-white">Open tools</h2>
        </div>
        <button type="button" onClick={closeToActive} className="pointer-events-auto rounded-full border border-white/20 bg-white/10 px-3 py-1.5 text-[11px] font-semibold text-white/90 transition-colors hover:bg-white/20">Esc to close</button>
      </div>
      <div className="relative min-h-full" style={{ minHeight: Math.max(window.innerHeight, PAD_Y + HEADER_H + Math.ceil(tabs.length / columnCount(tabs.length)) * 190 + PAD_Y) }}>
        {tabs.map((tab, index) => {
          const card = cards[index];
          if (!card) return null;
          const active = tab.id === activeId;
          const focused = (focusedId ?? activeId) === tab.id;
          return (
            <div
              key={tab.id}
              ref={(node) => {
                if (node) cardNodes.current.set(tab.id, node);
                else cardNodes.current.delete(tab.id);
              }}
              className="absolute origin-top-left"
              style={cardStyle(card, { pointerEvents: selectingId ? "none" : "auto" })}
            >
              <button
                type="button"
                onClick={() => selectTab(tab.id)}
                onFocus={() => setFocusedId(tab.id)}
                aria-label={`Switch to ${tab.label}`}
                aria-current={active ? "true" : undefined}
                className={cn("group absolute inset-x-0 top-0 overflow-hidden rounded-[14px] border bg-slate-900 shadow-[0_18px_50px_rgba(0,0,0,.28)] outline-none transition-[border-color,box-shadow] duration-200", active || focused ? "border-white/90 ring-1 ring-white/25" : "border-white/25 hover:border-white/70")}
                style={{ height: card.height }}
              >
                {tab.preview ? (
                  <span className="relative block h-full w-full">
                    <img src={tab.preview.src} width={tab.preview.width} height={tab.preview.height} draggable={false} className="block h-full w-full object-contain object-center" alt={`${tab.label} preview`} />
                    {tab.preview.nativeLayer ? (
                      <img
                        src={tab.preview.nativeLayer.src}
                        width={tab.preview.nativeLayer.imageWidth}
                        height={tab.preview.nativeLayer.imageHeight}
                        draggable={false}
                        className="absolute object-fill"
                        style={{
                          left: `${(tab.preview.nativeLayer.left / tab.preview.width) * 100}%`,
                          top: `${(tab.preview.nativeLayer.top / tab.preview.height) * 100}%`,
                          width: `${(tab.preview.nativeLayer.width / tab.preview.width) * 100}%`,
                          height: `${(tab.preview.nativeLayer.height / tab.preview.height) * 100}%`,
                        }}
                        alt=""
                      />
                    ) : null}
                  </span>
                ) : (
                  <div className="grid h-full w-full place-items-center bg-slate-800 text-xs font-medium text-white/70">Preparing current tool…</div>
                )}
              </button>
              {onCloseTab && tabs.length > 1 ? <button type="button" aria-label={`Close ${tab.label}`} onClick={(event) => closeTab(event, tab.id)} className={cn("absolute right-2 top-2 grid h-7 w-7 place-items-center rounded-full border border-white/30 bg-slate-950/70 text-white opacity-0 transition-opacity hover:bg-slate-800 focus:opacity-100", focused || closingId === tab.id ? "opacity-100" : "group-hover:opacity-100")}><X className="h-3.5 w-3.5" /></button> : null}
              <div className="absolute bottom-0 left-0 right-0 flex h-[36px] items-center gap-2 px-1 text-white">
                <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-white/15">{tab.icon}</span>
                <span className="min-w-0 flex-1 truncate text-[12px] font-semibold">{tab.label}</span>
                {active ? <span className="text-[9px] font-semibold uppercase tracking-wide text-white/60">Active</span> : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>,
    document.body,
  );
});
