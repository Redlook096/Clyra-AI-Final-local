"use client";

import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  ChevronLeft,
  ChevronRight,
  Code2,
  Crosshair,
  File,
  FileJson,
  FilePlus,
  FileText,
  Folder,
  FolderPlus,
  LayoutTemplate,
  Maximize2,
  Minimize2,
  RotateCw,
  Sparkles,
  AlertCircle,
  X,
} from "lucide-react";
import {
  buildVibePreviewSrcDoc,
  pickPrimaryPreviewPath,
} from "@/lib/buildVibePreviewSrcDoc";
import { sandboxVibePath } from "@/lib/parseVibeAgentContent";
import { cn } from "@/lib/utils";
import { isElectronRuntime } from "@/lib/electron-runtime";
import { ElectronWebContentsSurface } from "@/components/ElectronWebContentsSurface";
import { motion, AnimatePresence } from "framer-motion";

const STORAGE_KEY = "clyra_vibe_preview_files";

type Props = {
  filesByPath: Record<string, string>;
  className?: string;
  /** Patch streamed files into the editor map without wiping user-added paths (active vibe stream). */
  mergeFilesFromStream?: boolean;
  onAutoFix?: (error: {
    message: string;
    stack?: string;
    label?: string;
  }) => void;
  setToastMessage?: (message: string) => void;
  onReferenceElement?: (label: string) => void;
};

type WorkspaceMode = "preview" | "code";

const CODE_COMPLETIONS = [
  "function",
  "const",
  "return",
  "className",
  "children",
  "component",
  "interface",
  "useState",
  "useEffect",
  "useMemo",
  "useCallback",
  "import",
  "export",
  "async",
  "await",
  "background",
  "transition",
  "transform",
  "borderRadius",
  "document",
  "window",
  "response",
  "request",
  "Promise",
];

function getCodeCompletion(prefix: string) {
  const lower = prefix.toLowerCase();
  return CODE_COMPLETIONS.find(
    (item) => item.toLowerCase().startsWith(lower) && item.length > prefix.length,
  );
}

type AgentCursorState = {
  visible: boolean;
  x: number;
  y: number;
  label: string;
  clicking: boolean;
};

type TreeNode = {
  name: string;
  /** Full path for files; for dirs, path without trailing slash */
  path: string;
  kind: "file" | "dir";
  children: TreeNode[];
};

function normDir(p: string): string {
  return p.replace(/\/+$/, "").replace(/^\/+/, "");
}

function collectDirsFromFiles(files: Record<string, string>): Set<string> {
  const dirs = new Set<string>();
  for (const p of Object.keys(files)) {
    const parts = p.split("/").filter(Boolean);
    let acc = "";
    for (let i = 0; i < parts.length - 1; i++) {
      acc = acc ? `${acc}/${parts[i]}` : parts[i]!;
      dirs.add(acc);
    }
  }
  return dirs;
}

function inferPreviewTestPrompt(files: Record<string, string>) {
  const haystack = Object.entries(files)
    .map(([path, body]) => `${path}\n${body.slice(0, 3000)}`)
    .join("\n")
    .toLowerCase();
  if (/calculator|usecalculator|calculatorbuttons/.test(haystack))
    return "calculator";
  if (/platformer|gamecanvas|usegameloop|player|gravity|coin/.test(haystack))
    return "2d platformer game";
  if (/landing|hero|pricing|testimonial/.test(haystack)) return "landing page";
  return "interactive app";
}

const CODE_TOKEN_RE =
  /(\/\/.*$|\/\*[\s\S]*?\*\/)|(["'`])(?:\\.|(?!\2).)*\2|\b(import|export|from|type|interface|function|const|let|return|if|else|for|while|map|filter|reduce|useState|useMemo|useEffect|className|default|extends|React)\b|\b([A-Z][A-Za-z0-9_]*)\b|\b(\d+(?:\.\d+)?)\b/g;

function highlightCodeLine(line: string) {
  const nodes: ReactNode[] = [];
  let lastIndex = 0;

  for (const match of line.matchAll(CODE_TOKEN_RE)) {
    const index = match.index ?? 0;
    if (index > lastIndex) nodes.push(line.slice(lastIndex, index));
    const token = match[0];
    const className = match[1]
      ? "text-slate-400 italic"
      : /^["'`]/.test(token)
        ? "text-emerald-300"
        : match[3]
          ? "text-violet-300 font-semibold"
          : match[4]
            ? "text-sky-300"
            : match[5]
              ? "text-amber-300"
              : "text-slate-200";
    nodes.push(
      <span key={`${index}-${token}`} className={className}>
        {token}
      </span>,
    );
    lastIndex = index + token.length;
  }

  if (lastIndex < line.length) nodes.push(line.slice(lastIndex));
  return nodes;
}

function recordsEqual(a: Record<string, string>, b: Record<string, string>) {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => a[key] === b[key]);
}

function filesSignature(files: Record<string, string>) {
  return JSON.stringify(
    Object.keys(files)
      .sort()
      .map((key) => [key, files[key]]),
  );
}

function buildTree(
  files: Record<string, string>,
  extraDirs: Set<string>,
): TreeNode {
  const dirs = collectDirsFromFiles(files);
  for (const d of extraDirs) {
    const n = normDir(d);
    if (n) dirs.add(n);
    const parts = n.split("/").filter(Boolean);
    let acc = "";
    for (const part of parts) {
      acc = acc ? `${acc}/${part}` : part;
      dirs.add(acc);
    }
  }

  const filePaths = Object.keys(files);
  const root: TreeNode = { name: "", path: "", kind: "dir", children: [] };
  const findChild = (parent: TreeNode, name: string) =>
    parent.children.find((c) => c.name === name && c.kind === "dir");

  for (const dir of dirs) {
    const parts = dir.split("/").filter(Boolean);
    let cur = root;
    let acc = "";
    for (const part of parts) {
      acc = acc ? `${acc}/${part}` : part;
      let next = findChild(cur, part);
      if (!next) {
        next = { name: part, path: acc, kind: "dir", children: [] };
        cur.children.push(next);
      }
      cur = next;
    }
  }

  for (const fp of filePaths) {
    const parts = fp.split("/").filter(Boolean);
    if (parts.length === 0) continue;
    let cur = root;
    let acc = "";
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!;
      const isLast = i === parts.length - 1;
      acc = acc ? `${acc}/${part}` : part;
      if (isLast) {
        cur.children.push({ name: part, path: fp, kind: "file", children: [] });
      } else {
        let next = findChild(cur, part);
        if (!next) {
          next = { name: part, path: acc, kind: "dir", children: [] };
          cur.children.push(next);
        }
        cur = next;
      }
    }
  }

  const sortNodes = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const n of nodes) {
      if (n.kind === "dir") sortNodes(n.children);
    }
  };
  sortNodes(root.children);
  return root;
}

function FileGlyph({ path }: { path: string }) {
  const p = path.toLowerCase();
  if (p.endsWith(".json"))
    return (
      <FileJson
        className="h-3.5 w-3.5 shrink-0 text-amber-600/90"
        strokeWidth={1.75}
      />
    );
  if (p.endsWith(".md"))
    return (
      <FileText
        className="h-3.5 w-3.5 shrink-0 text-sky-600/90"
        strokeWidth={1.75}
      />
    );
  return (
    <File className="h-3.5 w-3.5 shrink-0 text-slate-500" strokeWidth={1.75} />
  );
}

const TreeRows = memo(function TreeRows({
  nodes,
  depth,
  expanded,
  toggle,
  activePath,
  onPick,
}: {
  nodes: TreeNode[];
  depth: number;
  expanded: Record<string, boolean>;
  toggle: (path: string) => void;
  activePath: string;
  onPick: (path: string) => void;
}) {
  return (
    <>
      {nodes.map((n) => {
        if (n.kind === "dir") {
          const open = expanded[n.path] !== false; // default expanded
          return (
            <div key={`d:${n.path}`}>
              <button
                type="button"
                onClick={() => toggle(n.path)}
                className="flex w-full items-center gap-0.5 rounded-md px-1 py-[3px] text-left text-[12.5px] text-slate-600 transition-colors hover:bg-white/[0.85]"
                style={{ paddingLeft: 6 + depth * 12 }}
              >
                <ChevronRight
                  className={cn(
                    "h-3 w-3 shrink-0 text-slate-400 transition-transform",
                    open && "rotate-90",
                  )}
                  strokeWidth={2}
                />
                <Folder
                  className="h-3.5 w-3.5 shrink-0 text-slate-500/90"
                  strokeWidth={1.75}
                />
                <span className="min-w-0 truncate">{n.name}</span>
              </button>
              {open ? (
                <TreeRows
                  nodes={n.children}
                  depth={depth + 1}
                  expanded={expanded}
                  toggle={toggle}
                  activePath={activePath}
                  onPick={onPick}
                />
              ) : null}
            </div>
          );
        }
        const active = n.path === activePath;
        return (
          <button
            key={`f:${n.path}`}
            type="button"
            onClick={() => onPick(n.path)}
            className={cn(
              "flex w-full items-center gap-1.5 rounded-md px-1 py-[3px] text-left text-[12.5px] transition-all",
              active
                ? "bg-white text-slate-900 shadow-sm ring-1 ring-slate-200/70"
                : "text-slate-600 hover:bg-white/[0.85]",
            )}
            style={{ paddingLeft: 10 + depth * 12 }}
          >
            <span className="inline-block w-3 shrink-0" />
            <FileGlyph path={n.path} />
            <span className="min-w-0 truncate">{n.name}</span>
          </button>
        );
      })}
    </>
  );
});

/**
 * Workbench: file tree + Monaco + mini-browser preview. The iframe loads your running dev server
 * at `?vibe_embed=1` (same as `npm run dev` for this app); files are synced via sessionStorage.
 */
export function VibeLivePreviewPanel({
  filesByPath,
  className,
  mergeFilesFromStream = false,
  onAutoFix,
  setToastMessage,
  onReferenceElement,
}: Props) {
  const [mergedFiles, setMergedFiles] = useState<Record<string, string>>(() => {
    const next: Record<string, string> = {};
    for (const [path, body] of Object.entries(filesByPath))
      next[sandboxVibePath(path)] = body;
    return next;
  });
  const [virtualDirs, setVirtualDirs] = useState<Set<string>>(() => new Set());
  const [expanded, setExpanded] = useState<Record<string, boolean>>({
    "": true,
  });
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>("preview");
  const [editorScroll, setEditorScroll] = useState({ top: 0, left: 0 });
  const [codeCompletion, setCodeCompletion] = useState<{
    suggestion: string;
    prefix: string;
    x: number;
    y: number;
  } | null>(null);
  const [addressInput, setAddressInput] = useState("");
  const [lastError, setLastError] = useState<{
    message: string;
    stack?: string;
    label?: string;
  } | null>(null);
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<any>(null);
  const [sessionUrl, setSessionUrl] = useState("");
  const [sessionStatus, setSessionStatus] = useState<
    "idle" | "syncing" | "ready" | "offline"
  >("idle");
  const [previewNotice, setPreviewNotice] = useState<string | null>(null);
  const [previewLoaded, setPreviewLoaded] = useState(false);
  const [isPreviewFullscreen, setIsPreviewFullscreen] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  const [agentCursor, setAgentCursor] = useState<AgentCursorState>({
    visible: false,
    x: 46,
    y: 40,
    label: "Headful Mode",
    clicking: false,
  });
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const codeTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const lastSessionSignatureRef = useRef<string | null>(null);
  const cursorTimeoutsRef = useRef<number[]>([]);

  useEffect(() => {
    setWorkspaceMode("preview");
    setLastError(null);
  }, [filesByPath]);

  useEffect(
    () => () => {
      for (const id of cursorTimeoutsRef.current) window.clearTimeout(id);
      cursorTimeoutsRef.current = [];
    },
    [],
  );

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.data?.type === "VIBE_PREVIEW_ERROR") {
        setLastError({
          message: event.data.message,
          stack: event.data.stack,
          label: event.data.label,
        });
      } else if (event.data?.type === "VIBE_FOCUS_SELECT") {
        const label =
          typeof event.data.label === "string"
            ? event.data.label
            : "preview element";
        onReferenceElement?.(label);
        setFocusMode(false);
      }
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [onReferenceElement]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsPreviewFullscreen(false);
        setFocusMode(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    iframeRef.current?.contentWindow?.postMessage(
      { type: "VIBE_FOCUS_MODE", enabled: focusMode },
      "*",
    );
  }, [focusMode, sessionUrl, previewLoaded]);

  useEffect(() => {
    if (mergeFilesFromStream) {
      setMergedFiles((prev) => {
        const next = { ...prev };
        for (const k of Object.keys(filesByPath)) {
          next[sandboxVibePath(k)] = filesByPath[k]!;
        }
        return recordsEqual(prev, next) ? prev : next;
      });
    } else {
      const next: Record<string, string> = {};
      for (const [path, body] of Object.entries(filesByPath))
        next[sandboxVibePath(path)] = body;
      setMergedFiles((prev) => (recordsEqual(prev, next) ? prev : next));
    }
  }, [filesByPath, mergeFilesFromStream]);

  const mergedFilesSignature = useMemo(
    () => filesSignature(mergedFiles),
    [mergedFiles],
  );

  const defaultPath = useMemo(
    () => pickPrimaryPreviewPath(mergedFiles),
    [mergedFiles],
  );
  const [activePath, setActivePath] = useState(defaultPath);

  useEffect(() => {
    if (mergedFiles[activePath] !== undefined) return;
    setActivePath((defaultPath || Object.keys(mergedFiles)[0]) ?? "");
  }, [activePath, defaultPath, mergedFiles]);

  const tree = useMemo(
    () => buildTree(mergedFiles, virtualDirs),
    [mergedFiles, virtualDirs],
  );

  /** Real isolated dev server rooted at vibe-sandbox/, separate from the Clyra app. */
  const SANDBOX_DEV_HOST = "http://localhost:5174";

  useLayoutEffect(() => {
    setAddressInput(`${SANDBOX_DEV_HOST}/`);
  }, []);

  const externalEmbedUrl = useMemo(() => {
    if (typeof window === "undefined") return "";
    return new URL("/?vibe_embed=1", window.location.origin).href;
  }, []);

  const previewSrcDoc = useMemo(
    () => buildVibePreviewSrcDoc(mergedFiles),
    [mergedFiles],
  );

  useLayoutEffect(() => {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(mergedFiles));
    } catch {
      /* ignore quota */
    }
  }, [mergedFiles]);

  useEffect(() => {
    if (Object.keys(mergedFiles).length === 0) {
      setSessionUrl("");
      setSessionStatus("idle");
      lastSessionSignatureRef.current = null;
      return;
    }
    if (
      lastSessionSignatureRef.current === mergedFilesSignature &&
      sessionUrl
    ) {
      return;
    }
    const controller = new AbortController();
    let timedOut = false;
    const syncTimeout = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 8000);
    const id = window.setTimeout(async () => {
      setSessionStatus("syncing");
      setPreviewLoaded(false);
      setLastError(null);
      setTestResult(null);
      try {
        const response = await fetch(`${SANDBOX_DEV_HOST}/api/session`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ files: mergedFiles }),
          signal: controller.signal,
        });
        if (!response.ok)
          throw new Error(`Sandbox sync failed: ${response.status}`);
        const result = (await response.json()) as { url?: string };
        if (!result.url)
          throw new Error("Sandbox server did not return a preview URL");
        lastSessionSignatureRef.current = mergedFilesSignature;
        setSessionUrl(result.url);
        setAddressInput(result.url);
        setSessionStatus("ready");
        setLastError(null);
        setTestResult(null);
        setPreviewNotice(null);
      } catch (error) {
        if (controller.signal.aborted && !timedOut) return;
        console.warn(
          "Vibe sandbox server unavailable; falling back to inline preview.",
          error,
        );
        setSessionUrl("");
        setSessionStatus("offline");
        setPreviewNotice(
          timedOut
            ? "Sandbox sync timed out. Inline fallback is active."
            : "Sandbox offline. Inline fallback is active.",
        );
      } finally {
        window.clearTimeout(syncTimeout);
      }
    }, 220);
    return () => {
      controller.abort();
      window.clearTimeout(id);
      window.clearTimeout(syncTimeout);
    };
  }, [SANDBOX_DEV_HOST, mergedFiles, mergedFilesSignature, sessionUrl]);

  const toggleDir = useCallback((path: string) => {
    setExpanded((e) => ({ ...e, [path]: e[path] === false ? true : false }));
  }, []);

  const parentDir = useCallback((filePath: string) => {
    const i = filePath.lastIndexOf("/");
    return i === -1 ? "" : filePath.slice(0, i);
  }, []);

  const ensureExpandedPath = useCallback((filePath: string) => {
    const parts = filePath.split("/").filter(Boolean);
    setExpanded((prev) => {
      const next = { ...prev };
      let acc = "";
      for (let i = 0; i < parts.length - 1; i++) {
        acc = acc ? `${acc}/${parts[i]!}` : parts[i]!;
        next[acc] = true;
      }
      return next;
    });
  }, []);

  const handleNewFile = useCallback(() => {
    const base =
      activePath && mergedFiles[activePath] !== undefined
        ? parentDir(activePath)
        : "";
    const suggestion = base ? `${base}/Untitled.tsx` : "src/Untitled.tsx";
    const rel = window.prompt("New file path", suggestion)?.trim();
    if (!rel) return;
    const clean = sandboxVibePath(rel);
    setMergedFiles((m) => ({ ...m, [clean]: "// New file\n" }));
    setActivePath(clean);
    ensureExpandedPath(clean);
  }, [activePath, mergedFiles, parentDir, ensureExpandedPath]);

  const handleNewFolder = useCallback(() => {
    const base =
      activePath && mergedFiles[activePath] !== undefined
        ? parentDir(activePath)
        : "";
    const suggestion = base ? `${base}/new-folder` : "src/new-folder";
    const rel = window.prompt("New folder path", suggestion)?.trim();
    if (!rel) return;
    const clean = normDir(sandboxVibePath(rel));
    if (!clean) return;
    setVirtualDirs((d) => new Set(d).add(clean));
    ensureExpandedPath(`${clean}/.keep`);
    setExpanded((e) => ({ ...e, [clean]: true }));
  }, [activePath, mergedFiles, parentDir, ensureExpandedPath]);

  const editorValue = mergedFiles[activePath] ?? "";

  const updateCodeCompletion = useCallback((textarea: HTMLTextAreaElement) => {
    const beforeCursor = textarea.value.slice(0, textarea.selectionStart);
    const match = beforeCursor.match(/([A-Za-z_$][\w$]*)$/);
    if (!match || match[1].length < 2) {
      setCodeCompletion(null);
      return;
    }

    const suggestion = getCodeCompletion(match[1]);
    if (!suggestion) {
      setCodeCompletion(null);
      return;
    }

    const lines = beforeCursor.split("\n");
    const lineIndex = lines.length - 1;
    const column = lines[lineIndex]?.length ?? 0;
    const lineHeight = 20;
    const charWidth = 7.2;
    setCodeCompletion({
      suggestion,
      prefix: match[1],
      x: Math.min(520, 64 + column * charWidth - textarea.scrollLeft),
      y: Math.max(10, 12 + lineIndex * lineHeight - textarea.scrollTop - 36),
    });
  }, []);

  const acceptCodeCompletion = useCallback(() => {
    const textarea = codeTextareaRef.current;
    if (!textarea || !codeCompletion || !activePath) return false;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const remainder = codeCompletion.suggestion.slice(codeCompletion.prefix.length);
    const next = `${editorValue.slice(0, start)}${remainder}${editorValue.slice(end)}`;
    setMergedFiles((m) => ({ ...m, [activePath]: next }));
    setCodeCompletion(null);
    window.requestAnimationFrame(() => {
      const nextPosition = start + remainder.length;
      textarea.focus();
      textarea.setSelectionRange(nextPosition, nextPosition);
    });
    return true;
  }, [activePath, codeCompletion, editorValue]);

  const runAgentCursorReplay = useCallback(() => {
    for (const id of cursorTimeoutsRef.current) window.clearTimeout(id);
    cursorTimeoutsRef.current = [];
    const steps: Array<Partial<AgentCursorState> & { at: number }> = [
      {
        at: 0,
        visible: true,
        x: 18,
        y: 22,
        label: "Opening preview",
        clicking: false,
      },
      { at: 650, x: 48, y: 38, label: "Scanning UI", clicking: false },
      {
        at: 1250,
        x: 66,
        y: 58,
        label: "Checking interactions",
        clicking: true,
      },
      { at: 1700, clicking: false },
      { at: 2200, x: 34, y: 70, label: "Testing controls", clicking: true },
      { at: 2700, clicking: false },
      { at: 3400, x: 72, y: 28, label: "Validating render", clicking: false },
    ];
    for (const step of steps) {
      const id = window.setTimeout(() => {
        setAgentCursor((prev) => ({ ...prev, ...step, visible: true }));
      }, step.at);
      cursorTimeoutsRef.current.push(id);
    }
  }, []);

  const testPreview = useCallback(async () => {
    if (Object.keys(mergedFiles).length === 0) return;
    const inferredPrompt = inferPreviewTestPrompt(mergedFiles);
    setIsTesting(true);
    setTestResult(null);
    setPreviewNotice(`Headful Mode: testing ${inferredPrompt}`);
    runAgentCursorReplay();
    try {
      const response = await fetch(`${SANDBOX_DEV_HOST}/api/test-preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: sessionUrl || `${SANDBOX_DEV_HOST}/`,
          files: mergedFiles,
          testPrompt: inferredPrompt,
          headfulMode: true,
        }),
      });
      if (!response.ok)
        throw new Error(`Preview test failed: ${response.status}`);
      const result = await response.json();
      setTestResult(result);
      if (result.success && !result.blank) {
        setPreviewNotice("Headful Mode preview test passed.");
        setToastMessage?.("Vibe preview test passed");
      } else {
        const reason = result.blank
          ? "Preview looked blank in Headful Mode."
          : (result.pageErrors?.[0] ?? "Preview test found errors.");
        setPreviewNotice(reason);
        setToastMessage?.("Preview test found errors");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setTestResult({ success: false, error: message });
      setPreviewNotice(message);
      setToastMessage?.("Preview test failed");
    } finally {
      setIsTesting(false);
      const id = window.setTimeout(() => {
        setAgentCursor((prev) => ({
          ...prev,
          visible: false,
          clicking: false,
        }));
      }, 1200);
      cursorTimeoutsRef.current.push(id);
    }
  }, [
    SANDBOX_DEV_HOST,
    mergedFiles,
    runAgentCursorReplay,
    sessionUrl,
    setToastMessage,
  ]);

  const reload = useCallback(() => {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(mergedFiles));
    } catch {
      /* ignore */
    }
    if (iframeRef.current?.contentWindow) {
      try {
        iframeRef.current.contentWindow.location.reload();
        return;
      } catch {
        /* cross-origin */
      }
    }
    if (iframeRef.current) {
      iframeRef.current.src = iframeRef.current.src;
    }
  }, [mergedFiles]);

  const goBack = useCallback(() => {
    try {
      iframeRef.current?.contentWindow?.history.back();
    } catch {
      /* ignore cross-origin */
    }
  }, []);

  const goForward = useCallback(() => {
    try {
      iframeRef.current?.contentWindow?.history.forward();
    } catch {
      /* ignore cross-origin */
    }
  }, []);

  const openExternal = useCallback(() => {
    if (sessionUrl) {
      window.open(sessionUrl, "_blank", "noopener,noreferrer");
      return;
    }
    if (!externalEmbedUrl) return;
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(mergedFiles));
    } catch {
      /* ignore */
    }
    window.open(externalEmbedUrl, "_blank", "noopener,noreferrer");
  }, [externalEmbedUrl, mergedFiles]);

  const handleAddressSubmit = useCallback(
    (e: FormEvent) => {
      e.preventDefault();
      try {
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify(mergedFiles));
      } catch {
        /* ignore */
      }
      if (iframeRef.current) {
        iframeRef.current.src = iframeRef.current.src;
      }
      if (addressInput.startsWith(SANDBOX_DEV_HOST))
        setSessionUrl(addressInput);
    },
    [addressInput, mergedFiles, SANDBOX_DEV_HOST],
  );

  const projectLabel = useMemo(() => {
    if (typeof window === "undefined") return "Project";
    const seg = window.location.pathname.split("/").filter(Boolean);
    return seg.length ? seg[seg.length - 1]! : "Project";
  }, []);

  const healthTone = useMemo(() => {
    if (lastError || testResult?.success === false) return "error";
    if (isTesting || sessionStatus === "syncing") return "busy";
    if (sessionStatus === "ready") return "ready";
    if (sessionStatus === "offline") return "warn";
    return "idle";
  }, [isTesting, lastError, sessionStatus, testResult]);

  const healthText = useMemo(() => {
    if (lastError) return "Runtime error";
    if (isTesting) return "Testing preview";
    if (sessionStatus === "syncing") return "Syncing sandbox";
    if (sessionStatus === "ready") return "Sandbox live";
    if (sessionStatus === "offline") return "Inline fallback";
    return "Preview ready";
  }, [isTesting, lastError, sessionStatus]);

  const showPreviewSyncOverlay = sessionStatus === "syncing" && !sessionUrl;

  const requestAutoFix = useCallback(() => {
    const message =
      lastError ??
      (testResult?.blank
        ? {
            label: "blank preview",
            message:
              "The Vibe live preview rendered blank in a headless browser test.",
          }
        : testResult?.pageErrors?.length
          ? { label: "preview test", message: testResult.pageErrors.join("\n") }
          : testResult?.error
            ? { label: "preview test", message: testResult.error }
            : null);
    if (!message || !onAutoFix) return;
    onAutoFix(message);
    setLastError(null);
    setPreviewNotice("Auto Fix requested in chat.");
  }, [lastError, onAutoFix, testResult]);

  return (
    <div
      className={cn(
        "flex h-full min-h-0 min-w-0 max-h-full flex-1 flex-col bg-[#f7f8fb]",
        isPreviewFullscreen &&
          "fixed inset-0 z-[300] h-dvh max-h-none shadow-2xl",
        className,
      )}
      data-invert-ignore
    >
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-slate-200/75 bg-white/[0.88] px-2.5 shadow-[inset_0_-1px_0_rgba(255,255,255,0.8)] backdrop-blur-xl">
        <button
          type="button"
          onClick={goBack}
          className="hidden rounded-lg p-1.5 text-slate-500 transition-all hover:bg-slate-100/80 hover:text-slate-800 hover:shadow-sm lg:inline-flex"
          aria-label="Back"
        >
          <ChevronLeft className="h-4.5 w-4.5" strokeWidth={2.2} />
        </button>
        <button
          type="button"
          onClick={goForward}
          className="hidden rounded-lg p-1.5 text-slate-500 transition-all hover:bg-slate-100/80 hover:text-slate-800 hover:shadow-sm lg:inline-flex"
          aria-label="Forward"
        >
          <ChevronRight className="h-4.5 w-4.5" strokeWidth={2.2} />
        </button>
        <button
          type="button"
          onClick={reload}
          className="hidden rounded-lg p-1.5 text-slate-500 transition-all hover:bg-slate-100/80 hover:text-slate-800 hover:shadow-sm lg:inline-flex"
          aria-label="Reload"
        >
          <RotateCw className="h-4.5 w-4.5" strokeWidth={2} />
        </button>

        <form
          onSubmit={handleAddressSubmit}
          className="mx-1 hidden min-w-0 flex-1 items-center lg:flex"
        >
          <input
            type="text"
            value={addressInput}
            onChange={(e) => setAddressInput(e.target.value)}
            placeholder="http://localhost:5174/sessions/..."
            className="h-8 min-w-0 flex-1 rounded-full border border-slate-200/90 bg-white/95 px-4 text-center font-mono text-[12px] text-slate-700 shadow-[inset_0_1px_0_rgba(255,255,255,0.8),0_8px_20px_rgba(15,23,42,0.045)] outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-300/60"
            spellCheck={false}
            autoComplete="off"
            aria-label="Preview URL"
          />
          <button type="submit" className="sr-only">
            Go to preview URL
          </button>
        </form>

        <button
          type="button"
          onClick={() => setFocusMode((enabled) => !enabled)}
          className={cn(
            "hidden rounded-lg p-1.5 transition-all lg:inline-flex",
            focusMode
              ? "bg-blue-50 text-blue-600 ring-1 ring-blue-200"
              : "text-slate-500 hover:bg-slate-100/80 hover:text-slate-800 hover:shadow-sm",
          )}
          aria-label="Inspect preview elements"
          title="Inspect preview elements"
        >
          <Crosshair className="h-4.5 w-4.5" strokeWidth={2} />
        </button>
        <button
          type="button"
          onClick={testPreview}
          disabled={isTesting}
          className="hidden rounded-lg p-1.5 text-slate-500 transition-all hover:bg-slate-100/80 hover:text-slate-800 hover:shadow-sm disabled:cursor-not-allowed disabled:opacity-50 lg:inline-flex"
          aria-label="Test preview"
          title="Run Headful Mode preview test"
        >
          <Sparkles className="h-4.5 w-4.5" strokeWidth={2} />
        </button>
        <button
          type="button"
          onClick={() => setIsPreviewFullscreen((full) => !full)}
          className="hidden rounded-lg p-1.5 text-slate-500 transition-all hover:bg-slate-100/80 hover:text-slate-800 hover:shadow-sm lg:inline-flex"
          aria-label={
            isPreviewFullscreen
              ? "Exit full screen preview"
              : "Full screen preview"
          }
          title={
            isPreviewFullscreen ? "Exit full screen" : "Full screen preview"
          }
        >
          {isPreviewFullscreen ? (
            <Minimize2 className="h-4.5 w-4.5" strokeWidth={2} />
          ) : (
            <Maximize2 className="h-4.5 w-4.5" strokeWidth={2} />
          )}
        </button>

        <div
          className="ml-1 flex shrink-0 rounded-full border border-slate-200/90 bg-white/95 p-[2px] shadow-[0_8px_20px_rgba(15,23,42,0.055)] lg:ml-auto"
          role="tablist"
          aria-label="Workspace"
        >
          <button
            type="button"
            role="tab"
            aria-selected={workspaceMode === "preview"}
            onClick={() => setWorkspaceMode("preview")}
            className={cn(
              "flex items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-semibold text-slate-500 transition-all duration-200",
              workspaceMode === "preview"
                ? "bg-slate-900 text-white shadow-sm"
                : "hover:text-slate-700",
            )}
          >
            <LayoutTemplate
              className="h-3 w-3 shrink-0 opacity-90"
              strokeWidth={2}
            />
            {sessionStatus === "syncing" ? "Syncing" : "Preview"}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={workspaceMode === "code"}
            onClick={() => setWorkspaceMode("code")}
            className={cn(
              "flex items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-semibold text-slate-500 transition-all duration-200",
              workspaceMode === "code"
                ? "bg-slate-900 text-white shadow-sm"
                : "hover:text-slate-700",
            )}
          >
            <Code2 className="h-3 w-3 shrink-0 opacity-90" strokeWidth={2} />
            Code
          </button>
        </div>
      </header>

      <div className="flex min-h-0 min-w-0 flex-1 flex-row overflow-hidden">
        {workspaceMode === "code" ? (
          <aside className="flex w-[220px] shrink-0 flex-col border-r border-slate-200/75 bg-[#f4f6f9] transition-[width,opacity] duration-300 ease-out">
            <div className="flex items-center justify-between gap-1 border-b border-slate-200/60 px-2 py-1.5">
              <span className="truncate text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                {projectLabel}
              </span>
              <div className="flex shrink-0 items-center gap-0.5">
                <button
                  type="button"
                  title="New file"
                  onClick={handleNewFile}
                  className="rounded-md p-1 text-slate-500 transition-colors hover:bg-white hover:text-slate-800"
                >
                  <FilePlus className="h-3.5 w-3.5" strokeWidth={1.85} />
                </button>
                <button
                  type="button"
                  title="New folder"
                  onClick={handleNewFolder}
                  className="rounded-md p-1 text-slate-500 transition-colors hover:bg-white hover:text-slate-800"
                >
                  <FolderPlus className="h-3.5 w-3.5" strokeWidth={1.85} />
                </button>
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden py-1 scrollbar-none">
              <TreeRows
                nodes={tree.children}
                depth={0}
                expanded={expanded}
                toggle={toggleDir}
                activePath={activePath}
                onPick={(p) => setActivePath(p)}
              />
            </div>
          </aside>
        ) : null}

        <div
          className={cn(
            "grid h-full min-h-0 min-w-0 flex-1 bg-white",
            "grid-rows-[minmax(0,1fr)]",
          )}
        >
          {workspaceMode === "code" ? (
            <div className="flex min-h-0 flex-col bg-[#fbfcfe]">
              <div className="flex h-10 shrink-0 items-center justify-between gap-3 border-b border-slate-200/75 bg-white px-3">
                <div className="flex min-w-0 items-center gap-2">
                  <FileGlyph path={activePath} />
                  <span className="truncate font-mono text-[12px] font-semibold text-slate-700">
                    {activePath || "untitled.tsx"}
                  </span>
                </div>
                <span className="shrink-0 rounded-full bg-slate-100 px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-slate-500">
                  Editable
                </span>
              </div>
              <div className="relative min-h-0 flex-1 overflow-hidden bg-[#0f172a]">
                <pre
                  className="pointer-events-none absolute inset-0 overflow-hidden px-0 py-3 font-mono text-[12px] leading-5"
                  aria-hidden="true"
                >
                  <code
                    className="block min-w-max"
                    style={{
                      transform: `translate(${-editorScroll.left}px, ${-editorScroll.top}px)`,
                    }}
                  >
                    {(editorValue || " ").split("\n").map((line, index) => (
                      <span key={index} className="flex min-h-5">
                        <span className="sticky left-0 mr-4 w-12 shrink-0 select-none border-r border-white/10 bg-[#0f172a] pr-3 text-right text-slate-500">
                          {index + 1}
                        </span>
                        <span className="whitespace-pre pr-6">
                          {highlightCodeLine(line)}
                        </span>
                      </span>
                    ))}
                  </code>
                </pre>
                <textarea
                  ref={codeTextareaRef}
                  key={activePath}
                  value={editorValue}
                  onChange={(event) => {
                    const next = event.target.value;
                    setMergedFiles((m) => {
                      if (!activePath) return m;
                      return { ...m, [activePath]: next };
                    });
                    updateCodeCompletion(event.currentTarget);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Tab" && codeCompletion) {
                      event.preventDefault();
                      acceptCodeCompletion();
                    }
                  }}
                  onKeyUp={(event) => {
                    if (event.key !== "Tab") updateCodeCompletion(event.currentTarget);
                  }}
                  onBlur={() => setCodeCompletion(null)}
                  onScroll={(event) => {
                    setEditorScroll({
                      top: event.currentTarget.scrollTop,
                      left: event.currentTarget.scrollLeft,
                    });
                    updateCodeCompletion(event.currentTarget);
                  }}
                  spellCheck={false}
                  className="relative z-10 h-full min-h-0 w-full resize-none overflow-auto bg-transparent py-3 pl-16 pr-6 font-mono text-[12px] leading-5 text-transparent caret-white outline-none scrollbar-none selection:bg-blue-400/30"
                  aria-label="Code editor"
                />
                <AnimatePresence>
                  {codeCompletion && (
                    <motion.div
                      className="clyra-code-autocomplete"
                      style={{ left: codeCompletion.x, top: codeCompletion.y }}
                      initial={{ opacity: 0, y: 8, scale: 0.96, filter: "blur(5px)" }}
                      animate={{ opacity: 1, y: 0, scale: 1, filter: "blur(0px)" }}
                      exit={{ opacity: 0, y: 6, scale: 0.96, filter: "blur(4px)" }}
                      transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
                    >
                      <span>{codeCompletion.suggestion}</span>
                      <kbd>Tab</kbd>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </div>
          ) : null}

          {workspaceMode === "preview" ? (
            <div className="relative flex min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden bg-white">
              {showPreviewSyncOverlay && (
                <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-white/80">
                  <div className="flex items-center gap-2 text-slate-400 text-sm font-medium">
                    <div className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-slate-600" />
                    Loading preview
                  </div>
                </div>
              )}
              <div className="absolute left-3 top-3 z-40 flex max-w-[calc(100%-1.5rem)] items-center gap-2 rounded-full border border-slate-200/75 bg-white/[0.96] px-2 py-1 text-[11px] font-medium text-slate-600 shadow-[0_12px_30px_rgba(15,23,42,0.10)] backdrop-blur-xl">
                <span
                  className={cn(
                    "h-1.5 w-1.5 shrink-0 rounded-full",
                    healthTone === "ready" && "bg-emerald-500",
                    healthTone === "busy" && "animate-pulse bg-blue-500",
                    healthTone === "warn" && "bg-amber-500",
                    healthTone === "error" && "bg-red-500",
                    healthTone === "idle" && "bg-slate-300",
                  )}
                  aria-hidden
                />
                <span className="truncate">{healthText}</span>
                {previewNotice ? (
                  <span className="hidden max-w-[260px] truncate text-slate-400 sm:inline">
                    {previewNotice}
                  </span>
                ) : null}
                {(lastError ||
                  testResult?.success === false ||
                  testResult?.blank) &&
                onAutoFix ? (
                  <button
                    type="button"
                    onClick={requestAutoFix}
                    className="pointer-events-auto ml-1 inline-flex h-6 items-center gap-1 rounded-full bg-slate-900 px-2 text-[10.5px] font-semibold text-white transition-colors hover:bg-slate-800"
                  >
                    <Sparkles className="h-3 w-3 text-amber-300" />
                    Auto Fix
                  </button>
                ) : null}
              </div>
              {isElectronRuntime() && sessionUrl ? (
                <ElectronWebContentsSurface
                  key="vibe-preview-native"
                  source={sessionUrl}
                  title="Vibe live preview"
                  surfaceId="live-preview"
                  kind="preview"
                  className="relative z-20 block min-h-0 min-w-0 w-full flex-1"
                  fallback={
                    <iframe
                      title="Vibe live preview"
                      src={sessionUrl}
                      onLoad={() => setPreviewLoaded(true)}
                      className="h-full w-full border-0 bg-white"
                      sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
                      referrerPolicy="no-referrer"
                    />
                  }
                />
              ) : (
                <iframe
                  key="vibe-preview-stable"
                  title="Vibe live preview"
                  ref={iframeRef}
                  src={sessionUrl || undefined}
                  srcDoc={!sessionUrl && sessionStatus === "offline" ? previewSrcDoc : undefined}
                  onLoad={() => setPreviewLoaded(true)}
                  className="relative z-20 block min-h-0 min-w-0 w-full flex-1 border-0 bg-white"
                  sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
                  referrerPolicy="no-referrer"
                />
              )}

              {agentCursor.visible ? (
                <div
                  className="pointer-events-none absolute z-50 transition-[left,top,transform,opacity] duration-500 ease-out"
                  style={{
                    left: `${agentCursor.x}%`,
                    top: `${agentCursor.y}%`,
                    transform: `translate(-10px, -8px) scale(${agentCursor.clicking ? 0.92 : 1})`,
                  }}
                  aria-hidden
                >
                  <div className="relative">
                    <div
                      className="h-9 w-9 bg-black shadow-[0_10px_28px_rgba(15,23,42,0.28)]"
                      style={{
                        clipPath:
                          "polygon(11% 0%, 100% 45%, 61% 57%, 47% 100%, 28% 91%, 42% 52%, 0% 35%)",
                        transform: "rotate(-8deg)",
                        borderRadius: "8px",
                      }}
                    />
                    {agentCursor.clicking ? (
                      <span className="absolute left-4 top-4 h-7 w-7 animate-ping rounded-full border-2 border-black/50" />
                    ) : null}
                    <span className="absolute left-7 top-7 whitespace-nowrap rounded-full border border-slate-200 bg-white/95 px-2 py-1 text-[10.5px] font-semibold text-slate-700 shadow-lg">
                      {agentCursor.label}
                    </span>
                  </div>
                </div>
              ) : null}

              {lastError && workspaceMode === "preview" && (
                <div className="absolute bottom-4 left-4 right-4 z-50">
                  <div className="flex flex-col gap-3 rounded-xl border border-red-200 bg-white p-4 shadow-xl shadow-red-900/5 ring-1 ring-red-500/10">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-center gap-2.5 text-red-600">
                        <div className="flex h-6 w-6 items-center justify-center rounded-full bg-red-50">
                          <AlertCircle className="h-4 w-4" />
                        </div>
                        <span className="text-[13px] font-semibold tracking-tight">
                          Runtime Error Detected
                        </span>
                      </div>
                      <button
                        onClick={() => setLastError(null)}
                        className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>

                    <div className="rounded-lg bg-red-50/50 px-3 py-2">
                      <p className="font-mono text-[11px] leading-relaxed text-red-700/90 line-clamp-2">
                        {lastError.message}
                      </p>
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => {
                          if (onAutoFix && lastError) {
                            requestAutoFix();
                          }
                        }}
                        className="group relative flex h-9 flex-1 items-center justify-center gap-2 overflow-hidden rounded-lg bg-slate-900 px-4 text-[12.5px] font-semibold text-white transition-all hover:bg-slate-800 active:scale-[0.98]"
                      >
                        <Sparkles className="h-3.5 w-3.5 text-amber-400 transition-transform group-hover:rotate-12" />
                        Auto Fix with AI
                      </button>
                      <button
                        onClick={reload}
                        className="flex h-9 items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 text-[12.5px] font-medium text-slate-600 transition-all hover:bg-slate-50 hover:text-slate-900"
                      >
                        <RotateCw className="h-3.5 w-3.5" />
                        Retry
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
