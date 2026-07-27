import type { ReactNode } from "react";
import { ChatWorkspaceHeader } from "./ChatWorkspaceHeader";
import type { ChatSyncStatus } from "./types";

export function ChatWorkspace({
  syncStatus,
  sidebarOpen,
  onToggleSidebar,
  onNewChat,
  children,
}: {
  syncStatus: ChatSyncStatus;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  onNewChat: () => void;
  children: ReactNode;
}) {
  return (
    <div className="relative flex h-full min-h-0 w-full flex-col bg-white">
      <ChatWorkspaceHeader
        syncStatus={syncStatus}
        sidebarOpen={sidebarOpen}
        onToggleSidebar={onToggleSidebar}
        onNewChat={onNewChat}
      />
      <div className="relative flex min-h-0 flex-1 flex-col">{children}</div>
    </div>
  );
}
