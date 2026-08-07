import { Handle, Position, type NodeProps } from "@xyflow/react";
import {
  FileText,
  Film,
  Globe,
  Image as ImageIcon,
  NotebookPen,
} from "lucide-react";
import { cn } from "../../../lib/utils";
import type { StudySourceNode } from "../../../lib/study-brain/types";
import { GoogleProductIcon, YouTubeBrandIcon } from "../../brand/ProductIcons";

const SIDE_HANDLES: Array<{ id: string; position: Position }> = [
  { id: "left", position: Position.Left },
  { id: "right", position: Position.Right },
  { id: "top", position: Position.Top },
  { id: "bottom", position: Position.Bottom },
];

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
  gdrive: "Google Drive",
};

function KindIcon({ kind, origin }: { kind: string; origin?: string }) {
  if (kind === "youtube") return <YouTubeBrandIcon className="h-[18px] w-[18px]" />;
  if (kind === "gdoc") return <GoogleProductIcon product="docs" className="h-[18px] w-[18px]" />;
  if (kind === "gslides" || kind === "slides") return <GoogleProductIcon product="slides" className="h-[18px] w-[18px]" />;
  if (kind === "gsheet" || kind === "sheet") return <GoogleProductIcon product="sheets" className="h-[18px] w-[18px]" />;
  if (kind === "gdrive") return <GoogleProductIcon product="drive" className="h-[18px] w-[18px]" />;
  if (kind === "web" && origin) {
    try {
      const host = new URL(origin).hostname;
      return (
        <img
          src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`}
          alt=""
          className="h-4 w-4 object-contain"
          draggable={false}
        />
      );
    } catch {
      /* fall through */
    }
  }

  const Lucide =
    kind === "note"
      ? NotebookPen
      : kind === "web"
        ? Globe
        : kind === "image"
          ? ImageIcon
          : kind === "video" || kind === "audio"
            ? Film
            : FileText;
  return <Lucide className="h-4 w-4" strokeWidth={1.7} />;
}

function iconWellTone(kind: string): string {
  if (kind === "youtube") return "bg-[#fff5f5] border-[#ffd4d4]";
  if (kind === "gdoc") return "bg-[#eef4ff] border-[#c9dbff]";
  if (kind === "gslides" || kind === "slides") return "bg-[#fff7ee] border-[#ffd9b8]";
  if (kind === "gsheet" || kind === "sheet") return "bg-[#eefaf1] border-[#c5e8cf]";
  if (kind === "gdrive") return "bg-[#f3f7ff] border-[#c9d8ff]";
  if (kind === "web") return "bg-[#f5f8ff] border-[color:var(--clyra-border)]";
  if (kind === "note") return "bg-[#f8f6ff] border-[color:var(--clyra-border)]";
  return "bg-[color:var(--clyra-surface-muted)] border-[color:var(--clyra-border)]";
}

function statusLabel(source: StudySourceNode) {
  if (source.status === "ready") return source.connected ? "Connected" : "Ready";
  if (source.status === "error") return "Needs attention";
  return source.statusDetail || source.status;
}

export function SourceNodeView({ data, selected }: NodeProps) {
  const source = data.source as StudySourceNode;
  const kindLabel = KIND_LABEL[source.kind] || source.kind;
  return (
    <div
      className={cn(
        "study-source-node group relative w-[236px] overflow-hidden rounded-[16px] border bg-white px-3.5 py-3 transition-[box-shadow,border-color,transform] duration-150",
        selected
          ? "border-[color:var(--clyra-accent)]/40 shadow-[0_0_0_3px_rgba(0,82,251,0.09),0_14px_28px_rgba(15,23,42,0.08)]"
          : "border-[color:var(--clyra-border)] shadow-[0_1px_2px_rgba(15,23,42,0.04),0_8px_20px_rgba(15,23,42,0.04)]",
        source.connected && !selected && "border-[color:var(--clyra-border-strong)]",
      )}
    >
      {SIDE_HANDLES.map((side) => (
        <Handle
          key={`src-${side.id}`}
          id={side.id}
          type="source"
          position={side.position}
          className="study-source-handle !h-2 !w-2 !border-[1.5px] !border-white !bg-[#94a3b8]"
        />
      ))}
      <div className="flex items-start gap-3">
        <span
          className={cn(
            "mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-[12px] border",
            iconWellTone(source.kind),
          )}
        >
          <KindIcon kind={source.kind} origin={source.origin} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13.5px] font-semibold tracking-[-0.025em] text-[color:var(--clyra-text)]">
            {source.title}
          </p>
          <p className="mt-0.5 truncate text-[11px] text-[color:var(--clyra-text-tertiary)]">{kindLabel}</p>
          <p
            className={cn(
              "mt-2 inline-flex items-center gap-1.5 text-[10.5px] font-medium",
              source.status === "ready" && source.connected && "text-[color:var(--clyra-accent)]",
              source.status === "ready" && !source.connected && "text-[color:var(--clyra-text-tertiary)]",
              source.status === "error" && "text-rose-500",
              source.status !== "ready" && source.status !== "error" && "text-[color:var(--clyra-text-secondary)]",
            )}
          >
            {source.status === "ready" && source.connected ? (
              <span className="h-1.5 w-1.5 rounded-full bg-[color:var(--clyra-accent)]" aria-hidden />
            ) : null}
            {statusLabel(source)}
          </p>
        </div>
      </div>
    </div>
  );
}
