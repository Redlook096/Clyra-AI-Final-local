import { AnimatePresence, motion } from "framer-motion";
import { Loader2, Server } from "lucide-react";
import type { PreviewStatus } from "../../../../types/vibe-preview";

const copy: Partial<Record<PreviewStatus, { title: string; detail: string }>> = {
  starting: { title: "Starting preview", detail: "Booting the development server…" },
  installing: { title: "Installing dependencies", detail: "Preparing packages…" },
  compiling: { title: "Compiling", detail: "Building the project…" },
  running: { title: "Connecting", detail: "Waiting for preview…" },
  refreshing: { title: "Refreshing", detail: "Reloading live page…" },
  restarting: { title: "Restarting", detail: "Recycling server…" },
  runtime_error: { title: "Preview unavailable", detail: "Check the terminal for errors." },
  build_failed: { title: "Compiling", detail: "Building the project…" },
  server_crashed: { title: "Restarting", detail: "Reconnecting to server…" },
  stopped: { title: "Preview stopped", detail: "Start the server to continue." },
};

export function PreviewStatusOverlay({ status }: { status?: PreviewStatus }) {
  const message = status ? copy[status] : undefined;
  const visible = Boolean(message && status !== "ready");

  return (
    <AnimatePresence>
      {visible && message ? (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          className="absolute inset-0 z-20 grid place-items-center bg-white/90"
          role="status"
          aria-live="polite"
        >
          <motion.div
            initial={{ y: 6, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 4, opacity: 0 }}
            transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
            className="mx-4 flex flex-col items-center gap-3 text-center"
          >
            <div className="grid h-8 w-8 place-items-center rounded-full">
              <Loader2 className="h-4 w-4 animate-spin text-[#737373]" />
            </div>
            <div>
              <p className="text-[13px] font-medium text-[#202020]">{message.title}</p>
              <p className="mt-0.5 text-[12px] text-[#999]">{message.detail}</p>
            </div>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
