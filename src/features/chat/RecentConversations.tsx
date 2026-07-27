import { ChevronRight } from "lucide-react";
import { RecentConversationRow } from "./RecentConversationRow";
import type { RecentChatItem } from "./types";

export function RecentConversations({
  chats,
  onOpenChat,
  onViewAll,
}: {
  chats: RecentChatItem[];
  onOpenChat: (id: string) => void;
  onViewAll: () => void;
}) {
  return (
    <section className="mt-10 w-full" aria-label="Recent conversations">
      <div className="mb-2 flex items-center justify-between gap-3 px-1">
        <h2 className="text-[14px] font-semibold tracking-[-0.01em] text-slate-800">
          Recent conversations
        </h2>
        <button
          type="button"
          onClick={onViewAll}
          className="inline-flex items-center gap-0.5 rounded-lg px-1.5 py-1 text-[12.5px] font-medium text-slate-500 transition-colors hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30"
        >
          View all
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
      </div>

      {chats.length === 0 ? (
        <div className="flex h-[60px] flex-col justify-center border-b border-slate-200/70 px-1">
          <p className="text-[13.5px] font-medium text-slate-700">No conversations yet</p>
          <p className="mt-0.5 text-[12.5px] text-slate-500">
            Your recent chats will appear here.
          </p>
        </div>
      ) : (
        <div>
          {chats.map((chat) => (
            <RecentConversationRow key={chat.id} chat={chat} onOpen={onOpenChat} />
          ))}
        </div>
      )}
    </section>
  );
}
