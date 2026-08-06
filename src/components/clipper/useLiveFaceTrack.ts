/**
 * Live face tracking for the clipper preview.
 *
 * Uses MediaPipe Tasks Face Detector (BlazeFace, Apache-2.0 / open source)
 * via CDN so we stay in lock-step with the Python pipeline detector, then
 * applies a high-responsiveness exponential smoother so nods and pans
 * follow with essentially no perceptible lag.
 */
import { useEffect, useRef, useState } from "react";

export type FaceTrackPoint = {
  /** 0–100 object-position X (face centre). */
  x: number;
  /** 0–100 object-position Y (face centre, slight headroom). */
  y: number;
  /** Zoom factor for vertical 9:16 framing. */
  zoom: number;
  confidence: number;
};

type Detector = {
  detectForVideo: (
    video: HTMLVideoElement,
    timestamp: number,
  ) => { detections: Array<{ boundingBox?: { originX: number; originY: number; width: number; height: number }; categories?: Array<{ score?: number }> }> };
  close: () => void;
};

const WASM_CDN = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
const MODEL_CDN =
  "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite";

/** Higher alpha = snappier follow (nods, quick pans). */
const SMOOTH_ALPHA = 0.42;
const HEADROOM = 0.18;
const DEFAULT_ZOOM = 1.55;

let detectorPromise: Promise<Detector | null> | null = null;

async function loadDetector(): Promise<Detector | null> {
  if (detectorPromise) return detectorPromise;
  detectorPromise = (async () => {
    try {
      const vision = await import(
        /* @vite-ignore */
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/+esm"
      );
      const fileset = await vision.FilesetResolver.forVisionTasks(WASM_CDN);
      const detector = await vision.FaceDetector.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL_CDN, delegate: "GPU" },
        runningMode: "VIDEO",
        minDetectionConfidence: 0.45,
      });
      return detector as Detector;
    } catch (error) {
      console.warn("[clyra] Face detector unavailable", error);
      return null;
    }
  })();
  return detectorPromise;
}

function lerp(from: number, to: number, alpha: number) {
  return from + (to - from) * alpha;
}

function pickBest(
  detections: Array<{
    boundingBox?: { originX: number; originY: number; width: number; height: number };
    categories?: Array<{ score?: number }>;
  }>,
  videoW: number,
  videoH: number,
): FaceTrackPoint | null {
  let best: FaceTrackPoint | null = null;
  let bestScore = 0;
  for (const detection of detections) {
    const box = detection.boundingBox;
    if (!box || box.width <= 0 || box.height <= 0) continue;
    const score = detection.categories?.[0]?.score ?? 0.5;
    const area = (box.width / videoW) * (box.height / videoH);
    const rank = score * (0.35 + area);
    if (rank <= bestScore) continue;
    bestScore = rank;
    const cx = (box.originX + box.width / 2) / videoW;
    const cy = (box.originY + box.height * (0.5 - HEADROOM)) / videoH;
    // Tighter crop when the face is small so the subject stays dominant.
    const faceFrac = Math.max(box.width / videoW, box.height / videoH);
    const zoom = Math.min(2.4, Math.max(1.25, DEFAULT_ZOOM * (0.22 / Math.max(0.08, faceFrac))));
    best = {
      x: Math.min(100, Math.max(0, cx * 100)),
      y: Math.min(100, Math.max(0, cy * 100)),
      zoom,
      confidence: score,
    };
  }
  return best;
}

/**
 * When `enabled`, continuously detects the dominant face in `video` and
 * returns a smoothed crop centre suitable for CSS object-position / scale.
 */
export function useLiveFaceTrack(
  video: HTMLVideoElement | null,
  enabled: boolean,
): FaceTrackPoint | null {
  const [point, setPoint] = useState<FaceTrackPoint | null>(null);
  const smoothRef = useRef<FaceTrackPoint | null>(null);
  const rafRef = useRef<number | null>(null);
  const lastTsRef = useRef(-1);

  useEffect(() => {
    if (!enabled || !video) {
      smoothRef.current = null;
      setPoint(null);
      if (rafRef.current != null) {
        video?.cancelVideoFrameCallback?.(rafRef.current as never);
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      return;
    }

    let cancelled = false;
    let detector: Detector | null = null;

    const tick = (now: number) => {
      if (cancelled || !video || video.readyState < 2) {
        schedule();
        return;
      }
      // Skip duplicate timestamps from rVFC when paused.
      if (now === lastTsRef.current && !video.paused) {
        schedule();
        return;
      }
      lastTsRef.current = now;
      try {
        if (detector) {
          const result = detector.detectForVideo(video, performance.now());
          const next = pickBest(result.detections || [], video.videoWidth || 1, video.videoHeight || 1);
          if (next) {
            const prev = smoothRef.current;
            const smoothed: FaceTrackPoint = prev
              ? {
                  x: lerp(prev.x, next.x, SMOOTH_ALPHA),
                  y: lerp(prev.y, next.y, SMOOTH_ALPHA),
                  zoom: lerp(prev.zoom, next.zoom, SMOOTH_ALPHA * 0.7),
                  confidence: next.confidence,
                }
              : next;
            smoothRef.current = smoothed;
            setPoint(smoothed);
          }
        }
      } catch {
        /* transient decode glitches ignored */
      }
      schedule();
    };

    const schedule = () => {
      if (cancelled) return;
      if (typeof video.requestVideoFrameCallback === "function") {
        rafRef.current = video.requestVideoFrameCallback((ts) => tick(ts)) as unknown as number;
      } else {
        rafRef.current = requestAnimationFrame(() => tick(performance.now()));
      }
    };

    void loadDetector().then((loaded) => {
      if (cancelled) return;
      detector = loaded;
      schedule();
    });

    return () => {
      cancelled = true;
      if (rafRef.current != null) {
        video.cancelVideoFrameCallback?.(rafRef.current as never);
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [video, enabled]);

  return point;
}
