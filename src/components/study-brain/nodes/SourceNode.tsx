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

const KIND_LABEL: Record<string, string> = {
  pdf: "PDF",
  doc: "Document",
  text: "Text",
  markdown: "Markdown",
  note: "Note",
  web: "Website",
  youtube: "YouTube",
  video: "Video",
  audio: "Audio",
  image: "Image",
  gdoc: "Google Docs",
  gslides: "Google Slides",
  gsheet: "Google Sheets",
  slides: "Slides",
  sheet: "Sheet",
  gdrive: "Drive",
};

function statusLabel(source: StudySourceNode) {
  if (source.status === "ready") return source.connected ? "Connected" : "Ready";
  if (source.status === "error") return "Needs attention";
  return source.statusDetail || source.status;
}

export function SourceNodeView({ data, selected }: NodeProps) {
  const source = data.source as StudySourceNode;
  const Icon = KIND_ICON[source.kind] || FileText;
  const kindLabel = KIND_LABEL[source.kind] || source.kind;
  return (
    <div
      className={cn(
        "study-source-node group w-[210px] rounded-[10px] border bg-white px-3 py-2.5",
        selected
          ? "border-[color:var(--clyra-accent)]/35 shadow-[0_0_0_3px_rgba(0,82,251,0.07)]"
          : "border-[color:var(--clyra-border)]",
        source.connected && !selected && "border-[color:var(--clyra-border-strong)]",
      )}
    >
      <Handle type="source" position={Position.Right} className="!h-2 !w-2 !border-[color:var(--clyra-border)] !bg-white" />
      <Handle type="target" position={Position.Left} className="!h-2 !w-2 !border-[color:var(--clyra-border)] !bg-white" />
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-[7px] border border-[color:var(--clyra-border)] bg-[color:var(--clyra-surface-muted)] text-[color:var(--clyra-text-secondary)]">
          <Icon className="h-3.5 w-3.5" strokeWidth={1.75} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[12.5px] font-medium tracking-[-0.015em] text-[color:var(--clyra-text)]">
            {source.title}
          </p>
          <p className="mt-0.5 truncate text-[11px] text-[color:var(--clyra-text-tertiary)]">{kindLabel}</p>
          <p
            className={cn(
              "mt-1.5 text-[10.5px] font-medium",
              source.status === "ready" && source.connected && "text-[color:var(--clyra-accent)]",
              source.status === "ready" && !source.connected && "text-[color:var(--clyra-text-tertiary)]",
              source.status === "error" && "text-rose-500",
              source.status !== "ready" && source.status !== "error" && "text-[color:var(--clyra-text-secondary)]",
            )}
          >
            {statusLabel(source)}
          </p>
        </div>
      </div>
    </div>
  );
}
