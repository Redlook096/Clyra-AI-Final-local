import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ArrowDown, ChevronRight } from "lucide-react";
import { cn } from "../../lib/utils";
import { MarkdownMessageContent } from "../MarkdownMessageContent";
import { ShiningText } from "../ShiningText";
import type { AgentAction, ClyraCodeState, LogEntry } from "./store";
import { AgentActionRow } from "./ActionRow";
import { DiffCounters } from "./AnimatedCounter";
import { stripFilePrefix } from "./format";
import { AGENT_EASE, ROW_ENTER, SUBTLE_ENTER } from "./motion";

/**
 * One persistent thinking row. While running it shimmers with the same sweep
 * as the live preview; when the backend ends the reasoning phase the same
 * row settles into "Thought for Xs" — the shimmer keeps sweeping underneath
 * while the completed label crossfades over it, then the container width
 * eases to the new label. No unmount, no frozen state, no teleport.
 */
function ThinkingEvent({ entry }: { entry: Extract<LogEntry, { type: "reasoning" }> }) {
  const completed = Boolean(entry.endedAt);
  const seconds = entry.endedAt
    ? Math.max(1, Math.round((entry.endedAt - entry.ts) / 1000))
    : 0;

  // Restored history renders the settled label immediately — no morph replay.
  const [historical] = useState(() => {
    if (!entry.endedAt) return false;
    return Date.now() - entry.endedAt > 4000;
  });
  const settled = completed && historical;

  const [dropShimmer, setDropShimmer] = useState(settled);
  const [expanded, setExpanded] = useState(false);
  const summary = entry.text?.trim();

  useEffect(() => {
    if (settled) return;
    if (!completed) {
      setDropShimmer(false);
      return;
    }
    const timer = window.setTimeout(() => setDropShimmer(true), 640);
    return () => window.clearTimeout(timer);
  }, [completed, settled]);

  return (
    <motion.div layout className="relative py-[2px]">
      <button
        type="button"
        disabled={!completed || !summary}
        aria-expanded={completed && summary ? expanded : undefined}
        onClick={() => summary && setExpanded((value) => !value)}
        className={cn(
          "flex min-h-[22px] min-w-0 items-center gap-1.5 rounded-[5px] text-left transition-colors",
          completed && summary && "hover:bg-black/[0.025]",
        )}
      >
        {!dropShimmer ? (
          <div className={cn("flex min-w-0 items-center gap-2 transition-opacity duration-300 ease-out", completed && "opacity-0")} aria-hidden={completed || undefined}>
            <ShiningText text={summary || "Thinking"} play className="truncate text-[14px] font-medium leading-5 tracking-normal" />
          </div>
        ) : null}
        <AnimatePresence>
          {completed ? (
            <motion.div key="completed" className={cn("flex items-center gap-1.5", !dropShimmer && "absolute inset-0")} initial={settled ? { opacity: 1, x: 0 } : { opacity: 0, x: -3 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.22, ease: AGENT_EASE }}>
              {summary ? <motion.span aria-hidden animate={{ rotate: expanded ? 90 : 0 }} transition={{ duration: 0.18, ease: AGENT_EASE }} className="inline-flex w-3 justify-center text-[#A0A2A6]"><ChevronRight className="h-3 w-3" /></motion.span> : <span className="w-3" />}
            <span className="text-[13px] leading-5 text-[#8A8D92]">Thought · {seconds}s</span>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </button>
      <AnimatePresence initial={false}>
        {completed && expanded && summary ? (
          <motion.p initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2, ease: AGENT_EASE }} className="ml-4 max-w-[620px] overflow-hidden pb-1 pt-0.5 text-[13px] leading-5 text-[#8A8D92]">
            {summary}
          </motion.p>
        ) : null}
      </AnimatePresence>
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

type TranscriptItem =
  | { type: "entry"; entry: LogEntry; id: string }
  | { type: "phase"; id: string; actions: AgentAction[]; thoughts: Extract<LogEntry, { type: "reasoning" }>[]; ts: number };

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
    }, reduced ? 0 : 500);
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
  if ((reads || searches || lists) && !edits.length && !commands.length) {
    const parts = [reads ? `${reads} file${reads === 1 ? "" : "s"}` : "", searches ? `${searches} search${searches === 1 ? "" : "es"}` : "", lists ? `${lists} folder${lists === 1 ? "" : "s"}` : ""].filter(Boolean);
    return { text: `Explored ${parts.join(" and ")}`, additions, deletions };
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
  const showThinking = running && !!state.runStartedAt && !hasActiveTool && !hasOpenReasoning;
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
    const next: TranscriptItem[] = [];
    const log = suppressBriefThoughts(dedupeConsecutiveAssistantEntries(state.log));
    for (let index = 0; index < log.length;) {
      const entry = log[index];
      if (entry.type !== "action") {
        next.push({ type: "entry", entry, id: entry.id });
        index += 1;
        continue;
      }
      const action = state.actions[entry.actionId];
      // Compact density hides insignificant internal calls.
      if (
        density === "compact" &&
        action &&
        /^(generic|todo|fetch)$/.test(action.kind) &&
        action.status === "success"
      ) {
        index += 1;
        continue;
      }
      const grouped: AgentAction[] = [action];
      const thoughts: Extract<LogEntry, { type: "reasoning" }>[] = [];
      let cursor = index + 1;
      while (cursor < log.length) {
        const candidate = log[cursor];
        // Reasoning belongs under the action phase it follows. It should not
        // prematurely split a real OpenCode phase into several summaries.
        if (candidate.type === "reasoning") {
          thoughts.push(candidate);
          cursor += 1;
          continue;
        }
        if (candidate.type !== "action") break;
        const candidateAction = state.actions[candidate.actionId];
        if (!candidateAction) break;
        grouped.push(candidateAction);
        cursor += 1;
      }
      const active = grouped.some((item) => item.status === "active" || item.status === "queued") || thoughts.some((thought) => !thought.endedAt);
      if (grouped.length > 1 || active || thoughts.length) {
        next.push({ type: "phase", id: `phase-${grouped[0].id}-${grouped.at(-1)?.id}`, actions: grouped, thoughts, ts: entry.ts });
        index = cursor;
      } else {
        next.push({ type: "entry", entry, id: entry.id });
        index += 1;
      }
    }
    return next;
  }, [state.actions, state.log, density]);

  // Render immediately from the real OpenCode event stream. Earlier versions
  // artificially delayed rows, which made scroll position lag behind the
  // changing transcript and looked like a raw, staged command log.
  const visibleItems = transcriptItems;

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={scrollRef} className="cc-scroll absolute inset-0 overflow-y-auto px-5 pb-3 pt-2 sm:px-7">
        <div className="mx-auto flex w-full max-w-[760px] flex-col">
          {visibleItems.map((item, index) => {
            if (item.type === "phase") {
              return (
                <PhaseGroup
                  key={item.id}
                  actions={item.actions}
                  thoughts={item.thoughts}
                  onOpenFile={onOpenFile}
                  revisitedActionIds={revisitedActionIds}
                  historical={Date.now() - item.ts > 4000}
                  defaultExpanded={density === "detailed"}
                />
              );
            }
            const entry = item.entry;
            const previousItem = visibleItems[index - 1];
            const prev = previousItem?.type === "entry" ? previousItem.entry : undefined;
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
                  className="mb-3 mt-[22px] flex w-full justify-end first:mt-2"
                >
                  <div
                    data-invert-ignore="true"
                    className="cc-user-prompt max-w-[82%] whitespace-pre-wrap rounded-[11px] px-[12px] py-[10px] text-[16px] leading-6 text-[#2F3033]"
                  >
                    {entry.text}
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
                    "text-[16px] font-normal leading-6 tracking-normal text-[#2F3033]",
                    "[&_p]:my-[10px] [&_ul]:my-[10px] [&_ol]:my-[10px] [&_li]:my-[3px] [&_pre]:my-2 [&_code]:text-[13px]",
                    "[&_strong]:font-medium",
                    nextKindGap ? "mt-3" : "mt-1.5",
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
                className={cn(prev?.type === "action" ? "mt-[4px]" : nextKindGap ? "mt-2.5" : "mt-1")}
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
