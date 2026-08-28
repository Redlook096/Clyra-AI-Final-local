import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { FolderOpen, Globe2, Monitor, PanelLeftOpen, PanelRightClose, PanelRightOpen, Play, Server } from "lucide-react";
import { cn } from "../../lib/utils";
import { api } from "./api";
import { shouldAskPlatform, useClyraCode, type AgentAction } from "./store";
import { Sidebar, ClyraMark, type ChatThread } from "./Sidebar";
import { Conversation } from "./Conversation";
import { Composer, type ComposerAttachment, type ComposerCommand, type ComposerContext } from "./Composer";
import { summarizeAnswers, type QuestionAnswers, type QuestionSet } from "./QuestionComposer";
import { RightPanel, usePreview, type RightTab } from "./RightPanel";
import { TerminalPanel } from "./TerminalPanel";
import { GitHubPopover } from "./GitHubPopover";
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

const quickStartTiles: Array<{ label: string; prompt: string; icon: typeof Globe2 }> = [
  { label: "Website", prompt: "Build me a modern website", icon: Globe2 },
  { label: "Desktop app", prompt: "Build me a desktop app", icon: Monitor },
  { label: "API / Backend", prompt: "Build me a backend API service", icon: Server },
];

function formatRecentTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const minutes = Math.max(0, Math.floor((Date.now() - then) / 60_000));
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

const PLATFORM_QUESTIONS: QuestionSet = {
  questions: [
    {
      id: "platform",
      question: "Which platform should I target?",
      type: "single",
      options: ["Webapp/Website", "Desktop app"],
    },
  ],
};

const DEMO_QUESTIONS: QuestionSet = {
  questions: [
    { id: "layout", question: "Which layout should I use?", type: "single", options: ["Current layout", "New layout"] },
    { id: "animations", question: "Should I preserve existing animations?", type: "single", options: ["Yes", "No", "Only the good ones"] },
    { id: "scope", question: "How much should I change?", type: "single", options: ["Minimal", "Balanced", "Full rebuild"] },
    { id: "direction", question: "Any visual direction?", type: "single", options: ["Keep it clean", "More colorful", "Dark mode"], allowCustom: true },
  ],
};

function platformDirective(answer: string): string {
  if (/desktop/i.test(answer)) return "Build this as a desktop app (Electron), shipped as a responsive web app first so the live preview works.\n\n";
  return "Build this as a website / web app.\n\n";
}

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
    plan,
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
  const [projectNameSheetOpen, setProjectNameSheetOpen] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [rightPanelOpen, setRightPanelOpen] = useState(false);
  const [previewContentVisible, setPreviewContentVisible] = useState(false);
  const [previewFullscreen, setPreviewFullscreen] = useState(false);
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
  const [questionSet, setQuestionSet] = useState<QuestionSet | null>(null);
  const questionSetRef = useRef<QuestionSet | null>(null);
  const [questionSubmitting, setQuestionSubmitting] = useState(false);
  const pendingPromptRef = useRef<string>("");

  const suggestPrompt = useCallback((text: string) => {
    setSuggestion((current) => ({ text, nonce: (current?.nonce ?? 0) + 1 }));
  }, []);

  /* -------------------- open existing project -------------------- */
  const [importingProject, setImportingProject] = useState(false);
  const [importPathDraft, setImportPathDraft] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

  const importProjectFromPath = useCallback(async (rawPath: string) => {
    const trimmed = rawPath.trim();
    if (!trimmed || importingProject) return;
    setImportingProject(true);
    setImportError(null);
    try {
      const project = await api.importProject(trimmed);
      await loadProjects();
      selectProject(project.id);
      setImportPathDraft(null);
    } catch (error) {
      setImportError(error instanceof Error ? error.message : "Could not import that project.");
    } finally {
      setImportingProject(false);
    }
  }, [importingProject, loadProjects, selectProject]);

  const requestOpenExistingProject = useCallback(async () => {
    if (importingProject) return;
    setImportError(null);
    const pick = window.clyraDesktop?.selectFolder;
    if (pick) {
      const result = await pick().catch(() => null);
      if (!result || result.canceled || !result.path) return;
      await importProjectFromPath(result.path);
      return;
    }
    setImportPathDraft("");
  }, [importProjectFromPath, importingProject]);

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

  // Successful runs bump buildVersion so the browser preview reloads.
  const [buildVersion, setBuildVersion] = useState(0);
  const previousRunState = useRef(state.runState);
  useEffect(() => {
    if (previousRunState.current !== "complete" && state.runState === "complete") {
      setBuildVersion((v) => v + 1);
    }
    previousRunState.current = state.runState;
  }, [state.runState]);

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
  const [shellWidth, setShellWidth] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [conversationWidth, setConversationWidth] = useState(() => {
    const raw = Number(localStorage.getItem(WIDTH_KEY));
    if (Number.isFinite(raw) && raw >= MIN_CONVERSATION) return raw;
    // ~47% of the chat+preview pair on a typical desktop (sidebar aside).
    return 560;
  });

  // Animate real pane widths rather than using a flex-grow interpolation.
  // Flex-grow makes children briefly scale/stretch while the free space is
  // redistributed; measured widths let both panes reflow like the left rail.
  useLayoutEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    const update = () => setShellWidth(shell.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(shell);
    return () => observer.disconnect();
  }, []);

  const availableWorkspaceWidth = Math.max(0, shellWidth - sidebarWidth - 2);
  const openConversationWidth = Math.min(
    Math.max(MIN_CONVERSATION, conversationWidth),
    Math.max(MIN_CONVERSATION, availableWorkspaceWidth - MIN_PREVIEW),
  );
  const conversationTargetWidth = rightPanelOpen ? openConversationWidth : availableWorkspaceWidth;
  const previewTargetWidth = rightPanelOpen ? Math.max(0, availableWorkspaceWidth - openConversationWidth) : 0;

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
  const createProject = useCallback(async (name = "New project") => {
    if (creating) return;
    setCreating(true);
    try {
      const project = await api.createProject(name.trim() || "New project");
      await loadProjects();
      selectProject(project.id);
      return project;
    } catch {
      /* surfaced by empty state */
    } finally {
      setCreating(false);
    }
  }, [creating, loadProjects, selectProject]);

  const requestNewProject = useCallback(() => {
    if (creating) return;
    setNewProjectName("");
    setProjectNameSheetOpen(true);
  }, [creating]);

  const confirmNewProject = useCallback(async () => {
    const name = newProjectName.trim();
    if (!name) return;
    const project = await createProject(name);
    if (project) setProjectNameSheetOpen(false);
  }, [createProject, newProjectName]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "n") {
        event.preventDefault();
        requestNewProject();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [requestNewProject]);

  /* -------------------- helpers -------------------- */
  const activeProject = state.projects.find((p) => p.id === state.activeProjectId) ?? null;
  const taskTitle = state.sessionTitle || (state.log.length ? "Task" : "");
  const desktopProject = /\b(?:desktop|electron)\b/i.test(`${activeProject?.name ?? ""} ${taskTitle}`);
  const canLaunchElectronPreview = Boolean(window.clyraDesktop?.preview?.launch);
  const launchDesktopPreview = useCallback(async () => {
    const url = preview.session?.url;
    if (!url) return;
    await window.clyraDesktop?.preview?.launch({ url, title: activeProject?.name || "Clyra desktop project" });
  }, [activeProject?.name, preview.session?.url]);
  const hasConversation = state.log.length > 0;
  const recentProjects = useMemo(
    () => state.projects.filter((project) => project.id !== activeProject?.id).slice(0, 4),
    [state.projects, activeProject?.id],
  );

  // Keep preview content out of the width animation.  The pane itself glides
  // in first; the browser surface then fades up at its final width, so it is
  // never visibly stretched while the sidebar opens.
  useEffect(() => {
    if (!rightPanelOpen) {
      setPreviewContentVisible(false);
      return;
    }
    const timer = window.setTimeout(() => setPreviewContentVisible(true), 255);
    return () => window.clearTimeout(timer);
  }, [rightPanelOpen]);

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
    async (
      text: string,
      attachments: ComposerAttachment[] = [],
      command?: ComposerCommand,
      options?: { userText?: string; answers?: Array<{ question: string; answer: string }> },
    ) => {
      window.dispatchEvent(new CustomEvent("clyra:workflow-tabs-hide"));
      const trimmed = text.trim();
      if (trimmed === "/ask") {
        pendingPromptRef.current = "";
        questionSetRef.current = DEMO_QUESTIONS;
        setQuestionSet(DEMO_QUESTIONS);
        return true;
      }
      // A fresh request that clearly asks to build a new app/website/product
      // with no platform signal turns into a question instead of guessing.
      // Follow-ups inside an existing session and ordinary requests always
      // send immediately so the composer never feels like it swallowed a turn.
      if (!command && shouldAskPlatform(trimmed) && !state.sessionId) {
        pendingPromptRef.current = trimmed;
        questionSetRef.current = PLATFORM_QUESTIONS;
        setQuestionSet(PLATFORM_QUESTIONS);
        return false;
      }
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
        // Fire the run without awaiting the full network round trip: startRun
        // appends the optimistic user message synchronously before its first
        // await, so the composer can clear immediately instead of freezing
        // the input until the agent's runtime/session/prompt calls resolve.
        void startRun((command ? commandInstruction[command] : "") + attachmentContext + text, command === "plan" ? "plan" : undefined, options);
        return true;
      } catch {
        return false;
      }
    },
    [createProject, startRun, state.activeProjectId, state.sessionId],
  );

  const handleQuestionSubmit = useCallback(
    (answers: QuestionAnswers) => {
      const answer = answers.platform?.values?.[0] ?? answers.layout?.values?.[0] ?? "";
      const pending = pendingPromptRef.current;
      pendingPromptRef.current = "";
      const usedSet = questionSetRef.current;
      const summary = summarizeAnswers(usedSet, answers);
      setQuestionSubmitting(true);
      window.setTimeout(() => {
        setQuestionSubmitting(false);
        setQuestionSet(null);
        if (pending) {
          void submitPrompt(platformDirective(answer) + pending, [], undefined, {
            userText: pending,
            answers: summary,
          });
        }
      }, 240);
    },
    [submitPrompt],
  );

  const handleQuestionBack = useCallback(() => {
    pendingPromptRef.current = "";
    setQuestionSubmitting(false);
    setQuestionSet(null);
  }, []);

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
        onNewProject={requestNewProject}
        onNewChat={(projectId) => void handleNewChat(projectId)}
        onRenameProject={(projectId, name) => {
          void api.renameProject(projectId, name).then(() => loadProjects());
        }}
        onRenameChat={(projectId, sessionId, title) => {
          void api.renameSession(projectId, sessionId, title).then(() => refreshThreads());
        }}
        onDeleteChat={(projectId, sessionId) => void handleDeleteChat(projectId, sessionId)}
        onRemoveProject={hideProject}
        onOpenProjectFolder={(projectId) => {
          void api.openProjectFolder(projectId).catch((error) => {
            console.error("Could not open the project folder:", error);
          });
        }}
      />
      {!sidebarCollapsed ? <div className="cc-resize-handle" aria-hidden /> : null}

      <div className="absolute right-1 top-1.5 z-40 flex h-[37px] items-center gap-0.5">
        {activeProject ? <GitHubPopover projectId={activeProject.id} projectName={activeProject.name} /> : null}
        {desktopProject && preview.session?.url && canLaunchElectronPreview ? (
          <button
            type="button"
            onClick={() => void launchDesktopPreview()}
            className="flex h-[30px] items-center gap-1.5 rounded-[8px] px-2.5 text-[11.5px] font-medium text-[#3977F6] transition-colors duration-150 hover:bg-[#3977F6]/[0.07]"
            title="Launch this desktop project in Electron"
          >
            <Play className="h-[12px] w-[12px]" fill="currentColor" strokeWidth={1.8} />
            Launch app
          </button>
        ) : null}
        <button
          type="button"
          aria-label={rightPanelOpen ? "Close preview" : "Open preview"}
          title={rightPanelOpen ? "Close preview" : "Open preview"}
          onClick={() => setRightPanelOpen((open) => !open)}
          className="flex h-[37px] w-[37px] items-center justify-center rounded-[10px] text-[#5F6368] transition-colors duration-150 hover:bg-black/[0.045]"
        >
          {rightPanelOpen ? <PanelRightClose className="h-[18px] w-[18px]" strokeWidth={1.65} /> : <PanelRightOpen className="h-[18px] w-[18px]" strokeWidth={1.65} />}
        </button>
      </div>

      {/* -------- centre: agent conversation -------- */}
      <motion.section
        initial={false}
        animate={{ width: conversationTargetWidth }}
        transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
        className="flex min-h-0 shrink-0 flex-col overflow-hidden bg-[color:var(--main-background)]"
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
          {sidebarCollapsed ? (
            <button
              type="button"
              aria-label="Expand sidebar"
              title="Expand sidebar"
              onClick={toggleSidebarCollapsed}
              className="flex h-[31px] w-[31px] shrink-0 items-center justify-center rounded-[9px] text-[#5F6368] transition-colors duration-150 hover:bg-black/[0.045]"
            >
              <PanelLeftOpen className="h-[16px] w-[16px]" strokeWidth={1.6} />
            </button>
          ) : null}
          {activeProject ? (
            <>
              <div className="min-w-0 flex-1">
                <h1 className="truncate text-[12.5px] font-medium tracking-[-0.01em] text-[#343539]">
                  {taskTitle || "New task"}
                </h1>
              </div>
            </>
          ) : <span className="flex-1" aria-hidden />}
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
                className="flex min-h-0 flex-1 flex-col justify-center overflow-y-auto pt-[9vh]"
              >
                <div className="mx-auto flex w-full max-w-[620px] flex-col items-center px-5 text-center">
                  <ClyraMark size={40} />
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
                      question={questionSet}
                      questionSubmitting={questionSubmitting}
                      onQuestionSubmit={handleQuestionSubmit}
                      onQuestionBack={handleQuestionBack}
                    />
                  </div>
                  <div className="mt-4 flex items-center justify-center gap-1.5">
                    {quickStartTiles.map((entry) => {
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
                  <button
                    type="button"
                    onClick={() => void requestOpenExistingProject()}
                    className="mt-2.5 inline-flex h-[28px] items-center gap-1.5 self-center rounded-full border border-black/[0.06] px-3 text-[11.5px] text-[#A4A6AA] transition-colors duration-150 hover:border-black/[0.11] hover:text-[#5F6368]"
                  >
                    <FolderOpen className="h-[12px] w-[12px]" strokeWidth={1.75} />
                    Open existing project
                  </button>
                  {importPathDraft !== null ? (
                    <div className="mt-3 flex w-full items-center gap-1.5">
                      <input
                        autoFocus
                        value={importPathDraft}
                        onChange={(event) => setImportPathDraft(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") { event.preventDefault(); void importProjectFromPath(importPathDraft); }
                          else if (event.key === "Escape") { event.preventDefault(); setImportPathDraft(null); setImportError(null); }
                        }}
                        placeholder="/path/to/your/project"
                        className="h-[34px] flex-1 rounded-[9px] border border-black/[0.08] bg-white px-3 text-[12.5px] text-[#343539] outline-none placeholder:text-[#B7B9BD] focus:border-[#3977F6]/40"
                      />
                      <button
                        type="button"
                        disabled={importingProject || !importPathDraft.trim()}
                        onClick={() => void importProjectFromPath(importPathDraft)}
                        className="h-[34px] shrink-0 rounded-[9px] bg-[#3977F6] px-3 text-[12.5px] font-medium text-white transition-opacity disabled:opacity-40"
                      >
                        {importingProject ? "Opening…" : "Open"}
                      </button>
                      <button
                        type="button"
                        onClick={() => { setImportPathDraft(null); setImportError(null); }}
                        className="h-[34px] shrink-0 rounded-[9px] px-2.5 text-[12.5px] text-[#9A9CA0] transition-colors hover:text-[#696B70]"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : null}
                  {importError ? (
                    <p className="mt-2 text-[11.5px] text-[#D64545]">{importError}</p>
                  ) : null}
                  <p className="mt-[15px] text-[11px] tracking-[-0.005em] text-[#9A9CA0]">
                    {activeProject?.name || "New project"} <span aria-hidden>·</span> Web and desktop supported
                  </p>
                  {recentProjects.length ? (
                    <div className="mt-7 w-full text-left">
                      <p className="mb-1.5 px-2.5 text-[10.5px] font-medium uppercase tracking-[0.06em] text-[#C1C3C7]">
                        Recent
                      </p>
                      <div className="flex flex-col">
                        {recentProjects.map((project) => (
                          <button
                            key={project.id}
                            type="button"
                            onClick={() => selectProject(project.id)}
                            className="flex items-center justify-between gap-3 rounded-[9px] px-2.5 py-[7px] text-left transition-colors duration-150 hover:bg-black/[0.03]"
                          >
                            <span className="min-w-0 truncate text-[12.5px] text-[#4B4D51]">{project.name || project.id}</span>
                            <span className="shrink-0 text-[11px] text-[#B7B9BD]">{formatRecentTime(project.updatedAt)}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : null}
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
                  question={questionSet}
                  questionSubmitting={questionSubmitting}
                  onQuestionSubmit={handleQuestionSubmit}
                  onQuestionBack={handleQuestionBack}
                />
              </motion.div>
            )}
          </AnimatePresence>
        }
      </motion.section>

      <motion.div
        initial={false}
        animate={rightPanelOpen
          ? { width: previewTargetWidth, x: 0, opacity: 1 }
          : { width: 0, x: 8, opacity: 0 }}
        transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
        className={cn("flex min-h-0 shrink-0 overflow-hidden", !rightPanelOpen && "pointer-events-none")}
        aria-hidden={!rightPanelOpen || undefined}
      >
          <div className="cc-resize-handle" data-active={dragging || undefined} onPointerDown={onDragStart} role="separator" aria-orientation="vertical" />
          <motion.div
            className="flex min-h-0 min-w-0 flex-1"
            initial={false}
            animate={{ opacity: previewContentVisible ? 1 : 0, x: previewContentVisible ? 0 : 8 }}
            transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
          >
            <RightPanel
              state={state}
              actionList={actionList}
              plan={plan}
              tab={rightTab}
              onTabChange={(tab) => { setRightTab(tab); if (tab !== "changes") setFocusFile(null); }}
              preview={preview}
              onAddContext={(context) => setContexts((prev) => (prev.some((item) => item.detail === context.detail) ? prev : [...prev, context]))}
              focusFile={focusFile}
              agentRunning={running}
              onOpenTerminal={() => setTerminalOpen(true)}
              onVisualEdit={(instruction) => void startRun(instruction)}
              onVisualSourceEdit={recordVisualEdit}
              onPreviewError={handlePreviewError}
              fullscreen={previewFullscreen}
              onToggleFullscreen={() => setPreviewFullscreen((value) => !value)}
            />
          </motion.div>
      </motion.div>
      </div>

      <TerminalPanel
        projectId={state.activeProjectId}
        open={terminalOpen}
        height={terminalHeight}
        onHeightChange={setTerminalHeight}
        onToggle={() => setTerminalOpen((open) => !open)}
        agentActivityCount={agentActivityCount}
      />
      <AnimatePresence>
        {projectNameSheetOpen ? (
          <motion.div
            className="fixed inset-0 z-[110] flex items-center justify-center bg-black/[0.10] p-5 backdrop-blur-[1px]"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            onMouseDown={() => setProjectNameSheetOpen(false)}
          >
            <motion.form
              initial={{ opacity: 0, y: 10, scale: 0.985 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 8, scale: 0.985 }} transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
              onMouseDown={(event) => event.stopPropagation()}
              onSubmit={(event) => { event.preventDefault(); void confirmNewProject(); }}
              className="w-full max-w-[360px] rounded-[13px] border border-black/[0.09] bg-white p-4 shadow-[0_22px_60px_rgba(15,23,42,0.16)]"
            >
              <p className="text-[13px] font-medium text-[#2D2F34]">New project</p>
              <p className="mt-1 text-[11.5px] leading-[1.5] text-[#777A80]">Give this workspace a clear name. Chats, files, preview, and source control will stay together here.</p>
              <input autoFocus value={newProjectName} onChange={(event) => setNewProjectName(event.target.value)} placeholder="Project name" className="mt-3 h-9 w-full rounded-[8px] border border-black/[0.09] px-2.5 text-[12px] text-[#35373C] outline-none transition-colors placeholder:text-[#A0A2A6] focus:border-black/[0.22]" />
              <div className="mt-3 flex justify-end gap-1.5">
                <button type="button" onClick={() => setProjectNameSheetOpen(false)} className="h-8 rounded-[8px] px-2.5 text-[11.5px] text-[#65676C] transition-colors hover:bg-black/[0.04]">Cancel</button>
                <button type="submit" disabled={!newProjectName.trim() || creating} className="flex h-8 items-center gap-1.5 rounded-[8px] bg-[#292A2E] px-3 text-[11.5px] font-medium text-white transition-colors hover:bg-[#17181B] disabled:cursor-not-allowed disabled:opacity-40">{creating ? <span className="h-3 w-3 animate-spin rounded-full border border-white/35 border-t-white" /> : null} Create project</button>
              </div>
            </motion.form>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
