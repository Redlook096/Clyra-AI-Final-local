#!/usr/bin/env node
/**
 * Give each Electron.dev binary a unique macOS identity so Privacy → Microphone
 * / Camera lists "Clyra" or "OpenCluely" instead of a shared "Electron" entry
 * that never appears or fights the other app for TCC.
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

export function patchElectronApp({
  appPath,
  bundleId,
  bundleName,
  displayName = bundleName,
  microphoneDescription,
  cameraDescription,
  screenDescription,
}) {
  if (process.platform !== "darwin") return { ok: false, reason: "not-darwin" };
  const plist = path.join(appPath, "Contents", "Info.plist");
  if (!fs.existsSync(plist)) return { ok: false, reason: "missing-plist", plist };

  setOrAdd(plist, "CFBundleIdentifier", "string", bundleId);
  setOrAdd(plist, "CFBundleName", "string", bundleName);
  setOrAdd(plist, "CFBundleDisplayName", "string", displayName);
  if (microphoneDescription) {
    setOrAdd(plist, "NSMicrophoneUsageDescription", "string", microphoneDescription);
  }
  if (cameraDescription) {
    setOrAdd(plist, "NSCameraUsageDescription", "string", cameraDescription);
  }
  if (screenDescription) {
    setOrAdd(plist, "NSScreenCaptureUsageDescription", "string", screenDescription);
  }

  return { ok: true, appPath, bundleId, bundleName };
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
