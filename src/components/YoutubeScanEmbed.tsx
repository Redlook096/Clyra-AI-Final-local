import { AnimatePresence, motion } from "motion/react";
import { useEffect, useId, useRef, useState } from "react";
import { cn } from "../lib/utils";

type YtPlayer = {
  destroy: () => void;
  mute: () => void;
  playVideo: () => void;
  seekTo: (seconds: number, allowSeekAhead: boolean) => void;
  setPlaybackRate: (rate: number) => void;
  getDuration: () => number;
  getCurrentTime: () => number;
};

declare global {
  interface Window {
    YT?: {
      Player: new (elementId: string, config: Record<string, unknown>) => YtPlayer;
      PlayerState: { ENDED: number; PLAYING: number };
    };
    onYouTubeIframeAPIReady?: () => void;
  }
}

type YoutubeScanEmbedProps = {
  videoId: string;
  active: boolean;
  className?: string;
};

/** Scan runs for this long before the AI reply is allowed to stream. */
export const YOUTUBE_SCAN_DURATION_MS = 10000;

let youtubeApiPromise: Promise<void> | null = null;

function loadYoutubeApi() {
  if (typeof window === "undefined") return Promise.resolve();
  if (window.YT?.Player) return Promise.resolve();
  if (youtubeApiPromise) return youtubeApiPromise;
  youtubeApiPromise = new Promise((resolve) => {
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previous?.();
      resolve();
    };
    if (!document.querySelector('script[src*="youtube.com/iframe_api"]')) {
      const script = document.createElement("script");
      script.src = "https://www.youtube.com/iframe_api";
      script.async = true;
      document.head.appendChild(script);
    }
    window.setTimeout(() => {
      if (window.YT?.Player) resolve();
    }, 0);
  });
  return youtubeApiPromise;
}

/**
 * Muted YouTube preview with a single butter-smooth scan bar.
 * Plays at normal speed. Stays visible for the full scan duration while active.
 */
export function YoutubeScanEmbed({
  videoId,
  active,
  className,
}: YoutubeScanEmbedProps) {
  const reactId = useId().replace(/:/g, "");
  const playerHostId = `yt-scan-${reactId}`;
  const mountRef = useRef<HTMLDivElement | null>(null);
  const playerRef = useRef<YtPlayer | null>(null);
  const shownAtRef = useRef<number>(0);
  const [ready, setReady] = useState(false);
  const [visible, setVisible] = useState(false);
  const [useIframeFallback, setUseIframeFallback] = useState(false);
  const [elapsedLabel, setElapsedLabel] = useState("0.0s");

  useEffect(() => {
    if (active) {
      shownAtRef.current = Date.now();
      setVisible(true);
      return;
    }
    if (!visible) return;
    // Hide only after the full scan window has elapsed.
    const elapsed = Date.now() - shownAtRef.current;
    const remaining = Math.max(0, YOUTUBE_SCAN_DURATION_MS - elapsed);
    const timer = window.setTimeout(() => setVisible(false), remaining);
    return () => window.clearTimeout(timer);
  }, [active, visible]);

  useEffect(() => {
    if (!visible) return;
    const tick = window.setInterval(() => {
      const secs = Math.min(
        YOUTUBE_SCAN_DURATION_MS / 1000,
        (Date.now() - shownAtRef.current) / 1000,
      );
      setElapsedLabel(`${secs.toFixed(1)}s`);
    }, 100);
    return () => window.clearInterval(tick);
  }, [visible]);

  useEffect(() => {
    if (!visible || !videoId) return;
    let cancelled = false;
    setUseIframeFallback(false);
    setReady(false);

    const fallbackTimer = window.setTimeout(() => {
      if (!cancelled && !playerRef.current) {
        setUseIframeFallback(true);
        setReady(true);
      }
    }, 2200);

    void loadYoutubeApi().then(() => {
      if (cancelled || !window.YT?.Player || !mountRef.current) return;

      mountRef.current.innerHTML = "";
      const host = document.createElement("div");
      host.id = playerHostId;
      host.style.width = "100%";
      host.style.height = "100%";
      mountRef.current.appendChild(host);

      try {
        playerRef.current?.destroy();
      } catch {
        // ignore
      }

      playerRef.current = new window.YT.Player(playerHostId, {
        videoId,
        width: "100%",
        height: "100%",
        playerVars: {
          autoplay: 1,
          mute: 1,
          controls: 0,
          modestbranding: 1,
          rel: 0,
          playsinline: 1,
          disablekb: 1,
          fs: 0,
          iv_load_policy: 3,
          origin: window.location.origin,
        },
        events: {
          onReady: (event: { target: YtPlayer }) => {
            if (cancelled || !event.target) return;
            window.clearTimeout(fallbackTimer);
            setUseIframeFallback(false);
            try {
              event.target.mute();
              event.target.setPlaybackRate(2.5);
            } catch {
              // mute / rate quirks
            }
            event.target.playVideo();
            setReady(true);
          },
          onStateChange: (event: { data: number; target: YtPlayer }) => {
            if (cancelled || !window.YT) return;
            if (event.data === window.YT.PlayerState.ENDED) {
              try {
                event.target.seekTo(0, true);
                event.target.playVideo();
              } catch {
                // ignore
              }
            }
          },
        },
      });
    });

    return () => {
      cancelled = true;
      window.clearTimeout(fallbackTimer);
      try {
        playerRef.current?.destroy();
      } catch {
        // ignore
      }
      playerRef.current = null;
      setReady(false);
    };
  }, [visible, playerHostId, videoId]);

  return (
    <AnimatePresence>
      {visible ? (
        <motion.div
          key={videoId}
          initial={{ opacity: 0, y: 10, filter: "blur(6px)" }}
          animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
          exit={{ opacity: 0, y: -8, filter: "blur(6px)" }}
          transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
          className={cn(
            "relative mb-3 overflow-hidden rounded-[24px] border border-slate-200/80 bg-slate-950 shadow-[0_22px_60px_rgba(15,23,42,0.14)]",
            className,
          )}
        >
          <div className="relative aspect-video w-full overflow-hidden bg-black">
            {useIframeFallback ? (
              <iframe
                title="YouTube scan preview"
                className="absolute inset-0 h-full w-full border-0"
                src={`https://www.youtube.com/embed/${videoId}?autoplay=1&mute=1&controls=0&modestbranding=1&playsinline=1&rel=0&loop=1&playlist=${videoId}`}
                allow="autoplay; encrypted-media; picture-in-picture"
                allowFullScreen={false}
              />
            ) : (
              <div ref={mountRef} className="absolute inset-0 h-full w-full" />
            )}
            {!ready ? (
              <div className="absolute inset-0 grid place-items-center bg-slate-950/90 text-[12px] font-semibold text-slate-300">
                Preparing scan…
              </div>
            ) : null}

            <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_48%,rgba(2,6,23,0.4)_100%)]" />
            <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(180deg,rgba(15,23,42,0.22)_0%,transparent_30%,transparent_72%,rgba(15,23,42,0.38)_100%)]" />

            {/* Soft glow trailing the beam */}
            <motion.div
              className="pointer-events-none absolute inset-y-0 w-[18%] bg-[linear-gradient(90deg,transparent_0%,rgba(255,255,255,0.07)_55%,transparent_100%)]"
              initial={{ left: "-18%" }}
              animate={{ left: ["-18%", "100%"] }}
              transition={{
                duration: 2.6,
                repeat: Infinity,
                repeatType: "reverse",
                ease: [0.37, 0, 0.63, 1],
              }}
            />

            {/* Single scan bar — butter smooth back and forth */}
            <motion.div
              className="pointer-events-none absolute inset-y-0 w-[2.5px] rounded-full"
              style={{
                background:
                  "linear-gradient(180deg, transparent 0%, rgba(255,255,255,0.2) 14%, #f8fafc 50%, rgba(255,255,255,0.2) 86%, transparent 100%)",
                boxShadow:
                  "0 0 14px rgba(248,250,252,0.55), 0 0 36px rgba(148,163,184,0.28)",
              }}
              initial={{ left: "3%" }}
              animate={{ left: ["3%", "97%"] }}
              transition={{
                duration: 2.6,
                repeat: Infinity,
                repeatType: "reverse",
                ease: [0.37, 0, 0.63, 1],
              }}
            />

            <div className="pointer-events-none absolute left-3 top-3 inline-flex items-center gap-2.5 rounded-full border border-white/15 bg-black/50 px-3 py-1.5 text-[11px] font-semibold tracking-wide text-white backdrop-blur-md">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-sky-300/70" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-sky-400" />
              </span>
              Scanning
              <span className="font-mono text-[10px] font-medium text-white/65">
                {elapsedLabel} / 10s · 2.5×
              </span>
            </div>
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

export function extractYoutubeVideoId(value: string): string | null {
  const text = (value || "").trim();
  if (!text) return null;
  if (/^[A-Za-z0-9_-]{11}$/.test(text)) return text;
  const match = text.match(
    /(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/,
  );
  if (match?.[1]) return match[1];
  const query = text.match(/[?&]v=([A-Za-z0-9_-]{11})/);
  return query?.[1] ?? null;
}

export function hostnameFromUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
