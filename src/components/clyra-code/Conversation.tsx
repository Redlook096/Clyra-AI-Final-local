import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import { cn } from "../../lib/utils";
import { MarkdownMessageContent } from "../MarkdownMessageContent";
import { ShiningBrainIcon, ShiningText, ThinkingDots } from "../ShiningText";
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
  return <span className="cc-counter text-[11px] text-[color:var(--text-tertiary)]">{seconds}s</span>;
}

/** Existing Clyra thinking treatment, rendered inline in the work log. */
export function ThinkingIndicator({
  startedAt,
  onStop,
}: {
  startedAt: number;
  onStop: () => void;
}) {
  return (
    <div className="flex items-center gap-2 py-2">
      <ShiningBrainIcon className="h-4 w-4" />
      <ShiningText text="Thinking" play className="text-[14px] font-medium tracking-[-0.01em]" />
      <ThinkingDots />
      <ElapsedSeconds since={startedAt} />
      <button
        type="button"
        onClick={onStop}
        className="ml-1 rounded-[8px] border border-[color:var(--border-medium)] px-2.5 py-[3px] text-[11.5px] font-medium text-[color:var(--text-secondary)] transition-colors hover:bg-[color:var(--surface-hover)]"
      >
        Stop
      </button>
    </div>
  );
}

function ThoughtSummary({ entry }: { entry: Extract<LogEntry, { type: "reasoning" }> }) {
  if (!entry.endedAt) return null;
  const seconds = Math.max(1, Math.round((entry.endedAt - entry.ts) / 1000));
  return (
    <div className="py-[2px] text-[12px] text-[color:var(--text-tertiary)]">
      Thought for {seconds}s
    </div>
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
      transition={{ duration: 0.2, ease: "easeOut" }}
      className="mt-3 rounded-[10px] bg-[color:var(--surface-muted)] px-3.5 py-2.5"
    >
      <div className="flex items-center gap-2 text-[12.5px]">
        <span className="font-semibold text-[color:var(--text-primary)]">
          {diffs.length} file{diffs.length === 1 ? "" : "s"} changed
        </span>
        <DiffCounters additions={totals.additions} deletions={totals.deletions} />
        <button
          type="button"
          onClick={onOpenChanges}
          className="ml-auto rounded-[7px] px-2 py-[2px] text-[11.5px] font-medium text-[color:var(--accent-blue)] transition-colors hover:bg-[color:var(--surface-hover)]"
        >
          Review changes
        </button>
      </div>
      <div className="mt-1.5 flex flex-col">
        {diffs.map((diff) => {
          const path = stripFilePrefix(diff.file);
          return (
            <button
              key={diff.file}
              type="button"
              onClick={() => onOpenFile(path)}
              title={path}
              className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-[6px] px-1.5 py-[3px] text-left transition-colors hover:bg-[color:var(--surface-hover)]"
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

  return (
    <div ref={scrollRef} className="cc-scroll min-h-0 flex-1 overflow-y-auto px-6 pb-5 pt-4">
      <div className="mx-auto flex max-w-[680px] flex-col">
        {state.log.map((entry) => {
          if (entry.type === "user") {
            return (
              <div key={entry.id} className="my-3 flex justify-end">
                <div className="max-w-[82%] rounded-[14px] bg-[color:var(--surface-muted)] px-3.5 py-2.5 text-[14px] leading-[1.55] tracking-[-0.01em] text-[color:var(--text-primary)]">
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
                  "my-2 text-[14px] leading-[1.65] tracking-[-0.011em] text-[color:var(--text-primary)]",
                  "[&_p]:my-2 [&_ul]:my-2 [&_ol]:my-2 [&_pre]:my-2.5 [&_code]:text-[12.5px]",
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
          if (action.kind === "todo") return null;
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

        {running && state.runStartedAt ? (
          <ThinkingIndicator startedAt={state.runStartedAt} onStop={onCancel} />
        ) : null}

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
