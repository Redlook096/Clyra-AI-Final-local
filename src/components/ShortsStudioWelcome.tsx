import { Clapperboard, MessageCircleQuestion, MessagesSquare, X } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { SHORTS_STUDIO_SAMPLE_LIBRARY } from "../data/shortsStudioSamples";
import { useShortsTokens } from "../lib/shortsTokens";

export type ShortsMode = "fake-text" | "would-rather" | "clip";

interface ShortsStudioWelcomeProps {
  open: boolean;
  onClose: () => void;
  onSelectMode: (mode: ShortsMode) => void;
}

const EASE = [0.22, 1, 0.36, 1] as const;

const TOOLS: Array<{
  id: ShortsMode;
  title: string;
  description: string;
  icon: typeof MessagesSquare;
}> = [
  {
    id: "fake-text",
    title: "Fake Text Story",
    description: "Create engaging fake text conversations that hook and entertain.",
    icon: MessagesSquare,
  },
  {
    id: "clip",
    title: "AI Clipper",
    description: "Turn long videos into viral shorts with AI-powered highlights.",
    icon: Clapperboard,
  },
  {
    id: "would-rather",
    title: "Would You Rather",
    description: "Create viral would-you-rather questions and scenarios.",
    icon: MessageCircleQuestion,
  },
];

// The real Shorts Studio sample outputs — doubled below for a seamless
// marquee loop rather than any placeholder/example footage.
const CAROUSEL_CLIPS = SHORTS_STUDIO_SAMPLE_LIBRARY;

function VideoCard({ clip }: { clip: (typeof CAROUSEL_CLIPS)[number] }) {
  return (
    <div className="shorts-video-card group relative aspect-[9/16] w-[188px] shrink-0 overflow-hidden sm:w-[200px]">
      <video
        src={clip.src}
        poster={clip.poster}
        autoPlay
        muted
        loop
        playsInline
        preload="metadata"
        className="absolute inset-0 h-full w-full object-cover transition-transform duration-300 ease-out group-hover:scale-[1.035]"
      />
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/72 via-black/0 to-transparent" />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 p-3">
        <p className="truncate text-[11.5px] font-semibold leading-tight text-white">{clip.label}</p>
        <p className="mt-0.5 truncate text-[10px] leading-tight text-white/65">{clip.detail}</p>
      </div>
    </div>
  );
}

export function ShortsStudioWelcome({ open, onClose, onSelectMode }: ShortsStudioWelcomeProps) {
  const reduceMotion = useReducedMotion();
  const { hasTokens, consume } = useShortsTokens();
  const motionOff = reduceMotion ? { duration: 0 } : undefined;

  const openMode = (mode: ShortsMode) => {
    if (hasTokens) consume();
    onSelectMode(mode);
  };

  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          className="fixed inset-0 z-[260] overflow-y-auto"
          style={{ background: "var(--shorts-page-bg)" }}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, transition: motionOff ?? { duration: 0.16 } }}
          transition={motionOff ?? { duration: 0.22 }}
          role="dialog"
          aria-modal="true"
          aria-label="Shorts Studio"
        >
          <style>{`
            :root {
              --shorts-page-bg: #fbfcff;
              --shorts-surface: rgba(255,255,255,0.78);
              --shorts-surface-solid: #ffffff;
              --shorts-text-primary: #071635;
              --shorts-text-secondary: #6f7d99;
              --shorts-blue: #1476ff;
              --shorts-blue-bright: #2588ff;
              --shorts-blue-deep: #075fea;
              --shorts-border: rgba(70,105,170,0.12);
              --shorts-border-hover: rgba(30,110,255,0.24);
            }
            .shorts-studio-root {
              font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", Inter, sans-serif;
            }
            .shorts-title-studio {
              background: linear-gradient(135deg, var(--shorts-blue-bright), var(--shorts-blue-deep));
              -webkit-background-clip: text;
              background-clip: text;
              color: transparent;
            }
            .shorts-tool-card {
              background: var(--shorts-surface);
              border: 1px solid var(--shorts-border);
              border-radius: 28px;
              box-shadow: 0 14px 40px rgba(40,75,130,0.07), 0 2px 7px rgba(40,75,130,0.035);
              transition: transform 280ms cubic-bezier(.2,.8,.2,1), box-shadow 280ms cubic-bezier(.2,.8,.2,1), border-color 220ms ease;
            }
            .shorts-tool-card:hover {
              transform: translateY(-5px) scale(1.012);
              border-color: var(--shorts-border-hover);
              box-shadow: 0 26px 60px rgba(40,75,130,0.12), 0 6px 16px rgba(40,75,130,0.05);
            }
            .shorts-tool-card:hover .shorts-tool-icon {
              transform: translateY(-2px);
            }
            .shorts-tool-icon {
              transition: transform 280ms cubic-bezier(.2,.8,.2,1);
            }
            .shorts-enter-btn {
              background: linear-gradient(180deg, var(--shorts-blue-bright), var(--shorts-blue-deep));
              box-shadow: 0 1px 0 rgba(255,255,255,0.35) inset, 0 8px 20px rgba(20,118,255,0.28);
              transition: transform 200ms cubic-bezier(.2,.8,.2,1), box-shadow 200ms cubic-bezier(.2,.8,.2,1), filter 200ms ease;
            }
            .shorts-enter-btn:hover {
              filter: brightness(1.05);
              transform: translateY(-1px);
              box-shadow: 0 1px 0 rgba(255,255,255,0.4) inset, 0 10px 26px rgba(20,118,255,0.34);
            }
            .shorts-enter-btn:active {
              transform: scale(0.97);
              box-shadow: 0 1px 0 rgba(255,255,255,0.3) inset, 0 4px 10px rgba(20,118,255,0.22);
            }
            .shorts-video-card {
              border-radius: 19px;
              border: 1px solid rgba(15,23,42,0.08);
              background: #0b0d12;
              box-shadow: 0 10px 26px rgba(15,23,42,0.09);
              transition: transform 240ms cubic-bezier(.2,.8,.2,1), box-shadow 240ms cubic-bezier(.2,.8,.2,1), border-color 240ms ease;
            }
            .shorts-video-card:hover {
              transform: translateY(-3.5px) scale(1.025);
              border-color: rgba(20,118,255,0.28);
              box-shadow: 0 18px 40px rgba(15,23,42,0.14);
            }
            @keyframes shorts-marquee {
              from { transform: translate3d(0,0,0); }
              to { transform: translate3d(-50%,0,0); }
            }
            .shorts-marquee-track {
              animation: shorts-marquee 38s linear infinite;
              will-change: transform;
            }
            .shorts-marquee-track:hover {
              animation-play-state: paused;
            }
            .shorts-focusable:focus-visible {
              outline: none;
              box-shadow: 0 0 0 3px rgba(20,118,255,0.35);
            }
            @media (prefers-reduced-motion: reduce) {
              .shorts-marquee-track { animation: none; }
              .shorts-tool-card, .shorts-video-card, .shorts-enter-btn { transition: none; }
            }
          `}</style>

          {/* Faint radial blue atmosphere behind the hero — never a decorative blob. */}
          <div
            className="pointer-events-none fixed inset-0"
            style={{
              background:
                "radial-gradient(720px 480px at 50% 8%, rgba(37,136,255,0.10), transparent 65%)",
            }}
          />

          <button
            type="button"
            onClick={onClose}
            aria-label="Close Shorts Studio"
            className="shorts-focusable fixed right-6 top-6 z-30 grid h-9 w-9 place-items-center rounded-full text-[#6f7d99] transition-colors hover:bg-black/[0.04] hover:text-[#071635]"
          >
            <X className="h-4 w-4" />
          </button>

          <div className="shorts-studio-root relative z-10 mx-auto flex min-h-dvh max-w-[1180px] flex-col items-center px-6 pb-20 pt-20 sm:pt-24">
            {/* Stage 1 — branding */}
            <motion.span
              initial={{ opacity: 0, y: 8, scale: 0.94 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              transition={motionOff ?? { duration: 0.32, ease: EASE }}
              className="grid h-11 w-11 place-items-center rounded-[13px]"
              style={{
                background: "linear-gradient(155deg, var(--shorts-blue-bright), var(--shorts-blue-deep))",
                boxShadow: "0 8px 20px rgba(20,118,255,.28)",
              }}
            >
              <Clapperboard className="h-5 w-5 text-white" strokeWidth={2} />
            </motion.span>

            <motion.h1
              initial={{ opacity: 0, y: 12, filter: "blur(4px)" }}
              animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
              transition={motionOff ?? { duration: 0.36, ease: EASE, delay: 0.06 }}
              className="mt-4 text-center text-[52px] font-semibold leading-[1.05] tracking-[-0.03em] sm:text-[68px]"
              style={{ color: "var(--shorts-text-primary)" }}
            >
              Shorts <span className="shorts-title-studio">Studio</span>
            </motion.h1>

            <motion.p
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={motionOff ?? { duration: 0.32, ease: EASE, delay: 0.12 }}
              className="mt-3 text-center text-[16px] font-medium sm:text-[18px]"
              style={{ color: "var(--shorts-text-secondary)" }}
            >
              Create viral short-form content with AI
            </motion.p>

            {/* Stage 2 — three tool cards */}
            <div className="mt-12 grid w-full max-w-[1120px] grid-cols-1 gap-6 sm:grid-cols-3 sm:gap-7">
              {TOOLS.map((tool, index) => {
                const Icon = tool.icon;
                return (
                  <motion.button
                    key={tool.id}
                    type="button"
                    onClick={() => openMode(tool.id)}
                    initial={{ opacity: 0, y: 18, scale: 0.985 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    transition={motionOff ?? { duration: 0.4, ease: EASE, delay: 0.2 + index * 0.08 }}
                    className="shorts-tool-card shorts-focusable flex min-h-[320px] flex-col items-center justify-center gap-4 px-8 py-10 text-center"
                  >
                    <span className="shorts-tool-icon">
                      <Icon className="h-10 w-10" strokeWidth={1.6} style={{ color: "var(--shorts-blue)" }} />
                    </span>
                    <span
                      className="text-[19px] font-semibold tracking-[-0.015em]"
                      style={{ color: "var(--shorts-text-primary)" }}
                    >
                      {tool.title}
                    </span>
                    <span
                      className="max-w-[26ch] text-[13.5px] leading-relaxed"
                      style={{ color: "var(--shorts-text-secondary)" }}
                    >
                      {tool.description}
                    </span>
                    <span
                      className="shorts-enter-btn mt-2 flex h-[46px] w-[140px] items-center justify-center rounded-full text-[14px] font-semibold text-white"
                    >
                      Enter
                    </span>
                  </motion.button>
                );
              })}
            </div>

            {/* Stage 3 — real project video carousel, no arrows/dots/headings */}
            <motion.div
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={motionOff ?? { duration: 0.4, ease: EASE, delay: 0.5 }}
              className="mt-16 w-screen overflow-hidden [mask-image:linear-gradient(90deg,transparent,black_6%,black_94%,transparent)]"
            >
              <div className="shorts-marquee-track flex w-max gap-4 px-6">
                {[...CAROUSEL_CLIPS, ...CAROUSEL_CLIPS].map((clip, index) => (
                  <VideoCard key={`${clip.id}-${index}`} clip={clip} />
                ))}
              </div>
            </motion.div>
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
