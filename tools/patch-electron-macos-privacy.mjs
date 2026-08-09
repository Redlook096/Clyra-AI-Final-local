#!/usr/bin/env node
/**
 * Give each Electron.dev binary a unique macOS identity so Privacy → Microphone
 * / Camera lists "Clyra" or "OpenCluely" instead of a shared "Electron" entry
 * that never appears or fights the other app for TCC.
 *
 * After rewriting Info.plist we must ad-hoc codesign the .app (and helpers),
 * otherwise macOS ignores the new name and the app never shows in Settings.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

function plistBuddy(plist, args) {
  execFileSync("/usr/libexec/PlistBuddy", [...args, plist], { stdio: "pipe" });
}

function setOrAdd(plist, key, type, value) {
  try {
    plistBuddy(plist, ["-c", `Set :${key} ${value}`]);
  } catch {
    plistBuddy(plist, ["-c", `Add :${key} ${type} ${value}`]);
  }
}

function listHelperApps(appPath) {
  const frameworks = path.join(appPath, "Contents", "Frameworks");
  if (!fs.existsSync(frameworks)) return [];
  return fs
    .readdirSync(frameworks)
    .filter((name) => name.endsWith(".app"))
    .map((name) => path.join(frameworks, name));
}

const ENTITLEMENTS = path.join(__dirname, "electron-dev.entitlements");

function adHocSign(targetPath, { withEntitlements = false } = {}) {
  if (process.platform !== "darwin") return;
  // Fresh Electron downloads on this machine are often unsigned. Use --deep so
  // nested frameworks get an ad-hoc seal. Do NOT enable hardened runtime
  // (`--options runtime`) — that requires Apple's full entitlement set and
  // will make Chromium exit before a window opens.
  const args = ["--force", "--deep", "--sign", "-", "--timestamp=none"];
  if (withEntitlements && fs.existsSync(ENTITLEMENTS)) {
    args.push("--entitlements", ENTITLEMENTS);
  }
  execFileSync("codesign", [...args, targetPath], { stdio: "pipe" });
}

export function patchElectronApp({
  appPath,
  bundleId,
  bundleName,
  displayName = bundleName,
  microphoneDescription,
  cameraDescription,
  screenDescription,
  resign = process.env.CLYRA_ELECTRON_CODESIGN === "1",
}) {
  if (process.platform !== "darwin") return { ok: false, reason: "not-darwin" };
  const plist = path.join(appPath, "Contents", "Info.plist");
  if (!fs.existsSync(plist)) return { ok: false, reason: "missing-plist", plist };

  setOrAdd(plist, "CFBundleIdentifier", "string", bundleId);
  setOrAdd(plist, "CFBundleName", "string", bundleName);
  setOrAdd(plist, "CFBundleDisplayName", "string", displayName);
  // Continuity Camera / modern AVCapture device types on recent macOS.
  setOrAdd(plist, "NSCameraUseContinuityCameraDeviceType", "bool", "true");
  if (microphoneDescription) {
    setOrAdd(plist, "NSMicrophoneUsageDescription", "string", microphoneDescription);
  }
  if (cameraDescription) {
    setOrAdd(plist, "NSCameraUsageDescription", "string", cameraDescription);
  }
  if (screenDescription) {
    setOrAdd(plist, "NSScreenCaptureUsageDescription", "string", screenDescription);
  }

  const helpers = listHelperApps(appPath);
  for (const helperApp of helpers) {
    const helperPlist = path.join(helperApp, "Contents", "Info.plist");
    if (!fs.existsSync(helperPlist)) continue;
    const base = path.basename(helperApp, ".app");
    const suffix = base
      .replace(/^Electron Helper/, "")
      .replace(/[()]/g, "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ".") || "helper";
    const helperId = `${bundleId}.${suffix === "helper" ? "helper" : `helper.${suffix}`}`;
    setOrAdd(helperPlist, "CFBundleIdentifier", "string", helperId);
    setOrAdd(helperPlist, "CFBundleName", "string", `${bundleName} Helper`);
    setOrAdd(helperPlist, "CFBundleDisplayName", "string", `${displayName} Helper`);
    if (microphoneDescription) {
      setOrAdd(helperPlist, "NSMicrophoneUsageDescription", "string", microphoneDescription);
    }
    if (cameraDescription) {
      setOrAdd(helperPlist, "NSCameraUsageDescription", "string", cameraDescription);
    }
  }

  let signed = false;
  let signError = null;
  if (resign) {
    try {
      // Helpers first (with mic/camera entitlements), then deep-sign the .app.
      for (const helperApp of helpers) {
        adHocSign(helperApp, { withEntitlements: true });
      }
      adHocSign(appPath, { withEntitlements: true });
      signed = true;
    } catch (error) {
      signError = error instanceof Error ? error.message : String(error || "codesign failed");
      // Fallback: deep ad-hoc without entitlements still seals the bundle so
      // TCC can attribute prompts to CFBundleName ("Clyra" / "OpenCluely").
      try {
        for (const helperApp of helpers) {
          adHocSign(helperApp, { withEntitlements: false });
        }
        adHocSign(appPath, { withEntitlements: false });
        signed = true;
        signError = signError ? `${signError} (fell back to deep ad-hoc)` : null;
      } catch (fallbackError) {
        signError = fallbackError instanceof Error
          ? fallbackError.message
          : String(fallbackError || signError || "codesign failed");
      }
    }
  }

  return {
    ok: true,
    appPath,
    bundleId,
    bundleName,
    helpers: helpers.length,
    signed,
    signError,
  };
}

export function patchClyraElectron() {
  return patchElectronApp({
    appPath: path.join(root, "node_modules", "electron", "dist", "Electron.app"),
    bundleId: "ai.clyra.desktop.dev",
    bundleName: "Clyra",
    microphoneDescription: "Clyra needs microphone access for Voice Call and Cmd+Shift+K dictation.",
    cameraDescription: "Clyra needs camera access for Voice Call camera vision.",
    screenDescription: "Clyra needs screen recording access to share your screen in Voice Call.",
  });
}

export function patchOpenCluelyElectron() {
  return patchElectronApp({
    appPath: path.join(root, "apps", "opencluely", "node_modules", "electron", "dist", "Electron.app"),
    bundleId: "ai.clyra.opencluely.dev",
    bundleName: "OpenCluely",
    microphoneDescription: "OpenCluely uses the microphone to transcribe your speech.",
    cameraDescription: "OpenCluely uses the camera when you ask it to see you.",
    screenDescription: "OpenCluely captures your screen to answer questions about what’s open.",
  });
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  const target = process.argv[2] || "both";
  const results = [];
  if (target === "clyra" || target === "both") results.push(patchClyraElectron());
  if (target === "opencluely" || target === "both") results.push(patchOpenCluelyElectron());
  for (const result of results) {
    console.log(JSON.stringify(result));
  }
}
