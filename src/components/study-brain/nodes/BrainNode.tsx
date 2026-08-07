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
    <div className="relative z-30 flex h-[132px] w-[260px] items-center justify-center">
      {SIDE_HANDLES.map((side) => (
        <Handle
          key={`brain-${side.id}`}
          id={side.id}
          type="source"
          position={side.position}
          className="study-brain-handle !h-2.5 !w-2.5 !border-[1.5px] !border-white !bg-[color:var(--clyra-accent)] !shadow-[0_0_0_1.5px_rgba(0,82,251,0.2)]"
        />
      ))}

      <div
        className={cn(
          "study-brain-node relative flex h-[80px] w-[228px] flex-col items-start justify-center overflow-hidden rounded-[16px] border bg-white px-4 text-left transition-[box-shadow,border-color] duration-150",
          selected
            ? "border-[color:var(--clyra-accent)]/40 shadow-[0_0_0_3px_rgba(0,82,251,0.1),0_12px_32px_rgba(15,23,42,0.08)]"
            : "border-[color:var(--clyra-border)]",
          processing && "study-brain-node--pulse",
        )}
        aria-label={`${title} study space`}
      >
        <span
          className="pointer-events-none absolute inset-x-0 top-0 h-[3px] bg-gradient-to-r from-[color:var(--clyra-accent)] via-[#5b8cff] to-[color:var(--clyra-accent)]/35"
          aria-hidden
        />
        <span className="max-w-full truncate text-[15px] font-semibold tracking-[-0.03em] text-[color:var(--clyra-text)]">
          {title}
        </span>
        <span className="mt-1 text-[11.5px] text-[color:var(--clyra-text-tertiary)]">
          {processing
            ? "Working…"
            : `${connectedCount} resource${connectedCount === 1 ? "" : "s"}`}
        </span>
      </div>
      <div
        className="study-brain-drag-handle absolute -bottom-1 left-1/2 h-1.5 w-9 -translate-x-1/2 cursor-grab rounded-full bg-[color:var(--clyra-border-strong)]/75 active:cursor-grabbing"
        title="Drag to move"
      />
    </div>
  );
}
