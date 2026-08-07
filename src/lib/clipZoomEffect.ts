/**
 * Pin-based cinematic zoom for AI Clip editor.
 *
 * Drop a start pin and an end pin on the scrubber; the zoom eases in
 * (accelerates) at the start and eases out (decelerates) at the end.
 * Speed is entirely determined by the pin gap — longer span = slower zoom.
 *
 * Preview applies this transform to the VIDEO layer only so subtitles
 * (CSS overlay / post-crop ASS) stay fixed on the canvas.
 */

export type ZoomDirection = "in" | "out";

export type ZoomPinEffect = {
  id: string;
  /** Seconds — effect begins accelerating from here. */
  start: number;
  /** Seconds — effect finishes decelerating here. */
  end: number;
  direction: ZoomDirection;
  /** Absolute scale at `start` (1 = no zoom). */
  fromZoom: number;
  /** Absolute scale at `end`. */
  toZoom: number;
  /** Transform origin X as percent of the framed video (0–100). */
  originX: number;
  /** Transform origin Y as percent of the framed video (0–100). */
  originY: number;
};

export type ZoomSample = {
  zoom: number;
  originX: number;
  originY: number;
  /** Active effect id, if any. */
  effectId: string | null;
  /** 0–1 eased progress through the active effect, else 0. */
  progress: number;
};

/** Ken-Burns-style smootherstep: flat derivative at both ends. */
export function easeInOutSmooth(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x * x * x * (x * (x * 6 - 15) + 10);
}

/** Slightly punchier than smootherstep; still zero velocity at ends. */
export function easeInOutCubic(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

export function defaultZoomPair(
  direction: ZoomDirection,
  intensity = 1.72,
): { fromZoom: number; toZoom: number } {
  const target = clamp(intensity, 1.15, 2.4);
  return direction === "in"
    ? { fromZoom: 1, toZoom: target }
    : { fromZoom: target, toZoom: 1 };
}

/**
 * Create a zoom-in or zoom-out effect spanning `start`→`end`.
 * Duration alone controls how fast the zoom travels.
 */
export function createZoomPinEffect(input: {
  id?: string;
  start: number;
  end: number;
  direction: ZoomDirection;
  intensity?: number;
  originX?: number;
  originY?: number;
}): ZoomPinEffect {
  const start = Math.min(input.start, input.end);
  const end = Math.max(input.start, input.end);
  const { fromZoom, toZoom } = defaultZoomPair(input.direction, input.intensity);
  return {
    id: input.id || `zoom-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    start,
    end: Math.max(end, start + 0.05),
    direction: input.direction,
    fromZoom,
    toZoom,
    originX: clamp(input.originX ?? 50, 0, 100),
    originY: clamp(input.originY ?? 42, 0, 100),
  };
}

/** Suggest an end time for a new pin pair given playhead + clip length. */
export function suggestZoomEnd(start: number, duration: number, preferredSpan = 1.6): number {
  const span = clamp(preferredSpan, 0.35, Math.max(0.35, duration * 0.28));
  return clamp(start + span, 0, Math.max(duration, start + 0.05));
}

/**
 * Evaluate the composed zoom at `time` seconds.
 * When multiple effects overlap, the latest-starting one wins.
 */
export function evaluateZoomAtTime(
  effects: ZoomPinEffect[],
  time: number,
  ease: (t: number) => number = easeInOutSmooth,
): ZoomSample {
  if (!effects.length) {
    return { zoom: 1, originX: 50, originY: 50, effectId: null, progress: 0 };
  }

  const active = effects
    .filter((effect) => time >= effect.start - 1e-4 && time <= effect.end + 1e-4)
    .sort((a, b) => b.start - a.start)[0];

  if (!active) {
    // After an effect ends, hold the end zoom until another effect starts
    // so the framing doesn't pop back. Before any effect, stay at 1.
    const previous = effects
      .filter((effect) => time > effect.end)
      .sort((a, b) => b.end - a.end)[0];
    if (previous) {
      return {
        zoom: previous.toZoom,
        originX: previous.originX,
        originY: previous.originY,
        effectId: null,
        progress: 1,
      };
    }
    return { zoom: 1, originX: 50, originY: 50, effectId: null, progress: 0 };
  }

  const span = Math.max(1e-4, active.end - active.start);
  const linear = clamp((time - active.start) / span, 0, 1);
  const progress = ease(linear);
  return {
    zoom: lerp(active.fromZoom, active.toZoom, progress),
    originX: active.originX,
    originY: active.originY,
    effectId: active.id,
    progress,
  };
}

/**
 * Dense crop-keyframe samples for FFmpeg / pipeline reframe.
 * Captions stay unscaled because ASS is burned AFTER the crop pass.
 */
export function zoomEffectsToCropKeyframes(
  effects: ZoomPinEffect[],
  durationSec: number,
  fps = 30,
): Array<{ timeMs: number; x: number; y: number; zoom: number }> {
  const frames = Math.max(1, Math.ceil(Math.max(0, durationSec) * fps));
  const out: Array<{ timeMs: number; x: number; y: number; zoom: number }> = [];
  for (let i = 0; i <= frames; i += 1) {
    const time = (i / fps);
    if (time > durationSec + 1e-6) break;
    const sample = evaluateZoomAtTime(effects, time);
    out.push({
      timeMs: Math.round(time * 1000),
      x: sample.originX,
      y: sample.originY,
      zoom: sample.zoom,
    });
  }
  return out;
}

export function normalizeZoomEffect(effect: ZoomPinEffect, duration: number): ZoomPinEffect {
  let start = clamp(effect.start, 0, Math.max(0, duration));
  let end = clamp(effect.end, 0, Math.max(0, duration));
  if (end < start) [start, end] = [end, start];
  if (end - start < 0.05) end = Math.min(duration, start + 0.05);
  return {
    ...effect,
    start,
    end,
    fromZoom: clamp(effect.fromZoom, 1, 2.6),
    toZoom: clamp(effect.toZoom, 1, 2.6),
    originX: clamp(effect.originX, 0, 100),
    originY: clamp(effect.originY, 0, 100),
  };
}
