import { Handle, Position, type NodeProps } from "@xyflow/react";
import { cn } from "../../../lib/utils";
import type { StudySourceNode } from "../../../lib/study-brain/types";
import {
  FileText,
  Film,
  Globe,
  Image as ImageIcon,
  Link2,
  NotebookPen,
  Presentation,
  Sheet,
  Youtube,
} from "lucide-react";

const KIND_ICON: Record<string, typeof FileText> = {
  pdf: FileText,
  doc: FileText,
  text: FileText,
  markdown: FileText,
  note: NotebookPen,
  web: Globe,
  youtube: Youtube,
  video: Film,
  audio: Film,
  image: ImageIcon,
  gdoc: FileText,
  gslides: Presentation,
  gsheet: Sheet,
  slides: Presentation,
  sheet: Sheet,
  gdrive: Link2,
};

function statusLabel(source: StudySourceNode) {
  if (source.status === "ready") return source.connected ? "Connected" : "Ready";
  if (source.status === "error") return "Error";
  return source.statusDetail || source.status;
}

export function SourceNodeView({ data, selected }: NodeProps) {
  const source = data.source as StudySourceNode;
  const Icon = KIND_ICON[source.kind] || FileText;
  return (
    <div
      className={cn(
        "study-source-node group w-[200px] rounded-[12px] border bg-white px-3 py-2.5 shadow-[0_1px_2px_rgba(24,33,47,0.04)]",
        selected ? "border-[#0052fb]/45" : "border-[#e7e7e4]",
        source.connected && "ring-1 ring-[#0052fb]/15",
      )}
    >
      <Handle type="source" position={Position.Right} className="!h-2 !w-2 !border-[#c5ccd6] !bg-white" />
      <Handle type="target" position={Position.Left} className="!h-2 !w-2 !border-[#c5ccd6] !bg-white" />
      <div className="flex items-start gap-2">
        <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-[8px] border border-[#e7e7e4] bg-[#fbfbfa] text-[#697386]">
          <Icon className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[12.5px] font-medium tracking-[-0.01em] text-[#18212f]">{source.title}</p>
          <p className="mt-0.5 truncate text-[10.5px] text-[#8b939e]">{source.kind}</p>
          <p
            className={cn(
              "mt-1.5 text-[10px] font-medium uppercase tracking-[0.08em]",
              source.status === "ready" && source.connected && "text-[#0052fb]",
              source.status === "ready" && !source.connected && "text-[#8b939e]",
              source.status === "error" && "text-rose-500",
              source.status !== "ready" && source.status !== "error" && "text-[#496a95]",
            )}
          >
            {statusLabel(source)}
          </p>
        </div>
      </div>
    </div>
  );
}
