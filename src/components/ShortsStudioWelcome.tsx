import { Clapperboard, Heart, MessagesSquare, Ticket, X } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { FAKE_TEXT_GAMEPLAY_LIBRARY } from "../data/fakeTextGameplay";
import { useShortsTokens } from "../lib/shortsTokens";

export type ShortsMode = "fake-text" | "would-rather" | "clip";

interface ShortsStudioWelcomeProps {
  open: boolean;
  onClose: () => void;
  onSelectMode: (mode: ShortsMode) => void;
}

const OPEN_TRANSITION = { duration: 0.22, ease: [0.22, 1, 0.36, 1] as const };
const CLOSE_TRANSITION = { duration: 0.18, ease: [0.4, 0, 1, 1] as const };

const SAMPLE_CARDS = [
  { clipId: "minecraft-01", caption: "iMessage story", detail: "Minecraft parkour" },
  { clipId: "subway-03", caption: "Would You Rather", detail: "Subway Surfers run" },
  { clipId: "gta-04", caption: "iMessage story", detail: "GTA mega-ramp" },
  { clipId: "minecraft-04", caption: "AI Clipper cut", detail: "Minecraft parkour" },
  { clipId: "subway-01", caption: "iMessage story", detail: "Subway Surfers run" },
  { clipId: "gta-01", caption: "Would You Rather", detail: "GTA mega-ramp" },
  { clipId: "minecraft-02", caption: "iMessage story", detail: "Minecraft parkour" },
  { clipId: "subway-05", caption: "AI Clipper cut", detail: "Subway Surfers run" },
];

const MODES: Array<{ id: ShortsMode; label: string; detail: string; icon: typeof MessagesSquare; accent: string }> = [
  { id: "fake-text", label: "Fake Text Story", detail: "Narrated iMessage-style conversation over gameplay", icon: MessagesSquare, accent: "#4169f6" },
  { id: "would-rather", label: "Would You Rather", detail: "Narrated choice and poll videos", icon: Heart, accent: "#e0245e" },
  { id: "clip", label: "AI Clipper", detail: "Turn long videos into polished social clips", icon: Clapperboard, accent: "#334155" },
];

function CarouselCard({ card }: { card: (typeof SAMPLE_CARDS)[number] }) {
  const clip = FAKE_TEXT_GAMEPLAY_LIBRARY.find((entry) => entry.id === card.clipId);
  if (!clip) return null;
  return (
    <div className="relative aspect-[9/16] w-[132px] shrink-0 overflow-hidden rounded-2xl border border-slate-200/90 bg-slate-900 shadow-[0_10px_28px_rgba(15,23,42,.08)] sm:w-[150px]">
      <video
        src={clip.src}
        poster={clip.poster}
        autoPlay
        muted
        loop
        playsInline
        preload="metadata"
        className="absolute inset-0 h-full w-full object-cover"
      />
      <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/5 to-transparent" />
      <div className="absolute inset-x-0 bottom-0 p-2.5">
        <p className="text-[10px] font-semibold leading-tight text-white">{card.caption}</p>
        <p className="text-[9px] leading-tight text-white/70">{card.detail}</p>
      </div>
      <span className="absolute right-2 top-2 rounded-full bg-black/45 px-2 py-0.5 text-[8px] font-semibold uppercase tracking-wide text-white/90 backdrop-blur-sm">
        Clyra
      </span>
    </div>
  );
}

export function ShortsStudioWelcome({ open, onClose, onSelectMode }: ShortsStudioWelcomeProps) {
  const reduceMotion = useReducedMotion();
  const { remaining, total, hasTokens, consume } = useShortsTokens();
  const motionOff = reduceMotion ? { duration: 0 } : undefined;

  const openMode = (mode: ShortsMode) => {
    if (hasTokens) consume();
    onSelectMode(mode);
  };

  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          className="fixed inset-0 z-[260] overflow-hidden bg-slate-50/95 text-slate-950"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, transition: motionOff ?? CLOSE_TRANSITION }}
          transition={motionOff ?? OPEN_TRANSITION}
          role="dialog"
          aria-modal="true"
          aria-label="Shorts Studio"
          onClick={onClose}
        >
          <style>{`
            @keyframes shorts-studio-marquee {
              from { transform: translateX(0); }
              to { transform: translateX(-50%); }
            }
            .shorts-studio-track {
              animation: shorts-studio-marquee 34s linear infinite;
            }
            .shorts-studio-track:hover {
              animation-play-state: paused;
            }
            @media (prefers-reduced-motion: reduce) {
              .shorts-studio-track { animation: none; }
            }
          `}</style>
          <div className="pointer-events-none absolute inset-0 opacity-[0.28] [background-image:linear-gradient(rgba(15,23,42,.035)_1px,transparent_1px),linear-gradient(90deg,rgba(15,23,42,.035)_1px,transparent_1px)] [background-size:40px_40px]" />

          <div
            className="relative z-10 mx-auto flex h-dvh max-w-[960px] flex-col overflow-y-auto px-5 pb-8 pt-7 sm:pt-10"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              onClick={onClose}
              aria-label="Close Shorts Studio"
              className="absolute right-4 top-4 z-20 grid h-8 w-8 place-items-center rounded-full border border-slate-200/90 bg-white text-slate-500 transition-colors hover:text-slate-950 sm:right-6"
            >
              <X className="h-4 w-4" />
            </button>

            <motion.header
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={motionOff ?? OPEN_TRANSITION}
              className="shrink-0 text-center sm:text-left"
            >
              <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-400">Clyra workspace</p>
              <h1 className="mt-1.5 text-[32px] font-semibold leading-none tracking-tight text-slate-950 sm:text-[40px]">
                Shorts Studio
              </h1>
              <p className="mx-auto mt-2.5 max-w-[56ch] text-[14px] leading-relaxed text-slate-500 sm:mx-0">
                Narrated iMessage stories, Would You Rather polls, and AI-clipped highlights — one place to script, preview, and export a scroll-stopping short.
              </p>
            </motion.header>

            <motion.div
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={motionOff ?? { ...OPEN_TRANSITION, delay: 0.04 }}
              className="mx-auto mt-5 flex shrink-0 items-center gap-2 self-center rounded-full border border-slate-200/90 bg-white px-3.5 py-1.5 text-[11px] font-semibold text-slate-600 sm:mx-0 sm:self-start"
            >
              <Ticket className="h-3.5 w-3.5 text-slate-400" />
              {hasTokens
                ? `${remaining} of ${total} free renders left`
                : "All free renders used — you can still continue"}
            </motion.div>

            <motion.div
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={motionOff ?? { ...OPEN_TRANSITION, delay: 0.08 }}
              className="mt-8 shrink-0"
            >
              <p className="px-0.5 text-[10px] font-bold uppercase tracking-[0.12em] text-slate-400">Made with Clyra</p>
              <div className="relative mt-3 overflow-hidden [mask-image:linear-gradient(90deg,transparent,black_8%,black_92%,transparent)]">
                <div className="shorts-studio-track flex w-max gap-3.5">
                  {[...SAMPLE_CARDS, ...SAMPLE_CARDS].map((card, index) => (
                    <CarouselCard key={`${card.clipId}-${index}`} card={card} />
                  ))}
                </div>
              </div>
            </motion.div>

            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={motionOff ?? { ...OPEN_TRANSITION, delay: 0.14 }}
              className="mt-9 shrink-0"
            >
              <p className="px-0.5 text-[10px] font-bold uppercase tracking-[0.12em] text-slate-400">Choose a tool</p>
              <div className="mt-3 grid gap-3.5 sm:grid-cols-3">
                {MODES.map((mode, index) => {
                  const Icon = mode.icon;
                  return (
                    <motion.button
                      key={mode.id}
                      type="button"
                      onClick={() => openMode(mode.id)}
                      initial={{ opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={motionOff ?? { ...OPEN_TRANSITION, delay: 0.16 + index * 0.03 }}
                      className="group flex flex-col items-start gap-3.5 rounded-2xl border border-slate-200/90 bg-white p-5 text-left shadow-[0_2px_10px_rgba(15,23,42,.03)] transition-[border-color,box-shadow,transform] duration-200 hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-[0_14px_34px_rgba(15,23,42,.08)] active:translate-y-0"
                    >
                      <span className="grid h-10 w-10 place-items-center rounded-full" style={{ backgroundColor: `${mode.accent}14`, color: mode.accent }}>
                        <Icon className="h-[19px] w-[19px]" strokeWidth={1.8} />
                      </span>
                      <span className="text-[14px] font-bold text-slate-950">{mode.label}</span>
                      <span className="text-[12px] leading-relaxed text-slate-500">{mode.detail}</span>
                      <span className="mt-auto flex items-center gap-1 text-[10px] font-semibold text-slate-400 transition-colors group-hover:text-slate-950">
                        <Ticket className="h-3 w-3" />
                        {hasTokens ? "Use 1 free render" : "Continue"}
                      </span>
                    </motion.button>
                  );
                })}
              </div>
            </motion.div>
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
