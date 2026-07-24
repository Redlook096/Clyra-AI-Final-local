import {
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
  Mic,
  MicOff,
  Pencil,
  PhoneOff,
  Sparkles,
  X,
} from "lucide-react";
import { AiOrb, type OrbColorTheme } from "../AiOrb";
import { cn } from "../../lib/utils";
import type { VoiceStatus, VoiceTurn } from "../../hooks/useVoiceCall";
import { VoiceWaveform } from "./VoiceWaveform";

type LeftMenuMode = "closed" | "type" | "summary";
type CallMediaMode = "none" | "screen";

const TYPE_DOCK_COLLAPSED_PX = 48;
const TYPE_DOCK_EXPANDED_PX = 320;
const DOCK_SPRING = { type: "spring" as const, stiffness: 300, damping: 30 };

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
      return { title: "Speaking", hint: "Talk for 2s to interrupt" };
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
    return "Nothing to summarize yet. Speak or type to start the call.";
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
  children,
}: {
  label: string;
  onClick: () => void;
  active?: boolean;
  danger?: boolean;
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
        "clyra-voice-call-btn relative z-[280] flex h-14 w-14 touch-manipulation items-center justify-center rounded-full border transition-transform active:scale-90",
        danger
          ? "border-rose-600 bg-rose-600 text-white"
          : active
            ? "border-slate-900 bg-slate-900 text-white"
            : "border-slate-200/90 bg-white/92 text-slate-800",
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
          tone === "muted" && "bg-slate-900 text-white",
          tone === "thinking" && "bg-slate-100 text-slate-600",
          tone === "speaking" && "bg-emerald-50 text-emerald-700",
          tone === "listening" && "bg-slate-50 text-slate-500",
          tone === "idle" && "bg-slate-50 text-slate-500",
        )}
      >
        <span
          className={cn(
            "h-1.5 w-1.5 rounded-full",
            tone === "muted" && "bg-white/70",
            tone === "thinking" && "bg-slate-400 clyra-voice-pulse",
            tone === "speaking" && "bg-emerald-500 clyra-voice-pulse",
            tone === "listening" && "bg-slate-400",
            tone === "idle" && "bg-slate-300",
          )}
        />
        {copy.title}
      </div>
      <p className="text-[12px] text-slate-400">{copy.hint}</p>
    </motion.div>
  );
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
  onSendText: (text: string) => boolean | void;
  onUpdateUserMessage: (id: string, content: string) => void;
  onResendUserMessage: (id: string, contentOverride?: string) => boolean | void;
}) {
  const [menu, setMenu] = useState<LeftMenuMode>("closed");
  const [draft, setDraft] = useState("");
  const [mediaMode, setMediaMode] = useState<CallMediaMode>("none");
  const [mediaError, setMediaError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const mediaPreviewRef = useRef<HTMLVideoElement>(null);
  // A display/camera picker can resolve after the user has ended the call.
  // Keep a monotonically increasing request id so a late grant is immediately
  // stopped instead of leaving the operating-system capture indicator on.
  const mediaRequestIdRef = useRef(0);

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
    setMediaMode("none");
    setMediaError(null);
  };

  const startMedia = async () => {
    const nextMode: Exclude<CallMediaMode, "none"> = "screen";
    setMediaError(null);
    const requestId = mediaRequestIdRef.current + 1;
    mediaRequestIdRef.current = requestId;
    for (const track of mediaStreamRef.current?.getTracks() ?? []) {
      track.enabled = false;
      track.stop();
    }
    try {
      // Launch the platform picker immediately. There is no intermediate
      // Clyra setup screen, and the platform retains the permission boundary.
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          frameRate: { ideal: 15, max: 30 },
          ...({ selfBrowserSurface: "exclude", surfaceSwitching: "include" } as MediaTrackConstraints),
        },
        audio: false,
      });
      // The picker may resolve after ending the call, changing media modes, or
      // closing the overlay. Do not retain that late stream.
      if (requestId !== mediaRequestIdRef.current) {
        for (const track of stream.getTracks()) {
          track.enabled = false;
          track.stop();
        }
        return;
      }
      mediaStreamRef.current = stream;
      const [videoTrack] = stream.getVideoTracks();
      if (videoTrack) {
        videoTrack.addEventListener("ended", () => {
          if (mediaStreamRef.current === stream) stopMedia();
        }, { once: true });
      }
      setMediaMode(nextMode);
      setMenu("closed");
      requestAnimationFrame(() => {
        if (!mediaPreviewRef.current) return;
        mediaPreviewRef.current.srcObject = stream;
        void mediaPreviewRef.current.play().catch(() => undefined);
      });
    } catch (cause) {
      if (requestId !== mediaRequestIdRef.current) return;
      const name = cause instanceof DOMException ? cause.name : "";
      setMediaError(
        name === "NotAllowedError"
          ? "Screen sharing permission was not granted."
          : "Could not start screen sharing.",
      );
      setMediaMode("none");
    }
  };

  useEffect(() => {
    if (!open) {
      setMenu("closed");
      setDraft("");
      stopMedia();
    }
    // Media tracks are intentionally tied to the call overlay lifecycle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

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

  void onUpdateUserMessage;
  void onResendUserMessage;

  const overlay = (
    <AnimatePresence>
      {open ? (
        <motion.div
          key="voice-call-overlay"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
          className="fixed inset-0 z-[220] flex flex-col items-center justify-center overflow-hidden bg-white/90 backdrop-blur-[12px] pointer-events-auto"
        >
          <AnimatePresence initial={false}>
            {mediaMode !== "none" ? (
              <motion.aside
                key={mediaMode}
                initial={{ opacity: 0, x: 18, y: -8, scale: 0.94, filter: "blur(8px)" }}
                animate={{ opacity: 1, x: 0, y: 0, scale: 1, filter: "blur(0px)" }}
                exit={{ opacity: 0, x: 12, scale: 0.96, filter: "blur(5px)" }}
                transition={{ duration: 0.42, ease: [0.16, 1, 0.3, 1] }}
                className="clyra-call-media-preview"
              >
                <div className="clyra-call-media-preview__frame">
                  <video
                    ref={mediaPreviewRef}
                    autoPlay
                    muted
                    playsInline
                    className={cn(
                      "h-full w-full object-cover",
                    )}
                  />
                  <div className="clyra-call-media-preview__sheen" />
                </div>
                <div className="absolute right-2 top-2 z-10">
                  <button type="button" onClick={stopMedia} className="grid h-7 w-7 place-items-center rounded-full border border-white/35 bg-slate-950/65 text-white shadow-sm backdrop-blur-md transition-[background-color,transform] duration-200 hover:scale-105 hover:bg-slate-950/85" aria-label="Stop screen sharing">
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

          {/* Normal voice call stage — stays put while typing */}
          <motion.div
            initial={{ opacity: 0, y: 28, scale: 0.94 }}
            animate={{
              opacity: 1,
              y: menu === "summary" ? -36 : 0,
              scale: menu === "summary" ? 0.94 : 1,
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
                  <motion.p
                    key="err"
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -4 }}
                    className="text-center text-[13px] font-medium text-rose-500"
                  >
                    {error}
                  </motion.p>
                ) : displayAssistant ? (
                  <motion.div
                    key={`ai-${displayAssistant.slice(0, 24)}`}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -6 }}
                    transition={{ duration: 0.32, ease: [0.16, 1, 0.3, 1] }}
                    className="clyra-voice-reply-card mx-auto max-w-md"
                  >
                    <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-400">
                      Clyra
                    </p>
                    <p className="max-h-36 overflow-y-auto text-[15px] leading-relaxed text-slate-800 scrollbar-thin">
                      {displayAssistant}
                    </p>
                  </motion.div>
                ) : displayUser ? (
                  <motion.p
                    key="user-live"
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    className="text-center text-[14px] font-medium text-slate-600"
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

          {/* Summary sheet only — no message list */}
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
                <div className="clyra-voice-summary-sheet mx-auto w-full max-w-lg rounded-t-[28px] border border-slate-200/80 bg-white/96 px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-3 shadow-[0_-18px_55px_rgba(15,23,42,0.12)] backdrop-blur-xl">
                  <div className="mx-auto mb-3 h-1 w-9 rounded-full bg-slate-200" />
                  <div className="mb-3 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Sparkles className="h-4 w-4 text-slate-500" />
                      <p className="text-[13px] font-semibold text-slate-900">Summary</p>
                      <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-700">
                        Live
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        setMenu("closed");
                      }}
                      className="flex h-8 w-8 items-center justify-center rounded-full text-slate-500 hover:bg-slate-100"
                      aria-label="Close summary"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                  <motion.p
                    key={summary}
                    initial={{ opacity: 0.4 }}
                    animate={{ opacity: 1 }}
                    transition={{ duration: 0.25 }}
                    className="text-[14px] leading-relaxed text-slate-600"
                  >
                    {summary}
                  </motion.p>
                  <p className="mt-3 text-[11px] text-slate-400">
                    Updates automatically as the call continues.
                  </p>
                </div>
                </motion.div>
              </motion.div>
            ) : null}
          </AnimatePresence>

          {/* Bottom dock: call controls ↔ expanding type bar. */}
          <motion.div
            initial={{ opacity: 0, y: 36 }}
            animate={{
              opacity: menu === "summary" ? 0 : 1,
              y: menu === "summary" ? 28 : 0,
              pointerEvents: menu === "summary" ? "none" : "auto",
            }}
            exit={{ opacity: 0, y: 20 }}
            transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1], delay: 0.08 }}
            className={cn(
              "absolute bottom-10 left-0 right-0 z-[260] flex justify-center px-5",
              menu === "summary" && "hidden",
            )}
            aria-hidden={menu === "summary"}
          >
            <div className="relative flex min-h-14 w-full max-w-md items-center justify-center">
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
                      className="clyra-voice-type-composer relative flex h-14 w-full items-center gap-2 overflow-hidden rounded-full border border-slate-200/90 bg-white/88 shadow-none backdrop-blur-md"
                    >
                      <div className="ml-4 flex shrink-0 text-slate-400">
                        <Pencil className="h-4 w-4" />
                      </div>
                      <input
                        ref={inputRef}
                        type="text"
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={onTypeKey}
                        placeholder="Type a message…"
                        autoFocus
                        className="h-14 min-w-0 flex-1 bg-transparent pr-1 text-[14px] text-slate-800 outline-none placeholder:text-slate-400"
                      />
                      <motion.button
                        type="submit"
                        disabled={!draft.trim()}
                        initial={{ scale: 0, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        transition={{ ...DOCK_SPRING, delay: 0.06 }}
                        whileHover={{ scale: 1.08 }}
                        whileTap={{ scale: 0.9 }}
                        className="mr-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-900 text-white disabled:bg-slate-300 disabled:opacity-60"
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
                        className="mr-2 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-slate-500 hover:bg-slate-100"
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
                    className="grid w-full max-w-[184px] grid-cols-2 items-center justify-items-center"
                  >
                    {/* The former left control (Type plus Share Screen) is
                        intentionally hidden for now. `startMedia`, `stopMedia`
                        and the type dock remain intact for the next UI pass. */}
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
