import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import Editor, { type OnMount, loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
// Load Monaco from the local bundle instead of the CDN loader default so the
// Files editor renders in the desktop/offline shell, not only on the web.
loader.config({ monaco });
import {
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  ExternalLink,
  FileCode2,
  FilePlus2,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Globe,
  Maximize2,
  Minimize2,
  RotateCw,
  Save,
  Search,
  Pencil,
  Trash2,
  X,
} from "lucide-react";
import { cn } from "../../lib/utils";
import { ShiningText } from "../ShiningText";
import { api, type FileDiff, type PreviewLogLine, type PreviewSession } from "./api";
import { IPhonePanel } from "./IPhonePanel";
import type { AgentAction, ClyraCodeState, ProjectPlatform } from "./store";
import { DiffCounters } from "./AnimatedCounter";
import { computeLineDiff, linesFromPatch } from "./diff";
import { stripFilePrefix } from "./format";
import type { ComposerContext } from "./Composer";
import {
  VisualInspector,
  selectionChipLabel,
  selectionContextDetail,
  type InspectPayload,
} from "./VisualInspector";

export type RightTab = "browser" | "changes" | "files";

/* ------------------------------------------------------------------ */
/* Preview controller                                                  */
/* ------------------------------------------------------------------ */

export function usePreview(projectId: string | null, buildVersion: number) {
  const [session, setSession] = useState<PreviewSession | null>(null);
  const [logs, setLogs] = useState<PreviewLogLine[]>([]);
  const [frameVersion, setFrameVersion] = useState(0);
  const startedForRef = useRef<string | null>(null);

  const start = useCallback(async () => {
    if (!projectId) return;
    setSession((prev) => (prev ? { ...prev, status: "starting" } : { projectId, status: "starting" }));
    try {
      const next = await api.previewStart(projectId);
      setSession(next);
    } catch (error) {
      setSession({
        projectId,
        status: "build_failed",
        lastError: { message: error instanceof Error ? error.message : "Preview failed to start" },
      });
    }
  }, [projectId]);

  const restart = useCallback(async () => {
    if (!projectId) return;
    setSession((prev) => (prev ? { ...prev, status: "restarting" } : prev));
    try {
      setSession(await api.previewRestart(projectId));
    } catch {
      /* status poll recovers */
    }
  }, [projectId]);

  const reload = useCallback(() => setFrameVersion((v) => v + 1), []);

  useEffect(() => {
    if (!projectId) return;
    if (startedForRef.current !== projectId) {
      startedForRef.current = projectId;
      // Drop the previous project's session immediately so its preview can
      // never render against the newly selected project.
      setSession(null);
      setFrameVersion(0);
      void start();
    }
    let retryingMissingEntry = false;
    const interval = window.setInterval(async () => {
      const status = await api.previewStatus(projectId).catch(() => null);
      if (status) setSession(status);
      const lines = await api.previewLogs(projectId).catch(() => null);
      if (lines) setLogs(lines);

      // Agent often creates index.html after the first preview probe. Retry
      // start while the failure is "entry missing" so the browser comes up
      // mid-run instead of waiting for session.idle / a manual Retry click.
      const missingEntry =
        status?.status === "build_failed" &&
        /index\.html entry point/i.test(status.lastError?.message ?? "");
      if (missingEntry && !retryingMissingEntry) {
        retryingMissingEntry = true;
        try {
          const next = await api.previewStart(projectId);
          setSession(next);
          if (next.url && (next.status === "ready" || next.status === "running")) {
            setFrameVersion((v) => v + 1);
          }
        } catch {
          /* status poll retries next tick */
        } finally {
          retryingMissingEntry = false;
        }
      }
    }, 2000);
    return () => window.clearInterval(interval);
  }, [projectId, start]);

  // Reload the frame after each successful agent run so the preview always
  // reflects the latest build.
  useEffect(() => {
    if (buildVersion > 0) {
      setFrameVersion((v) => v + 1);
      if (projectId && (!session?.url || session.status === "stopped" || session.status === "build_failed")) {
        void start();
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buildVersion]);

  return { session, logs, frameVersion, start, restart, reload };
}

/* ------------------------------------------------------------------ */
/* Browser view                                                        */
function BrowserView({
  session,
  frameVersion,
  onReload,
  onRestart,
  onOpenTerminal,
  onAddContext,
  agentRunning = false,
  projectId,
  inspectMode,
  onToggleInspect,
  onFrameReady,
  onPreviewError,
  fullscreen,
  onToggleFullscreen,
}: {
  session: PreviewSession | null;
  frameVersion: number;
  onReload: () => void;
  onRestart: () => void;
  onOpenTerminal?: () => void;
  onAddContext: (context: ComposerContext) => void;
  agentRunning?: boolean;
  projectId: string | null;
  inspectMode: boolean;
  onToggleInspect: () => void;
  onFrameReady: (win: Window | null) => void;
  onPreviewError?: (message: string) => void;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
}) {
  const [historyIndex, setHistoryIndex] = useState(0);
  const [history, setHistory] = useState<string[]>([]);
  const surfaceRef = useRef<HTMLDivElement | null>(null);

  const url = session?.url ?? "";
  const host = url.replace(/^https?:\/\//, "").replace(/\/$/, "");
  const ready = Boolean(url) && (session?.status === "ready" || session?.status === "running");
  const starting =
    session?.status === "starting" ||
    session?.status === "installing" ||
    session?.status === "compiling" ||
    session?.status === "restarting" ||
    session?.status === "refreshing";
  const missingEntry =
    /index\.html|entry point|not yet created/i.test(String(session?.lastError?.message || ""));
  const failed =
    !missingEntry &&
    (session?.status === "build_failed" ||
      session?.status === "server_crashed" ||
      session?.status === "runtime_error");

  useEffect(() => {
    if (failed && session?.lastError?.message) onPreviewError?.(session.lastError.message);
  }, [failed, onPreviewError, session?.lastError?.message]);

  useEffect(() => {
    if (!url) return;
    setHistory((prev) => {
      if (prev[prev.length - 1] === url) return prev;
      const next = [...prev, url];
      setHistoryIndex(next.length - 1);
      return next;
    });
  }, [url]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-[40px] items-center gap-0.5 border-b border-[color:var(--border-subtle)] px-2.5">
        <button
          type="button"
          aria-label="Back"
          disabled={historyIndex <= 0}
          onClick={() => setHistoryIndex((i) => Math.max(0, i - 1))}
          className="rounded-[7px] p-1.5 text-[#93959A] transition-colors hover:bg-[color:var(--surface-hover)] disabled:text-[color:var(--text-disabled)]"
        >
          <ArrowLeft className="h-[13px] w-[13px]" strokeWidth={1.8} />
        </button>
        <button
          type="button"
          aria-label="Forward"
          disabled={historyIndex >= history.length - 1}
          onClick={() => setHistoryIndex((i) => Math.min(history.length - 1, i + 1))}
          className="rounded-[7px] p-1.5 text-[#93959A] transition-colors hover:bg-[color:var(--surface-hover)] disabled:text-[color:var(--text-disabled)]"
        >
          <ArrowRight className="h-[13px] w-[13px]" strokeWidth={1.8} />
        </button>
        <button
          type="button"
          aria-label="Reload"
          onClick={onReload}
          className="rounded-[7px] p-1.5 text-[#93959A] transition-colors hover:bg-[color:var(--surface-hover)]"
        >
          <RotateCw className="h-[13px] w-[13px]" strokeWidth={1.8} />
        </button>
        <div className="mx-2 flex h-[28px] min-w-0 flex-1 items-center justify-center rounded-[8px] bg-black/[0.025] px-3">
          {host ? (
            <span className="cc-mono truncate text-[11.5px] text-[color:var(--text-secondary)]">
              {host}
            </span>
          ) : starting ? (
            <ShiningText text="Starting development server…" play className="text-[11.5px]" />
          ) : (
            <span className="text-[11.5px] text-[color:var(--text-tertiary)]">Preview</span>
          )}
        </div>
        {url ? (
          <button
            type="button"
            aria-label="Open externally"
            onClick={() => window.open(url, "_blank", "noopener")}
            className="rounded-[7px] p-1.5 text-[color:var(--text-secondary)] transition-colors hover:bg-[color:var(--surface-hover)]"
          >
            <ExternalLink className="h-[14px] w-[14px]" strokeWidth={1.8} />
          </button>
        ) : null}
        <button
          type="button"
          aria-label={fullscreen ? "Exit full screen preview" : "Full screen preview"}
          title={fullscreen ? "Exit full screen" : "Full screen"}
          onClick={onToggleFullscreen}
          className="rounded-[7px] p-1.5 text-[color:var(--text-secondary)] transition-colors hover:bg-[color:var(--surface-hover)]"
        >
          {fullscreen ? <Minimize2 className="h-[14px] w-[14px]" strokeWidth={1.8} /> : <Maximize2 className="h-[14px] w-[14px]" strokeWidth={1.8} />}
        </button>
        <button
          type="button"
          onClick={onToggleInspect}
          className={cn(
            "ml-1 flex h-7 items-center gap-1.5 rounded-[8px] px-2.5 text-[11.5px] transition-colors",
            inspectMode
              ? "bg-[#E8F0FE] font-medium text-[#3977F6]"
              : "font-medium text-[color:var(--text-secondary)] hover:bg-[color:var(--surface-hover)]",
          )}
        >
          {inspectMode ? "✓ Editing" : "Commenting"}
        </button>
      </div>

      <div ref={surfaceRef} className="relative min-h-0 flex-1 bg-white">
        {ready && !agentRunning ? (
          <iframe
            key={`${projectId}:${frameVersion}`}
            // Keep the trailing slash so the preview behaves as a directory:
            // relative JS/CSS assets and the injected inspect bridge resolve
            // inside this project's proxied namespace.
            src={`/api/vibe/projects/${encodeURIComponent(projectId ?? "")}/preview/`}
            title="Live preview"
            className="h-full w-full border-0 bg-white"
            sandbox="allow-forms allow-modals allow-popups allow-same-origin allow-scripts"
            onLoad={(event) => {
              const win = event.currentTarget.contentWindow;
              onFrameReady(win);
              win?.postMessage({ type: "clyra:mode", mode: inspectMode }, "*");
            }}
          />
        ) : failed ? (
          <div className="flex h-full flex-col items-center justify-center gap-2.5 bg-[#FAFAF9]">
            <p className="text-[13px] font-medium text-[#171717]">Preview could not start</p>
            {session?.lastError?.message ? (
              <p className="max-w-[360px] text-center text-[11.5px] leading-[1.45] text-[#8A8A8A]">
                {session.lastError.message}
              </p>
            ) : null}
            <div className="mt-1 flex items-center gap-1.5">
              <button
                type="button"
                onClick={onRestart}
                className="h-7 rounded-[7px] border border-[#EEEEEC] px-2.5 text-[11.5px] text-[#171717] transition-colors hover:bg-[#F6F6F5]"
              >
                Retry
              </button>
              <button
                type="button"
                onClick={onOpenTerminal}
                className="h-7 rounded-[7px] px-2.5 text-[11.5px] text-[#5F6368] transition-colors hover:bg-[#F6F6F5]"
              >
                View logs
              </button>
            </div>
          </div>
        ) : (!starting && !agentRunning) ? (
          <div className="relative flex h-full flex-col items-center justify-center overflow-hidden bg-[#F7F7F6]">
            <div className="relative z-[1] flex max-w-[300px] flex-col items-center px-5 text-center">
              <Globe className="mb-2.5 h-6 w-6 text-[#B7B9BD]" strokeWidth={1.4} />
              <h3 className="text-[13px] font-medium tracking-[-0.015em] text-[#3D3F43]">
                Preview will appear here
              </h3>
              <p className="mt-1 text-[11.5px] leading-[1.45] text-[#94969A]">
                Describe what to create in the chat. The live preview opens here once files are ready.
              </p>
            </div>
          </div>
        ) : null}

        <AnimatePresence>
          {(starting || agentRunning) && !failed ? (
            <motion.div
              key="preview-loading"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ opacity: { duration: 0.32, ease: [0.22, 1, 0.36, 1] } }}
              className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-[#FAFAF9]"
            >
              <div className="cc-preview-loader" aria-hidden />
              <div className="flex flex-col items-center gap-1 text-center">
                <ShiningText
                  text={starting ? "Starting live preview…" : "Building your project…"}
                  play
                  className="text-[12.5px] font-medium tracking-[-0.01em]"
                />
                <p className="text-[11px] text-[#8A8A8A]">
                  {starting ? "Preparing the development server" : "Preview will appear when files are ready"}
                </p>
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Changes view                                                        */
/* ------------------------------------------------------------------ */

function ChangesView({
  diffs,
  actions,
  focusFile,
}: {
  diffs: FileDiff[];
  actions: AgentAction[];
  focusFile: string | null;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const activeFile = focusFile ?? selected ?? (diffs[0] ? stripFilePrefix(diffs[0].file) : null);
  const activeDiff = diffs.find((d) => stripFilePrefix(d.file) === activeFile) ?? null;
  const lines = useMemo(() => {
    if (!activeDiff) return [];
    if (activeDiff.before || activeDiff.after) {
      return computeLineDiff(activeDiff.before ?? "", activeDiff.after ?? "");
    }
    const patch = [...actions]
      .reverse()
      .find((a) => a.target === activeFile && a.patch)?.patch;
    return patch ? linesFromPatch(patch) : [];
  }, [activeDiff, actions, activeFile]);

  if (!diffs.length) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <p className="text-[12.5px] text-[color:var(--text-tertiary)]">No changes yet.</p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1">
      <div className="cc-scroll w-[220px] shrink-0 overflow-y-auto border-r border-[color:var(--border-subtle)] py-2">
        {diffs.map((diff) => {
          const path = stripFilePrefix(diff.file);
          const active = path === activeFile;
          return (
            <button
              key={diff.file}
              type="button"
              onClick={() => setSelected(path)}
              title={path}
              className={cn(
                "grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-1.5 px-3 py-[5px] text-left transition-colors",
                active ? "bg-[color:var(--surface-selected)]" : "hover:bg-[color:var(--surface-hover)]",
              )}
            >
              <span className="cc-mono truncate text-[11px] text-[color:var(--text-secondary)]">
                {path.split("/").pop()}
              </span>
              <DiffCounters additions={diff.additions} deletions={diff.deletions} className="text-[10.5px]" />
            </button>
          );
        })}
      </div>
      <div className="cc-scroll min-h-0 flex-1 overflow-auto">
        {activeDiff ? (
          <>
            <div className="sticky top-0 flex items-center gap-2 border-b border-[color:var(--border-subtle)] bg-white/95 px-4 py-2 backdrop-blur">
              <span className="cc-mono truncate text-[11.5px] text-[color:var(--text-secondary)]">
                {stripFilePrefix(activeDiff.file)}
              </span>
              <DiffCounters
                additions={activeDiff.additions}
                deletions={activeDiff.deletions}
                className="ml-auto"
              />
            </div>
            <table className="w-full border-collapse">
              <tbody>
                {lines.map((line, index) => (
                  <tr
                    key={index}
                    className={cn(
                      line.kind === "add" && "bg-[rgba(46,160,90,0.085)]",
                      line.kind === "del" && "bg-[rgba(195,73,73,0.075)]",
                    )}
                  >
                    <td className="cc-mono w-10 select-none px-2 text-right align-top text-[10px] leading-[1.7] text-[color:var(--text-disabled)]">
                      {line.beforeLine ?? ""}
                    </td>
                    <td className="cc-mono w-10 select-none px-2 text-right align-top text-[10px] leading-[1.7] text-[color:var(--text-disabled)]">
                      {line.afterLine ?? ""}
                    </td>
                    <td
                      className={cn(
                        "cc-mono whitespace-pre-wrap px-2 text-[11.5px] leading-[1.7]",
                        line.kind === "add" && "text-[#1c6b3d]",
                        line.kind === "del" && "text-[#a53c3c]",
                        line.kind === "context" && "text-[color:var(--text-secondary)]",
                      )}
                    >
                      {line.kind === "add" ? "+ " : line.kind === "del" ? "− " : "  "}
                      {line.text}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        ) : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Files view                                                          */
/* ------------------------------------------------------------------ */

type WorkspaceFile = { path: string; content: string };
type FileTreeNode = { name: string; path: string; children: Map<string, FileTreeNode>; file?: WorkspaceFile };

function fileLanguage(filePath: string) {
  const extension = filePath.split(".").pop()?.toLowerCase();
  return ({ ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", json: "json", css: "css", html: "html", md: "markdown", swift: "swift", yml: "yaml", yaml: "yaml", sh: "shell", zsh: "shell" } as Record<string, string>)[extension ?? ""] ?? "plaintext";
}

function buildFileTree(files: WorkspaceFile[]) {
  const root: FileTreeNode = { name: "", path: "", children: new Map() };
  for (const file of files) {
    let node = root;
    const segments = file.path.split("/").filter(Boolean);
    segments.forEach((segment, index) => {
      const nextPath = node.path ? `${node.path}/${segment}` : segment;
      let next = node.children.get(segment);
      if (!next) {
        next = { name: segment, path: nextPath, children: new Map() };
        node.children.set(segment, next);
      }
      if (index === segments.length - 1) next.file = file;
      node = next;
    });
  }
  return root;
}

function shouldShowWorkspaceFile(path: string) {
  if (path.startsWith(".agent/skills/")) return true;
  if (path === ".agent/AGENTS.md") return true;
  return !path.startsWith(".agent/") && !path.startsWith(".clyra/") && !path.startsWith(".git");
}

function FilesView({ projectId, diffs }: { projectId: string | null; diffs: FileDiff[] }) {
  const [files, setFiles] = useState<WorkspaceFile[]>([]);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [openFiles, setOpenFiles] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(() => new Set());

  const refresh = useCallback(async () => {
    if (!projectId) { setFiles([]); return; }
    const data = await api.getProject(projectId).catch(() => null);
    // Agent checkpoints stay hidden, but the bundled Apple/SwiftUI skills are
    // real project guidance and belong in the workbench alongside source.
    const next = (data?.files ?? []).filter((file) => shouldShowWorkspaceFile(file.path));
    setFiles(next);
    setSelected((current) => current && next.some((file) => file.path === current) ? current : next[0]?.path ?? null);
  }, [projectId]);

  useEffect(() => { void refresh(); }, [refresh, diffs.length]);

  const changed = useMemo(() => new Set(diffs.map((d) => stripFilePrefix(d.file))), [diffs]);
  const tree = useMemo(() => buildFileTree(files), [files]);
  const selectedFile = files.find((file) => file.path === selected) ?? null;

  useEffect(() => {
    if (!selectedFile) { setDraft(""); return; }
    setDraft(selectedFile.content);
    setOpenFiles((current) => current.includes(selectedFile.path) ? current : [...current, selectedFile.path]);
  }, [selectedFile?.path]);

  const selectFile = useCallback((filePath: string) => setSelected(filePath), []);
  const save = useCallback(async () => {
    if (!projectId || !selected) return;
    setSaving(true);
    try {
      const result = await api.writeProjectFile(projectId, selected, draft);
      setFiles(result.files);
    } finally { setSaving(false); }
  }, [draft, projectId, selected]);

  const createFile = useCallback(async () => {
    if (!projectId) return;
    const requested = window.prompt("New file path", "src/Untitled.ts");
    if (!requested?.trim()) return;
    const result = await api.writeProjectFile(projectId, requested.trim(), "");
    setFiles(result.files);
    setSelected(requested.trim());
  }, [projectId]);

  const createFolder = useCallback(async () => {
    if (!projectId) return;
    const requested = window.prompt("New folder path", "src/components");
    if (!requested?.trim()) return;
    await api.createProjectFolder(projectId, requested.trim());
    await refresh();
  }, [projectId, refresh]);

  const removeSelected = useCallback(async () => {
    if (!projectId || !selected || !window.confirm(`Remove ${selected}?`)) return;
    await api.deleteProjectFile(projectId, selected);
    setOpenFiles((current) => current.filter((path) => path !== selected));
    setSelected(null);
    await refresh();
  }, [projectId, refresh, selected]);

  const renamePath = useCallback(async (path: string) => {
    if (!projectId) return;
    const nextPath = window.prompt("Rename path", path)?.trim();
    if (!nextPath || nextPath === path) return;
    const result = await api.moveProjectPath(projectId, path, nextPath);
    const visibleFiles = result.files.filter((file) => shouldShowWorkspaceFile(file.path));
    setFiles(visibleFiles);
    setSelected((current) => current === path ? nextPath : current);
    setOpenFiles((current) => current.map((item) => item === path ? nextPath : item));
  }, [projectId]);

  const removePath = useCallback(async (path: string, folder = false) => {
    if (!projectId || !window.confirm(`Remove ${folder ? "folder" : "file"} ${path}?`)) return;
    await api.deleteProjectFile(projectId, path, folder);
    setOpenFiles((current) => current.filter((item) => item !== path && !item.startsWith(`${path}/`)));
    setSelected((current) => current === path || current?.startsWith(`${path}/`) ? null : current);
    await refresh();
  }, [projectId, refresh]);

  const handleEditorMount: OnMount = useCallback((editor, monaco) => {
    // Monaco normally shows an empty widget for a brand-new Swift file until
    // it has language-server data. Keep one quiet, useful local completion
    // source available so the editor behaves like an IDE from the first key.
    const disposable = monaco.languages.registerCompletionItemProvider("*", {
      triggerCharacters: [".", "<", "@", "(", "[", "\"", "'"],
      provideCompletionItems: (model, position) => {
        const range = model.getWordUntilPosition(position);
        const editRange = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: range.startColumn,
          endColumn: range.endColumn,
        };
        const language = model.getLanguageId();
        const entries = language === "swift"
          ? ["VStack", "HStack", "ZStack", "Text", "Button", "TextField", "NavigationStack", "@State", ".padding()", ".frame(width:height:)"]
          : language === "typescript" || language === "javascript"
            ? ["const", "function", "return", "useState", "useEffect", "async", "export default"]
          : ["class", "function", "return", "import", "const", "let", "if", "for"];
        return { suggestions: entries.map((label) => ({
          label,
          kind: monaco.languages.CompletionItemKind.Keyword,
          insertText: label,
          range: editRange,
          detail: "Clyra code suggestion",
          sortText: `0-${label}`,
        })) };
      },
    });
    // Deliberately suggest after any source change: compact Monaco suggestions
    // make a single typed character useful without changing the editor model.
    editor.onDidChangeModelContent(() => {
      // Trigger after every typed character. The provider above always offers
      // context-safe basics, so users never get an empty IDE-style popup.
      window.setTimeout(() => {
        if (editor.hasTextFocus()) editor.trigger("clyra", "editor.action.triggerSuggest", {});
      }, 36);
    });
    requestAnimationFrame(() => editor.trigger("clyra", "editor.action.triggerSuggest", {}));
    editor.onDidDispose(() => disposable.dispose());
  }, []);

  const renderNode = (node: FileTreeNode, depth = 0): React.ReactNode[] => {
    const children = [...node.children.values()].sort((a, b) => Number(Boolean(a.file)) - Number(Boolean(b.file)) || a.name.localeCompare(b.name));
    return children.flatMap((child) => {
      if (child.file) {
        if (query && !child.path.toLowerCase().includes(query.toLowerCase())) return [];
        return <div key={child.path} style={{ paddingLeft: 12 + depth * 14 }} className={cn("group flex h-[26px] items-center pr-1.5", selected === child.path ? "bg-black/[0.045]" : "hover:bg-black/[0.03]")}><button type="button" onClick={() => selectFile(child.path)} title={child.path} className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left"><FileCode2 className="h-[12px] w-[12px] shrink-0 text-[#85878C]" strokeWidth={1.55} /><span className="truncate text-[11.5px] text-[#5C5F64]">{child.name}</span>{changed.has(child.path) ? <span className="ml-auto h-1 w-1 shrink-0 rounded-full bg-[#3977F6]" /> : null}</button><button type="button" onClick={(event) => { event.stopPropagation(); void renamePath(child.path); }} title={`Rename ${child.name}`} className="invisible ml-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-[5px] text-[#7D8086] opacity-0 transition-[opacity,background-color] duration-100 hover:bg-black/[0.05] group-hover:visible group-hover:opacity-100"><Pencil className="h-[11px] w-[11px]" strokeWidth={1.6} /></button><button type="button" onClick={(event) => { event.stopPropagation(); void removePath(child.path); }} title={`Remove ${child.name}`} className="invisible ml-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-[5px] text-[#8A6262] opacity-0 transition-[opacity,background-color] duration-100 hover:bg-[#C24949]/[0.08] group-hover:visible group-hover:opacity-100"><Trash2 className="h-[11px] w-[11px]" strokeWidth={1.6} /></button></div>;
      }
      const hidden = collapsedFolders.has(child.path);
      const descendants = renderNode(child, depth + 1);
      if (query && descendants.length === 0) return [];
      return [<div key={`${child.path}-folder`} style={{ paddingLeft: 11 + depth * 14 }} className="group flex h-[27px] items-center pr-1.5 text-[11.75px] font-medium text-[#55585D] transition-colors hover:bg-black/[0.03]"><button type="button" onClick={() => setCollapsedFolders((current) => { const next = new Set(current); if (next.has(child.path)) next.delete(child.path); else next.add(child.path); return next; })} className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left"><ChevronDown className={cn("h-[11px] w-[11px] shrink-0 transition-transform duration-150", hidden && "-rotate-90")} strokeWidth={1.65} />{hidden ? <Folder className="h-[13px] w-[13px] text-[#777A80]" strokeWidth={1.5} /> : <FolderOpen className="h-[13px] w-[13px] text-[#777A80]" strokeWidth={1.5} />}<span className="truncate">{child.name}</span></button><button type="button" onClick={(event) => { event.stopPropagation(); void renamePath(child.path); }} title={`Rename ${child.name}`} className="invisible ml-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-[5px] text-[#7D8086] opacity-0 transition-[opacity,background-color] duration-100 hover:bg-black/[0.05] group-hover:visible group-hover:opacity-100"><Pencil className="h-[11px] w-[11px]" strokeWidth={1.6} /></button><button type="button" onClick={(event) => { event.stopPropagation(); void removePath(child.path, true); }} title={`Remove ${child.name}`} className="invisible ml-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-[5px] text-[#8A6262] opacity-0 transition-[opacity,background-color] duration-100 hover:bg-[#C24949]/[0.08] group-hover:visible group-hover:opacity-100"><Trash2 className="h-[11px] w-[11px]" strokeWidth={1.6} /></button></div>, ...(hidden ? [] : descendants)];
    });
  };

  return (
    <div className="flex min-h-0 flex-1 bg-white">
      <div className="flex w-[218px] shrink-0 flex-col border-r border-black/[0.06]">
        <div className="flex h-[42px] items-center gap-1.5 border-b border-black/[0.06] px-2.5">
          <div className="flex min-w-0 flex-1 items-center gap-1.5 rounded-[7px] bg-black/[0.025] px-2 py-1.5 focus-within:bg-black/[0.04]">
            <Search className="h-[12px] w-[12px] text-[#96989D]" strokeWidth={1.7} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search files" className="min-w-0 flex-1 bg-transparent text-[11.5px] text-[#55575C] outline-none placeholder:text-[#9A9CA0]" />
            {query ? <button type="button" onClick={() => setQuery("")} className="text-[#92949A] hover:text-[#52545A]"><X className="h-[12px] w-[12px]" /></button> : null}
          </div>
          <button type="button" onClick={() => void createFile()} title="New file" className="flex h-[27px] w-[27px] items-center justify-center rounded-[7px] text-[#66696F] transition-colors hover:bg-black/[0.045]"><FilePlus2 className="h-[14px] w-[14px]" strokeWidth={1.55} /></button>
          <button type="button" onClick={() => void createFolder()} title="New folder" className="flex h-[27px] w-[27px] items-center justify-center rounded-[7px] text-[#66696F] transition-colors hover:bg-black/[0.045]"><FolderPlus className="h-[14px] w-[14px]" strokeWidth={1.55} /></button>
        </div>
        <div className="cc-scroll min-h-0 flex-1 overflow-y-auto py-1.5">{files.length ? renderNode(tree) : <p className="px-3 py-3 text-[11.5px] text-[#989AA0]">No files yet.</p>}</div>
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-[34px] items-end gap-1 border-b border-black/[0.06] px-2 pt-1.5">
          <div className="flex min-w-0 flex-1 items-end gap-1 overflow-x-auto">
            {openFiles.map((filePath) => <button key={filePath} type="button" onClick={() => selectFile(filePath)} className={cn("group flex h-[27px] max-w-[190px] shrink-0 items-center gap-1.5 rounded-t-[7px] px-2 text-[11.5px] transition-colors", selected === filePath ? "bg-black/[0.055] text-[#36383D]" : "text-[#84868B] hover:bg-black/[0.03]")}><FileCode2 className="h-[11px] w-[11px] shrink-0" strokeWidth={1.55} /><span className="truncate">{filePath.split("/").at(-1)}</span><span role="button" aria-label={`Close ${filePath}`} onClick={(event) => { event.stopPropagation(); setOpenFiles((current) => current.filter((path) => path !== filePath)); if (selected === filePath) setSelected(openFiles.find((path) => path !== filePath) ?? null); }} className="ml-0.5 rounded p-0.5 opacity-0 transition-opacity hover:bg-black/[0.06] group-hover:opacity-100"><X className="h-[10px] w-[10px]" /></span></button>)}
          </div>
          {selectedFile ? <><button type="button" onClick={() => void save()} disabled={saving || draft === selectedFile.content} title="Save file" className="mb-0.5 flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-[7px] text-[#5F6368] transition-colors hover:bg-black/[0.045] disabled:opacity-35"><Save className="h-[13px] w-[13px]" strokeWidth={1.55} /></button><button type="button" onClick={() => void removeSelected()} title="Remove file" className="mb-0.5 flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-[7px] text-[#7A5656] transition-colors hover:bg-[#C24949]/[0.08]"><Trash2 className="h-[13px] w-[13px]" strokeWidth={1.55} /></button></> : null}
        </div>
        {selectedFile ? <div className="cc-code-editor min-h-0 flex-1 overflow-hidden"><Editor height="100%" path={selectedFile.path} language={fileLanguage(selectedFile.path)} value={draft} onChange={(value) => setDraft(value ?? "")} onMount={handleEditorMount} theme="vs" options={{ fontSize: 12, lineHeight: 19, fontFamily: '"SFMono-Regular", "SF Mono", Menlo, Monaco, Consolas, monospace', minimap: { enabled: false }, padding: { top: 12, bottom: 12 }, scrollBeyondLastLine: false, renderLineHighlight: "gutter", suggestOnTriggerCharacters: true, quickSuggestions: { other: true, comments: true, strings: true }, suggest: { showIcons: true, showStatusBar: false, preview: false, selectionMode: "whenQuickSuggestion" }, fixedOverflowWidgets: false, tabSize: 2, automaticLayout: true, smoothScrolling: true, wordWrap: "off", overviewRulerBorder: false }} /></div> : <div className="flex h-full items-center justify-center"><p className="text-[12px] text-[#999BA0]">Select a file to edit.</p></div>}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Panel shell with tabs                                               */
/* ------------------------------------------------------------------ */

const EXTRA_TABS: Array<{ id: RightTab; label: string }> = [
  { id: "changes", label: "Changes" },
  { id: "files", label: "Files" },
];

export function RightPanel({
  state,
  actionList,
  tab,
  onTabChange,
  preview,
  onAddContext,
  focusFile,
  agentRunning = false,
  onOpenTerminal,
  platform = "web",
  relaunchSignal = 0,
  onVisualEdit,
  onVisualSourceEdit,
  onPreviewError,
  fullscreen = false,
  onToggleFullscreen,
}: {
  state: ClyraCodeState;
  actionList: AgentAction[];
  tab: RightTab;
  onTabChange: (tab: RightTab) => void;
  preview: ReturnType<typeof usePreview>;
  onAddContext: (context: ComposerContext) => void;
  focusFile: string | null;
  agentRunning?: boolean;
  onOpenTerminal?: () => void;
  platform?: ProjectPlatform;
  /** Bumps after successful agent runs; iOS preview reinstalls + relaunches. */
  relaunchSignal?: number;
  /** Route visual changes that need the agent back into the coding stream. */
  onVisualEdit?: (instruction: string) => void;
  /** Record a successful direct source edit in Clyra's existing change stream. */
  onVisualSourceEdit?: (edit: { file: string; before: string; after: string; additions: number; deletions: number }) => void;
  /** A real preview error can be offered to the agent after its run settles. */
  onPreviewError?: (message: string) => void;
  fullscreen?: boolean;
  onToggleFullscreen?: () => void;
}) {
  const [inspectMode, setInspectMode] = useState(false);
  const [selection, setSelection] = useState<InspectPayload | null>(null);
  const frameWindowRef = useRef<Window | null>(null);

  const postToFrame = (message: unknown) => {
    frameWindowRef.current?.postMessage(message, "*");
  };

  // Messages from the injected inspect script inside the preview frame.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const data = event.data as {
        type?: string;
        payload?: InspectPayload;
        elId?: number;
        rect?: { left: number; top: number; width: number; height: number };
        absolute?: boolean;
      };
      if (!data || typeof data !== "object" || !data.type) return;
      if (event.source !== frameWindowRef.current) return;
      if (data.type === "clyra:element" && data.payload) {
        setSelection(data.payload);
        onAddContext({
          id: `inspect-${Date.now()}`,
          label: selectionChipLabel(data.payload),
          detail: selectionContextDetail(data.payload),
        });
      } else if (data.type === "clyra:clear") {
        setSelection(null);
      } else if (data.type === "clyra:drag" && data.rect) {
        handleDragChange({
          elId: data.elId,
          rect: data.rect,
          absolute: data.absolute,
          styles: (data as { styles?: Record<string, string> }).styles,
        });
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection, inspectMode, state.activeProjectId]);

  // Esc clears the selection; toggling off clears everything.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && (selection || inspectMode)) {
        setSelection(null);
        postToFrame({ type: "clyra:clear" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection, inspectMode]);

  useEffect(() => {
    postToFrame({ type: "clyra:mode", mode: inspectMode });
    if (!inspectMode) setSelection(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inspectMode]);

  const agentFallback = (property: string, value: string) => {
    if (!selection || !onVisualEdit) return;
    onVisualEdit(
      `Change ${property} to "${value}" on the selected preview element. Here is its structured inspect context:\n${selectionContextDetail(selection)}\nUpdate the real source files so the change is permanent. Do not use a temporary preview-only style.`,
    );
  };

  const cssProperty = (property: string) => property.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

  const recordSourceEdit = (result: Awaited<ReturnType<typeof api.sourceEdit>>, reload = true) => {
    if (result.applied && result.file && typeof result.before === "string" && typeof result.after === "string") {
      onVisualSourceEdit?.({
        file: result.file,
        before: result.before,
        after: result.after,
        additions: result.additions ?? 0,
        deletions: result.deletions ?? 0,
      });
      if (reload) preview.reload();
    }
  };

  const handleChange = (property: string, value: string, liveStyles?: Record<string, string>) => {
    if (!selection || !state.activeProjectId) return;
    if (liveStyles && selection.elId) {
      postToFrame({ type: "clyra:style", elId: selection.elId, styles: liveStyles });
    }
    if (property === "__ios__") {
      onVisualEdit?.(
        `In the iOS app, change the selected view ${selection.label ?? ""} at (${selection.x ?? 0}, ${selection.y ?? 0}) on ${selection.device ?? "the simulator"}: ${value}. Locate the real SwiftUI view in the project and update its source.`,
      );
      setSelection(null);
      return;
    }
    const rule =
      selection.rules?.find((r) => r.file && r.declarations[property] !== undefined) ??
      selection.rules?.find((r) => r.file);
    if (rule?.file && rule.selector) {
      void api
        .sourceEdit(state.activeProjectId, {
          file: rule.file,
          selector: rule.selector,
          property: cssProperty(property),
          value,
        })
        .then((result) => {
          if (!result.applied) agentFallback(property, value);
          else recordSourceEdit(result);
        })
        .catch(() => agentFallback(property, value));
    } else {
      agentFallback(property, value);
    }
  };

  const handleDragChange = (data: {
    elId?: number;
    rect: { left: number; top: number; width: number; height: number };
    absolute?: boolean;
    styles?: Record<string, string>;
  }) => {
    if (!selection || !state.activeProjectId) return;
    const rule = selection.rules?.find((r) => r.file);
    const rect = data.rect;
    if (rule?.file && rule.selector && data.styles && Object.keys(data.styles).length) {
      const edits = Object.entries(data.styles).map(([property, value]) => ({ property: cssProperty(property), value }));
      void Promise.all(
        edits.map((edit) =>
          api.sourceEdit(state.activeProjectId!, {
            file: rule.file!,
            selector: rule.selector,
            property: edit.property,
            value: edit.value,
          }),
        ),
      )
        .then((results) => {
          results.forEach((result) => recordSourceEdit(result, false));
          preview.reload();
        })
        .catch(() => agentFallback("layout", `${Math.round(rect.width)}×${Math.round(rect.height)}`));
    } else if (onVisualEdit) {
      onVisualEdit(
        `Move or resize the selected preview element so it is ${Math.round(rect.width)}×${Math.round(rect.height)} at (${Math.round(rect.left)}, ${Math.round(rect.top)}).\n${selectionContextDetail(selection)}\nUse its existing responsive layout system (flex, grid, CSS layout, or SwiftUI modifiers) rather than introducing absolute positioning unless it is already positioned freely.`,
      );
    }
  };

  const tabs: Array<{ id: RightTab; label: string; icon?: typeof Globe }> = [
    { id: "browser", label: platform === "ios" ? "iPhone Preview" : "Browser", icon: Globe },
    ...EXTRA_TABS,
  ];

  return (
    <section className={cn("relative flex min-h-0 min-w-0 flex-1 flex-col bg-[color:var(--preview-background)] transition-[opacity,transform] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]", fullscreen && "fixed inset-0 z-[100] bg-white shadow-2xl")}>
      <div className="relative flex h-[42px] min-w-max items-center gap-1 border-b border-[color:var(--border-subtle)] px-2.5">
        {tabs.map((entry) => {
          const Icon = entry.icon;
          const selected = tab === entry.id;
          return (
            <button
              key={entry.id}
              type="button"
              onClick={() => onTabChange(entry.id)}
              className={cn(
                "relative flex items-center gap-1.5 rounded-[7px] px-[9px] py-[6px] text-[11.75px] transition-colors duration-100",
                selected
                  ? "bg-[#F1F1F0] font-medium text-[#34363A]"
                  : "text-[#818388] hover:bg-black/[0.03]",
              )}
            >
              <span className="flex items-center gap-1.5">
                {Icon ? <Icon className="h-[13px] w-[13px]" strokeWidth={1.8} /> : null}
                {entry.label}
              </span>
            </button>
          );
        })}
      </div>

      {tab === "browser" ? (
        platform === "ios" ? (
          <IPhonePanel
            projectId={state.activeProjectId}
            buildVersion={relaunchSignal}
            agentRunning={agentRunning}
            inspectMode={inspectMode}
            onToggleInspect={() => setInspectMode((mode) => !mode)}
            onInspectElement={(payload) => {
              setSelection(payload);
              onAddContext({
                id: `inspect-${Date.now()}`,
                label: selectionChipLabel(payload),
                detail: selectionContextDetail(payload),
              });
            }}
            onPreviewError={onPreviewError}
            fullscreen={fullscreen}
            onToggleFullscreen={() => onToggleFullscreen?.()}
          />
        ) : (
          <BrowserView
            session={preview.session}
            frameVersion={preview.frameVersion}
            onReload={preview.reload}
            onRestart={preview.restart}
            onOpenTerminal={onOpenTerminal}
            onAddContext={onAddContext}
            agentRunning={agentRunning}
            projectId={state.activeProjectId}
            inspectMode={inspectMode}
            onToggleInspect={() => setInspectMode((mode) => !mode)}
            onFrameReady={(win) => {
              frameWindowRef.current = win;
            }}
            onPreviewError={onPreviewError}
            fullscreen={fullscreen}
            onToggleFullscreen={() => onToggleFullscreen?.()}
          />
        )
      ) : tab === "changes" ? (
        <ChangesView diffs={state.diffs} actions={actionList} focusFile={focusFile} />
      ) : (
        <FilesView projectId={state.activeProjectId} diffs={state.diffs} />
      )}

      {inspectMode && selection ? (
        <VisualInspector
          payload={selection}
          onClose={() => {
            setSelection(null);
            postToFrame({ type: "clyra:clear" });
          }}
          onChange={handleChange}
        />
      ) : null}
    </section>
  );
}
