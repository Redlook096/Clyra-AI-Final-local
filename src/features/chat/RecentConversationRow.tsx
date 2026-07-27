import { Code2, MessageCircleDashed, MoreHorizontal } from "lucide-react";
import { cn } from "../../lib/utils";
import type { RecentChatItem } from "./types";

function formatRowTime(updatedAt: number) {
  const elapsedMinutes = Math.max(0, Math.round((Date.now() - updatedAt) / 60_000));
  if (elapsedMinutes < 1) return "Just now";
  if (elapsedMinutes < 60) return `${elapsedMinutes}m ago`;
  const elapsedHours = Math.round(elapsedMinutes / 60);
  if (elapsedHours < 24) return `${elapsedHours}h ago`;
  const days = Math.round(elapsedHours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(updatedAt).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

export function RecentConversationRow({
  chat,
  onOpen,
}: {
  chat: RecentChatItem;
  onOpen: (id: string) => void;
}) {
  const Icon = chat.kind === "vibe" ? Code2 : MessageCircleDashed;

  return (
    <button
      type="button"
      onClick={() => onOpen(chat.id)}
      className={cn(
        "group flex h-[60px] w-full items-center gap-3 border-b border-slate-200/70 px-1 text-left transition-colors",
        "hover:bg-slate-50/90 focus-visible:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30",
      )}
    >
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-slate-100 text-slate-500">
        <Icon className="h-4 w-4" strokeWidth={1.9} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13.5px] font-semibold tracking-[-0.01em] text-slate-800">
          {chat.title || "New conversation"}
        </span>
        {chat.preview ? (
          <span className="mt-0.5 block truncate text-[12.5px] text-slate-500">
            {chat.preview}
          </span>
        ) : null}
      </span>
      <span className="shrink-0 text-[11.5px] text-slate-400 tabular-nums">
        {formatRowTime(chat.updatedAt)}
      </span>
      <span
        className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-slate-400 opacity-0 transition-opacity group-hover:opacity-100"
        aria-hidden
      >
        <MoreHorizontal className="h-4 w-4" />
      </span>
    </button>
  );
}
