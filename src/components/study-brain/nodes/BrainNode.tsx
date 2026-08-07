import { Handle, Position, type NodeProps } from "@xyflow/react";
import { useMemo, useState } from "react";
import { cn } from "../../../lib/utils";
import { BRAIN_ACTIONS, type BrainAction } from "../../../lib/study-brain/types";

/**
 * Central Study Brain node — shows the study space / project name.
 * Click or drag-out opens a compact action fan (notes, quiz, etc.).
 */
export function BrainNodeView({ data, selected }: NodeProps) {
  const title = String(data.title || "Untitled").trim() || "Untitled";
  const processing = Boolean(data.processing);
  const connectedCount = Number(data.connectedCount || 0);
  const onAction = data.onAction as ((action: BrainAction) => void) | undefined;
  const [fanOpen, setFanOpen] = useState(false);

  const fan = useMemo(() => {
    const radius = 108;
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
    <div className="relative flex h-[120px] w-[240px] items-center justify-center">
      <Handle
        type="target"
        position={Position.Left}
        className="!h-2 !w-2 !border-[color:var(--clyra-border)] !bg-white"
      />
      <Handle
        type="target"
        position={Position.Top}
        id="top"
        className="!h-2 !w-2 !border-[color:var(--clyra-border)] !bg-white"
      />
      <Handle
        type="target"
        position={Position.Bottom}
        id="bottom"
        className="!h-2 !w-2 !border-[color:var(--clyra-border)] !bg-white"
      />
      <Handle
        type="source"
        position={Position.Right}
        className="!h-2 !w-2 !border-[color:var(--clyra-border)] !bg-white"
      />

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
              className="absolute z-20 flex h-8 min-w-[84px] -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-[8px] border border-[color:var(--clyra-border)] bg-white px-2.5 text-[11.5px] font-medium text-[color:var(--clyra-text)] shadow-[0_6px_18px_rgba(15,23,42,0.08)] transition-colors hover:bg-[color:var(--clyra-hover)]"
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
          "study-brain-node nodrag nopan relative flex h-[72px] w-[214px] flex-col items-start justify-center rounded-[12px] border bg-white px-4 text-left transition-[box-shadow,border-color] duration-150",
          selected
            ? "border-[color:var(--clyra-accent)]/35 shadow-[0_0_0_3px_rgba(0,82,251,0.08)]"
            : "border-[color:var(--clyra-border)]",
          processing && "study-brain-node--pulse",
        )}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          const startX = event.clientX;
          const startY = event.clientY;
          const onMove = (move: PointerEvent) => {
            const dist = Math.hypot(move.clientX - startX, move.clientY - startY);
            if (dist > 24) {
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
        onClick={() => setFanOpen((open) => !open)}
        aria-label={`${title} study space`}
      >
        <span className="mb-1.5 h-[2px] w-7 rounded-full bg-[color:var(--clyra-accent)]" aria-hidden />
        <span className="max-w-full truncate text-[14px] font-medium tracking-[-0.02em] text-[color:var(--clyra-text)]">
          {title}
        </span>
        <span className="mt-0.5 text-[11.5px] text-[color:var(--clyra-text-tertiary)]">
          {processing
            ? "Working…"
            : `${connectedCount} resource${connectedCount === 1 ? "" : "s"}`}
        </span>
      </button>
      <div
        className="study-brain-drag-handle absolute -bottom-1 left-1/2 h-1 w-7 -translate-x-1/2 cursor-grab rounded-full bg-[color:var(--clyra-border)] active:cursor-grabbing"
        title="Drag to move"
      />
    </div>
  );
}
