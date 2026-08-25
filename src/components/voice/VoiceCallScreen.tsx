import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useMemo, useRef } from "react";
import { Mic, MicOff, PhoneOff } from "lucide-react";
import type { UseVoiceCallOptions, VoiceCallStatus } from "../../hooks/useVoiceCall";
import { Bloub, type BloubState } from "../bloub/Bloub";
import { LiquidGlassButton } from "./LiquidGlassButton";
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
  error: string | null;
  endCall: () => void | Promise<void>;
  toggleMute: () => void;
};

type VoiceCallScreenProps = {
  call: VoiceCallScreenCall;
  testMode: boolean;
  /** Bloub's ink colour on this screen. Defaults to a near-black ink. */
  avatarColor?: string;
};

export function VoiceCallScreen({ call, testMode, avatarColor = "#0a0a0c" }: VoiceCallScreenProps) {
  const fluidRef = useRef<VoiceFluidHandle>(null);

  useEffect(() => {
    const energy = call.status === "speaking" ? call.botLevel : call.micLevel;
    fluidRef.current?.setEnergy(energy);
  }, [call.status, call.micLevel, call.botLevel]);

  const bloubState = useMemo(() => bloubStateForCallStatus(call.status), [call.status]);

  return (
    <AnimatePresence>
      {call.active && (
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
            className="pointer-events-none absolute inset-x-0 bottom-0 h-[32%]"
          >
            <VoiceFluidField ref={fluidRef} className="h-full w-full" />
          </motion.div>

          <div className="relative z-10 flex flex-1 flex-col items-center justify-center gap-6">
            {testMode && (
              <span className="rounded-full bg-amber-100 px-3 py-1 text-xs font-medium text-amber-700">
                Test Mode — repeating what you say, DeepSeek not used
              </span>
            )}
            <motion.div
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
            >
              <Bloub
                state={bloubState}
                size={92}
                color={avatarColor}
                background="#fbfbfa"
                audioLevel={call.status === "speaking" ? call.botLevel : 0}
                animateEntrance
              />
            </motion.div>
            <VoiceStage
              status={call.status}
              micLevel={call.micLevel}
              partialTranscript={call.partialTranscript}
              captionLines={call.captionLines}
            />
            {call.error && <span className="text-sm text-rose-500">{call.error}</span>}
          </div>

          <motion.div
            initial={{ y: 24, opacity: 0, scale: 0.96 }}
            animate={{ y: 0, opacity: 1, scale: 1 }}
            exit={{ y: 24, opacity: 0, scale: 0.96 }}
            transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1], delay: 0.05 }}
            className="relative z-10 flex items-center justify-center gap-6 pb-12"
          >
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
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export type { UseVoiceCallOptions };
