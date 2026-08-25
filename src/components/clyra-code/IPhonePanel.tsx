import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, Maximize2, Minimize2, Play, RotateCw, Square } from "lucide-react";
import { cn } from "../../lib/utils";
import { ShiningText } from "../ShiningText";
import { api, type IPhoneDevice, type IPhoneStatus } from "./api";
import type { InspectPayload } from "./VisualInspector";
import { IPhoneSetupWizard } from "./IPhoneSetupWizard";

/**
 * The one iPhone panel. Talks only to /api/iphone/* (lib/iphone/iphone-routes.ts),
 * which talks only to IPhoneProvider (lib/iphone/SimctlProvider.ts today — a
 * real Xcode Simulator via xcrun simctl/xcodebuild, streamed and controlled
 * through serve-sim). No screenshot-in-a-frame mockup: the body is an iframe
 * onto serve-sim's own live preview page for the booted device.
 */
type Phase = "disconnected" | "connecting" | "pipeline" | "running" | "failed";

export function IPhonePanel({
  projectId,
  agentRunning,
  buildVersion,
  inspectMode,
  onToggleInspect,
  onInspectElement,
  fullscreen,
  onToggleFullscreen,
  onPreviewError,
}: {
  projectId: string | null;
  agentRunning: boolean;
  /** Bumps after each successful agent run — triggers a rebuild + relaunch. */
  buildVersion: number;
  inspectMode: boolean;
  onToggleInspect: () => void;
  onInspectElement: (payload: InspectPayload) => void;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
  onPreviewError?: (message: string) => void;
}) {
  const [status, setStatus] = useState<IPhoneStatus | null>(null);
  const [phase, setPhase] = useState<Phase>("connecting");
  const [pipelineLabel, setPipelineLabel] = useState("Booting Simulator…");
  const [streamUrl, setStreamUrl] = useState<string | null>(null);
  const [streamKind, setStreamKind] = useState<"iframe" | "img">("iframe");
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [deviceMenu, setDeviceMenu] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [frameKey, setFrameKey] = useState(0);
  const launchedForRef = useRef<string | null>(null);
  const rebuiltForRef = useRef(0);
  const reportedErrorRef = useRef<string | null>(null);
  const streamAreaRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api.iphoneStatus().then((result) => {
      if (cancelled) return;
      setStatus(result);
      setDeviceId((current) => current ?? result.booted?.udid ?? result.devices[0]?.udid ?? null);
      if (!result.mac || !result.xcodeVersion) setPhase("disconnected");
    }).catch(() => { if (!cancelled) setPhase("disconnected"); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (phase === "failed" && error && reportedErrorRef.current !== error) {
      reportedErrorRef.current = error;
      onPreviewError?.(error);
    }
  }, [error, onPreviewError, phase]);

  const run = useCallback(async () => {
    if (!projectId || !status?.mac || !status.xcodeVersion) return;
    setPhase("pipeline");
    setPipelineLabel("Booting Simulator…");
    setError(null);
    try {
      const timer = window.setTimeout(() => setPipelineLabel("Building for the Simulator…"), 900);
      const result = await api.iphoneRun(projectId, deviceId ?? undefined);
      window.clearTimeout(timer);
      if (!result.ok || !result.streamUrl) throw new Error(result.error ?? result.buildOutput?.slice(-800) ?? "The iPhone pipeline failed.");
      setStreamUrl(result.streamUrl);
      setStreamKind(result.streamKind ?? "iframe");
      if (result.deviceId) setDeviceId(result.deviceId);
      setFrameKey((value) => value + 1);
      setPhase("running");
    } catch (cause) {
      setPhase("failed");
      setError(cause instanceof Error ? cause.message : "The iPhone pipeline failed.");
    }
  }, [projectId, status, deviceId]);

  const handleSetupReady = useCallback(() => {
    launchedForRef.current = null;
    void run();
  }, [run]);

  const stop = useCallback(async () => {
    if (!projectId) return;
    await api.iphoneStop(projectId).catch(() => undefined);
    setStreamUrl(null);
    setPhase("disconnected");
    launchedForRef.current = null;
  }, [projectId]);

  // Auto-boot the pipeline once the project actually has Swift source, same
  // readiness-poll pattern the rest of the workspace's preview panes use.
  useEffect(() => {
    if (!projectId || !status?.mac || !status.xcodeVersion) return;
    if (agentRunning) return;
    if (launchedForRef.current === projectId) return;
    let cancelled = false;
    let retry: number | undefined;
    const checkReadiness = () => {
      void api.iphoneReadiness(projectId).then((readiness) => {
        if (cancelled) return;
        if (!readiness.ready) {
          retry = window.setTimeout(checkReadiness, 800);
          return;
        }
        launchedForRef.current = projectId;
        void run();
      }).catch(() => {
        if (!cancelled) retry = window.setTimeout(checkReadiness, 1200);
      });
    };
    checkReadiness();
    return () => { cancelled = true; if (retry !== undefined) window.clearTimeout(retry); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, status, agentRunning]);

  // Rebuild + relaunch (not a full reboot) after every successful agent run.
  useEffect(() => {
    if (!projectId || buildVersion === 0 || rebuiltForRef.current === buildVersion || phase !== "running") return;
    rebuiltForRef.current = buildVersion;
    setPhase("pipeline");
    setPipelineLabel("Rebuilding…");
    setError(null);
    api.iphoneRebuild(projectId)
      .then((result) => {
        if (!result.ok) throw new Error(result.error ?? "Rebuild failed.");
        setFrameKey((value) => value + 1);
        setPhase("running");
      })
      .catch((cause) => {
        setPhase("failed");
        setError(cause instanceof Error ? cause.message : "Rebuild failed.");
      });
  }, [buildVersion, projectId, phase]);

  const rotate = useCallback(() => {
    if (!projectId) return;
    void api.iphoneControl(projectId, { action: "rotate", orientation: "landscape" }).catch(() => undefined);
  }, [projectId]);

  const loading = agentRunning || phase === "connecting" || phase === "pipeline";
  const loadingTitle = phase === "pipeline" ? pipelineLabel : agentRunning ? "Building your iOS project…" : "Connecting to the Apple Host…";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-[40px] items-center gap-1 border-b border-[color:var(--border-subtle)] px-2.5">
        <div className="relative">
          <button
            type="button"
            onClick={() => setDeviceMenu((open) => !open)}
            disabled={!status?.devices.length}
            className="flex h-7 items-center gap-1 rounded-[7px] px-2 text-[11.5px] font-medium text-[#505258] transition-colors hover:bg-black/[0.03] disabled:opacity-50"
          >
            {status?.devices.find((d) => d.udid === deviceId)?.name ?? "iPhone"}
            <ChevronDown className={cn("h-3 w-3 text-[#96989D] transition-transform", deviceMenu && "rotate-180")} />
          </button>
          {deviceMenu && status?.devices.length ? (
            <div className="absolute left-0 top-[32px] z-30 max-h-64 w-[220px] overflow-y-auto rounded-[8px] border border-black/[0.06] bg-white py-0.5 shadow-[0_8px_20px_rgba(15,23,42,0.08)]">
              {status.devices.map((device: IPhoneDevice) => (
                <button
                  key={device.udid}
                  type="button"
                  onClick={() => { setDeviceId(device.udid); setDeviceMenu(false); launchedForRef.current = null; void run(); }}
                  className="flex w-full items-center justify-between px-2.5 py-[5px] text-left text-[11.5px] text-[#202124] transition-colors hover:bg-black/[0.03]"
                >
                  <span className="truncate">{device.name}</span>
                  <span className="ml-2 shrink-0 text-[10px] text-[#96989D]">{device.runtime}</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
        <span className="text-[10.5px] text-[#96989D]">{status?.xcodeVersion ? `Xcode ${status.xcodeVersion}` : ""}</span>
        <span className="flex-1" />
        {phase === "running" ? (
          <button type="button" aria-label="Stop" title="Stop" onClick={() => void stop()} className="rounded-[7px] p-1.5 text-[#93959A] transition-colors hover:bg-black/[0.03] hover:text-[#202124]"><Square className="h-[13px] w-[13px]" strokeWidth={1.8} /></button>
        ) : (
          <button type="button" aria-label="Run" title="Run" disabled={loading || !status?.mac || !status.xcodeVersion} onClick={() => { launchedForRef.current = null; void run(); }} className="rounded-[7px] p-1.5 text-[#93959A] transition-colors hover:bg-black/[0.03] hover:text-[#202124] disabled:opacity-40"><Play className="h-[13px] w-[13px]" strokeWidth={1.8} /></button>
        )}
        <button type="button" aria-label="Reload" title="Reload" onClick={() => { launchedForRef.current = null; void run(); }} className="rounded-[7px] p-1.5 text-[#93959A] transition-colors hover:bg-black/[0.03] hover:text-[#202124]"><RotateCw className="h-[13px] w-[13px]" strokeWidth={1.8} /></button>
        <button type="button" aria-label="Rotate" title="Rotate" onClick={rotate} className="rounded-[7px] p-1.5 text-[#93959A] transition-colors hover:bg-black/[0.03] hover:text-[#202124]"><RotateCw className="h-[13px] w-[13px] rotate-90" strokeWidth={1.8} /></button>
        <button type="button" aria-label={fullscreen ? "Exit full screen preview" : "Full screen preview"} title={fullscreen ? "Exit full screen" : "Full screen"} onClick={onToggleFullscreen} className="rounded-[7px] p-1.5 text-[#93959A] transition-colors hover:bg-black/[0.03] hover:text-[#202124]">{fullscreen ? <Minimize2 className="h-[13px] w-[13px]" strokeWidth={1.8} /> : <Maximize2 className="h-[13px] w-[13px]" strokeWidth={1.8} />}</button>
        <button type="button" onClick={onToggleInspect} className={cn("ml-1 flex h-7 items-center gap-1.5 rounded-[8px] px-2.5 text-[11.5px] transition-colors", inspectMode ? "bg-[#E8F0FE] font-medium text-[#3977F6]" : "font-medium text-[#505258] hover:bg-black/[0.03]")}>{inspectMode ? "✓ Editing" : "Commenting"}</button>
      </div>
      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-[#FAFAF9]">
        {streamUrl && phase === "running" ? (
          <div ref={streamAreaRef} className="absolute inset-0 flex items-center justify-center overflow-hidden">
            {streamKind === "iframe" ? (
              // serve-sim's own preview page owns the live framebuffer + HID
              // input (touch, keyboard, scroll) for the real booted
              // Simulator — this is not a screenshot, same-origin via the
              // proxy in lib/iphone/iphone-routes.ts.
              <iframe key={frameKey} src={streamUrl} title="iPhone Simulator" className="h-full w-full" allow="clipboard-read; clipboard-write" />
            ) : (
              // sim-use's raw MJPEG stream: a real <img> multipart stream,
              // not an interactive page, so this panel forwards touch/scroll/
              // keyboard itself via /api/iphone/projects/:id/control.
              <img
                key={frameKey}
                src={streamUrl}
                alt="iPhone Simulator"
                tabIndex={0}
                className="h-full max-h-full w-auto object-contain outline-none"
                onClick={(event) => {
                  if (!projectId) return;
                  const rect = event.currentTarget.getBoundingClientRect();
                  const x = (event.clientX - rect.left) / rect.width;
                  const y = (event.clientY - rect.top) / rect.height;
                  void api.iphoneControl(projectId, { action: "tap", x, y }).catch(() => undefined);
                }}
                onWheel={(event) => {
                  if (!projectId) return;
                  void api.iphoneControl(projectId, { action: "swipe", direction: event.deltaY > 0 ? "up" : "down" }).catch(() => undefined);
                }}
                onKeyDown={(event) => {
                  if (!projectId || event.metaKey || event.ctrlKey) return;
                  if (event.key === "Backspace" || event.key.length === 1) {
                    event.preventDefault();
                    void api.iphoneControl(projectId, { action: "type", text: event.key === "Backspace" ? "\b" : event.key }).catch(() => undefined);
                  }
                }}
              />
            )}
            {inspectMode ? (
              <button type="button" className="absolute inset-0 z-20 cursor-crosshair" aria-label="Reference simulator view" onClick={(event) => {
                const rect = streamAreaRef.current?.getBoundingClientRect();
                onInspectElement({ platform: "ios", kind: "SwiftUI view", label: "Simulator view", name: "view", x: Math.round(event.clientX - (rect?.left ?? 0)), y: Math.round(event.clientY - (rect?.top ?? 0)) });
              }}>
                <span className="pointer-events-none absolute left-3 top-3 rounded-[6px] bg-[#3977F6]/95 px-2 py-1 text-[10px] font-medium text-white">Click a view to reference it in chat</span>
              </button>
            ) : null}
          </div>
        ) : null}
        {loading ? (
          <div className="relative z-10 flex h-full w-full flex-col items-center justify-center gap-3.5 bg-[#FAFAF9]">
            <div className="cc-preview-loader" aria-hidden />
            <ShiningText text={loadingTitle} play className="max-w-[220px] text-center text-[12px] font-medium tracking-[-0.01em]" />
          </div>
        ) : phase === "failed" ? (
          <div className="flex max-w-[380px] flex-col items-center gap-2 text-center">
            <p className="text-[13px] font-medium text-[#3D3F43]">Simulator build failed</p>
            <p className="max-h-40 overflow-y-auto whitespace-pre-wrap text-[11px] leading-[1.5] text-[#94969A]">{error}</p>
            <button type="button" onClick={() => { launchedForRef.current = null; void run(); }} className="mt-1 h-7 rounded-[7px] border border-black/[0.08] px-2.5 text-[11.5px] text-[#202124] transition-colors hover:bg-black/[0.03]">Try again</button>
          </div>
        ) : phase === "disconnected" && status?.mac ? (
          <IPhoneSetupWizard projectId={projectId} onReady={handleSetupReady} />
        ) : phase === "disconnected" ? (
          <div className="flex w-full max-w-[360px] flex-col items-center gap-2.5 text-center">
            <p className="text-[13px] font-medium text-[#3D3F43]">Connect a Mac to run iOS apps</p>
            <p className="text-[11.5px] leading-[1.5] text-[#94969A]">The real iOS Simulator only runs on a Mac with Xcode. Pair one to control it from here.</p>
            {/* The pairing protocol (lib/iphone/remote/*) is implemented and
               tested end-to-end, but this button isn't wired to it yet in
               this pass — disabled rather than pretending to work. */}
            <button type="button" disabled title="Pairing UI not wired in this build yet" className="mt-1 h-8 cursor-not-allowed rounded-[8px] bg-[#3977F6]/40 px-4 text-[12px] font-medium text-white">Pair Mac</button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
