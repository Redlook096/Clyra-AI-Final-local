import { Handle, Position, type NodeProps } from "@xyflow/react";
import { cn } from "../../../lib/utils";

const SIDE_HANDLES: Array<{ id: string; position: Position }> = [
  { id: "left", position: Position.Left },
  { id: "right", position: Position.Right },
  { id: "top", position: Position.Top },
  { id: "bottom", position: Position.Bottom },
];

/**
 * Central Study Brain node — project name only.
 * Four side dots for dragging connections. Study actions live in Materials / Chat tabs.
 */
export function BrainNodeView({ data, selected }: NodeProps) {
  const title = String(data.title || "Untitled").trim() || "Untitled";
  const processing = Boolean(data.processing);
  const connectedCount = Number(data.connectedCount || 0);

  return (
    <div className="relative z-30 flex h-[118px] w-[248px] items-center justify-center">
      {SIDE_HANDLES.map((side) => (
        <Handle
          key={`brain-${side.id}`}
          id={side.id}
          type="source"
          position={side.position}
          className="study-brain-handle !h-2 !w-2 !border !border-white !bg-[color:var(--clyra-accent)]"
        />
      ))}

      <div
        className={cn(
          "study-brain-node relative flex h-[90px] w-[228px] flex-col items-start justify-center overflow-hidden rounded-[13px] border bg-white px-4 text-left transition-[box-shadow,border-color,transform] duration-150",
          selected
            ? "border-[color:var(--clyra-accent)]/45 shadow-[0_0_0_2px_rgba(10,111,242,0.09),0_8px_22px_rgba(15,23,42,0.06)]"
            : "border-[color:var(--clyra-border)]",
          processing && "study-brain-node--pulse",
        )}
        aria-label={`${title} study space`}
      >
        <span className={cn("pointer-events-none absolute inset-x-0 top-0 h-px bg-[color:var(--clyra-border)]", selected && "bg-[color:var(--clyra-accent)]")} aria-hidden />
        <span className="max-w-full truncate text-[15px] font-semibold tracking-[-0.025em] text-[color:var(--clyra-text)]">
          {title}
        </span>
        <span className="mt-1 text-[11.5px] text-[color:var(--clyra-text-tertiary)]">
          {processing
            ? "Working…"
            : `${connectedCount} resource${connectedCount === 1 ? "" : "s"}`}
        </span>
      </div>
      <div
        className="study-brain-drag-handle absolute -bottom-0.5 left-1/2 h-1 w-7 -translate-x-1/2 cursor-grab rounded-full bg-[color:var(--clyra-border-strong)]/70 active:cursor-grabbing"
        title="Drag to move"
      />
    </div>
  );
}
