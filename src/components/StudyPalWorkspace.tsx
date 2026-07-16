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
    <div className={cn("relative cursor-grab pt-6 active:cursor-grabbing", starter ? "w-[340px]" : "w-[300px]")}>
      <span className="absolute left-1 top-0 flex items-center gap-1.5 text-[10px] font-medium text-slate-400"><Icon className="h-3 w-3" style={{ color: style.accent }} />{kindLabel}</span>
      <div
        className={cn(
          "relative overflow-visible rounded-[20px] border bg-[#fffefa] shadow-[0_12px_34px_rgba(34,39,45,.07)] transition-[border-color,box-shadow,transform] duration-150",
          selected ? "border-[#111318] shadow-[0_0_0_4px_rgba(17,19,24,.08),0_16px_38px_rgba(34,39,45,.09)]" : "border-[#dfe2e6]",
        )}
      >
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
          <div className="relative mx-4 overflow-hidden rounded-[14px] border border-[#e2e4e7] bg-slate-100">
            <iframe
              src={data.sourceUrl || urlDraft}
              title={data.title || "Web preview"}
              className="pointer-events-none h-[140px] w-full origin-top-left scale-[0.45]"
              style={{ width: "222%", height: "222%" }}
              sandbox=""
              tabIndex={-1}
            />
            <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-[#fffefa]/40 to-transparent" />
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
          {sourceMode === "youtube" || sourceMode === "web" ? (
            data.body ? <p className="mt-2 line-clamp-3 rounded-[14px] border border-[#e2e4e7] bg-[#f7f7f4] p-3 text-[10px] leading-5 text-slate-600">{data.body}</p> : null
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
      </div>
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

function StudyCanvas({ workspace, onBack, onPersist }: { workspace: StudyWorkspace; onBack: () => void; onPersist: (workspace: StudyWorkspace) => void }) {
  const [nodes, setNodes, onNodesChange] = useNodesState<StudyNode>(workspace.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<StudyEdge>(workspace.edges);
  const [resources, setResources] = useState(workspace.resources);
  const [conversations, setConversations] = useState(workspace.conversations);
  const [name, setName] = useState(workspace.name);
  const [selectedId, setSelectedId] = useState("");
  const [sourceInput, setSourceInput] = useState("");
  const [addingSource, setAddingSource] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [asking, setAsking] = useState(false);
  const [notice, setNotice] = useState("");
  const [composerMode, setComposerMode] = useState<"ask" | "source">("ask");
  const [studyView, setStudyView] = useState<"nodes" | "notes" | "flashcards" | "test" | "chat">("nodes");
  const [hoveredStudyTab, setHoveredStudyTab] = useState<"nodes" | "notes" | "flashcards" | "test" | "chat" | null>(null);
  const [notesContent, setNotesContent] = useState(workspace.notesContent || "");
  const [notesLoading, setNotesLoading] = useState(false);
  const [flashLoading, setFlashLoading] = useState(false);
  const [testLoading, setTestLoading] = useState(false);
  const [testAnswers, setTestAnswers] = useState<Record<string, string>>({});
  const [testMarks, setTestMarks] = useState<Record<string, { correct?: boolean; feedback?: string }>>({});
  const [flippedCards, setFlippedCards] = useState<Set<string>>(() => new Set());
  const [practiceSelections, setPracticeSelections] = useState<Record<string, string>>({});
  const [nodeMenuQuery, setNodeMenuQuery] = useState("");
  const [nodeMenuIndex, setNodeMenuIndex] = useState(0);
  const [canvasTool, setCanvasTool] = useState<"select" | "pan" | "cut">("select");
  const [commandDockOpen, setCommandDockOpen] = useState(false);
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
    updateNode(nodeId, { sourceUrl: value, sourceMode: mode });
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
      });
    } catch (cause) {
      resource.status = "failed";
      resource.error = cause instanceof Error ? cause.message : String(cause);
      setResources((current) => current.map((item) => item.id === resource.id ? { ...resource } : item));
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
      const response = await fetch("/api/study/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: `Create a concise study-map foundation for: ${request}. Return four short, distinct learning branches with one useful sentence each.`,
          mode: "plan",
          scope: "workspace",
          context: [{ id: starter?.id || "brief", title: starter?.data.title || "Workspace brief", body: briefBody, source: "User brief" }],
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
      while (branches.length < 4) {
        branches.push(["Core ideas and vocabulary", "Evidence and worked examples", "Common misconceptions", "Questions to practise"][branches.length]!);
      }
      capture();
      const rootId = starter?.id || safeId();
      const rootPosition = starter?.position || { x: 360, y: 220 };
      const kinds: NodeKind[] = ["concept", "evidence", "note", "question"];
      const childNodes = branches.map((branch, index) => {
        const [heading, ...rest] = branch.split(/:\s*/);
        return {
          id: safeId(),
          type: "study" as const,
          position: {
            x: rootPosition.x + 390 + (index % 2) * 300,
            y: rootPosition.y - 170 + Math.floor(index / 2) * 245,
          },
          data: {
            kind: kinds[index]!,
            title: (heading || `Study branch ${index + 1}`).slice(0, 84),
            body: (rest.join(": ") || branch).slice(0, 560),
          },
        } satisfies StudyNode;
      });
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
            ...childNodes,
          ];
        }
        const root: StudyNode = {
          id: rootId,
          type: "study",
          position: rootPosition,
          data: { kind: "concept", title: request.slice(0, 90), body: request, tags: ["starter"] },
        };
        return [root, ...current, ...childNodes];
      });
      setEdges((current) => [
        ...current.filter((edge) => edge.source !== rootId || !childNodes.some((node) => node.id === edge.target)),
        ...childNodes.map((node, index) => {
          const edgeLabel = ["breaks into", "supported by", "remember", "raises"][index] || "connects to";
          return {
            id: safeId(),
            source: rootId,
            target: node.id,
            ...studyEdgeStyle(edgeLabel),
          };
        }),
      ]);
      setConversations((current) => [...current, { id: safeId(), role: "assistant", text: "I built a four-branch foundation. Add sources, then ask me to verify or expand any selected branch.", citations: payload.citations }]);
      setSelectedId(rootId);
      window.setTimeout(() => void flowInstance?.fitView({ duration: 520, padding: 0.18 }), 50);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setNotice(message);
      setConversations((current) => [...current, { id: safeId(), role: "assistant", text: message }]);
    } finally {
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
    const context = scoped.context.length
      ? scoped.context
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

  const submitDock = async () => {
    const value = prompt.trim();
    if (!value || asking || addingSource) return;
    if (composerMode === "source") {
      setPrompt("");
      await ingestUrl(value);
      return;
    }
    await ask("answer", value);
  };

  const openStudyView = (view: typeof studyView) => {
    if (view !== "nodes" && studyLocked) {
      setNotice("Add a ready source before opening study tools.");
      return;
    }
    setStudyView(view);
    if (view === "nodes") return;
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
    () => prioritizeGraphContext(nodes, edges),
    [edges, nodes],
  );

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
      setNotesContent(payload.answer);
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setNotesLoading(false);
    }
  }, [buildGraphContext, notesLoading, studyLocked]);

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
    { id: "concept", label: "Concept", detail: "A central idea to develop", kind: "concept" as NodeKind, icon: Network },
    { id: "question", label: "Open question", detail: "Something to investigate", kind: "question" as NodeKind, icon: CircleHelp },
    { id: "claim", label: "Claim", detail: "A statement to prove or challenge", kind: "claim" as NodeKind, icon: Check },
    { id: "evidence", label: "Evidence", detail: "Support linked to a claim", kind: "evidence" as NodeKind, icon: Link2 },
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
        <StudyNodeActions.Provider value={{ buildFromPrompt: (value) => void buildFromPrompt(value), capture, updateNode, duplicateNode, ingestNodeUrl: (nodeId, url) => void ingestNodeUrl(nodeId, url), workspaceName: name, workspaceDescription: workspace.description }}>
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
            fitViewOptions={{ padding: 0.35, minZoom: 0.2, maxZoom: 0.72, duration: 0 }}
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

        <AnimatePresence mode="wait">
          {studyView !== "nodes" ? (
            <motion.section key={studyView} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -5 }} transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }} className="absolute inset-0 z-[12] overflow-y-auto bg-[#f7f8fa] px-5 pb-32 pt-24 sm:px-8">
              <div className="mx-auto max-w-[900px]">
                {studyView === "chat" ? (
                  <div>
                    <div className="mb-4 flex items-end justify-between">
                      <div><p className="text-[9px] font-semibold uppercase tracking-[.14em] text-slate-400">AI Assistant</p><h2 className="mt-1 text-[22px] font-semibold tracking-[-.02em] text-slate-950">Chat</h2></div>
                    </div>
                    <div className="space-y-4">
                      {conversations.map((msg) => (
                        <div key={msg.id} className={cn("rounded-[18px] border p-4 shadow-[0_10px_30px_rgba(15,23,42,.05)]", msg.role === "user" ? "border-slate-200 bg-white" : "border-blue-100 bg-blue-50")}>
                          <p className="text-[8px] font-semibold uppercase tracking-[.12em] text-slate-400">{msg.role === "user" ? "You" : "Clyra"}</p>
                          <p className="mt-2 text-[11px] leading-5 text-slate-700">{msg.text}</p>
                          {msg.citations && msg.citations.length > 0 ? (
                            <div className="mt-2 flex flex-wrap gap-1">
                              {msg.citations.map((citation, idx) => (
                                <span key={idx} className="text-[8px] text-blue-600">[{idx + 1}] {citation}</span>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      ))}
                      {!conversations.length ? <p className="py-16 text-center text-[11px] text-slate-400">Start a conversation with Clyra about your study materials.</p> : null}
                    </div>
                  </div>
                ) : null}
                {studyView === "notes" ? (
                  <div>
                    <div className="mb-4 flex items-end justify-between">
                      <div><p className="text-[9px] font-semibold uppercase tracking-[.14em] text-slate-400">Live from your map</p><h2 className="mt-1 text-[22px] font-semibold tracking-[-.02em] text-slate-950">Notes</h2></div>
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
                      <DocumentCardUI content={notesContent || "# Notes\n\nAdd sources and connect nodes — notes will generate here."} onContentChange={setNotesContent} />
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
                              x: [-(90 - index * 8), 90 - index * 8, -(90 - index * 8)],
                              y: [index % 2 === 0 ? -18 : 18, index % 2 === 0 ? 18 : -18, index % 2 === 0 ? -18 : 18],
                              rotate: [(index - 2) * 8, (2 - index) * 8, (index - 2) * 8],
                            }}
                            transition={{ repeat: Infinity, duration: 2.2, ease: "easeInOut", delay: index * 0.08 }}
                          />
                        ))}
                      </div>
                    ) : (
                      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                        {(activeFlashDeck ? splitStudyItems(activeFlashDeck.data.body).slice(0, 5) : []).map((card, index) => {
                          const [front, back] = card.split(/\n+|—|-/).map((part) => part.trim()).filter(Boolean);
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
                              className="min-h-[170px] rounded-[18px] border border-slate-200 bg-white p-5 text-left shadow-[0_10px_30px_rgba(15,23,42,.06)] transition-transform active:scale-[.99]"
                            >
                              <p className="text-[8px] font-semibold uppercase tracking-[.12em] text-slate-400">{flipped ? "Answer" : "Question"}</p>
                              <h3 className="mt-4 text-[13px] font-semibold leading-5 text-slate-900">{flipped ? (back || card) : (front || card)}</h3>
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
                        {generatedViewNodes.map((node, index) => {
                          const items = splitStudyItems(node.data.body);
                          const options = items.filter((item) => /^[A-D][.)]\s/i.test(item));
                          const shortPrompt = items.find((item) => !/^[A-D][.)]\s/i.test(item)) || node.data.title;
                          const mark = testMarks[node.id];
                          return (
                            <article key={node.id} className="rounded-[18px] border border-slate-200 bg-white p-5 shadow-[0_10px_30px_rgba(15,23,42,.05)]">
                              <p className="text-[8px] font-semibold uppercase tracking-[.12em] text-slate-400">Question {index + 1}</p>
                              <h3 className="mt-2 text-[14px] font-semibold text-slate-900">{node.data.title}</h3>
                              <p className="mt-2 text-[10px] leading-5 text-slate-600">{shortPrompt}</p>
                              <div className="mt-4 space-y-2">
                                {options.map((option) => (
                                  <button key={option} type="button" onClick={() => setPracticeSelections((current) => ({ ...current, [node.id]: option }))} className={cn("w-full rounded-xl border px-3 py-2.5 text-left text-[10px] transition-colors", practiceSelections[node.id] === option ? "border-blue-500 bg-blue-50 text-blue-800" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50")}>{option}</button>
                                ))}
                              </div>
                              <textarea
                                aria-label={`Short answer ${index + 1}`}
                                value={testAnswers[node.id] || ""}
                                onChange={(event) => setTestAnswers((current) => ({ ...current, [node.id]: event.target.value }))}
                                placeholder="Short-answer response..."
                                className="mt-4 min-h-16 w-full resize-none rounded-xl border border-slate-200 bg-slate-50/80 p-3 text-[10px] outline-none focus:border-blue-300 focus:ring-4 focus:ring-blue-50"
                              />
                              <div className="mt-3 flex items-center gap-2">
                                <button
                                  type="button"
                                  onClick={async () => {
                                    const answer = [practiceSelections[node.id], testAnswers[node.id]].filter(Boolean).join("\n");
                                    if (!answer.trim()) return;
                                    try {
                                      const response = await fetch("/api/study/ask", {
                                        method: "POST",
                                        headers: { "Content-Type": "application/json" },
                                        body: JSON.stringify({
                                          question: `Mark this student answer. Reply with CORRECT or INCORRECT on the first line, then one sentence of feedback.\nQuestion: ${node.data.title}\nExpected material:\n${node.data.body}\nStudent answer:\n${answer}`,
                                          mode: "answer",
                                          scope: "workspace",
                                          context: buildGraphContext().slice(0, 8),
                                        }),
                                      });
                                      const payload = await response.json() as { answer?: string };
                                      const text = payload.answer || "";
                                      setTestMarks((current) => ({
                                        ...current,
                                        [node.id]: { correct: /^correct/i.test(text.trim()), feedback: text },
                                      }));
                                    } catch (cause) {
                                      setNotice(cause instanceof Error ? cause.message : String(cause));
                                    }
                                  }}
                                  className="rounded-full bg-slate-950 px-3.5 py-2 text-[9px] font-semibold text-white"
                                >
                                  Mark with AI
                                </button>
                                {mark ? <span className={cn("text-[9px] font-semibold", mark.correct ? "text-emerald-600" : "text-rose-600")}>{mark.correct ? "Correct" : "Needs work"}{mark.feedback ? ` · ${mark.feedback.slice(0, 120)}` : ""}</span> : null}
                              </div>
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
        <div
          className="clyra-workflow-tabs absolute left-1/2 top-4 z-30 flex -translate-x-1/2 items-center rounded-full border border-white/80 bg-white/85 p-1 shadow-[0_10px_32px_rgba(15,23,42,.08)] backdrop-blur-xl"
          onPointerLeave={() => setHoveredStudyTab(null)}
        >
          <AnimatePresence>
            {hoveredStudyTab ? (
              <motion.div
                className="clyra-workflow-tab__hover pointer-events-none absolute bottom-1 top-1 rounded-full"
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1, x: `calc(${(["nodes", "notes", "flashcards", "test", "chat"] as const).indexOf(hoveredStudyTab)} * 100%)` }}
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
              disabled={view !== "nodes" && studyLocked}
              className={cn(
                "relative z-10 h-8 rounded-full px-3.5 text-[8px] font-semibold transition-colors",
                studyView === view ? "text-slate-950" : view !== "nodes" && studyLocked ? "cursor-not-allowed text-slate-300" : "text-slate-500 hover:text-slate-800",
              )}
            >
              {studyView === view ? <motion.span layoutId="study-tab" className="absolute inset-0 -z-10 rounded-full bg-white shadow-sm" transition={{ type: "spring", stiffness: 520, damping: 38 }} /> : null}
              {view === "nodes" ? "Node" : view === "notes" ? "Notes" : view === "flashcards" ? "Flashcards" : view === "test" ? "Test" : "Chat"}
            </button>
          ))}
        </div>
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

        <div className="absolute inset-x-3 bottom-4 z-30 mx-auto flex max-w-[720px] justify-center">
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
                        <span className="pointer-events-none absolute -top-8 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-md bg-slate-900 px-2 py-1 text-[8px] font-medium text-white opacity-0 transition-opacity group-hover/tool:opacity-100">{tool.label}</span>
                      </button>
                    );
                  })}
                  <button type="button" onClick={() => void flowInstance?.fitView({ duration: 320, padding: 0.28 })} title="Fit canvas" aria-label="Fit canvas" className="group/tool relative grid h-10 w-10 place-items-center rounded-full text-slate-500 transition-colors hover:bg-slate-50 hover:text-slate-800">
                    <Maximize2 className="h-4 w-4" />
                    <span className="pointer-events-none absolute -top-8 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-md bg-slate-900 px-2 py-1 text-[8px] font-medium text-white opacity-0 transition-opacity group-hover/tool:opacity-100">Fit canvas</span>
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
              <Sparkles className="h-4 w-4" />
              <span className="pointer-events-none absolute -top-8 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-md bg-slate-900 px-2 py-1 text-[8px] font-medium text-white opacity-0 transition-opacity group-hover/tool:opacity-100">{commandDockOpen ? "Close ask" : "Ask Clyra"}</span>
            </button>

            <AnimatePresence initial={false}>
              {commandDockOpen ? (
                <motion.div
                  key="ask"
                  initial={{ opacity: 0, width: 0 }}
                  animate={{ opacity: 1, width: "min(420px, calc(100vw - 140px))" }}
                  exit={{ opacity: 0, width: 0 }}
                  transition={{ type: "spring", stiffness: 420, damping: 34, mass: 0.35 }}
                  className="flex min-w-0 items-center gap-1 overflow-hidden"
                >
                  <textarea
                    value={prompt}
                    onChange={(event) => setPrompt(event.target.value)}
                    onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void submitDock(); } }}
                    placeholder="Ask Clyra..."
                    rows={1}
                    className="min-h-9 max-h-16 min-w-0 flex-1 resize-none rounded-full border border-slate-200 bg-slate-50 px-3 py-2 text-[10px] leading-5 text-slate-800 outline-none placeholder:text-slate-400 focus:border-slate-300 focus:bg-white"
                  />
                  <button type="button" onClick={() => void submitDock()} disabled={asking || addingSource || !prompt.trim()} title="Send" aria-label="Send" className="grid h-10 w-10 shrink-0 place-items-center rounded-full text-slate-700 transition-colors hover:bg-slate-100 disabled:opacity-35">
                    {asking || addingSource ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                  </button>
                </motion.div>
              ) : null}
            </AnimatePresence>
          </motion.nav>
        </div>
      </main>
      {notice ? <button type="button" onClick={() => setNotice("")} className="absolute bottom-24 left-1/2 z-50 max-w-[80%] -translate-x-1/2 rounded-[14px] border border-red-200 bg-[#fffefa] px-4 py-3 text-[8px] text-red-600 shadow-[0_12px_34px_rgba(48,52,58,.1)]">{notice}</button> : null}
    </div>
  );

}

export default function StudyPalWorkspace() {
  const [workspaces, setWorkspaces] = useState<StudyWorkspace[]>(readWorkspaces);
  const [activeId, setActiveId] = useState("");
  useEffect(() => {
    const timer = window.setTimeout(() => localStorage.setItem(STORAGE_KEY, JSON.stringify(workspaces.slice(0, 40))), 250);
    return () => window.clearTimeout(timer);
  }, [workspaces]);
  const active = workspaces.find((workspace) => workspace.id === activeId);
  const persist = useCallback((next: StudyWorkspace) => setWorkspaces((current) => current.map((workspace) => workspace.id === next.id ? next : workspace)), []);
  return active ? <StudyCanvas key={active.id} workspace={active} onBack={() => setActiveId("")} onPersist={persist} /> : <WorkspaceDashboard workspaces={workspaces} onChange={setWorkspaces} onOpen={setActiveId} />;
}
