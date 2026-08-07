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
  list: { active: "Explored", done: "Explored", failed: "Failed exploring" },
  command: { active: "Running", done: "Ran", failed: "Failed" },
  check: { active: "Checking", done: "Checked", failed: "Failed checking" },
  test: { active: "Testing", done: "Tested", failed: "Failed testing" },
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
  const isMonoTarget = /^(command|check|test|edit|create|delete|read|list)$/.test(action.kind);
  const hasDetails = Boolean(action.output?.trim() || action.error?.trim());
  const duration = action.endedAt && action.startedAt ? action.endedAt - action.startedAt : null;

  if (action.kind === "permission") {
    return (
      <div className="flex h-5 items-center gap-1.5 text-[12px]">
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
                  "rounded-[6px] border border-[#EEEEEC] px-1.5 py-px text-[10.5px] transition-colors hover:bg-[#F6F6F5]",
                  response === "deny" ? "text-[color:var(--deletion-red)]" : "text-[#171717]",
                )}
              >
                {response === "allow" ? "Allow" : response === "always" ? "Always" : "Deny"}
              </button>
            ))}
          </span>
        ) : action.permissionResolved ? (
          <span className="ml-auto text-[10.5px] text-[#8A8A8A]">{action.permissionResolved}</span>
        ) : null}
      </div>
    );
  }

  const commandExit =
    /^(command|check|test)$/.test(action.kind) && !isActive
      ? isError
        ? "exit 1"
        : "exit 0"
      : null;

  return (
    <motion.div
      layout
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.14, ease: [0.22, 1, 0.36, 1] }}
      className="group"
    >
      <div
        className={cn(
          "grid h-[22px] items-center gap-x-1.5 text-[12px] leading-none tracking-[-0.01em]",
          "grid-cols-[auto_minmax(0,1fr)_auto]",
          hasDetails && "cursor-pointer",
        )}
        onClick={hasDetails ? () => setExpanded((v) => !v) : undefined}
        role={hasDetails ? "button" : undefined}
      >
        <span
          className={cn(
            "shrink-0",
            isError
              ? "font-medium text-[color:var(--deletion-red)]"
              : isCancelled
                ? "text-[#8A8A8A]"
                : isActive
                  ? "font-medium text-[#2563eb]"
                  : "font-medium text-[#5F6368]",
          )}
        >
          {verb}
        </span>
        <span className="flex min-w-0 items-center gap-1.5">
          <ShimmerText
            text={action.target}
            active={isActive}
            tone={isActive && isFileAction ? "blue" : "neutral"}
            mono={isMonoTarget}
            className={cn(
              "text-[12px] tracking-[-0.01em]",
              !isActive && "text-[#5F6368]",
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
            />
          ) : null}
        </span>
        <span className="flex items-center gap-1.5 text-[10.5px] text-[#8A8A8A]">
          {commandExit ? (
            <span className={cn("cc-mono", isError && "text-[color:var(--deletion-red)]")}>
              {commandExit}
            </span>
          ) : null}
          {duration !== null && duration > 900 ? (
            <span className="cc-counter">{formatDuration(duration)}</span>
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

      {expanded && hasDetails ? (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: "auto" }}
          transition={{ duration: 0.14, ease: "easeOut" }}
          className="mb-1 overflow-hidden"
        >
          <pre className="cc-mono max-h-48 overflow-auto cc-scroll whitespace-pre-wrap rounded-[7px] bg-[#F7F7F6] px-2.5 py-2 text-[11px] leading-[1.45] text-[#5F6368]">
            {(action.error ? `${action.error}\n\n` : "") + (action.output ?? "")}
          </pre>
          {isError ? (
            <div className="mt-1 flex items-center gap-1.5">
              {onRetry ? (
                <button
                  type="button"
                  onClick={() => onRetry(action)}
                  className="rounded-[6px] border border-[#EEEEEC] px-2 py-[2px] text-[10.5px] text-[#171717] hover:bg-[#F6F6F5]"
                >
                  Ask agent to fix
                </button>
              ) : null}
              {onOpenTerminal && /^(command|check|test)$/.test(action.kind) ? (
                <button
                  type="button"
                  onClick={onOpenTerminal}
                  className="rounded-[6px] px-2 py-[2px] text-[10.5px] text-[#5F6368] hover:bg-[#F6F6F5]"
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
              className="mt-1 rounded-[6px] px-2 py-[2px] text-[10.5px] text-[#5F6368] hover:bg-[#F6F6F5]"
            >
              View diff
            </button>
          ) : null}
        </motion.div>
      ) : null}
    </motion.div>
  );
}
