import { existsSync } from "node:fs";
import path from "node:path";

export function clyraResourceRoot() {
  return process.env.CLYRA_RESOURCE_ROOT || process.cwd();
}

export function clyraDataRoot() {
  return process.env.CLYRA_DATA_ROOT || process.cwd();
}

export function clyraResourcePath(...segments: string[]) {
  return path.join(clyraResourceRoot(), ...segments);
}

export function clyraDataPath(...segments: string[]) {
  return path.join(clyraDataRoot(), ...segments);
}

/** Canonical writable dir for rendered clip MP4s (Electron userData or cwd). */
export function clipperOutputDir() {
  return process.env.CLYRA_OUTPUT_DIR || clyraDataPath("output");
}

/**
 * Resolve a clip filename across data-root, project resource, and cwd outputs.
 * Electron serves from CLYRA_DATA_ROOT while CLI/dev pipelines often write to ./output.
 */
export function resolveClipperMediaPath(filename: string) {
  const safe = path.basename(filename || "");
  if (!/^[\w.-]+\.mp4$/i.test(safe)) return null;
  const candidates = [
    path.join(clipperOutputDir(), safe),
    clyraDataPath("output", safe),
    clyraResourcePath("output", safe),
    path.join(process.cwd(), "output", safe),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}
