import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ArrowDown } from "lucide-react";
import { cn } from "../../lib/utils";
import { MarkdownMessageContent } from "../MarkdownMessageContent";
import { ShiningText } from "../ShiningText";
import type { AgentAction, ClyraCodeState, LogEntry } from "./store";
import { AgentActionRow } from "./ActionRow";
import { DiffCounters } from "./AnimatedCounter";
import { stripFilePrefix } from "./format";
import { AGENT_EASE, ROW_ENTER, SUBTLE_ENTER } from "./motion";

/**
 * A single quiet reasoning marker. It only shows the durable elapsed label
 * after a real reasoning event completes; no disclosure UI or grouped state.
 */
function ThinkingEvent({ entry }: { entry: Extract<LogEntry, { type: "reasoning" }> }) {
  const completed = Boolean(entry.endedAt);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (completed) return;
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [completed]);
  const seconds = Math.max(1, Math.round(((entry.endedAt ?? now) - entry.ts) / 1000));
  const showDuration = completed || seconds >= 3;

  return (
    <motion.div layout className="flex min-h-[22px] items-center py-[2px]">
      {completed ? (
        <motion.span initial={{ opacity: 0, y: -1 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.16, ease: AGENT_EASE }} className="text-[13px] leading-5 text-[#8A8D92]">
          Thought · {seconds}s
        </motion.span>
      ) : (
        <>
          <ShiningText text="Thinking" play className="truncate text-[13px] font-medium leading-5 tracking-normal" />
          <span className="ml-1 inline-block min-w-[2.5ch] text-[11px] tabular-nums text-[#8A8D92]">
            {showDuration ? `${seconds}s` : ""}
          </span>
        </>
      )}
    </motion.div>
  );
}

/** Consecutive identical assistant chunks are transport retries, not user-visible prose. */
function dedupeConsecutiveAssistantEntries(entries: LogEntry[]) {
  return entries.filter((entry, index) => {
    if (entry.type !== "assistant") return true;
    const previous = entries[index - 1];
    return previous?.type !== "assistant" || previous.text.trim() !== entry.text.trim();
  });
}

/** Tiny transport-level reasoning bridges add no useful structure once their
 * real tool phase is present. Keep meaningful completed thoughts expandable,
 * but suppress one-second noise so a run never becomes a column of repeats. */
function suppressBriefThoughts(entries: LogEntry[]) {
  // Providers can emit several small reasoning summaries before any tool has
  // actually started. They are one continuous thought, not three separate UI
  // events. Keep a single row using the first timestamp and latest summary.
  const compacted: LogEntry[] = [];
  for (const entry of entries) {
    if (entry.type !== "reasoning") {
      compacted.push(entry);
      continue;
    }
    const previous = compacted.at(-1);
    if (previous?.type === "reasoning") {
      compacted[compacted.length - 1] = {
        ...entry,
        id: `${previous.id}:${entry.id}`,
        ts: previous.ts,
        text: entry.text?.trim() || previous.text,
        endedAt: entry.endedAt ?? previous.endedAt,
      };
      continue;
    }
    compacted.push(entry);
  }
  return compacted;
}

/** Bottom-of-transcript thinking gap while the next reasoning phase is pending. */
function PendingThinking({
  startedAt,
  onStop,
  reduced,
}: {
  startedAt: number;
  onStop?: () => void;
  reduced: boolean | null;
}) {
  return (
    <motion.div
      layout
      className="flex min-w-0 items-center gap-1.5 py-[3px]"
      {...(reduced
        ? {}
        : { initial: { opacity: 0, y: 3 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.18, ease: AGENT_EASE } })}
    >
      <ShiningText
        text="Thinking"
        play
        className="text-[12px] font-medium tracking-[-0.01em]"
      />
      {onStop ? (
        <button
          type="button"
          onClick={onStop}
          className="ml-0.5 h-5 rounded-[6px] px-1.5 text-[10.5px] text-[#5F6368] transition-colors hover:bg-black/[0.035]"
        >
          Stop
        </button>
      ) : null}
    </motion.div>
  );
}

export function CompletionSummary({
  diffs,
  actions,
  onOpenChanges,
  onOpenFile,
  restored = false,
}: {
  diffs: ClyraCodeState["diffs"];
  actions: AgentAction[];
  onOpenChanges: () => void;
  onOpenFile: (path: string) => void;
  restored?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const totals = useMemo(
    () => ({
      additions: diffs.reduce((sum, d) => sum + (d.additions ?? 0), 0),
      deletions: diffs.reduce((sum, d) => sum + (d.deletions ?? 0), 0),
    }),
    [diffs],
  );
  const successfulValidation = actions.filter(
    (action) => /^(build|check|test|preview)$/.test(action.kind) && action.status === "success",
  );
  const validationLabels = [...new Set(successfulValidation.map((action) => {
    if (action.kind === "build") return "Build passed";
    if (action.kind === "test") return "Tests passed";
    if (action.kind === "check") return "Checks passed";
    return "Preview checked";
  }))];
  if (!diffs.length && !validationLabels.length) return null;
  return (
    <motion.div
      {...(restored ? {} : SUBTLE_ENTER)}
      className="mt-4 text-[12px] leading-[1.5]"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[#65796A]">
        {validationLabels.map((label) => <span key={label}>✓ {label}</span>)}
      </div>
      {diffs.length ? (
        <>
          <div className="mt-1.5 flex items-center gap-2 text-[12px]">
            <button
              type="button"
              aria-expanded={expanded}
              onClick={() => setExpanded((current) => !current)}
              className="flex min-w-0 items-center gap-1 text-left text-[#686A70] transition-colors hover:text-[#252525]"
            >
              <motion.span
                aria-hidden
                animate={{ rotate: expanded ? 90 : 0 }}
                transition={{ duration: 0.18, ease: AGENT_EASE }}
                className="inline-block w-2 text-[9px]"
              >
                ›
              </motion.span>
              <span className="font-medium">
                {diffs.length} file{diffs.length === 1 ? "" : "s"} changed
              </span>
            </button>
            <DiffCounters additions={totals.additions} deletions={totals.deletions} animate={false} className="text-[10.75px] font-medium" />
            <button
              type="button"
              onClick={onOpenChanges}
              className="ml-auto text-[11.5px] text-[#3977F6] transition-opacity hover:opacity-80"
            >
              Review
            </button>
          </div>
          <AnimatePresence initial={false}>
            {expanded ? (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.22, ease: AGENT_EASE }}
                className="mt-1 overflow-hidden"
              >
                <div className="flex flex-col">
                  {diffs.map((diff) => {
                    const path = stripFilePrefix(diff.file);
                    return (
                      <button
                        key={diff.file}
                        type="button"
                        onClick={() => onOpenFile(path)}
                        title={path}
                        className="grid h-[24px] grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-[5px] px-2 text-left transition-colors hover:bg-black/[.025]"
                      >
                        <span className="cc-mono truncate text-[11px] text-[#505258]">{path}</span>
                        <DiffCounters additions={diff.additions} deletions={diff.deletions} animate={false} className="text-[10.75px] font-medium" />
                      </button>
                    );
                  })}
                </div>
              </motion.div>
            ) : null}
          </AnimatePresence>
        </>
      ) : null}
      <p className="mt-2 text-[12px] leading-[1.5] text-[#686A70]">
        {diffs.length
          ? `Completed the requested work with ${diffs.length} updated file${diffs.length === 1 ? "" : "s"}.`
          : "Completed the requested validation."}
      </p>
    </motion.div>
  );
}

type TranscriptItem = { type: "entry"; entry: LogEntry; id: string };

/**
 * Keeps the activity stream readable during a busy OpenCode phase. A later
 * action is not mounted until the prior action has finished its visible
 * lifecycle; streaming edit boxes explicitly release this queue after their
 * own smooth collapse. The 500ms hand-off makes each real event legible.
 */
function SequencedActionRows({
  actions,
  thoughts,
  onOpenFile,
  revisitedActionIds,
  instant = false,
}: {
  actions: AgentAction[];
  thoughts: Extract<LogEntry, { type: "reasoning" }>[];
  onOpenFile: (path: string) => void;
  revisitedActionIds: Set<string>;
  instant?: boolean;
}) {
  const reduced = useReducedMotion();
  const [revealed, setRevealed] = useState(() => (instant ? actions.length : Math.min(1, actions.length)));
  const releaseTimer = useRef<number | null>(null);
  const releasing = useRef(false);
  const current = actions[Math.max(0, revealed - 1)];

  useEffect(() => {
    setRevealed((value) => instant ? actions.length : Math.min(Math.max(value, actions.length ? 1 : 0), actions.length));
  }, [actions.length, instant]);
  useEffect(() => () => { if (releaseTimer.current) window.clearTimeout(releaseTimer.current); }, []);

  const releaseNext = () => {
    if (instant || releasing.current || revealed >= actions.length) return;
    releasing.current = true;
    releaseTimer.current = window.setTimeout(() => {
      releasing.current = false;
      setRevealed((value) => Math.min(actions.length, value + 1));
    }, reduced ? 0 : 120);
  };

  useEffect(() => {
    if (instant || !current || revealed >= actions.length) return;
    const editing = /^(edit|create)$/.test(current.kind);
    const running = current.status === "active" || current.status === "queued";
    // Edit cards control their own close animation and call releaseNext. All
    // other settled real actions receive the same calm 0.5s hand-off.
    if (!editing && !running) releaseNext();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id, current?.status, revealed, actions.length, instant]);

  // Thoughts are compacted by phase too: the latest provider summary is the
  // useful one, and it appears only after the final visible action.
  const latestThought = thoughts.at(-1);
  return (
    <>
      {actions.slice(0, revealed).map((action) => (
        <AgentActionRow
          key={action.id}
          action={action}
          onOpenFile={onOpenFile}
          revisiting={revisitedActionIds.has(action.id)}
          onEditClosed={action.id === current?.id ? releaseNext : undefined}
          settled={instant}
        />
      ))}
      {revealed >= actions.length && latestThought ? <ThinkingEvent key={latestThought.id} entry={latestThought} /> : null}
    </>
  );
}

function phaseLabel(actions: AgentAction[]) {
  const reads = actions.filter((action) => action.kind === "read").length;
  const searches = actions.filter((action) => action.kind === "search").length;
  const research = actions.filter((action) => action.kind === "research").length;
  const lists = actions.filter((action) => action.kind === "list").length;
  const edits = actions.filter((action) => /^(edit|create|delete)$/.test(action.kind));
  const commands = actions.filter((action) => /^(command|build|check|test|preview)$/.test(action.kind));
  const additions = edits.reduce((total, action) => total + (action.additions ?? 0), 0);
  const deletions = edits.reduce((total, action) => total + (action.deletions ?? 0), 0);
  if (edits.length && !reads && !searches && !lists && !commands.length) {
    return { text: `Edited ${new Set(edits.map((action) => action.target)).size} file${new Set(edits.map((action) => action.target)).size === 1 ? "" : "s"}`, additions, deletions };
  }
  if (commands.length && !edits.length && !reads && !searches && !lists) {
    const validation = commands.some((action) => /^(build|check|test)$/.test(action.kind));
    return { text: validation ? "Ran validation" : `Ran ${commands.length} command${commands.length === 1 ? "" : "s"}`, additions, deletions };
  }
  if ((reads || searches || research || lists) && !edits.length && !commands.length) {
    const parts = [
      research ? `${research} web source${research === 1 ? "" : "s"}` : "",
      reads ? `${reads} file${reads === 1 ? "" : "s"}` : "",
      searches ? `${searches} codebase search${searches === 1 ? "" : "es"}` : "",
      lists ? `${lists} folder${lists === 1 ? "" : "s"}` : "",
    ].filter(Boolean);
    return { text: research ? `Researched ${parts.join(" and ")}` : `Explored ${parts.join(" and ")}`, additions, deletions };
  }
  const parts = [edits.length ? "edited files" : "", reads || searches || lists ? "read files" : "", commands.length ? "ran commands" : ""].filter(Boolean);
  return { text: parts.length ? `${parts[0][0].toUpperCase()}${parts[0].slice(1)}${parts.length > 1 ? `, ${parts.slice(1).join(", ")}` : ""}` : "Completed agent work", additions, deletions };
}

function PhaseGroup({
  actions,
  thoughts,
  onOpenFile,
  revisitedActionIds,
  historical,
  defaultExpanded,
}: {
  actions: AgentAction[];
  thoughts: Extract<LogEntry, { type: "reasoning" }>[];
  onOpenFile: (path: string) => void;
  revisitedActionIds: Set<string>;
  historical?: boolean;
  defaultExpanded?: boolean;
}) {
  const [manuallyExpanded, setManuallyExpanded] = useState(false);
  const active = actions.some((action) => action.status === "active" || action.status === "queued") || thoughts.some((thought) => !thought.endedAt);
  const [expanded, setExpanded] = useState(Boolean(defaultExpanded) || active);
  // A run must read as a live stream first.  Only after every action in this
  // contiguous phase has settled do we replace the individual rows with its
  // compact summary.  This avoids the old behaviour where "Explored…" was
  // rendered before the user had actually seen the final read/command.
  const [summaryVisible, setSummaryVisible] = useState(Boolean(defaultExpanded) || historical);
  const reduced = useReducedMotion();
  const label = phaseLabel(actions);
  useEffect(() => {
    if (active) {
      setSummaryVisible(false);
      setExpanded(true);
      return;
    }
    if (manuallyExpanded) return;
    // Let the final row (and its completed Thought) remain visible long
    // enough to be read, then compact the entire finished phase together.
    const timer = window.setTimeout(() => {
      setSummaryVisible(true);
      setExpanded(Boolean(defaultExpanded));
    }, reduced ? 0 : 560);
    return () => window.clearTimeout(timer);
  }, [active, defaultExpanded, manuallyExpanded, reduced]);

  if (!summaryVisible) {
    return (
      <motion.div {...(reduced || historical ? {} : ROW_ENTER)} layout className="py-[2px]">
        <SequencedActionRows actions={actions} thoughts={thoughts} onOpenFile={onOpenFile} revisitedActionIds={revisitedActionIds} />
      </motion.div>
    );
  }
  return (
    <motion.div
      {...(reduced || historical ? {} : ROW_ENTER)}
      layout
      className="py-[2px] text-[14px] leading-5 text-[#73757A] opacity-[0.84] transition-opacity duration-200"
    >
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => { setManuallyExpanded(true); setExpanded((current) => !current); }}
        className="flex h-6 items-center gap-1 rounded-[5px] pr-1 text-left transition-colors hover:bg-black/[0.025] hover:text-[#505257]"
      >
        <motion.span
          aria-hidden
          animate={{ rotate: expanded ? 90 : 0 }}
          transition={{ duration: 0.18, ease: AGENT_EASE }}
          className="inline-block w-2 text-[9px]"
        >
          ›
        </motion.span>
        <span>{label.text}</span>
        {(label.additions || label.deletions) ? <DiffCounters additions={label.additions} deletions={label.deletions} animate={false} className="text-[13px] font-medium" /> : null}
      </button>
      <AnimatePresence initial={false}>
        {expanded ? (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.22, ease: AGENT_EASE }}
            className="ml-4 overflow-hidden"
          >
            <SequencedActionRows actions={actions} thoughts={thoughts} onOpenFile={onOpenFile} revisitedActionIds={revisitedActionIds} instant />
          </motion.div>
        ) : null}
      </AnimatePresence>
    </motion.div>
  );
}

export function Conversation({
  state,
  running,
  onCancel,
  onReplyPermission,
  onRetry,
  onOpenTerminal,
  onOpenFile,
  onOpenChanges,
}: {
  state: ClyraCodeState;
  running: boolean;
  onCancel: () => void;
  onReplyPermission: (permissionId: string, response: "allow" | "always" | "deny") => void;
  onRetry: (action: AgentAction) => void;
  onOpenTerminal: () => void;
  onOpenFile: (path: string) => void;
  onOpenChanges: () => void;
}) {
  const reduced = useReducedMotion();
  const [density] = useState<"compact" | "balanced" | "detailed">(() => {
    try {
      const saved = localStorage.getItem("clyra-code:density");
      if (saved === "compact" || saved === "detailed") return saved;
    } catch { /* storage unavailable */ }
    return "balanced";
  });
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(true);
  const scrollFrameRef = useRef<number | null>(null);
  const contentHeightRef = useRef(0);
  const [pinned, setPinned] = useState(true);

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const onScroll = () => {
      const isPinned = node.scrollHeight - node.scrollTop - node.clientHeight < 96;
      pinnedRef.current = isPinned;
      // Only re-render when the pin state actually flips so scrolling itself
      // never churns the transcript.
      setPinned((prev) => (prev === isPinned ? prev : isPinned));
    };
    node.addEventListener("scroll", onScroll, { passive: true });
    return () => node.removeEventListener("scroll", onScroll);
  }, []);

  // Follow layout transitions instead of snapping: rAF-throttled, only while
  // the user is near the bottom. Framer's height animation drives the motion;
  // we simply keep the viewport glued to the moving bottom edge.
  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const content = node.firstElementChild;
    if (!content) return;
    const observer = new ResizeObserver(() => {
      if (!pinnedRef.current) return;
      if (scrollFrameRef.current) return;
      scrollFrameRef.current = requestAnimationFrame(() => {
        scrollFrameRef.current = null;
        if (pinnedRef.current) {
          const nextHeight = node.scrollHeight;
          const delta = nextHeight - contentHeightRef.current;
          // Move the viewport by the same amount as the transcript's layout
          // growth. This keeps collapses/streamed actions visually attached
          // to the bottom instead of making the content jump underneath it.
          if (delta > 0) node.scrollTop += delta;
          else node.scrollTop = node.scrollHeight;
          contentHeightRef.current = nextHeight;
        }
      });
    });
    observer.observe(content);
    contentHeightRef.current = node.scrollHeight;
    return () => {
      observer.disconnect();
      if (scrollFrameRef.current) cancelAnimationFrame(scrollFrameRef.current);
    };
  }, []);

  const jumpToLatest = () => {
    pinnedRef.current = true;
    setPinned(true);
    const node = scrollRef.current;
    if (node) {
      node.scrollTo({ top: node.scrollHeight, behavior: reduced ? "auto" : "smooth" });
    }
  };

  const showCompletion = state.runState === "complete" && (
    state.diffs.length > 0 || Object.values(state.actions).some(
      (action) => /^(build|check|test|preview)$/.test(action.kind) && action.status === "success",
    )
  );
  const hasActiveTool = Object.values(state.actions).some(
    (action) => action.status === "active" || action.status === "queued",
  );
  const hasOpenReasoning = state.log.some(
    (entry) => entry.type === "reasoning" && !entry.endedAt,
  );
  // A provider can settle a reasoning part a frame before it emits the next
  // tool. Keep that real Thought marker as the single visual owner of the
  // state during the hand-off instead of briefly mounting a second “Thinking”
  // row beneath it.
  const latestReasoning = [...state.log].reverse().find(
    (entry): entry is Extract<LogEntry, { type: "reasoning" }> => entry.type === "reasoning",
  );
  const reasoningJustSettled = Boolean(
    latestReasoning?.endedAt && Date.now() - latestReasoning.endedAt < 1_800,
  );
  const showThinking =
    running &&
    !!state.runStartedAt &&
    !hasActiveTool &&
    !hasOpenReasoning &&
    !reasoningJustSettled;
  const revisitedActionIds = useMemo(() => {
    const editedFiles = new Set<string>();
    const revisited = new Set<string>();

    state.log.forEach((entry) => {
      if (entry.type !== "action") return;
      const action = state.actions[entry.actionId];
      if (!action) return;
      if (/^(edit|create|delete)$/.test(action.kind)) editedFiles.add(action.target);
      if (action.kind === "read" && editedFiles.has(action.target)) revisited.add(action.id);
    });

    return revisited;
  }, [state.actions, state.log]);
  const transcriptItems = useMemo<TranscriptItem[]>(() => {
    const log = suppressBriefThoughts(dedupeConsecutiveAssistantEntries(state.log));
    // Keep the transcript literal: each OpenCode event owns one row. In
    // particular, do not suppress unfamiliar provider tools; they are often
    // the only visible record of real browser, file, or project work.
    return log.map((entry) => ({ type: "entry" as const, entry, id: entry.id }));
  }, [state.actions, state.log, density]);

  // Render immediately from the real OpenCode event stream. Earlier versions
  // artificially delayed rows, which made scroll position lag behind the
  // changing transcript and looked like a raw, staged command log.
  const visibleItems = transcriptItems;

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={scrollRef} className="cc-scroll absolute inset-0 overflow-y-auto px-6 pb-4 pt-3 sm:px-7">
        <div className="mx-auto flex w-full max-w-[760px] flex-col">
          {visibleItems.map((item, index) => {
            const entry = item.entry;
            const prev = visibleItems[index - 1]?.entry;
            const nextKindGap =
              prev &&
              ((prev.type === "action" && entry.type === "assistant") ||
                (prev.type === "assistant" && entry.type === "action") ||
                (prev.type === "user" && entry.type !== "user"));
            // Historical entries (restored sessions) render settled.
            const fresh = Date.now() - entry.ts < 4000;

            if (entry.type === "user") {
              return (
                <motion.div
                  key={entry.id}
                  {...(reduced || !fresh
                    ? {}
                    : { initial: { opacity: 0, y: 3 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.18, ease: AGENT_EASE } })}
                  className="mb-2.5 mt-[16px] flex w-full justify-end first:mt-2"
                >
                  <div
                    data-invert-ignore="true"
                    className="cc-user-prompt max-w-[82%] rounded-[11px] px-[12px] py-[8px] text-[14px] leading-[21px] text-[#2F3033]"
                  >
                    {entry.answers?.length ? (
                      <div className="mb-1.5 flex flex-col gap-[3px] rounded-[7px] border border-black/[0.05] bg-white/55 px-2 py-1.5">
                        {entry.answers.map((row) => (
                          <div key={row.question} className="flex items-center gap-2">
                            <span className="min-w-0 flex-1 truncate text-[11px] text-[#8B8D92]">{row.question}</span>
                            <span className="shrink-0 text-[12px] font-medium text-[#303136]">{row.answer}</span>
                          </div>
                        ))}
                      </div>
                    ) : null}
                    <span className="whitespace-pre-wrap">{entry.text}</span>
                  </div>
                </motion.div>
              );
            }
            if (entry.type === "assistant") {
              return (
                <motion.div
                  key={entry.id}
                  {...(reduced || !fresh ? {} : SUBTLE_ENTER)}
                  className={cn(
                    "text-[14px] font-normal leading-[21px] tracking-normal text-[#303136]",
                    "[&_p]:my-[9px] [&_ul]:my-[9px] [&_ol]:my-[9px] [&_li]:my-[3px] [&_pre]:my-2 [&_code]:text-[12px]",
                    "[&_strong]:font-medium",
                    nextKindGap ? "mt-2.5" : "mt-1.5",
                  )}
                >
                  <MarkdownMessageContent content={entry.text} />
                </motion.div>
              );
            }
            if (entry.type === "reasoning") {
              return (
                <div key={entry.id} className={cn(nextKindGap ? "mt-2" : "mt-0.5")}>
                  <ThinkingEvent entry={entry} />
                </div>
              );
            }
            const action = state.actions[entry.actionId];
            if (!action) return null;
            return (
              <div
                key={entry.id}
                className={cn(prev?.type === "action" ? "mt-[3px]" : nextKindGap ? "mt-2" : "mt-1")}
              >
                <AgentActionRow
                  action={action}
                  onReplyPermission={onReplyPermission}
                  onRetry={onRetry}
                  onOpenTerminal={onOpenTerminal}
                  onOpenFile={onOpenFile}
                  revisiting={revisitedActionIds.has(action.id)}
                />
              </div>
            );
          })}

          <AnimatePresence initial={false}>
            {showThinking ? (
              <motion.div
                key="thinking-gap"
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.18, ease: AGENT_EASE }}
                className="mt-1.5 overflow-hidden"
              >
                <PendingThinking
                  startedAt={state.runStartedAt!}
                  onStop={onCancel}
                  reduced={reduced}
                />
              </motion.div>
            ) : null}
          </AnimatePresence>

          {state.runState === "failed" && state.error ? (
            <div className="mt-2 text-[12px] leading-[1.5]">
              <span className="font-medium text-[#B94B4B]">Failed</span>{" "}
              <span className="text-[#787A7F]">{state.error}</span>
            </div>
          ) : null}

          {state.runState === "cancelled" ? (
            <div className="mt-2 text-[11.5px] text-[#96989D]">
              Cancelled by user
            </div>
          ) : null}

          {showCompletion ? (
            <CompletionSummary
              diffs={state.diffs}
              actions={Object.values(state.actions)}
              onOpenChanges={onOpenChanges}
              onOpenFile={onOpenFile}
              restored={state.restored}
            />
          ) : null}
        </div>
      </div>

      <AnimatePresence>
        {!pinned ? (
          <motion.button
            key="jump-to-latest"
            type="button"
            initial={{ opacity: 0, y: 6, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.96 }}
            transition={{ duration: 0.18, ease: AGENT_EASE }}
            onClick={jumpToLatest}
            aria-label="Jump to latest"
            title="Jump to latest"
            className="absolute bottom-4 left-1/2 z-10 flex h-7 -translate-x-1/2 items-center gap-1 rounded-full border border-black/[0.08] bg-white px-2.5 text-[12px] font-medium text-[#5F6368] shadow-[0_4px_14px_rgba(15,23,42,0.1)] transition-colors hover:text-[#171717]"
          >
            <ArrowDown className="h-3 w-3" strokeWidth={2} />
            Jump to latest
          </motion.button>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
