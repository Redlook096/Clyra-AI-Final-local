import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Brain, Code2, FileCode2, FolderTree, Globe2, Play, Send, Square, TerminalSquare } from "lucide-react";
import { cn } from "../lib/utils";
import { useVibeCoderWorkspace } from "../hooks/useVibeCoderWorkspace";
import { FileTreePanel } from "./vibe-coder/files/FileTreePanel";
import { ShiningText } from "./ShiningText";

type OpenCodeVibeWorkspaceProps = {
  onEngaged?: () => void;
  onOpenBrowser?: () => void;
};

function AnimatedCount({ value, tone }: { value: number; tone: "added" | "removed" }) {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  useEffect(() => {
    const start = from.current;
    const delta = value - start;
    if (!delta) return;
    const started = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const progress = Math.min(1, (now - started) / 220);
      setShown(Math.round(start + delta * (1 - (1 - progress) ** 3)));
      if (progress < 1) frame = requestAnimationFrame(tick);
      else from.current = value;
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [value]);
  return <motion.span layout className={tone === "added" ? "text-emerald-600" : "text-rose-500"}>{tone === "added" ? "+" : "−"}{shown}</motion.span>;
}

function ActivityRow({
  icon: Icon,
  label,
  detail,
  active,
  additions,
  removals,
}: {
  icon: typeof Brain;
  label: string;
  detail?: string;
  active: boolean;
  additions?: number;
  removals?: number;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2.5 rounded-xl px-3 py-2 text-[12.5px]">
      <Icon className={cn("h-4 w-4 shrink-0", active ? "text-slate-700" : "text-slate-400")} strokeWidth={1.75} />
      <div className="min-w-0 flex-1 truncate">
        {active ? <ShiningText text={label} play className="font-medium" /> : <span className="font-medium text-slate-700">{label}</span>}
        {detail ? <span className={cn("ml-1.5 truncate", label === "Editing" ? "font-medium text-[#0a84ff]" : "font-mono text-[11.5px] text-slate-500")}>{detail}</span> : null}
      </div>
      {additions !== undefined || removals !== undefined ? (
        <motion.span layout className="flex shrink-0 items-center gap-1.5 font-mono text-[11px] font-semibold">
          <AnimatedCount value={additions || 0} tone="added" />
          <AnimatedCount value={removals || 0} tone="removed" />
        </motion.span>
      ) : null}
    </div>
  );
}

export function OpenCodeVibeWorkspace({ onEngaged, onOpenBrowser }: OpenCodeVibeWorkspaceProps) {
  const { state, startTask, cancelTask, setState } = useVibeCoderWorkspace("project-advanced-vibe");
  const [prompt, setPrompt] = useState("");
  const [planMode, setPlanMode] = useState(false);
  const [status, setStatus] = useState<{ available: boolean; version?: string; providerConfigured?: boolean } | null>(null);
  const textarea = useRef<HTMLTextAreaElement | null>(null);
  const running = !["idle", "complete", "failed", "cancelled", "paused"].includes(state.stage);
  const files = useMemo(() => Object.values(state.files).sort((left, right) => left.path.localeCompare(right.path)), [state.files]);
  const activeFile = state.activeFilePath || files.at(-1)?.path || null;
  const activeCode = activeFile ? state.files[activeFile]?.code || "" : "";

  useEffect(() => {
    void fetch("/api/opencode/status", { cache: "no-store" })
      .then(async (response) => ({ response, body: await response.json() as { available: boolean; version?: string; providerConfigured?: boolean } }))
      .then(({ body }) => setStatus(body))
      .catch(() => setStatus({ available: false }));
  }, []);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const next = prompt.trim();
    if (!next || running) return;
    onEngaged?.();
    void startTask(next, planMode);
    setPrompt("");
  };

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-[#fbfcfe] text-slate-950">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-slate-200/80 bg-white/85 px-4 backdrop-blur-xl">
        <span className="grid h-7 w-7 place-items-center rounded-[9px] bg-slate-950 text-white"><Code2 className="h-3.5 w-3.5" /></span>
        <div className="min-w-0">
          <p className="text-[13px] font-semibold tracking-[-.01em] text-slate-900">Vibe Coder</p>
          <p className="text-[10.5px] font-medium text-slate-400">OpenCode workspace{status?.version ? ` · ${status.version}` : ""}</p>
        </div>
        <span className={cn("ml-1 h-1.5 w-1.5 rounded-full", status?.available ? status?.providerConfigured ? "bg-emerald-500" : "bg-amber-400" : "bg-rose-400")} title={status?.available ? "OpenCode runtime available" : "OpenCode runtime unavailable"} />
        <div className="ml-auto flex items-center gap-1 rounded-[10px] bg-slate-100 p-1">
          <button type="button" onClick={() => setPlanMode(false)} className={cn("rounded-[7px] px-2.5 py-1 text-[11px] font-semibold transition-colors duration-150", !planMode ? "bg-white text-slate-900 shadow-[0_1px_2px_rgba(15,23,42,.08)]" : "text-slate-500 hover:text-slate-800")}>Build</button>
          <button type="button" onClick={() => setPlanMode(true)} className={cn("rounded-[7px] px-2.5 py-1 text-[11px] font-semibold transition-colors duration-150", planMode ? "bg-white text-slate-900 shadow-[0_1px_2px_rgba(15,23,42,.08)]" : "text-slate-500 hover:text-slate-800")}>Plan</button>
        </div>
        <button type="button" onClick={onOpenBrowser} className="ml-1 grid h-8 w-8 place-items-center rounded-[9px] text-slate-500 transition-colors duration-150 hover:bg-slate-100 hover:text-slate-900" title="Open Clyra Browser"><Globe2 className="h-4 w-4" /></button>
      </header>

      <main className="grid min-h-0 flex-1 grid-cols-[218px_minmax(0,1fr)] gap-0 lg:grid-cols-[236px_minmax(0,1fr)_minmax(260px,30%)]">
        <aside className="min-h-0 border-r border-slate-200/80 bg-white p-2.5"><FileTreePanel files={state.files} activeFile={activeFile} planMd={state.planMd} onSelectFile={(path) => setState((current) => ({ ...current, activeFilePath: path }))} /></aside>

        <section className="relative flex min-h-0 min-w-0 flex-col border-r border-slate-200/80">
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 py-6 sm:px-8">
            {state.chatMessages.length ? <p className="mb-5 max-w-3xl text-[15px] font-medium leading-6 text-slate-700">{state.chatMessages.at(-1)?.content}</p> : <>
              <h1 className="max-w-2xl text-[26px] font-semibold tracking-[-.035em] text-slate-950">Build directly in your project.</h1>
              <p className="mt-2 max-w-xl text-[13.5px] leading-6 text-slate-500">OpenCode plans, edits, and runs project work in a Clyra-managed workspace. Its activity is streamed here as it happens.</p>
            </>}
            <div className="mt-5 max-w-3xl overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-[0_8px_28px_rgba(15,23,42,.035)]">
              <div className="border-b border-slate-100 px-3.5 py-2.5 text-[10.5px] font-semibold uppercase tracking-[.14em] text-slate-400">Activity</div>
              <div className="divide-y divide-slate-100 px-1.5 py-1">
                {!state.thinkingLines.length && !files.length && !state.terminalLogs.length ? <div className="px-3 py-5 text-[12.5px] text-slate-400">Describe a change to start an OpenCode run.</div> : null}
                {state.thinkingLines.slice(-6).map((line, index, lines) => <ActivityRow key={line.id} icon={Brain} label="Thinking" detail={line.text} active={running && index === lines.length - 1} />)}
                {files.map((file) => <ActivityRow key={`${file.path}-${file.added}-${file.removed}`} icon={FileCode2} label="Editing" detail={file.path} active={file.status === "streaming"} additions={file.added} removals={file.removed} />)}
                {state.terminalLogs.slice(-5).map((log, index, logs) => <ActivityRow key={log.id} icon={TerminalSquare} label="Running command" detail={log.command || log.output.replace(/^>\s*/, "").split("\n")[0]} active={running && index === logs.length - 1 && state.stage === "running-command"} />)}
                {state.error ? <div className="px-3 py-3 text-[12.5px] font-medium text-rose-600">{state.error}</div> : null}
              </div>
            </div>
            {state.stage === "complete" ? <p className="mt-3 text-[12px] font-medium text-emerald-600">OpenCode finished. Review the files or continue with another instruction.</p> : null}
          </div>
          <form onSubmit={submit} className="shrink-0 border-t border-slate-200/80 bg-white/94 p-3 backdrop-blur-xl">
            <div className="mx-auto flex max-w-3xl items-end gap-2 rounded-[16px] border border-slate-200 bg-white px-3 py-2 shadow-[0_4px_16px_rgba(15,23,42,.04)] focus-within:border-slate-400 focus-within:shadow-[0_0_0_3px_rgba(15,23,42,.055)]">
              <textarea ref={textarea} value={prompt} onChange={(event) => setPrompt(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} rows={1} placeholder={planMode ? "Plan a change in this project…" : "Ask OpenCode to build or change something…"} className="max-h-28 min-h-6 flex-1 resize-none bg-transparent py-1 text-[13.5px] font-medium leading-5 text-slate-800 outline-none placeholder:text-slate-400" />
              {running ? <button type="button" onClick={() => void cancelTask()} className="grid h-8 w-8 place-items-center rounded-[9px] bg-slate-950 text-white transition-transform active:scale-95" title="Stop run"><Square className="h-3 w-3 fill-current" /></button> : <button type="submit" disabled={!prompt.trim() || status?.available === false} className="grid h-8 w-8 place-items-center rounded-[9px] bg-slate-950 text-white transition-transform hover:bg-slate-800 active:scale-95 disabled:cursor-not-allowed disabled:opacity-35" title="Run with OpenCode"><Send className="h-3.5 w-3.5" /></button>}
            </div>
          </form>
        </section>

        <aside className="hidden min-h-0 flex-col bg-white lg:flex">
          <div className="flex h-11 shrink-0 items-center gap-2 border-b border-slate-200/80 px-3.5"><FolderTree className="h-3.5 w-3.5 text-slate-400" /><span className="truncate font-mono text-[11.5px] font-medium text-slate-600">{activeFile || "No file selected"}</span></div>
          <pre className="clyra-visible-scrollbar min-h-0 flex-1 overflow-auto bg-[#fbfcfe] p-4 font-mono text-[11.5px] leading-5 text-slate-700">{activeCode || "// Generated files appear here."}</pre>
        </aside>
      </main>
    </div>
  );
}
