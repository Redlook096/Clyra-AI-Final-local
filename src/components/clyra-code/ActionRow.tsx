import { memo, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ChevronRight } from "lucide-react";
import { cn } from "../../lib/utils";
import type { AgentAction } from "./store";
import { ShimmerText } from "./Shimmer";
import { DiffCounters } from "./AnimatedCounter";
import { AgentFileEdit, hasRenderableActionDiff } from "./AgentFileEdit";
import { AGENT_EASE, LABEL_MORPH, ROW_ENTER } from "./motion";

const VERBS: Record<string, { active: string; done: string; failed: string; min: string }> = {
  read: { active: "Reading", done: "Read", failed: "Failed reading", min: "0" },
  edit: { active: "Editing", done: "Edited", failed: "Failed editing", min: "0" },
  create: { active: "Editing", done: "Edited", failed: "Failed editing", min: "0" },
  delete: { active: "Deleting", done: "Deleted", failed: "Failed deleting", min: "0" },
  search: { active: "Searching", done: "Searched", failed: "Failed searching", min: "0" },
  research: { active: "Researching", done: "Researched", failed: "Research failed", min: "0" },
  list: { active: "Exploring", done: "Explored", failed: "Failed exploring", min: "0" },
  command: { active: "Running", done: "Ran", failed: "Failed", min: "0" },
  build: { active: "Building", done: "Built", failed: "Build failed", min: "0" },
  check: { active: "Checking", done: "Checked", failed: "Failed checking", min: "0" },
  test: { active: "Testing", done: "Tested", failed: "Failed testing", min: "0" },
  preview: { active: "Previewing", done: "Previewed", failed: "Preview failed", min: "0" },
  fetch: { active: "Fetching", done: "Fetched", failed: "Failed fetching", min: "0" },
  todo: { active: "Planning", done: "Planned", failed: "Failed planning", min: "0" },
  permission: { active: "Awaiting approval", done: "Approved", failed: "Denied", min: "0" },
  generic: { active: "Working on", done: "Completed", failed: "Failed", min: "0" },
};

function formatDuration(ms: number) {
  if (ms < 1000) return `${Math.max(0, Math.round(ms / 100) / 10)}s`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** Label that morphs in place (Running → Ran) instead of remounting the row. */
function MorphLabel({
  label,
  settled,
  className,
}: {
  label: string;
  settled?: boolean;
  className?: string;
}) {
  if (settled) return <span className={cn("inline-block", className)}>{label}</span>;
  return (
    <AnimatePresence mode="popLayout" initial={false}>
      <motion.span key={label} {...LABEL_MORPH} className={cn("inline-block", className)}>
        {label}
      </motion.span>
    </AnimatePresence>
  );
}

export const AgentActionRow = memo(function AgentActionRow({
  action,
  onReplyPermission,
  onRetry,
  onOpenTerminal,
  onOpenFile,
  revisiting = false,
  onEditClosed,
  settled = false,
}: {
  action: AgentAction;
  onReplyPermission?: (permissionId: string, response: "allow" | "always" | "deny") => void;
  onRetry?: (action: AgentAction) => void;
  onOpenTerminal?: () => void;
  onOpenFile?: (path: string) => void;
  /** A real read that follows an edit to the same file. */
  revisiting?: boolean;
  onEditClosed?: (id: string) => void;
  /** Render an expanded completed phase without replaying its animation. */
  settled?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const reduced = useReducedMotion();
  const verbs = VERBS[action.kind] ?? VERBS.generic;
  const isActive = action.status === "active" || action.status === "queued";
  const isError = action.status === "error";
  const isCancelled = action.status === "cancelled";

  // Historical rows (restored sessions / reopened tabs) render settled.
  const [historical] = useState(() => {
    if (settled) return true;
    if (isActive) return false;
    const ended = action.endedAt ?? action.startedAt;
    return Date.now() - ended > 4000;
  });
  const enterProps = reduced || historical ? {} : ROW_ENTER;
  const rowTransition =
    reduced || historical
      ? { layout: { duration: 0.28, ease: AGENT_EASE } }
      : { ...ROW_ENTER.transition, layout: { duration: 0.28, ease: AGENT_EASE } };

  const verb = revisiting && action.kind === "read"
    ? isActive
      ? "Revisiting"
      : isError
        ? verbs.failed
        : isCancelled
          ? "Cancelled"
          : "Revisited"
    : isActive ? verbs.active : isError ? verbs.failed : isCancelled ? "Cancelled" : verbs.done;
  // Never render an empty mini-diff shell. A normal action row is more honest
  // when OpenCode performed a file operation but did not provide changed text.
  const isStreamingEdit = /^(edit|create)$/.test(action.kind) && hasRenderableActionDiff(action);
  const isFileAction = /^(edit|create|delete)$/.test(action.kind);
  const isTerminalAction = /^(command|build|check|test|preview)$/.test(action.kind);
  const isMonoTarget = /^(command|build|check|test|preview|edit|create|delete|read|list)$/.test(action.kind);
  const hasDetails = Boolean(action.output?.trim() || action.error?.trim());
  const duration = action.endedAt && action.startedAt ? action.endedAt - action.startedAt : null;
  // A tool's completed transport state is not proof that its build or test
  // passed: shell pipelines can intentionally return zero after a failing
  // compiler. Only use a pass label when the real tool output proves it.
  const terminalEvidence = `${action.output ?? ""}\n${action.error ?? ""}`;
  const terminalPassConfirmed = /\b(?:exit(?:\s+code)?\s*[:=]?\s*0|tests?\s+passed|build\s+(?:passed|succeeded)|checks?\s+passed|typecheck\s+passed)\b/i.test(terminalEvidence);
  const terminalStatus = isTerminalAction
    ? isActive
      ? "Running"
      : isError
        ? "Failed"
        : isCancelled
          ? "Cancelled"
          : terminalPassConfirmed
            ? action.kind === "build"
              ? "Build passed"
              : action.kind === "test"
                ? "Tests passed"
                : action.kind === "check"
                  ? "Checks passed"
                  : "Completed"
            : action.kind === "preview"
              ? "Preview ready"
              : "Completed"
    : null;

  if (action.kind === "permission") {
    return (
      <motion.div {...enterProps} className="flex h-[26px] items-center gap-1.5 text-[12px]">
        <span className="font-medium text-[color:var(--warning-amber)]">
          {action.status === "active" ? "Approval needed" : "Approval"}
        </span>
        <ShimmerText text={action.target} active={action.status === "active"} className="min-w-0" />
        {action.status === "active" && action.permissionId && onReplyPermission ? (
          <span className="ml-auto flex items-center gap-1">
            {(["allow", "always", "deny"] as const).map((response) => (
              <button
                key={response}
                type="button"
                onClick={() => onReplyPermission(action.permissionId!, response)}
                className={cn(
                  "rounded-[6px] border border-black/[0.06] px-1.5 py-px text-[10.5px] transition-colors hover:bg-black/[0.035]",
                  response === "deny" ? "text-[#B94B4B]" : "text-[#202124]",
                )}
              >
                {response === "allow" ? "Allow" : response === "always" ? "Always" : "Deny"}
              </button>
            ))}
          </span>
        ) : action.permissionResolved ? (
          <span className="ml-auto text-[10.5px] text-[#96989D]">{action.permissionResolved}</span>
        ) : null}
      </motion.div>
    );
  }

  if (isStreamingEdit) {
    return <AgentFileEdit action={action} onOpenFile={onOpenFile} onClosed={onEditClosed} settled={settled} />;
  }

  const completionLabel =
    !isActive && !isError && !isCancelled
      && !isTerminalAction
      ? action.kind === "build"
        ? "Build passed"
        : action.kind === "test"
          ? "Tests passed"
          : action.kind === "check"
            ? "Checks passed"
            : action.kind === "preview"
              ? "Preview checked"
              : null
      : null;

  return (
    <motion.div
      {...enterProps}
      layout
      transition={rowTransition}
      className={cn("group", !isActive && !isError && "opacity-[0.8] transition-opacity duration-200")}
    >
      <div
        className={cn(
          "grid min-h-[26px] items-center gap-x-2 py-[2px] text-[13px] leading-[18px] tracking-[-0.01em]",
          "grid-cols-[max-content_minmax(0,1fr)_auto]",
          hasDetails && "cursor-pointer",
        )}
        onClick={
          isFileAction && onOpenFile && !isError
            ? () => onOpenFile(action.target)
            : hasDetails
              ? () => setExpanded((v) => !v)
              : undefined
        }
        role={isFileAction && onOpenFile && !isError ? "button" : hasDetails ? "button" : undefined}
        title={isFileAction && onOpenFile && !isError ? "Open file changes" : undefined}
      >
        <span
          className={cn(
            "flex shrink-0 items-center",
            isTerminalAction
              ? "cc-mono text-[#85878C]"
              : isError
              ? "font-medium text-[#B94B4B]"
              : isCancelled
                ? "text-[#96989D]"
                : isActive
                  ? "font-medium text-[#55575C]"
                  : "font-normal text-[#73757A]",
          )}
          // Compact command labels should sit next to their command, not in a
          // wide faux-table column. File/terminal details still truncate.
            style={{ minWidth: isTerminalAction ? undefined : verbs.min }}
        >
          {isTerminalAction ? <span aria-hidden>›</span> : <MorphLabel label={verb} settled={historical} />}
        </span>
        <span className="flex min-w-0 items-center gap-1.5">
          <ShimmerText
            text={action.target}
            active={isActive}
            tone={isActive && isFileAction ? "blue" : "neutral"}
            mono={isMonoTarget}
            className={cn(
              "text-[12.5px] tracking-normal",
              isTerminalAction && "font-normal text-[#404247]",
              !isActive && !isTerminalAction && "text-[#6D7076]",
            )}
          />
          {isFileAction ? (
            <DiffCounters
              additions={
                action.kind === "delete"
                  ? undefined
                  : action.additions !== undefined
                    ? action.additions
                    : action.kind === "create"
                      ? undefined
                      : 0
              }
              deletions={
                action.kind === "create"
                  ? undefined
                  : action.deletions !== undefined
                    ? action.deletions
                    : action.kind === "delete"
                      ? undefined
                      : 0
              }
              showZero={action.kind !== "create" && action.kind !== "delete"}
              animate={!historical}
              className="text-[11.5px] font-medium"
            />
          ) : null}
        </span>
        <span className="flex min-w-[4.5ch] items-center justify-end gap-1.5 text-[11px] text-[#8A8D92]">
          {terminalStatus ? (
            <span className={cn("whitespace-nowrap", isError && "text-[#B94B4B]", !isActive && !isError && !isCancelled && "text-[#65796A]")}>
              {isError ? "× " : !isActive && !isCancelled ? "✓ " : ""}
              {isActive ? <ShimmerText text={terminalStatus} active className="text-[11px]" /> : terminalStatus}
            </span>
          ) : null}
          {duration !== null && duration > 900 ? (
            <span className="cc-counter whitespace-nowrap tabular-nums">
              {formatDuration(duration)}
            </span>
          ) : null}
          {hasDetails ? (
            <ChevronRight
              className={cn(
                "h-3 w-3 text-[#B0B0B0] transition-colors duration-150 group-hover:text-[#5F6368]",
                expanded && "rotate-90",
              )}
            />
          ) : null}
        </span>
      </div>

      <AnimatePresence initial={false}>
        {completionLabel ? (
          <motion.div
            key="result"
            initial={historical ? { opacity: 1, y: 0 } : { opacity: 0, y: 3 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.18, ease: AGENT_EASE }}
            className="ml-[1px] pb-[2px] text-[13px] leading-5 text-[#65796A]"
          >
            ✓ {completionLabel}
          </motion.div>
        ) : null}
      </AnimatePresence>
      {isError && action.error ? (
        <div
          className={cn(
            "ml-[1px] max-w-[600px] pb-[2px] text-[13px] leading-5 text-[#8A8D92]",
            historical && "opacity-100",
          )}
        >
          <span className="mr-1 font-medium text-[#B94B4B]">×</span>
          {action.error}
        </div>
      ) : null}

      <AnimatePresence initial={false}>
        {expanded && hasDetails ? (
          <motion.div
            key="details"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{
              height: { duration: 0.24, ease: AGENT_EASE },
              opacity: { duration: 0.16 },
            }}
            className="mb-1 overflow-hidden"
          >
            <pre className="cc-mono max-h-48 overflow-auto cc-scroll whitespace-pre-wrap rounded-[7px] bg-[#F7F7F6] px-2.5 py-2 text-[10.75px] leading-[1.55] text-[#5F6368]">
              {(action.error ? `${action.error}\n\n` : "") + (action.output ?? "")}
            </pre>
            {isError ? (
              <div className="mt-1 flex items-center gap-1.5">
                {onRetry ? (
                  <button
                    type="button"
                    onClick={() => onRetry(action)}
                    className="rounded-[6px] border border-black/[0.06] px-2 py-[2px] text-[10.5px] text-[#202124] hover:bg-black/[0.035]"
                  >
                    Ask agent to fix
                  </button>
                ) : null}
                {onOpenTerminal && isTerminalAction ? (
                  <button
                    type="button"
                    onClick={onOpenTerminal}
                    className="rounded-[6px] px-2 py-[2px] text-[10.5px] text-[#5F6368] hover:bg-black/[0.035]"
                  >
                    Open terminal
                  </button>
                ) : null}
              </div>
            ) : null}
            {isFileAction && onOpenFile && !isError ? (
              <button
                type="button"
                onClick={() => onOpenFile(action.target)}
                className="mt-1 rounded-[6px] px-2 py-[2px] text-[10.5px] text-[#5F6368] hover:bg-black/[0.035]"
              >
                View diff
              </button>
            ) : null}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </motion.div>
  );
});
