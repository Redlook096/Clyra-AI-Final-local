import { useCallback, useEffect, useState } from "react";
import { Check, ChevronRight, Copy, RefreshCw, Terminal } from "lucide-react";
import { cn } from "../../lib/utils";
import { api, type XcodeDiagnosis } from "./api";
import { IPhoneInstallTerminal } from "./IPhoneInstallTerminal";

const STATE_COPY: Record<XcodeDiagnosis["state"], { title: string; body: string }> = {
  NO_XCODE: {
    title: "No developer tools found",
    body: "Clyra couldn't find any Xcode command-line tools on this Mac.",
  },
  COMMAND_LINE_TOOLS_ONLY: {
    title: "Full Xcode is required",
    body: "Only Command Line Tools are installed. The real iOS Simulator needs the full Xcode app from the App Store.",
  },
  XCODE_INSTALLED_NOT_SELECTED: {
    title: "Xcode is installed but not selected",
    body: "Xcode.app is on this Mac, but Command Line Tools is still the active developer directory.",
  },
  XCODE_NEEDS_FIRST_LAUNCH: {
    title: "Xcode needs its first launch",
    body: "Xcode is selected but hasn't finished its one-time license/component setup yet.",
  },
  NO_IOS_RUNTIME: {
    title: "No iOS Simulator runtime installed",
    body: "Xcode is ready, but no iOS runtime is installed yet (Xcode ▸ Settings ▸ Platforms).",
  },
  READY: { title: "Ready", body: "" },
};

/** One-time setup wizard shown in the iPhone panel until the Apple Host reaches READY. Every state and action here is driven by a real backend diagnosis — no fake progress. */
export function IPhoneSetupWizard({ projectId, onReady }: { projectId?: string | null; onReady?: () => void }) {
  const [diag, setDiag] = useState<XcodeDiagnosis | null>(null);
  const [checking, setChecking] = useState(false);
  const [versions, setVersions] = useState<Array<{ version: string; build: string; installed: boolean }>>([]);
  const [showVersions, setShowVersions] = useState(false);
  const [recommended, setRecommended] = useState<string | null>(null);
  const [command, setCommand] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [runningInstall, setRunningInstall] = useState(false);

  const check = useCallback(async () => {
    setChecking(true);
    try {
      const result = await api.iphoneSetupDiagnose();
      setDiag(result);
      if (result.state === "READY") onReady?.();
    } finally {
      setChecking(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Diagnose once on mount only — the caller's onReady prop is commonly an
  // inline closure that changes identity every render, and each diagnosis
  // spawns several real subprocesses (sw_vers/xcode-select/xcrun), so this
  // must not re-run on every parent re-render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void check(); }, []);

  const loadVersions = useCallback(async () => {
    setShowVersions(true);
    const [{ versions: found }, rec] = await Promise.all([
      api.iphoneXcodeVersions(),
      api.iphoneRecommendedXcode().catch(() => null),
    ]);
    // Skip betas/RCs by default — a beginner picking "Install Xcode" should
    // land on the newest *stable* release, not a beta.
    setVersions(found.filter((v) => !/beta|rc|release candidate/i.test(v.version)));
    if (rec?.recommendedXcode) {
      setRecommended(rec.recommendedXcode);
      void pickVersion(rec.recommendedXcode);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pickVersion = useCallback(async (version: string) => {
    const { command: cmd } = await api.iphoneInstallCommand(version);
    setCommand(cmd);
    setCopied(false);
  }, []);

  if (!diag) {
    return <div className="flex h-full w-full items-center justify-center"><div className="cc-preview-loader" aria-hidden /></div>;
  }

  const copy = STATE_COPY[diag.state];
  const steps: Array<{ label: string; done: boolean; active: boolean }> = [
    { label: "Mac Host", done: true, active: false },
    { label: "Xcode", done: diag.state !== "NO_XCODE" && diag.state !== "COMMAND_LINE_TOOLS_ONLY" && diag.state !== "XCODE_INSTALLED_NOT_SELECTED" && diag.state !== "XCODE_NEEDS_FIRST_LAUNCH", active: ["NO_XCODE", "COMMAND_LINE_TOOLS_ONLY", "XCODE_INSTALLED_NOT_SELECTED", "XCODE_NEEDS_FIRST_LAUNCH"].includes(diag.state) },
    { label: "iOS Runtime", done: diag.state === "READY", active: diag.state === "NO_IOS_RUNTIME" },
    { label: "Simulator Device", done: diag.state === "READY" && diag.devices.length > 0, active: diag.state === "READY" && diag.devices.length === 0 },
  ];

  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-5 overflow-y-auto px-6 py-8">
      <div className="flex items-center gap-2">
        {steps.map((step, i) => (
          <div key={step.label} className="flex items-center gap-2">
            <div className={cn("flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-medium", step.done ? "bg-[#3977F6] text-white" : step.active ? "bg-[#E8F0FE] text-[#3977F6]" : "bg-[#F1F1F0] text-[#96989D]")}>
              {step.done ? <Check className="h-3 w-3" /> : i + 1}
            </div>
            {i < steps.length - 1 ? <ChevronRight className="h-3 w-3 text-[#D6D6D5]" /> : null}
          </div>
        ))}
      </div>

      <div className="flex max-w-[420px] flex-col items-center gap-2 text-center">
        <p className="text-[14px] font-medium text-[#202124]">iPhone Setup Required</p>
        <p className="text-[13px] font-medium text-[#3D3F43]">{copy.title}</p>
        <p className="text-[11.5px] leading-[1.5] text-[#84868B]">{copy.body}</p>
        <p className="mt-1 text-[10.5px] text-[#B3B4B8]">
          {diag.macOSVersion ? `macOS ${diag.macOSVersion} · ${diag.arch}` : diag.arch}
          {diag.xcodeVersion ? ` · Xcode ${diag.xcodeVersion}` : ""}
        </p>
      </div>

      {diag.state === "COMMAND_LINE_TOOLS_ONLY" || diag.state === "NO_XCODE" ? (
        !showVersions ? (
          <button type="button" onClick={() => void loadVersions()} className="h-8 rounded-[8px] bg-[#3977F6] px-4 text-[12px] font-medium text-white transition-colors hover:bg-[#2E68E0]">
            Install Xcode
          </button>
        ) : (
          <div className="flex w-full max-w-[420px] flex-col gap-2">
            <p className="text-[10.5px] font-medium text-[#84868B]">Choose the newest stable Xcode compatible with this Mac:</p>
            <div className="max-h-[140px] overflow-y-auto rounded-[8px] border border-black/[0.06]">
              {versions.slice(0, 12).map((v) => (
                <button key={v.build} type="button" onClick={() => void pickVersion(v.version)} className={cn("flex w-full items-center justify-between px-3 py-[7px] text-left text-[11.5px] transition-colors hover:bg-black/[0.03]", v.version === recommended ? "bg-[#E8F0FE] text-[#3977F6]" : "text-[#202124]")}>
                  <span className="flex items-center gap-1.5">
                    {v.version}
                    {v.version === recommended ? <span className="rounded-full bg-[#3977F6] px-1.5 py-[1px] text-[9px] font-medium text-white">Recommended</span> : null}
                  </span>
                  <span className="text-[10px] text-[#96989D]">{v.build}</span>
                </button>
              ))}
            </div>
            {runningInstall && command ? (
              <IPhoneInstallTerminal projectId={projectId!} command={command} onDone={() => void check()} />
            ) : command ? (
              <div className="flex flex-col gap-2 rounded-[8px] bg-[#F6F6F5] p-3 text-left">
                {projectId ? (
                  <button type="button" onClick={() => setRunningInstall(true)} className="flex h-8 items-center justify-center gap-1.5 rounded-[7px] bg-[#3977F6] text-[11.5px] font-medium text-white transition-colors hover:bg-[#2E68E0]">
                    <Terminal className="h-3.5 w-3.5" /> Install (opens a real terminal — Apple sign-in happens there, not in Clyra)
                  </button>
                ) : null}
                <p className="text-[10.5px] text-[#84868B]">Or run this yourself in your own Terminal:</p>
                <div className="flex items-center gap-2 rounded-[6px] bg-white px-2 py-1.5 font-mono text-[11px] text-[#202124]">
                  <code className="flex-1 overflow-x-auto whitespace-nowrap">{command}</code>
                  <button type="button" aria-label="Copy command" onClick={() => { navigator.clipboard.writeText(command).then(() => setCopied(true)).catch(() => undefined); }} className="text-[#96989D] hover:text-[#202124]">
                    {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        )
      ) : diag.state === "XCODE_INSTALLED_NOT_SELECTED" ? (
        <div className="flex flex-col gap-1.5 rounded-[8px] bg-[#F6F6F5] p-3 text-left">
          <p className="text-[10.5px] text-[#84868B]">Run in Terminal (needs your Mac password — Clyra can't do this for you):</p>
          <code className="rounded-[6px] bg-white px-2 py-1.5 text-[11px] text-[#202124]">sudo xcode-select -s /Applications/Xcode.app/Contents/Developer</code>
        </div>
      ) : diag.state === "XCODE_NEEDS_FIRST_LAUNCH" ? (
        <div className="flex flex-col gap-1.5 rounded-[8px] bg-[#F6F6F5] p-3 text-left">
          <code className="rounded-[6px] bg-white px-2 py-1.5 text-[11px] text-[#202124]">xcodebuild -runFirstLaunch</code>
        </div>
      ) : diag.state === "NO_IOS_RUNTIME" ? (
        <p className="text-[11px] text-[#84868B]">Open Xcode ▸ Settings ▸ Platforms and install an iOS runtime, then check again.</p>
      ) : null}

      <button type="button" onClick={() => void check()} disabled={checking} className="flex h-7 items-center gap-1.5 rounded-[7px] border border-black/[0.08] px-3 text-[11.5px] text-[#505258] transition-colors hover:bg-black/[0.03] disabled:opacity-50">
        <RefreshCw className={cn("h-3 w-3", checking && "animate-spin")} />
        Check Again
      </button>
    </div>
  );
}
