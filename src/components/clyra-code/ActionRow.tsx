import { useState } from "react";
import { motion } from "motion/react";
import { ChevronRight } from "lucide-react";
import { cn } from "../../lib/utils";
import type { AgentAction } from "./store";
import { ShimmerText } from "./Shimmer";
import { DiffCounters } from "./AnimatedCounter";

const VERBS: Record<string, { active: string; done: string; failed: string }> = {
  read: { active: "Reading", done: "Read", failed: "Failed reading" },
  edit: { active: "Editing", done: "Edited", failed: "Failed editing" },
  create: { active: "Creating", done: "Created", failed: "Failed creating" },
  delete: { active: "Deleting", done: "Deleted", failed: "Failed deleting" },
  search: { active: "Searching", done: "Searched", failed: "Failed searching" },
  list: { active: "Listing", done: "Listed", failed: "Failed listing" },
  command: { active: "Running", done: "Ran", failed: "Failed" },
  fetch: { active: "Fetching", done: "Fetched", failed: "Failed fetching" },
  todo: { active: "Planning", done: "Planned", failed: "Failed planning" },
  permission: { active: "Awaiting approval", done: "Approved", failed: "Denied" },
  generic: { active: "Working on", done: "Completed", failed: "Failed" },
};

function formatDuration(ms: number) {
  if (ms < 1000) return `${Math.max(0, Math.round(ms / 100) / 10)}s`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function AgentActionRow({
  action,
  onReplyPermission,
  onRetry,
  onOpenTerminal,
  onOpenFile,
}: {
  action: AgentAction;
  onReplyPermission?: (permissionId: string, response: "allow" | "always" | "deny") => void;
  onRetry?: (action: AgentAction) => void;
  onOpenTerminal?: () => void;
  onOpenFile?: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const verbs = VERBS[action.kind] ?? VERBS.generic;
  const isActive = action.status === "active" || action.status === "queued";
  const isError = action.status === "error";
  const isCancelled = action.status === "cancelled";
  const verb = isActive ? verbs.active : isError ? verbs.failed : isCancelled ? "Cancelled" : verbs.done;
  const isFileAction = /^(edit|create|delete)$/.test(action.kind);
  const isMonoTarget = /^(command|edit|create|delete|read|list)$/.test(action.kind);
  const hasDetails = Boolean(action.output?.trim() || action.error?.trim());
  const duration = action.endedAt && action.startedAt ? action.endedAt - action.startedAt : null;

  if (action.kind === "permission") {
    return (
      <div className="flex min-h-[26px] items-center gap-2 py-[2px] text-[12.5px]">
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
                  "rounded-[7px] border border-[color:var(--border-medium)] px-2 py-[2px] text-[11px] font-medium transition-colors hover:bg-[color:var(--surface-hover)]",
                  response === "deny"
                    ? "text-[color:var(--deletion-red)]"
                    : "text-[color:var(--text-primary)]",
                )}
              >
                {response === "allow" ? "Allow" : response === "always" ? "Always" : "Deny"}
              </button>
            ))}
          </span>
        ) : action.permissionResolved ? (
          <span className="ml-auto text-[11px] text-[color:var(--text-tertiary)]">
            {action.permissionResolved}
          </span>
        ) : null}
      </div>
    );
  }

  const commandExit = action.kind === "command" && !isActive
    ? isError
      ? "exit 1"
      : "exit 0"
    : null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 3 }}
      animate={{ opacity: action.status === "success" ? 0.92 : 1, y: 0 }}
      transition={{ duration: 0.18, ease: "easeOut" }}
      className="group"
    >
      <div
        className={cn(
          "grid min-h-[24px] items-center gap-x-1.5 py-[2px] text-[12.5px] leading-[1.45]",
          "grid-cols-[auto_minmax(0,1fr)_auto]",
          hasDetails && "cursor-pointer",
        )}
        onClick={hasDetails ? () => setExpanded((v) => !v) : undefined}
        role={hasDetails ? "button" : undefined}
      >
        <span
          className={cn(
            "font-medium",
            isError
              ? "text-[color:var(--deletion-red)]"
              : isCancelled
                ? "text-[color:var(--text-tertiary)]"
                : "text-[color:var(--accent-blue)]",
          )}
        >
          {verb}
        </span>
        <span className="flex min-w-0 items-center gap-1.5">
          <ShimmerText
            text={action.target}
            active={isActive}
            tone={isFileAction ? "blue" : "neutral"}
            mono={isMonoTarget}
            className={cn("text-[12.5px]", isFileAction && !isActive && "text-[#3a5b96]")}
          />
          {isFileAction ? (
            <DiffCounters
              additions={action.kind === "delete" ? undefined : action.additions ?? 0}
              deletions={action.kind === "create" ? undefined : action.deletions ?? 0}
              showZero={action.kind !== "create" && action.kind !== "delete"}
            />
          ) : null}
        </span>
        <span className="flex items-center gap-2 text-[11px] text-[color:var(--text-tertiary)]">
          {commandExit ? (
            <span className={cn("cc-mono", isError && "text-[color:var(--deletion-red)]")}>
              {commandExit}
            </span>
          ) : null}
          {duration !== null && duration > 900 ? <span>{formatDuration(duration)}</span> : null}
          {hasDetails ? (
            <ChevronRight
              className={cn(
                "h-3 w-3 text-[color:var(--text-disabled)] transition-transform duration-150",
                expanded && "rotate-90",
              )}
            />
          ) : null}
        </span>
      </div>

      {expanded && hasDetails ? (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: "auto" }}
          transition={{ duration: 0.16, ease: "easeOut" }}
          className="mb-1 overflow-hidden"
        >
          <pre className="cc-mono max-h-56 overflow-auto cc-scroll whitespace-pre-wrap rounded-[8px] bg-[color:var(--surface-muted)] px-3 py-2 text-[11.5px] leading-[1.5] text-[color:var(--text-secondary)]">
            {(action.error ? `${action.error}\n\n` : "") + (action.output ?? "")}
          </pre>
          {isError ? (
            <div className="mt-1 flex items-center gap-2">
              {onRetry ? (
                <button
                  type="button"
                  onClick={() => onRetry(action)}
                  className="rounded-[7px] border border-[color:var(--border-medium)] px-2 py-[3px] text-[11px] font-medium text-[color:var(--text-primary)] hover:bg-[color:var(--surface-hover)]"
                >
                  Ask agent to fix
                </button>
              ) : null}
              {onOpenTerminal && action.kind === "command" ? (
                <button
                  type="button"
                  onClick={onOpenTerminal}
                  className="rounded-[7px] border border-[color:var(--border-medium)] px-2 py-[3px] text-[11px] font-medium text-[color:var(--text-secondary)] hover:bg-[color:var(--surface-hover)]"
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
              className="mt-1 rounded-[7px] border border-[color:var(--border-medium)] px-2 py-[3px] text-[11px] font-medium text-[color:var(--text-secondary)] hover:bg-[color:var(--surface-hover)]"
            >
              View diff
            </button>
          ) : null}
        </motion.div>
      ) : null}
    </motion.div>
  );
}
