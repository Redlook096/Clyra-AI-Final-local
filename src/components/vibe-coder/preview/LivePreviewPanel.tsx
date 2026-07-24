import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { TerminalSquare } from "lucide-react";
import type {
  PreviewLogLine,
  PreviewSession,
} from "../../../../types/vibe-preview";
import { cn } from "../../../lib/utils";
import { PreviewBrowserChrome } from "./PreviewBrowserChrome";
import { PreviewEmptyState } from "./PreviewEmptyState";
import { PreviewErrorOverlay } from "./PreviewErrorOverlay";
import { PreviewIframe } from "./PreviewIframe";
import { PreviewStatusOverlay } from "./PreviewStatusOverlay";
import { PreviewHealthStatus } from "./PreviewHealthStatus";

interface VibeProjectPreviewTarget {
  id: string;
  name: string;
  status: string;
}

async function previewRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Preview request failed: ${response.status}`);
  }
  return (await response.json()) as T;
}

function deviceWidth(_device: string) {
  return "100%";
}

function displayPreviewUrl(url: string) {
  return url.replace("http://127.0.0.1:", "http://localhost:");
}

export function LivePreviewPanel({
  project,
  className,
  onFixError,
}: {
  project: VibeProjectPreviewTarget | null;
  className?: string;
  onFixError?: (errMsg: string) => void;
}) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [session, setSession] = useState<PreviewSession | null>(null);
  const [logs, setLogs] = useState<PreviewLogLine[]>([]);
  const [address, setAddress] = useState("");
  const [showLogs, setShowLogs] = useState(false);
  const [customSrc, setCustomSrc] = useState("");
  const [isFullscreen, setIsFullscreen] = useState(false);

  const projectId = project?.id ?? "";

  const startPreview = useCallback(async () => {
    if (!projectId) return;
    setSession((prev) =>
      prev
        ? { ...prev, status: "starting" }
        : {
            projectId,
            projectPath: "",
            packageManager: "npm",
            devCommand: "",
            status: "starting",
          },
    );
    const data = await previewRequest<{ session: PreviewSession }>(
      "/api/vibe/preview/start",
      {
        method: "POST",
        body: JSON.stringify({ projectId }),
      },
    );
    setSession(data.session);
    if (data.session.url) {
      setAddress(displayPreviewUrl(data.session.url));
      setCustomSrc("");
    }
  }, [projectId]);

  const restartPreview = useCallback(async () => {
    if (!projectId) return;
    setSession((prev) => (prev ? { ...prev, status: "restarting" } : prev));
    const data = await previewRequest<{ session: PreviewSession }>(
      "/api/vibe/preview/restart",
      {
        method: "POST",
        body: JSON.stringify({ projectId }),
      },
    );
    setSession(data.session);
    if (data.session.url) {
      setAddress(displayPreviewUrl(data.session.url));
      setCustomSrc("");
    }
  }, [projectId]);

  const refreshPreview = useCallback(async () => {
    if (!projectId) return;
    if (iframeRef.current) {
      try {
        iframeRef.current.contentWindow?.location.reload();
      } catch {
        iframeRef.current.src = iframeRef.current.src;
      }
    }
    const data = await previewRequest<{ session: PreviewSession }>(
      "/api/vibe/preview/refresh",
      {
        method: "POST",
        body: JSON.stringify({ projectId }),
      },
    );
    if (data.session) setSession(data.session);
  }, [projectId]);

  useEffect(() => {
    if (!projectId) {
      setSession(null);
      setLogs([]);
      setAddress("");
      return;
    }
    void startPreview().catch((error) => {
      setSession({
        projectId,
        projectPath: "",
        packageManager: "npm",
        devCommand: "",
        status: "build_failed",
        lastError: {
          title: "Preview start failed",
          message: error instanceof Error ? error.message : "Could not start preview.",
        },
      });
    });
  }, [projectId, startPreview]);

  useEffect(() => {
    if (!projectId) return;
    const id = window.setInterval(async () => {
      try {
        const [statusData, logData] = await Promise.all([
          previewRequest<{ session: PreviewSession | null }>(
            `/api/vibe/preview/status/${projectId}`,
          ),
          previewRequest<{ logs: PreviewLogLine[] }>(
            `/api/vibe/preview/logs/${projectId}`,
          ),
        ]);
        if (statusData.session) {
          setSession(statusData.session);
          if (!customSrc && statusData.session.url) {
            setAddress(displayPreviewUrl(statusData.session.url));
          }
        }
        setLogs(logData.logs.slice(-120));
      } catch {
        // Keep the current UI stable while the app server is restarting.
      }
    }, 1400);
    return () => window.clearInterval(id);
  }, [customSrc, projectId]);

  const effectiveSrc = customSrc || session?.url || "";
  const canNavigate = Boolean(effectiveSrc);
  const activeTitle = useMemo(() => {
    if (!project) return "New tab";
    if (session?.status === "ready") return project.name;
    return session?.status ? session.status.replaceAll("_", " ") : project.name;
  }, [project, session?.status]);

  const navigate = (url: string) => {
    setCustomSrc(url === "about:blank" ? "" : url);
    setAddress(url === "about:blank" ? "" : url);
  };

  const openExternal = () => {
    if (!effectiveSrc) return;
    window.open(effectiveSrc, "_blank", "noopener,noreferrer");
  };

  const copyUrl = () => {
    if (!effectiveSrc) return;
    void navigator.clipboard?.writeText(displayPreviewUrl(effectiveSrc));
  };

  const error =
    session?.status === "runtime_error" ||
    session?.status === "build_failed" ||
    session?.status === "server_crashed"
      ? session.lastError
      : undefined;

  const reportedErrorRef = useRef<string | null>(null);

  useEffect(() => {
    if (!error || !onFixError) return;
    const signature = `${error.title}:${error.message}`;
    if (reportedErrorRef.current === signature) return;
    reportedErrorRef.current = signature;
    const errMsg = [error.title, error.filePath ? `${error.filePath}${error.line ? `:${error.line}` : ""}` : "", error.message]
      .filter(Boolean)
      .join("\n");
    onFixError(errMsg);
  }, [error, onFixError]);

  return (
    <motion.aside
      layout
      initial={{ opacity: 0, x: 60, scale: 0.97 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      exit={{ opacity: 0, x: 48, scale: 0.975 }}
      transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
      className={cn(
        "group flex min-w-0 flex-col overflow-hidden rounded-[16px] border border-slate-200/80 bg-white shadow-[0_12px_40px_rgba(15,23,42,0.06)]",
        !isFullscreen && "sticky top-0 h-[calc(100vh-6rem)] min-h-[580px]",
        isFullscreen &&
          "fixed inset-3 top-3 z-[240] h-auto min-h-0 rounded-[16px] shadow-[0_24px_70px_rgba(15,23,42,0.12)]",
        className,
      )}
    >
      <PreviewBrowserChrome
        title={activeTitle}
        address={address}
        canNavigate={canNavigate}
        onAddressChange={setAddress}
        onNavigate={navigate}
        onBack={() => {
          try {
            iframeRef.current?.contentWindow?.history.back();
          } catch {
            // Cross-origin pages may block iframe history access.
          }
        }}
        onForward={() => {
          try {
            iframeRef.current?.contentWindow?.history.forward();
          } catch {
            // Cross-origin pages may block iframe history access.
          }
        }}
        onRefresh={refreshPreview}
        onRestart={restartPreview}
        onOpenExternal={openExternal}
        onCopyUrl={copyUrl}
        isFullscreen={isFullscreen}
        onToggleFullscreen={() => setIsFullscreen((value) => !value)}
        statusLabel={
          session?.status && session.status !== "ready" && session.status !== "idle"
            ? session.status.replaceAll("_", " ")
            : undefined
        }
      />

      {/* Preview viewport — overflow-hidden so iframe never causes outer scroll */}
      <div className="relative min-h-0 flex-1 overflow-hidden bg-white">
        <PreviewHealthStatus status={session?.status === "runtime_error" ? "runtime_error" : session?.status === "server_crashed" ? "server_crashed" : session?.status === "ready" ? "ready" : "idle"} />
        <motion.div
          layout
          className="mx-auto h-full max-w-full overflow-hidden bg-white"
          style={{ width: deviceWidth("desktop") }}
          transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
        >
          {effectiveSrc && !error ? (
            <PreviewIframe
              ref={iframeRef}
              src={effectiveSrc}
              title={`${project?.name ?? "Vibe"} preview`}
            />
          ) : error ? (
            <PreviewStatusOverlay status="build_failed" />
          ) : (
            <PreviewEmptyState />
          )}
        </motion.div>
        <PreviewStatusOverlay status={error ? undefined : session?.status} />
        <PreviewErrorOverlay
          error={undefined}
          onRestart={restartPreview}
          onOpenLogs={() => setShowLogs(true)}
        />
      </div>

      <AnimatePresence>
        {showLogs && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 190, opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.26, ease: [0.22, 1, 0.36, 1] }}
            className="border-t border-slate-200/70 bg-slate-950 text-slate-200"
          >
            <div className="flex h-10 items-center justify-between px-4">
              <div className="flex items-center gap-2 text-[12px] font-bold">
                <TerminalSquare className="h-3.5 w-3.5" />
                Preview logs
              </div>
              <button
                type="button"
                onClick={() => setShowLogs(false)}
                className="rounded-full px-2 py-1 text-[11px] font-bold text-slate-400 transition hover:bg-white/10 hover:text-white"
              >
                Close
              </button>
            </div>
            <div className="scrollbar-none h-[150px] overflow-y-auto px-4 pb-3 font-mono text-[11px] leading-relaxed text-slate-300">
              {logs.length === 0 ? (
                <p className="text-slate-500">No logs yet.</p>
              ) : (
                logs.map((line) => (
                  <p
                    key={line.id}
                    className={cn(
                      "m-0 whitespace-pre-wrap",
                      line.level === "error" && "text-rose-200",
                      line.level === "warn" && "text-amber-200",
                    )}
                  >
                    {line.message}
                  </p>
                ))
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.aside>
  );
}
