import { motion } from "motion/react";
import { RecentConversations } from "./RecentConversations";
import type { RecentChatItem } from "./types";

export function ChatWelcome({
  composerSlotRef,
  recentChats,
  onOpenChat,
  onViewAll,
  onNavigateWorkspace,
}: {
  composerSlotRef: (node: HTMLDivElement | null) => void;
  recentChats: RecentChatItem[];
  onOpenChat: (id: string) => void;
  onViewAll: () => void;
  onNavigateWorkspace: (workspace: "browser" | "vibe" | "study" | "clip") => void;
}) {
  return (
    <div className="clyra-chat-welcome relative flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden">
      <div className="clyra-chat-welcome__atmosphere" aria-hidden>
        <div className="clyra-chat-welcome__glow clyra-chat-welcome__glow--a" />
        <div className="clyra-chat-welcome__glow clyra-chat-welcome__glow--b" />
        <div className="clyra-chat-welcome__glow clyra-chat-welcome__glow--c" />
        <div className="clyra-chat-welcome__aurora" />
        <div className="clyra-chat-welcome__grid" />
      </div>

      <div className="relative z-[1] mx-auto flex w-full max-w-[840px] flex-col px-6 pb-12 pt-[132px] sm:px-8 sm:pt-[148px]">
        <motion.div
          className="flex flex-col items-center text-center"
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
        >
          <div className="clyra-chat-welcome__brand mb-5 flex items-center gap-2.5">
            <span className="clyra-chat-welcome__mark" aria-hidden>
              <span className="clyra-chat-welcome__mark-core">C</span>
            </span>
            <span className="text-[16px] font-semibold tracking-[-0.02em] text-slate-900">
              Clyra
            </span>
          </div>

          <h1 className="clyra-chat-welcome__title max-w-[640px] text-[34px] font-semibold leading-[1.12] tracking-[-0.035em] sm:text-[38px]">
            What can I help you with?
          </h1>

          <p className="mt-4 max-w-[560px] text-[14.5px] leading-relaxed text-slate-500">
            Ask a question, start a task, or continue work across{" "}
            <button
              type="button"
              onClick={() => onNavigateWorkspace("browser")}
              className="clyra-chat-welcome__link"
            >
              Browser
            </button>
            ,{" "}
            <button
              type="button"
              onClick={() => onNavigateWorkspace("vibe")}
              className="clyra-chat-welcome__link"
            >
              Vibe
            </button>
            ,{" "}
            <button
              type="button"
              onClick={() => onNavigateWorkspace("study")}
              className="clyra-chat-welcome__link"
            >
              Study
            </button>{" "}
            and{" "}
            <button
              type="button"
              onClick={() => onNavigateWorkspace("clip")}
              className="clyra-chat-welcome__link"
            >
              Create
            </button>
            .
          </p>
        </motion.div>

        <motion.div
          ref={composerSlotRef}
          className="relative mt-8 w-full min-h-[148px]"
          initial={{ opacity: 0, y: 18 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.08, ease: [0.22, 1, 0.36, 1] }}
        />

        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.55, delay: 0.16, ease: [0.22, 1, 0.36, 1] }}
        >
          <RecentConversations
            chats={recentChats}
            onOpenChat={onOpenChat}
            onViewAll={onViewAll}
          />
        </motion.div>
      </div>
    </div>
  );
}
