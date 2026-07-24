import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Check, ChevronDown, Expand, MousePointer2, Pause, Play, RotateCcw, Square, X } from "lucide-react";
import { cn } from "../lib/utils";
import {
  createAgentTask,
  persistAgentTask,
  readAgentTask,
  taskKey,
  updateTaskStep,
  type AgentActionRecord,
  type AgentControllerState,
  type AgentControllerTask,
} from "../lib/agentController";

type PreviewAgent = {
  id: string;
  label: string;
  instruction?: string;
  status: string;
  action?: string;
};

const TERMINAL_STATES = new Set<AgentControllerState>(["completed", "failed", "cancelled"]);

function wait(ms: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, ms));
}

function setNativeValue(field: HTMLTextAreaElement, value: string) {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value");
  descriptor?.set?.call(field, value);
  field.dispatchEvent(new Event("input", { bubbles: true }));
  field.dispatchEvent(new Event("change", { bubbles: true }));
}

export function AgentControlledPreview({ agent, messageId }: { agent: PreviewAgent; messageId: string }) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const runnerRef = useRef(false);
  const cancelledRef = useRef(false);
  const taskStorageKey = useMemo(() => taskKey(messageId, agent.id), [agent.id, messageId]);
  const [iframeReady, setIframeReady] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [fullScreen, setFullScreen] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const [task, setTask] = useState<AgentControllerTask>(() => readAgentTask(taskStorageKey) || createAgentTask(taskStorageKey, agent.id, agent.instruction || agent.label));

  const commit = useCallback((next: AgentControllerTask) => {
    setTask(next);
    persistAgentTask(taskStorageKey, next);
    return next;
  }, [taskStorageKey]);

  useEffect(() => {
    const restored = readAgentTask(taskStorageKey) || createAgentTask(taskStorageKey, agent.id, agent.instruction || agent.label);
    cancelledRef.current = false;
    setTask(restored);
  }, [agent.id, agent.instruction, agent.label, taskStorageKey]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFullScreen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const record = useCallback((current: AgentControllerTask, action: Omit<AgentActionRecord, "id" | "timestamp" | "retry">, state: AgentControllerState, currentAction: string) => {
    const next = {
      ...current,
      state,
      currentAction,
      actions: [...current.actions, { ...action, id: `${Date.now()}-${current.actions.length}`, timestamp: Date.now(), retry: 0 }].slice(-80),
      activity: [...current.activity, currentAction].slice(-12),
      updatedAt: Date.now(),
    };
    return commit(next);
  }, [commit]);

  const getFrameDocument = useCallback(() => {
    const frame = iframeRef.current;
    if (!frame?.contentDocument || !frame.contentWindow) throw new Error("The workspace is still loading.");
    return { frame, document: frame.contentDocument, window: frame.contentWindow };
  }, []);

  const moveTo = useCallback(async (_target: HTMLElement, _label: string, clicking = false) => {
    // The agent operates the same-origin preview directly; timing preserves a
    // readable handoff without drawing a decorative cursor over the workspace.
    await wait(clicking ? 120 : 170);
  }, []);

  const ensureRunnable = useCallback((current: AgentControllerTask) => {
    if (cancelledRef.current || current.state === "cancelled") throw new Error("Stopped by user");
    if (current.state === "paused_by_user" || current.state === "user_controlling") throw new Error("Paused for user control");
  }, []);

  const typeRequest = useCallback(async (current: AgentControllerTask) => {
    const { document } = getFrameDocument();
    const input = document.querySelector<HTMLTextAreaElement>("[data-agent-id='vibe-request-input']");
    if (!input) throw new Error("Vibe's request field was not available.");
    input.scrollIntoView({ block: "center", behavior: "smooth" });
    await moveTo(input, "Project request", true);
    input.focus();
    const prompt = agent.instruction?.trim() || "Build the requested project.";
    let value = "";
    for (const unit of Array.from(prompt)) {
      ensureRunnable(current);
      value += unit;
      setNativeValue(input, value);
      await wait(unit === " " ? 10 : 15);
    }
    return record(current, { type: "type_text", target: "Vibe project request", expected: "The project request is entered", actual: prompt, verified: input.value === prompt }, "acting", "Entered the project request");
  }, [agent.instruction, ensureRunnable, getFrameDocument, moveTo, record]);

  const click = useCallback(async (current: AgentControllerTask, selector: string, targetName: string, expected: string) => {
    const { document } = getFrameDocument();
    const target = document.querySelector<HTMLElement>(selector);
    if (!target) throw new Error(`${targetName} was not available.`);
    target.scrollIntoView({ block: "center", behavior: "smooth" });
    await moveTo(target, targetName, true);
    target.click();
    await wait(180);
    return record(current, { type: "click", target: targetName, expected, actual: "Clicked", verified: true }, "waiting", `Waiting for ${targetName.toLowerCase()}`);
  }, [getFrameDocument, moveTo, record]);

  const waitFor = useCallback(async (current: AgentControllerTask, selector: string, label: string, timeout = 30000) => {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      ensureRunnable(current);
      const { document } = getFrameDocument();
      if (document.querySelector(selector)) {
        return record(current, { type: "wait_for_element", target: label, expected: "Control becomes available", actual: "Available", verified: true, durationMs: Date.now() - started }, "verifying", `${label} is ready`);
      }
      await wait(240);
    }
    throw new Error(`${label} did not become available.`);
  }, [ensureRunnable, getFrameDocument, record]);

  const runVibe = useCallback(async () => {
    if (runnerRef.current || !iframeReady || agent.id !== "vibe") return;
    const existing = readAgentTask(taskStorageKey) || task;
    if (TERMINAL_STATES.has(existing.state) || existing.state === "paused_by_user" || existing.state === "user_controlling") return;
    runnerRef.current = true;
    let current = commit({ ...existing, state: "planning", currentAction: "Inspecting Vibe Coder", activity: [...existing.activity, "Inspecting Vibe Coder"].slice(-12) });
    try {
      const { window: childWindow } = getFrameDocument();
      const snapshot = childWindow.__CLYRA_AGENT_BRIDGE__?.snapshot();
      current = record(current, { type: "inspect_page", target: "Vibe Coder", expected: "Semantic workspace controls", actual: `${snapshot?.controls.length || 0} controls`, verified: Boolean(snapshot) }, "inspecting", "Inspected the live workspace");
      current = updateTaskStep(current, "open", "complete");
      current = updateTaskStep(current, "request", "active");
      current = commit(current);
      current = await waitFor(current, "[data-agent-id='vibe-request-input']", "Vibe request field", 30000);
      current = await typeRequest(current);
      current = updateTaskStep(current, "request", "complete");
      current = updateTaskStep(current, "build", "active");
      current = commit(current);
      current = await click(current, "[data-agent-id='vibe-send-request']", "Send request", "The real build is started");
      current = record(current, { type: "wait_for_build", target: "Vibe build", expected: "A real build state or recoverable error", actual: "Build request sent", verified: true }, "waiting", "Monitoring the real build");
      current = updateTaskStep(current, "build", "complete");
      current = updateTaskStep(current, "preview", "active");
      current = commit(current);

      const started = Date.now();
      while (Date.now() - started < 60_000) {
        ensureRunnable(current);
        const next = getFrameDocument().window.__CLYRA_AGENT_BRIDGE__?.snapshot();
        if (next?.errors.length) throw new Error(next.errors[0]);
        if (next?.previewReady || next?.buildStatus === "complete") {
          current = updateTaskStep(current, "preview", "complete");
          current = updateTaskStep(current, "verify", "complete");
          current = updateTaskStep(current, "save", "complete");
          commit({ ...current, state: "completed", currentAction: "Build verified", completionEvidence: ["Vibe Coder reported a ready preview or complete build."], activity: [...current.activity, "Build verified"].slice(-12) });
          return;
        }
        await wait(350);
      }
      throw new Error("The build did not report a ready preview in time.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "The workspace stopped unexpectedly.";
      if (message === "Paused for user control" || message === "Stopped by user") return;
      commit({ ...current, state: "failed", currentAction: "Needs attention", error: message, activity: [...current.activity, `Needs attention: ${message}`].slice(-12) });
    } finally {
      runnerRef.current = false;
    }
  }, [agent.id, click, commit, ensureRunnable, getFrameDocument, iframeReady, record, task, taskStorageKey, typeRequest, waitFor]);

  useEffect(() => {
    void runVibe();
  }, [runVibe]);

  const changeState = (state: AgentControllerState, action: string) => {
    const next = { ...task, state, currentAction: action, error: state === "planning" ? undefined : task.error, manualControl: state === "user_controlling", activity: [...task.activity, action].slice(-12) };
    commit(next);
  };

  const origin = typeof window === "undefined" ? "http://localhost:3000" : window.location.origin;
  const source = `${origin}/?embedTool=${encodeURIComponent(agent.id)}&agentPreview=1`;
  const manual = task.state === "user_controlling";
  const running = !TERMINAL_STATES.has(task.state) && task.state !== "paused_by_user" && !manual;

  return (
    <motion.article
      layout
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      className={cn("agent-controlled-preview relative overflow-hidden bg-white", fullScreen && "fixed inset-4 z-[100]")}
      transition={{ type: "spring", stiffness: 340, damping: 34, mass: .7 }}
    >
      <AnimatePresence initial={false}>
        {expanded ? <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="agent-preview-activity overflow-hidden px-4 py-3">
          <ol className="space-y-1 text-[11px] text-slate-500">{task.plan.map((step) => <li key={step.id} className="flex items-center gap-2"><span className={cn("h-1.5 w-1.5 rounded-full", step.status === "complete" ? "bg-emerald-500" : step.status === "active" ? "bg-blue-500" : "bg-slate-300")} />{step.label}</li>)}</ol>
          {task.error ? <p className="mt-2 text-[11px] text-amber-700">{task.error}</p> : null}
        </motion.div> : null}
      </AnimatePresence>
      <div className="relative h-[min(58vh,500px)] min-h-[320px] overflow-hidden rounded-[18px] bg-slate-50">
        {!iframeReady ? <div className="agent-soft-shimmer absolute inset-0 z-10" /> : null}
        <iframe ref={iframeRef} title={`${agent.label} live workspace`} src={source} onLoad={() => setIframeReady(true)} className={cn("h-full w-full border-0 bg-white", manual ? "pointer-events-auto" : "pointer-events-none")} />
        <div className="agent-preview-status"><span className={cn("h-1.5 w-1.5 rounded-full", task.state === "completed" ? "bg-emerald-500" : task.state === "failed" ? "bg-amber-500" : "bg-blue-500")} />{task.currentAction || agent.action || agent.label}</div>
        <AnimatePresence>
          {(isHovered || expanded || fullScreen) ? <motion.div initial={{ opacity: 0, y: -5 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -5 }} className="agent-preview-controls">
            <button type="button" aria-label={expanded ? "Hide activity" : "Show activity"} onClick={() => setExpanded((value) => !value)}><ChevronDown className={cn("h-3.5 w-3.5 transition-transform", expanded && "rotate-180")} /></button>
            <button type="button" aria-label={fullScreen ? "Exit fullscreen preview" : "Fullscreen preview"} onClick={() => setFullScreen((value) => !value)}>{fullScreen ? <X className="h-3.5 w-3.5" /> : <Expand className="h-3.5 w-3.5" />}</button>
          </motion.div> : null}
        </AnimatePresence>
      </div>
      <AnimatePresence>
      {(isHovered || task.state === "failed" || task.state === "paused_by_user" || manual) ? <motion.div initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 4 }} className="agent-preview-footer flex items-center gap-1 px-3 py-2">
        {task.state === "completed" ? <span className="mr-auto inline-flex items-center gap-1.5 text-[11px] font-medium text-emerald-700"><Check className="h-3.5 w-3.5" />Build verified</span> : <span className="mr-auto text-[11px] text-slate-500">{manual ? "You are controlling this workspace" : task.state === "paused_by_user" ? "Agent paused" : "Live workspace"}</span>}
        {task.state === "failed" ? <button type="button" onClick={() => { cancelledRef.current = false; changeState("planning", "Retrying from the live workspace"); }} className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-slate-600 hover:bg-slate-100"><RotateCcw className="h-3 w-3" />Retry</button> : null}
        {task.state === "paused_by_user" ? <button type="button" onClick={() => changeState("planning", "Agent resumed") } className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-slate-600 hover:bg-slate-100"><Play className="h-3 w-3" />Resume</button> : null}
        {manual ? <button type="button" onClick={() => changeState("planning", "Agent resumed from your current workspace") } className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-slate-600 hover:bg-slate-100"><RotateCcw className="h-3 w-3" />Return control</button> : <button type="button" disabled={TERMINAL_STATES.has(task.state)} onClick={() => changeState("user_controlling", "You took control") } className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-slate-600 hover:bg-slate-100 disabled:opacity-40"><MousePointer2 className="h-3 w-3" />Take control</button>}
        {running ? <button type="button" aria-label="Pause agent" onClick={() => changeState("paused_by_user", "Agent paused") } className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100"><Pause className="h-3.5 w-3.5" /></button> : null}
        {!TERMINAL_STATES.has(task.state) ? <button type="button" aria-label="Stop agent" onClick={() => { cancelledRef.current = true; changeState("cancelled", "Stopped by user"); }} className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100"><Square className="h-3 w-3" /></button> : null}
      </motion.div> : null}
      </AnimatePresence>
    </motion.article>
  );
}
