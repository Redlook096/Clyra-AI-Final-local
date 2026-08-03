/**
 * Boundary adapter for a separately-running AutoClip instance.
 *
 * AutoClip is intentionally not bundled into the Electron renderer or copied
 * into Clyra.  This module owns the small, versioned HTTP contract Clyra needs
 * in order to offer it as an optional local runner while preserving Clyra's
 * richer video-evidence pipeline as the default.
 */

export type AutoClipHealth = {
  status?: string;
  version?: string;
  running_job?: string | null;
  queued?: number;
};

export type AutoClipJob = {
  id: string;
  status: "queued" | "running" | "failed" | "done" | "cancelled" | string;
  current_stage?: string;
  progress?: number;
  error?: string | null;
};

export type AutoClipExport = {
  id: string;
  download_url: string;
  size_bytes?: number;
};

export type AutoClipClip = {
  id: string;
  rank: number;
  start_s: number;
  end_s: number;
  duration_s: number;
  title: string;
  hook?: string;
  score?: number;
  reason?: string;
  exports?: AutoClipExport[];
};

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

/**
 * Only a loopback worker is enabled by default. A remote worker needs an
 * explicit opt-in because Clyra will upload the user-selected source URL to
 * it. This keeps the optional integration local-first by default.
 */
export function configuredAutoClipBaseUrl(environment: NodeJS.ProcessEnv = process.env): string | null {
  const raw = String(environment.CLYRA_AUTOCLIP_URL || "").trim();
  if (!raw) return null;

  try {
    const url = new URL(raw);
    if (!/^https?:$/.test(url.protocol)) return null;
    if (!LOOPBACK_HOSTS.has(url.hostname) && environment.CLYRA_AUTOCLIP_ALLOW_REMOTE !== "true") return null;
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

/** Maps AutoClip's persisted job stages onto Clyra's established progress UI. */
export function clyraStageForAutoClip(stage?: string): string {
  const value = String(stage || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (["ingest", "prepare", "probe", "transcribe"].includes(value)) return "captions";
  if (["vad", "audio"].includes(value)) return "audio";
  if (["scene_detect", "scenes", "reframe"].includes(value)) return "vision";
  if (["highlight", "highlights", "select", "rank"].includes(value)) return "analyze";
  if (["caption", "captions"].includes(value)) return "subtitles";
  if (["export", "render"].includes(value)) return "render";
  if (["done", "complete"].includes(value)) return "complete";
  return "captions";
}

export function autoClipStatusMessage(job: Pick<AutoClipJob, "status" | "current_stage" | "progress">): string {
  const stage = String(job.current_stage || "preparing").replace(/_/g, " ");
  const rawProgress = Number(job.progress);
  const percent = rawProgress > 1 ? rawProgress : rawProgress * 100;
  const progress = Number.isFinite(rawProgress) ? ` ${Math.round(percent)}%` : "";
  return `${stage.charAt(0).toUpperCase()}${stage.slice(1)}${progress}`.trim();
}
