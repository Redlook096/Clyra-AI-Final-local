import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { AnimatePresence, motion } from "motion/react";
import { createPortal } from "react-dom";
import {
  ArrowUpIcon,
  MessageSquareText,
  Mic,
  MicOff,
  MonitorUp,
  Pencil,
  PhoneOff,
  Sparkles,
  Video,
  VideoOff,
  X,
} from "lucide-react";
import { AiOrb, type OrbColorTheme } from "../AiOrb";
import { cn } from "../../lib/utils";
import type { VoiceStatus, VoiceTurn } from "../../hooks/useVoiceCall";
import { getElectronDesktop } from "../../lib/electron-runtime";
import { VoiceWaveform } from "./VoiceWaveform";
import { VoiceTranscriptPanel } from "./VoiceTranscriptPanel";

type LeftMenuMode = "closed" | "type" | "summary" | "messages";
type CallMediaMode = "none" | "screen" | "camera";

const TYPE_DOCK_COLLAPSED_PX = 48;
const TYPE_DOCK_EXPANDED_PX = 340;
const DOCK_SPRING = { type: "spring" as const, stiffness: 320, damping: 30 };

function isVisionQuestion(text: string) {
  return /\b(what('?s| is) on (my )?(screen|camera)|see (my )?(screen|camera)|look at (my )?(screen|camera|this)|what (am i|do you) (looking at|seeing|viewing)|what (can you|do you) see|describe (what|the|my).*(screen|camera|view)|read (the )?(page|screen)|where (is|do i click)|help (me )?(find|click))\b/i.test(
    String(text || ""),
  );
}

function statusCopy({ status, muted }: { status: VoiceStatus; muted: boolean }) {
  if (muted) return { title: "Muted", hint: "Tap unmute when you’re ready" };
  switch (status) {
    case "connecting":
      return { title: "Connecting", hint: "Setting up your call" };
    case "listening":
      return { title: "Listening", hint: "Speak naturally" };
    case "thinking":
      return { title: "Thinking", hint: "Composing a reply" };
    case "speaking":
      return { title: "Speaking", hint: "Talk to interrupt" };
    case "error":
      return { title: "Interrupted", hint: "Try again or end the call" };
    default:
      return { title: "", hint: "" };
  }
}

function buildSummary(turns: VoiceTurn[]) {
  const users = turns.filter((t) => t.role === "user").map((t) => t.content.trim()).filter(Boolean);
  const ais = turns.filter((t) => t.role === "assistant").map((t) => t.content.trim()).filter(Boolean);
  if (!users.length && !ais.length) {
    return "Nothing to summarize yet. Speak, type, or share your screen.";
  }
  const latestUser = users[users.length - 1]!;
  const latestAi = ais[ais.length - 1];
  const count = Math.max(users.length, ais.length);
  const head =
    count <= 1
      ? `You said: “${latestUser.slice(0, 140)}${latestUser.length > 140 ? "…" : ""}”.`
      : `${count} exchanges so far. Latest from you: “${latestUser.slice(0, 110)}${latestUser.length > 110 ? "…" : ""}”.`;
  const tail = latestAi
    ? ` Clyra replied: “${latestAi.slice(0, 160)}${latestAi.length > 160 ? "…" : ""}”.`
    : " Waiting on Clyra’s reply.";
  return `${head}${tail}`;
}

function CallControlButton({
  label,
  onClick,
  active,
  danger,
  accent,
  children,
}: {
  label: string;
  onClick: () => void;
  active?: boolean;
  danger?: boolean;
  accent?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onClick();
      }}
      className={cn(
        "clyra-voice-call-btn relative z-[280] flex h-12 w-12 touch-manipulation items-center justify-center rounded-full border transition-transform active:scale-90",
        danger
          ? "border-rose-600 bg-rose-600 text-white"
          : accent
            ? "clyra-voice-call-btn--accent"
            : active
              ? "border-slate-900 bg-slate-900 text-white"
              : "border-[#e7e7e4] bg-white/95 text-[#18212f]",
      )}
      aria-label={label}
    >
      {children}
    </button>
  );
}

function StatusChip({
  status,
  muted,
}: {
  status: VoiceStatus;
  muted: boolean;
}) {
  const copy = statusCopy({ status, muted });
  const tone = muted
    ? "muted"
    : status === "thinking"
      ? "thinking"
      : status === "speaking"
        ? "speaking"
        : status === "listening"
          ? "listening"
          : "idle";

  return (
    <motion.div
      key={`${tone}-${copy.title}`}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
      className="mt-5 flex flex-col items-center gap-1.5"
    >
      <div
        className={cn(
          "inline-flex items-center gap-2 rounded-full px-3 py-1 text-[11px] font-semibold tracking-[0.14em] uppercase",
          tone === "muted" && "bg-[#18212f] text-white",
          tone === "thinking" && "bg-[#f1f3f7] text-[#697386]",
          tone === "speaking" && "bg-[#eef4ff] text-[#0052fb]",
          tone === "listening" && "bg-[#f7f8fa] text-[#697386]",
          tone === "idle" && "bg-[#f7f8fa] text-[#697386]",
        )}
      >
        <span
          className={cn(
            "h-1.5 w-1.5 rounded-full",
            tone === "muted" && "bg-white/70",
            tone === "thinking" && "bg-[#94a3b8] clyra-voice-pulse",
            tone === "speaking" && "bg-[#0052fb] clyra-voice-pulse",
            tone === "listening" && "bg-[#94a3b8]",
            tone === "idle" && "bg-[#cbd5e1]",
          )}
        />
        {copy.title}
      </div>
      <p className="text-[12px] text-[#8b939e]">{copy.hint}</p>
    </motion.div>
  );
}

async function captureFrameDataUrl(video: HTMLVideoElement | null): Promise<string | null> {
  if (!video || video.readyState < 2 || video.videoWidth < 2) return null;
  const canvas = document.createElement("canvas");
  const maxW = 1280;
  const scale = Math.min(1, maxW / video.videoWidth);
  canvas.width = Math.max(2, Math.round(video.videoWidth * scale));
  canvas.height = Math.max(2, Math.round(video.videoHeight * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.72);
}

/** Wait until the live <video> has a drawable frame (camera often needs a beat). */
async function waitForVideoFrame(
  video: HTMLVideoElement | null,
  { timeoutMs = 2500 }: { timeoutMs?: number } = {},
): Promise<boolean> {
  if (!video) return false;
  if (video.readyState >= 2 && video.videoWidth > 2) return true;
  const start = Date.now();
  return await new Promise((resolve) => {
    const done = (ok: boolean) => {
      video.removeEventListener("loadeddata", onReady);
      video.removeEventListener("playing", onReady);
      clearInterval(poll);
      resolve(ok);
    };
    const onReady = () => {
      if (video.readyState >= 2 && video.videoWidth > 2) done(true);
    };
    const poll = setInterval(() => {
      if (video.readyState >= 2 && video.videoWidth > 2) done(true);
      else if (Date.now() - start > timeoutMs) done(false);
    }, 80);
    video.addEventListener("loadeddata", onReady);
    video.addEventListener("playing", onReady);
    void video.play().catch(() => undefined);
  });
}

export function VoiceCallOverlay({
  open,
  status,
  muted,
  micLevel,
  partialTranscript,
  assistantText,
  error,
  turns,
  orbColorTheme,
  onToggleMute,
  onEnd,
  onRetry,
  onSendText,
  onUpdateUserMessage,
  onResendUserMessage,
}: {
  open: boolean;
  status: VoiceStatus;
  muted: boolean;
  micLevel: number;
  partialTranscript: string;
  assistantText: string;
  error: string | null;
  turns: VoiceTurn[];
  orbColorTheme: OrbColorTheme;
  onToggleMute: () => void;
  onEnd: () => void;
  onRetry?: () => void;
  onSendText: (text: string) => boolean | void;
  onUpdateUserMessage: (id: string, content: string) => void;
  onResendUserMessage: (id: string, contentOverride?: string) => boolean | void;
}) {
  const [menu, setMenu] = useState<LeftMenuMode>("closed");
  const [draft, setDraft] = useState("");
  const [mediaMode, setMediaMode] = useState<CallMediaMode>("none");
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [screenHint, setScreenHint] = useState<string | null>(null);
  const [seeingScreen, setSeeingScreen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const mediaPreviewRef = useRef<HTMLVideoElement>(null);
  const mediaRequestIdRef = useRef(0);
  const mediaModeRef = useRef<CallMediaMode>("none");
  const autoVisionKeyRef = useRef<string>("");
  const desktop = getElectronDesktop();

  const setCallMediaMode = (mode: CallMediaMode) => {
    mediaModeRef.current = mode;
    setMediaMode(mode);
  };

  const meterActive =
    !muted &&
    (status === "connecting" ||
      status === "listening" ||
      status === "thinking" ||
      status === "speaking");

  const summary = useMemo(() => buildSummary(turns), [turns]);
  const displayAssistant = assistantText.trim();
  const displayUser =
    status === "listening" ? partialTranscript.trim() : "";

  const closeTypeDock = () => {
    setMenu("closed");
    setDraft("");
  };

  const stopMedia = () => {
    mediaRequestIdRef.current += 1;
    const stream = mediaStreamRef.current;
    for (const track of stream?.getTracks() ?? []) {
      track.enabled = false;
      track.stop();
    }
    mediaStreamRef.current = null;
    if (mediaPreviewRef.current) {
      mediaPreviewRef.current.pause();
      mediaPreviewRef.current.srcObject = null;
      mediaPreviewRef.current.removeAttribute("src");
    }
    setCallMediaMode("none");
    setMediaError(null);
    setScreenHint(null);
    setSeeingScreen(false);
  };

  const analyseSharedScreen = useCallback(async (question?: string) => {
    setSeeingScreen(true);
    const activeMode = mediaModeRef.current;
    try {
      const ask =
        question ||
        (activeMode === "camera"
          ? "What do you see on my camera? Answer helpfully about what is visible."
          : "What is on my shared screen? Help briefly.");

      // Wait for a real camera/screenshare frame, then send to Gemini / OpenCluely vision.
      await waitForVideoFrame(mediaPreviewRef.current);
      let dataUrl = await captureFrameDataUrl(mediaPreviewRef.current);
      // One short retry — webcams often need an extra frame after play().
      if (!dataUrl) {
        await new Promise((r) => setTimeout(r, 180));
        await waitForVideoFrame(mediaPreviewRef.current, { timeoutMs: 1200 });
        dataUrl = await captureFrameDataUrl(mediaPreviewRef.current);
      }

      let visionText = "";
      let source = "";

      if (dataUrl) {
        const response = await fetch("/api/companion/vision-frame", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ image: dataUrl, question: ask, source: activeMode }),
        });
        const payload = await response.json().catch(() => ({}));
        visionText = String(payload?.summary || payload?.text || payload?.error || "").trim();
        source = String(payload?.source || payload?.model || "vision-frame");
      } else if (activeMode === "screen" && (desktop?.seeScreen || desktop?.companion?.seeScreen)) {
        // Screen-share only: fall back to Electron OS capture. Never use this for camera.
        const seen = await (desktop.seeScreen || desktop.companion!.seeScreen!)(ask);
        visionText = String(seen?.vision?.summary || seen?.vision?.text || seen?.error || "").trim();
        source = String(seen?.vision?.source || seen?.vision?.model || "electron-see");
      }

      if (visionText) {
        const label = activeMode === "camera" ? "Camera" : "Screen share";
        setScreenHint(`${visionText.slice(0, 220)}${source ? ` · ${source}` : ""}`);
        onSendText(`[${label}] ${ask}\n\nVisible: ${visionText.slice(0, 1200)}`);
      } else {
        setScreenHint(
          activeMode === "camera"
            ? "Camera is on, but no frame was ready yet — looking again shortly."
            : "OpenCluely is ready — ask what’s on your screen from the overlay.",
        );
      }
    } catch (cause) {
      setScreenHint(cause instanceof Error ? cause.message : "Vision failed.");
    } finally {
      setSeeingScreen(false);
    }
  }, [desktop, onSendText]);

  const attachStream = (stream: MediaStream, mode: Exclude<CallMediaMode, "none">, hint: string) => {
    mediaStreamRef.current = stream;
    const [videoTrack] = stream.getVideoTracks();
    if (videoTrack) {
      videoTrack.addEventListener(
        "ended",
        () => {
          if (mediaStreamRef.current === stream) stopMedia();
        },
        { once: true },
      );
    }
    setCallMediaMode(mode);
    setMenu("closed");
    setScreenHint(hint);
    requestAnimationFrame(() => {
      if (!mediaPreviewRef.current) return;
      mediaPreviewRef.current.srcObject = stream;
      void mediaPreviewRef.current.play().catch(() => undefined);
    });
  };

  const startCamera = async () => {
    setMediaError(null);
    const requestId = mediaRequestIdRef.current + 1;
    mediaRequestIdRef.current = requestId;
    for (const track of mediaStreamRef.current?.getTracks() ?? []) {
      track.enabled = false;
      track.stop();
    }
    try {
      const desktopPermission = await getElectronDesktop()?.dictation.ensureCamera?.().catch(() => null);
      if (desktopPermission && desktopPermission.ok === false) {
        setMediaError(String(desktopPermission.error || "Camera permission was not granted."));
        setCallMediaMode("none");
        return;
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: "user",
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      });
      if (requestId !== mediaRequestIdRef.current) {
        for (const track of stream.getTracks()) {
          track.enabled = false;
          track.stop();
        }
        return;
      }
      attachStream(
        stream,
        "camera",
        "Camera on — Gemini is reading your camera automatically.",
      );
      // Auto-capture once the preview has a live frame — no manual "See camera" step.
      window.setTimeout(() => {
        void analyseSharedScreen("What do you see on my camera right now? Describe it clearly.");
      }, 350);
    } catch (cause) {
      if (requestId !== mediaRequestIdRef.current) return;
      const name = cause instanceof DOMException ? cause.name : "";
      if (name === "NotAllowedError") {
        void getElectronDesktop()?.dictation.openCameraSettings?.().catch(() => undefined);
      }
      setMediaError(
        name === "NotAllowedError"
          ? "Camera permission was not granted. Enable “Clyra” under System Settings → Privacy & Security → Camera."
          : "Could not start the camera.",
      );
      setCallMediaMode("none");
    }
  };

  const startMedia = async () => {
    setMediaError(null);
    const requestId = mediaRequestIdRef.current + 1;
    mediaRequestIdRef.current = requestId;
    for (const track of mediaStreamRef.current?.getTracks() ?? []) {
      track.enabled = false;
      track.stop();
    }
    mediaStreamRef.current = null;
    try {
      // Share screen → open the OpenCluely overlay system (spawn if needed).
      if (desktop?.openCluely?.ensure) {
        setScreenHint("Opening OpenCluely…");
        const ensured = await desktop.openCluely.ensure({ expand: true });
        if (requestId !== mediaRequestIdRef.current) return;
        if (ensured?.ok) {
          setCallMediaMode("screen");
          setMenu("closed");
          setScreenHint("OpenCluely is open — use Ask / Auto Answer / Take Control there.");
          // Kick a desktop vision pass so the call also gets screen context.
          if (desktop.seeScreen || desktop.companion?.seeScreen) {
            void analyseSharedScreen("What is on my screen right now?");
          }
          return;
        }
        setMediaError(String(ensured?.error || "Could not open OpenCluely."));
      }

      // Browser / fallback path when Electron OpenCluely bridge is unavailable.
      if (navigator.mediaDevices?.getDisplayMedia) {
        const stream = await navigator.mediaDevices.getDisplayMedia({
          video: {
            frameRate: { ideal: 15, max: 30 },
            ...({ selfBrowserSurface: "exclude", surfaceSwitching: "include" } as MediaTrackConstraints),
          },
          audio: false,
        });
        if (requestId !== mediaRequestIdRef.current) {
          for (const track of stream.getTracks()) {
            track.enabled = false;
            track.stop();
          }
          return;
        }
        attachStream(
          stream,
          "screen",
          "Screen shared — analysing what’s visible.",
        );
        window.setTimeout(() => {
          void analyseSharedScreen("What is on my shared screen right now?");
        }, 280);
        return;
      }
      if (desktop?.seeScreen || desktop?.companion?.seeScreen) {
        setCallMediaMode("screen");
        setScreenHint("Desktop vision ready — ask what’s on your screen.");
        setMenu("closed");
        void analyseSharedScreen("What is on my screen right now?");
        return;
      }
      throw new Error("Screen sharing is not available in this browser.");
    } catch (cause) {
      if (requestId !== mediaRequestIdRef.current) return;
      const name = cause instanceof DOMException ? cause.name : "";
      if (desktop?.seeScreen || desktop?.companion?.seeScreen) {
        setCallMediaMode("screen");
        setScreenHint("Using desktop capture — ask what’s on your screen.");
        return;
      }
      setMediaError(
        name === "NotAllowedError"
          ? "Screen sharing permission was not granted."
          : "Could not start screen sharing.",
      );
      setCallMediaMode("none");
    }
  };

  useEffect(() => {
    if (!open) {
      setMenu("closed");
      setDraft("");
      stopMedia();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // When camera/screen is on and the user speaks a vision question, auto-analyse.
  useEffect(() => {
    if (!open || mediaMode === "none" || seeingScreen) return;
    const latest = [...turns].reverse().find((t) => t.role === "user");
    if (!latest?.content || !isVisionQuestion(latest.content)) return;
    if (/^\[(Camera|Screen share)\]/i.test(latest.content)) return;
    const key = `${latest.id || latest.content}`;
    if (autoVisionKeyRef.current === key) return;
    autoVisionKeyRef.current = key;
    void analyseSharedScreen(latest.content);
  }, [turns, open, mediaMode, seeingScreen, analyseSharedScreen]);

  useEffect(() => () => stopMedia(), []);

  useEffect(() => {
    const stream = mediaStreamRef.current;
    if (!stream || !mediaPreviewRef.current) return;
    mediaPreviewRef.current.srcObject = stream;
    void mediaPreviewRef.current.play().catch(() => undefined);
  }, [mediaMode]);

  useEffect(() => {
    if (menu === "type") {
      const id = window.setTimeout(() => inputRef.current?.focus(), 180);
      return () => window.clearTimeout(id);
    }
  }, [menu]);

  useEffect(() => {
    if (menu === "closed") return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setMenu("closed");
      setDraft("");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [menu]);

  const submitType = (event?: FormEvent) => {
    event?.preventDefault();
    const text = draft.trim();
    if (!text) return;
    if (mediaMode !== "none" && isVisionQuestion(text)) {
      setDraft("");
      void analyseSharedScreen(text);
      return;
    }
    const ok = onSendText(text);
    if (ok !== false) setDraft("");
  };

  const onTypeKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      closeTypeDock();
    }
  };

  const endCall = () => {
    stopMedia();
    onEnd();
  };

  const overlay = (
    <AnimatePresence>
      {open ? (
        <motion.div
          key="voice-call-overlay"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
          className="fixed inset-0 z-[220] flex flex-col items-center justify-center overflow-hidden bg-[#fbfbfa]/92 backdrop-blur-[14px] pointer-events-auto"
          style={{ fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif" }}
        >
          <AnimatePresence initial={false}>
            {mediaMode !== "none" && (mediaStreamRef.current || mediaMode === "screen" || mediaMode === "camera") ? (
              <motion.aside
                key="screen-preview"
                initial={{ opacity: 0, x: 18, y: -8, scale: 0.94, filter: "blur(8px)" }}
                animate={{ opacity: 1, x: 0, y: 0, scale: 1, filter: "blur(0px)" }}
                exit={{ opacity: 0, x: 12, scale: 0.96, filter: "blur(5px)" }}
                transition={{ duration: 0.42, ease: [0.16, 1, 0.3, 1] }}
                className="clyra-call-media-preview"
              >
                <div className="clyra-call-media-preview__frame">
                  {mediaStreamRef.current ? (
                    <video
                      ref={mediaPreviewRef}
                      autoPlay
                      muted
                      playsInline
                      className={cn(
                        "h-full w-full object-cover",
                        mediaMode === "camera" && "scale-x-[-1]",
                      )}
                    />
                  ) : (
                    <div className="grid h-full w-full place-items-center bg-[#0f172a] text-[11px] font-medium text-white/80">
                      Desktop vision ready
                    </div>
                  )}
                  <div className="clyra-call-media-preview__sheen" />
                </div>
                <div className="absolute inset-x-0 bottom-0 z-10 flex items-center justify-end gap-2 p-2">
                  <button
                    type="button"
                    onClick={stopMedia}
                    className="grid h-7 w-7 place-items-center rounded-full border border-white/35 bg-slate-950/65 text-white shadow-sm backdrop-blur-md"
                    aria-label={mediaMode === "camera" ? "Turn off camera" : "Stop screen sharing"}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              </motion.aside>
            ) : null}
          </AnimatePresence>

          {mediaError ? (
            <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} className="absolute right-6 top-6 z-[270] max-w-[280px] rounded-2xl border border-rose-100 bg-white/95 px-3 py-2 text-[11px] font-medium text-rose-600 shadow-lg backdrop-blur-xl">
              {mediaError}
            </motion.div>
          ) : null}

          {screenHint ? (
            <motion.div
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              className="absolute left-1/2 top-6 z-[270] max-w-[420px] -translate-x-1/2 rounded-2xl border border-[#e7e7e4] bg-white/96 px-3.5 py-2 text-[12px] leading-relaxed text-[#18212f] shadow-[0_10px_30px_rgba(15,23,42,0.08)]"
            >
              {screenHint}
            </motion.div>
          ) : null}

          <motion.div
            initial={{ opacity: 0, y: 28, scale: 0.94 }}
            animate={{
              opacity: menu === "summary" || menu === "messages" ? 0.35 : 1,
              y: menu === "summary" ? -36 : 0,
              scale: menu === "summary" || menu === "messages" ? 0.94 : 1,
            }}
            exit={{ opacity: 0, y: 16, scale: 0.97 }}
            transition={{ duration: 0.55, ease: [0.16, 1, 0.3, 1] }}
            className="relative z-[221] flex w-full max-w-lg flex-col items-center px-6"
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.86 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1], delay: 0.04 }}
              className="clyra-voice-orb-stage"
            >
              <AiOrb colorTheme={orbColorTheme} introActive={false} />
            </motion.div>

            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1], delay: 0.1 }}
            >
              <VoiceWaveform level={micLevel} muted={muted} active={meterActive} className="clyra-voice-call-waveform" />
            </motion.div>

            <StatusChip status={status} muted={muted} />

            <div className="mt-4 w-full min-h-[4.5rem]">
              <AnimatePresence mode="wait">
                {error ? (
                  <motion.div
                    key="err"
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -4 }}
                    className="flex flex-col items-center gap-3"
                  >
                    <p className="text-center text-[13px] font-medium text-rose-500">
                      {error}
                    </p>
                    <button
                      type="button"
                      onClick={() => onRetry?.()}
                      className="rounded-full border border-[#dfe4e9] bg-white px-4 py-2 text-[13px] font-semibold text-[#18212f] shadow-sm transition hover:bg-[#f8fafc]"
                    >
                      Try again
                    </button>
                  </motion.div>
                ) : displayAssistant ? (
                  <motion.div
                    key={`ai-${displayAssistant.slice(0, 24)}`}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -6 }}
                    transition={{ duration: 0.32, ease: [0.16, 1, 0.3, 1] }}
                    className="clyra-voice-reply-card mx-auto max-w-md"
                  >
                    <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-[#8b939e]">
                      Clyra
                    </p>
                    <p className="max-h-36 overflow-y-auto text-[15px] leading-relaxed text-[#18212f] scrollbar-thin">
                      {displayAssistant}
                    </p>
                  </motion.div>
                ) : displayUser ? (
                  <motion.p
                    key="user-live"
                    initial={{ opacity: 0, y: 26, scale: 0.988 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.88, ease: [0.22, 1, 0.36, 1] }}
                    className="mx-auto max-w-md rounded-[14px] bg-[#aec7f1]/55 px-3.5 py-2.5 text-center text-[14px] font-medium text-[#18212f]"
                  >
                    {displayUser}
                  </motion.p>
                ) : status === "thinking" ? (
                  <motion.div
                    key="thinking"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="flex justify-center gap-1.5 pt-2"
                  >
                    <span className="clyra-voice-dot" />
                    <span className="clyra-voice-dot" style={{ animationDelay: "0.12s" }} />
                    <span className="clyra-voice-dot" style={{ animationDelay: "0.24s" }} />
                  </motion.div>
                ) : null}
              </AnimatePresence>
            </div>
          </motion.div>

          <VoiceTranscriptPanel
            open={menu === "messages"}
            turns={turns}
            liveUser={displayUser}
            liveAssistant={displayAssistant}
            onClose={() => setMenu("closed")}
            onSend={onSendText}
            onUpdateUser={onUpdateUserMessage}
            onResendUser={onResendUserMessage}
          />

          <AnimatePresence>
            {menu === "summary" ? (
              <motion.div key="summary-layer" className="absolute inset-0 z-[241]">
                <motion.button
                  type="button"
                  aria-label="Close summary"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.18 }}
                  onClick={() => setMenu("closed")}
                  className="absolute inset-0 h-full w-full cursor-default bg-slate-950/8"
                />
                <motion.div
                  initial={{ y: "110%", opacity: 0.4, scale: 0.985 }}
                  animate={{ y: 0, opacity: 1, scale: 1 }}
                  exit={{ y: "110%", opacity: 0.4, scale: 0.99 }}
                  transition={{ type: "spring", stiffness: 410, damping: 39, mass: 0.7 }}
                  className="absolute inset-x-0 bottom-0"
                >
                  <div className="clyra-voice-summary-sheet mx-auto w-full max-w-lg rounded-t-[28px] border border-[#e7e7e4] bg-white/96 px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-3 shadow-[0_-18px_55px_rgba(15,23,42,0.08)] backdrop-blur-xl">
                    <div className="mx-auto mb-3 h-1 w-9 rounded-full bg-[#e7e7e4]" />
                    <div className="mb-3 flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Sparkles className="h-4 w-4 text-[#0052fb]" />
                        <p className="text-[13px] font-semibold text-[#18212f]">Summary</p>
                        <span className="rounded-full bg-[#eef4ff] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-[#0052fb]">
                          Live
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => setMenu("closed")}
                        className="flex h-8 w-8 items-center justify-center rounded-full text-[#697386] hover:bg-[#f1f3f7]"
                        aria-label="Close summary"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                    <p className="text-[14px] leading-relaxed text-[#697386]">{summary}</p>
                  </div>
                </motion.div>
              </motion.div>
            ) : null}
          </AnimatePresence>

          <motion.div
            initial={{ opacity: 0, y: 36 }}
            animate={{
              opacity: menu === "summary" || menu === "messages" ? 0 : 1,
              y: menu === "summary" || menu === "messages" ? 28 : 0,
              pointerEvents: menu === "summary" || menu === "messages" ? "none" : "auto",
            }}
            exit={{ opacity: 0, y: 20 }}
            transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1], delay: 0.08 }}
            className={cn(
              "absolute bottom-8 left-0 right-0 z-[260] flex justify-center px-5",
              (menu === "summary" || menu === "messages") && "hidden",
            )}
            aria-hidden={menu === "summary" || menu === "messages"}
          >
            <div className="relative flex min-h-14 w-full max-w-lg items-center justify-center">
              <AnimatePresence mode="wait" initial={false}>
                {menu === "type" ? (
                  <motion.form
                    key="type-dock"
                    onSubmit={submitType}
                    initial={{ width: TYPE_DOCK_COLLAPSED_PX, opacity: 0 }}
                    animate={{ width: TYPE_DOCK_EXPANDED_PX, opacity: 1 }}
                    exit={{ width: TYPE_DOCK_COLLAPSED_PX, opacity: 0 }}
                    transition={DOCK_SPRING}
                    style={{ maxWidth: "100%" }}
                    className="relative mx-auto overflow-hidden"
                  >
                    <motion.div
                      initial={{ backdropFilter: "blur(0px)" }}
                      animate={{ backdropFilter: "blur(12px)" }}
                      transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
                      className="clyra-voice-type-composer relative flex h-14 w-full items-center gap-2 overflow-hidden rounded-full border border-[#dfe7f1] bg-white/96"
                    >
                      <div className="ml-4 flex shrink-0 text-[#8b939e]">
                        <Pencil className="h-4 w-4" />
                      </div>
                      <input
                        ref={inputRef}
                        type="text"
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={onTypeKey}
                        placeholder="Message Clyra…"
                        autoFocus
                        className="h-14 min-w-0 flex-1 bg-transparent pr-1 text-[14px] text-[#18212f] outline-none placeholder:text-[#8b939e]"
                      />
                      <motion.button
                        type="submit"
                        disabled={!draft.trim()}
                        initial={{ scale: 0, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        transition={{ ...DOCK_SPRING, delay: 0.06 }}
                        whileHover={{ scale: 1.08 }}
                        whileTap={{ scale: 0.9 }}
                        className="mr-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#0052fb] text-white disabled:bg-[#e8eaef] disabled:text-[#b0b5bf]"
                        aria-label="Send message"
                      >
                        <ArrowUpIcon className="h-4 w-4" />
                      </motion.button>
                      <motion.button
                        type="button"
                        onClick={closeTypeDock}
                        initial={{ scale: 0, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        transition={{ ...DOCK_SPRING, delay: 0.08 }}
                        whileHover={{ scale: 1.1 }}
                        whileTap={{ scale: 0.9 }}
                        className="mr-2 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[#697386] hover:bg-[#f1f3f7]"
                        aria-label="Close typing"
                      >
                        <X className="h-4 w-4" />
                      </motion.button>
                    </motion.div>
                  </motion.form>
                ) : (
                  <motion.div
                    key="call-controls"
                    initial={{ scale: 0.92, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    exit={{ scale: 0.92, opacity: 0 }}
                    transition={{ type: "spring", stiffness: 320, damping: 28 }}
                    className="flex w-full max-w-[420px] items-center justify-center gap-2"
                  >
                    <CallControlButton
                      label="Type a message"
                      onClick={() => setMenu("type")}
                    >
                      <Pencil className="h-[18px] w-[18px]" />
                    </CallControlButton>
                    <CallControlButton
                      label="Open messages"
                      onClick={() => setMenu("messages")}
                    >
                      <MessageSquareText className="h-[18px] w-[18px]" />
                    </CallControlButton>
                    <CallControlButton
                      label={mediaMode === "camera" ? "Turn off camera" : "Turn on camera"}
                      onClick={() => {
                        if (mediaMode === "camera") stopMedia();
                        else void startCamera();
                      }}
                      accent={mediaMode === "camera"}
                      active={mediaMode === "camera"}
                    >
                      {mediaMode === "camera" ? (
                        <VideoOff className="h-[18px] w-[18px]" />
                      ) : (
                        <Video className="h-[18px] w-[18px]" />
                      )}
                    </CallControlButton>
                    <CallControlButton
                      label={mediaMode === "screen" ? "Stop screen share" : "Share screen"}
                      onClick={() => {
                        if (mediaMode === "screen") stopMedia();
                        else void startMedia();
                      }}
                      accent={mediaMode === "screen"}
                      active={mediaMode === "screen"}
                    >
                      <MonitorUp className="h-[18px] w-[18px]" />
                    </CallControlButton>
                    <CallControlButton
                      label={muted ? "Unmute microphone" : "Mute microphone"}
                      onClick={onToggleMute}
                      active={muted}
                    >
                      {muted ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
                    </CallControlButton>
                    <CallControlButton label="End voice call" onClick={endCall} danger>
                      <PhoneOff className="h-5 w-5" />
                    </CallControlButton>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
  return typeof document === "undefined" ? overlay : createPortal(overlay, document.body);
}
