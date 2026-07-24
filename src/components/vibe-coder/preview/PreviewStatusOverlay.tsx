import { AnimatePresence, motion } from "framer-motion";
import { Loader2, Server } from "lucide-react";
import type { PreviewStatus } from "../../../../types/vibe-preview";

const copy: Partial<Record<PreviewStatus, { title: string; detail: string }>> = {
  starting: { title: "Starting your preview", detail: "Booting the development server…" },
  installing: { title: "Installing dependencies", detail: "Preparing the project package graph…" },
  compiling: { title: "Compiling project", detail: "Building the first render…" },
  running: { title: "Connecting", detail: "Waiting for the preview URL…" },
  refreshing: { title: "Refreshing preview", detail: "Reloading the live page…" },
  restarting: { title: "Restarting preview", detail: "Recycling the development server…" },
  runtime_error: { title: "Runtime error", detail: "Open diagnostics to inspect the failure." },
  build_failed: { title: "Build failed", detail: "The project could not compile." },
  server_crashed: { title: "Server crashed", detail: "Restart the preview to continue." },
  stopped: { title: "Preview stopped", detail: "Start the development server to continue." },
};

export function PreviewStatusOverlay({ status }: { status?: PreviewStatus }) {
  const message = status ? copy[status] : undefined;
  const visible = Boolean(message && status !== "ready");
  const isError = status === "build_failed" || status === "runtime_error" || status === "server_crashed";

  return (
    <AnimatePresence>
      {visible && message ? (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          className="absolute inset-0 z-20 grid place-items-center bg-white/88"
          role="status"
          aria-live="polite"
        >
          <motion.div
            initial={{ y: 8, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 6, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
            className="mx-4 flex max-w-sm flex-col items-center gap-3 rounded-[16px] border border-slate-200/80 bg-white px-6 py-5 text-center shadow-[0_16px_40px_rgba(15,23,42,0.08)]"
          >
            <div className="relative grid h-10 w-10 place-items-center rounded-full bg-[#f8fafc] ring-1 ring-slate-200/80">
              {isError ? (
                <Server className="h-4 w-4 text-slate-500" />
              ) : (
                <Loader2 className="h-4 w-4 animate-spin text-slate-500" />
              )}
              {!isError ? (
                <span className="pointer-events-none absolute inset-0 rounded-full bg-gradient-to-r from-transparent via-white/50 to-transparent opacity-60 [animation:clyra-shimmer_1.8s_ease_infinite]" />
              ) : null}
            </div>
            <div>
              <p className="text-[14px] font-semibold tracking-[-0.01em] text-slate-900">{message.title}</p>
              <p className="mt-1 text-[12.5px] leading-snug text-slate-500">{message.detail}</p>
            </div>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
