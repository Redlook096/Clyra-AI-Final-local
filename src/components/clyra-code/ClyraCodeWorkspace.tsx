import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Globe2, Monitor, PanelLeftOpen, PanelRightClose, PanelRightOpen, Smartphone } from "lucide-react";
import { cn } from "../../lib/utils";
import { api } from "./api";
import { useClyraCode, type AgentAction } from "./store";
import { Sidebar, ClyraMark, type ChatThread } from "./Sidebar";
import { Conversation } from "./Conversation";
import { Composer, type ComposerAttachment, type ComposerCommand, type ComposerContext } from "./Composer";
import { RightPanel, usePreview, type RightTab } from "./RightPanel";
import { TerminalPanel } from "./TerminalPanel";
import { formatTokens } from "./format";

const WIDTH_KEY = "clyra-code:conversation-width";
const SIDEBAR_KEY = "clyra-code:sidebar-collapsed";
const MIN_CONVERSATION = 400;
const MIN_PREVIEW = 520;
const SIDEBAR_EXPANDED = 236;
const SIDEBAR_COLLAPSED = 0;

const WELCOME_SUBTITLES = [
  ["Turn an ", "idea", " into something real."],
  ["", "Build", " something worth shipping."],
  ["Start with an ", "idea", ". Clyra handles the details."],
  ["Describe it. We'll ", "build", " from there."],
  ["Create something worth ", "shipping", "."],
  ["From first idea to working ", "product", "."],
  ["Build it, improve it, make it ", "yours", "."],
  ["Bring your next ", "idea", " to life."],
  ["Start anywhere. Clyra will help ", "shape", " it."],
  ["Make something ", "great", ", one change at a time."],
] as const;

function encodeAttachment(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Could not read attachment."));
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      resolve(result.includes(",") ? result.slice(result.indexOf(",") + 1) : result);
    };
    reader.readAsDataURL(file);
  });
}

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
    selectThread,
    newChat,
    loadProjects,
    startRun,
    cancelRun,
    replyPermission,
    recordVisualEdit,
  } = useClyraCode();

  useEffect(() => {
    // Keep Chat/Vibe/Clip rail out of the coding surface; hover-dot reveals it.
    window.dispatchEvent(new CustomEvent("clyra:workflow-tabs-hide"));
  }, []);

  // Views consume harness diffs when present, or summaries synthesized from
  // real tool payloads when the diff endpoint is empty.
  const state = useMemo(
    () => ({ ...rawState, diffs: effectiveDiffs }),
    [rawState, effectiveDiffs],
  );

  const [rightTab, setRightTab] = useState<RightTab>("browser");
  const [focusFile, setFocusFile] = useState<string | null>(null);
  const [contexts, setContexts] = useState<ComposerContext[]>([]);
  const [creating, setCreating] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [rightPanelOpen, setRightPanelOpen] = useState(false);
  const [terminalHeight, setTerminalHeight] = useState(200);
  const [agentActivityCount, setAgentActivityCount] = useState(0);
  const [suggestion, setSuggestion] = useState<{ text: string; nonce: number } | undefined>(
    undefined,
  );
  const [welcomeSubtitle] = useState(() => WELCOME_SUBTITLES[Math.floor(Math.random() * WELCOME_SUBTITLES.length)]);
  const [threadsByProject, setThreadsByProject] = useState<Record<string, ChatThread[]>>({});
  const [hiddenProjectIds, setHiddenProjectIds] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem("clyra-code:hidden-projects") || "[]"); } catch { return []; }
  });
  const autoFixedPreviewError = useRef<string | null>(null);

  const suggestPrompt = useCallback((text: string) => {
    setSuggestion((current) => ({ text, nonce: (current?.nonce ?? 0) + 1 }));
  }, []);

  const refreshThreads = useCallback(async () => {
    const rows = await Promise.all(state.projects.map(async (project) => {
      const threads = await api.listSessions(project.id).catch(() => [] as ChatThread[]);
      return [project.id, threads] as const;
    }));
    setThreadsByProject(Object.fromEntries(rows));
  }, [state.projects]);

  useEffect(() => { void refreshThreads(); }, [refreshThreads, state.sessionId, state.runState]);

  const hideProject = useCallback((projectId: string) => {
    setHiddenProjectIds((previous) => {
      const next = previous.includes(projectId) ? previous : [...previous, projectId];
      try { localStorage.setItem("clyra-code:hidden-projects", JSON.stringify(next)); } catch { /* storage unavailable */ }
      return next;
    });
    if (state.activeProjectId === projectId) selectProject(null);
  }, [selectProject, state.activeProjectId]);

  // Successful runs bump buildVersion so the browser preview reloads and the
  // iOS preview reinstalls + relaunches the freshly built app.
  const [buildVersion, setBuildVersion] = useState(0);
  const [relaunchSignal, setRelaunchSignal] = useState(0);
  const previousRunState = useRef(state.runState);
  useEffect(() => {
    if (previousRunState.current !== "complete" && state.runState === "complete") {
      setBuildVersion((v) => v + 1);
      if (state.platform === "ios") {
        setRelaunchSignal((v) => v + 1);
      }
    }
    previousRunState.current = state.runState;
  }, [state.runState, state.platform]);

  useEffect(() => {
    setAgentActivityCount(Object.values(state.actions).filter((action) => /^(command|build|check|test|preview)$/.test(action.kind)).length);
  }, [state.actions]);

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
  // Only establish the initial split once. The sidebar itself now owns its
  // interpolated width, so recalculating the conversation width on every
  // sidebar toggle would make the chat jump before the pane finishes moving.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
  // New projects open straight into the welcome chat — no name prompt. The
  // project takes its name from the first request once the agent responds.
  const createProject = useCallback(async () => {
    if (creating) return;
    setCreating(true);
    try {
      const project = await api.createProject("New project");
      await loadProjects();
      selectProject(project.id);
      return project;
    } catch {
      /* surfaced by empty state */
    } finally {
      setCreating(false);
    }
  }, [creating, loadProjects, selectProject]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "n") {
        event.preventDefault();
        void createProject();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [createProject]);

  /* -------------------- helpers -------------------- */
  const activeProject = state.projects.find((p) => p.id === state.activeProjectId) ?? null;
  const taskTitle = state.sessionTitle || (state.log.length ? "Task" : "");
  const hasConversation = state.log.length > 0;

  // A blank project gives the welcome workspace all available width. Selecting
  // an existing thread or sending the first prompt activates the preview.
  useEffect(() => {
    setRightPanelOpen(Boolean(state.activeProjectId && hasConversation));
  }, [hasConversation, state.activeProjectId, state.sessionId]);

  const openFileDiff = useCallback((path: string) => {
    setFocusFile(path);
    setRightTab("changes");
  }, []);

  const retryAction = useCallback(
    (action: AgentAction) => {
      void startRun(
        /^(command|build|check|test|preview)$/.test(action.kind)
          ? `The command \`${action.target}\` failed. Investigate the error and fix it:\n${action.error ?? ""}\n${(action.output ?? "").slice(-2000)}`
          : `The ${action.kind} action on ${action.target} failed. Investigate and fix it.`,
      );
    },
    [startRun],
  );

  const submitPrompt = useCallback(
    async (text: string, attachments: ComposerAttachment[] = [], command?: ComposerCommand) => {
      window.dispatchEvent(new CustomEvent("clyra:workflow-tabs-hide"));
      let projectId = state.activeProjectId;
      if (!projectId) {
        const project = await createProject();
        projectId = project?.id ?? null;
      }
      setRightPanelOpen(true);
      if (!projectId) return false;
      try {
        const uploaded = attachments.length
          ? await api.uploadAttachments(projectId, await Promise.all(attachments.map(async (attachment) => ({
              name: attachment.file.name,
              relativePath: (attachment.file as File & { webkitRelativePath?: string }).webkitRelativePath || undefined,
              type: attachment.file.type || "application/octet-stream",
              data: await encodeAttachment(attachment.file),
            }))))
          : { attachments: [] };
        const attachmentContext = uploaded.attachments.length
          ? `Attached project files (inspect these before editing):\n${uploaded.attachments.map((attachment) => `- ${attachment.path} (${attachment.type})`).join("\n")}\n\n`
          : "";
        const commandInstruction: Record<ComposerCommand, string> = {
          browser: "[Clyra Browser mode] Use the existing live preview and real browser/preview tools to observe, act, verify, repair source when needed, rebuild and retest. Do not claim browser interactions that did not occur.\n\n",
          plan: "[Clyra Plan mode] Inspect the repository, create a detailed PLAN.md at project root with findings, files, implementation steps, risks and validation. Do not edit implementation files in this turn; stop after presenting the plan for user approval.\n\n",
          test: "[Clyra Test mode] Determine the appropriate real checks for this project. Run relevant tests, typecheck/build and live-preview checks where available; diagnose and fix genuine failures, then rerun validation.\n\n",
          debug: "[Clyra Debug mode] Reproduce the reported issue, inspect real logs and relevant code, make the smallest correct repair, then rerun the reproduction and validation.\n\n",
          explain: "[Clyra Explain mode] Inspect the actual repository and explain the requested architecture or code. Do not edit files unless the user separately asks for a change.\n\n",
        };
        return startRun((command ? commandInstruction[command] : "") + attachmentContext + text, command === "plan" ? "plan" : undefined);
      } catch {
        return false;
      }
    },
    [createProject, startRun, state.activeProjectId],
  );

  // A preview failure that appears after an otherwise finished run is a real
  // validation signal. Feed it back into the same agent session once, rather
  // than leaving the user to copy opaque console output by hand.
  const handlePreviewError = useCallback((message: string) => {
    const normalized = message.trim();
    if (!normalized || running || state.runState !== "complete" || autoFixedPreviewError.current === normalized) return;
    autoFixedPreviewError.current = normalized;
    void startRun(`The live preview failed after the task completed. Diagnose and fix the real project error, then validate the preview again:\n${normalized}`);
  }, [running, startRun, state.runState]);

  useEffect(() => {
    autoFixedPreviewError.current = null;
    // Inspect and terminal references belong to one chat thread only.
    setContexts([]);
  }, [state.activeProjectId, state.sessionId]);

  const addTerminalErrorContext = useCallback(() => {
    if (!state.error) return;
    const detail = state.error.trim();
    setContexts((previous) => previous.some((entry) => entry.detail === detail)
      ? previous
      : [...previous, { id: `terminal-error-${Date.now()}`, label: "Terminal error", detail }]);
  }, [state.error]);

  const tokensLabel = formatTokens(state.tokens);
  const visibleProjects = state.projects.filter((project) => !hiddenProjectIds.includes(project.id));

  const handleNewChat = useCallback(async (projectId: string) => {
    try {
      await newChat(projectId);
      await refreshThreads();
      setRightTab("browser");
      setFocusFile(null);
    } catch {
      // The composer keeps the user in the current chat if OpenCode is unavailable.
    }
  }, [newChat, refreshThreads]);

  const handleDeleteChat = useCallback(async (projectId: string, sessionId: string) => {
    if (!window.confirm("Delete this chat? Project files will not be changed.")) return;
    try {
      await api.deleteSession(projectId, sessionId);
      const remaining = (await api.listSessions(projectId)).filter((thread) => thread.id !== sessionId);
      setThreadsByProject((prev) => ({ ...prev, [projectId]: remaining }));
      if (state.activeProjectId === projectId && state.sessionId === sessionId) {
        if (remaining[0]) await selectThread(projectId, remaining[0].id);
        else selectProject(projectId);
      }
    } catch { /* leave the existing thread visible if deletion fails */ }
  }, [selectProject, selectThread, state.activeProjectId, state.sessionId]);

  /* -------------------- render -------------------- */
  return (
    <div ref={shellRef} className="clyra-code-root flex h-full w-full flex-col overflow-hidden">
      <div className="relative flex min-h-0 w-full flex-1 overflow-hidden">
      <Sidebar
        projects={visibleProjects}
        threadsByProject={threadsByProject}
        activeProjectId={state.activeProjectId}
        activeSessionId={state.sessionId}
        collapsed={sidebarCollapsed}
        onToggleCollapsed={toggleSidebarCollapsed}
        onSelectProject={(id) => {
          selectProject(id);
          setContexts([]);
          setRightTab("browser");
          setFocusFile(null);
        }}
        onSelectChat={(projectId, sessionId) => {
          void selectThread(projectId, sessionId);
          setContexts([]);
          setRightTab("browser");
          setFocusFile(null);
        }}
        onNewProject={() => void createProject()}
        onNewChat={(projectId) => void handleNewChat(projectId)}
        onRenameProject={(projectId, name) => {
          void api.renameProject(projectId, name).then(() => loadProjects());
        }}
        onRenameChat={(projectId, sessionId, title) => {
          void api.renameSession(projectId, sessionId, title).then(() => refreshThreads());
        }}
        onDeleteChat={(projectId, sessionId) => void handleDeleteChat(projectId, sessionId)}
        onRemoveProject={hideProject}
      />
      {!sidebarCollapsed ? <div className="cc-resize-handle" aria-hidden /> : null}
      {sidebarCollapsed ? <button type="button" aria-label="Expand sidebar" title="Expand sidebar" onClick={toggleSidebarCollapsed} className="absolute left-2 top-1.5 z-30 flex h-[31px] w-[31px] items-center justify-center rounded-[9px] text-[#5F6368] transition-colors duration-150 hover:bg-black/[0.045]"><PanelLeftOpen className="h-[16px] w-[16px]" strokeWidth={1.6} /></button> : null}

      <button
        type="button"
        aria-label={rightPanelOpen ? "Close preview" : "Open preview"}
        title={rightPanelOpen ? "Close preview" : "Open preview"}
        onClick={() => setRightPanelOpen((open) => !open)}
        className="absolute right-2 top-1.5 z-40 flex h-[37px] w-[37px] items-center justify-center rounded-[10px] text-[#5F6368] transition-colors duration-150 hover:bg-black/[0.045]"
      >
        {rightPanelOpen ? <PanelRightClose className="h-[18px] w-[18px]" strokeWidth={1.65} /> : <PanelRightOpen className="h-[18px] w-[18px]" strokeWidth={1.65} />}
      </button>

      {/* -------- centre: agent conversation -------- */}
      <section
        className={cn("flex min-h-0 flex-col bg-[color:var(--main-background)] transition-[width] duration-[300ms] ease-[cubic-bezier(0.22,1,0.36,1)]", rightPanelOpen ? "shrink-0" : "min-w-0 flex-1")}
        style={rightPanelOpen ? { width: conversationWidth } : undefined}
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

        <header className="relative flex h-[44px] shrink-0 items-center gap-2 border-b border-black/[0.055] bg-white/[0.92] px-3.5 backdrop-blur-[16px]">
          {activeProject ? (
            <>
              <div className="min-w-0 flex-1">
                <h1 className="truncate text-[12.5px] font-medium tracking-[-0.01em] text-[#343539]">
                  {taskTitle || "New task"}
                </h1>
              </div>
            </>
          ) : (
            <h1 className="text-[12.5px] font-medium text-[#343539]">Clyra Code</h1>
          )}
        </header>

        {
          <AnimatePresence mode="wait" initial={false}>
            {!hasConversation ? (
              <motion.div
                key="welcome"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0, y: -5, transition: { duration: 0.26, ease: [0.22, 1, 0.36, 1] } }}
                transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
                className="flex min-h-0 flex-1 flex-col justify-center overflow-y-auto pb-[9vh]"
              >
                <div className="mx-auto flex w-full max-w-[620px] flex-col items-center px-5 text-center">
                  <ClyraMark size={29} />
                  <h2 className="mt-4 text-[25px] font-medium leading-[1.18] tracking-[-0.03em] text-[#202124]">
                    What do you want to build?
                  </h2>
                  <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }} className="mt-2 text-[14px] leading-[1.5] text-[#818388]">
                    {welcomeSubtitle[0]}<span className="text-[#3977F6]">{welcomeSubtitle[1]}</span>{welcomeSubtitle[2]}
                  </motion.p>
                  {activeProject ? (
                    <p className="mt-1.5 text-[11.5px] text-[#9A9CA0]">
                      Working in {activeProject.name || activeProject.id}
                    </p>
                  ) : null}
                  <div className="mt-[26px] w-full">
                    <Composer
                      running={false}
                      model={state.model}
                      contexts={contexts}
                      onRemoveContext={(id) => setContexts((prev) => prev.filter((c) => c.id !== id))}
                      onSubmit={submitPrompt}
                      onStop={cancelRun}
                      placeholder="Ask Clyra to build, fix, or change something…"
                      welcome
                      suggestion={suggestion}
                    />
                  </div>
                  <div className="mt-4 flex items-center justify-center gap-1.5">
                    {([
                      { label: "Website", prompt: "Build me a modern website", icon: Globe2 },
                      { label: "Desktop app", prompt: "Build me a desktop app", icon: Monitor },
                      { label: "iOS app", prompt: "Build me a native iOS app with SwiftUI", icon: Smartphone },
                    ] as const).map((entry) => {
                      const Icon = entry.icon;
                      return (
                        <button
                          key={entry.label}
                          type="button"
                          onClick={() => suggestPrompt(entry.prompt)}
                          className="flex h-[36px] items-center gap-1.5 rounded-[9px] px-3 text-[12.5px] text-[#696B70] transition-colors duration-150 hover:bg-black/[0.035] hover:text-[#303236]"
                        >
                          <Icon className="h-[14px] w-[14px] text-[#7D8086]" strokeWidth={1.65} />
                          {entry.label}
                        </button>
                      );
                    })}
                  </div>
                  <p className="mt-[15px] text-[11px] tracking-[-0.005em] text-[#9A9CA0]">
                    {activeProject?.name || "New project"} <span aria-hidden>·</span> Web, desktop and iOS supported
                  </p>
                </div>
              </motion.div>
            ) : (
              <motion.div
                key="conversation"
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.26, ease: [0.22, 1, 0.36, 1] }}
                className="flex min-h-0 flex-1 flex-col"
              >
                <Conversation
                  state={state}
                  running={running}
                  onCancel={() => void cancelRun()}
                  onReplyPermission={(id, response) => void replyPermission(id, response)}
                  onRetry={retryAction}
                  onOpenTerminal={() => setTerminalOpen(true)}
                  onOpenFile={openFileDiff}
                  onOpenChanges={() => setRightTab("changes")}
                />
                {state.runState === "failed" && state.error ? (
                  <div className="mx-auto mb-1 flex w-full max-w-[760px] items-center gap-2 px-5 text-[11.5px] text-[#76787D]">
                    <span className="min-w-0 flex-1 truncate">The last run needs attention.</span>
                    <button
                      type="button"
                      onClick={addTerminalErrorContext}
                      className="shrink-0 rounded-[6px] px-1.5 py-1 font-medium text-[#3977F6] transition-colors hover:bg-[#3977F6]/[0.06]"
                    >
                      Add error to chat
                    </button>
                  </div>
                ) : null}
                <footer className="flex h-[17px] shrink-0 items-center gap-3 px-4 text-[9.5px] text-[#A0A2A6]">
                  <span>Local</span>
                  <span className="cc-mono truncate">{activeProject.id}</span>
                  {tokensLabel ? <span className="cc-counter ml-auto">{tokensLabel}</span> : null}
                </footer>
                <Composer
                  running={running}
                  model={state.model}
                  contexts={contexts}
                  onRemoveContext={(id) => setContexts((prev) => prev.filter((c) => c.id !== id))}
                  onSubmit={submitPrompt}
                  onStop={() => void cancelRun()}
                  suggestion={suggestion}
                />
              </motion.div>
            )}
          </AnimatePresence>
        }
      </section>

      <AnimatePresence initial={false}>
        {rightPanelOpen ? <motion.div layout key="preview-panel" initial={{ width: 0, x: 8, opacity: 0 }} animate={{ width: "auto", x: 0, opacity: 1 }} exit={{ width: 0, x: 8, opacity: 0 }} transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }} className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
          <div className="cc-resize-handle" data-active={dragging || undefined} onPointerDown={onDragStart} role="separator" aria-orientation="vertical" />
          <RightPanel
            state={state}
            actionList={actionList}
            tab={rightTab}
            onTabChange={(tab) => { setRightTab(tab); if (tab !== "changes") setFocusFile(null); }}
            preview={preview}
            onAddContext={(context) => setContexts((prev) => (prev.some((item) => item.detail === context.detail) ? prev : [...prev, context]))}
            focusFile={focusFile}
            agentRunning={running}
            onOpenTerminal={() => setTerminalOpen(true)}
            platform={state.platform}
            relaunchSignal={relaunchSignal}
            onVisualEdit={(instruction) => void startRun(instruction)}
            onVisualSourceEdit={recordVisualEdit}
            onPreviewError={handlePreviewError}
          />
        </motion.div> : null}
      </AnimatePresence>
      </div>

      <TerminalPanel
        projectId={state.activeProjectId}
        open={terminalOpen}
        height={terminalHeight}
        onHeightChange={setTerminalHeight}
        onToggle={() => setTerminalOpen((open) => !open)}
        agentActivityCount={agentActivityCount}
      />
    </div>
  );
}
