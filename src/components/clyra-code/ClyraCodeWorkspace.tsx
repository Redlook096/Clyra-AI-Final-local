import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { MoreHorizontal } from "lucide-react";
import { cn } from "../../lib/utils";
import { api } from "./api";
import { useClyraCode, type AgentAction } from "./store";
import { Sidebar } from "./Sidebar";
import { Conversation } from "./Conversation";
import { Composer, type ComposerContext } from "./Composer";
import { RightPanel, usePreview, type RightTab } from "./RightPanel";
import { formatTokens } from "./format";

const WIDTH_KEY = "clyra-code:conversation-width";
const SIDEBAR_KEY = "clyra-code:sidebar-collapsed";
const MIN_CONVERSATION = 420;
const MIN_PREVIEW = 520;
const SIDEBAR_EXPANDED = 240;
const SIDEBAR_COLLAPSED = 56;

/**
 * Clyra Code — the agent-first coding workspace. Three columns: project
 * sidebar, live agent work log, and the project preview. Every rendered
 * action mirrors a real OpenCode harness event.
 */
export default function ClyraCodeWorkspace() {
  const {
    state: rawState,
    actionList,
    running,
    effectiveDiffs,
    selectProject,
    loadProjects,
    startRun,
    cancelRun,
    replyPermission,
  } = useClyraCode();

  // Views consume harness diffs when present, or summaries synthesized from
  // real tool payloads when the diff endpoint is empty.
  const state = useMemo(
    () => ({ ...rawState, diffs: effectiveDiffs }),
    [rawState, effectiveDiffs],
  );

  const [rightTab, setRightTab] = useState<RightTab>("browser");
  const [focusFile, setFocusFile] = useState<string | null>(null);
  const [contexts, setContexts] = useState<ComposerContext[]>([]);
  const [showNewProject, setShowNewProject] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [creating, setCreating] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  // Successful runs bump buildVersion so the browser preview reloads.
  const [buildVersion, setBuildVersion] = useState(0);
  const previousRunState = useRef(state.runState);
  useEffect(() => {
    if (previousRunState.current !== "complete" && state.runState === "complete") {
      setBuildVersion((v) => v + 1);
    }
    previousRunState.current = state.runState;
  }, [state.runState]);

  const preview = usePreview(state.activeProjectId, buildVersion);

  /* -------------------- resizable centre column -------------------- */
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try {
      return localStorage.getItem(SIDEBAR_KEY) === "1";
    } catch {
      return false;
    }
  });
  const sidebarWidth = sidebarCollapsed ? SIDEBAR_COLLAPSED : SIDEBAR_EXPANDED;
  const shellRef = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const [conversationWidth, setConversationWidth] = useState(() => {
    const raw = Number(localStorage.getItem(WIDTH_KEY));
    if (Number.isFinite(raw) && raw >= MIN_CONVERSATION) return raw;
    // ~47% of the chat+preview pair on a typical desktop (sidebar aside).
    return 560;
  });

  // First layout (no saved width): pin conversation to ~47% of remaining space.
  useEffect(() => {
    if (localStorage.getItem(WIDTH_KEY)) return;
    const shell = shellRef.current;
    if (!shell) return;
    const available = shell.clientWidth - sidebarWidth - 2;
    const target = Math.round(available * 0.47);
    const max = available - MIN_PREVIEW;
    setConversationWidth(Math.min(max, Math.max(MIN_CONVERSATION, target)));
  }, [sidebarWidth]);

  const toggleSidebarCollapsed = useCallback(() => {
    setSidebarCollapsed((current) => {
      const next = !current;
      try {
        localStorage.setItem(SIDEBAR_KEY, next ? "1" : "0");
      } catch {
        // ignore
      }
      return next;
    });
  }, []);

  const onDragStart = useCallback(
    (event: React.PointerEvent) => {
      event.preventDefault();
      setDragging(true);
      const startX = event.clientX;
      const startWidth = conversationWidth;
      const move = (moveEvent: PointerEvent) => {
        const shell = shellRef.current;
        if (!shell) return;
        const max = shell.clientWidth - sidebarWidth - MIN_PREVIEW - 2;
        const next = Math.min(max, Math.max(MIN_CONVERSATION, startWidth + moveEvent.clientX - startX));
        setConversationWidth(next);
      };
      const up = () => {
        setDragging(false);
        setConversationWidth((width) => {
          localStorage.setItem(WIDTH_KEY, String(width));
          return width;
        });
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    },
    [conversationWidth, sidebarWidth],
  );

  /* -------------------- project creation -------------------- */
  const createProject = useCallback(async () => {
    const name = newProjectName.trim() || `Project ${new Date().toLocaleString()}`;
    if (creating) return;
    setCreating(true);
    try {
      const project = await api.createProject(name);
      await loadProjects();
      selectProject(project.id);
      setShowNewProject(false);
      setNewProjectName("");
    } catch {
      /* surfaced by empty state */
    } finally {
      setCreating(false);
    }
  }, [newProjectName, creating, loadProjects, selectProject]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "n") {
        event.preventDefault();
        setShowNewProject(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /* -------------------- helpers -------------------- */
  const activeProject = state.projects.find((p) => p.id === state.activeProjectId) ?? null;
  const taskTitle = state.sessionTitle || (state.log.length ? "Task" : "");
  const hasConversation = state.log.length > 0;

  const openFileDiff = useCallback((path: string) => {
    setFocusFile(path);
    setRightTab("changes");
  }, []);

  const retryAction = useCallback(
    (action: AgentAction) => {
      void startRun(
        action.kind === "command"
          ? `The command \`${action.target}\` failed. Investigate the error and fix it:\n${action.error ?? ""}\n${(action.output ?? "").slice(-2000)}`
          : `The ${action.kind} action on ${action.target} failed. Investigate and fix it.`,
      );
    },
    [startRun],
  );

  const submitPrompt = useCallback(
    (text: string) => {
      window.dispatchEvent(new CustomEvent("clyra:workflow-tabs-hide"));
      void startRun(text);
    },
    [startRun],
  );

  const tokensLabel = formatTokens(state.tokens);

  /* -------------------- render -------------------- */
  return (
    <div ref={shellRef} className="clyra-code-root flex h-full w-full overflow-hidden">
      <Sidebar
        projects={state.projects}
        activeProjectId={state.activeProjectId}
        collapsed={sidebarCollapsed}
        onToggleCollapsed={toggleSidebarCollapsed}
        onSelectProject={(id) => {
          selectProject(id);
          setRightTab("browser");
          setFocusFile(null);
        }}
        onNewProject={() => {
          setNewProjectName("");
          setShowNewProject(true);
          // One-click create when the modal opens empty is awkward; create
          // immediately with a default name so the empty state is never a dead end.
          window.setTimeout(() => {
            const input = document.querySelector<HTMLInputElement>('[data-testid="clyra-code-new-project-name"]');
            input?.focus();
          }, 0);
        }}
      />
      {!sidebarCollapsed ? <div className="cc-resize-handle" aria-hidden /> : null}

      {/* -------- centre: agent conversation -------- */}
      <section
        className="flex min-h-0 shrink-0 flex-col bg-[color:var(--main-background)]"
        style={{ width: conversationWidth }}
      >
        {state.connection === "reconnecting" && running ? (
          <motion.div
            initial={{ y: -28 }}
            animate={{ y: 0 }}
            className="border-b border-[color:var(--border-subtle)] bg-[#fff8ec] px-4 py-1.5 text-center text-[11.5px] text-[color:var(--warning-amber)]"
          >
            Connection interrupted. Reconnecting…
          </motion.div>
        ) : null}

        <header className="flex h-[52px] shrink-0 items-center gap-2 border-b border-[color:var(--border-subtle)] px-4">
          {activeProject ? (
            <>
              <h1 className="truncate text-[15px] font-semibold text-[color:var(--text-primary)]">
                {taskTitle || "New task"}
              </h1>
              <span className="truncate text-[12.5px] text-[color:var(--text-tertiary)]">
                {activeProject.name || activeProject.id}
              </span>
              <div className="relative ml-auto">
                <button
                  type="button"
                  aria-label="Task menu"
                  onClick={() => setMenuOpen((v) => !v)}
                  className="rounded-[7px] p-1.5 text-[color:var(--text-tertiary)] transition-colors hover:bg-[color:var(--surface-hover)]"
                >
                  <MoreHorizontal className="h-[15px] w-[15px]" />
                </button>
                {menuOpen ? (
                  <div
                    className="absolute right-0 top-[32px] z-30 w-[180px] rounded-[10px] border border-[color:var(--border-subtle)] bg-white py-1 shadow-[0_10px_30px_rgba(15,23,42,0.1)]"
                    onMouseLeave={() => setMenuOpen(false)}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        void navigator.clipboard
                          .writeText(
                            state.log
                              .map((entry) =>
                                entry.type === "user"
                                  ? `You: ${entry.text}`
                                  : entry.type === "assistant"
                                    ? `Clyra: ${entry.text}`
                                    : "",
                              )
                              .filter(Boolean)
                              .join("\n\n"),
                          )
                          .catch(() => undefined);
                        setMenuOpen(false);
                      }}
                      className="flex w-full px-3 py-[6px] text-left text-[12.5px] transition-colors hover:bg-[color:var(--surface-hover)]"
                    >
                      Export conversation
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        selectProject(state.activeProjectId);
                        setMenuOpen(false);
                      }}
                      className="flex w-full px-3 py-[6px] text-left text-[12.5px] transition-colors hover:bg-[color:var(--surface-hover)]"
                    >
                      New task
                    </button>
                  </div>
                ) : null}
              </div>
            </>
          ) : (
            <h1 className="text-[15px] font-semibold text-[color:var(--text-primary)]">Clyra Code</h1>
          )}
        </header>

        {!activeProject ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6">
            <p className="text-[15px] font-semibold text-[color:var(--text-primary)]">
              Create your first project
            </p>
            <p className="max-w-[300px] text-center text-[12.5px] leading-[1.55] text-[color:var(--text-tertiary)]">
              Projects hold everything the coding agent builds. Create one to get started.
            </p>
            <button
              type="button"
              onClick={() => setShowNewProject(true)}
              className="rounded-[9px] border border-[color:var(--border-medium)] bg-white px-3.5 py-[7px] text-[12.5px] font-medium transition-colors hover:bg-[color:var(--surface-hover)]"
            >
              New project
            </button>
          </div>
        ) : !hasConversation ? (
          <div className="flex flex-1 flex-col justify-center px-6 pb-16">
            <p className="mb-4 text-center text-[17px] font-semibold tracking-[-0.01em] text-[color:var(--text-primary)]">
              What should Clyra build?
            </p>
            <Composer
              running={false}
              model={state.model}
              contexts={contexts}
              onRemoveContext={(id) => setContexts((prev) => prev.filter((c) => c.id !== id))}
              onSubmit={submitPrompt}
              onStop={cancelRun}
              placeholder={`Describe what to build in ${activeProject.name || "this project"}`}
            />
          </div>
        ) : (
          <>
            <Conversation
              state={state}
              running={running}
              onCancel={() => void cancelRun()}
              onReplyPermission={(id, response) => void replyPermission(id, response)}
              onRetry={retryAction}
              onOpenTerminal={() => setRightTab("terminal")}
              onOpenFile={openFileDiff}
              onOpenChanges={() => setRightTab("changes")}
            />
            <Composer
              running={running}
              model={state.model}
              contexts={contexts}
              onRemoveContext={(id) => setContexts((prev) => prev.filter((c) => c.id !== id))}
              onSubmit={submitPrompt}
              onStop={() => void cancelRun()}
            />
            <footer className="flex h-[26px] shrink-0 items-center gap-4 px-5 pb-1 text-[11px] text-[color:var(--text-tertiary)]">
              <span>Local</span>
              <span className="cc-mono truncate">{activeProject.id}</span>
              {tokensLabel ? <span className="cc-counter ml-auto">{tokensLabel}</span> : null}
            </footer>
          </>
        )}
      </section>

      <div
        className="cc-resize-handle"
        data-active={dragging || undefined}
        onPointerDown={onDragStart}
        role="separator"
        aria-orientation="vertical"
      />

      <RightPanel
        state={state}
        actionList={actionList}
        tab={rightTab}
        onTabChange={(tab) => {
          setRightTab(tab);
          if (tab !== "changes") setFocusFile(null);
        }}
        preview={preview}
        onAddContext={(context) => setContexts((prev) => [...prev, context])}
        focusFile={focusFile}
      />

      {/* -------- new project modal -------- */}
      <AnimatePresence>
        {showNewProject ? (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 z-40 flex items-center justify-center bg-black/20"
            onClick={() => setShowNewProject(false)}
          >
            <motion.div
              initial={{ opacity: 0, y: 10, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 6, scale: 0.99 }}
              transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
              className="w-[360px] rounded-[14px] border border-[color:var(--border-subtle)] bg-white p-4 shadow-[0_24px_60px_rgba(15,23,42,0.18)]"
              onClick={(event) => event.stopPropagation()}
            >
              <h2 className="text-[14px] font-semibold text-[color:var(--text-primary)]">
                New project
              </h2>
              <input
                autoFocus
                data-testid="clyra-code-new-project-name"
                value={newProjectName}
                onChange={(event) => setNewProjectName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void createProject();
                  if (event.key === "Escape") setShowNewProject(false);
                }}
                placeholder="Project name"
                className="mt-3 w-full rounded-[9px] border border-[color:var(--border-medium)] px-3 py-[7px] text-[13px] outline-none focus:border-[color:var(--accent-blue)]"
              />
              <div className="mt-3 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowNewProject(false)}
                  className="rounded-[8px] px-3 py-[6px] text-[12.5px] text-[color:var(--text-secondary)] transition-colors hover:bg-[color:var(--surface-hover)]"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={creating}
                  onClick={() => void createProject()}
                  className={cn(
                    "rounded-[8px] px-3 py-[6px] text-[12.5px] font-medium text-white transition-colors",
                    !creating
                      ? "bg-[color:var(--accent-blue)]"
                      : "bg-[color:var(--text-disabled)]",
                  )}
                >
                  {creating ? "Creating…" : "Create"}
                </button>
              </div>
            </motion.div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
