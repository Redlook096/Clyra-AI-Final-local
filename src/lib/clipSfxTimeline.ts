/**
 * Sound FX clips for the AI Clipper editor.
 *
 * Items live on the Audio timeline row, play in preview synced to the
 * main video clock, and are mixed into the final MP4 via FFmpeg.
 */

export type ClipSfxAssetId = "thud" | "sus" | "fahh_long" | "fahh_short";

export type ClipSfxAsset = {
  id: ClipSfxAssetId;
  label: string;
  file: string;
  /** Public URL for editor preview. */
  url: string;
  /** Native file duration in seconds (at 1×). */
  nativeDuration: number;
  /** Short description shown in the palette. */
  hint: string;
};

export type ClipSfxClip = {
  id: string;
  assetId: ClipSfxAssetId;
  /** Timeline start in seconds. */
  start: number;
  /** Playback rate (0.5–2). Timeline duration = nativeDuration / speed. */
  speed: number;
  /** Linear gain 0–1.5. */
  volume: number;
};

export const CLIP_SFX_ASSETS: ClipSfxAsset[] = [
  {
    id: "thud",
    label: "Thud",
    file: "thud.mp3",
    url: "/media/clipper-sfx/thud.mp3",
    nativeDuration: 1.28,
    hint: "Heavy impact",
  },
  {
    id: "sus",
    label: "Sus",
    file: "sus.mp3",
    url: "/media/clipper-sfx/sus.mp3",
    nativeDuration: 4.68,
    hint: "Suspense sting",
  },
  {
    id: "fahh_long",
    label: "Fahh Long",
    file: "fahh_long.mp3",
    url: "/media/clipper-sfx/fahh_long.mp3",
    nativeDuration: 2.8,
    hint: "Long whoosh / fahh",
  },
  {
    id: "fahh_short",
    label: "Fahh Short",
    file: "fahh_short.mp3",
    url: "/media/clipper-sfx/fahh_short.mp3",
    nativeDuration: 2.32,
    hint: "Short whoosh / fahh",
  },
];

const ASSET_BY_ID = Object.fromEntries(CLIP_SFX_ASSETS.map((asset) => [asset.id, asset])) as Record<
  ClipSfxAssetId,
  ClipSfxAsset
>;

export function clipSfxAsset(assetId: string): ClipSfxAsset | null {
  return ASSET_BY_ID[assetId as ClipSfxAssetId] || null;
}

export function clampSfxSpeed(speed: number): number {
  if (!Number.isFinite(speed)) return 1;
  return Math.min(2, Math.max(0.5, Math.round(speed * 100) / 100));
}

export function clampSfxVolume(volume: number): number {
  if (!Number.isFinite(volume)) return 1;
  return Math.min(1.5, Math.max(0, Math.round(volume * 100) / 100));
}

/** Length of the clip on the timeline at the current speed. */
export function sfxTimelineDuration(clip: Pick<ClipSfxClip, "assetId" | "speed">): number {
  const asset = clipSfxAsset(clip.assetId);
  if (!asset) return 0.2;
  const speed = clampSfxSpeed(clip.speed);
  return Math.max(0.05, asset.nativeDuration / speed);
}

export function sfxEnd(clip: ClipSfxClip): number {
  return clip.start + sfxTimelineDuration(clip);
}

export function createSfxClip(input: {
  id?: string;
  assetId: ClipSfxAssetId;
  start: number;
  speed?: number;
  volume?: number;
}): ClipSfxClip {
  return normalizeSfxClip({
    id: input.id || `sfx-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    assetId: input.assetId,
    start: input.start,
    speed: input.speed ?? 1,
    volume: input.volume ?? 1,
  });
}

export function normalizeSfxClip(raw: Partial<ClipSfxClip>, clipDuration = Number.POSITIVE_INFINITY): ClipSfxClip | null {
  const asset = clipSfxAsset(String(raw.assetId || ""));
  if (!asset) return null;
  const speed = clampSfxSpeed(Number(raw.speed ?? 1));
  const volume = clampSfxVolume(Number(raw.volume ?? 1));
  const duration = Math.max(0.05, asset.nativeDuration / speed);
  const maxStart = Number.isFinite(clipDuration) ? Math.max(0, clipDuration - 0.05) : Number.POSITIVE_INFINITY;
  const start = Math.min(maxStart, Math.max(0, Number(raw.start) || 0));
  return {
    id: String(raw.id || `sfx-${asset.id}`),
    assetId: asset.id,
    start,
    speed,
    volume,
  };
}

export function normalizeSfxClips(raw: unknown, clipDuration = Number.POSITIVE_INFINITY): ClipSfxClip[] {
  if (!Array.isArray(raw)) return [];
  const out: ClipSfxClip[] = [];
  for (const item of raw) {
    const clip = normalizeSfxClip((item || {}) as Partial<ClipSfxClip>, clipDuration);
    if (clip) out.push(clip);
  }
  return out;
}

/** Source-file offset (seconds at 1×) for a given timeline time. */
export function sfxSourceTimeAt(clip: ClipSfxClip, timelineTime: number): number {
  const speed = clampSfxSpeed(clip.speed);
  return Math.max(0, (timelineTime - clip.start) * speed);
}

export function isSfxActiveAt(clip: ClipSfxClip, timelineTime: number): boolean {
  return timelineTime >= clip.start - 0.001 && timelineTime < sfxEnd(clip) - 0.001;
}

/** Payload shape sent to `/api/clipper/rerender` and the Python mixer. */
export function sfxClipsForRender(clips: ClipSfxClip[]) {
  return clips.map((clip) => {
    const asset = clipSfxAsset(clip.assetId);
    return {
      id: clip.id,
      assetId: clip.assetId,
      file: asset?.file || `${clip.assetId}.mp3`,
      start: clip.start,
      speed: clampSfxSpeed(clip.speed),
      volume: clampSfxVolume(clip.volume),
      duration: sfxTimelineDuration(clip),
      nativeDuration: asset?.nativeDuration ?? sfxTimelineDuration(clip),
    };
  });
}
