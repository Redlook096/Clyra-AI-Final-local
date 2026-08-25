import { AnimatePresence, motion } from "framer-motion";
import type { VoiceCallStatus } from "../../hooks/useVoiceCall";

const BAR_COUNT = 9;

function ListeningMeter({ level }: { level: number }) {
  return (
    <div className="flex items-end gap-[6px] h-16">
      {Array.from({ length: BAR_COUNT }).map((_, i) => {
        // A per-bar phase so the meter reads as organic speech, not a single
        // uniform pulse -- still entirely driven by the real mic level.
        const wobble = 0.55 + 0.45 * Math.sin(i * 1.3);
        const height = 8 + Math.min(1, level * wobble * 2.4) * 52;
        return (
          <motion.span
            key={i}
            className="w-[5px] rounded-full bg-slate-700/70"
            animate={{ height }}
            transition={{ type: "spring", stiffness: 300, damping: 20 }}
          />
        );
      })}
    </div>
  );
}

function ThinkingPulse() {
  return (
    <div className="flex items-center gap-3">
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          className="h-3 w-3 rounded-full bg-slate-400"
          animate={{ scale: [0.6, 1, 0.6], opacity: [0.4, 1, 0.4] }}
          transition={{ duration: 1.1, repeat: Infinity, ease: "easeInOut", delay: i * 0.15 }}
        />
      ))}
    </div>
  );
}

function SpeakingCaptions({ lines }: { lines: string[] }) {
  const visible = lines.filter((l) => l.trim());
  return (
    <div className="flex flex-col items-center gap-1 max-w-xl px-6 text-center" data-testid="voice-speaking-captions">
      <div className="text-xs font-medium tracking-wide text-slate-400 mb-1">Clyra</div>
      <AnimatePresence initial={false} mode="popLayout">
        {visible.map((line, i) => (
          <motion.p
            key={`${i}-${line.slice(0, 12)}`}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: i === visible.length - 1 ? 1 : 0.45, y: 0 }}
            exit={{ opacity: 0, y: -14 }}
            transition={{ duration: 0.22, ease: "easeOut" }}
            className="text-lg text-slate-800 leading-snug"
          >
            {line}
          </motion.p>
        ))}
      </AnimatePresence>
    </div>
  );
}

type VoiceStageProps = {
  status: VoiceCallStatus;
  micLevel: number;
  partialTranscript: string;
  captionLines: string[];
};

export function VoiceStage({ status, micLevel, partialTranscript, captionLines }: VoiceStageProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-4">
      <AnimatePresence mode="wait">
        {status === "speaking" ? (
          <motion.div key="speaking" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <SpeakingCaptions lines={captionLines} />
          </motion.div>
        ) : status === "thinking" ? (
          <motion.div
            key="thinking"
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.9 }}
            className="flex flex-col items-center gap-3"
          >
            <span className="text-sm text-slate-400">Thinking…</span>
            <ThinkingPulse />
          </motion.div>
        ) : status === "connecting" ? (
          <motion.div
            key="connecting"
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.9 }}
            className="flex flex-col items-center gap-3"
          >
            <span className="text-sm text-slate-400">Connecting…</span>
            <ThinkingPulse />
          </motion.div>
        ) : (
          <motion.div
            key="listening"
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            className="flex flex-col items-center gap-3"
          >
            <span className="text-sm text-slate-400">Listening</span>
            <ListeningMeter level={micLevel} />
            {partialTranscript && (
              <span className="max-w-md truncate text-sm text-slate-500">{partialTranscript}</span>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
