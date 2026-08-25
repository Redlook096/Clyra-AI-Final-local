/**
 * Real disk-space requirement check before an Xcode install — one of the
 * two explicitly legitimate reasons to stop (the other being Apple auth).
 * Apple doesn't publish an API for this either, so these figures come from
 * Apple's own installer-visible sizes for the current Xcode 26.x line
 * (observed download ~9-11GB .xip, ~15-18GB unpacked app, ~2-9GB per iOS
 * Simulator runtime depending on included device families) — quoted as a
 * range with a safety margin, not a false-precision single number.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// GB, conservative (high) estimates so we ask for headroom rather than
// leave a user stuck mid-extraction with a full disk.
const XCODE_XIP_DOWNLOAD_GB = 12;
const XCODE_UNPACKED_GB = 18;
const IOS_RUNTIME_GB = 9;
const EXTRACTION_TEMP_GB = XCODE_XIP_DOWNLOAD_GB; // .xip needs its own size again in scratch space while unarchiving
const SAFETY_MARGIN_GB = 5;

export type DiskSpaceCheck = {
  availableGB: number;
  requiredGB: number;
  breakdown: { label: string; gb: number }[];
  sufficient: boolean;
  shortfallGB: number;
};

export async function checkDiskSpace(): Promise<DiskSpaceCheck> {
  const { stdout } = await execFileAsync("df", ["-g", "/"], { timeout: 5_000 });
  const line = stdout.trim().split("\n")[1];
  const availableGB = Number(line?.split(/\s+/)[3]) || 0;

  const breakdown = [
    { label: "Xcode .xip download", gb: XCODE_XIP_DOWNLOAD_GB },
    { label: "Temporary extraction scratch space", gb: EXTRACTION_TEMP_GB },
    { label: "Unpacked Xcode.app", gb: XCODE_UNPACKED_GB },
    { label: "One iOS Simulator runtime", gb: IOS_RUNTIME_GB },
    { label: "Safety margin", gb: SAFETY_MARGIN_GB },
  ];
  // The .xip download and its extraction scratch space are freed once
  // Xcode.app is unpacked, but both must fit AT ONCE during install — the
  // real peak requirement is (download + scratch + final app + runtime),
  // not their sum after cleanup. Using the peak is the conservative,
  // correct number to check against.
  const requiredGB = breakdown.reduce((sum, b) => sum + b.gb, 0);

  return {
    availableGB,
    requiredGB,
    breakdown,
    sufficient: availableGB >= requiredGB,
    shortfallGB: Math.max(0, requiredGB - availableGB),
  };
}
