import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { cn } from "../../lib/utils";
import { MarkdownMessageContent } from "../MarkdownMessageContent";
import { ShiningBrainIcon, ShiningText } from "../ShiningText";
import type { AgentAction, ClyraCodeState, LogEntry } from "./store";
import { AgentActionRow } from "./ActionRow";
import { DiffCounters } from "./AnimatedCounter";
import { stripFilePrefix } from "./format";

function ElapsedSeconds({ since }: { since: number }) {
  const [, force] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => force((v) => v + 1), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.round((Date.now() - since) / 1000));
  return <span className="cc-counter text-[10.5px] tabular-nums text-[#8A8A8A]">{seconds}s</span>;
}

/** Existing Clyra thinking shimmer — no spinners. */
export function ThinkingIndicator({
  startedAt,
  onStop,
}: {
  startedAt: number;
  onStop?: () => void;
}) {
  return (
    <div className="flex items-center gap-1.5 py-[3px]">
      <ShiningBrainIcon className="h-3.5 w-3.5" />
      <ShiningText text="Thinking" play className="text-[12px] font-medium tracking-[-0.01em]" />
      <ElapsedSeconds since={startedAt} />
      {onStop ? (
        <button
          type="button"
          onClick={onStop}
          className="ml-0.5 h-5 rounded-[6px] px-1.5 text-[11px] text-[#5F6368] transition-colors hover:bg-[#F0F0EE]"
        >
          Stop
        </button>
      ) : null}
    </div>
  );
}

function ThoughtSummary({ entry }: { entry: Extract<LogEntry, { type: "reasoning" }> }) {
  const open = !entry.endedAt;
  const seconds = entry.endedAt
    ? Math.max(1, Math.round((entry.endedAt - entry.ts) / 1000))
    : 0;

  return (
    <AnimatePresence mode="wait" initial={false}>
      {open ? (
        <motion.div
          key={`${entry.id}-open`}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, height: 0 }}
          transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
          className="overflow-hidden"
        >
          <ThinkingIndicator startedAt={entry.ts} />
        </motion.div>
      ) : (
        <motion.div
          key={`${entry.id}-done`}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
          className="py-[3px] text-[11.5px] text-[#8A8A8A]"
        >
          Thought for {seconds}s
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export function CompletionSummary({
  diffs,
  onOpenChanges,
  onOpenFile,
}: {
  diffs: ClyraCodeState["diffs"];
  onOpenChanges: () => void;
  onOpenFile: (path: string) => void;
}) {
  const totals = useMemo(
    () => ({
      additions: diffs.reduce((sum, d) => sum + (d.additions ?? 0), 0),
      deletions: diffs.reduce((sum, d) => sum + (d.deletions ?? 0), 0),
    }),
    [diffs],
  );
  if (!diffs.length) return null;
  return (
    <motion.div
      initial={{ opacity: 0, y: 3 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
      className="cc-changed-files mt-4 overflow-hidden rounded-[8px] bg-[#F7F7F6]"
    >
      <div className="flex h-6 items-center gap-2 px-2.5 text-[11.5px]">
        <span className="font-medium text-[#171717]">
          {diffs.length} file{diffs.length === 1 ? "" : "s"} changed
        </span>
        <DiffCounters additions={totals.additions} deletions={totals.deletions} />
        <button
          type="button"
          onClick={onOpenChanges}
          className="ml-auto text-[11.5px] text-[#2563eb] transition-opacity hover:opacity-80"
        >
          Review changes
        </button>
      </div>
      <div className="flex flex-col pb-0.5">
        {diffs.map((diff) => {
          const path = stripFilePrefix(diff.file);
          return (
            <button
              key={diff.file}
              type="button"
              onClick={() => onOpenFile(path)}
              title={path}
              className="grid h-[22px] grid-cols-[minmax(0,1fr)_auto] items-center gap-2 px-2.5 text-left transition-colors hover:bg-[#EEEEEC]"
            >
              <span className="cc-mono truncate text-[11.5px] text-[#5F6368]">{path}</span>
              <DiffCounters additions={diff.additions} deletions={diff.deletions} />
            </button>
          );
        })}
      </div>
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
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(true);

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const onScroll = () => {
      pinnedRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
    };
    node.addEventListener("scroll", onScroll, { passive: true });
    return () => node.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    const node = scrollRef.current;
    if (node && pinnedRef.current) node.scrollTop = node.scrollHeight;
  });

  const showCompletion = state.runState === "complete" && state.diffs.length > 0;
  const hasActiveTool = Object.values(state.actions).some(
    (action) => action.status === "active" || action.status === "queued",
  );
  const hasOpenReasoning = state.log.some(
    (entry) => entry.type === "reasoning" && !entry.endedAt,
  );
  const showThinking = running && !!state.runStartedAt && !hasActiveTool && !hasOpenReasoning;

  return (
    <div ref={scrollRef} className="cc-scroll min-h-0 flex-1 overflow-y-auto px-4 pb-3 pt-2 sm:px-5">
      <div className="mx-auto flex max-w-[620px] flex-col">
        {state.log.map((entry, index) => {
          const prev = state.log[index - 1];
          const nextKindGap =
            prev &&
            ((prev.type === "action" && entry.type === "assistant") ||
              (prev.type === "assistant" && entry.type === "action") ||
              (prev.type === "user" && entry.type !== "user"));

          if (entry.type === "user") {
            return (
              <div key={entry.id} className="mb-3 mt-2 flex w-full justify-end">
                <div
                  data-invert-ignore="true"
                  className="cc-user-prompt max-w-[min(100%,480px)] whitespace-pre-wrap px-3 py-2.5 text-[12.5px] leading-[1.5] tracking-[-0.01em] text-[#171717]"
                >
                  {entry.text}
                </div>
              </div>
            );
          }
          if (entry.type === "assistant") {
            return (
              <div
                key={entry.id}
                className={cn(
                  "text-[12.5px] font-normal leading-[1.5] tracking-[-0.012em] text-[#171717]",
                  "[&_p]:my-[8px] [&_ul]:my-[8px] [&_ol]:my-[8px] [&_li]:my-[3px] [&_pre]:my-2 [&_code]:text-[11.5px]",
                  "[&_strong]:font-semibold",
                  nextKindGap ? "mt-3" : "mt-1.5",
                )}
              >
                <MarkdownMessageContent content={entry.text} />
              </div>
            );
          }
          if (entry.type === "reasoning") {
            return (
              <div key={entry.id} className={cn(nextKindGap ? "mt-2.5" : "mt-0.5")}>
                <ThoughtSummary entry={entry} />
              </div>
            );
          }
          const action = state.actions[entry.actionId];
          if (!action) return null;
          return (
            <div key={entry.id} className={cn(prev?.type === "action" ? "mt-[5px]" : nextKindGap ? "mt-3" : "mt-1")}>
              <AgentActionRow
                action={action}
                onReplyPermission={onReplyPermission}
                onRetry={onRetry}
                onOpenTerminal={onOpenTerminal}
                onOpenFile={onOpenFile}
              />
            </div>
          );
        })}

        <AnimatePresence>
          {showThinking ? (
            <motion.div
              key="thinking-gap"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
              className="mt-1.5 overflow-hidden"
            >
              <ThinkingIndicator startedAt={state.runStartedAt!} onStop={onCancel} />
            </motion.div>
          ) : null}
        </AnimatePresence>

        {state.runState === "failed" && state.error ? (
          <div className="mt-2 text-[12px] leading-[1.45]">
            <span className="font-medium text-[color:var(--deletion-red)]">Failed</span>{" "}
            <span className="text-[#5F6368]">{state.error}</span>
          </div>
        ) : null}

        {state.runState === "cancelled" ? (
          <div className="mt-2 text-[11.5px] text-[#8A8A8A]">Cancelled by user</div>
        ) : null}

        {showCompletion ? (
          <CompletionSummary
            diffs={state.diffs}
            onOpenChanges={onOpenChanges}
            onOpenFile={onOpenFile}
          />
        ) : null}
      </div>
    </div>
  );
}
