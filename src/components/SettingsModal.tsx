import { useEffect, useMemo, useRef, useState, type ReactNode, type MouseEvent } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  Bot,
  ChevronLeft,
  ChevronRight,
  Code2,
  Download,
  Headphones,
  MessageCircle,
  MonitorCog,
  Palette,
  Play,
  RotateCcw,
  Shield,
  Trash2,
  Type,
  X,
} from "lucide-react";
import { cn } from "../lib/utils";
import { AiOrb, type OrbColorTheme } from "./AiOrb";

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
  chats: unknown[];
};

const EASE = [0.16, 1, 0.3, 1] as [number, number, number, number];
const SPRING = { type: "spring" as const, stiffness: 430, damping: 36, mass: 0.45 };
const QUICK_SPRING = { type: "spring" as const, stiffness: 620, damping: 42, mass: 0.32 };

const sections = [
  { id: "look", label: "Appearance", icon: Palette },
  { id: "chat", label: "Conversation", icon: MessageCircle },
  { id: "voice", label: "Voice", icon: Bot },
  { id: "advanced", label: "Model", icon: MonitorCog },
  { id: "data", label: "Privacy", icon: Shield },
] as const;

const bubbleColors = [
  { label: "Mist", value: "#F4F4F4" },
  { label: "Sky", value: "#DBEAFE" },
  { label: "Mint", value: "#DCFCE7" },
  { label: "Lilac", value: "#F3E8FF" },
  { label: "Rose", value: "#FFE4E6" },
];

const orbThemes: Array<{ id: OrbColorTheme; label: string; gradient: string }> = [
  { id: "default", label: "Default", gradient: "conic-gradient(from 45deg,#3b82f6,#2563eb,#22d3ee,#8b5cf6,#3b82f6)" },
  { id: "ocean", label: "Ocean", gradient: "conic-gradient(from 45deg,#0c4a6e,#0284c7,#06b6d4,#0ea5e9,#0c4a6e)" },
  { id: "sunset", label: "Sunset", gradient: "conic-gradient(from 45deg,#f97316,#f472b6,#a855f7,#fb7185,#f97316)" },
  { id: "forest", label: "Forest", gradient: "conic-gradient(from 45deg,#14532d,#16a34a,#2dd4bf,#059669,#14532d)" },
  { id: "mono", label: "Mono", gradient: "conic-gradient(from 45deg,#1e293b,#64748b,#cbd5e1,#94a3b8,#1e293b)" },
  { id: "noir", label: "Noir", gradient: "conic-gradient(from 45deg,#000,#333,#fff,#111,#000)" },
];

const voicePresets = [
  { id: "calm", label: "Ryan · Calm", detail: "Warm and measured", voice: "Ryan", rate: 0.88, pitch: 0.98, volume: 0.9 },
  { id: "natural", label: "Ryan · Natural", detail: "Balanced conversation", voice: "Ryan", rate: 0.94, pitch: 1.03, volume: 0.96 },
  { id: "bright", label: "Aiden · Bright", detail: "Clear with more energy", voice: "Aiden", rate: 1.02, pitch: 1.1, volume: 0.92 },
] as const;

const modelPresets = [
  { label: "Precise", detail: "Shorter, direct answers", temperature: 0.1 },
  { label: "Balanced", detail: "Useful default for most chats", temperature: 0.7 },
  { label: "Creative", detail: "More exploration and variation", temperature: 1 },
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
        "group relative h-6 w-11 rounded-full p-0.5 transition-[background-color,box-shadow,transform] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] hover:scale-[1.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300",
        checked ? "bg-slate-950 shadow-[0_6px_18px_rgba(15,23,42,0.16)]" : "bg-slate-200 hover:bg-slate-300/80",
      )}
    >
      <motion.span
        layout
        transition={SPRING}
        className={cn(
          "block h-5 w-5 rounded-full bg-white shadow-[0_2px_7px_rgba(15,23,42,0.16)] transition-shadow group-hover:shadow-[0_3px_10px_rgba(15,23,42,0.18)]",
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
    <div className="flex items-center justify-between gap-5 border-b border-slate-100/80 py-3.5 last:border-0">
      <div className="min-w-0">
        <p className="text-[13.5px] font-semibold text-slate-950">{title}</p>
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
  label,
}: {
  value: T;
  options: Array<{ label: string; value: T }>;
  onChange: (value: T) => void;
  label: string;
}) {
  const [hovered, setHovered] = useState<T | null>(null);
  return (
    <div aria-label={label} className="inline-flex rounded-full border border-slate-200/70 bg-white p-0.5 shadow-[0_1px_0_rgba(15,23,42,0.03)]">
      {options.map((option) => {
        const active = option.value === value;
        const isHovered = hovered === option.value;
        return (
          <button
            key={String(option.value)}
            type="button"
            onClick={() => onChange(option.value)}
            onMouseEnter={() => setHovered(option.value)}
            onFocus={() => setHovered(option.value)}
            onMouseLeave={() => setHovered(null)}
            onBlur={() => setHovered(null)}
            className={cn(
              "relative min-w-20 rounded-full px-3 py-1.5 text-[12px] font-semibold transition-[color,opacity,transform] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]",
              active ? "text-slate-950" : "text-slate-500 hover:text-slate-900",
            )}
          >
            {isHovered && !active ? (
              <motion.span
                layoutId={`settings-${label}-hover`}
                className="clyra-workflow-tab__hover absolute inset-0 rounded-full"
                transition={QUICK_SPRING}
              />
            ) : null}
            {active ? (
              <motion.span
                layoutId={`settings-${label}`}
                className="absolute inset-0 rounded-full border border-slate-200/70 bg-slate-950 shadow-[0_6px_16px_rgba(15,23,42,0.12)]"
                transition={QUICK_SPRING}
              />
            ) : null}
            <span className={cn("relative", active && "text-white")}>{option.label}</span>
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
    <div className="py-3.5">
      <div className="mb-2 flex items-center justify-between gap-4">
        <div>
          <p className="text-[13.5px] font-semibold text-slate-950">{label}</p>
          <p className="mt-0.5 text-[12px] text-slate-500">{valueLabel}</p>
        </div>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-slate-200 accent-slate-950 outline-none transition-opacity hover:opacity-90"
        style={{
          background: `linear-gradient(90deg, #0f172a ${percent}%, #e2e8f0 ${percent}%)`,
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
  chats,
}: SettingsModalProps) {
  const [activeSection, setActiveSection] = useState<(typeof sections)[number]["id"]>("look");
  const [hoveredSection, setHoveredSection] = useState<(typeof sections)[number]["id"] | null>(null);
  const [voicePreviewState, setVoicePreviewState] = useState<"idle" | "loading" | "error">("idle");
  const voicePreviewRef = useRef<{ audio: HTMLAudioElement; url: string } | null>(null);
  const chatCount = chats.length;
  const selectedOrbIndex = Math.max(0, orbThemes.findIndex((preset) => preset.id === orbColorTheme));
  const rotateOrb = (direction: -1 | 1) => {
    const next = (selectedOrbIndex + direction + orbThemes.length) % orbThemes.length;
    setOrbColorTheme(orbThemes[next]!.id);
  };
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
          text: `Hi, I’m ${preset.voice}. This is how I’ll sound in a natural Clyra conversation.`,
          voice: preset.voice,
        }),
      });
      if (!response.ok) throw new Error("Chatterbox preview is unavailable");
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
          data-invert-ignore={theme === "Dark" ? "true" : undefined}
          className="fixed inset-0 z-[100] grid place-items-center p-3 sm:p-6"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18, ease: EASE }}
        >
          <motion.button
            type="button"
            aria-label="Close settings"
            className="absolute inset-0 bg-slate-950/12 backdrop-blur-[4px]"
            onClick={closeSettings}
            tabIndex={-1}
          />
          <motion.section
            role="dialog"
            aria-modal="true"
            aria-label="Settings"
            initial={{ opacity: 0, y: 16, scale: 0.985, filter: "blur(5px)" }}
            animate={{ opacity: 1, y: 0, scale: 1, filter: "blur(0px)" }}
            exit={{ opacity: 0, y: 10, scale: 0.99, filter: "blur(4px)" }}
            transition={{ type: "spring", stiffness: 420, damping: 38, mass: 0.55 }}
            className="relative grid h-[min(650px,92vh)] w-full max-w-[820px] overflow-hidden rounded-[22px] border border-slate-200/80 bg-white shadow-[0_24px_70px_rgba(15,23,42,0.13)] sm:grid-cols-[224px_1fr]"
          >
            <aside className="hidden border-r border-slate-100 bg-white p-3 sm:block">
              <div className="px-3 pb-4 pt-2">
                <p className="text-[17px] font-semibold tracking-tight text-slate-950">Settings</p>
                <p className="mt-1 text-[12px] leading-snug text-slate-500">Clean controls for how Clyra feels.</p>
              </div>
              <div className="relative space-y-1">
                {sections.map((section) => {
                  const Icon = section.icon;
                  const active = section.id === activeSection;
                  const hovered = hoveredSection === section.id;
                  return (
                    <button
                      key={section.id}
                      type="button"
                      onClick={() => setActiveSection(section.id)}
                      onMouseEnter={() => setHoveredSection(section.id)}
                      onFocus={() => setHoveredSection(section.id)}
                      onMouseLeave={() => setHoveredSection(null)}
                      onBlur={() => setHoveredSection(null)}
                      className={cn(
                        "relative flex w-full items-center gap-3 rounded-full px-3 py-2.5 text-left text-[13px] font-semibold transition-[color,opacity,transform] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]",
                        active ? "text-slate-950" : "text-slate-500 hover:text-slate-900",
                        hoveredSection && !hovered && !active && "opacity-70",
                      )}
                    >
                      {hovered && !active ? (
                        <motion.span
                          layoutId="settings-sidebar-hover"
                          className="absolute inset-0 rounded-full bg-slate-100"
                          transition={QUICK_SPRING}
                        />
                      ) : null}
                      {active ? (
                        <motion.span
                          layoutId="settings-sidebar-active"
                          className="absolute inset-0 rounded-full bg-slate-950"
                          transition={QUICK_SPRING}
                        />
                      ) : null}
                      <Icon className={cn("relative h-4 w-4", active && "text-white")} />
                      <span className={cn("relative", active && "text-white")}>{section.label}</span>
                    </button>
                  );
                })}
              </div>
            </aside>

            <div className="flex min-h-0 flex-col bg-white">
              <header className="flex shrink-0 items-center justify-between border-b border-slate-100 px-5 py-4 sm:px-7">
                <div className="min-w-0">
                  <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-slate-400">Preferences</p>
                  <h2 className="mt-1 text-[20px] font-semibold tracking-tight text-slate-950">{activeMeta.label}</h2>
                </div>
                <button
                  type="button"
                  onClick={closeSettings}
                  className="grid h-9 w-9 place-items-center rounded-full text-slate-500 transition-[background-color,color,transform] duration-300 hover:scale-[1.03] hover:bg-slate-100 hover:text-slate-900"
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
                      "rounded-full px-3 py-1.5 text-[12px] font-semibold transition-colors",
                      section.id === activeSection ? "bg-slate-950 text-white" : "bg-white text-slate-600 hover:bg-slate-100",
                    )}
                  >
                    {section.label}
                  </button>
                ))}
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3 sm:px-7">
                <motion.div
                  key={activeSection}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.14, ease: EASE }}
                  className="mx-auto max-w-[540px] pb-8"
                >
                    {activeSection === "look" ? (
                      <>
                        <SettingRow title="Theme" detail="Choose the app surface tone.">
                          <Segmented
                            label="Theme"
                            value={theme}
                            onChange={setTheme}
                            options={[
                              { label: "Light", value: "Light" },
                              { label: "Dark", value: "Dark" },
                            ]}
                          />
                        </SettingRow>
                        <SettingRow title="Message text" detail="Adjust chat reading size.">
                          <Segmented
                            label="Text size"
                            value={fontSize}
                            onChange={setFontSize}
                            options={[
                              { label: "Small", value: "Small" },
                              { label: "Medium", value: "Medium" },
                              { label: "Large", value: "Large" },
                            ]}
                          />
                        </SettingRow>
                        <div className="border-b border-slate-100 py-4">
                          <p className="text-[13.5px] font-semibold text-slate-950">User bubble</p>
                          <p className="mt-0.5 text-[12.5px] text-slate-500">Pick the color used for your chat messages.</p>
                          <div className="mt-3 flex flex-wrap items-center gap-2">
                            {bubbleColors.map((color) => (
                              <button
                                key={color.value}
                                type="button"
                                onClick={() => setUserBubbleColor(color.value)}
                                title={color.label}
                                className={cn(
                                  "h-8 w-8 rounded-full border border-white shadow-[0_3px_10px_rgba(15,23,42,0.09)] transition-transform duration-300 hover:scale-105",
                                  userBubbleColor === color.value && "ring-2 ring-slate-950 ring-offset-2",
                                )}
                                style={{ backgroundColor: color.value }}
                              />
                            ))}
                            <label
                              className={cn(
                                "relative grid h-9 w-9 cursor-pointer place-items-center overflow-hidden rounded-full border border-slate-200 shadow-[0_4px_14px_rgba(15,23,42,0.08)]",
                                !bubbleColors.some((color) => color.value === userBubbleColor) &&
                                  "ring-2 ring-slate-950 ring-offset-2",
                              )}
                              title="Custom bubble color"
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
                        <div className="py-4">
                          <p className="text-[13.5px] font-semibold text-slate-950">Orb palette</p>
                          <p className="mt-0.5 text-[12.5px] text-slate-500">Choose the live orb used across chat and voice.</p>
                          <div className="mt-4 grid grid-cols-[36px_minmax(0,1fr)_36px] items-center gap-2">
                            <button type="button" onClick={() => rotateOrb(-1)} aria-label="Previous orb palette" className="grid h-9 w-9 place-items-center rounded-full border border-slate-200 bg-white text-slate-500 shadow-sm transition-[border-color,color,transform] hover:scale-[1.04] hover:border-slate-300 hover:text-slate-950"><ChevronLeft className="h-4 w-4" /></button>
                            <div className="relative h-[176px] overflow-hidden rounded-lg border border-slate-200/80 bg-[linear-gradient(180deg,rgba(248,250,252,.85),rgba(255,255,255,.96))]">
                              <AnimatePresence mode="popLayout" initial={false}>
                                <motion.div
                                  key={orbColorTheme}
                                  initial={{ opacity: 0, x: 24, scale: 0.94 }}
                                  animate={{ opacity: 1, x: 0, scale: 1 }}
                                  exit={{ opacity: 0, x: -24, scale: 0.94 }}
                                  transition={QUICK_SPRING}
                                  className="absolute inset-0 grid place-items-center"
                                >
                                  <div className="absolute left-1 top-1/2 -translate-y-1/2 scale-[0.52] opacity-25 blur-[.15px]">
                                    <AiOrb colorTheme={orbThemes[(selectedOrbIndex - 1 + orbThemes.length) % orbThemes.length]!.id} introActive={false} />
                                  </div>
                                  <div className="relative z-10 flex flex-col items-center">
                                    <div className="h-[116px] w-[150px] overflow-visible">
                                      <AiOrb colorTheme={orbColorTheme} introActive={false} />
                                    </div>
                                    <span className="-mt-2 text-[12px] font-semibold text-slate-950">{orbThemes[selectedOrbIndex]?.label}</span>
                                  </div>
                                  <div className="absolute right-1 top-1/2 -translate-y-1/2 scale-[0.52] opacity-25 blur-[.15px]">
                                    <AiOrb colorTheme={orbThemes[(selectedOrbIndex + 1) % orbThemes.length]!.id} introActive={false} />
                                  </div>
                                </motion.div>
                              </AnimatePresence>
                            </div>
                            <button type="button" onClick={() => rotateOrb(1)} aria-label="Next orb palette" className="grid h-9 w-9 place-items-center rounded-full border border-slate-200 bg-white text-slate-500 shadow-sm transition-[border-color,color,transform] hover:scale-[1.04] hover:border-slate-300 hover:text-slate-950"><ChevronRight className="h-4 w-4" /></button>
                          </div>
                          <div className="mt-3 flex justify-center gap-1.5">
                            {orbThemes.map((preset) => <button key={preset.id} type="button" onClick={() => setOrbColorTheme(preset.id)} aria-label={`Select ${preset.label} orb`} className={cn("h-1.5 rounded-full transition-[width,background-color]", preset.id === orbColorTheme ? "w-5 bg-slate-950" : "w-1.5 bg-slate-200 hover:bg-slate-400")} />)}
                          </div>
                        </div>
                      </>
                    ) : null}

                    {activeSection === "chat" ? (
                      <>
                        <SettingRow title="Send on Enter" detail="Use Shift + Enter for a new line.">
                          <Toggle checked={sendOnEnter} onChange={setSendOnEnter} label="Toggle send on Enter" />
                        </SettingRow>
                        <SettingRow title="Auto-scroll" detail="Keep the latest streamed response in view.">
                          <Toggle checked={autoScroll} onChange={setAutoScroll} label="Toggle auto-scroll" />
                        </SettingRow>
                        <SettingRow title="Markdown" detail="Render headings, lists, links, and emphasis.">
                          <Toggle checked={markdownSupport} onChange={setMarkdownSupport} label="Toggle markdown rendering" />
                        </SettingRow>
                        <SettingRow title="Code highlighting" detail="Colorize code blocks when markdown is enabled.">
                          <Toggle checked={codeHighlighting} onChange={setCodeHighlighting} label="Toggle code highlighting" />
                        </SettingRow>
                      </>
                    ) : null}

                    {activeSection === "voice" ? (
                      <>
                        <SettingRow title="Delivery" detail="Natural phrase streaming stays enabled.">
                          <span className="rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-[11px] font-bold uppercase tracking-[0.14em] text-emerald-700">
                            Natural
                          </span>
                        </SettingRow>
                        <div className="grid gap-2 border-b border-slate-100/80 py-3.5 sm:grid-cols-3">
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
                                  "group rounded-[16px] border p-3 text-left transition-[background-color,border-color,transform] duration-300 hover:-translate-y-0.5",
                                  active ? "border-slate-950 bg-slate-950 text-white" : "border-slate-200 bg-white hover:bg-slate-50",
                                )}
                              >
                                <div className="flex items-center justify-between gap-2">
                                  <Headphones className="h-4 w-4" />
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
                                      "grid h-7 w-7 place-items-center rounded-full transition-colors",
                                      active ? "bg-white/12 text-white" : "bg-slate-100 text-slate-600 group-hover:bg-white",
                                    )}
                                  >
                                    <Play className="h-3.5 w-3.5" />
                                  </span>
                                </div>
                                <p className="mt-3 text-[13px] font-semibold">{preset.label}</p>
                                <p className={cn("mt-1 text-[11.5px]", active ? "text-white/65" : "text-slate-500")}>
                                  {preset.detail}
                                </p>
                              </button>
                            );
                          })}
                        </div>
                        {voicePreviewState !== "idle" ? (
                          <p className={cn("-mt-1 text-[11px] font-medium", voicePreviewState === "error" ? "text-rose-500" : "text-blue-600")}>
                            {voicePreviewState === "loading" ? "Preparing Chatterbox preview…" : "Chatterbox preview is unavailable. Check the shared voice worker."}
                          </p>
                        ) : null}
                        <RangeControl
                          label="Pace"
                          value={voiceRate}
                          min={0.82}
                          max={1.08}
                          step={0.01}
                          onChange={setVoiceRate}
                          valueLabel={voiceRate < 0.91 ? "Calmer delivery" : voiceRate > 1 ? "A little quicker" : "Balanced conversation pace"}
                        />
                        <RangeControl
                          label="Warmth"
                          value={voicePitch}
                          min={0.9}
                          max={1.16}
                          step={0.01}
                          onChange={setVoicePitch}
                          valueLabel={voicePitch < 0.99 ? "Lower, steadier tone" : voicePitch > 1.08 ? "Brighter tone" : "Warm natural tone"}
                        />
                        <RangeControl
                          label="Volume"
                          value={voiceVolume}
                          min={0.5}
                          max={1}
                          step={0.01}
                          onChange={setVoiceVolume}
                          valueLabel={`${Math.round(voiceVolume * 100)}% browser speech volume`}
                        />
                      </>
                    ) : null}

                    {activeSection === "advanced" ? (
                      <>
                        <div className="grid gap-2 border-b border-slate-100/80 py-3.5 sm:grid-cols-3">
                          {modelPresets.map((preset) => {
                            const active = Math.abs(temperature - preset.temperature) < 0.01;
                            return (
                              <button
                                key={preset.label}
                                type="button"
                                onClick={() => setTemperature(preset.temperature)}
                                className={cn(
                                  "rounded-[16px] border p-3 text-left transition-[background-color,border-color,transform] duration-300 hover:-translate-y-0.5",
                                  active ? "border-slate-950 bg-slate-950 text-white" : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50",
                                )}
                              >
                                <p className="text-[13px] font-semibold">{preset.label}</p>
                                <p className={cn("mt-1 text-[11.5px] leading-snug", active ? "text-white/65" : "text-slate-500")}>
                                  {preset.detail}
                                </p>
                              </button>
                            );
                          })}
                        </div>
                        <div className="py-4">
                          <div className="mb-3 flex items-center gap-2">
                            <Type className="h-4 w-4 text-slate-500" />
                            <p className="text-[14px] font-semibold text-slate-950">System prompt</p>
                          </div>
                          <textarea
                            value={systemPrompt}
                            onChange={(event) => setSystemPrompt(event.target.value)}
                            placeholder="Add persistent instructions for Clyra..."
                            spellCheck={false}
                            className="h-32 w-full resize-none rounded-[20px] border border-slate-200 bg-slate-50/70 px-4 py-3 text-[13.5px] leading-relaxed text-slate-800 outline-none transition-colors placeholder:text-slate-400 focus:border-slate-300 focus:bg-white"
                          />
                        </div>
                        <div className="mb-3 flex flex-wrap gap-2">
                          {[
                            "Be concise and practical.",
                            "Ask one clarifying question when needed.",
                            "Prefer polished UI details.",
                          ].map((prompt) => (
                            <button
                              key={prompt}
                              type="button"
                              onClick={() => setSystemPrompt(prompt)}
                              className="rounded-full border border-slate-200 px-3 py-1.5 text-[12px] font-semibold text-slate-600 transition-colors hover:bg-slate-50"
                            >
                              {prompt}
                            </button>
                          ))}
                        </div>
                        <div className="rounded-[18px] border border-slate-200 bg-white p-3 text-[12px] leading-relaxed text-slate-500">
                          <Code2 className="mb-2 h-4 w-4 text-slate-500" />
                          Model routing stays automatic so the app preserves the existing OpenAI-compatible API behavior.
                        </div>
                      </>
                    ) : null}

                    {activeSection === "data" ? (
                      <>
                        <div className="rounded-[22px] border border-slate-200 bg-slate-50/70 p-4">
                          <p className="text-[14px] font-semibold text-slate-950">{chatCount} saved chats</p>
                          <p className="mt-1 text-[12.5px] text-slate-500">Export a local copy or clear the current browser history.</p>
                        </div>
                        <SettingRow title="Export chats" detail="Download your chat list as JSON.">
                          <button
                            type="button"
                            onClick={exportChats}
                            className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-4 py-2 text-[13px] font-semibold text-slate-700 transition-colors hover:bg-slate-50"
                          >
                            <Download className="h-4 w-4" />
                            Export
                          </button>
                        </SettingRow>
                        <SettingRow title="Clear chats" detail="Remove saved conversations from this browser.">
                          <button
                            type="button"
                            onClick={clearChats}
                            className="inline-flex items-center gap-2 rounded-full bg-rose-600 px-4 py-2 text-[13px] font-semibold text-white transition-colors hover:bg-rose-500"
                          >
                            <Trash2 className="h-4 w-4" />
                            Clear
                          </button>
                        </SettingRow>
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
                          className="mt-2 inline-flex items-center gap-2 rounded-full border border-slate-200 px-4 py-2 text-[13px] font-semibold text-slate-600 transition-colors hover:bg-slate-50"
                        >
                          <RotateCcw className="h-4 w-4" />
                          Reset useful defaults
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
