import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowLeft,
  Check,
  ExternalLink,
  LoaderCircle,
  Monitor,
  MousePointer2,
  Play,
  RefreshCw,
  Send,
  Smartphone,
  Tablet,
} from "lucide-react";

type DesignTarget = "website" | "web-app" | "desktop-app" | "mobile-app";

type HealthState = {
  status: "checking" | "ready" | "offline";
  editorUrl: string;
  message?: string;
};

const targets: Array<{
  id: DesignTarget;
  label: string;
  icon: typeof Monitor;
}> = [
  { id: "web-app", label: "Web app", icon: Monitor },
  { id: "website", label: "Website", icon: ExternalLink },
  { id: "desktop-app", label: "Desktop", icon: Tablet },
  { id: "mobile-app", label: "Mobile", icon: Smartphone },
];

function compactStatus(input: string) {
  return input
    .replace(/[•`*_#<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 92);
}

export function OpenPencilWorkspace({
  initialPrompt,
  onClose,
  embedded = false,
  requestKey = 0,
  onUseDesign,
}: {
  initialPrompt?: string;
  onClose: () => void;
  embedded?: boolean;
  requestKey?: number;
  onUseDesign?: () => void;
}) {
  const [health, setHealth] = useState<HealthState>({
    status: "checking",
    editorUrl: "http://127.0.0.1:3100",
  });
  const [target, setTarget] = useState<DesignTarget>("desktop-app");
  const [prompt, setPrompt] = useState("");
  const [generation, setGeneration] = useState<
    "idle" | "generating" | "complete" | "error"
  >("idle");
  const [generationStatus, setGenerationStatus] = useState("Canvas ready");
  const [iframeReady, setIframeReady] = useState(false);
  const [canvasZoom, setCanvasZoom] = useState(1);
  const sentInitialRef = useRef("");
  const abortRef = useRef<AbortController | null>(null);

  const checkHealth = useCallback(async () => {
    setHealth((current) => ({ ...current, status: "checking" }));
    try {
      const response = await fetch("/api/openpencil/health");
      const data = await response.json();
      if (!response.ok || !data?.ok) {
        throw new Error(data?.error || "The design canvas is still starting");
      }
      setHealth({
        status: "ready",
        editorUrl: String(data.editorUrl || "http://127.0.0.1:3100"),
      });
    } catch (error) {
      setHealth({
        status: "offline",
        editorUrl: "http://127.0.0.1:3100",
        message:
          error instanceof Error ? error.message : "The design canvas is unavailable",
      });
    }
  }, []);

  useEffect(() => {
    void checkHealth();
    const timer = window.setInterval(() => {
      if (health.status !== "ready") void checkHealth();
    }, 2_500);
    return () => window.clearInterval(timer);
  }, [checkHealth, health.status]);

  const submitDesign = useCallback(
    async (request: string) => {
      const clean = request.replace(/^\/design\s*/i, "").trim();
      if (!clean || health.status !== "ready" || generation === "generating") return;

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setGeneration("generating");
      setGenerationStatus("Planning canvas structure");
      setCanvasZoom(0.88);

      try {
        const response = await fetch("/api/openpencil/design", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt: clean, target }),
          signal: controller.signal,
        });
        if (!response.ok || !response.body) {
          const detail = await response.text();
          throw new Error(detail || "Design generation failed");
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffered = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffered += decoder.decode(value, { stream: true });
          const lines = buffered.split("\n");
          buffered = lines.pop() || "";
          for (const line of lines) {
            if (!line.startsWith("data:")) continue;
            try {
              const event = JSON.parse(line.slice(5).trim());
              const status = compactStatus(String(event.thinking || event.delta || ""));
              if (status) setGenerationStatus(status);
              if (event.error) throw new Error(String(event.error));
              if (event.done) {
                setGeneration("complete");
                setGenerationStatus("Design applied to the live canvas");
                setCanvasZoom(1);
              }
            } catch (error) {
              if (error instanceof SyntaxError) continue;
              throw error;
            }
          }
        }
        setGeneration((current) => (current === "error" ? current : "complete"));
        setGenerationStatus((current) =>
          current === "Design applied to the live canvas"
            ? current
            : "Design applied to the live canvas",
        );
        setCanvasZoom(1);
        setPrompt("");
      } catch (error) {
        if (controller.signal.aborted) return;
        setGeneration("error");
        setGenerationStatus(
          error instanceof Error ? error.message : "Design generation failed",
        );
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
      }
    },
    [generation, health.status, target],
  );

  useEffect(() => {
    if (
      !initialPrompt ||
      sentInitialRef.current === `${requestKey}:${initialPrompt}` ||
      health.status !== "ready" ||
      !iframeReady
    ) {
      return;
    }
    sentInitialRef.current = `${requestKey}:${initialPrompt}`;
    void submitDesign(initialPrompt);
  }, [health.status, iframeReady, initialPrompt, requestKey, submitDesign]);

  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    [],
  );

  const statusIcon = useMemo(() => {
    if (generation === "generating") {
      return <LoaderCircle className="h-3.5 w-3.5 animate-spin" />;
    }
    if (generation === "complete") return <Check className="h-3.5 w-3.5" />;
    return <Play className="h-3.5 w-3.5" />;
  }, [generation]);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-[#f7f9fc] text-slate-950">
      {!embedded ? <header className="relative z-20 flex min-h-[58px] flex-wrap items-center gap-2 border-b border-slate-200/70 bg-white/88 px-3 py-2 backdrop-blur-xl sm:px-4">
        {!embedded ? (
          <>
            <button
              type="button"
              onClick={onClose}
              className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-slate-200 bg-white text-slate-500 transition-colors hover:border-slate-300 hover:text-slate-900"
              aria-label="Return to Vibe Coder"
            >
              <ArrowLeft className="h-4 w-4" />
            </button>

            <div className="min-w-0 shrink-0 pr-1">
              <p className="text-[12px] font-bold text-slate-900">Design canvas</p>
              <p className="text-[10px] font-medium text-slate-400">OpenPencil, connected to Clyra</p>
            </div>
          </>
        ) : null}

        <div className="flex min-w-0 flex-1 items-center justify-center">
          <div className="flex rounded-full border border-slate-200/80 bg-slate-100/70 p-1">
            {targets.map((item) => {
              const Icon = item.icon;
              const selected = target === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setTarget(item.id)}
                  className="relative flex h-7 items-center gap-1.5 rounded-full px-2.5 text-[10px] font-bold text-slate-500 transition-colors hover:text-slate-900"
                  aria-pressed={selected}
                >
                  {selected ? (
                    <motion.span
                      layoutId="openpencil-target"
                      className="absolute inset-0 rounded-full border border-slate-200 bg-white shadow-sm"
                      transition={{ type: "spring", stiffness: 560, damping: 42 }}
                    />
                  ) : null}
                  <Icon className="relative h-3.5 w-3.5" />
                  <span className="relative hidden lg:inline">{item.label}</span>
                </button>
              );
            })}
          </div>
        </div>

        {!embedded ? (
          <div className="flex min-w-[280px] flex-1 items-center gap-2 rounded-full border border-slate-200/80 bg-white px-2 py-1 shadow-[0_8px_30px_rgba(15,23,42,0.05)] sm:max-w-[540px]">
            <input
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void submitDesign(prompt);
                }
              }}
              placeholder="Describe a change to the live design"
              className="min-w-0 flex-1 bg-transparent px-2 text-[12px] font-medium text-slate-800 outline-none placeholder:text-slate-400"
            />
            <button
              type="button"
              onClick={() => void submitDesign(prompt)}
              disabled={!prompt.trim() || generation === "generating" || health.status !== "ready"}
              className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-slate-950 text-white transition-transform hover:scale-[1.04] disabled:cursor-not-allowed disabled:opacity-35"
              aria-label="Apply design prompt"
            >
              {generation === "generating" ? (
                <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Send className="h-3.5 w-3.5" />
              )}
            </button>
          </div>
        ) : null}

        {embedded && onUseDesign ? (
          <button
            type="button"
            onClick={onUseDesign}
            disabled={generation === "generating" || health.status !== "ready"}
            className="ml-auto flex h-8 items-center gap-1.5 rounded-xl bg-blue-600 px-3 text-[10px] font-bold text-white shadow-[0_8px_24px_rgba(37,99,235,.22)] transition-[background-color,transform] hover:bg-blue-700 active:scale-[.98] disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400 disabled:shadow-none"
          >
            <Check className="h-3.5 w-3.5" /> Use this design
          </button>
        ) : null}
      </header> : null}

      <div className="relative min-h-0 flex-1 overflow-hidden">
        {health.status === "ready" ? (
          <motion.div
            className="absolute inset-0 origin-center"
            animate={{ scale: canvasZoom }}
            transition={{ duration: 0.65, ease: [0.16, 1, 0.3, 1] }}
          >
            <motion.iframe
              title="OpenPencil design editor"
              src={health.editorUrl}
              onLoad={() => setIframeReady(true)}
              initial={{ opacity: 0, scale: 0.995 }}
              animate={{ opacity: iframeReady ? 1 : 0.25, scale: 1 }}
              transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
              className="absolute inset-0 h-full w-full border-0 bg-[#f7f9fc]"
              allow="clipboard-read; clipboard-write; fullscreen"
            />
          </motion.div>
        ) : (
          <div className="absolute inset-0 grid place-items-center px-6">
            <div className="w-full max-w-md text-center">
              <div className="mx-auto grid h-12 w-12 place-items-center rounded-2xl border border-slate-200 bg-white shadow-sm">
                {health.status === "checking" ? (
                  <LoaderCircle className="h-5 w-5 animate-spin text-blue-500" />
                ) : (
                  <RefreshCw className="h-5 w-5 text-slate-500" />
                )}
              </div>
              <h2 className="mt-4 text-[17px] font-bold tracking-normal text-slate-950">
                {health.status === "checking"
                  ? "Starting the design canvas"
                  : "Design canvas is offline"}
              </h2>
              <p className="mx-auto mt-2 max-w-sm text-[12px] font-medium leading-5 text-slate-500">
                {health.message ||
                  "OpenPencil is loading its local CanvasKit editor. Clyra remains available while it starts."}
              </p>
              {health.status === "offline" ? (
                <button
                  type="button"
                  onClick={() => void checkHealth()}
                  className="mt-4 rounded-full bg-slate-950 px-4 py-2 text-[11px] font-bold text-white"
                >
                  Check again
                </button>
              ) : null}
            </div>
          </div>
        )}

        <AnimatePresence>
          {health.status === "ready" && generation === "generating" ? (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="pointer-events-none absolute inset-0 z-10 overflow-hidden"
              aria-live="polite"
            >
              <motion.div
                className="absolute left-[14%] top-[22%] h-20 w-20 rounded-full border border-blue-300/60 bg-blue-400/10 shadow-[0_0_34px_rgba(59,130,246,.34)]"
                animate={{ left: ["14%", "66%", "38%", "14%"], top: ["22%", "38%", "68%", "22%"] }}
                transition={{ duration: 5.8, repeat: Infinity, ease: "easeInOut" }}
              >
                <motion.span
                  className="absolute -right-1 -top-1 grid h-6 w-6 place-items-center rounded-full bg-blue-600 text-white shadow-[0_6px_18px_rgba(37,99,235,.36)]"
                  animate={{ scale: [1, 1.08, 1] }}
                  transition={{ duration: 1.4, repeat: Infinity, ease: "easeInOut" }}
                >
                  <MousePointer2 className="h-3.5 w-3.5" />
                </motion.span>
              </motion.div>
              <motion.div
                className="absolute inset-x-0 h-px bg-gradient-to-r from-transparent via-blue-400/70 to-transparent"
                animate={{ top: ["8%", "92%", "8%"] }}
                transition={{ duration: 3.2, repeat: Infinity, ease: "easeInOut" }}
              />
              <div className="absolute left-4 top-4 rounded-full border border-blue-200/80 bg-white/90 px-3 py-1.5 text-[10px] font-semibold text-slate-600 shadow-sm backdrop-blur-md">
                <span className="mr-1.5 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-blue-500" />
                {generationStatus || "Working on the live design"}
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>

        <AnimatePresence>
          {health.status === "ready" && generation !== "idle" ? (
            <motion.div
              initial={{ opacity: 0, y: 12, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 8 }}
              transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
              className="pointer-events-none absolute bottom-5 left-1/2 flex max-w-[min(520px,calc(100%-32px))] -translate-x-1/2 items-center gap-2 rounded-full border border-white/80 bg-slate-950/88 px-4 py-2 text-[11px] font-semibold text-white shadow-[0_16px_50px_rgba(15,23,42,0.22)] backdrop-blur-xl"
            >
              <span className="text-blue-300">{statusIcon}</span>
              <span className="truncate">{generationStatus}</span>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
    </div>
  );
}
