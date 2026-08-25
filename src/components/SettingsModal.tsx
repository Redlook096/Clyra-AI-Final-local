import { useEffect, useMemo, useRef, useState, type ReactNode, type MouseEvent } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  Bot,
  ChartNoAxesCombined,
  ChevronRight,
  Code2,
  Download,
  Headphones,
  MessageCircle,
  Monitor,
  Palette,
  Play,
  RotateCcw,
  RefreshCw,
  Shield,
  Trash2,
  Type,
  X,
} from "lucide-react";
import { cn } from "../lib/utils";
import type { OrbColorTheme } from "./AiOrb";

type SettingsModalProps = {
  isOpen: boolean;
  onClose: () => void;
  theme: string;
  setTheme: (value: string) => void;
  sendOnEnter: boolean;
  setSendOnEnter: (value: boolean) => void;
  fontSize: string;
  setFontSize: (value: string) => void;
  clearChats: () => void;
  autoScroll: boolean;
  setAutoScroll: (value: boolean) => void;
  animationSpeed?: number;
  setAnimationSpeed?: (value: number) => void;
  codeHighlighting: boolean;
  setCodeHighlighting: (value: boolean) => void;
  markdownSupport: boolean;
  setMarkdownSupport: (value: boolean) => void;
  systemPrompt: string;
  setSystemPrompt: (value: string) => void;
  temperature: number;
  setTemperature: (value: number) => void;
  userBubbleColor: string;
  setUserBubbleColor: (value: string) => void;
  orbColorTheme: OrbColorTheme;
  setOrbColorTheme: (value: OrbColorTheme) => void;
  voiceRate: number;
  setVoiceRate: (value: number) => void;
  voicePitch: number;
  setVoicePitch: (value: number) => void;
  voiceVolume: number;
  setVoiceVolume: (value: number) => void;
  voiceTestMode: boolean;
  setVoiceTestMode: (value: boolean) => void;
  chats: unknown[];
};

const EASE_OUT = [0.16, 1, 0.3, 1] as [number, number, number, number];

const sections = [
  { id: "look", label: "Appearance", icon: Palette },
  { id: "chat", label: "Conversation", icon: MessageCircle },
  { id: "voice", label: "Voice", icon: Bot },
  { id: "advanced", label: "Model", icon: Monitor },
  { id: "usage", label: "Usage", icon: ChartNoAxesCombined },
  { id: "data", label: "Privacy", icon: Shield },
] as const;

const bubbleColors = [
  { label: "Mist", value: "#F4F4F4" },
  { label: "Sky", value: "#DBEAFE" },
  { label: "Mint", value: "#DCFCE7" },
  { label: "Lilac", value: "#F3E8FF" },
  { label: "Rose", value: "#FFE4E6" },
];

const voicePresets = [
  { id: "calm", label: "Calm", detail: "Warm and measured", rate: 0.88, pitch: 0.98, volume: 0.9 },
  { id: "natural", label: "Natural", detail: "Balanced conversation", rate: 0.94, pitch: 1.03, volume: 0.96 },
  { id: "bright", label: "Bright", detail: "Clear with energy", rate: 1.02, pitch: 1.1, volume: 0.92 },
] as const;

const modelPresets = [
  { label: "Precise", detail: "Shorter, direct answers", temperature: 0.1 },
  { label: "Balanced", detail: "Useful default", temperature: 0.7 },
  { label: "Creative", detail: "More exploration", temperature: 1 },
] as const;

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      aria-label={label}
      aria-pressed={checked}
      className={cn(
        "relative h-6 w-11 rounded-full p-0.5 transition-colors duration-200",
        checked ? "bg-blue-600" : "bg-slate-200 hover:bg-slate-300",
      )}
    >
      <motion.span
        layout
        transition={{ type: "spring", stiffness: 600, damping: 40 }}
        className={cn(
          "block h-5 w-5 rounded-full bg-white shadow-sm",
          checked && "ml-5",
        )}
      />
    </button>
  );
}

function SettingRow({
  title,
  detail,
  children,
}: {
  title: string;
  detail?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-6 py-4">
      <div className="min-w-0">
        <p className="text-[14px] font-medium text-slate-800">{title}</p>
        {detail ? <p className="mt-0.5 text-[12px] leading-snug text-slate-500">{detail}</p> : null}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function Segmented<T extends string | number>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: Array<{ label: string; value: T }>;
  onChange: (value: T) => void;
}) {
  return (
    <div className="inline-flex rounded-xl border border-slate-200/80 bg-slate-50 p-0.5">
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={String(option.value)}
            type="button"
            onClick={() => onChange(option.value)}
            className={cn(
              "relative min-w-[4.5rem] rounded-[10px] px-3 py-1.5 text-[13px] font-medium transition-all duration-150",
              active ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

function RangeControl({
  label,
  value,
  min,
  max,
  step,
  onChange,
  valueLabel,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  valueLabel: string;
}) {
  const percent = ((value - min) / (max - min)) * 100;
  return (
    <div className="py-4">
      <div className="mb-3 flex items-end justify-between gap-4">
        <p className="text-[14px] font-medium text-slate-800">{label}</p>
        <p className="text-[12px] text-slate-500">{valueLabel}</p>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="h-1.5 w-full cursor-pointer appearance-none rounded-full outline-none"
        style={{
          background: `linear-gradient(90deg, #2563eb ${percent}%, #e2e8f0 ${percent}%)`,
          accentColor: "#2563eb",
        }}
      />
    </div>
  );
}

export function SettingsModal({
  isOpen,
  onClose,
  theme,
  setTheme,
  sendOnEnter,
  setSendOnEnter,
  fontSize,
  setFontSize,
  clearChats,
  autoScroll,
  setAutoScroll,
  codeHighlighting,
  setCodeHighlighting,
  markdownSupport,
  setMarkdownSupport,
  systemPrompt,
  setSystemPrompt,
  temperature,
  setTemperature,
  userBubbleColor,
  setUserBubbleColor,
  orbColorTheme,
  setOrbColorTheme,
  voiceRate,
  setVoiceRate,
  voicePitch,
  setVoicePitch,
  voiceVolume,
  setVoiceVolume,
  voiceTestMode,
  setVoiceTestMode,
  chats,
}: SettingsModalProps) {
  const [activeSection, setActiveSection] = useState<(typeof sections)[number]["id"]>("look");
  const [voicePreviewState, setVoicePreviewState] = useState<"idle" | "loading" | "error">("idle");
  const [usage, setUsage] = useState<any>(null);
  const [usageState, setUsageState] = useState<"idle" | "loading" | "error">("idle");
  const voicePreviewRef = useRef<{ audio: HTMLAudioElement; url: string } | null>(null);
  const chatCount = chats.length;
  void orbColorTheme;
  void setOrbColorTheme;
  const activeMeta = useMemo(
    () => sections.find((section) => section.id === activeSection) ?? sections[0],
    [activeSection],
  );

  const closeSettings = (event?: MouseEvent<HTMLElement>) => {
    event?.preventDefault();
    event?.stopPropagation();
    onClose();
  };

  const applyVoicePreset = (preset: (typeof voicePresets)[number]) => {
    setVoiceRate(preset.rate);
    setVoicePitch(preset.pitch);
    setVoiceVolume(preset.volume);
  };

  const refreshUsage = async () => {
    setUsageState("loading");
    try {
      const response = await fetch("/api/usage", { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok || !payload?.ok) throw new Error("Usage unavailable");
      setUsage(payload);
      setUsageState("idle");
    } catch {
      setUsageState("error");
    }
  };

  useEffect(() => {
    if (!isOpen || activeSection !== "usage") return;
    void refreshUsage();
    const interval = window.setInterval(() => void refreshUsage(), 5_000);
    return () => window.clearInterval(interval);
  }, [isOpen, activeSection]);

  useEffect(() => () => {
    voicePreviewRef.current?.audio.pause();
    if (voicePreviewRef.current?.url) URL.revokeObjectURL(voicePreviewRef.current.url);
  }, []);

  const previewVoicePreset = async (preset: (typeof voicePresets)[number]) => {
    applyVoicePreset(preset);
    voicePreviewRef.current?.audio.pause();
    if (voicePreviewRef.current?.url) URL.revokeObjectURL(voicePreviewRef.current.url);
    voicePreviewRef.current = null;
    setVoicePreviewState("loading");
    try {
      const response = await fetch("/api/creator/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: `Hi, I'm Max. This is how I'll sound in a natural Clyra conversation.`,
          voice: "Max",
        }),
      });
      if (!response.ok) throw new Error("Async Voice preview is unavailable");
      const url = URL.createObjectURL(await response.blob());
      const audio = new Audio(url);
      audio.playbackRate = preset.rate;
      audio.volume = preset.volume;
      audio.onended = () => {
        URL.revokeObjectURL(url);
        if (voicePreviewRef.current?.url === url) voicePreviewRef.current = null;
      };
      voicePreviewRef.current = { audio, url };
      await audio.play();
      setVoicePreviewState("idle");
    } catch {
      setVoicePreviewState("error");
    }
  };

  const exportChats = () => {
    const blob = new Blob([JSON.stringify(chats, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "clyra-chat-export.json";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <AnimatePresence>
      {isOpen ? (
        <motion.div
          className="fixed inset-0 z-[100] grid place-items-center p-4 sm:p-6"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
        >
          <motion.button
            type="button"
            aria-label="Close settings"
            className="absolute inset-0 bg-black/30 backdrop-blur-xl"
            onClick={closeSettings}
            tabIndex={-1}
          />
          <motion.section
            role="dialog"
            aria-modal="true"
            aria-label="Settings"
            initial={{ opacity: 0, y: 16, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={{ duration: 0.3, ease: EASE_OUT }}
            className="relative grid h-[min(620px,90vh)] w-full max-w-[800px] overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-[0_2px_24px_rgba(0,0,0,.08)] sm:grid-cols-[220px_1fr]"
          >
            <aside className="hidden border-r border-slate-100 bg-slate-50/60 p-3 sm:flex sm:flex-col">
              <div className="px-3 pb-6 pt-4">
                <p className="text-[18px] font-semibold tracking-[-0.02em] text-slate-900">Settings</p>
              </div>
              <nav className="space-y-0.5" aria-label="Settings sections">
                {sections.map((section) => {
                  const Icon = section.icon;
                  const active = section.id === activeSection;
                  return (
                    <button
                      key={section.id}
                      type="button"
                      onClick={() => setActiveSection(section.id)}
                      className={cn(
                        "group flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-left text-[13px] font-medium transition-all duration-150",
                        active
                          ? "bg-white text-slate-900 shadow-sm ring-1 ring-slate-200/80"
                          : "text-slate-500 hover:bg-white/80 hover:text-slate-800",
                      )}
                    >
                      <Icon className={cn("h-4 w-4 transition-colors", active ? "text-slate-700" : "text-slate-400 group-hover:text-slate-500")} />
                      <span className="flex-1">{section.label}</span>
                      {active ? <ChevronRight className="h-3.5 w-3.5 text-slate-400" /> : null}
                    </button>
                  );
                })}
              </nav>
            </aside>

            <div className="flex min-h-0 flex-col bg-white">
              <header className="flex h-14 shrink-0 items-center justify-between border-b border-slate-100 px-6">
                <h2 className="text-[16px] font-semibold tracking-[-0.01em] text-slate-900">{activeMeta.label}</h2>
                <button
                  type="button"
                  onClick={closeSettings}
                  className="grid h-8 w-8 place-items-center rounded-lg text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
                  aria-label="Close settings"
                >
                  <X className="h-4 w-4" />
                </button>
              </header>

              <div className="flex gap-1 overflow-x-auto border-b border-slate-100 px-4 py-2 sm:hidden">
                {sections.map((section) => (
                  <button
                    key={section.id}
                    type="button"
                    onClick={() => setActiveSection(section.id)}
                    className={cn(
                      "rounded-lg px-3 py-1.5 text-[13px] font-medium transition-colors",
                      section.id === activeSection
                        ? "bg-slate-900 text-white"
                        : "text-slate-500 hover:text-slate-900",
                    )}
                  >
                    {section.label}
                  </button>
                ))}
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto px-6 py-2">
                <motion.div
                  key={activeSection}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.2, ease: EASE_OUT }}
                  className="mx-auto max-w-[480px] pb-8"
                >
                  {activeSection === "look" ? (
                    <>
                      <SettingRow title="Theme">
                        <Segmented
                          value={theme}
                          onChange={setTheme}
                          options={[
                            { label: "Light", value: "Light" },
                            { label: "Dark", value: "Dark" },
                          ]}
                        />
                      </SettingRow>
                      <SettingRow title="Text size" detail="Adjust chat reading size.">
                        <Segmented
                          value={fontSize}
                          onChange={setFontSize}
                          options={[
                            { label: "Small", value: "Small" },
                            { label: "Medium", value: "Medium" },
                            { label: "Large", value: "Large" },
                          ]}
                        />
                      </SettingRow>
                      <div className="py-4">
                        <p className="text-[14px] font-medium text-slate-800">Bubble color</p>
                        <p className="mt-0.5 text-[12px] text-slate-500">Color for your chat messages.</p>
                        <div className="mt-3 flex flex-wrap items-center gap-2.5">
                          {bubbleColors.map((color) => (
                            <button
                              key={color.value}
                              type="button"
                              onClick={() => setUserBubbleColor(color.value)}
                              title={color.label}
                              className={cn(
                                "h-8 w-8 rounded-full border border-slate-200/80 transition-all duration-150 hover:scale-110",
                                userBubbleColor === color.value && "ring-2 ring-blue-600 ring-offset-2",
                              )}
                              style={{ backgroundColor: color.value }}
                            />
                          ))}
                          <label
                            className={cn(
                              "relative grid h-8 w-8 cursor-pointer place-items-center overflow-hidden rounded-full border border-slate-200/80 transition-all hover:scale-110",
                              !bubbleColors.some((c) => c.value === userBubbleColor) && "ring-2 ring-blue-600 ring-offset-2",
                            )}
                            title="Custom color"
                          >
                            <span className="absolute inset-0 bg-[conic-gradient(#ef4444,#f59e0b,#22c55e,#06b6d4,#6366f1,#ef4444)]" />
                            <input
                              type="color"
                              value={userBubbleColor}
                              onChange={(event) => setUserBubbleColor(event.target.value)}
                              className="absolute inset-[-10px] h-14 w-14 cursor-pointer opacity-0"
                            />
                          </label>
                        </div>
                      </div>
                    </>
                  ) : null}

                  {activeSection === "chat" ? (
                    <div className="divide-y divide-slate-100">
                      <SettingRow title="Send on Enter" detail="Shift + Enter for a new line.">
                        <Toggle checked={sendOnEnter} onChange={setSendOnEnter} label="Toggle send on Enter" />
                      </SettingRow>
                      <SettingRow title="Auto-scroll" detail="Keep latest response in view.">
                        <Toggle checked={autoScroll} onChange={setAutoScroll} label="Toggle auto-scroll" />
                      </SettingRow>
                      <SettingRow title="Markdown" detail="Render headings, lists, and links.">
                        <Toggle checked={markdownSupport} onChange={setMarkdownSupport} label="Toggle markdown" />
                      </SettingRow>
                      <SettingRow title="Code highlighting" detail="Colorize code blocks.">
                        <Toggle checked={codeHighlighting} onChange={setCodeHighlighting} label="Toggle highlighting" />
                      </SettingRow>
                    </div>
                  ) : null}

                  {activeSection === "voice" ? (
                    <>
                      <div className="grid gap-2 py-4 sm:grid-cols-3">
                        {voicePresets.map((preset) => {
                          const active =
                            Math.abs(voiceRate - preset.rate) < 0.01 &&
                            Math.abs(voicePitch - preset.pitch) < 0.01 &&
                            Math.abs(voiceVolume - preset.volume) < 0.02;
                          return (
                            <button
                              key={preset.id}
                              type="button"
                              onClick={() => applyVoicePreset(preset)}
                              className={cn(
                                "rounded-xl border p-3 text-left transition-all duration-150",
                                active
                                  ? "border-blue-300 bg-blue-50 ring-1 ring-blue-200"
                                  : "border-slate-200/80 hover:border-slate-300 hover:bg-slate-50",
                              )}
                            >
                              <div className="flex items-center justify-between gap-2">
                                <Headphones className={cn("h-4 w-4", active ? "text-blue-600" : "text-slate-400")} />
                                <span
                                  role="button"
                                  tabIndex={0}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    void previewVoicePreset(preset);
                                  }}
                                  onKeyDown={(event) => {
                                    if (event.key === "Enter" || event.key === " ") {
                                      event.preventDefault();
                                      event.stopPropagation();
                                      void previewVoicePreset(preset);
                                    }
                                  }}
                                  className={cn(
                                    "grid h-7 w-7 place-items-center rounded-lg transition-colors",
                                    active ? "bg-blue-600/10 text-blue-600" : "bg-slate-100 text-slate-500 hover:bg-slate-200",
                                  )}
                                >
                                  <Play className="h-3.5 w-3.5" />
                                </span>
                              </div>
                              <p className={cn("mt-2 text-[13px] font-semibold", active ? "text-blue-800" : "text-slate-800")}>{preset.label}</p>
                              <p className="mt-0.5 text-[11px] text-slate-500">{preset.detail}</p>
                            </button>
                          );
                        })}
                      </div>
                      {voicePreviewState !== "idle" ? (
                        <p className={cn("text-[12px] font-medium", voicePreviewState === "error" ? "text-rose-500" : "text-slate-500")}>
                          {voicePreviewState === "loading" ? "Preparing voice preview…" : "Async Voice preview is unavailable."}
                        </p>
                      ) : null}
                      <RangeControl label="Pace" value={voiceRate} min={0.82} max={1.08} step={0.01} onChange={setVoiceRate} valueLabel={voiceRate < 0.91 ? "Calmer" : voiceRate > 1 ? "Quicker" : "Balanced"} />
                      <RangeControl label="Warmth" value={voicePitch} min={0.9} max={1.16} step={0.01} onChange={setVoicePitch} valueLabel={voicePitch < 0.99 ? "Lower" : voicePitch > 1.08 ? "Brighter" : "Natural"} />
                      <RangeControl label="Volume" value={voiceVolume} min={0.5} max={1} step={0.01} onChange={setVoiceVolume} valueLabel={`${Math.round(voiceVolume * 100)}%`} />
                      <SettingRow title="Test Mode" detail="Voice call repeats back what you say instead of using DeepSeek. Use this to check the mic, connection, and Fish Audio voice without spending chat credits.">
                        <Toggle checked={voiceTestMode} onChange={setVoiceTestMode} label="Toggle voice call test mode" />
                      </SettingRow>
                    </>
                  ) : null}

                  {activeSection === "advanced" ? (
                    <>
                      <div className="grid gap-2 py-4 sm:grid-cols-3">
                        {modelPresets.map((preset) => {
                          const active = Math.abs(temperature - preset.temperature) < 0.01;
                          return (
                            <button
                              key={preset.label}
                              type="button"
                              onClick={() => setTemperature(preset.temperature)}
                              className={cn(
                                "rounded-xl border p-3 text-left transition-all duration-150",
                                active
                                  ? "border-blue-300 bg-blue-50 ring-1 ring-blue-200"
                                  : "border-slate-200/80 hover:border-slate-300 hover:bg-slate-50",
                              )}
                            >
                              <p className={cn("text-[13px] font-semibold", active ? "text-blue-800" : "text-slate-800")}>{preset.label}</p>
                              <p className="mt-0.5 text-[12px] text-slate-500">{preset.detail}</p>
                            </button>
                          );
                        })}
                      </div>
                      <div className="py-4">
                        <div className="mb-3 flex items-center gap-2">
                          <Type className="h-4 w-4 text-slate-400" />
                          <p className="text-[14px] font-medium text-slate-800">System prompt</p>
                        </div>
                        <textarea
                          value={systemPrompt}
                          onChange={(event) => setSystemPrompt(event.target.value)}
                          placeholder="Add persistent instructions for Clyra..."
                          spellCheck={false}
                          className="h-28 w-full resize-none rounded-xl border border-slate-200/80 bg-slate-50 px-4 py-3 text-[13px] leading-relaxed text-slate-800 outline-none transition-all placeholder:text-slate-400 focus:border-blue-400 focus:bg-white focus:ring-2 focus:ring-blue-100"
                        />
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {["Be concise and practical.", "Ask one clarifying question.", "Prefer polished UI details."].map((prompt) => (
                          <button
                            key={prompt}
                            type="button"
                            onClick={() => setSystemPrompt(prompt)}
                            className="rounded-full border border-slate-200/80 bg-white px-3 py-1.5 text-[12px] font-medium text-slate-600 transition-all hover:bg-slate-50 hover:text-slate-900"
                          >
                            {prompt}
                          </button>
                        ))}
                      </div>
                      <div className="mt-4 rounded-xl border border-slate-200/80 bg-slate-50 p-3.5 text-[12px] leading-relaxed text-slate-500">
                        <Code2 className="mb-2 h-4 w-4 text-slate-400" />
                        Model routing stays automatic so the app preserves existing OpenAI-compatible API behavior.
                      </div>
                    </>
                  ) : null}

                  {activeSection === "usage" ? (
                    <div className="py-4">
                      <div className="flex items-start justify-between gap-4">
                        <div>
                          <p className="text-[15px] font-semibold tracking-[-.01em] text-slate-900">API usage</p>
                          <p className="mt-1 max-w-[410px] text-[12px] leading-relaxed text-slate-500">Live token and unit metering from completed provider calls. Totals refresh automatically after each use.</p>
                        </div>
                        <button type="button" onClick={() => void refreshUsage()} className="grid h-8 w-8 place-items-center rounded-lg text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800" aria-label="Refresh API usage">
                          <RefreshCw className={cn("h-4 w-4", usageState === "loading" && "animate-spin")} />
                        </button>
                      </div>
                      {usageState === "error" ? <p className="mt-6 rounded-xl bg-rose-50 px-3 py-2 text-[12px] text-rose-700">Usage data is temporarily unavailable. Your API calls continue normally.</p> : null}
                      <div className="mt-5 grid grid-cols-2 gap-2.5">
                        <div className="rounded-xl border border-slate-200/80 bg-slate-50/70 p-3.5"><p className="text-[11px] font-medium text-slate-500">Total cost</p><p className="mt-1 text-[20px] font-semibold tracking-[-.03em] text-slate-900">${Number(usage?.total?.costUsd || 0).toFixed(4)}</p><p className="mt-1 text-[10.5px] text-slate-400">USD · verified rates</p></div>
                        <div className="rounded-xl border border-slate-200/80 bg-slate-50/70 p-3.5"><p className="text-[11px] font-medium text-slate-500">Today</p><p className="mt-1 text-[20px] font-semibold tracking-[-.03em] text-slate-900">{Number(usage?.today?.tokens || 0).toLocaleString()}</p><p className="mt-1 text-[10.5px] text-slate-400">provider tokens</p></div>
                      </div>
                      <div className="mt-5">
                        <div className="mb-2 flex items-center justify-between"><p className="text-[11px] font-medium uppercase tracking-[.08em] text-slate-400">By provider & model</p><p className="text-[10.5px] text-slate-400">{usage?.total?.requests || 0} requests</p></div>
                        <div className="overflow-hidden rounded-xl border border-slate-200/80 bg-white">
                          {(usage?.byModel || []).length ? usage.byModel.slice(0, 6).map((item: any) => <div key={`${item.provider}-${item.model}`} className="flex items-center justify-between gap-3 border-b border-slate-100 px-3.5 py-3 last:border-0"><div className="min-w-0"><p className="truncate text-[12.5px] font-medium text-slate-800">{item.model}</p><p className="mt-0.5 text-[10.5px] text-slate-400">{item.provider} · {Number(item.tokens || 0).toLocaleString()} tokens · {item.requests} requests</p></div><p className={cn("shrink-0 text-[11.5px] font-medium", item.unpricedRequests ? "text-amber-600" : "text-slate-700")}>{item.unpricedRequests ? "Unpriced" : `$${Number(item.costUsd || 0).toFixed(4)}`}</p></div>) : <div className="px-3.5 py-7 text-center text-[12px] text-slate-400">No provider calls recorded yet.</div>}
                        </div>
                      </div>
                      <p className="mt-4 text-[10.5px] leading-relaxed text-slate-400">{usage?.methodology || "Models without a verified rate are labeled Unpriced rather than counted as $0. Usage records never store prompt or response content."}</p>
                      <button type="button" onClick={async () => { await fetch("/api/usage/clear", { method: "POST" }); await refreshUsage(); }} className="mt-4 inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[11.5px] font-medium text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800"><Trash2 className="h-3.5 w-3.5" /> Clear usage history</button>
                    </div>
                  ) : null}

                  {activeSection === "data" ? (
                    <>
                      <div className="mb-4 rounded-xl border border-slate-200/80 bg-slate-50 p-4">
                        <p className="text-[15px] font-semibold text-slate-900">{chatCount} saved chats</p>
                        <p className="mt-1 text-[13px] text-slate-500">Export a local copy or clear browser history.</p>
                      </div>
                      <div className="divide-y divide-slate-100">
                        <SettingRow title="Export chats" detail="Download as JSON.">
                          <button
                            type="button"
                            onClick={exportChats}
                            className="inline-flex items-center gap-2 rounded-xl border border-slate-200/80 bg-white px-3.5 py-2 text-[13px] font-medium text-slate-700 transition-all hover:bg-slate-50"
                          >
                            <Download className="h-4 w-4" />
                            Export
                          </button>
                        </SettingRow>
                        <SettingRow title="Clear chats" detail="Remove from this browser.">
                          <button
                            type="button"
                            onClick={clearChats}
                            className="inline-flex items-center gap-2 rounded-xl bg-rose-600 px-3.5 py-2 text-[13px] font-medium text-white transition-all hover:bg-rose-500"
                          >
                            <Trash2 className="h-4 w-4" />
                            Clear
                          </button>
                        </SettingRow>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          setTheme("Light");
                          setFontSize("Medium");
                          setUserBubbleColor("#F4F4F4");
                          setOrbColorTheme("default");
                          setSendOnEnter(true);
                          setAutoScroll(true);
                          setMarkdownSupport(true);
                          setCodeHighlighting(true);
                          setTemperature(0.7);
                          setSystemPrompt("");
                          setVoiceRate(0.94);
                          setVoicePitch(1.03);
                          setVoiceVolume(0.96);
                        }}
                        className="mt-4 inline-flex items-center gap-2 rounded-xl border border-slate-200/80 px-3.5 py-2 text-[13px] font-medium text-slate-600 transition-all hover:bg-slate-50"
                      >
                        <RotateCcw className="h-4 w-4" />
                        Reset defaults
                      </button>
                    </>
                  ) : null}
                </motion.div>
              </div>
            </div>
          </motion.section>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
