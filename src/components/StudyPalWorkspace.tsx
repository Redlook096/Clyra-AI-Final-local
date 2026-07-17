import {
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  addEdge,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
  type OnConnectEnd,
  type ReactFlowInstance,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  Archive,
  BookOpen,
  Check,
  CircleHelp,
  Copy,
  FileText,
  FolderOpen,
  Hand,
  Globe2,
  GraduationCap,
  LayoutGrid,
  Link2,
  Loader2,
  Network,
  NotebookPen,
  MousePointer2,
  Pin,
  Plus,
  Search,
  Scissors,
  Send,
  Sparkles,
  Trash2,
  Type,
  Undo2,
  Redo2,
  Maximize2,
  Upload,
  X,
  Youtube,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "../lib/utils";
import { MarkdownMessageContent } from "./MarkdownMessageContent";
import { DocumentCardUI } from "./ui/document-card";

type ResourceKind = "web" | "youtube" | "document" | "image" | "text";
type NodeKind = "source" | "note" | "concept" | "claim" | "evidence" | "question" | "summary" | "flashcards" | "quiz" | "study-plan";

type StudyResource = {
  id: string;
  kind: ResourceKind;
  title: string;
  url?: string;
  content: string;
  status: "processing" | "ready" | "failed";
  error?: string;
  createdAt: number;
};

type StudyNodeData = {
  kind: NodeKind;
  title: string;
  body: string;
  resourceId?: string;
  sourceNodeId?: string;
  sourceLabel?: string;
  sourceUrl?: string;
  sourceMode?: "youtube" | "web";
  sourceStatus?: "processing" | "ready" | "failed";
  sourceError?: string;
  tags?: string[];
};

type StudyNode = Node<StudyNodeData>;
type StudyEdge = Edge<{ relationship?: string }>;

type StudyWorkspace = {
  id: string;
  name: string;
  description: string;
  pinned: boolean;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
  nodes: StudyNode[];
  edges: StudyEdge[];
  resources: StudyResource[];
  notesContent?: string;
  conversations: Array<{ id: string; role: "user" | "assistant"; text: string; citations?: string[] }>;
};

const STORAGE_KEY = "clyra.study-pal.workspaces.v1";

const StudyNodeActions = createContext<{
  buildFromPrompt: (prompt: string) => void;
  capture: () => void;
  updateNode: (id: string, patch: Partial<StudyNodeData>) => void;
  duplicateNode: (id: string) => void;
  ingestNodeUrl: (nodeId: string, url: string) => void;
  answerQuestionNode: (nodeId: string, question: string) => void;
  workspaceName: string;
  workspaceDescription: string;
} | null>(null);

const nodeStyles: Record<NodeKind, { label: string; accent: string; surface: string; icon: typeof FileText }> = {
  source: { label: "Source", accent: "#2563eb", surface: "#eff6ff", icon: FileText },
  note: { label: "Note", accent: "#ca8a04", surface: "#fefce8", icon: NotebookPen },
  concept: { label: "Concept", accent: "#0f766e", surface: "#f0fdfa", icon: Network },
  claim: { label: "Claim", accent: "#b91c1c", surface: "#fef2f2", icon: Check },
  evidence: { label: "Evidence", accent: "#047857", surface: "#ecfdf5", icon: Link2 },
  question: { label: "Question", accent: "#6d28d9", surface: "#f5f3ff", icon: CircleHelp },
  summary: { label: "Summary", accent: "#475569", surface: "#f8fafc", icon: BookOpen },
  flashcards: { label: "Flashcards", accent: "#be123c", surface: "#fff1f2", icon: LayoutGrid },
  quiz: { label: "Practice", accent: "#c2410c", surface: "#fff7ed", icon: GraduationCap },
  "study-plan": { label: "Study plan", accent: "#0369a1", surface: "#f0f9ff", icon: FolderOpen },
};

function safeId() {
  return crypto.randomUUID();
}

function youtubeVideoId(url = "") {
  return url.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|shorts\/|embed\/))([\w-]{6,})/i)?.[1] || "";
}

function fuzzyContains(value: string, query: string) {
  const haystack = value.toLowerCase().replace(/[^a-z0-9]+/g, " ");
  const needle = query.toLowerCase().trim().replace(/[^a-z0-9]+/g, " ");
  if (!needle || haystack.includes(needle)) return true;
  let index = 0;
  for (const character of haystack) {
    if (character === needle[index]) index += 1;
    if (index === needle.length) return true;
  }
  return false;
}

function connectedNodeIds(rootId: string, edges: StudyEdge[]) {
  const ids = new Set<string>([rootId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const edge of edges) {
      if (ids.has(edge.source) && !ids.has(edge.target)) {
        ids.add(edge.target);
        grew = true;
      }
      if (ids.has(edge.target) && !ids.has(edge.source)) {
        ids.add(edge.source);
        grew = true;
      }
    }
  }
  return ids;
}

const NODE_MENU_WIDTH = 268;
const NODE_MENU_EST_HEIGHT = 320;

function clampNodeMenuPosition(
  dropX: number,
  dropY: number,
  bounds: { width: number; height: number },
  menuW = NODE_MENU_WIDTH,
  menuH = NODE_MENU_EST_HEIGHT,
) {
  const pad = 12;
  const half = menuW / 2;
  const x = Math.min(
    Math.max(dropX, pad + half),
    Math.max(pad + half, bounds.width - pad - half),
  );
  const below = dropY + 8;
  const above = dropY - menuH - 8;
  const y = below + menuH <= bounds.height - pad
    ? Math.max(pad, below)
    : Math.max(pad, Math.min(above > pad ? above : pad, bounds.height - pad - menuH));
  return { x, y };
}

function buildScopedGraphContext(
  allNodes: StudyNode[],
  allEdges: StudyEdge[],
  anchorId?: string | null,
) {
  const attached = anchorId ? connectedNodeIds(anchorId, allEdges) : null;
  const scoped = attached && attached.size > 1
    ? allNodes.filter((node) => attached.has(node.id) && node.data.kind !== "flashcards" && node.data.kind !== "quiz" && node.data.kind !== "study-plan")
    : allNodes.filter((node) => node.data.kind !== "flashcards" && node.data.kind !== "quiz" && node.data.kind !== "study-plan");
  const scopedIds = new Set(scoped.map((node) => node.id));
  const scopedEdges = allEdges.filter((edge) => scopedIds.has(edge.source) && scopedIds.has(edge.target));
  return {
    scopedToAttached: Boolean(attached && attached.size > 1),
    context: prioritizeGraphContext(scoped, scopedEdges),
  };
}

function edgeRelationship(edge: StudyEdge) {
  const label = String(edge.label || "").trim();
  const dataRel = String(edge.data?.relationship || "").trim();
  if (label && (!dataRel || dataRel === "connects to" || dataRel === "generated")) return label;
  return dataRel || label || "relates to";
}

function studyEdgeStyle(label: string) {
  return {
    type: "step" as const,
    label,
    labelStyle: { fill: "#64748b", fontSize: 8, fontWeight: 600 },
    labelBgStyle: { fill: "rgba(255,254,250,.94)" },
    labelBgPadding: [5, 3] as [number, number],
    labelBgBorderRadius: 6,
    markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: "#111318" },
    style: { stroke: "#111318", strokeWidth: 1.6 },
    data: { relationship: label },
  };
}

type GraphContextItem = { id: string; title: string; body: string; source: string };

function enrichGraphContext(items: GraphContextItem[], allNodes: StudyNode[], resources: StudyResource[]) {
  return items.map((item) => {
    const node = allNodes.find((candidate) => candidate.id === item.id);
    const resource = node?.data.resourceId ? resources.find((candidate) => candidate.id === node.data.resourceId) : undefined;
    if (!resource?.content || resource.content === item.body) return item;
    return { ...item, body: `${item.body}\n\nFull analysed source context:\n${resource.content.slice(0, 12_000)}` };
  });
}

function questionParts(body = "") {
  const [question, answer = ""] = body.split(/\n\s*Answer:\s*/i);
  return { question: question.replace(/^Question:\s*/i, "").trim(), answer: answer.trim() };
}

function explicitQuestionNotes(allNodes: StudyNode[], allEdges: StudyEdge[]) {
  const sections = allNodes
    .filter((node) => node.data.kind === "question")
    .map((node) => {
      const parsed = questionParts(node.data.body);
      if (!parsed.question || !parsed.answer) return null;
      const attachedIds = connectedNodeIds(node.id, allEdges);
      const sources = allNodes
        .filter((candidate) => attachedIds.has(candidate.id) && candidate.data.kind === "source")
        .map((candidate) => candidate.data.title || candidate.data.sourceLabel || candidate.data.sourceUrl)
        .filter(Boolean);
      return `### ${parsed.question}\n\n${parsed.answer}${sources.length ? `\n\nSource: ${sources.join(", ")}` : ""}`;
    })
    .filter(Boolean);
  return sections.length ? `\n\n## Questions and Answers\n\n${sections.join("\n\n")}` : "";
}

function prioritizeGraphContext(allNodes: StudyNode[], allEdges: StudyEdge[], maxItems = 32): GraphContextItem[] {
  const nodeItems = allNodes
    .filter((node) => node.data.kind !== "flashcards" && node.data.kind !== "quiz" && node.data.kind !== "study-plan")
    .map((node) => ({
      id: node.id,
      title: `${node.data.kind}: ${node.data.title}`,
      body: [node.data.body, node.data.sourceUrl].filter(Boolean).join("\n").slice(0, 3_500),
      source: node.data.sourceLabel || node.data.sourceUrl || node.data.kind,
    }));
  const edgeItems = allEdges.map((edge) => {
    const source = allNodes.find((node) => node.id === edge.source);
    const target = allNodes.find((node) => node.id === edge.target);
    if (!source || !target) return null;
    const relation = edgeRelationship(edge);
    return {
      id: `edge-${edge.id}`,
      title: "Connected group",
      body: `${source.data.kind.toUpperCase()} "${source.data.title}" ${relation} ${target.data.kind.toUpperCase()} "${target.data.title}". Source body: ${(source.data.body || source.data.sourceUrl || "").slice(0, 1_200)}. Target body: ${(target.data.body || "").slice(0, 800)}.`,
      source: "canvas-edge",
    };
  }).filter(Boolean) as GraphContextItem[];
  const edgeBudget = Math.min(12, edgeItems.length);
  const nodeBudget = Math.max(4, maxItems - edgeBudget);
  return [...nodeItems.slice(0, nodeBudget), ...edgeItems.slice(0, edgeBudget)];
}

function splitStudyItems(body: string) {
  return body.split(/\n(?=\s*(?:\d+[.)]|[-*])\s+)/).map((item) => item.replace(/^\s*(?:\d+[.)]|[-*])\s*/, "").trim()).filter(Boolean);
}

function cleanStudyText(value: string) {
  return value
    .replace(/\*\*|__/g, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\s{3,}/g, " ")
    .trim();
}

function compactStudyMarkdown(value: string) {
  return value.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function parseFlashcardPairs(body: string): Array<{ front: string; back: string }> {
  const matches = [...body.matchAll(/(?:Flashcard\s*\d+[^\n]*\n?\s*)?(?:\*\*|__)?Front(?:\*\*|__)?\s*:\s*(.*?)(?:\n|\s)+(?:\*\*|__)?Back(?:\*\*|__)?\s*:\s*(.*?)(?=(?:\n\s*(?:\*\*)?Flashcard\s*\d+|\n\s*\d+[.)]|$))/gis)]
    .map((match) => ({ front: match[1]?.replace(/[*_#]/g, "").trim() || "", back: match[2]?.replace(/[*_#]/g, "").trim() || "" }))
    .filter((card) => card.front && card.back);
  if (matches.length) return matches;
  return splitStudyItems(body).slice(0, 8).map((item): { front: string; back: string } => {
    const parts = item.split(/\s+(?:Answer|Back)\s*:\s*/i);
    return { front: parts[0]?.replace(/^(?:Question|Front)\s*:\s*/i, "").trim() || item, back: parts[1]?.trim() || "Review the connected source." };
  });
}

function readWorkspaces(): StudyWorkspace[] {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    if (!Array.isArray(value)) return [];
    return value.map((workspace: StudyWorkspace) => {
      const resources = Array.isArray(workspace.resources) ? workspace.resources : [];
      const nodes = Array.isArray(workspace.nodes) ? workspace.nodes : [];
      const edges = (Array.isArray(workspace.edges) ? workspace.edges : []).map((edge) => ({
        ...edge,
        type: "step",
        style: { ...edge.style, stroke: "#111318", strokeWidth: 1.6, strokeDasharray: "none" },
        markerEnd: { type: MarkerType.ArrowClosed, color: "#111318", width: 14, height: 14 },
      }));
      return { ...workspace, resources, nodes, edges };
    });
  } catch {
    return [];
  }
}

function newWorkspace(name = "Untitled workspace"): StudyWorkspace {
  const timestamp = Date.now();
  return {
    id: safeId(),
    name,
    description: "A source-grounded canvas for research and study.",
    pinned: false,
    archived: false,
    createdAt: timestamp,
    updatedAt: timestamp,
    resources: [],
    edges: [],
    conversations: [],
    nodes: [{
      id: safeId(),
      type: "study",
      position: { x: 360, y: 220 },
      data: {
        kind: "concept",
        title: "",
        body: "",
        tags: ["starter"],
      },
    }],
  };
}

function StudyNodeCard({ id, data, selected }: NodeProps<StudyNode>) {
  const style = nodeStyles[data.kind];
  const actions = useContext(StudyNodeActions);
  const [starterPrompt, setStarterPrompt] = useState("");
  const [urlDraft, setUrlDraft] = useState(data.sourceUrl || "");
  const starter = data.tags?.includes("starter");
  const videoId = data.kind === "source" ? youtubeVideoId(data.sourceUrl || urlDraft) : "";
  const sourceMode = data.sourceMode
    || (data.kind === "source" && /youtu/i.test(data.title) ? "youtube" as const : undefined)
    || (data.kind === "source" && /web\s*page/i.test(data.title) ? "web" as const : undefined);
  const Icon = sourceMode === "youtube" ? Youtube : sourceMode === "web" ? Globe2 : style.icon;
  const showUrlField = data.kind === "source" && (sourceMode === "youtube" || sourceMode === "web");
  const kindLabel = sourceMode === "youtube" ? "YouTube" : sourceMode === "web" ? "Web page" : style.label;
  const isGhost = data.tags?.includes("ai-ghost");
  const isAnswering = data.tags?.includes("answering");
  const isSourceAnalysing = data.kind === "source" && data.sourceStatus === "processing";
  const isTyping = data.tags?.includes("ai-typing");
  const question = data.kind === "question" ? questionParts(data.body) : null;
  
  // Get workspace context for starter node
  const workspaceName = actions?.workspaceName || "";
  const workspaceDescription = actions?.workspaceDescription || "";

  useEffect(() => {
    setUrlDraft(data.sourceUrl || "");
  }, [data.sourceUrl]);

  const commitSourceUrl = (value: string) => {
    const next = value.trim();
    const nextMode = sourceMode || (/youtu(?:be\.com|\.be)/i.test(next) ? "youtube" as const : "web" as const);
    actions?.updateNode(id, { sourceUrl: next, sourceMode: nextMode });
    if (!next || next === data.sourceUrl && data.body) return;
    if (nextMode === "youtube" || /youtu(?:be\.com|\.be)/i.test(next)) {
      if (!youtubeVideoId(next)) return;
      actions?.ingestNodeUrl(id, next);
      return;
    }
    if (/^https?:\/\//i.test(next)) actions?.ingestNodeUrl(id, next);
  };

  return (
    <div data-study-node-id={id} className={cn("relative cursor-grab pt-6 active:cursor-grabbing", starter ? "w-[340px]" : "w-[300px]")}>
      <span className="absolute left-1 top-0 flex items-center gap-1.5 text-[10px] font-medium text-slate-400"><Icon className="h-3 w-3" style={{ color: style.accent }} />{kindLabel}</span>
      <motion.div
        className={cn(
          "relative overflow-visible rounded-[20px] border bg-[#fffefa] shadow-[0_12px_34px_rgba(34,39,45,.07)] transition-[border-color,box-shadow,transform] duration-150",
          isGhost && "min-h-[180px] border-blue-300 bg-white/70 shadow-[0_0_0_4px_rgba(59,130,246,.10),0_0_34px_rgba(37,99,235,.28)]",
          (isAnswering || isSourceAnalysing) && "border-blue-400 shadow-[0_0_0_6px_rgba(59,130,246,.2),0_0_48px_rgba(37,99,235,.42)]",
          selected ? "border-[#111318] shadow-[0_0_0_4px_rgba(17,19,24,.08),0_16px_38px_rgba(34,39,45,.09)]" : "border-[#dfe2e6]",
        )}
        animate={isAnswering || isSourceAnalysing ? {
          boxShadow: [
            "0 0 0 0 rgba(37,99,235,0), 0 0 0 rgba(37,99,235,0)",
            "0 0 0 7px rgba(37,99,235,.14), 0 0 34px rgba(37,99,235,.34)",
            "0 0 0 2px rgba(37,99,235,.08), 0 0 20px rgba(37,99,235,.18)",
          ],
        } : undefined}
        transition={isAnswering || isSourceAnalysing ? { duration: 1.55, repeat: Infinity, ease: "easeInOut" } : undefined}
      >
        {isGhost ? (
          <motion.span
            className="pointer-events-none absolute inset-0 rounded-[20px] border border-blue-300/70"
            animate={{ opacity: [0.38, 1, 0.38] }}
            transition={{ repeat: Infinity, duration: 1.15, ease: "easeInOut" }}
          />
        ) : null}
        {isTyping ? <motion.span className="pointer-events-none absolute left-7 top-[116px] z-20 h-5 w-px bg-blue-600 shadow-[0_0_8px_rgba(37,99,235,.7)]" animate={{ opacity: [0, 1, 0] }} transition={{ repeat: Infinity, duration: 0.8, ease: "linear" }} /> : null}
        <Handle type="target" position={Position.Left} className="!left-[-8px] !top-1/2 !h-4 !w-4 !-translate-y-1/2 !border-[3px] !border-black !bg-black !shadow-none !transition-transform hover:!scale-125" />
        <Handle type="source" position={Position.Right} className="!right-[-8px] !top-1/2 !h-4 !w-4 !-translate-y-1/2 !border-[3px] !border-black !bg-black !shadow-none !transition-transform hover:!scale-125" />
        <Handle type="target" position={Position.Top} className="!top-[-8px] !left-1/2 !h-4 !w-4 !-translate-x-1/2 !border-[3px] !border-black !bg-black !shadow-none !transition-transform hover:!scale-125" />
        <Handle type="source" position={Position.Bottom} className="!bottom-[-8px] !left-1/2 !h-4 !w-4 !-translate-x-1/2 !border-[3px] !border-black !bg-black !shadow-none !transition-transform hover:!scale-125" />
        <div className="relative flex h-12 items-center justify-between px-5 text-[9px] font-medium text-slate-500">
          <span>Input</span>
          <span>Output</span>
        </div>
        {videoId ? (
          <div className="mx-4 overflow-hidden rounded-[14px] border border-[#e2e4e7] bg-black">
            <iframe
              src={`https://www.youtube.com/embed/${videoId}`}
              title={data.title || "YouTube source"}
              className="h-[168px] w-full"
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
              allowFullScreen
            />
          </div>
        ) : null}
        {sourceMode === "web" && /^https?:\/\//i.test(data.sourceUrl || urlDraft) ? (
          <div className="mx-4 rounded-[14px] border border-[#dbeafe] bg-gradient-to-br from-blue-50 to-white p-3">
            <div className="flex items-start gap-2">
              <Globe2 className="mt-0.5 h-4 w-4 shrink-0 text-blue-600" />
              <div className="min-w-0">
                <p className="truncate text-[10px] font-semibold text-slate-800">{data.title || "Web source"}</p>
                <p className="mt-1 line-clamp-2 break-all text-[8px] leading-4 text-slate-500">{data.sourceUrl || urlDraft}</p>
              </div>
            </div>
            <div className="mt-3 flex items-center justify-between gap-2 text-[8px] font-medium text-blue-700">
              <span>{data.body ? "Readable page text imported for AI context" : "Paste a URL to import readable page text"}</span>
              <a href={data.sourceUrl || urlDraft} target="_blank" rel="noreferrer" className="nodrag nopan shrink-0 rounded-full border border-blue-200 bg-white px-2.5 py-1 text-blue-700 hover:bg-blue-50">Open</a>
            </div>
          </div>
        ) : null}
        <div className="px-4 pb-4">
          <div className="flex h-9 items-center justify-between border-y border-slate-200/70 text-slate-400">
            <span className="inline-flex items-center gap-1.5 text-[9px] font-medium"><Icon className="h-3.5 w-3.5" style={{ color: style.accent }} />{kindLabel}</span>
            <button type="button" title="Duplicate node" onClick={() => actions?.duplicateNode(id)} className="nodrag nopan grid h-7 w-7 place-items-center rounded-lg transition-colors hover:bg-slate-100 hover:text-slate-700"><Copy className="h-3.5 w-3.5" /></button>
          </div>
          {showUrlField ? (
            <input
              value={urlDraft}
              onFocus={() => actions?.capture()}
              onChange={(event) => {
                const next = event.target.value;
                setUrlDraft(next);
                actions?.updateNode(id, { sourceUrl: next.trim() });
              }}
              onBlur={() => commitSourceUrl(urlDraft)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  commitSourceUrl(urlDraft);
                }
              }}
              aria-label={sourceMode === "youtube" ? "YouTube URL" : "Web page URL"}
              placeholder={sourceMode === "youtube" ? "Paste a YouTube URL..." : "Paste a webpage URL..."}
              className="nodrag nopan mt-3 h-10 w-full rounded-xl border border-[#e2e4e7] bg-[#f7f7f4] px-3 text-[11px] text-[#30343a] outline-none transition-shadow placeholder:text-slate-400 focus:border-[#d8a17d] focus:ring-4 focus:ring-[#e8b28d]/15"
            />
          ) : null}
          {/* YouTube / web sources: URL (+ preview) only — no extra title/body fields */}
          {isGhost ? (
            <div className="space-y-2 py-3">
              <div className="agent-soft-shimmer h-3 w-2/3 rounded-full bg-blue-100" />
              <div className="agent-soft-shimmer h-3 w-full rounded-full bg-blue-50" />
              <div className="agent-soft-shimmer h-3 w-5/6 rounded-full bg-blue-50" />
            </div>
          ) : sourceMode === "youtube" || sourceMode === "web" ? (
            <>
              {data.sourceStatus === "processing" ? <div className="mt-3 flex items-center gap-2 rounded-[14px] border border-blue-200 bg-blue-50/70 p-3 text-[9px] font-semibold text-blue-700"><Loader2 className="h-3.5 w-3.5 animate-spin" />Analysing this source for Clyra</div> : null}
              {data.sourceStatus === "failed" ? <div className="mt-3 rounded-[14px] border border-rose-200 bg-rose-50 p-3 text-[9px] leading-4 text-rose-700">{data.sourceError || "This source could not be analysed."}</div> : null}
              {data.body ? <p className="mt-2 line-clamp-3 rounded-[14px] border border-[#e2e4e7] bg-[#f7f7f4] p-3 text-[10px] leading-5 text-slate-600">{data.body}</p> : null}
            </>
          ) : data.kind === "question" ? (
            <div className="mt-3">
              <textarea
                value={question?.question || ""}
                onFocus={() => actions?.capture()}
                onKeyDown={(event) => event.stopPropagation()}
                onChange={(event) => actions?.updateNode(id, { title: "Question", body: event.target.value.slice(0, 2_000) })}
                onBlur={(event) => {
                  const next = event.target.value.trim();
                  if (next && !question?.answer) actions?.answerQuestionNode(id, next);
                }}
                aria-label="Question"
                rows={3}
                placeholder="Ask a focused question..."
                className="nodrag nopan min-h-[78px] w-full resize-none rounded-[14px] border border-[#e2e4e7] bg-[#f7f7f4] p-3 text-[11px] font-medium leading-5 text-slate-700 outline-none transition-shadow focus:border-blue-300 focus:ring-4 focus:ring-blue-100/60"
              />
              {isAnswering ? (
                <div className="mt-3 space-y-2 rounded-[14px] border border-blue-200 bg-blue-50/70 p-3 shadow-[0_0_24px_rgba(37,99,235,.14)]">
                  <div className="flex items-center gap-2 text-[8px] font-semibold uppercase tracking-[.12em] text-blue-600"><Sparkles className="h-3 w-3" />Clyra is analysing connected sources</div>
                  <div className="agent-soft-shimmer h-3 w-4/5 rounded-full bg-blue-100" />
                  <div className="agent-soft-shimmer h-3 w-2/3 rounded-full bg-blue-100" />
                </div>
              ) : question?.answer ? (
                <div className="mt-3 rounded-[14px] border border-blue-100 bg-blue-50/70 p-3">
                  <p className="text-[8px] font-semibold uppercase tracking-[.12em] text-blue-500">Answer</p>
                  <p className="mt-1 line-clamp-4 text-[10px] leading-5 text-slate-700">{question.answer}</p>
                </div>
              ) : null}
            </div>
          ) : (
            <>
              <input
                value={data.title}
                onFocus={() => actions?.capture()}
                onChange={(event) => actions?.updateNode(id, { title: event.target.value.slice(0, 120) })}
                aria-label="Node title"
                placeholder={starter ? "Name this study or research..." : undefined}
                className={cn("nodrag nopan mt-3 h-10 w-full rounded-xl border border-[#e2e4e7] bg-[#f7f7f4] px-3 text-[12px] font-semibold text-[#30343a] outline-none transition-shadow focus:border-[#d8a17d] focus:ring-4 focus:ring-[#e8b28d]/15", starter && !data.title ? "placeholder:animate-pulse placeholder:text-slate-400" : "")}
              />
              <textarea
                value={data.body}
                onFocus={() => actions?.capture()}
                onChange={(event) => actions?.updateNode(id, { body: event.target.value.slice(0, 8_000) })}
                aria-label="Node content"
                rows={starter ? 3 : 4}
                placeholder={starter ? "Enter the purpose or description of this project so Clyra can build a better map..." : undefined}
                className={cn("nodrag nopan mt-2 min-h-[78px] w-full resize-none rounded-[14px] border border-[#e2e4e7] bg-[#f7f7f4] p-3 text-[10px] leading-5 text-slate-600 outline-none transition-shadow focus:border-[#d8a17d] focus:ring-4 focus:ring-[#e8b28d]/15", starter && !data.body ? "placeholder:animate-pulse placeholder:text-slate-400" : "")}
              />
            </>
          )}
        {starter ? (
          <div className="nodrag nopan mt-2 rounded-[14px] border border-[#e2e4e7] bg-gradient-to-br from-blue-50 to-indigo-50 p-3 text-center">
            <p className="text-[9px] font-semibold text-slate-700">{workspaceName || "Welcome to your study workspace"}</p>
            <p className="mt-1 text-[8px] leading-4 text-slate-500">{workspaceDescription || "Drag from any direction to start adding nodes and build your knowledge map"}</p>
            <div className="mt-2 flex justify-center gap-1">
              <div className="h-1 w-1 rounded-full bg-slate-400 animate-pulse" />
              <div className="h-1 w-1 rounded-full bg-slate-400 animate-pulse delay-75" />
              <div className="h-1 w-1 rounded-full bg-slate-400 animate-pulse delay-150" />
            </div>
          </div>
        ) : null}
          {data.sourceLabel ? <div className="mt-3 flex items-center gap-1.5 border-t border-slate-200/70 pt-2 text-[8px] font-medium text-slate-400"><Link2 className="h-3 w-3" /><span className="truncate">{data.sourceLabel}</span></div> : null}
        </div>
      </motion.div>
    </div>
  );
}

const nodeTypes = { study: StudyNodeCard };

function WorkspaceDashboard({ workspaces, onChange, onOpen }: { workspaces: StudyWorkspace[]; onChange: (next: StudyWorkspace[]) => void; onOpen: (id: string) => void }) {
  const active = workspaces.filter((workspace) => !workspace.archived).sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt);
  const create = () => {
    const workspace = newWorkspace("");
    onChange([workspace, ...workspaces]);
    onOpen(workspace.id);
  };
  return (
    <div className="h-full overflow-y-auto bg-[#f7f8fa] px-5 py-8 sm:px-8 lg:px-12">
      <div className="mx-auto w-full max-w-[1160px]">
        <div className="flex flex-col gap-6 border-b border-slate-200/80 pb-8 sm:flex-row sm:items-end sm:justify-between">
          <div><p className="text-[9px] font-bold uppercase tracking-[.16em] text-slate-400">Study Pal</p><h1 className="mt-2 text-[34px] font-semibold tracking-[-.035em] text-slate-950 sm:text-[44px]">Research that stays connected.</h1><p className="mt-2 max-w-2xl text-[12px] leading-6 text-slate-500">Collect sources, map ideas, ask grounded questions, and turn the same evidence into a study plan.</p></div>
          <button type="button" onClick={create} className="flex h-11 shrink-0 items-center justify-center gap-2 rounded-2xl bg-slate-950 px-4 text-[10px] font-semibold text-white shadow-[0_12px_28px_rgba(15,23,42,.12)] transition-[transform,box-shadow] hover:-translate-y-0.5 hover:shadow-[0_16px_34px_rgba(15,23,42,.16)]"><Plus className="h-4 w-4" />New workspace</button>
        </div>

        {active.length ? (
          <div className="mt-7 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {active.map((workspace) => (
              <motion.article key={workspace.id} layout className="group relative overflow-hidden rounded-2xl border border-slate-200/90 bg-white p-5 transition-[border-color,box-shadow,transform] hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-[0_18px_50px_rgba(15,23,42,.08)]">
                <button type="button" onClick={() => onOpen(workspace.id)} className="block w-full text-left">
                  <div className="flex items-center justify-between"><span className="grid h-9 w-9 place-items-center rounded-md bg-slate-950 text-white"><Network className="h-4 w-4" /></span>{workspace.pinned ? <Pin className="h-3.5 w-3.5 fill-slate-700 text-slate-700" /> : null}</div>
                  <h2 className="mt-6 truncate text-[14px] font-semibold">{workspace.name || "Untitled study"}</h2>
                  <p className="mt-2 line-clamp-2 text-[9px] leading-4 text-slate-400">{workspace.description}</p>
                  <div className="mt-5 flex items-center gap-3 text-[8px] text-slate-400"><span>{workspace.resources.length} sources</span><span>{workspace.nodes.length} nodes</span><span className="ml-auto">{new Date(workspace.updatedAt).toLocaleDateString()}</span></div>
                </button>
                <div className="mt-4 flex border-t border-slate-100 pt-3">
                  <button type="button" onClick={() => onChange(workspaces.map((item) => item.id === workspace.id ? { ...item, pinned: !item.pinned } : item))} className="grid h-8 w-8 place-items-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-800" title={workspace.pinned ? "Unpin workspace" : "Pin workspace"}><Pin className="h-3.5 w-3.5" /></button>
                  <button type="button" onClick={() => { const duplicate = { ...structuredClone(workspace), id: safeId(), name: `${workspace.name} copy`, pinned: false, updatedAt: Date.now() }; onChange([duplicate, ...workspaces]); }} className="grid h-8 w-8 place-items-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-800" title="Duplicate workspace"><Copy className="h-3.5 w-3.5" /></button>
                  <button type="button" onClick={() => onChange(workspaces.map((item) => item.id === workspace.id ? { ...item, archived: true } : item))} className="grid h-8 w-8 place-items-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-800" title="Archive workspace"><Archive className="h-3.5 w-3.5" /></button>
                  <button type="button" onClick={() => onChange(workspaces.filter((item) => item.id !== workspace.id))} className="ml-auto grid h-8 w-8 place-items-center rounded-md text-slate-400 hover:bg-red-50 hover:text-red-600" title="Delete workspace"><Trash2 className="h-3.5 w-3.5" /></button>
                </div>
              </motion.article>
            ))}
          </div>
        ) : (
          <button type="button" onClick={create} className="mt-8 flex min-h-[280px] w-full flex-col items-center justify-center rounded-lg border border-dashed border-slate-300 bg-white text-center hover:border-slate-500"><Network className="h-8 w-8 text-slate-300" /><span className="mt-4 text-[13px] font-semibold">Create your first workspace</span><span className="mt-2 text-[9px] text-slate-400">Sources, notes, questions, and study material stay together.</span></button>
        )}
      </div>
    </div>
  );
}

function StudyCanvas({ workspace, onBack, onPersist, globalTabsVisible }: { workspace: StudyWorkspace; onBack: () => void; onPersist: (workspace: StudyWorkspace) => void; globalTabsVisible: boolean }) {
  const [nodes, setNodes, onNodesChange] = useNodesState<StudyNode>(workspace.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<StudyEdge>(workspace.edges);
  const [resources, setResources] = useState(workspace.resources);
  const [conversations, setConversations] = useState<Array<{ id: string; role: "user" | "assistant"; text: string; citations?: string[] }>>([]);
  const [name, setName] = useState(workspace.name);
  const [selectedId, setSelectedId] = useState("");
  const [sourceInput, setSourceInput] = useState("");
  const [addingSource, setAddingSource] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [chatDraft, setChatDraft] = useState("");
  const [asking, setAsking] = useState(false);
  const [notice, setNotice] = useState("");
  const [composerMode, setComposerMode] = useState<"ask" | "source">("ask");
  const [studyView, setStudyView] = useState<"nodes" | "notes" | "flashcards" | "test" | "chat">("nodes");
  const [studyViewDirection, setStudyViewDirection] = useState(1);
  const [hoveredStudyTab, setHoveredStudyTab] = useState<"nodes" | "notes" | "flashcards" | "test" | "chat" | null>(null);
  const [notesContent, setNotesContent] = useState(workspace.notesContent || "");
  const [notesLoading, setNotesLoading] = useState(false);
  const [flashLoading, setFlashLoading] = useState(false);
  const [testLoading, setTestLoading] = useState(false);
  const [testSubmitting, setTestSubmitting] = useState(false);
  const [testScore, setTestScore] = useState<{ correct: number; total: number } | null>(null);
  const [testAnswers, setTestAnswers] = useState<Record<string, string>>({});
  const [testMarks, setTestMarks] = useState<Record<string, { correct?: boolean; feedback?: string }>>({});
  const [flippedCards, setFlippedCards] = useState<Set<string>>(() => new Set());
  const [practiceSelections, setPracticeSelections] = useState<Record<string, string>>({});
  const [nodeMenuQuery, setNodeMenuQuery] = useState("");
  const [nodeMenuIndex, setNodeMenuIndex] = useState(0);
  const [canvasTool, setCanvasTool] = useState<"select" | "pan" | "cut">("pan");
  const [commandDockOpen, setCommandDockOpen] = useState(false);
  const [welcomeOpen, setWelcomeOpen] = useState(true);
  const [agentCursor, setAgentCursor] = useState<{ x: number; y: number; label: string } | null>(null);
  const [flowInstance, setFlowInstance] = useState<ReactFlowInstance<StudyNode, StudyEdge> | null>(null);
  const [pendingConnection, setPendingConnection] = useState<{
    source?: string;
    target?: string;
    screen: { x: number; y: number };
    flow: { x: number; y: number };
  } | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const canvasRef = useRef<HTMLElement | null>(null);
  const nodeMenuRef = useRef<HTMLDivElement | null>(null);
  const pendingSourceRef = useRef<string | null>(null);
  const undoRef = useRef<Array<{ nodes: StudyNode[]; edges: StudyEdge[] }>>([]);
  const redoRef = useRef<Array<{ nodes: StudyNode[]; edges: StudyEdge[] }>>([]);
  const autoAnsweredQuestionsRef = useRef(new Set<string>());
  const backgroundStudyKeyRef = useRef("");

  const selected = nodes.find((node) => node.id === selectedId);
  const readyResourceCount = resources.filter((resource) => resource.status === "ready").length;
  const studyLocked = readyResourceCount === 0;

  useEffect(() => {
    const timer = window.setTimeout(() => onPersist({ ...workspace, name, nodes, edges, resources, conversations, notesContent, updatedAt: Date.now() }), 420);
    return () => window.clearTimeout(timer);
  }, [conversations, edges, name, nodes, notesContent, onPersist, resources, workspace]);

  const capture = useCallback(() => {
    undoRef.current = [...undoRef.current.slice(-39), { nodes: structuredClone(nodes), edges: structuredClone(edges) }];
    redoRef.current = [];
  }, [edges, nodes]);

  const undo = useCallback(() => {
    const previous = undoRef.current.pop();
    if (!previous) return;
    redoRef.current.push({ nodes: structuredClone(nodes), edges: structuredClone(edges) });
    setNodes(previous.nodes);
    setEdges(previous.edges);
  }, [edges, nodes, setEdges, setNodes]);

  const redo = useCallback(() => {
    const next = redoRef.current.pop();
    if (!next) return;
    undoRef.current.push({ nodes: structuredClone(nodes), edges: structuredClone(edges) });
    setNodes(next.nodes);
    setEdges(next.edges);
  }, [edges, nodes, setEdges, setNodes]);

  const updateNode = useCallback((id: string, patch: Partial<StudyNodeData>) => {
    setNodes((current) => current.map((node) => node.id === id ? { ...node, data: { ...node.data, ...patch } } : node));
  }, [setNodes]);

  const revealGeneratedNode = useCallback(async (
    node: StudyNode,
    finalData: StudyNodeData,
    sourceNodeId?: string,
    edgeLabel = "generated",
  ) => {
    capture();
    setAgentCursor({ x: node.position.x - 54, y: node.position.y + 28, label: "Clyra" });
    const sourceNode = sourceNodeId ? nodes.find((item) => item.id === sourceNodeId) : undefined;
    const startPosition = sourceNode
      ? { x: sourceNode.position.x + (sourceNode.data.tags?.includes("starter") ? 340 : 300), y: sourceNode.position.y + 118 }
      : { x: node.position.x - 220, y: node.position.y - 90 };
    setNodes((current) => [...current, {
      ...node,
      position: startPosition,
      data: { ...finalData, title: "", body: "", tags: ["ai-ghost"] },
    }]);
    if (sourceNodeId) {
      setEdges((current) => addEdge({
        id: safeId(),
        source: sourceNodeId,
        target: node.id,
        ...studyEdgeStyle(edgeLabel),
      }, current));
    }
    await new Promise((resolve) => window.setTimeout(resolve, 420));
    const dragSteps = 18;
    for (let step = 1; step <= dragSteps; step += 1) {
      const progress = step / dragSteps;
      const eased = 1 - Math.pow(1 - progress, 3);
      const x = startPosition.x + (node.position.x - startPosition.x) * eased;
      const y = startPosition.y + (node.position.y - startPosition.y) * eased;
      setAgentCursor({ x: x + 44, y: y + 54, label: "Clyra" });
      setNodes((current) => current.map((item) => item.id === node.id ? { ...item, position: { x, y } } : item));
      await new Promise((resolve) => window.setTimeout(resolve, 22));
    }
    setAgentCursor({ x: node.position.x + 44, y: node.position.y + 54, label: "Clyra" });
    const title = finalData.title || "";
    const body = finalData.body || "";
    const totalCharacters = title.length + body.length;
    for (let character = 1; character <= totalCharacters; character += 1) {
      const titleCharacters = Math.min(title.length, character);
      const bodyCharacters = Math.max(0, character - title.length);
      setNodes((current) => current.map((item) => item.id === node.id ? {
        ...item,
        data: {
          ...finalData,
          title: title.slice(0, titleCharacters),
          body: body.slice(0, bodyCharacters),
          tags: ["ai-typing"],
        },
      } : item));
      const nodeElement = document.querySelector(`[data-study-node-id="${node.id}"]`);
      const typingSelector = title.length && character <= title.length
        ? "input[aria-label='Node title']"
        : "textarea[aria-label='Node content'], textarea[aria-label='Question'], input[aria-label='YouTube URL'], input[aria-label='Web page URL']";
      const typingTarget = nodeElement?.querySelector(typingSelector) as HTMLInputElement | HTMLTextAreaElement | null;
      typingTarget?.click();
      typingTarget?.focus({ preventScroll: true });
      await new Promise((resolve) => window.setTimeout(resolve, 12));
    }
    setNodes((current) => current.map((item) => item.id === node.id ? {
      ...item,
      data: { ...finalData, tags: finalData.tags?.filter((tag) => tag !== "ai-ghost" && tag !== "ai-typing") },
    } : item));
    await new Promise((resolve) => window.setTimeout(resolve, 130));
  }, [capture, nodes, setEdges, setNodes]);

  const duplicateNode = useCallback((id: string) => {
    const original = nodes.find((node) => node.id === id);
    if (!original) return;
    capture();
    const copyId = safeId();
    setNodes((current) => [...current, { ...structuredClone(original), id: copyId, selected: false, position: { x: original.position.x + 36, y: original.position.y + 36 } }]);
    setSelectedId(copyId);
  }, [capture, nodes, setNodes]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target?.matches("input, textarea, [contenteditable='true']");
      if (event.key === "Escape") {
        setPendingConnection(null);
        setNodeMenuQuery("");
        return;
      }
      if (typing) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) redo(); else undo();
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "d" && selectedId) {
        event.preventDefault();
        duplicateNode(selectedId);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [duplicateNode, redo, selectedId, undo]);

  const onConnect = useCallback((connection: Connection) => {
    if (!connection.source || !connection.target) return;
    capture();
    const rect = canvasRef.current?.getBoundingClientRect();
    const bounds = { width: rect?.width || 600, height: rect?.height || 500 };
    const target = nodes.find((node) => node.id === connection.target);
    const flow = target ? { x: target.position.x, y: target.position.y } : { x: 360, y: 240 };
    setPendingConnection({
      source: connection.source,
      target: connection.target,
      flow,
      screen: clampNodeMenuPosition(bounds.width / 2, Math.min(bounds.height - 160, bounds.height / 2), bounds, NODE_MENU_WIDTH, 220),
    });
  }, [capture, nodes]);

  const addNode = (kind: NodeKind, title: string, body: string, resource?: StudyResource, position?: { x: number; y: number }, sourceNodeId?: string) => {
    capture();
    const id = safeId();
    setNodes((current) => [...current, {
      id,
      type: "study",
      position: position || { x: 180 + (current.length % 4) * 285, y: 140 + Math.floor(current.length / 4) * 210 },
      data: {
        kind,
        title,
        body,
        resourceId: resource?.id,
        sourceNodeId,
        sourceLabel: resource?.title,
        sourceUrl: resource?.url,
        sourceMode: resource?.kind === "youtube" ? "youtube" : resource?.kind === "web" ? "web" : undefined,
        sourceStatus: resource ? "ready" : undefined,
      },
    }]);
    if (sourceNodeId) {
      setEdges((current) => addEdge({
        id: safeId(),
        source: sourceNodeId,
        target: id,
        ...studyEdgeStyle(kind === "flashcards" ? "generates" : kind === "quiz" ? "tests" : "derived from"),
      }, current));
    }
    setSelectedId(id);
    return id;
  };

  const addRelationship = (relationship: string) => {
    if (!pendingConnection?.source || !pendingConnection.target) return;
    capture();
    setEdges((current) => addEdge({
      id: safeId(),
      source: pendingConnection.source,
      target: pendingConnection.target!,
      ...studyEdgeStyle(relationship),
    }, current));
    setPendingConnection(null);
  };

  const addConnectedNode = (kind: NodeKind, titleOverride?: string, bodyOverride?: string) => {
    if (!pendingConnection) return;
    const labels: Record<NodeKind, [string, string]> = {
      source: ["New source", "Attach a source from the resource panel."],
      note: ["Connected note", "Capture the thought that belongs here."],
      concept: ["Related concept", "Describe how this idea extends the map."],
      claim: ["New claim", "State the claim this connection should support."],
      evidence: ["Supporting evidence", "Add the evidence behind this connection."],
      question: ["Open question", "What should be investigated next?"],
      summary: ["Summary", "Summarise this branch of the map."],
      flashcards: ["Flashcards", "Turn this branch into recall prompts."],
      quiz: ["Practice", "Test the ideas connected here."],
      "study-plan": ["Study step", "Add the next action for this topic."],
    };
    const [defaultTitle, defaultBody] = labels[kind];
    const title = titleOverride || defaultTitle;
    const body = bodyOverride || defaultBody;
    const id = safeId();
    capture();
    setNodes((current) => [...current, { id, type: "study", position: pendingConnection.flow, data: { kind, title, body } }]);
    if (pendingConnection.source) {
      const edgeLabel = kind === "question" ? "raises" : kind === "source" ? "grounded in" : "connects to";
      setEdges((current) => addEdge({
        id: safeId(),
        source: pendingConnection.source!,
        target: id,
        ...studyEdgeStyle(edgeLabel),
      }, current));
    }
    setSelectedId(id);
    setPendingConnection(null);
  };

  const ingestUrl = async (overrideValue = "") => {
    const value = (overrideValue || sourceInput).trim();
    if (!value || addingSource) return;
    setAddingSource(true);
    setNotice("");
    const resource: StudyResource = { id: safeId(), kind: /youtu(?:be\.com|\.be)/i.test(value) ? "youtube" : /^https?:/i.test(value) ? "web" : "text", title: value.slice(0, 80), url: /^https?:/i.test(value) ? value : undefined, content: value, status: "processing", createdAt: Date.now() };
    setResources((current) => [resource, ...current]);
    setSourceInput("");
    try {
      if (resource.kind === "youtube") {
        const response = await fetch("/api/research/youtube", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: value, question: "Create a concise, source-grounded study summary with chapters and key concepts." }) });
        const payload = await response.json();
        if (!response.ok || !payload?.ok) throw new Error(payload?.error?.message || "The YouTube transcript was unavailable");
        resource.title = payload?.metadata?.title || "YouTube source";
        resource.content = payload.analysisPrompt || payload.full_text || value;
      } else if (resource.kind === "web") {
        const response = await fetch("/api/study/fetch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: value }) });
        const payload = await response.json();
        if (!response.ok || !payload?.ok) throw new Error(payload?.error || "The page could not be read");
        resource.title = payload.title || value;
        resource.content = payload.text || value;
      }
      resource.status = "ready";
      setResources((current) => current.map((item) => item.id === resource.id ? { ...resource } : item));
      addNode("source", resource.title, resource.content.slice(0, 480), resource);
      setComposerMode("ask");
    } catch (cause) {
      resource.status = "failed";
      resource.error = cause instanceof Error ? cause.message : String(cause);
      setResources((current) => current.map((item) => item.id === resource.id ? { ...resource } : item));
      setNotice(resource.error);
    } finally {
      setAddingSource(false);
    }
  };

  const ingestNodeUrl = async (nodeId: string, url: string) => {
    const value = url.trim();
    if (!value || addingSource) return;
    const isYoutube = /youtu(?:be\.com|\.be)/i.test(value);
    const isWeb = /^https?:\/\//i.test(value);
    if (!isYoutube && !isWeb) {
      setNotice("Enter a valid http(s) URL.");
      return;
    }
    if (isYoutube && !youtubeVideoId(value)) {
      setNotice("That does not look like a valid YouTube URL.");
      return;
    }
    setAddingSource(true);
    setNotice("");
    const mode: "youtube" | "web" = isYoutube ? "youtube" : "web";
    capture();
    updateNode(nodeId, { sourceUrl: value, sourceMode: mode, sourceStatus: "processing", sourceError: undefined, body: "" });
    const resource: StudyResource = { id: safeId(), kind: mode, title: value.slice(0, 80), url: value, content: value, status: "processing", createdAt: Date.now() };
    setResources((current) => [resource, ...current]);
    try {
      if (mode === "youtube") {
        const response = await fetch("/api/research/youtube", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: value, question: "Create a concise, source-grounded study summary with chapters and key concepts." }) });
        const payload = await response.json();
        if (!response.ok || !payload?.ok) throw new Error(payload?.error?.message || "The YouTube transcript was unavailable");
        resource.title = payload?.metadata?.title || "YouTube source";
        resource.content = payload.analysisPrompt || payload.full_text || value;
      } else {
        const response = await fetch("/api/study/fetch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: value }) });
        const payload = await response.json();
        if (!response.ok || !payload?.ok) throw new Error(payload?.error || "The page could not be read");
        resource.title = payload.title || value;
        resource.content = payload.text || value;
      }
      resource.status = "ready";
      setResources((current) => current.map((item) => item.id === resource.id ? { ...resource } : item));
      updateNode(nodeId, {
        title: resource.title,
        body: resource.content.slice(0, 480),
        resourceId: resource.id,
        sourceLabel: resource.title,
        sourceUrl: value,
        sourceMode: mode,
        sourceStatus: "ready",
        sourceError: undefined,
      });
    } catch (cause) {
      resource.status = "failed";
      resource.error = cause instanceof Error ? cause.message : String(cause);
      setResources((current) => current.map((item) => item.id === resource.id ? { ...resource } : item));
      updateNode(nodeId, { sourceStatus: "failed", sourceError: resource.error });
      setNotice(resource.error);
    } finally {
      setAddingSource(false);
    }
  };

  const ingestFiles = async (files: FileList | null) => {
    const connectFrom = pendingSourceRef.current;
    const dropFlow = pendingConnection?.flow;
    pendingSourceRef.current = null;
    for (const file of Array.from(files || [])) {
      const kind: ResourceKind = file.type.startsWith("image/") ? "image" : "document";
      let content = "";
      try { content = kind === "image" ? `Image resource: ${file.name}. Local visual extraction can be requested from Study Pal.` : (await file.text()).slice(0, 120_000); } catch { content = `Document resource: ${file.name}`; }
      const resource: StudyResource = { id: safeId(), kind, title: file.name, content, status: "ready", createdAt: Date.now() };
      setResources((current) => [resource, ...current]);
      const nodeId = addNode("source", file.name, content.slice(0, 480), resource, dropFlow);
      if (connectFrom && nodeId) {
        setEdges((current) => addEdge({
          id: safeId(),
          source: connectFrom,
          target: nodeId,
          ...studyEdgeStyle("grounded in"),
        }, current));
      }
    }
    setPendingConnection(null);
  };

  const buildFromPrompt = async (brief: string) => {
    const request = brief.trim();
    if (!request || asking) return;
    setAsking(true);
    setNotice("");
    setConversations((current) => [...current, { id: safeId(), role: "user", text: request }]);
    try {
      const starter = nodes.find((node) => node.data.tags?.includes("starter")) || nodes[0];
      const briefBody = [starter?.data.title, starter?.data.body, request].filter(Boolean).join("\n\n");
      const sourceUrls = Array.from(new Set(
        request.match(/https?:\/\/[^\s)\]}>,]+/gi)?.map((url) => url.replace(/[.,;:!?]+$/, "")) || [],
      ));
      const researchContext: GraphContextItem[] = [];
      for (const url of sourceUrls) {
        if (/youtu(?:be\.com|\.be)/i.test(url)) {
          try {
            const youtubeResponse = await fetch("/api/research/youtube", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url, preferredLanguages: ["en"], question: request }) });
            const youtubePayload = await youtubeResponse.json() as { ok?: boolean; analysisPrompt?: string; full_text?: string; metadata?: { title?: string } };
            if (youtubeResponse.ok && youtubePayload.ok) researchContext.push({ id: `research-${safeId()}`, title: youtubePayload.metadata?.title || "YouTube analysis", body: (youtubePayload.analysisPrompt || youtubePayload.full_text || "").slice(0, 12_000), source: url });
          } catch { /* The source node will show its own analyser error. */ }
        }
      }
      try {
        const searchResponse = await fetch("/api/research/web-search", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: request, maxResults: 6, fetchTop: 3 }) });
        const searchPayload = await searchResponse.json() as { ok?: boolean; analysisPrompt?: string; urls?: string[] };
        if (searchResponse.ok && searchPayload.ok && searchPayload.analysisPrompt) {
          researchContext.push({ id: `research-${safeId()}`, title: "Web research", body: searchPayload.analysisPrompt.slice(0, 12_000), source: (searchPayload.urls || []).slice(0, 6).join(", ") || "Web search" });
        }
      } catch { /* Study Pal can still use the supplied URL or brief. */ }
      const response = await fetch("/api/study/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: `Create a concise, source-grounded study-map foundation for: ${request}. Use the supplied research to produce four useful branches directly related to the request. Return exactly four lines in the format Branch title: one grounded sentence. If the user asked questions, make one branch answer the most important question. Do not invent unrelated concepts.`,
          mode: "plan",
          scope: "workspace",
          context: [{ id: starter?.id || "brief", title: starter?.data.title || "Workspace brief", body: briefBody, source: "User brief" }, ...researchContext],
        }),
      });
      const payload = await response.json() as { answer?: string; citations?: string[]; error?: string };
      if (!response.ok || !payload.answer) throw new Error(payload.error || "Study Pal could not build the map");
      const branches = payload.answer
        .split(/\n+/)
        .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").replace(/[*_#`]/g, "").trim())
        .filter((line) => {
          if (line.length < 12 || line.length > 220) return false;
          if (/^(here(?:'s| is)|below|sure|okay|i(?:'| a)ve|this (?:is|map)|study[- ]map foundation)/i.test(line)) return false;
          return /:/.test(line) || line.split(/\s+/).length <= 10 || /^\d+\./.test(line);
        })
        .slice(0, 4);
      const questionSection = request.match(/Questions?\s*:\s*(.*?)(?:\s+Sources?\s*:|$)/is)?.[1] || "";
      const requestedQuestions = Array.from(questionSection.matchAll(/[^?\n]{12,180}?\?/g))
        .map((match) => match[0]!.trim())
        .filter((question) => !/^https?:/i.test(question));
      while (branches.length < 4) {
        branches.push(["Core ideas and vocabulary", "Evidence and worked examples", "Common misconceptions", "Questions to practise"][branches.length]!);
      }
      const rootId = starter?.id || safeId();
      const rootPosition = starter?.position || { x: 360, y: 220 };
      const kinds: NodeKind[] = ["concept", "evidence", "note", "question"];
      const childNodes = branches.map((branch, index) => {
        const [heading, ...rest] = branch.split(/:\s*/);
        return {
          id: safeId(),
          type: "study" as const,
          position: {
            x: rootPosition.x + 430 + (index % 2) * 340,
            y: rootPosition.y - 210 + Math.floor(index / 2) * 285,
          },
        data: {
          kind: kinds[index]!,
          title: (heading || `Study branch ${index + 1}`).slice(0, 84),
          body: kinds[index] === "question"
            ? (requestedQuestions[0] || rest.join(": ") || branch).slice(0, 560)
            : (rest.join(": ") || branch).slice(0, 560),
        },
      } satisfies StudyNode;
      });
      capture();
      setNodes((current) => {
        if (starter) {
          return [
            ...current.map((node) => node.id !== starter.id ? node : {
              ...node,
              data: {
                ...node.data,
                title: node.data.title.trim() || (name.trim() || request).slice(0, 90),
                body: node.data.body.trim() || request,
              },
            }),
          ];
        }
        const root: StudyNode = {
          id: rootId,
          type: "study",
          position: rootPosition,
          data: { kind: "concept", title: request.slice(0, 90), body: request, tags: ["starter"] },
        };
        return [root, ...current];
      });
      setEdges((current) => current.filter((edge) => edge.source !== rootId || !childNodes.some((node) => node.id === edge.target)));
      for (let index = 0; index < childNodes.length; index += 1) {
        const node = childNodes[index]!;
        const edgeLabel = ["breaks into", "supported by", "remember", "raises"][index] || "connects to";
        await revealGeneratedNode(node, node.data, rootId, edgeLabel);
      }
      for (let index = 0; index < sourceUrls.length; index += 1) {
        const url = sourceUrls[index]!;
        const sourceNode: StudyNode = {
          id: safeId(),
          type: "study",
          position: {
            x: rootPosition.x - 420,
            y: rootPosition.y - 220 + index * 230,
          },
          data: {
            kind: "source",
            title: "",
            body: "",
            sourceUrl: url,
            sourceMode: /youtu(?:be\.com|\.be)/i.test(url) ? "youtube" : "web",
            tags: ["ai-source"],
          },
        };
        await revealGeneratedNode(sourceNode, sourceNode.data, rootId, "grounded by");
        await ingestNodeUrl(sourceNode.id, url);
      }
      setConversations((current) => [...current, { id: safeId(), role: "assistant", text: `I built a four-branch foundation${sourceUrls.length ? ` and connected ${sourceUrls.length} source${sourceUrls.length === 1 ? "" : "s"}` : ""}. You can now verify or expand any selected branch.`, citations: payload.citations }]);
      setSelectedId(rootId);
      window.setTimeout(() => void flowInstance?.fitView({ duration: 520, padding: 0.18 }), 50);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setNotice(message);
      setConversations((current) => [...current, { id: safeId(), role: "assistant", text: message }]);
    } finally {
      setAgentCursor(null);
      setAsking(false);
    }
  };

  const ask = async (
    mode: "answer" | "summary" | "flashcards" | "quiz" | "plan" = "answer",
    overrideQuestion = "",
    options?: { anchorId?: string | null },
  ) => {
    const question = overrideQuestion.trim() || prompt.trim() || (
      mode === "summary" ? "Summarise the selected evidence."
        : mode === "flashcards" ? "Create exactly 5 concise flashcards as numbered Q/A pairs."
          : mode === "quiz" ? "Create a practice quiz with multiple choice and short answer."
            : "Build a practical study plan."
    );
    if (!question || asking) return;
    if (studyLocked) {
      if (mode !== "answer") {
        setNotice("Add a ready source to generate this study view.");
        return;
      }
      const starter = nodes.find((node) => node.data.tags?.includes("starter"));
      if (starter) {
        capture();
        updateNode(starter.id, { body: question });
        setPrompt("");
        setNotice("Your brief is saved. Add a source to ground an AI answer.");
      }
      return;
    }
    const resolveAnchor = () => {
      if (options?.anchorId) return options.anchorId;
      if (mode === "flashcards") {
        return (
          (selectedId && nodes.find((node) => node.id === selectedId && node.data.kind === "flashcards")?.id)
          || nodes.find((node) => node.data.kind === "flashcards" && edges.some((edge) => edge.source === node.id || edge.target === node.id))?.id
          || null
        );
      }
      if (selectedId) return selectedId;
      return null;
    };
    const anchorId = resolveAnchor();
    const scopedModes = new Set(["flashcards", "quiz", "summary", "answer"]);
    const scoped = scopedModes.has(mode)
      ? buildScopedGraphContext(nodes, edges, anchorId)
      : { scopedToAttached: false, context: prioritizeGraphContext(nodes, edges) };
    let context = scoped.context.length
      ? enrichGraphContext(scoped.context, nodes, resources)
      : resources.slice(0, 8).map((resource) => ({
        id: resource.id,
        title: resource.title,
        body: resource.content.slice(0, 3_000),
        source: resource.url || resource.title,
      }));
    const scopedQuestion = scoped.scopedToAttached
      ? `${question}\n\nIMPORTANT: Only use nodes connected to the selected branch. Ignore unrelated workspace content.`
      : question;
    setAsking(true);
    setPrompt("");
    setConversations((current) => [...current, { id: safeId(), role: "user", text: scopedQuestion }]);
    try {
      const response = await fetch("/api/study/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: scopedQuestion,
          mode,
          scope: scoped.scopedToAttached ? "connected" : "workspace",
          context,
        }),
      });
      const payload = await response.json() as { ok?: boolean; answer?: string; citations?: string[]; error?: string };
      if (!response.ok || !payload.answer) throw new Error(payload.error || "Study Pal could not answer");
      setConversations((current) => [...current, { id: safeId(), role: "assistant", text: payload.answer!, citations: payload.citations }]);
      if (mode !== "answer") {
        if (mode === "flashcards" && anchorId && nodes.some((node) => node.id === anchorId && node.data.kind === "flashcards")) {
          updateNode(anchorId, {
            title: scoped.scopedToAttached ? "Flashcards (attached)" : "Flashcards",
            body: payload.answer,
          });
        } else {
          const groundingNodeId = anchorId
            || nodes.find((node) => node.data.kind === "source")?.id
            || nodes[0]?.id;
          addNode(
            mode === "flashcards" ? "flashcards" : mode === "quiz" ? "quiz" : "summary",
            mode === "flashcards"
              ? (scoped.scopedToAttached ? "Flashcards (attached)" : "Flashcards")
              : mode === "quiz" ? "Practice quiz" : "Generated summary",
            payload.answer,
            undefined,
            undefined,
            groundingNodeId,
          );
        }
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setConversations((current) => [...current, { id: safeId(), role: "assistant", text: message }]);
      setNotice(message);
    } finally {
      setAsking(false);
    }
  };

  const submitChatDraft = async () => {
    const value = chatDraft.trim();
    if (!value || asking) return;
    setChatDraft("");
    await ask("answer", value);
  };

  useEffect(() => {
    if (studyLocked || asking || !readyResourceCount) return;
    const readyKey = resources.filter((resource) => resource.status === "ready").map((resource) => resource.id).sort().join("|");
    if (!readyKey || backgroundStudyKeyRef.current === readyKey) return;
    const needsFlashcards = !nodes.some((node) => node.data.kind === "flashcards");
    const needsTest = !nodes.some((node) => node.data.kind === "quiz");
    if (!needsFlashcards && !needsTest) {
      backgroundStudyKeyRef.current = readyKey;
      return;
    }
    backgroundStudyKeyRef.current = readyKey;
    setFlashLoading(needsFlashcards);
    setTestLoading(needsTest);
    void (needsFlashcards ? ask("flashcards") : Promise.resolve())
      .then(() => needsTest ? ask("quiz") : undefined)
      .finally(() => {
        setFlashLoading(false);
        setTestLoading(false);
      });
  }, [asking, nodes, readyResourceCount, resources, studyLocked]);

  const submitDock = async () => {
    const value = prompt.trim();
    if (!value || asking || addingSource) return;
    setPrompt("");
    if (composerMode === "source") {
      await ingestUrl(value);
      return;
    }
    if (studyLocked) {
      await buildFromPrompt(value);
      return;
    }
    const anchor = selectedId || nodes.find((node) => node.data.kind === "source")?.id || nodes[0]?.id;
    const anchorNode = nodes.find((node) => node.id === anchor);
    const position = anchorNode
      ? { x: anchorNode.position.x + 360, y: anchorNode.position.y + 24 }
      : { x: 520, y: 260 };
    const questionNode: StudyNode = {
      id: safeId(),
      type: "study",
      position,
      data: { kind: "question", title: "Question", body: value },
    };
    await revealGeneratedNode(questionNode, questionNode.data, anchor || undefined, "asks");
    setSelectedId(questionNode.id);
    await answerQuestionNode(questionNode.id, value);
  };

  const openStudyView = (view: typeof studyView) => {
    const studyViews = ["nodes", "notes", "flashcards", "test", "chat"] as const;
    const currentIndex = studyViews.indexOf(studyView);
    const nextIndex = studyViews.indexOf(view);
    if (currentIndex !== nextIndex) setStudyViewDirection(nextIndex > currentIndex ? 1 : -1);
    setStudyView(view);
    if (view === "nodes") return;
    if (view !== "chat" && studyLocked) {
      setNotice("Add a ready source to generate this study view.");
      return;
    }
    if (view === "notes") {
      if (!notesContent) void regenerateNotes();
      return;
    }
    const nodeKind = view === "flashcards" ? "flashcards" : "quiz";
    if (!nodes.some((node) => node.data.kind === nodeKind)) {
      void ask(view === "flashcards" ? "flashcards" : "quiz");
    }
  };

  const buildGraphContext = useCallback(
    () => enrichGraphContext(prioritizeGraphContext(nodes, edges), nodes, resources),
    [edges, nodes, resources],
  );

  const nodeContext = useMemo(() => {
    const attached = selectedId ? connectedNodeIds(selectedId, edges) : null;
    const sourceNodes = nodes.filter((node) => node.data.kind === "source" && (!attached || attached.has(node.id)));
    const contextNodes = nodes.filter((node) => (!attached || attached.has(node.id)) && node.data.kind !== "flashcards" && node.data.kind !== "quiz" && node.data.kind !== "study-plan");
    return { sourceNodes, contextNodes, attached: Boolean(attached && attached.size > 1) };
  }, [edges, nodes, selectedId]);

  const notesHeading = useMemo(() => {
    const starter = nodes.find((node) => node.data.tags?.includes("starter"));
    const subject = cleanStudyText(starter?.data.title || name || "Study workspace").replace(/\s+(study|research)$/i, "");
    return subject ? `${subject} brief` : "Study brief";
  }, [name, nodes]);

  const graphFingerprint = useMemo(
    () => JSON.stringify({
      nodes: nodes.map((node) => [node.id, node.data.kind, node.data.title, node.data.body?.slice(0, 120)]),
      edges: edges.map((edge) => [edge.source, edge.target, edgeRelationship(edge)]),
    }),
    [edges, nodes],
  );

  const regenerateNotes = useCallback(async () => {
    if (studyLocked || notesLoading) return;
    setNotesLoading(true);
    try {
      const context = buildGraphContext();
      const question = `Write Meeting Notes style study notes for this workspace. Use clear headings. Include:
1) Source analysis for every YouTube/web node (transcript/page summary)
2) Direct answers wherever a Question/Open question is connected to a source (explain how the source answers it)
3) Claims supported or challenged by evidence
4) Key takeaways from connected groups
Follow a clean notes layout with ## headings and short paragraphs.`;
      const response = await fetch("/api/study/ask", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question, mode: "summary", scope: "workspace", context }) });
      const payload = await response.json() as { ok?: boolean; answer?: string; error?: string };
      if (!response.ok || !payload.answer) throw new Error(payload.error || "Could not generate notes");
      setNotesContent(compactStudyMarkdown(`${payload.answer.trim()}${explicitQuestionNotes(nodes, edges)}`));
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setNotesLoading(false);
    }
  }, [buildGraphContext, edges, nodes, notesLoading, studyLocked]);

  const answerQuestionNode = useCallback(async (nodeId: string, rawQuestion: string) => {
    const question = rawQuestion.trim();
    if (!question || asking) return;
    setAsking(true);
    updateNode(nodeId, { title: "Question", body: question, tags: ["answering"] });
    const scoped = buildScopedGraphContext(nodes, edges, nodeId);
    let context = scoped.context.length
      ? enrichGraphContext(scoped.context, nodes, resources)
      : resources.slice(0, 8).map((resource) => ({
        id: resource.id,
        title: resource.title,
        body: resource.content.slice(0, 3_000),
        source: resource.url || resource.title,
      }));
    try {
      const connectedYoutubeSources = nodes.filter((node) => {
        const connected = connectedNodeIds(nodeId, edges);
        return connected.has(node.id) && node.data.kind === "source" && node.data.sourceMode === "youtube" && Boolean(node.data.sourceUrl);
      });
      if (connectedYoutubeSources.length) {
        const youtubeResults = await Promise.allSettled(connectedYoutubeSources.map(async (source) => {
          const response = await fetch("/api/research/youtube", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url: source.data.sourceUrl, preferredLanguages: ["en"], question }),
          });
          const payload = await response.json() as { ok?: boolean; analysisPrompt?: string; full_text?: string; metadata?: { title?: string }; error?: { message?: string } };
          if (!response.ok || !payload.ok) throw new Error(payload.error?.message || "The YouTube transcript was unavailable");
          const analysed = payload.analysisPrompt || payload.full_text || "";
          if (analysed) updateNode(source.id, { body: analysed.slice(0, 480), title: payload.metadata?.title || source.data.title, sourceStatus: "ready", sourceError: undefined });
          return { id: source.id, title: `${source.data.title} (YouTube analysis)`, body: analysed.slice(0, 14_000), source: source.data.sourceUrl || "YouTube" };
        }));
        context = [...context, ...youtubeResults.flatMap((result) => result.status === "fulfilled" && result.value.body ? [result.value] : [])];
      }
      const response = await fetch("/api/study/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: `${question}\n\nAnswer this question using connected source nodes first. If a source is connected, explain the answer from that source.`,
          mode: "answer",
          scope: scoped.scopedToAttached ? "connected" : "workspace",
          context,
        }),
      });
      const payload = await response.json() as { ok?: boolean; answer?: string; citations?: string[]; error?: string };
      if (!response.ok || !payload.answer) throw new Error(payload.error || "Study Pal could not answer");
      const answer = payload.answer.trim();
      updateNode(nodeId, { title: "Question", body: `Question: ${question}\n\nAnswer: ${answer}`, tags: [] });
      setConversations((current) => [...current, { id: safeId(), role: "user", text: question }, { id: safeId(), role: "assistant", text: answer, citations: payload.citations }]);
      if (studyView === "notes") void regenerateNotes();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      updateNode(nodeId, { title: "Question", body: question, tags: [] });
      setNotice(message);
    } finally {
      setAsking(false);
    }
  }, [asking, edges, nodes, regenerateNotes, resources, studyLocked, studyView, updateNode]);

  useEffect(() => {
    if (studyLocked || asking) return;
    const candidate = nodes.find((node) => {
      if (node.data.kind !== "question" || autoAnsweredQuestionsRef.current.has(node.id)) return false;
      const parsed = questionParts(node.data.body);
      if (!parsed.question || parsed.answer) return false;
      const connected = connectedNodeIds(node.id, edges);
      return nodes.some((source) => connected.has(source.id) && source.data.kind === "source" && source.data.sourceStatus === "ready" && Boolean(source.data.body));
    });
    if (!candidate) return;
    const parsed = questionParts(candidate.data.body);
    autoAnsweredQuestionsRef.current.add(candidate.id);
    void answerQuestionNode(candidate.id, parsed.question);
  }, [answerQuestionNode, asking, edges, nodes, studyLocked]);

  useEffect(() => {
    if (studyLocked) return;
    const timer = window.setTimeout(() => {
      if (studyView === "notes") void regenerateNotes();
    }, 1_400);
    return () => window.clearTimeout(timer);
  }, [graphFingerprint, studyLocked, studyView, regenerateNotes]);

  const finishConnection = useCallback<OnConnectEnd<StudyNode>>((event, connectionState) => {
    if (connectionState.isValid || !connectionState.fromNode) return;
    const pointer = "changedTouches" in event ? event.changedTouches[0] : event;
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!pointer || !rect) return;
    const dropX = pointer.clientX - rect.left;
    const dropY = pointer.clientY - rect.top;
    const screen = clampNodeMenuPosition(dropX, dropY, { width: rect.width, height: rect.height });
    setPendingConnection({
      source: connectionState.fromNode.id,
      screen,
      flow: flowInstance?.screenToFlowPosition({ x: pointer.clientX, y: pointer.clientY }) || { x: dropX, y: dropY },
    });
  }, [flowInstance]);

  useEffect(() => {
    if (!pendingConnection) return;
    const closeMenu = (event: PointerEvent) => {
      if (nodeMenuRef.current?.contains(event.target as globalThis.Node)) return;
      setPendingConnection(null);
      setNodeMenuQuery("");
    };
    const timer = window.setTimeout(() => document.addEventListener("pointerdown", closeMenu), 0);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("pointerdown", closeMenu);
    };
  }, [pendingConnection]);
  const exportWorkspace = () => {
    const blob = new Blob([JSON.stringify({ ...workspace, name, nodes, edges, resources, conversations }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "study-workspace"}.json`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
  };
  const generatedViewKind: NodeKind | null = studyView === "flashcards" ? "flashcards" : studyView === "test" ? "quiz" : null;
  const generatedViewNodes = generatedViewKind ? nodes.filter((node) => node.data.kind === generatedViewKind) : [];
  const gradeTest = async () => {
    if (!generatedViewNodes.length || testSubmitting) return;
    setTestSubmitting(true);
    setTestScore(null);
    let correct = 0;
    for (const node of generatedViewNodes) {
      const answer = [practiceSelections[node.id], testAnswers[node.id]].filter(Boolean).join("\n");
      if (!answer.trim()) {
        setTestMarks((current) => ({ ...current, [node.id]: { correct: false, feedback: "No answer submitted. Compare your response with the source-grounded material below." } }));
        continue;
      }
      try {
        const response = await fetch("/api/study/ask", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            question: `Mark this student answer. Reply with CORRECT or INCORRECT on the first line, then concise feedback and a line beginning Sample answer:.\nQuestion: ${node.data.title}\nExpected material:\n${node.data.body}\nStudent answer:\n${answer}`,
            mode: "answer",
            scope: "workspace",
            context: buildGraphContext().slice(0, 8),
          }),
        });
        const payload = await response.json() as { answer?: string };
        const feedback = payload.answer || "The answer could not be graded.";
        const isCorrect = /^correct\b/i.test(feedback.trim());
        if (isCorrect) correct += 1;
        setTestMarks((current) => ({ ...current, [node.id]: { correct: isCorrect, feedback } }));
      } catch (cause) {
        setNotice(cause instanceof Error ? cause.message : String(cause));
      }
    }
    setTestScore({ correct, total: generatedViewNodes.length });
    setTestSubmitting(false);
  };
  const activeFlashDeck = useMemo(() => {
    if (!generatedViewNodes.length || studyView !== "flashcards") return null;
    return generatedViewNodes.find((node) => node.id === selectedId)
      || generatedViewNodes.find((node) => edges.some((edge) => edge.source === node.id || edge.target === node.id))
      || generatedViewNodes[0];
  }, [edges, generatedViewNodes, selectedId, studyView]);
  const flashDeckScoped = Boolean(
    activeFlashDeck && connectedNodeIds(activeFlashDeck.id, edges).size > 1,
  );
  const nodeMenuItems = useMemo(() => [
    { id: "text", label: "Text", detail: "Editable thought or note", kind: "note" as NodeKind, icon: Type },
    { id: "question", label: "Open question", detail: "Something to investigate", kind: "question" as NodeKind, icon: CircleHelp },
    { id: "takeaway", label: "Key takeaway", detail: "Capture the main insight", kind: "note" as NodeKind, icon: NotebookPen },
    { id: "flashcards", label: "Flashcards", detail: "Deck scoped to attached nodes", kind: "flashcards" as NodeKind, icon: LayoutGrid },
    { id: "youtube", label: "YouTube video", detail: "Paste a video and ground the map", kind: "source" as NodeKind, icon: Youtube, sourceMode: "youtube" as const },
    { id: "web", label: "Web page", detail: "Read and connect a live source", kind: "source" as NodeKind, icon: Globe2, sourceMode: "web" as const },
    { id: "document", label: "Document", detail: "Add notes, PDF, Markdown, or text", kind: "source" as NodeKind, icon: FileText },
  ], []);
  const filteredNodeMenuItems = useMemo(
    () => nodeMenuItems.filter((item) => fuzzyContains(`${item.label} ${item.detail}`, nodeMenuQuery)),
    [nodeMenuItems, nodeMenuQuery],
  );

  useEffect(() => setNodeMenuIndex(0), [nodeMenuQuery, pendingConnection?.screen.x, pendingConnection?.screen.y]);

  const selectNodeMenuItem = (item: (typeof nodeMenuItems)[number]) => {
    const sourceMode = "sourceMode" in item ? item.sourceMode : undefined;
    if (sourceMode === "youtube" || sourceMode === "web") {
      const id = safeId();
      const title = sourceMode === "youtube" ? "YouTube video" : "Web page";
      capture();
      setNodes((current) => [...current, {
        id,
        type: "study",
        position: pendingConnection?.flow || { x: 180 + (current.length % 4) * 285, y: 140 + Math.floor(current.length / 4) * 210 },
        data: {
          kind: "source",
          title,
          body: "",
          sourceMode,
          sourceUrl: "",
        },
      }]);
      if (pendingConnection?.source) {
        setEdges((current) => addEdge({
          type: "step",
          source: pendingConnection.source!,
          target: id,
          id: safeId(),
          label: "grounded in",
          labelStyle: { fill: "#6b7280", fontSize: 8, fontWeight: 600 },
          labelBgStyle: { fill: "rgba(255,254,250,.94)" },
          labelBgPadding: [5, 3],
          labelBgBorderRadius: 6,
          markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: "#111318" },
          style: { stroke: "#111318", strokeWidth: 1.6 },
          data: { relationship: "grounded in" },
        }, current));
      }
      setSelectedId(id);
      setPendingConnection(null);
      setNodeMenuQuery("");
      return;
    }
    if (item.id === "document") {
      pendingSourceRef.current = pendingConnection?.source || null;
      window.setTimeout(() => fileInput.current?.click(), 40);
      setPendingConnection(null);
      setNodeMenuQuery("");
      return;
    }
    addConnectedNode(item.kind);
  };

  const menuRelationships = ["supports", "explains", "challenges", "relates to"].filter((relationship) => fuzzyContains(relationship, nodeMenuQuery));
  const activeMenuLength = pendingConnection?.target ? menuRelationships.length : filteredNodeMenuItems.length;
  const agentCursorScreen = agentCursor && flowInstance && canvasRef.current
    ? (() => {
      const point = flowInstance.flowToScreenPosition({ x: agentCursor.x, y: agentCursor.y });
      const rect = canvasRef.current!.getBoundingClientRect();
      return { x: point.x - rect.left, y: point.y - rect.top, label: agentCursor.label };
    })()
    : null;
  const openFreeNodeMenu = () => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const screen = clampNodeMenuPosition(rect.width / 2, Math.max(120, rect.height - 280), { width: rect.width, height: rect.height });
    setPendingConnection({
      screen,
      flow: flowInstance?.screenToFlowPosition({ x: rect.left + screen.x, y: rect.top + screen.y }) || screen,
    });
  };

  return (
    <div className="relative h-full min-h-0 overflow-hidden bg-[#f5f3ef] text-[#30343a]">
      <input ref={fileInput} type="file" multiple accept=".txt,.md,.csv,.json,.pdf,image/*" className="hidden" onChange={(event) => void ingestFiles(event.target.files)} />
      <main ref={canvasRef} className="absolute inset-0 overflow-hidden">
        <StudyNodeActions.Provider value={{ buildFromPrompt: (value) => void buildFromPrompt(value), capture, updateNode, duplicateNode, ingestNodeUrl: (nodeId, url) => void ingestNodeUrl(nodeId, url), answerQuestionNode: (nodeId, question) => void answerQuestionNode(nodeId, question), workspaceName: name, workspaceDescription: workspace.description }}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onInit={setFlowInstance}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onConnectEnd={finishConnection}
            onNodeClick={(_, node) => setSelectedId(node.id)}
            onNodeDragStart={capture}
            onEdgeClick={(_, edge) => {
              if (canvasTool !== "cut") return;
              capture();
              setEdges((current) => current.filter((item) => item.id !== edge.id));
            }}
            onPaneClick={() => { setSelectedId(""); setPendingConnection(null); setNodeMenuQuery(""); }}
            panOnDrag={canvasTool === "pan"}
            nodesDraggable={canvasTool !== "pan"}
            selectionOnDrag={canvasTool === "select"}
            panOnScroll
            fitView
            fitViewOptions={{ padding: 0.22, minZoom: 0.25, maxZoom: 1.08, duration: 0 }}
            minZoom={0.2}
            maxZoom={1.8}
            onlyRenderVisibleElements
            deleteKeyCode={["Backspace", "Delete"]}
            connectionLineStyle={{ stroke: "#111318", strokeWidth: 1.8 }}
            defaultEdgeOptions={{ type: "step", style: { stroke: "#111318", strokeWidth: 1.6 }, markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: "#111318" } }}
            proOptions={{ hideAttribution: true }}
          >
            <Background color="#d6d2cb" gap={28} size={1.15} />
          </ReactFlow>
        </StudyNodeActions.Provider>

        {studyLocked && !nodes.length ? (
          <section className="pointer-events-none absolute inset-0 z-10 grid place-items-center px-6 pb-24 pt-20">
            <div className="pointer-events-auto w-full max-w-[430px] rounded-[24px] border border-white/90 bg-white/88 p-7 text-center shadow-[0_20px_70px_rgba(15,23,42,.1)] backdrop-blur-xl">
              <div className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-slate-950 text-white"><FolderOpen className="h-5 w-5" /></div>
              <h2 className="mt-5 text-[18px] font-semibold text-slate-950">Add your first source</h2>
              <p className="mx-auto mt-2 max-w-[320px] text-[10px] leading-5 text-slate-500">Study Pal stays empty until it has something grounded to work from. Add a file, paste text, or connect a webpage or YouTube video.</p>
              <button type="button" onClick={() => { setComposerMode("source"); setCommandDockOpen(true); }} className="mt-5 inline-flex h-10 items-center gap-2 rounded-xl bg-slate-950 px-4 text-[9px] font-semibold text-white transition-colors hover:bg-slate-800"><Plus className="h-3.5 w-3.5" />Add a source</button>
            </div>
          </section>
        ) : null}

        <AnimatePresence>
          {welcomeOpen && studyView === "nodes" ? (
            <motion.aside
              initial={{ opacity: 0, y: -8, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -6, scale: 0.98 }}
              className="pointer-events-auto absolute left-5 top-[76px] z-20 w-[min(332px,calc(100vw-40px))] overflow-hidden rounded-[20px] border border-white/90 bg-white/94 shadow-[0_20px_60px_rgba(15,23,42,.14)] backdrop-blur-xl"
            >
              <div className="flex items-start gap-3 border-b border-slate-100 bg-gradient-to-r from-blue-50 via-white to-white px-4 py-3.5">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-slate-950 text-white shadow-[0_8px_18px_rgba(15,23,42,.14)]"><Sparkles className="h-4 w-4" /></span>
                <div className="min-w-0 pr-5"><p className="text-[8px] font-semibold uppercase tracking-[.14em] text-blue-600">Study Pal guide</p><h2 className="mt-1 text-[14px] font-semibold text-slate-950">Build a connected map</h2></div>
                <button type="button" onClick={() => setWelcomeOpen(false)} aria-label="Close workspace welcome" title="Close" className="absolute right-2.5 top-2.5 grid h-7 w-7 place-items-center rounded-full text-slate-400 transition-colors hover:bg-white hover:text-slate-700"><X className="h-3.5 w-3.5" /></button>
              </div>
              <div className="p-4"><p className="text-[9px] leading-4 text-slate-500">Add a source, connect a question, and let Clyra carry the evidence into every study view.</p>
                <div className="mt-4 space-y-2"><div className="flex items-center gap-3 rounded-xl border border-blue-100 bg-blue-50/60 px-3 py-2.5"><span className="grid h-6 w-6 place-items-center rounded-full bg-blue-600 text-[9px] font-bold text-white">1</span><div><p className="text-[9px] font-semibold text-slate-800">Add a source</p><p className="text-[8px] text-slate-500">Web, YouTube, or a file</p></div></div><div className="flex items-center gap-3 rounded-xl border border-slate-100 bg-slate-50/70 px-3 py-2.5"><span className="grid h-6 w-6 place-items-center rounded-full bg-white text-[9px] font-bold text-slate-700 shadow-sm">2</span><div><p className="text-[9px] font-semibold text-slate-800">Connect the ideas</p><p className="text-[8px] text-slate-500">Drag from a node handle</p></div></div><div className="flex items-center gap-3 rounded-xl border border-slate-100 bg-slate-50/70 px-3 py-2.5"><span className="grid h-6 w-6 place-items-center rounded-full bg-white text-[9px] font-bold text-slate-700 shadow-sm">3</span><div><p className="text-[9px] font-semibold text-slate-800">Ask Clyra</p><p className="text-[8px] text-slate-500">Answers update the map</p></div></div></div>
              </div>
            </motion.aside>
          ) : null}
        </AnimatePresence>

        <AnimatePresence mode="wait">
          {studyView !== "nodes" ? (
            <motion.section
              key={studyView}
              custom={studyViewDirection}
              variants={{
                enter: (direction: number) => ({ opacity: 0, x: direction > 0 ? 42 : -42 }),
                center: { opacity: 1, x: 0 },
                exit: (direction: number) => ({ opacity: 0, x: direction > 0 ? -30 : 30 }),
              }}
              initial="enter"
              animate="center"
              exit="exit"
              transition={{ duration: 0.34, ease: [0.22, 1, 0.36, 1] }}
              className={cn("absolute inset-0 z-[12] bg-[#f7f8fa] px-4 pt-24 sm:px-5", studyView === "notes" ? "overflow-hidden pb-4" : "overflow-y-auto pb-32")}
            >
              <div className={cn("mx-auto max-w-[1180px]", studyView === "notes" && "flex h-full min-h-0 max-w-[1180px] flex-col")}>
                {studyView === "chat" ? (
                  <div className="grid min-h-full gap-6 lg:grid-cols-[minmax(0,1fr)_280px]">
                    <div className="flex min-h-[calc(100vh-150px)] flex-col">
                      <div className="mb-5 flex items-end justify-between"><div><p className="text-[9px] font-semibold uppercase tracking-[.14em] text-blue-600">Study Pal chat</p><h2 className="mt-1 text-[26px] font-semibold tracking-[-.025em] text-slate-950">Ask about your map</h2><p className="mt-1 text-[10px] text-slate-500">Fresh conversation, grounded in the connected nodes.</p></div></div>
                      <div className="flex-1 space-y-5">
                        {conversations.map((msg) => (
                          <div key={msg.id} className={cn("flex", msg.role === "user" ? "justify-end" : "justify-start")}>
                            <div className={cn("max-w-[88%]", msg.role === "user" ? "clyra-chat-user-bubble rounded-[24px] rounded-br-md border border-slate-200/70 bg-slate-950 px-5 py-3.5 text-white shadow-none" : "clyra-assistant-message max-w-[94%] px-1 py-2 text-slate-700")}>
                              <p className={cn("text-[8px] font-semibold uppercase tracking-[.12em]", msg.role === "user" ? "text-slate-300" : "text-blue-600")}>{msg.role === "user" ? "You" : "Clyra"}</p>
                              {msg.role === "assistant" ? <MarkdownMessageContent content={msg.text} codePresentation="soft" /> : <p className="mt-2 whitespace-pre-wrap text-[11px] leading-5">{cleanStudyText(msg.text)}</p>}
                              {msg.citations && msg.citations.length > 0 ? <div className="mt-2 flex flex-wrap gap-1">{msg.citations.map((citation, idx) => <span key={idx} className="text-[8px] text-blue-600">[{idx + 1}] {citation}</span>)}</div> : null}
                            </div>
                          </div>
                        ))}
                        {!conversations.length ? <p className="py-16 text-center text-[11px] text-slate-400">Ask Clyra about the sources and connections in your map.</p> : null}
                      </div>
                      <div className="input-wrapper sticky bottom-0 z-20 mt-6 flex items-end gap-2 rounded-[26px] border border-slate-200/80 bg-white/90 p-2 shadow-[0_18px_50px_rgba(15,23,42,.10)] backdrop-blur-xl">
                        <textarea value={chatDraft} onChange={(event) => setChatDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void submitChatDraft(); } }} placeholder="Ask Clyra anything..." rows={1} className="min-h-10 max-h-28 min-w-0 flex-1 resize-none rounded-[20px] bg-transparent px-3 py-2.5 text-[11px] leading-5 text-slate-800 outline-none placeholder:text-slate-400" aria-label="Ask Clyra anything..." />
                        <button type="button" onClick={() => void submitChatDraft()} disabled={!chatDraft.trim() || asking} aria-label="Send message" className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-slate-950 text-white transition-transform hover:-translate-y-0.5 disabled:opacity-35"><Send className="h-4 w-4" /></button>
                      </div>
                    </div>
                    <aside className="h-fit rounded-[22px] border border-slate-200/90 bg-white p-5 shadow-[0_16px_44px_rgba(15,23,42,.07)]">
                      <div className="flex items-start justify-between gap-3"><div><p className="text-[8px] font-semibold uppercase tracking-[.14em] text-blue-600">Live context</p><h3 className="mt-1 text-[15px] font-semibold text-slate-950">Connected map</h3></div><span className="grid h-8 w-8 place-items-center rounded-full bg-blue-50 text-blue-600"><Sparkles className="h-3.5 w-3.5" /></span></div>
                      <p className="mt-3 rounded-xl bg-slate-50 p-3 text-[9px] leading-4 text-slate-500">{nodeContext.attached ? "Focused on the selected node and its connected path." : "Using the whole workspace until you select a node."}</p>
                      <div className="mt-5 space-y-3">
                        {nodeContext.contextNodes.slice(0, 6).map((node) => <div key={node.id} className="rounded-xl border border-slate-100 bg-white p-3"><p className="text-[9px] font-semibold text-slate-700">{cleanStudyText(node.data.title || node.data.kind)}</p><p className="mt-1 line-clamp-3 text-[8px] leading-4 text-slate-400">{cleanStudyText(node.data.body || node.data.sourceUrl || "Empty node")}</p></div>)}
                        {!nodeContext.contextNodes.length ? <p className="text-[9px] text-slate-400">No nodes selected yet.</p> : null}
                      </div>
                      <div className="mt-5 border-t border-slate-100 pt-4"><p className="text-[8px] font-semibold uppercase tracking-[.14em] text-slate-400">Sources</p><div className="mt-2 space-y-2">{nodeContext.sourceNodes.slice(0, 4).map((node) => <p key={node.id} className="truncate text-[8px] text-blue-600">{cleanStudyText(node.data.title || node.data.sourceUrl || "Source")}</p>)}</div></div>
                    </aside>
                  </div>
                ) : null}
                {studyView === "notes" ? (
                  <div className="flex h-full min-h-0 flex-col">
                    <div className="mb-4 flex shrink-0 items-end justify-between">
                      <div><p className="text-[9px] font-semibold uppercase tracking-[.14em] text-blue-600">AI-generated study brief</p><h2 className="mt-1 text-[26px] font-semibold tracking-[-.025em] text-slate-950">{notesHeading}</h2><p className="mt-1 text-[10px] text-slate-500">Compact notes that update as your connected evidence changes.</p></div>
                      <button type="button" onClick={() => void regenerateNotes()} disabled={notesLoading || studyLocked} className="flex h-9 items-center gap-2 rounded-full border border-slate-200 bg-white px-3.5 text-[9px] font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-40">{notesLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}Refresh</button>
                    </div>
                    {notesLoading && !notesContent ? (
                      <div className="space-y-3 rounded-[22px] border border-slate-200 bg-white p-6 shadow-[0_12px_40px_rgba(15,23,42,.06)]">
                        {[0.92, 0.74, 0.86, 0.58, 0.8, 0.66].map((width, index) => (
                          <div key={index} className="agent-soft-shimmer h-4 overflow-hidden rounded-md bg-slate-100" style={{ width: `${width * 100}%` }}>
                            <motion.span className="block h-full w-1/2 bg-gradient-to-r from-transparent via-white to-transparent" animate={{ x: ["-120%", "220%"] }} transition={{ repeat: Infinity, duration: 1.15, ease: "linear", delay: index * 0.06 }} />
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="min-h-0 flex-1 overflow-y-auto rounded-[20px]">
                        <DocumentCardUI content={notesContent || "# Notes\n\nAdd sources and connect nodes — notes will generate here."} onContentChange={setNotesContent} />
                      </div>
                    )}
                  </div>
                ) : null}

                {studyView === "flashcards" ? (
                  <div>
                    <div className="mb-4 flex items-end justify-between">
                      <div>
                        <p className="text-[9px] font-semibold uppercase tracking-[.14em] text-slate-400">Recall deck</p>
                        <h2 className="mt-1 text-[22px] font-semibold tracking-[-.02em] text-slate-950">Flashcards</h2>
                        <p className="mt-1 text-[9px] text-slate-400">
                          {flashDeckScoped ? "Scoped to nodes attached to the flashcards node" : "Using the whole workspace"}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          setFlashLoading(true);
                          void ask("flashcards", "", { anchorId: activeFlashDeck?.id || null }).finally(() => setFlashLoading(false));
                        }}
                        disabled={asking || studyLocked}
                        className="flex h-9 items-center gap-2 rounded-full border border-slate-200 bg-white px-3.5 text-[9px] font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-40"
                      >
                        {asking || flashLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                        Regenerate
                      </button>
                    </div>
                    {flashLoading || (asking && !activeFlashDeck) ? (
                      <div className="relative mx-auto flex h-[280px] max-w-[640px] items-center justify-center">
                        {[0, 1, 2, 3, 4].map((index) => (
                          <motion.div
                            key={index}
                            className="agent-soft-shimmer absolute h-[190px] w-[140px] rounded-[18px] border border-white/80 bg-gradient-to-br from-slate-100 to-slate-200 shadow-[0_16px_40px_rgba(15,23,42,.12)]"
                            animate={{
                              x: [0, -(index * 2), 0, (index - 2) * 52, (index - 2) * 52],
                              y: [index * 2, index * 2, 0, (index % 2 ? 1 : -1) * 8, 0],
                              rotate: [(index - 2) * 3, (index - 2) * 3, 0, (index - 2) * 7, 0],
                              scale: [1, 1, 1.04, 1, 1],
                            }}
                            transition={{ repeat: Infinity, duration: 3.2, times: [0, 0.22, 0.48, 0.7, 1], ease: [0.22, 1, 0.36, 1], delay: index * 0.12 }}
                          />
                        ))}
                      </div>
                    ) : (
                      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                        {(activeFlashDeck ? parseFlashcardPairs(activeFlashDeck.data.body).slice(0, 8) : []).map((card, index) => {
                          const { front, back } = card;
                          const id = `${activeFlashDeck?.id}-${index}`;
                          const flipped = flippedCards.has(id);
                          return (
                            <motion.button
                              key={id}
                              type="button"
                              initial={{ opacity: 0, y: 16, rotate: (index - 2) * 6, scale: 0.9 }}
                              animate={{ opacity: 1, y: 0, rotate: 0, scale: 1 }}
                              transition={{ delay: index * 0.05, type: "spring", stiffness: 420, damping: 28 }}
                              onClick={() => setFlippedCards((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; })}
                              style={{ perspective: 900 }}
                              className="min-h-[170px] overflow-hidden rounded-[18px] border border-slate-200 bg-white p-0 text-left shadow-[0_10px_30px_rgba(15,23,42,.06)] transition-transform active:scale-[.99]"
                            >
                              <div className="relative min-h-[170px] w-full transition-transform duration-500 [transform-style:preserve-3d]" style={{ transform: flipped ? "rotateY(180deg)" : "rotateY(0deg)" }}>
                                <div className="absolute inset-0 p-5 [backface-visibility:hidden]">
                                  <p className="text-[8px] font-semibold uppercase tracking-[.12em] text-slate-400">Question</p>
                                  <h3 className="mt-4 text-[13px] font-semibold leading-5 text-slate-900">{cleanStudyText(front)}</h3>
                                </div>
                                <div className="absolute inset-0 bg-slate-950 p-5 text-white [backface-visibility:hidden]" style={{ transform: "rotateY(180deg)" }}>
                                  <p className="text-[8px] font-semibold uppercase tracking-[.12em] text-blue-300">Answer</p>
                                  <h3 className="mt-4 text-[13px] font-semibold leading-5">{cleanStudyText(back)}</h3>
                                </div>
                              </div>
                            </motion.button>
                          );
                        })}
                        {!activeFlashDeck ? <p className="col-span-full py-16 text-center text-[11px] text-slate-400">Cards will appear once sources are connected.</p> : null}
                      </div>
                    )}
                  </div>
                ) : null}

                {studyView === "test" ? (
                  <div>
                    <div className="mb-4 flex items-end justify-between">
                      <div><p className="text-[9px] font-semibold uppercase tracking-[.14em] text-slate-400">Interactive</p><h2 className="mt-1 text-[22px] font-semibold tracking-[-.02em] text-slate-950">Test</h2></div>
                      <button type="button" onClick={() => { setTestLoading(true); void ask("quiz").finally(() => setTestLoading(false)); }} disabled={asking || studyLocked} className="flex h-9 items-center gap-2 rounded-full border border-slate-200 bg-white px-3.5 text-[9px] font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-40">{asking || testLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}New test</button>
                    </div>
                    {testLoading || (asking && !generatedViewNodes.length) ? (
                      <div className="space-y-4 rounded-[22px] border border-slate-200 bg-white p-6">
                        {[0.88, 0.7, 0.94, 0.62, 0.78].map((width, index) => (
                          <div key={index} className="space-y-2">
                            <div className="agent-soft-shimmer h-5 overflow-hidden rounded-md bg-slate-100" style={{ width: `${width * 100}%` }}>
                              <motion.span className="block h-full w-1/2 bg-gradient-to-r from-transparent via-white to-transparent" animate={{ x: ["-120%", "220%"] }} transition={{ repeat: Infinity, duration: 1.1, ease: "linear", delay: index * 0.05 }} />
                            </div>
                            <div className="grid gap-2 sm:grid-cols-2">
                              {[0, 1, 2, 3].map((option) => <div key={option} className="agent-soft-shimmer h-9 rounded-xl bg-slate-50" />)}
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="space-y-4">
                        <div className="flex items-center justify-between rounded-[18px] border border-slate-200 bg-white px-5 py-4 shadow-[0_10px_30px_rgba(15,23,42,.05)]">
                          <div><p className="text-[8px] font-semibold uppercase tracking-[.12em] text-slate-400">Ready when you are</p><p className="mt-1 text-[11px] font-semibold text-slate-800">Answer every question, then submit once for an AI review.</p></div>
                          <button type="button" onClick={() => void gradeTest()} disabled={testSubmitting} className="flex h-9 items-center gap-2 rounded-full bg-slate-950 px-4 text-[9px] font-semibold text-white transition-transform hover:-translate-y-0.5 disabled:opacity-50">{testSubmitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}Submit test</button>
                        </div>
                        {testScore ? (
                          <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="flex items-center gap-5 rounded-[20px] border border-blue-100 bg-white p-5 shadow-[0_16px_40px_rgba(37,99,235,.10)]">
                            <div className="relative grid h-20 w-20 shrink-0 place-items-center rounded-full" style={{ background: `conic-gradient(#2563eb ${(testScore.correct / Math.max(1, testScore.total)) * 360}deg, #e2e8f0 0deg)` }}><div className="grid h-14 w-14 place-items-center rounded-full bg-white text-center"><span className="text-[15px] font-semibold text-slate-950">{Math.round((testScore.correct / Math.max(1, testScore.total)) * 100)}%</span></div></div>
                            <div><p className="text-[8px] font-semibold uppercase tracking-[.12em] text-blue-600">AI review complete</p><h3 className="mt-1 text-[17px] font-semibold text-slate-950">{testScore.correct} of {testScore.total} correct</h3><p className="mt-1 text-[10px] leading-5 text-slate-500">Your answer highlights and sample answers are shown below.</p></div>
                          </motion.div>
                        ) : null}
                        {generatedViewNodes.map((node, index) => {
                          const items = splitStudyItems(node.data.body);
                          const options = items.filter((item) => /^[A-D][.)]\s/i.test(item)).map(cleanStudyText);
                          const shortPrompt = cleanStudyText(items.find((item) => !/^[A-D][.)]\s/i.test(item)) || node.data.title);
                          const mark = testMarks[node.id];
                          return (
                            <article key={node.id} className="rounded-[18px] border border-slate-200 bg-white p-5 shadow-[0_10px_30px_rgba(15,23,42,.05)]">
                              <p className="text-[8px] font-semibold uppercase tracking-[.12em] text-slate-400">Question {index + 1}</p>
                              <h3 className="mt-2 text-[14px] font-semibold text-slate-900">{cleanStudyText(node.data.title)}</h3>
                              <p className="mt-2 text-[10px] leading-5 text-slate-600">{shortPrompt}</p>
                              <div className="mt-4 space-y-2">
                                {options.map((option) => (
                                  <button key={option} type="button" onClick={() => setPracticeSelections((current) => ({ ...current, [node.id]: option }))} className={cn("w-full rounded-xl border px-3 py-2.5 text-left text-[10px] transition-colors", practiceSelections[node.id] === option ? testScore && mark ? mark.correct ? "border-emerald-500 bg-emerald-50 text-emerald-800" : "border-rose-500 bg-rose-50 text-rose-800" : "border-blue-500 bg-blue-50 text-blue-800" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50")}>{option}</button>
                                ))}
                              </div>
                              <textarea
                                aria-label={`Short answer ${index + 1}`}
                                value={testAnswers[node.id] || ""}
                                onChange={(event) => setTestAnswers((current) => ({ ...current, [node.id]: event.target.value }))}
                                placeholder="Short-answer response..."
                                className="mt-4 min-h-16 w-full resize-none rounded-xl border border-slate-200 bg-slate-50/80 p-3 text-[10px] outline-none focus:border-blue-300 focus:ring-4 focus:ring-blue-50"
                              />
                              {mark ? <div className={cn("mt-4 rounded-[14px] border p-3", mark.correct ? "border-emerald-200 bg-emerald-50/70" : "border-rose-200 bg-rose-50/70")}><p className={cn("text-[9px] font-semibold", mark.correct ? "text-emerald-700" : "text-rose-700")}>{mark.correct ? "Correct answer" : "Needs another look"}</p><div className="mt-3 grid gap-3 lg:grid-cols-[minmax(0,1fr)_150px]"><div><p className="text-[8px] font-semibold uppercase tracking-[.12em] text-slate-400">Your answer</p><p className={cn("mt-1 whitespace-pre-wrap rounded-lg border px-2.5 py-2 text-[9px] leading-4", mark.correct ? "border-emerald-200 bg-emerald-100/70 text-emerald-900" : "border-rose-200 bg-rose-100/70 text-rose-900")}>{[practiceSelections[node.id], testAnswers[node.id]].filter(Boolean).join("\n") || "No answer submitted"}</p><p className="mt-2 text-[8px] font-semibold uppercase tracking-[.12em] text-slate-400">Sample answer</p><p className="mt-1 whitespace-pre-wrap text-[9px] leading-4 text-slate-600">{mark.feedback?.replace(/^\s*(?:CORRECT|INCORRECT)\s*/i, "").trim() || "Review the connected source material."}</p></div><aside className="rounded-lg border border-white/80 bg-white/70 p-2.5"><p className="text-[8px] font-semibold uppercase tracking-[.12em] text-slate-400">Clyra's comment</p><p className="mt-1 text-[9px] leading-4 text-slate-600">{mark.correct ? "Clear and grounded." : "Look for the key idea in the source."}</p></aside></div></div> : null}
                            </article>
                          );
                        })}
                        {!generatedViewNodes.length ? <p className="py-16 text-center text-[11px] text-slate-400">Connect sources to generate a test.</p> : null}
                      </div>
                    )}
                  </div>
                ) : null}
              </div>
            </motion.section>
          ) : null}
        </AnimatePresence>

        <button type="button" onClick={onBack} className="absolute left-4 top-4 z-30 flex h-10 items-center gap-2 rounded-[14px] border border-[#dedbd5] bg-[#fffefa]/95 px-3.5 text-[9px] font-semibold shadow-[0_8px_24px_rgba(48,52,58,.06)] transition-[background,transform] hover:bg-white active:scale-[.98]"><LayoutGrid className="h-4 w-4" />Workspaces</button>
        <motion.div
          className="clyra-workflow-tabs absolute left-1/2 top-4 z-30 flex -translate-x-1/2 items-center rounded-full border border-slate-200/80 bg-white/95 p-1 shadow-[0_10px_32px_rgba(15,23,42,.10)] backdrop-blur-xl sm:top-6"
          initial={{ y: -14, opacity: 0 }}
          animate={{ y: globalTabsVisible ? 48 : 0, opacity: 1 }}
          transition={{ type: "spring", stiffness: 360, damping: 32, mass: 0.35 }}
          style={{ position: "absolute" }}
          onPointerLeave={() => setHoveredStudyTab(null)}
        >
          <AnimatePresence>
            {hoveredStudyTab ? (
              <motion.div
                className="clyra-workflow-tab__hover pointer-events-none absolute bottom-1 top-1 rounded-full"
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1, x: `${(["nodes", "notes", "flashcards", "test", "chat"] as const).indexOf(hoveredStudyTab) * 100}%` }}
                exit={{ opacity: 0, scale: 0.95 }}
                transition={{ type: "spring", stiffness: 520, damping: 38, mass: 0.2 }}
                style={{ left: 4, width: "calc((100% - 8px) / 5)" }}
              />
            ) : null}
          </AnimatePresence>
          {(["nodes", "notes", "flashcards", "test", "chat"] as const).map((view) => (
            <button
              key={view}
              type="button"
              onMouseEnter={() => setHoveredStudyTab(view)}
              onFocus={() => setHoveredStudyTab(view)}
              onClick={() => openStudyView(view)}
              className={cn(
                "clyra-workflow-tab relative z-10 h-8 rounded-full px-3.5 text-[9px] font-semibold transition-colors",
                studyView === view ? "clyra-workflow-tab--active text-slate-950" : "text-slate-500 hover:text-slate-800",
              )}
            >
              {studyView === view ? <motion.span layoutId="study-tab" className="absolute inset-0 -z-10 rounded-full bg-white shadow-sm" transition={{ type: "spring", stiffness: 520, damping: 38 }} /> : null}
              {view === "nodes" ? "Canvas" : view === "notes" ? "Notes" : view === "flashcards" ? "Flashcards" : view === "test" ? "Test" : "Chat"}
            </button>
          ))}
        </motion.div>
        <div className="absolute right-4 top-4 z-30 flex items-center rounded-[14px] border border-[#dedbd5] bg-[#fffefa]/95 p-1 shadow-[0_8px_24px_rgba(48,52,58,.06)]">
          <button type="button" onClick={undo} title="Undo" className="grid h-8 w-8 place-items-center rounded-[10px] text-slate-500 hover:bg-[#efede8]"><Undo2 className="h-3.5 w-3.5" /></button>
          <button type="button" onClick={redo} title="Redo" className="grid h-8 w-8 place-items-center rounded-[10px] text-slate-500 hover:bg-[#efede8]"><Redo2 className="h-3.5 w-3.5" /></button>
          <button type="button" onClick={exportWorkspace} title="Export workspace" className="grid h-8 w-8 place-items-center rounded-[10px] text-slate-500 hover:bg-[#efede8]"><Upload className="h-3.5 w-3.5 rotate-180" /></button>
        </div>

        <AnimatePresence>
          {pendingConnection ? (
            <motion.div
              ref={nodeMenuRef}
              initial={{ opacity: 0, y: 6, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 4, scale: 0.99 }}
              transition={{ duration: 0.14, ease: [0.2, 0.82, 0.2, 1] }}
              style={{
                left: pendingConnection.screen.x,
                top: pendingConnection.screen.y,
                width: NODE_MENU_WIDTH,
              }}
              className="absolute z-40 max-h-[min(360px,62vh)] -translate-x-1/2 overflow-hidden rounded-2xl border border-slate-200/90 bg-white shadow-[0_12px_36px_rgba(15,23,42,.1)]"
            >
              <div className="relative h-10 border-b border-slate-100">
                <Search className="absolute left-3.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                <input
                  autoFocus
                  value={nodeMenuQuery}
                  onChange={(event) => setNodeMenuQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "ArrowDown") {
                      event.preventDefault();
                      setNodeMenuIndex((index) => Math.min(Math.max(0, activeMenuLength - 1), index + 1));
                    } else if (event.key === "ArrowUp") {
                      event.preventDefault();
                      setNodeMenuIndex((index) => Math.max(0, index - 1));
                    } else if (event.key === "Enter") {
                      event.preventDefault();
                      if (pendingConnection.target) {
                        const relationship = menuRelationships[nodeMenuIndex];
                        if (relationship) addRelationship(relationship);
                      } else {
                        const item = filteredNodeMenuItems[nodeMenuIndex];
                        if (item) selectNodeMenuItem(item);
                      }
                    } else if (event.key === "Escape") {
                      setPendingConnection(null);
                      setNodeMenuQuery("");
                    }
                  }}
                  placeholder="Search..."
                  className="h-full w-full bg-transparent pl-10 pr-3 text-[11px] text-slate-800 outline-none placeholder:text-slate-400"
                />
              </div>
              <div className="max-h-[300px] overflow-y-auto p-1.5">
                {pendingConnection.target
                  ? menuRelationships.map((relationship, index) => (
                    <button
                      key={relationship}
                      type="button"
                      onMouseEnter={() => setNodeMenuIndex(index)}
                      onClick={() => { addRelationship(relationship); setNodeMenuQuery(""); }}
                      className={cn(
                        "flex h-9 w-full items-center rounded-xl px-2.5 text-left text-[10px] font-medium capitalize text-slate-700 transition-colors",
                        nodeMenuIndex === index ? "bg-slate-100" : "hover:bg-slate-50",
                      )}
                    >
                      <Link2 className="mr-2.5 h-3.5 w-3.5 text-slate-400" />
                      {relationship}
                    </button>
                  ))
                  : filteredNodeMenuItems.map((item, index) => {
                    const Icon = item.icon;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onMouseEnter={() => setNodeMenuIndex(index)}
                        onClick={() => selectNodeMenuItem(item)}
                        className={cn(
                          "flex h-10 w-full items-center gap-2.5 rounded-xl px-2.5 text-left transition-colors",
                          nodeMenuIndex === index ? "bg-slate-100" : "hover:bg-slate-50",
                        )}
                      >
                        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg border border-slate-200/80 bg-white text-slate-600">
                          <Icon className="h-3.5 w-3.5" />
                        </span>
                        <span className="min-w-0">
                          <span className="block truncate text-[10px] font-semibold text-slate-800">{item.label}</span>
                          <span className="mt-0.5 block truncate text-[8px] text-slate-400">{item.detail}</span>
                        </span>
                      </button>
                    );
                  })}
                {!activeMenuLength ? <div className="px-3 py-8 text-center text-[9px] text-slate-400">No matches</div> : null}
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>

        <AnimatePresence>
          {agentCursorScreen ? (
            <motion.div
              key="study-agent-cursor"
              className="pointer-events-none absolute z-50 flex items-center gap-2"
              initial={{ opacity: 0, scale: 0.92 }}
              animate={{ opacity: 1, scale: 1, x: agentCursorScreen.x, y: agentCursorScreen.y }}
              exit={{ opacity: 0, scale: 0.95 }}
              transition={{ type: "spring", stiffness: 520, damping: 34, mass: 0.22 }}
              style={{ left: 0, top: 0 }}
            >
              <MousePointer2 className="h-5 w-5 fill-blue-600 text-blue-600 drop-shadow-[0_4px_10px_rgba(37,99,235,.28)]" />
              <span className="rounded-full border border-blue-100 bg-white/95 px-2 py-1 text-[8px] font-semibold text-blue-700 shadow-[0_8px_24px_rgba(37,99,235,.16)]">{agentCursorScreen.label}</span>
            </motion.div>
          ) : null}
        </AnimatePresence>

        {studyView === "nodes" ? <div className="absolute inset-x-3 bottom-4 z-30 mx-auto flex max-w-[720px] justify-center">
          <motion.nav
            layout
            className="flex items-center gap-1 rounded-full border border-slate-200 bg-white p-2 shadow-[0_18px_50px_rgba(15,23,42,.1)]"
            transition={{ type: "spring", stiffness: 480, damping: 36, mass: 0.35 }}
          >
            <AnimatePresence initial={false}>
              {!commandDockOpen ? (
                <motion.div
                  key="tools"
                  initial={{ opacity: 0, width: 0 }}
                  animate={{ opacity: 1, width: "auto" }}
                  exit={{ opacity: 0, width: 0 }}
                  transition={{ duration: 0.18 }}
                  className="flex items-center gap-1 overflow-hidden"
                >
                  {([{ id: "select", label: "Select", icon: MousePointer2 }, { id: "pan", label: "Pan", icon: Hand }, { id: "cut", label: "Cut connection", icon: Scissors }] as const).map((tool) => {
                    const Icon = tool.icon;
                    return (
                      <button
                        key={tool.id}
                        type="button"
                        onClick={() => setCanvasTool(tool.id)}
                        title={tool.label}
                        aria-label={tool.label}
                        className={cn("group/tool relative grid h-10 w-10 place-items-center rounded-full transition-colors", canvasTool === tool.id ? "bg-slate-100 text-slate-900" : "text-slate-500 hover:bg-slate-50 hover:text-slate-800")}
                      >
                        <Icon className="h-4 w-4" />
                        <span className="pointer-events-none absolute -top-8 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-md bg-slate-900 px-2 py-1 text-[8px] font-medium text-white opacity-0 transition-opacity group-hover/tool:opacity-100">{tool.label} - {tool.id === "select" ? "select nodes" : tool.id === "pan" ? "move the canvas" : "remove links"}</span>
                      </button>
                    );
                  })}
                  <button type="button" onClick={() => void flowInstance?.fitView({ duration: 320, padding: 0.28 })} title="Fit canvas" aria-label="Fit canvas" className="group/tool relative grid h-10 w-10 place-items-center rounded-full text-slate-500 transition-colors hover:bg-slate-50 hover:text-slate-800">
                    <Maximize2 className="h-4 w-4" />
                    <span className="pointer-events-none absolute -top-8 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-md bg-slate-900 px-2 py-1 text-[8px] font-medium text-white opacity-0 transition-opacity group-hover/tool:opacity-100">Fit - frame all nodes</span>
                  </button>
                </motion.div>
              ) : null}
            </AnimatePresence>

            <button
              type="button"
              onClick={() => {
                if (commandDockOpen) {
                  setCommandDockOpen(false);
                } else {
                  setCommandDockOpen(true);
                  setComposerMode("ask");
                }
              }}
              title={commandDockOpen ? "Close ask" : "Ask Clyra"}
              aria-label={commandDockOpen ? "Close ask" : "Ask Clyra"}
              className={cn("group/tool relative grid h-10 w-10 place-items-center rounded-full text-slate-500 transition-colors hover:bg-slate-50 hover:text-slate-800", commandDockOpen && "bg-slate-100 text-slate-900")}
            >
              {commandDockOpen ? <X className="h-4 w-4" /> : <Sparkles className="h-4 w-4" />}
              <span className="pointer-events-none absolute -top-8 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-md bg-slate-900 px-2 py-1 text-[8px] font-medium text-white opacity-0 transition-opacity group-hover/tool:opacity-100">{commandDockOpen ? "Close - hide Ask Clyra" : "Ask Clyra - build from your prompt"}</span>
            </button>

            <AnimatePresence initial={false}>
              {commandDockOpen ? (
                <motion.div
                  key="ask"
                  initial={{ opacity: 0, width: 0 }}
                  animate={{ opacity: 1, width: "min(560px, calc(100vw - 96px))" }}
                  exit={{ opacity: 0, width: 0 }}
                  transition={{ type: "spring", stiffness: 420, damping: 34, mass: 0.35 }}
                  className="flex min-w-0 items-center gap-1 overflow-hidden"
                >
                  {asking || addingSource ? (
                    <div className="flex min-h-10 flex-1 items-center px-2">
                      <div className="agent-soft-shimmer h-4 w-full rounded-full bg-slate-100" />
                    </div>
                  ) : (
                    <>
                      <div className="relative min-w-0 flex-1">
                        <motion.span className="pointer-events-none absolute inset-x-3 top-1/2 h-5 -translate-y-1/2 overflow-hidden rounded-full opacity-70" animate={{ backgroundPosition: ["-160% 0", "220% 0", "-160% 0"] }} transition={{ repeat: Infinity, duration: 2.6, ease: "easeInOut" }} style={{ backgroundImage: "linear-gradient(90deg, transparent, rgba(96,165,250,.26), transparent)", backgroundSize: "60% 100%", backgroundRepeat: "no-repeat" }} />
                        <textarea
                          value={prompt}
                          onChange={(event) => setPrompt(event.target.value)}
                          onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void submitDock(); } }}
                          placeholder="Ask Clyra..."
                          rows={1}
                          className="relative z-10 min-h-9 max-h-16 w-full resize-none rounded-full border border-slate-200 bg-slate-50/90 px-3 py-2 text-[10px] leading-5 text-slate-800 outline-none placeholder:text-slate-400 focus:border-blue-300 focus:bg-white focus:ring-4 focus:ring-blue-100/60"
                        />
                      </div>
                      <button type="button" onClick={() => void submitDock()} disabled={!prompt.trim()} title="Send" aria-label="Send" className="grid h-10 w-10 shrink-0 place-items-center rounded-full text-slate-700 transition-colors hover:bg-slate-100 disabled:opacity-35">
                        <Send className="h-4 w-4" />
                      </button>
                    </>
                  )}
                </motion.div>
              ) : null}
            </AnimatePresence>
          </motion.nav>
        </div> : null}
      </main>
      {notice ? <button type="button" onClick={() => setNotice("")} className="absolute bottom-24 left-1/2 z-50 max-w-[80%] -translate-x-1/2 rounded-[14px] border border-red-200 bg-[#fffefa] px-4 py-3 text-[8px] text-red-600 shadow-[0_12px_34px_rgba(48,52,58,.1)]">{notice}</button> : null}
    </div>
  );

}

export default function StudyPalWorkspace({ globalTabsVisible = false }: { globalTabsVisible?: boolean }) {
  const [workspaces, setWorkspaces] = useState<StudyWorkspace[]>(readWorkspaces);
  const [activeId, setActiveId] = useState("");
  useEffect(() => {
    const timer = window.setTimeout(() => localStorage.setItem(STORAGE_KEY, JSON.stringify(workspaces.slice(0, 40))), 250);
    return () => window.clearTimeout(timer);
  }, [workspaces]);
  const active = workspaces.find((workspace) => workspace.id === activeId);
  const persist = useCallback((next: StudyWorkspace) => setWorkspaces((current) => current.map((workspace) => workspace.id === next.id ? next : workspace)), []);
  return active ? <StudyCanvas key={active.id} workspace={active} onBack={() => setActiveId("")} onPersist={persist} globalTabsVisible={globalTabsVisible} /> : <WorkspaceDashboard workspaces={workspaces} onChange={setWorkspaces} onOpen={setActiveId} />;
}
