import { useCallback, useEffect, useMemo, useState, useRef } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  AlertTriangle,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  Code2,
  FileCode2,
  Globe2,
  Loader2,
  Paperclip,
  Rocket,
  Search,
  Send,
  Square,
  TerminalSquare,
  GitBranch,
  Plus,
  Folder,
  ArrowUpRight,
} from "lucide-react";
import { cn } from "../lib/utils";
import { ShiningBrainIcon, ShiningText, ThinkingDots } from "./ShiningText";
import { MarkdownMessageContent } from "./MarkdownMessageContent";
import { LivePreviewPanel } from "./vibe-coder/preview/LivePreviewPanel";
import { useVibeCoderWorkspace } from "../hooks/useVibeCoderWorkspace";

// ── Cursor 3 Light Design Tokens ──
const S = {
  bg: "#f7f7f5",
  sidebar: "#f2f2f0",
  main: "#ffffff",
  panel: "#fbfbfa",
  raised: "#ffffff",
  hover: "#eeeeeb",
  selected: "#e9e9e6",
  active: "#e5e5e2",
  border: "#e7e7e4",
  borderDefault: "#ddddda",
  borderStrong: "#ccccca",
  text: "#20201e",
  textSecondary: "#686864",
  textMuted: "#92928d",
  textDisabled: "#b5b5b0",
  success: "#35854a",
  warning: "#9a6b20",
  danger: "#ba4141",
  diffAddBg: "rgba(45,145,76,0.10)",
  diffRemoveBg: "rgba(190,65,65,0.09)",
  diffAddText: "#28743c",
  diffRemoveText: "#a33c3c",
};
const EASE = [0.2, 0, 0, 1] as [number, number, number, number];

interface Props {}

const stageLabel = (stage: string) =>
  stage === "task-created" ? "Thinking" : stage === "generating-file" ? "Generating" : stage === "editing-file" ? "Editing" : stage === "running-command" ? "Running" : stage === "complete" ? "Done" : stage.replace(/-/g, " ");

type RuntimeSnapshot = { state: string; stateReason?: string; validation: Array<{ name: string; status: string }> };
type RuntimeEvent = { id: string; type: string; timestamp: string; status: string; payload: Record<string, unknown>; error?: { message: string } };
type AgentStage = "idle" | "task-created" | "generating-file" | "editing-file" | "running-command" | "starting-preview" | "complete" | "failed";
type AgentActivityItem = { id: string; type: string; status: string; title: string; description?: string; timestamp: number; durationMs?: number; filePath?: string; command?: string; added?: number; removed?: number; details?: string; shimmer?: boolean };
type VibePlanDraft = { projectId: string; prompt: string; title: string; summary: string; markdown: string; taskGraph: unknown[] };
type VibeChatMessage = { id: string; role: string; content: string; timestamp: number };

function relativeTime(iso: string) {
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "Just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function vibeThinkingHoldMs(prompt: string) {
  if (typeof window !== "undefined" && window.sessionStorage.getItem("clyra-vibe-boot-ready") === "1") return 0;
  return Math.min(1400, Math.max(280, prompt.trim().split(/\s+/).filter(Boolean).length > 48 ? 900 : 420));
}

function AnimatedCount({ value, tone }: { value: number; tone: "added" | "removed" }) {
  const [shown, setShown] = useState(0);
  const fromRef = useRef(0);

  useEffect(() => {
    if (value <= 0) { setShown(0); fromRef.current = 0; return; }
    const start = fromRef.current;
    const delta = value - start;
    if (delta <= 0) return;
    const started = performance.now();
    const duration = Math.min(1500, Math.max(350, delta * 10));
    let frame = 0;
    const tick = (now: number) => {
      const progress = Math.min(1, (now - started) / duration);
      const eased = 1 - Math.pow(1 - progress, 4);
      setShown(Math.round(start + delta * eased));
      if (progress < 1) frame = requestAnimationFrame(tick);
      else fromRef.current = value;
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [value]);

  return (
    <motion.span
      initial={{ scale: 1.2 }}
      animate={{ scale: 1 }}
      transition={{ duration: 0.4, ease: EASE }}
      className={tone === "added" ? "text-emerald-600 tabular-nums font-semibold" : "text-rose-500 tabular-nums font-semibold"}
    >
      {tone === "added" ? "+" : "−"}{shown}
    </motion.span>
  );
}

function ShimmerIcon({ icon: Icon, active }: { icon: typeof FileCode2; active: boolean }) {
  if (!active) return <Icon className="h-3.5 w-3.5" />;
  return (
    <motion.span
      animate={{ opacity: [0.3, 1, 0.3] }}
      transition={{ repeat: Infinity, duration: 2, ease: "easeInOut" }}
      className="text-[#0a84ff]"
    >
      <Icon className="h-3.5 w-3.5" />
    </motion.span>
  );
}

function AgentActionRow({ item, index }: { item: AgentActivityItem; index: number }) {
  const isActive = item.status === "active" || item.status === "running";
  const isDone = item.status === "success" || item.status === "completed";
  const isFailed = item.status === "error" || item.status === "failed";

  const isFileWrite = item.type === "file_create" || item.type === "file_edit" || item.type === "file_delete";
  const isTerminal = item.type === "terminal" || item.type === "command";
  const isSearch = item.type === "search" || item.type === "grep" || item.type === "glob";

  const actionLabel = isFileWrite ? "Edit" : isTerminal ? (isActive ? "Run" : isFailed ? "Failed" : "Ran") : isSearch ? "Explore" : "Done";

  const shimmerPlay = isActive && !isFailed;
  const delay = Math.min(index * 0.2, 1.2);

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay, ease: EASE }}
      className="flex items-center gap-3 py-1.5"
      style={{ fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" }}
    >
      {shimmerPlay ? (
        <ShiningText text={actionLabel} play className="text-[13px] font-medium shrink-0" />
      ) : (
        <span className={cn("text-[13px] font-medium shrink-0", isFailed ? "text-[#ba4141]" : "text-[#737373]")}>{actionLabel}</span>
      )}

      {item.filePath ? (
        <>
          <span className="text-[13px] font-medium text-[#242424] truncate">{item.filePath.split("/").pop()}</span>
          <span className="text-[12px] text-[#999] truncate hidden sm:inline">{item.filePath.split("/").slice(0, -1).join("/")}{item.filePath.includes("/") ? "/" : ""}</span>
        </>
      ) : null}

      <span className="ml-auto flex shrink-0 items-center gap-2 text-[12px] tabular-nums">
        {isFileWrite ? (
          <>
            <AnimatedCount value={item.added ?? 0} tone="added" />
            <AnimatedCount value={item.removed ?? 0} tone="removed" />
          </>
        ) : null}
      </span>
    </motion.div>
  );
}

function AgentTimeline({ items }: { items: AgentActivityItem[] }) {
  if (items.length === 0) return null;
  const recent = items.slice(-30);
  return (
    <div className="flex flex-col gap-0.5">
      <AnimatePresence initial={false}>
        {recent.map((item, index) => (
          <AgentActionRow key={item.id} item={item} index={index} />
        ))}
      </AnimatePresence>
    </div>
  );
}

function Composer({
  value, onChange, onSubmit, disabled, isGenerating, onStop, placeholder = "Plan, build, or ask anything…",
}: {
  value: string; onChange: (v: string) => void; onSubmit: () => void; disabled: boolean; isGenerating?: boolean; onStop?: () => void; placeholder?: string;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(160, Math.max(52, el.scrollHeight))}px`;
  }, [value]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!disabled || isGenerating) {
        if (isGenerating && onStop) onStop();
        else onSubmit();
      }
    }
  };

  return (
    <div className="shrink-0 border-t border-[#e7e7e7] bg-white px-4 py-3">
      <div className="mx-auto flex max-w-[600px] items-end gap-2 rounded-2xl border border-[#e5e5e5] bg-white px-3 py-1.5 transition-colors focus-within:border-[#d0d0d0]">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={1}
          placeholder={placeholder}
          className="max-h-40 min-h-[42px] flex-1 resize-none bg-transparent py-1.5 text-[14px] leading-relaxed text-[#202020] outline-none placeholder:text-[#999]"
          style={{ fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" }}
        />
        {isGenerating ? (
          <button type="button" onClick={onStop} className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-[#ba4141]/10 text-[#ba4141] transition-colors hover:bg-[#ba4141]/20">
            <Square className="h-3.5 w-3.5 fill-current" />
          </button>
        ) : (
          <button type="button" onClick={onSubmit} disabled={disabled} className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-[#202020] text-white transition-colors hover:bg-[#333] disabled:opacity-30">
            <Send className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}

type VibeProjectMeta = {
  id: string;
  name: string;
  prompt: string;
  mode: string;
  status: string;
  createdAt: string;
  updatedAt: string;
};

export default function VibeCoderWorkspace() {
  const { state, resetToIdle, startTask, restoreProject, updateProjectId } = useVibeCoderWorkspace("vibe-session");
  const [promptInput, setPromptInput] = useState("");
  const [chatMessages, setChatMessages] = useState<VibeChatMessage[]>([]);
  const [activeActivityItems, setActiveActivityItems] = useState<AgentActivityItem[]>([]);
  const [m1LaunchError, setM1LaunchError] = useState<string | null>(null);
  const [m1Launching, setM1Launching] = useState(false);
  const [thinkingStartedAt, setThinkingStartedAt] = useState<number | null>(null);
  const [warmupStatusHint, setWarmupStatusHint] = useState<string | null>(null);
  const [handoffSummary, setHandoffSummary] = useState<string | null>(null);
  const [activeProjectName, setActiveProjectName] = useState("Vibe Coder");
  const [skipEnterAnimation, setSkipEnterAnimation] = useState(false);
  const [rightTab, setRightTab] = useState<"code" | "changes" | "preview" | "terminal" | "plan">("preview");
  const welcomeScrollRef = useRef<HTMLDivElement>(null);
  const [followTimeline, setFollowTimeline] = useState(true);
  const [existingProjects, setExistingProjects] = useState<VibeProjectMeta[]>([]);
  const [loadingProjects, setLoadingProjects] = useState(true);
  const [projectSearch, setProjectSearch] = useState("");
  const [showAllProjects, setShowAllProjects] = useState(false);

  useEffect(() => {
    fetch("/api/vibe/projects")
      .then((r) => r.json())
      .then((data) => setExistingProjects(data.projects || []))
      .catch(() => setExistingProjects([]))
      .finally(() => setLoadingProjects(false));
  }, []);

  const filteredProjects = useMemo(() => {
    const q = projectSearch.trim().toLowerCase();
    const subset = q
      ? existingProjects.filter((p) => p.name.toLowerCase().includes(q) || p.prompt.toLowerCase().includes(q))
      : existingProjects;
    return showAllProjects ? subset : subset.slice(0, 4);
  }, [existingProjects, projectSearch, showAllProjects]);

  const timelineItems = useMemo<AgentActivityItem[]>(() => {
    const activity = state.thinkingLines
      .filter((line) => !/^Working\s/i.test(line.text) && !/^\*\*\*/.test(line.text) && line.text.trim().length > 0)
      .map((line) => ({
        id: line.id, type: /^Completed |^Could not run /.test(line.text) ? "tool" : "progress" as string,
        status: /Could not run/.test(line.text) ? "failed" as const : "completed" as const,
        title: line.text, timestamp: line.timestamp,
      }));
    const actionPaths = new Set(Object.values(state.actions).filter(a => /^(read|write|edit|delete)$/.test(a.tool)).map(a => a.target).filter(Boolean));
    const files = Object.values(state.files)
      .filter((file) => !actionPaths.has(file.path))
      .map((file) => ({
        id: `file:${file.path}`,
        type: file.action === "create" ? "file_create" : file.action === "delete" ? "file_delete" : "file_edit",
        status: file.status === "streaming" ? "running" : file.status === "error" ? "failed" : "completed",
        title: file.action, filePath: file.path, added: file.added, removed: file.removed, details: file.code, timestamp: Date.now(),
      }));
    const actionTerminalPaths = new Set(Object.values(state.actions).filter(a => /^(bash|shell|command)$/.test(a.tool)).map(a => a.target).filter(Boolean));
    const terminal = state.terminalLogs
      .filter((log) => !actionTerminalPaths.has(log.command || ""))
      .map((log) => ({ id: log.id, type: "terminal", status: "completed", title: "command", command: log.command, details: log.output, timestamp: log.timestamp }));
    const actions = Object.values(state.actions).map((action) => {
      const fileTool = /^(read|write|edit|delete)$/.test(action.tool);
      const commandTool = /^(bash|shell|command)$/.test(action.tool);
      const kind = action.tool === "read" ? "file_read" : action.tool === "write" ? "file_create" : action.tool === "edit" ? "file_edit" : action.tool === "delete" ? "file_delete" : commandTool ? "terminal" : /^(grep|glob|search)$/.test(action.tool) ? "search" : "tool";
      return {
        id: action.id, type: kind, status: action.status, title: action.tool,
        filePath: fileTool ? action.target : undefined,
        command: commandTool ? action.target : undefined,
        added: action.additions, removed: action.deletions,
        timestamp: action.startedAt || Date.now(),
        durationMs: action.completedAt && action.startedAt ? action.completedAt - action.startedAt : undefined,
      } satisfies AgentActivityItem;
    });
    return [...activity, ...files, ...terminal, ...actions].sort((left, right) => left.timestamp - right.timestamp).slice(-80);
  }, [state.actions, state.files, state.terminalLogs, state.thinkingLines]);

  const agentBusy = m1Launching || Boolean(thinkingStartedAt) || ["task-created", "generating-file", "editing-file", "running-command", "starting-preview"].includes(state.stage);
  const thinkingLabel = agentBusy ? (state.stage === "task-created" ? "Thinking" : stageLabel(state.stage)) : null;

  useEffect(() => {
    const container = welcomeScrollRef.current;
    if (container && followTimeline) container.scrollTop = container.scrollHeight;
  }, [followTimeline, state.actions, state.chatMessages, state.thinkingLines]);

  const handleSubmit = useCallback(async (overridePrompt?: string) => {
    const prompt = (overridePrompt ?? promptInput).trim();
    if (!prompt) return;
    setChatMessages((prev) => [...prev, { id: `user-${Date.now()}`, role: "user", content: prompt, timestamp: Date.now() }]);
    setPromptInput("");
    setM1LaunchError(null);
    setM1Launching(true);
    setThinkingStartedAt(Date.now());
    setHandoffSummary(`Got it — ${prompt.slice(0, 89)}… Creating project.`);
    setSkipEnterAnimation(true);
    try {
      const createRes = await fetch("/api/vibe/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, name: prompt.slice(0, 72), mode: "fast" }),
      });
      if (!createRes.ok) throw new Error("Failed to create project");
      const { project } = await createRes.json() as { project: VibeProjectMeta };
      setActiveProjectName(project.name);
      updateProjectId(project.id);
      window.dispatchEvent(new CustomEvent("clyra:workflow-tabs-hide"));
      setHandoffSummary(`Got it — ${prompt.slice(0, 89)}… Getting to work.`);
      await startTask(prompt, false);
    } catch (e) {
      setM1LaunchError(e instanceof Error ? e.message : "Failed to start");
    } finally {
      setM1Launching(false);
      setThinkingStartedAt(null);
    }
  }, [promptInput, startTask, updateProjectId]);

  const handleOpenProject = useCallback(async (project: VibeProjectMeta) => {
    try {
      setM1Launching(true);
      setActiveProjectName(project.name);
      setSkipEnterAnimation(true);
      await restoreProject(project.id);
    } catch (e) {
      setM1LaunchError(e instanceof Error ? e.message : "Failed to open project");
    } finally {
      setM1Launching(false);
    }
  }, [restoreProject]);

  const buildState = state.stage !== "idle";

  if (buildState) {
    return (
      <div className="flex h-full min-h-0 w-full bg-[#fafafa]" style={{ fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" }}>
        {m1LaunchError ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
            <span className="grid h-12 w-12 place-items-center rounded-xl bg-[#ba4141]/10 text-[#ba4141]"><AlertTriangle className="h-5 w-5" /></span>
            <p className="text-[15px] font-semibold text-[#20201e]">Couldn't start</p>
            <p className="max-w-lg text-[13px] text-[#686864]">{m1LaunchError}</p>
            <div className="flex gap-2">
              <button onClick={resetToIdle} className="rounded-lg border border-[#e7e7e4] bg-white px-4 py-2 text-[13px] font-medium text-[#686864] hover:bg-[#eeeeeb]">Back</button>
              <button onClick={() => void handleSubmit(promptInput)} className="rounded-lg bg-[#20201e] px-4 py-2 text-[13px] font-medium text-white hover:bg-black/80">Retry</button>
            </div>
          </div>
        ) : (
          <motion.div initial={skipEnterAnimation ? false : { opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.16, ease: EASE }} className="flex min-h-0 min-w-0 flex-1">
            {/* Left sessions sidebar */}
            <aside className="flex w-[220px] shrink-0 flex-col border-r border-[#e7e7e4] bg-[#f2f2f0]">
              <div className="flex h-9 shrink-0 items-center gap-2 border-b border-[#e7e7e4] px-3">
                <span className="text-[12px] font-semibold text-[#20201e]">Agents</span>
                <button className="ml-auto grid h-6 w-6 place-items-center rounded-md text-[#92928d] hover:bg-black/[0.04] hover:text-[#20201e]"><Plus className="h-3.5 w-3.5" /></button>
              </div>
              <div className="flex-1 overflow-y-auto p-1.5">
                <div className="rounded-md bg-black/[0.03] px-2.5 py-1.5">
                  <p className="text-[11px] font-medium text-[#20201e]">{activeProjectName}</p>
                  <p className="text-[10px] text-[#92928d]">{agentBusy ? "Running" : state.stage === "complete" ? "Completed" : stageLabel(state.stage)}</p>
                </div>
              </div>
            </aside>

            {/* Center conversation */}
            <section className="flex min-w-0 flex-1 flex-col bg-white border-r border-[#e7e7e4]">
              <div className="flex h-9 shrink-0 items-center gap-2 border-b border-[#e7e7e4] px-3">
                <span className="text-[12px] font-semibold text-[#20201e]">{activeProjectName}</span>
                <span className="ml-auto rounded-full px-2 py-0.5 text-[10px] font-medium text-[#686864] bg-[#f2f2f0]">
                  {agentBusy ? "In progress" : state.stage === "complete" ? "Done" : stageLabel(state.stage)}
                </span>
              </div>

              <div ref={welcomeScrollRef} onScroll={(event) => {
                const element = event.currentTarget;
                setFollowTimeline(element.scrollHeight - element.scrollTop - element.clientHeight < 72);
              }} className="relative min-h-0 flex-1 overflow-y-auto px-5 py-4">
                <div className="mx-auto flex max-w-[600px] flex-col gap-4">
                  {state.chatMessages.map((msg) => (
                    <motion.div key={msg.id} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.18, ease: EASE }}>
                      {msg.role === "user" ? (
                        <div className="ml-auto w-fit max-w-[78%] rounded-xl bg-[#f4f4f1] px-4 py-2.5 text-[14px] leading-relaxed text-[#202020]" style={{ fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" }}>{msg.content}</div>
                      ) : (
                        <div className="max-w-full text-[14px] leading-relaxed text-[#242424]" style={{ fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" }}>
                          <MarkdownMessageContent content={msg.content} />
                        </div>
                      )}
                    </motion.div>
                  ))}

                  {thinkingLabel && agentBusy ? (
                    <div className="flex items-center gap-2">
                      <ShiningBrainIcon />
                      <ShiningText text={thinkingLabel} play className="text-[13px] font-medium" />
                      <ThinkingDots />
                    </div>
                  ) : timelineItems.some(i => i.status === "running") ? (
                    <div className="flex items-center gap-2">
                      <ShiningBrainIcon />
                      <ShiningText text="Thinking" play className="text-[13px] font-medium" />
                      <ThinkingDots />
                    </div>
                  ) : handoffSummary && agentBusy ? (
                    <p className="text-[13px] text-[#686864]">{handoffSummary}</p>
                  ) : null}

                  <AgentTimeline items={timelineItems} />

                  {state.stage === "complete" && state.chatMessages.length > 0 ? (
                    <motion.div
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.35, delay: 0.15, ease: EASE }}
                      className="rounded-xl border border-[#e7e7e7] bg-white p-4"
                    >
                      <div className="flex items-center gap-2 mb-3">
                        <span className="grid h-5 w-5 place-items-center rounded-md bg-emerald-100 text-emerald-600">
                          <Check className="h-3 w-3" />
                        </span>
                        <span className="text-[13px] font-medium text-[#202020]">Build complete</span>
                      </div>
                      <div className="text-[14px] leading-relaxed text-[#737373]" style={{ fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" }}>
                        {state.chatMessages.filter((m) => m.role === "assistant").slice(-1).map((msg) => {
                          const lines = msg.content.split("\n").filter(Boolean);
                          const bullets = lines.filter((l) => /^[-*•]\s/.test(l.trim()));
                          const rest = lines.filter((l) => !bullets.includes(l));
                          return (
                            <div key={msg.id}>
                              {rest.length > 0 && <p className="mb-2">{rest.join(" ")}</p>}
                              {bullets.length > 0 && (
                                <ul className="space-y-1">
                                  {bullets.map((b, i) => (
                                    <li key={i} className="flex items-start gap-2">
                                      <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[#999]" />
                                      <span>{b.replace(/^[-*•]\s*/, "")}</span>
                                    </li>
                                  ))}
                                </ul>
                              )}
                            </div>
                          );
                        })}
                      </div>
                      {Object.keys(state.files).length > 0 && (
                        <p className="mt-3 text-[12px] text-[#999]">
                          {Object.keys(state.files).length} file{Object.keys(state.files).length !== 1 ? "s" : ""} created
                        </p>
                      )}
                    </motion.div>
                  ) : null}
                </div>
                {!followTimeline ? <button type="button" onClick={() => setFollowTimeline(true)} className="sticky bottom-2 left-1/2 -translate-x-1/2 rounded-md border border-[#ddddda] bg-white px-2.5 py-1 text-[11px] font-medium text-[#686864] shadow-sm">Jump to latest</button> : null}
              </div>

              <Composer
                value={promptInput}
                onChange={setPromptInput}
                onSubmit={() => void handleSubmit()}
                disabled={!promptInput.trim()}
                isGenerating={agentBusy}
                onStop={resetToIdle}
                placeholder="Describe what to change…"
              />
            </section>

            {/* Right work surface */}
            <section className="flex min-w-0 flex-1 flex-col bg-[#fafafa]">
              <div className="flex h-[42px] shrink-0 items-end border-b border-[#e7e7e7] px-2">
                <div className="flex items-end gap-0.5 h-full">
                  {(["code", "preview", "changes", "terminal", "plan"] as const).map((tab) => (
                    <button
                      key={tab}
                      onClick={() => setRightTab(tab)}
                      className={cn(
                        "flex items-center gap-1.5 px-3 py-2 text-[12px] font-medium transition-colors duration-150 rounded-t-lg",
                        rightTab === tab
                          ? "bg-white text-[#202020] border border-[#e7e7e7] border-b-white -mb-px"
                          : "text-[#737373] hover:text-[#202020] hover:bg-white/50",
                      )}
                    >
                      {tab === "code" ? <Code2 className="h-3.5 w-3.5" /> : tab === "preview" ? <Globe2 className="h-3.5 w-3.5" /> : tab === "changes" ? <GitBranch className="h-3.5 w-3.5" /> : tab === "terminal" ? <TerminalSquare className="h-3.5 w-3.5" /> : <FileCode2 className="h-3.5 w-3.5" />}
                      <span className="capitalize">{tab}</span>
                      {tab === "terminal" && state.terminalLogs.length > 0 ? <span className="text-[10px] text-[#999]">{state.terminalLogs.length}</span> : null}
                    </button>
                  ))}
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-hidden">
                {rightTab === "preview" && state.projectId ? (
                  <LivePreviewPanel project={{ id: state.projectId, name: activeProjectName, status: state.preview.status || "starting" }} className="h-full" />
                ) : rightTab === "preview" ? (
                  <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
                    <Globe2 className="h-5 w-5 text-[#92928d]" />
                    <p className="text-[13px] text-[#686864]">Preview will appear here</p>
                    <p className="text-[11px] text-[#92928d]">Start building to see the live result</p>
                  </div>
                ) : rightTab === "code" ? (
                  <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
                    <Code2 className="h-5 w-5 text-[#92928d]" />
                    <p className="text-[13px] text-[#686864]">Code editor</p>
                    <p className="text-[11px] text-[#92928d]">Files will appear here during the session</p>
                  </div>
                ) : rightTab === "changes" ? (
                  <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
                    <GitBranch className="h-5 w-5 text-[#92928d]" />
                    <p className="text-[13px] text-[#686864]">Changes</p>
                    <p className="text-[11px] text-[#92928d]">Diffs will show here after editing files</p>
                  </div>
                ) : rightTab === "terminal" ? (
                  <div className="flex h-full flex-col bg-[#fbfbfb]">
                    <div className="flex h-8 shrink-0 items-center gap-2 border-b border-[#e7e7e4] px-3">
                      <TerminalSquare className="h-3.5 w-3.5 text-[#92928d]" />
                      <span className="text-[11px] font-semibold text-[#686864]">Terminal</span>
                      {state.terminalLogs.length > 0 ? (
                        <span className="ml-auto text-[10px] text-[#b5b5b0]">{state.terminalLogs.length} command{state.terminalLogs.length !== 1 ? "s" : ""}</span>
                      ) : null}
                    </div>
                    <div className="flex-1 overflow-y-auto">
                      {state.terminalLogs.length > 0 ? (
                        <div className="p-3 font-mono text-[12px] leading-relaxed">
                          {state.terminalLogs.map((log) => (
                            <div key={log.id} className="mb-3 last:mb-0">
                              {log.command ? (
                                <div className="flex items-center gap-2 rounded-md bg-[#f0f2f5] px-2.5 py-1.5">
                                  <span className="text-[#0a84ff] font-semibold select-none">$</span>
                                  <span className="text-[#20201e] font-medium">{log.command}</span>
                                </div>
                              ) : null}
                              {log.output ? (
                                <pre className="mt-1.5 ml-1 whitespace-pre-wrap text-[#686864] leading-5 break-all">{log.output.trim()}</pre>
                              ) : null}
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
                          <TerminalSquare className="h-5 w-5 text-[#b5b5b0]" />
                          <p className="text-[13px] text-[#686864]">No commands yet</p>
                          <p className="text-[11px] text-[#92928d]">Command output will stream here</p>
                        </div>
                      )}
                    </div>
                  </div>
                ) : rightTab === "plan" ? (
                  <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
                    <FileCode2 className="h-5 w-5 text-[#92928d]" />
                    <p className="text-[13px] text-[#686864]">Plan</p>
                    <p className="text-[11px] text-[#92928d]">Use Plan mode to outline before building</p>
                  </div>
                ) : null}
              </div>
            </section>
          </motion.div>
        )}
      </div>
    );
  }

  // ── IDLE WELCOME ──
  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-[#fafafa]" style={{ fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" }}>
      <div className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-6 py-10">
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3, ease: EASE }} className="flex flex-col items-center text-center">
          <span className="mb-5 grid h-10 w-10 place-items-center rounded-xl bg-black/[0.06]">
            <Code2 className="h-5 w-5 text-[#686864]" />
          </span>
          <h1 className="text-[26px] font-semibold tracking-[-0.03em] text-[#20201e]">What do you want to build?</h1>
          <p className="mt-1.5 text-[14px] text-[#686864]">Describe your app, feature, or fix.</p>
        </motion.div>

        <div className="mt-8 w-full max-w-[540px]">
          <Composer
            value={promptInput}
            onChange={setPromptInput}
            onSubmit={() => void handleSubmit()}
            disabled={!promptInput.trim() || m1Launching}
            isGenerating={m1Launching}
            placeholder="Plan, build, or ask anything…"
          />
        </div>

        <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
          {["Build a landing page", "Create a calculator app", "Fix a bug", "Add authentication"].map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              onClick={() => { setPromptInput(suggestion); }}
              className="rounded-lg border border-[#e7e7e4] bg-white px-3 py-1.5 text-[12px] font-medium text-[#686864] transition-colors hover:bg-[#eeeeeb] hover:text-[#20201e]"
            >
              {suggestion}
            </button>
          ))}
        </div>

        {existingProjects.length > 0 ? (
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: 0.1, ease: EASE }}
            className="mt-12 w-full max-w-[680px]"
          >
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-[13px] font-semibold tracking-[-0.01em] text-[#686864]">Recent Projects</h2>
              <span className="text-[11px] text-[#92928d]">{existingProjects.length} project{existingProjects.length !== 1 ? "s" : ""}</span>
            </div>
            <div className="relative mb-4">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[#92928d]" />
              <input
                type="text"
                value={projectSearch}
                onChange={(e) => setProjectSearch(e.target.value)}
                placeholder="Search projects…"
                className="w-full rounded-lg border border-[#e7e7e4] bg-white py-2 pl-9 pr-3 text-[12px] text-[#20201e] outline-none placeholder:text-[#b5b5b0] focus:border-[#ccccca] focus:ring-0 transition-colors"
              />
            </div>
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
              {filteredProjects.map((project) => (
                <motion.button
                  key={project.id}
                  type="button"
                  onClick={() => void handleOpenProject(project)}
                  disabled={m1Launching}
                  className="group flex items-center gap-3 rounded-xl border border-[#e7e7e4] bg-white p-3.5 text-left transition-all hover:border-[#ccccca] hover:shadow-sm active:scale-[0.985]"
                  whileHover={{ y: -1 }}
                  transition={{ duration: 0.15, ease: EASE }}
                >
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px] bg-black/[0.04] text-[#686864] group-hover:bg-black/[0.08] group-hover:text-[#20201e] transition-colors">
                    <Folder className="h-4 w-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] font-semibold text-[#20201e]">{project.name}</p>
                    <p className="mt-0.5 flex items-center gap-1 text-[11px] text-[#92928d]">
                      {project.mode === "fast" ? "Build" : "Plan"}
                      <span className="inline-block w-1 h-1 rounded-full bg-[#ddddda]" />
                      <span>{relativeTime(project.updatedAt)}</span>
                    </p>
                  </div>
                  <ArrowUpRight className="h-3.5 w-3.5 text-[#92928d] transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
                </motion.button>
              ))}
            </div>
            {filteredProjects.length === 0 && projectSearch.trim() ? (
              <p className="mt-3 text-center text-[12px] text-[#92928d]">No projects match "{projectSearch}"</p>
            ) : null}
            {!projectSearch.trim() && existingProjects.length > 4 && !showAllProjects ? (
              <motion.button
                type="button"
                onClick={() => setShowAllProjects(true)}
                className="mt-4 w-full rounded-xl border border-[#e7e7e4] bg-white py-2.5 text-[12px] font-medium text-[#686864] transition-all hover:border-[#ccccca] hover:text-[#20201e] hover:bg-[#fbfbfa]"
              >
                View all {existingProjects.length} projects
                <ChevronRight className="h-3.5 w-3.5 inline-block ml-1" />
              </motion.button>
            ) : showAllProjects && !projectSearch.trim() ? (
              <motion.button
                type="button"
                onClick={() => setShowAllProjects(false)}
                className="mt-4 w-full text-center text-[12px] font-medium text-[#92928d] hover:text-[#686864] transition-colors"
              >
                Show less
              </motion.button>
            ) : null}
          </motion.div>
        ) : loadingProjects ? (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="mt-12 flex items-center gap-2 text-[12px] text-[#92928d]"
          >
            <Loader2 className="h-3 w-3 animate-spin" />
            Loading projects…
          </motion.div>
        ) : null}
      </div>
    </div>
  );
}
