import React, { useMemo, useState } from "react";
import { ProjectFile } from "../../../hooks/useVibeCoderWorkspace";
import {
  CheckCircle2,
  ChevronRight,
  Clock,
  FileText,
  FolderClosed,
  FolderOpen,
  XCircle,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { cn } from "../../../lib/utils";

interface FileTreePanelProps {
  files: Record<string, ProjectFile>;
  activeFile: string | null;
  planMd: string;
  onSelectFile?: (path: string) => void;
}

type TreeFolder = {
  kind: "folder";
  name: string;
  path: string;
  children: TreeNode[];
};

type TreeLeaf = {
  kind: "file";
  name: string;
  path: string;
  file: ProjectFile;
};

type TreeNode = TreeFolder | TreeLeaf;

/** VS Code-style per-extension accent colours, kept soft for the light theme. */
function extensionColor(name: string) {
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  switch (ext) {
    case "ts":
    case "tsx":
      return "text-sky-600";
    case "js":
    case "jsx":
    case "mjs":
      return "text-amber-500";
    case "css":
    case "scss":
      return "text-indigo-500";
    case "html":
    case "htm":
      return "text-orange-500";
    case "json":
      return "text-lime-600";
    case "md":
      return "text-slate-500";
    case "svg":
    case "png":
    case "jpg":
    case "jpeg":
    case "gif":
    case "webp":
      return "text-fuchsia-500";
    default:
      return "text-slate-400";
  }
}

function buildTree(fileList: ProjectFile[]): TreeNode[] {
  const root: TreeFolder = { kind: "folder", name: "", path: "", children: [] };
  for (const file of fileList) {
    const segments = file.path.split("/").filter(Boolean);
    let cursor = root;
    segments.forEach((segment, index) => {
      const isLeaf = index === segments.length - 1;
      const childPath = segments.slice(0, index + 1).join("/");
      if (isLeaf) {
        cursor.children.push({ kind: "file", name: segment, path: file.path, file });
        return;
      }
      let folder = cursor.children.find(
        (node): node is TreeFolder => node.kind === "folder" && node.name === segment,
      );
      if (!folder) {
        folder = { kind: "folder", name: segment, path: childPath, children: [] };
        cursor.children.push(folder);
      }
      cursor = folder;
    });
  }
  const sortNodes = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const node of nodes) {
      if (node.kind === "folder") sortNodes(node.children);
    }
  };
  sortNodes(root.children);
  return root.children;
}

function FileStatusBadge({ status }: { status: ProjectFile["status"] }) {
  if (status === "complete") return <CheckCircle2 className="h-3 w-3 text-emerald-500" />;
  if (status === "streaming") return <Clock className="h-3 w-3 animate-pulse text-sky-500" />;
  if (status === "error") return <XCircle className="h-3 w-3 text-rose-500" />;
  return null;
}

function FileRow({
  node,
  depth,
  active,
  onSelectFile,
}: {
  node: TreeLeaf;
  depth: number;
  active: boolean;
  onSelectFile?: (path: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelectFile?.(node.path)}
      title={node.path}
      className={cn(
        "group flex w-full cursor-default items-center gap-2 rounded-lg py-1.5 pr-2 text-left text-[12.5px] transition-colors duration-150",
        active
          ? "bg-sky-50 font-semibold text-sky-900"
          : "text-slate-600 hover:bg-slate-100/80 hover:text-slate-900",
      )}
      style={{ paddingLeft: 10 + depth * 14 }}
    >
      <FileText className={cn("h-3.5 w-3.5 shrink-0", extensionColor(node.name))} strokeWidth={1.8} />
      <span className="min-w-0 flex-1 truncate">{node.name}</span>
      <span className="ml-auto flex shrink-0 items-center">
        <FileStatusBadge status={node.file.status} />
      </span>
    </button>
  );
}

function FolderRow({
  node,
  depth,
  activeFile,
  onSelectFile,
}: {
  node: TreeFolder;
  depth: number;
  activeFile: string | null;
  onSelectFile?: (path: string) => void;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-1.5 rounded-lg py-1.5 pr-2 text-left text-[12.5px] font-medium text-slate-700 transition-colors duration-150 hover:bg-slate-100/80"
        style={{ paddingLeft: 6 + depth * 14 }}
      >
        <motion.span
          animate={{ rotate: open ? 90 : 0 }}
          transition={{ duration: 0.18, ease: "easeOut" }}
          className="grid h-4 w-4 shrink-0 place-items-center text-slate-400"
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </motion.span>
        {open ? (
          <FolderOpen className="h-3.5 w-3.5 shrink-0 text-slate-400" strokeWidth={1.8} />
        ) : (
          <FolderClosed className="h-3.5 w-3.5 shrink-0 text-slate-400" strokeWidth={1.8} />
        )}
        <span className="min-w-0 flex-1 truncate">{node.name}</span>
      </button>
      <AnimatePresence initial={false}>
        {open ? (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
            className="relative overflow-hidden"
          >
            {/* Indent guide aligned with this folder's chevron column. */}
            <span
              aria-hidden
              className="absolute bottom-1 top-0 w-px bg-slate-200"
              style={{ left: 13 + depth * 14 }}
            />
            {node.children.map((child) =>
              child.kind === "folder" ? (
                <FolderRow key={child.path} node={child} depth={depth + 1} activeFile={activeFile} onSelectFile={onSelectFile} />
              ) : (
                <FileRow key={child.path} node={child} depth={depth + 1} active={child.path === activeFile} onSelectFile={onSelectFile} />
              ),
            )}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

export function FileTreePanel({ files, activeFile, planMd, onSelectFile }: FileTreePanelProps) {
  const fileList = useMemo(
    () => Object.values(files).sort((a, b) => a.path.localeCompare(b.path)),
    [files],
  );
  const tree = useMemo(() => buildTree(fileList), [fileList]);

  return (
    <div className="flex h-full w-full flex-col overflow-hidden rounded-xl border border-slate-200 bg-white">
      <div className="flex shrink-0 items-center gap-2 border-b border-slate-200 bg-slate-50 px-3.5 py-2.5">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
          Explorer
        </h2>
        <span className="ml-auto rounded-full bg-white px-2 py-0.5 text-[10px] font-semibold text-slate-400 ring-1 ring-slate-200">
          {fileList.length} files
        </span>
      </div>

      <div className="clyra-visible-scrollbar flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-2">
        {planMd ? (
          <button
            type="button"
            onClick={() => onSelectFile?.("PLAN.md")}
            className={cn(
              "flex w-full items-center gap-2 rounded-lg py-1.5 pl-2.5 pr-2 text-left text-[12.5px] transition-colors duration-150",
              activeFile === "PLAN.md"
                ? "bg-sky-50 font-semibold text-sky-900"
                : "text-slate-600 hover:bg-slate-100/80 hover:text-slate-900",
            )}
          >
            <FileText className="h-3.5 w-3.5 shrink-0 text-emerald-500" strokeWidth={1.8} />
            <span className="min-w-0 flex-1 truncate">PLAN.md</span>
            <CheckCircle2 className="ml-auto h-3 w-3 shrink-0 text-emerald-500" />
          </button>
        ) : null}

        {tree.map((node) =>
          node.kind === "folder" ? (
            <FolderRow key={node.path} node={node} depth={0} activeFile={activeFile} onSelectFile={onSelectFile} />
          ) : (
            <FileRow key={node.path} node={node} depth={0} active={node.path === activeFile} onSelectFile={onSelectFile} />
          ),
        )}

        {fileList.length === 0 && !planMd ? (
          <div className="py-10 text-center text-[12.5px] font-medium text-slate-400">
            No files generated yet
          </div>
        ) : null}
      </div>
    </div>
  );
}
