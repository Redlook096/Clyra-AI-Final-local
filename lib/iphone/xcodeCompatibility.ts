/**
 * Picks a genuinely compatible Xcode version instead of always recommending
 * the newest release.
 *
 * Corrected after a real defect: the first version of this resolver only
 * tracked compatibility per Xcode MAJOR version (e.g. "Xcode 26.x needs
 * macOS 15+"), which is wrong — Apple's actual minimum macOS requirement
 * changes between MINOR versions within the same major, particularly around
 * the 26.x line (26.3 still supports macOS Sequoia 15.6+, but 26.4/26.5/26.6
 * require macOS Tahoe 26.2+). That bug would have recommended installing an
 * Xcode build this exact Mac (macOS 15.7.7) cannot run. Fixed by keyeing the
 * table per exact version.
 *
 * There is no API that returns "which Xcode versions run on macOS 15.7.7" —
 * Apple publishes this only as prose in each version's release notes, and
 * `xcodes` itself doesn't expose it either (it only reports the versions
 * that EXIST, not which ones a given macOS can run). The table below is
 * manually curated from those release notes and needs periodic verification
 * against Apple's current documentation — it is not derived from a live
 * API, which the `sourceEvidence`/`confidence` fields on the result make
 * explicit rather than overstating certainty.
 */
import { listAvailableXcodeVersions, type XcodeVersionListing } from "./xcodeSetup";

/** Minimum macOS version each specific Xcode version requires, per Apple's release notes. Ordered newest-first; a version not listed falls back to its nearest older documented entry within the same major (conservative). */
const MIN_MACOS_FOR_XCODE_VERSION: Array<{ version: string; minMacOS: string }> = [
  { version: "26.6", minMacOS: "26.2" },
  { version: "26.5", minMacOS: "26.2" },
  { version: "26.4.1", minMacOS: "26.2" },
  { version: "26.4", minMacOS: "26.2" },
  { version: "26.3", minMacOS: "15.6" },
  { version: "26.2", minMacOS: "15.6" },
  { version: "26.1", minMacOS: "15.6" },
  { version: "26.0.1", minMacOS: "15.6" },
  { version: "26.0", minMacOS: "15.6" },
  { version: "16.4", minMacOS: "14.5" },
  { version: "16.0", minMacOS: "14.5" },
  { version: "15.0", minMacOS: "13.5" },
  { version: "14.0", minMacOS: "12.5" },
];

function parseVersion(value: string): number[] {
  return value.trim().split(".").map((p) => Number(p.replace(/[^\d]/g, ""))).filter((n) => !Number.isNaN(n));
}

function compareVersionArrays(a: number[], b: number[]) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** The minimum-macOS requirement for a given Xcode version — its exact table entry, or the nearest older entry within the same major if this exact build isn't listed. */
function minMacOSFor(xcodeVersion: string): string | null {
  const exact = MIN_MACOS_FOR_XCODE_VERSION.find((r) => r.version === xcodeVersion.trim());
  if (exact) return exact.minMacOS;
  const parts = parseVersion(xcodeVersion);
  const major = parts[0];
  if (major === undefined) return null;
  const sameMajor = MIN_MACOS_FOR_XCODE_VERSION
    .filter((r) => parseVersion(r.version)[0] === major)
    .sort((a, b) => compareVersionArrays(parseVersion(b.version), parseVersion(a.version)));
  const olderOrEqual = sameMajor.find((r) => compareVersionArrays(parseVersion(r.version), parts) <= 0);
  return (olderOrEqual ?? sameMajor[sameMajor.length - 1])?.minMacOS ?? null;
}

export type CompatibilityResult = {
  macOSVersion: string;
  architecture: string;
  compatibleXcodes: string[];
  recommendedXcode: string | null;
  confidence: "curated-table" | "no-data";
  sourceEvidence: string[];
  blockedReason: string | null;
};

export async function recommendXcodeVersion(hostMacOSVersion: string, architecture = "x86_64"): Promise<CompatibilityResult> {
  const hostParts = parseVersion(hostMacOSVersion);
  const versions = await listAvailableXcodeVersions();
  const stable = versions.filter((v) => !/beta|rc|release candidate/i.test(v.version));

  const compatible = stable.filter((v) => {
    const minMacOS = minMacOSFor(v.version);
    if (!minMacOS) return false;
    return compareVersionArrays(hostParts, parseVersion(minMacOS)) >= 0;
  });

  const sourceEvidence = [
    `xcodes list: ${versions.length} cataloged releases (${stable.length} stable)`,
    `curated minimum-macOS table: ${MIN_MACOS_FOR_XCODE_VERSION.length} entries, keyed per exact version (not per major)`,
    `host: macOS ${hostMacOSVersion}, ${architecture}`,
  ];

  if (!compatible.length) {
    return {
      macOSVersion: hostMacOSVersion, architecture, compatibleXcodes: [], recommendedXcode: null,
      confidence: "curated-table", sourceEvidence,
      blockedReason: `No cataloged stable Xcode version is documented to run on macOS ${hostMacOSVersion}. This Mac may need a macOS update, or an older Xcode outside the curated table's range — verify manually at https://developer.apple.com/support/xcode/.`,
    };
  }

  const sorted = [...compatible].sort((a, b) => compareVersionArrays(parseVersion(b.version), parseVersion(a.version)));
  return {
    macOSVersion: hostMacOSVersion, architecture,
    compatibleXcodes: sorted.map((v) => v.version),
    recommendedXcode: sorted[0].version,
    confidence: "curated-table",
    sourceEvidence,
    blockedReason: null,
  };
}
