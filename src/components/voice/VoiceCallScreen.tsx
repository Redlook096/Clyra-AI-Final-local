import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useMemo, useRef, useState } from "react";
import { Camera, Menu, MessageCircle, Mic, MicOff, MoreHorizontal, PhoneOff, ScreenShare, X } from "lucide-react";
import type { UseVoiceCallOptions, VoiceCallStatus, VoiceTurn } from "../../hooks/useVoiceCall";
import { Bloub, type BloubState } from "../bloub/Bloub";
import { LiquidGlassButton, LiquidGlassIconGroup } from "./LiquidGlassButton";
import { VoiceFluidField, type VoiceFluidHandle } from "./VoiceFluidField";
import { VoiceStage } from "./VoiceStage";

/**
 * Bloub only has a real "thinking" (three-dot pulse) and "wide" (attentive,
 * dramatically open eyes) state in its catalogue — there's no dedicated
 * mouth/speaking pose since the character has no mouth at all. So: thinking
 * and listening map onto those two directly, "talking" stays on idle with a
 * live audio-reactive pulse (see `Bloub`'s `audioLevel` prop) rather than a
 * fabricated state, and idle/connecting/error all fall back to plain idle.
 */
function bloubStateForCallStatus(status: VoiceCallStatus): BloubState {
  switch (status) {
    case "listening":
      return "wide";
    case "thinking":
    case "connecting":
      return "thinking";
    default:
      return "idle";
  }
}

export type VoiceCallScreenCall = {
  active: boolean;
  status: VoiceCallStatus;
  muted: boolean;
  micLevel: number;
  botLevel: number;
  partialTranscript: string;
  captionLines: string[];
  turns: VoiceTurn[];
  error: string | null;
  endCall: () => void | Promise<void>;
  toggleMute: () => void;
};

type VoiceCallScreenProps = {
  call: VoiceCallScreenCall;
  testMode: boolean;
  /** Bloub's ink colour on this screen. Defaults to a near-black ink. */
  avatarColor?: string;
  /** Opens the existing voice/device settings surface. */
  onOpenSettings?: () => void;
};

export function VoiceCallScreen({ call, testMode, avatarColor = "#0a0a0c", onOpenSettings }: VoiceCallScreenProps) {
  const fluidRef = useRef<VoiceFluidHandle>(null);
  const [minimized, setMinimized] = useState(false);
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const [cameraArmed, setCameraArmed] = useState(false);
  const [shareArmed, setShareArmed] = useState(false);

  useEffect(() => {
    const energy = call.status === "speaking" ? call.botLevel : call.micLevel;
    fluidRef.current?.setEnergy(energy);
  }, [call.status, call.micLevel, call.botLevel]);

  useEffect(() => {
    if (call.active && !minimized) {
      // liquid-glass-react measures its own box once on mount and only
      // re-measures on a window `resize` -- while the control row is still
      // animating in (spring scale 0.96 -> 1) that first measurement is
      // taken mid-transition and never corrected, leaving each glass
      // control's internal tint/highlight layers permanently the wrong
      // size. Nudging a resize once the spring settles forces a fresh,
      // correct measurement.
      const timer = window.setTimeout(() => window.dispatchEvent(new Event("resize")), 400);
      return () => window.clearTimeout(timer);
    }
  }, [call.active, minimized]);

  useEffect(() => {
    if (call.active) {
      setMinimized(false);
    } else {
      setTranscriptOpen(false);
      setCameraArmed(false);
      setShareArmed(false);
    }
  }, [call.active]);

  const bloubState = useMemo(() => bloubStateForCallStatus(call.status), [call.status]);

  return (
    <AnimatePresence>
      {call.active && minimized && (
        <motion.button
          key="voice-resume-chip"
          type="button"
          onClick={() => setMinimized(false)}
          initial={{ opacity: 0, y: 16, scale: 0.9 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 16, scale: 0.9 }}
          transition={{ type: "spring", stiffness: 380, damping: 28 }}
          className="fixed bottom-6 right-6 z-[85] flex items-center gap-3 rounded-full bg-white/90 px-4 py-2.5 shadow-[0_8px_28px_rgba(15,23,42,0.16)] ring-1 ring-black/5 backdrop-blur-xl"
        >
          <Bloub state={bloubState} size={28} color={avatarColor} background="#ffffff" audioLevel={call.status === "speaking" ? call.botLevel : 0} />
          <span className="text-sm font-medium text-slate-700">
            {call.status === "speaking" ? "Speaking…" : call.status === "thinking" ? "Thinking…" : "Clyra call"}
          </span>
        </motion.button>
      )}

      {call.active && !minimized && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.22 }}
          className="fixed inset-0 z-[80] flex flex-col overflow-hidden bg-[#fbfbfa]"
        >
          <motion.div
            initial={{ y: 60, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 40, opacity: 0 }}
            transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
            className="pointer-events-none absolute inset-x-0 bottom-0 h-[34%]"
          >
            <VoiceFluidField ref={fluidRef} className="h-full w-full" />
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: -12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -12 }}
            transition={{ duration: 0.24, delay: 0.06 }}
            className="relative z-10 flex items-center justify-between px-6 pt-6"
          >
            <LiquidGlassButton icon={<Menu size={18} />} label="Minimize call" onClick={() => setMinimized(true)} size="sm" />
            <LiquidGlassIconGroup
              items={[
                { icon: <MessageCircle size={17} />, label: "Transcript", onClick: () => setTranscriptOpen((v) => !v) },
                { icon: <MoreHorizontal size={17} />, label: "More", onClick: () => onOpenSettings?.() },
              ]}
            />
          </motion.div>

          <div className="relative z-10 flex flex-1 flex-col items-center justify-center gap-7">
            {testMode && (
              <span className="rounded-full bg-amber-100 px-3 py-1 text-xs font-medium text-amber-700">
                Test Mode — repeating what you say, DeepSeek not used
              </span>
            )}
            <motion.div
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
              className="relative flex items-center justify-center"
            >
              <motion.div
                aria-hidden
                className="pointer-events-none absolute rounded-full"
                style={{
                  width: 220,
                  height: 220,
                  background: "radial-gradient(circle, rgba(91,157,255,0.22) 0%, rgba(91,157,255,0.06) 55%, transparent 75%)",
                }}
                animate={{
                  scale: call.status === "speaking" ? 1 + call.botLevel * 0.35 : [1, 1.06, 1],
                  opacity: call.status === "speaking" ? 0.6 + call.botLevel * 0.4 : [0.55, 0.75, 0.55],
                }}
                transition={
                  call.status === "speaking"
                    ? { duration: 0.12, ease: "easeOut" }
                    : { duration: 3.2, repeat: Infinity, ease: "easeInOut" }
                }
              />
              <Bloub
                state={bloubState}
                size={100}
                color={avatarColor}
                background="#fbfbfa"
                audioLevel={call.status === "speaking" ? call.botLevel : 0}
                animateEntrance
              />
            </motion.div>
            <VoiceStage
              status={call.status}
              active={call.active}
              muted={call.muted}
              micLevel={call.micLevel}
              botLevel={call.botLevel}
              partialTranscript={call.partialTranscript}
              captionLines={call.captionLines}
            />
            {call.error && <span className="text-sm text-rose-500">{call.error}</span>}
          </div>

          <motion.div
            initial={{ y: 24, opacity: 0, scale: 0.96 }}
            animate={{ y: 0, opacity: 1, scale: 1 }}
            exit={{ y: 24, opacity: 0, scale: 0.96 }}
            transition={{ type: "spring", stiffness: 340, damping: 22, delay: 0.08 }}
            className="relative z-10 flex items-center justify-center gap-5 pb-12"
          >
            <LiquidGlassButton
              icon={<Camera size={19} />}
              label="Camera"
              onClick={() => setCameraArmed((v) => !v)}
              active={cameraArmed}
              disabled
            />
            <LiquidGlassButton
              icon={<ScreenShare size={19} />}
              label="Share screen"
              onClick={() => setShareArmed((v) => !v)}
              active={shareArmed}
              disabled
            />
            <LiquidGlassButton
              icon={call.muted ? <MicOff size={20} /> : <Mic size={20} />}
              label={call.muted ? "Unmute" : "Mute"}
              onClick={call.toggleMute}
              active={call.muted}
            />
            <LiquidGlassButton
              icon={<PhoneOff size={20} />}
              label="End call"
              onClick={() => void call.endCall()}
              danger
            />
          </motion.div>

          <AnimatePresence>
            {transcriptOpen && (
              <motion.div
                key="voice-transcript-sheet"
                initial={{ x: 340, opacity: 0 }}
                animate={{ x: 0, opacity: 1 }}
                exit={{ x: 340, opacity: 0 }}
                transition={{ type: "spring", stiffness: 360, damping: 34 }}
                className="absolute inset-y-0 right-0 z-20 flex w-[320px] flex-col border-l border-black/5 bg-white/85 backdrop-blur-2xl"
              >
                <div className="flex items-center justify-between px-5 py-5">
                  <span className="text-sm font-semibold text-slate-800">Transcript</span>
                  <button
                    type="button"
                    aria-label="Close transcript"
                    onClick={() => setTranscriptOpen(false)}
                    className="rounded-full p-1 text-slate-400 hover:bg-black/5 hover:text-slate-600"
                  >
                    <X size={16} />
                  </button>
                </div>
                <div className="flex-1 space-y-4 overflow-y-auto px-5 pb-6" data-testid="voice-transcript-list">
                  {call.turns.length === 0 && !call.partialTranscript && (
                    <p className="text-sm text-slate-400">Nothing said yet.</p>
                  )}
                  {call.turns.map((turn, i) => (
                    <div key={i} className="space-y-1">
                      <span className="text-[11px] font-medium uppercase tracking-wide text-slate-400">
                        {turn.role === "user" ? "You" : "Clyra"}
                      </span>
                      <p className="text-sm leading-snug text-slate-700">{turn.content}</p>
                    </div>
                  ))}
                  {call.partialTranscript && (
                    <div className="space-y-1">
                      <span className="text-[11px] font-medium uppercase tracking-wide text-slate-400">You</span>
                      <p className="text-sm italic leading-snug text-slate-400">{call.partialTranscript}</p>
                    </div>
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export type { UseVoiceCallOptions };
