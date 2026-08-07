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
  return <span className="cc-counter text-[11px] tabular-nums text-[color:var(--text-tertiary)]">{seconds}s</span>;
}

/** Existing Clyra thinking shimmer — no spinners/dots. */
export function ThinkingIndicator({
  startedAt,
  onStop,
}: {
  startedAt: number;
  onStop?: () => void;
}) {
  return (
    <div className="flex items-center gap-2 py-1">
      <ShiningBrainIcon className="h-3.5 w-3.5" />
      <ShiningText text="Thinking" play className="text-[12.5px] font-medium tracking-[-0.01em]" />
      <ElapsedSeconds since={startedAt} />
      {onStop ? (
        <button
          type="button"
          onClick={onStop}
          className="ml-0.5 h-6 rounded-[8px] px-2 text-[11.5px] font-medium text-[color:var(--text-secondary)] transition-colors hover:bg-[color:var(--surface-hover)] active:bg-[color:var(--surface-selected)]"
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
          transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
          className="overflow-hidden"
        >
          <ThinkingIndicator startedAt={entry.ts} />
        </motion.div>
      ) : (
        <motion.div
          key={`${entry.id}-done`}
          initial={{ opacity: 0, y: -2 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
          className="py-1 text-[12px] font-medium tracking-[-0.01em] text-[color:var(--text-tertiary)]"
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
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
      className="mt-4 border-t border-[color:var(--border-subtle)] pt-3"
    >
      <div className="flex items-center gap-2 text-[12.5px]">
        <span className="font-medium text-[color:var(--text-primary)]">
          {diffs.length} file{diffs.length === 1 ? "" : "s"} changed
        </span>
        <DiffCounters additions={totals.additions} deletions={totals.deletions} />
        <button
          type="button"
          onClick={onOpenChanges}
          className="ml-auto h-6 rounded-[8px] px-2 text-[11.5px] font-medium text-[color:var(--accent-blue)] transition-colors hover:bg-[color:var(--surface-hover)]"
        >
          Review changes
        </button>
      </div>
      <div className="mt-1 flex flex-col">
        {diffs.map((diff) => {
          const path = stripFilePrefix(diff.file);
          return (
            <button
              key={diff.file}
              type="button"
              onClick={() => onOpenFile(path)}
              title={path}
              className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-[8px] px-1.5 py-1 text-left transition-colors hover:bg-[color:var(--surface-hover)]"
            >
              <span className="cc-mono truncate text-[11.5px] text-[color:var(--text-secondary)]">
                {path}
              </span>
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
  // Waiting gap between tools — never while a tool or open reasoning row is active.
  const showThinking = running && !!state.runStartedAt && !hasActiveTool && !hasOpenReasoning;

  return (
    <div ref={scrollRef} className="cc-scroll min-h-0 flex-1 overflow-y-auto px-4 pb-4 pt-3 sm:px-6">
      <div className="mx-auto flex max-w-[640px] flex-col gap-0.5">
        {state.log.map((entry) => {
          if (entry.type === "user") {
            return (
              <div key={entry.id} className="my-3 flex w-full justify-end">
                {/* Subtle rounded surface only — not a chat bubble / card */}
                <div
                  data-invert-ignore="true"
                  className="cc-user-prompt max-w-[min(100%,520px)] whitespace-pre-wrap px-3 py-2.5 text-[13.5px] leading-[1.55] tracking-[-0.01em] text-[color:var(--text-primary)]"
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
                  "my-2 text-[13.5px] font-normal leading-[1.6] tracking-[-0.015em] text-[color:var(--text-primary)]",
                  "[&_p]:my-2 [&_ul]:my-2 [&_ol]:my-2 [&_li]:my-1 [&_pre]:my-2.5 [&_code]:text-[12.5px]",
                )}
              >
                <MarkdownMessageContent content={entry.text} />
              </div>
            );
          }
          if (entry.type === "reasoning") {
            return <ThoughtSummary key={entry.id} entry={entry} />;
          }
          const action = state.actions[entry.actionId];
          if (!action) return null;
          return (
            <AgentActionRow
              key={entry.id}
              action={action}
              onReplyPermission={onReplyPermission}
              onRetry={onRetry}
              onOpenTerminal={onOpenTerminal}
              onOpenFile={onOpenFile}
            />
          );
        })}

        <AnimatePresence>
          {showThinking ? (
            <motion.div
              key="thinking-gap"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
              className="overflow-hidden"
            >
              <ThinkingIndicator startedAt={state.runStartedAt!} onStop={onCancel} />
            </motion.div>
          ) : null}
        </AnimatePresence>

        {state.runState === "failed" && state.error ? (
          <div className="my-2 text-[12.5px] leading-[1.5]">
            <span className="font-medium text-[color:var(--deletion-red)]">Failed</span>{" "}
            <span className="text-[color:var(--text-secondary)]">{state.error}</span>
          </div>
        ) : null}

        {state.runState === "cancelled" ? (
          <div className="my-2 text-[12.5px] text-[color:var(--text-tertiary)]">
            Cancelled by user
          </div>
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
