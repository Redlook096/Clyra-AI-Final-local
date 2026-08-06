import { Handle, Position, type NodeProps } from "@xyflow/react";
import { useMemo, useState } from "react";
import { cn } from "../../../lib/utils";
import { BRAIN_ACTIONS, type BrainAction } from "../../../lib/study-brain/types";

export function BrainNodeView({ data, selected }: NodeProps) {
  const processing = Boolean(data.processing);
  const connectedCount = Number(data.connectedCount || 0);
  const onAction = data.onAction as ((action: BrainAction) => void) | undefined;
  const [fanOpen, setFanOpen] = useState(false);

  const fan = useMemo(() => {
    const radius = 118;
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
    <div className="relative flex h-[168px] w-[168px] items-center justify-center">
      <Handle type="target" position={Position.Left} className="!h-2.5 !w-2.5 !border-[#c5ccd6] !bg-white" />
      <Handle type="target" position={Position.Top} id="top" className="!h-2.5 !w-2.5 !border-[#c5ccd6] !bg-white" />
      <Handle type="target" position={Position.Bottom} id="bottom" className="!h-2.5 !w-2.5 !border-[#c5ccd6] !bg-white" />
      <Handle type="source" position={Position.Right} className="!h-2.5 !w-2.5 !border-[#c5ccd6] !bg-white" />

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
              className="absolute z-20 flex h-9 min-w-[88px] -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-[#e7e7e4] bg-white px-3 text-[11px] font-medium text-[#18212f] shadow-[0_8px_24px_rgba(24,33,47,0.08)] transition-transform hover:scale-[1.03]"
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
          "study-brain-node nodrag nopan relative flex h-[124px] w-[124px] flex-col items-center justify-center rounded-full border bg-[#f4f7fb] text-center transition-[box-shadow,transform] duration-200",
          selected ? "border-[#0052fb]/40" : "border-[#d7dee8]",
          processing && "study-brain-node--pulse",
        )}
        onPointerDown={(event) => {
          // Dragging out from the brain opens the action fan (as specified).
          if (event.button !== 0) return;
          const startX = event.clientX;
          const startY = event.clientY;
          const onMove = (move: PointerEvent) => {
            const dist = Math.hypot(move.clientX - startX, move.clientY - startY);
            if (dist > 28) {
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
      >
        <span className="text-[13px] font-semibold tracking-[-0.02em] text-[#18212f]">Study Brain</span>
        <span className="mt-1 text-[10.5px] text-[#8b939e]">
          {connectedCount} source{connectedCount === 1 ? "" : "s"}
        </span>
        <span className="mt-2 text-[10px] font-medium uppercase tracking-[0.1em] text-[#496a95]">
          {processing ? "Working" : fanOpen ? "Choose" : "Drag out"}
        </span>
      </button>
      <div className="study-brain-drag-handle absolute bottom-1 left-1/2 h-1.5 w-8 -translate-x-1/2 cursor-grab rounded-full bg-[#d7dee8] active:cursor-grabbing" title="Drag to move Brain" />
    </div>
  );
}
