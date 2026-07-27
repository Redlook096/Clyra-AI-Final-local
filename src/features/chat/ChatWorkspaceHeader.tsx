import {
  MessageCircleDashed,
  MoreHorizontal,
  PanelLeft,
  SquarePen,
} from "lucide-react";
import { cn } from "../../lib/utils";
import type { ChatSyncStatus } from "./types";

const SYNC_LABEL: Record<ChatSyncStatus, string> = {
  saving: "Saving",
  synced: "Synced",
  "saved-locally": "Saved locally",
  offline: "Offline",
  "save-failed": "Save failed",
};

export function ChatWorkspaceHeader({
  syncStatus,
  sidebarOpen,
  onToggleSidebar,
  onNewChat,
}: {
  syncStatus: ChatSyncStatus;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  onNewChat: () => void;
}) {
  const syncTone =
    syncStatus === "save-failed"
      ? "text-rose-600"
      : syncStatus === "offline"
        ? "text-amber-600"
        : syncStatus === "saving"
          ? "text-slate-500"
          : syncStatus === "synced"
            ? "text-emerald-600"
            : "text-slate-500";

  return (
    <header className="relative z-20 flex h-12 shrink-0 items-center gap-2 border-b border-slate-200/80 bg-white px-3 sm:px-4">
      {!sidebarOpen ? (
        <button
          type="button"
          onClick={onToggleSidebar}
          aria-label="Open sidebar"
          title="Open sidebar"
          className="grid h-9 w-9 place-items-center rounded-lg text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30"
        >
          <PanelLeft className="h-4 w-4" />
        </button>
      ) : null}

      <div className="flex min-w-0 items-center gap-2">
        <MessageCircleDashed className="h-4 w-4 shrink-0 text-slate-500" />
        <h1 className="truncate text-[15px] font-semibold tracking-[-0.01em] text-slate-800">
          Chat
        </h1>
      </div>

      <span
        className={cn(
          "ml-1 truncate rounded-md px-1.5 py-0.5 text-[11.5px] font-medium",
          syncTone,
        )}
        aria-live="polite"
      >
        {SYNC_LABEL[syncStatus]}
      </span>

      <div className="ml-auto flex items-center gap-1">
        <button
          type="button"
          onClick={onNewChat}
          aria-label="New chat"
          title="New chat"
          className="inline-flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-[12.5px] font-semibold text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30"
        >
          <SquarePen className="h-3.5 w-3.5" />
          New Chat
        </button>
        <button
          type="button"
          aria-label="Chat options"
          title="Chat options"
          className="grid h-9 w-9 place-items-center rounded-lg text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30"
        >
          <MoreHorizontal className="h-4 w-4" />
        </button>
      </div>
    </header>
  );
}
