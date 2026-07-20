import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { cn } from "../lib/utils";
import { StatusTextReveal } from "./core/status-text-reveal";

type YoutubeScanEmbedProps = {
  videoId: string;
  active: boolean;
  className?: string;
};

/** Scan runs for this long before the AI reply is allowed to stream. */
export const YOUTUBE_SCAN_DURATION_MS = 5200;

/**
 * Compact YouTube analysis status with no embedded video player. It stays
 * visible for the full scan duration while the answer is being prepared.
 */
export function YoutubeScanEmbed({
  videoId,
  active,
  className,
}: YoutubeScanEmbedProps) {
  const shownAtRef = useRef<number>(0);
  const [visible, setVisible] = useState(false);
  const [elapsedLabel, setElapsedLabel] = useState("0.0s");
  const [videoTitle, setVideoTitle] = useState("YouTube video");

  useEffect(() => {
    if (!active || !videoId) return;
    let cancelled = false;
    setVideoTitle("YouTube video");
    void fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}&format=json`)
      .then((response) => response.ok ? response.json() as Promise<{ title?: string }> : null)
      .then((payload) => {
        if (!cancelled && payload?.title) setVideoTitle(payload.title);
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [active, videoId]);

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

  return (
    <AnimatePresence>
      {visible ? (
        <motion.div
          key={videoId}
          initial={{ opacity: 0, y: 10, filter: "blur(6px)" }}
          animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
          exit={{ opacity: 0, y: -8, filter: "blur(6px)" }}
          transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
          className={cn("clyra-youtube-scan", className)}
        >
          <div className="clyra-youtube-scan__beam" aria-hidden />
          <span className="clyra-youtube-scan__dot" aria-hidden />
          <div className="min-w-0">
            <StatusTextReveal
              className="clyra-youtube-scan__label"
              text="Analyzing YouTube video"
              ariaLabel="Analyzing YouTube video"
            />
            <strong title={videoTitle}>{videoTitle}</strong>
          </div>
          <span className="clyra-youtube-scan__time">{elapsedLabel} / 5.2s</span>
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
