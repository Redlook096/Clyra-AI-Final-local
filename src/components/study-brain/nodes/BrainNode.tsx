import { Handle, Position, type NodeProps } from "@xyflow/react";
import { useMemo, useRef, useState } from "react";
import { cn } from "../../../lib/utils";
import { BRAIN_ACTIONS, type BrainAction } from "../../../lib/study-brain/types";

const SIDE_HANDLES: Array<{ id: string; position: Position }> = [
  { id: "left", position: Position.Left },
  { id: "right", position: Position.Right },
  { id: "top", position: Position.Top },
  { id: "bottom", position: Position.Bottom },
];

/**
 * Central Study Brain node — shows the study space / project name.
 * Four side dots let the user drag connections; click / drag-out opens the action fan.
 */
export function BrainNodeView({ data, selected }: NodeProps) {
  const title = String(data.title || "Untitled").trim() || "Untitled";
  const processing = Boolean(data.processing);
  const connectedCount = Number(data.connectedCount || 0);
  const onAction = data.onAction as ((action: BrainAction) => void) | undefined;
  const [fanOpen, setFanOpen] = useState(false);
  const openedByDrag = useRef(false);

  const fan = useMemo(() => {
    const radius = 112;
    return BRAIN_ACTIONS.map((action, index) => {
      const angle = (-90 + (index * 360) / BRAIN_ACTIONS.length) * (Math.PI / 180);
      return {
        ...action,
        x: Math.cos(angle) * radius,
        y: Math.sin(angle) * radius,
      };
    });
  }, []);

  return (
    <div className="relative z-30 flex h-[128px] w-[252px] items-center justify-center">
      {SIDE_HANDLES.map((side) => (
        <Handle
          key={`brain-${side.id}`}
          id={side.id}
          type="source"
          position={side.position}
          className="study-brain-handle !h-2.5 !w-2.5 !border-[1.5px] !border-white !bg-[color:var(--clyra-accent)] !shadow-[0_0_0_1px_rgba(0,82,251,0.18)]"
        />
      ))}

      {fanOpen
        ? fan.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                setFanOpen(false);
                onAction?.(item.id);
              }}
              className="absolute z-[70] flex h-8 min-w-[88px] -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-[10px] border border-[color:var(--clyra-border)] bg-white/95 px-2.5 text-[11.5px] font-medium text-[color:var(--clyra-text)] shadow-[0_8px_24px_rgba(15,23,42,0.1)] backdrop-blur-sm transition-colors hover:bg-[color:var(--clyra-hover)]"
              style={{ left: `calc(50% + ${item.x}px)`, top: `calc(50% + ${item.y}px)` }}
              title={item.hint}
            >
              {item.label}
            </button>
          ))
        : null}

      <button
        type="button"
        className={cn(
          "study-brain-node nodrag nopan relative flex h-[76px] w-[220px] flex-col items-start justify-center overflow-hidden rounded-[14px] border bg-white px-4 text-left transition-[box-shadow,border-color,transform] duration-150",
          selected
            ? "border-[color:var(--clyra-accent)]/40 shadow-[0_0_0_3px_rgba(0,82,251,0.09),0_10px_28px_rgba(15,23,42,0.08)]"
            : "border-[color:var(--clyra-border)]",
          processing && "study-brain-node--pulse",
        )}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          openedByDrag.current = false;
          const startX = event.clientX;
          const startY = event.clientY;
          const onMove = (move: PointerEvent) => {
            const dist = Math.hypot(move.clientX - startX, move.clientY - startY);
            if (dist > 24) {
              openedByDrag.current = true;
              setFanOpen(true);
              window.removeEventListener("pointermove", onMove);
            }
          };
          const onUp = () => {
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
          };
          window.addEventListener("pointermove", onMove);
          window.addEventListener("pointerup", onUp);
        }}
        onClick={() => {
          if (openedByDrag.current) {
            openedByDrag.current = false;
            return;
          }
          setFanOpen((open) => !open);
        }}
        aria-label={`${title} study space`}
      >
        <span
          className="pointer-events-none absolute inset-x-0 top-0 h-[3px] bg-gradient-to-r from-[color:var(--clyra-accent)] via-[#4f8cff] to-[color:var(--clyra-accent)]/40"
          aria-hidden
        />
        <span className="max-w-full truncate text-[14.5px] font-semibold tracking-[-0.025em] text-[color:var(--clyra-text)]">
          {title}
        </span>
        <span className="mt-1 text-[11.5px] text-[color:var(--clyra-text-tertiary)]">
          {processing
            ? "Working…"
            : `${connectedCount} resource${connectedCount === 1 ? "" : "s"}`}
        </span>
      </button>
      <div
        className="study-brain-drag-handle absolute -bottom-1 left-1/2 h-1.5 w-8 -translate-x-1/2 cursor-grab rounded-full bg-[color:var(--clyra-border-strong)]/70 active:cursor-grabbing"
        title="Drag to move"
      />
    </div>
  );
}
