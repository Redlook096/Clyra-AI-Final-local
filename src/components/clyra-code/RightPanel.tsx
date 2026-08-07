import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  FileText,
  Globe,
  MessageSquarePlus,
  Plus,
  RotateCw,
  Search,
} from "lucide-react";
import { cn } from "../../lib/utils";
import { MarkdownMessageContent } from "../MarkdownMessageContent";
import { ShiningText } from "../ShiningText";
import { api, type FileDiff, type PreviewLogLine, type PreviewSession } from "./api";
import type { AgentAction, ClyraCodeState } from "./store";
import { DiffCounters } from "./AnimatedCounter";
import { computeLineDiff, linesFromPatch } from "./diff";
import { stripFilePrefix } from "./format";
import type { ComposerContext } from "./Composer";

export type RightTab = "summary" | "browser" | "terminal" | "changes" | "files";

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
/* ------------------------------------------------------------------ */

function BrowserView({
  session,
  frameVersion,
  onReload,
  onRestart,
  onOpenTerminal,
  onAddContext,
  agentRunning = false,
}: {
  session: PreviewSession | null;
  frameVersion: number;
  onReload: () => void;
  onRestart: () => void;
  onOpenTerminal: () => void;
  onAddContext: (context: ComposerContext) => void;
  agentRunning?: boolean;
}) {
  const [commenting, setCommenting] = useState(false);
  const [pin, setPin] = useState<{ x: number; y: number } | null>(null);
  const [comment, setComment] = useState("");
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
    if (!url) return;
    setHistory((prev) => {
      if (prev[prev.length - 1] === url) return prev;
      const next = [...prev, url];
      setHistoryIndex(next.length - 1);
      return next;
    });
  }, [url]);

  const submitComment = () => {
    if (!pin || !comment.trim()) return;
    onAddContext({
      id: `comment-${Date.now()}`,
      label: `Preview note @ ${Math.round(pin.x)}%, ${Math.round(pin.y)}%`,
      detail: `User comment pinned at ${Math.round(pin.x)}% x ${Math.round(pin.y)}% of the live preview (${url}): ${comment.trim()}`,
    });
    setPin(null);
    setComment("");
    setCommenting(false);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-[46px] items-center gap-1 border-b border-[color:var(--border-subtle)] px-2.5">
        <button
          type="button"
          aria-label="Back"
          disabled={historyIndex <= 0}
          onClick={() => setHistoryIndex((i) => Math.max(0, i - 1))}
          className="rounded-[7px] p-1.5 text-[color:var(--text-secondary)] transition-colors hover:bg-[color:var(--surface-hover)] disabled:text-[color:var(--text-disabled)]"
        >
          <ArrowLeft className="h-[15px] w-[15px]" strokeWidth={1.8} />
        </button>
        <button
          type="button"
          aria-label="Forward"
          disabled={historyIndex >= history.length - 1}
          onClick={() => setHistoryIndex((i) => Math.min(history.length - 1, i + 1))}
          className="rounded-[7px] p-1.5 text-[color:var(--text-secondary)] transition-colors hover:bg-[color:var(--surface-hover)] disabled:text-[color:var(--text-disabled)]"
        >
          <ArrowRight className="h-[15px] w-[15px]" strokeWidth={1.8} />
        </button>
        <button
          type="button"
          aria-label="Reload"
          onClick={onReload}
          className="rounded-[7px] p-1.5 text-[color:var(--text-secondary)] transition-colors hover:bg-[color:var(--surface-hover)]"
        >
          <RotateCw className="h-[14px] w-[14px]" strokeWidth={1.8} />
        </button>
        <div className="flex min-w-0 flex-1 justify-center">
          {host ? (
            <span className="cc-mono truncate text-[12px] text-[color:var(--text-secondary)]">
              {host}
            </span>
          ) : starting ? (
            <ShiningText text="Starting development server…" play className="text-[12px]" />
          ) : (
            <span className="text-[12px] text-[color:var(--text-tertiary)]">No preview yet</span>
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
          onClick={() => {
            setCommenting((v) => !v);
            setPin(null);
            setComment("");
          }}
          className={cn(
            "ml-1 flex h-7 items-center gap-1.5 rounded-[8px] px-2.5 text-[11.5px] font-medium transition-colors",
            commenting
              ? "bg-[color:var(--surface-selected)] text-[color:var(--text-primary)]"
              : "text-[color:var(--text-secondary)] hover:bg-[color:var(--surface-hover)]",
          )}
        >
          <MessageSquarePlus className="h-3.5 w-3.5" strokeWidth={1.9} />
          Commenting
        </button>
      </div>

      <div ref={surfaceRef} className="relative min-h-0 flex-1 bg-white">
        {ready ? (
          <iframe
            key={frameVersion}
            src={url}
            title="Live preview"
            className="h-full w-full border-0 bg-white"
            sandbox="allow-forms allow-modals allow-popups allow-same-origin allow-scripts"
          />
        ) : starting || agentRunning ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 bg-[#FAFAF9]">
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
          </div>
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
        ) : (
          <div className="relative flex h-full flex-col items-center justify-center overflow-hidden bg-[#F7F7F6]">
            <div className="relative z-[1] flex max-w-[300px] flex-col items-center px-5 text-center">
              <div className="mb-2.5 grid h-8 w-8 place-items-center rounded-[8px] border border-[#EEEEEC] bg-white text-[13px] font-medium text-[#171717]">
                C
              </div>
              <h3 className="text-[14px] font-medium tracking-[-0.02em] text-[#171717]">
                Build something to preview
              </h3>
              <p className="mt-1.5 text-[12px] leading-[1.45] text-[#8A8A8A]">
                Describe what to create in the chat. The live preview opens here once files are ready.
              </p>
            </div>
          </div>
        )}

        {commenting && ready ? (
          <div
            className="absolute inset-0 cursor-crosshair"
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              setPin({
                x: ((event.clientX - rect.left) / rect.width) * 100,
                y: ((event.clientY - rect.top) / rect.height) * 100,
              });
            }}
          >
            {pin ? (
              <div
                className="absolute z-10 w-[240px] -translate-x-1/2 rounded-[10px] border border-[color:var(--border-medium)] bg-white p-2 shadow-[0_10px_28px_rgba(15,23,42,0.14)]"
                style={{ left: `${pin.x}%`, top: `calc(${pin.y}% + 10px)` }}
                onClick={(event) => event.stopPropagation()}
              >
                <textarea
                  autoFocus
                  value={comment}
                  onChange={(event) => setComment(event.target.value)}
                  placeholder="Describe what should change here"
                  rows={2}
                  className="w-full resize-none rounded-[7px] bg-[color:var(--surface-muted)] px-2 py-1.5 text-[12px] outline-none"
                />
                <div className="mt-1.5 flex justify-end gap-1.5">
                  <button
                    type="button"
                    onClick={() => setPin(null)}
                    className="rounded-[6px] px-2 py-[3px] text-[11px] text-[color:var(--text-secondary)] hover:bg-[color:var(--surface-hover)]"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={submitComment}
                    className="rounded-[6px] bg-[color:var(--accent-blue)] px-2 py-[3px] text-[11px] font-medium text-white"
                  >
                    Add to prompt
                  </button>
                </div>
              </div>
            ) : null}
            {pin ? (
              <span
                className="absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-[color:var(--accent-blue)] shadow"
                style={{ left: `${pin.x}%`, top: `${pin.y}%` }}
              />
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Summary view                                                        */
/* ------------------------------------------------------------------ */

function SummaryView({ state, actions }: { state: ClyraCodeState; actions: AgentAction[] }) {
  const lastAssistant = [...state.log].reverse().find((e) => e.type === "assistant");
  const commands = actions.filter((a) => a.kind === "command");
  return (
    <div className="cc-scroll min-h-0 flex-1 overflow-y-auto px-5 py-4">
      <div className="mx-auto max-w-[640px]">
        {state.sessionTitle ? (
          <h3 className="text-[14px] font-semibold text-[color:var(--text-primary)]">
            {state.sessionTitle}
          </h3>
        ) : null}
        {lastAssistant && lastAssistant.type === "assistant" ? (
          <div className="mt-2 text-[13px] leading-[1.6] text-[color:var(--text-primary)]">
            <MarkdownMessageContent content={lastAssistant.text} />
          </div>
        ) : (
          <p className="mt-2 text-[12.5px] text-[color:var(--text-tertiary)]">
            The task summary appears here once the agent reports back.
          </p>
        )}

        {state.diffs.length ? (
          <>
            <h4 className="mt-5 text-[12px] font-semibold uppercase tracking-[0.04em] text-[color:var(--text-tertiary)]">
              Changed files
            </h4>
            <div className="mt-1.5">
              {state.diffs.map((diff) => (
                <div
                  key={diff.file}
                  className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 py-[3px]"
                >
                  <span className="cc-mono truncate text-[11.5px] text-[color:var(--text-secondary)]">
                    {stripFilePrefix(diff.file)}
                  </span>
                  <DiffCounters additions={diff.additions} deletions={diff.deletions} />
                </div>
              ))}
            </div>
          </>
        ) : null}

        {commands.length ? (
          <>
            <h4 className="mt-5 text-[12px] font-semibold uppercase tracking-[0.04em] text-[color:var(--text-tertiary)]">
              Commands
            </h4>
            <div className="mt-1.5">
              {commands.map((command) => (
                <div key={command.id} className="flex items-center gap-2 py-[3px]">
                  <span className="cc-mono min-w-0 flex-1 truncate text-[11.5px] text-[color:var(--text-secondary)]">
                    {command.target}
                  </span>
                  <span
                    className={cn(
                      "cc-mono text-[11px]",
                      command.status === "error"
                        ? "text-[color:var(--deletion-red)]"
                        : "text-[color:var(--addition-green)]",
                    )}
                  >
                    {command.status === "error" ? "exit 1" : command.status === "success" ? "exit 0" : "running"}
                  </span>
                </div>
              ))}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Terminal view                                                       */
/* ------------------------------------------------------------------ */

function TerminalView({
  commands,
  devLogs,
}: {
  commands: AgentAction[];
  devLogs: PreviewLogLine[];
}) {
  const [source, setSource] = useState<"agent" | "server">("agent");
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const node = scrollRef.current;
    if (node && node.scrollHeight - node.scrollTop - node.clientHeight < 120) {
      node.scrollTop = node.scrollHeight;
    }
  }, [commands, devLogs, source]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-[38px] items-center gap-1 border-b border-[color:var(--border-subtle)] px-3">
        {(["agent", "server"] as const).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setSource(option)}
            className={cn(
              "rounded-[7px] px-2.5 py-[4px] text-[11.5px] font-medium transition-colors",
              source === option
                ? "bg-[color:var(--surface-selected)] text-[color:var(--text-primary)]"
                : "text-[color:var(--text-tertiary)] hover:bg-[color:var(--surface-hover)]",
            )}
          >
            {option === "agent" ? "Agent commands" : "Dev server"}
          </button>
        ))}
      </div>
      <div ref={scrollRef} className="cc-scroll min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {source === "agent" ? (
          commands.length ? (
            commands.map((command) => (
              <div key={command.id} className="mb-3">
                <div className="flex items-center gap-2">
                  <span className="cc-mono text-[11.5px] text-[color:var(--text-tertiary)]">$</span>
                  <span className="cc-mono text-[12px] font-medium text-[color:var(--text-primary)]">
                    {command.target}
                  </span>
                  <span
                    className={cn(
                      "cc-mono ml-auto text-[10.5px]",
                      command.status === "error"
                        ? "text-[color:var(--deletion-red)]"
                        : command.status === "active"
                          ? "text-[color:var(--accent-blue)]"
                          : "text-[color:var(--text-tertiary)]",
                    )}
                  >
                    {command.status === "active"
                      ? "running"
                      : command.status === "error"
                        ? "exit 1"
                        : "exit 0"}
                  </span>
                </div>
                {command.output?.trim() ? (
                  <pre className="cc-mono mt-1 whitespace-pre-wrap text-[11.5px] leading-[1.55] text-[color:var(--text-secondary)]">
                    {command.output}
                  </pre>
                ) : null}
              </div>
            ))
          ) : (
            <p className="text-[12px] text-[color:var(--text-tertiary)]">
              Commands the agent runs appear here.
            </p>
          )
        ) : devLogs.length ? (
          devLogs.map((line, index) => (
            <pre
              key={line.id ?? index}
              className={cn(
                "cc-mono whitespace-pre-wrap text-[11.5px] leading-[1.55]",
                line.stream === "stderr"
                  ? "text-[color:var(--deletion-red)]"
                  : "text-[color:var(--text-secondary)]",
              )}
            >
              {line.line ?? line.text ?? ""}
            </pre>
          ))
        ) : (
          <p className="text-[12px] text-[color:var(--text-tertiary)]">
            Development server output appears here.
          </p>
        )}
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
    // Synthesized entry without full content: fall back to the edit tool's
    // real patch text for this file when available.
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
                      line.kind === "add" && "bg-[#e9f7ef]",
                      line.kind === "del" && "bg-[#fdeeee]",
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

function FilesView({ projectId, diffs }: { projectId: string | null; diffs: FileDiff[] }) {
  const [files, setFiles] = useState<Array<{ path: string; content: string }>>([]);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    if (!projectId) return;
    void api
      .getProject(projectId)
      .then((data) => setFiles(data.files ?? []))
      .catch(() => setFiles([]));
  }, [projectId, diffs.length]);

  const changed = useMemo(() => new Set(diffs.map((d) => stripFilePrefix(d.file))), [diffs]);
  const filtered = files.filter((file) =>
    file.path.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const selectedFile = files.find((file) => file.path === selected) ?? null;

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex w-[240px] shrink-0 flex-col border-r border-[color:var(--border-subtle)]">
        <div className="flex items-center gap-1.5 border-b border-[color:var(--border-subtle)] px-3 py-2">
          <Search className="h-[13px] w-[13px] text-[color:var(--text-tertiary)]" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search files"
            className="w-full bg-transparent text-[12px] outline-none placeholder:text-[color:var(--text-tertiary)]"
          />
        </div>
        <div className="cc-scroll min-h-0 flex-1 overflow-y-auto py-1">
          {filtered.length ? (
            filtered.map((file) => (
              <button
                key={file.path}
                type="button"
                onClick={() => setSelected(file.path)}
                title={file.path}
                className={cn(
                  "flex w-full items-center gap-1.5 px-3 py-[4px] text-left transition-colors",
                  selected === file.path
                    ? "bg-[color:var(--surface-selected)]"
                    : "hover:bg-[color:var(--surface-hover)]",
                )}
              >
                <FileText className="h-[12px] w-[12px] shrink-0 text-[color:var(--text-disabled)]" />
                <span className="cc-mono truncate text-[11px] text-[color:var(--text-secondary)]">
                  {file.path}
                </span>
                {changed.has(file.path) ? (
                  <span className="ml-auto h-[5px] w-[5px] shrink-0 rounded-full bg-[color:var(--accent-blue)]" />
                ) : null}
              </button>
            ))
          ) : (
            <p className="px-3 py-2 text-[11.5px] text-[color:var(--text-tertiary)]">
              {files.length ? "No matches." : "No files yet."}
            </p>
          )}
        </div>
      </div>
      <div className="cc-scroll min-h-0 flex-1 overflow-auto">
        {selectedFile ? (
          <>
            <div className="cc-mono sticky top-0 border-b border-[color:var(--border-subtle)] bg-white/95 px-4 py-2 text-[11px] text-[color:var(--text-tertiary)] backdrop-blur">
              {selectedFile.path.split("/").join(" / ")}
            </div>
            <pre className="cc-mono whitespace-pre-wrap px-4 py-3 text-[11.5px] leading-[1.6] text-[color:var(--text-secondary)]">
              {selectedFile.content}
            </pre>
          </>
        ) : (
          <div className="flex h-full items-center justify-center">
            <p className="text-[12px] text-[color:var(--text-tertiary)]">Select a file to preview.</p>
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Panel shell with tabs                                               */
/* ------------------------------------------------------------------ */

const EXTRA_TABS: Array<{ id: RightTab; label: string }> = [
  { id: "terminal", label: "Terminal" },
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
}: {
  state: ClyraCodeState;
  actionList: AgentAction[];
  tab: RightTab;
  onTabChange: (tab: RightTab) => void;
  preview: ReturnType<typeof usePreview>;
  onAddContext: (context: ComposerContext) => void;
  focusFile: string | null;
  agentRunning?: boolean;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [openExtras, setOpenExtras] = useState<RightTab[]>([]);
  const commands = actionList.filter((a) => a.kind === "command");

  const tabs: Array<{ id: RightTab; label: string; icon?: typeof Globe }> = [
    { id: "summary", label: "Summary" },
    { id: "browser", label: "Browser", icon: Globe },
    ...EXTRA_TABS.filter((extra) => openExtras.includes(extra.id)),
  ];

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-[color:var(--preview-background)]">
      <div className="relative flex h-[50px] items-center gap-1 border-b border-[color:var(--border-subtle)] px-2.5">
        {tabs.map((entry) => {
          const Icon = entry.icon;
          const selected = tab === entry.id;
          return (
            <button
              key={entry.id}
              type="button"
              onClick={() => onTabChange(entry.id)}
              className={cn(
                "relative flex items-center gap-1.5 rounded-[8px] px-2.5 py-[6px] text-[12.5px] transition-colors duration-100",
                selected
                  ? "font-medium text-[#222222]"
                  : "text-[color:var(--text-secondary)] hover:bg-[color:var(--surface-hover)]",
              )}
            >
              {selected ? (
                <motion.span
                  layoutId="cc-tab-pill"
                  className="absolute inset-0 rounded-[8px] bg-[#ececec]"
                  transition={{ type: "spring", stiffness: 500, damping: 40 }}
                />
              ) : null}
              <span className="relative flex items-center gap-1.5">
                {Icon ? <Icon className="h-[13px] w-[13px]" strokeWidth={1.8} /> : null}
                {entry.label}
              </span>
            </button>
          );
        })}
        <div className="relative">
          <button
            type="button"
            aria-label="Open view"
            onClick={() => setMenuOpen((v) => !v)}
            className="rounded-[7px] p-1.5 text-[color:var(--text-tertiary)] transition-colors hover:bg-[color:var(--surface-hover)]"
          >
            <Plus className="h-[14px] w-[14px]" strokeWidth={1.9} />
          </button>
          {menuOpen ? (
            <div className="absolute left-0 top-[34px] z-20 w-[150px] rounded-[10px] border border-[color:var(--border-subtle)] bg-white py-1 shadow-[0_10px_30px_rgba(15,23,42,0.1)]">
              {EXTRA_TABS.map((extra) => (
                <button
                  key={extra.id}
                  type="button"
                  onClick={() => {
                    setOpenExtras((prev) =>
                      prev.includes(extra.id) ? prev : [...prev, extra.id],
                    );
                    onTabChange(extra.id);
                    setMenuOpen(false);
                  }}
                  className="flex w-full px-3 py-[6px] text-left text-[12.5px] text-[color:var(--text-primary)] transition-colors hover:bg-[color:var(--surface-hover)]"
                >
                  {extra.label}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </div>

      {tab === "browser" ? (
        <BrowserView
          session={preview.session}
          frameVersion={preview.frameVersion}
          onReload={preview.reload}
          onRestart={preview.restart}
          onOpenTerminal={() => {
            setOpenExtras((prev) => (prev.includes("terminal") ? prev : [...prev, "terminal"]));
            onTabChange("terminal");
          }}
          onAddContext={onAddContext}
          agentRunning={agentRunning}
        />
      ) : tab === "summary" ? (
        <SummaryView state={state} actions={actionList} />
      ) : tab === "terminal" ? (
        <TerminalView commands={commands} devLogs={preview.logs} />
      ) : tab === "changes" ? (
        <ChangesView diffs={state.diffs} actions={actionList} focusFile={focusFile} />
      ) : (
        <FilesView projectId={state.activeProjectId} diffs={state.diffs} />
      )}
    </section>
  );
}
