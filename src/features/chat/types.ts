export type ChatSyncStatus =
  | "saving"
  | "synced"
  | "saved-locally"
  | "offline"
  | "save-failed";

export type RecentChatItem = {
  id: string;
  title: string;
  preview: string;
  updatedAt: number;
  kind?: "chat" | "vibe";
};
