import { Handle, Position, type NodeProps } from "@xyflow/react";
import {
  FileText,
  Film,
  Globe,
  Image as ImageIcon,
  NotebookPen,
} from "lucide-react";
import type { ReactNode } from "react";
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

function KindIcon({ kind }: { kind: string }) {
  if (kind === "youtube") return <YouTubeBrandIcon className="h-4 w-4" />;
  if (kind === "gdoc") return <GoogleProductIcon product="docs" className="h-4 w-4" />;
  if (kind === "gslides" || kind === "slides") return <GoogleProductIcon product="slides" className="h-4 w-4" />;
  if (kind === "gsheet" || kind === "sheet") return <GoogleProductIcon product="sheets" className="h-4 w-4" />;
  if (kind === "gdrive") return <GoogleProductIcon product="drive" className="h-4 w-4" />;

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
  return <Lucide className="h-3.5 w-3.5" strokeWidth={1.75} />;
}

function iconWellTone(kind: string): string {
  if (kind === "youtube") return "bg-[#fff5f5] border-[#ffd0d0]";
  if (kind === "gdoc") return "bg-[#eef4ff] border-[#c9dbff]";
  if (kind === "gslides" || kind === "slides") return "bg-[#fff6ed] border-[#ffd9b8]";
  if (kind === "gsheet" || kind === "sheet") return "bg-[#eefaf1] border-[#c5e8cf]";
  if (kind === "gdrive") return "bg-[#f3f7ff] border-[#c9d8ff]";
  if (kind === "web") return "bg-[#f3f7ff] border-[color:var(--clyra-border)]";
  if (kind === "note") return "bg-[#f7f5ff] border-[color:var(--clyra-border)]";
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
        "study-source-node group relative w-[222px] overflow-hidden rounded-[14px] border bg-white px-3 py-2.5 shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition-[box-shadow,border-color] duration-150",
        selected
          ? "border-[color:var(--clyra-accent)]/40 shadow-[0_0_0_3px_rgba(0,82,251,0.08),0_10px_24px_rgba(15,23,42,0.07)]"
          : "border-[color:var(--clyra-border)]",
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
      <div className="flex items-start gap-2.5">
        <span
          className={cn(
            "mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-[10px] border text-[color:var(--clyra-text-secondary)]",
            iconWellTone(source.kind),
          )}
        >
          <KindIcon kind={source.kind} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-semibold tracking-[-0.02em] text-[color:var(--clyra-text)]">
            {source.title}
          </p>
          <p className="mt-0.5 truncate text-[11px] text-[color:var(--clyra-text-tertiary)]">{kindLabel}</p>
          <p
            className={cn(
              "mt-1.5 inline-flex items-center gap-1 text-[10.5px] font-medium",
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

/** Exported for menu reuse — brand-aware icon by resource kind / menu id. */
export function StudyResourceGlyph({
  kind,
  className = "h-4 w-4",
}: {
  kind: string;
  className?: string;
}): ReactNode {
  if (kind === "youtube") return <YouTubeBrandIcon className={className} />;
  if (kind === "docs" || kind === "gdoc") return <GoogleProductIcon product="docs" className={className} />;
  if (kind === "slides" || kind === "gslides") return <GoogleProductIcon product="slides" className={className} />;
  if (kind === "sheets" || kind === "gsheet") return <GoogleProductIcon product="sheets" className={className} />;
  if (kind === "drive" || kind === "gdrive") return <GoogleProductIcon product="drive" className={className} />;
  if (kind === "web") return <Globe className={className} strokeWidth={1.75} />;
  if (kind === "note") return <NotebookPen className={className} strokeWidth={1.75} />;
  return <FileText className={className} strokeWidth={1.75} />;
}
