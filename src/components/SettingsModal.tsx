import { useEffect, useMemo, useRef, useState, type ReactNode, type MouseEvent } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
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
const CAROUSEL_EASE = [0.22, 1, 0.36, 1] as [number, number, number, number];
const QUICK_SPRING = { type: "spring" as const, stiffness: 520, damping: 40, mass: 0.34 };

const ORB_SLOT = 112;
const ORB_VISIBLE = 3;

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

const orbThemes: Array<{ id: OrbColorTheme; label: string }> = [
  { id: "default", label: "Default" },
  { id: "ocean", label: "Ocean" },
  { id: "sunset", label: "Sunset" },
  { id: "forest", label: "Forest" },
  { id: "mono", label: "Mono" },
  { id: "noir", label: "Noir" },
];

const voicePresets = [
  { id: "calm", label: "Max · Calm", detail: "Warm and measured", voice: "Max", rate: 0.88, pitch: 0.98, volume: 0.9 },
  { id: "natural", label: "Max · Natural", detail: "Balanced conversation", voice: "Max", rate: 0.94, pitch: 1.03, volume: 0.96 },
  { id: "bright", label: "Max · Bright", detail: "Clear with more energy", voice: "Max", rate: 1.02, pitch: 1.1, volume: 0.92 },
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
        "group relative h-6 w-11 rounded-full p-0.5 transition-[background-color,box-shadow] duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300",
        checked ? "bg-slate-900" : "bg-slate-200 hover:bg-slate-300/80",
      )}
    >
      <motion.span
        layout
        transition={QUICK_SPRING}
        className={cn(
          "block h-5 w-5 rounded-full bg-white shadow-[0_1px_3px_rgba(15,23,42,0.14)]",
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
    <div className="flex items-center justify-between gap-6 border-b border-slate-200/70 py-4 last:border-0">
      <div className="min-w-0">
        <p className="text-[14px] font-semibold tracking-[-0.01em] text-slate-900">{title}</p>
        {detail ? <p className="mt-1 text-[13px] leading-snug text-slate-500">{detail}</p> : null}
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
  return (
    <div
      aria-label={label}
      className="inline-flex rounded-[10px] border border-slate-200/80 bg-[#f8fafc] p-0.5"
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={String(option.value)}
            type="button"
            onClick={() => onChange(option.value)}
            className={cn(
              "relative min-w-[4.5rem] rounded-[8px] px-3 py-1.5 text-[12.5px] font-semibold transition-colors duration-150",
              active ? "bg-white text-slate-900 shadow-[0_1px_2px_rgba(15,23,42,0.06)]" : "text-slate-500 hover:text-slate-800",
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
        <p className="text-[14px] font-semibold tracking-[-0.01em] text-slate-900">{label}</p>
        <p className="text-[12.5px] text-slate-500">{valueLabel}</p>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-slate-200 accent-slate-900 outline-none"
        style={{
          background: `linear-gradient(90deg, #0f172a ${percent}%, #e2e8f0 ${percent}%)`,
        }}
      />
    </div>
  );
}

function wrapOffset(index: number, selected: number, length: number) {
  let offset = index - selected;
  if (offset > length / 2) offset -= length;
  if (offset < -length / 2) offset += length;
  return offset;
}

function OrbCarousel({
  value,
  onChange,
}: {
  value: OrbColorTheme;
  onChange: (value: OrbColorTheme) => void;
}) {
  const reduceMotion = useReducedMotion();
  const selectedIndex = Math.max(0, orbThemes.findIndex((preset) => preset.id === value));
  const viewportRef = useRef<HTMLDivElement>(null);

  const rotate = (direction: -1 | 1) => {
    const next = (selectedIndex + direction + orbThemes.length) % orbThemes.length;
    onChange(orbThemes[next]!.id);
  };

  useEffect(() => {
    const node = viewportRef.current;
    if (!node) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        const next = (selectedIndex - 1 + orbThemes.length) % orbThemes.length;
        onChange(orbThemes[next]!.id);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        const next = (selectedIndex + 1) % orbThemes.length;
        onChange(orbThemes[next]!.id);
      }
    };
    node.addEventListener("keydown", onKeyDown);
    return () => node.removeEventListener("keydown", onKeyDown);
  }, [onChange, selectedIndex]);

  const transition = reduceMotion
    ? { duration: 0.01 }
    : { duration: 0.48, ease: CAROUSEL_EASE };

  return (
    <div className="clyra-orb-carousel py-2">
      <div className="grid grid-cols-[40px_minmax(0,1fr)_40px] items-center gap-1">
        <button
          type="button"
          onClick={() => rotate(-1)}
          aria-label="Previous orb"
          className="grid h-9 w-9 place-items-center rounded-[10px] border border-slate-200/80 bg-white text-slate-500 transition-[color,background-color,border-color,transform] duration-150 hover:border-slate-300 hover:bg-[#f8fafc] hover:text-slate-900 active:scale-[0.97]"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>

        <div
          ref={viewportRef}
          tabIndex={0}
          role="listbox"
          aria-label="Orb palette"
          aria-activedescendant={`orb-option-${value}`}
          className="relative mx-auto h-[148px] w-full max-w-[336px] overflow-hidden outline-none focus-visible:ring-2 focus-visible:ring-slate-300 focus-visible:ring-offset-2"
        >
          <div className="pointer-events-none absolute inset-y-0 left-0 z-[2] w-10 bg-gradient-to-r from-white to-transparent" />
          <div className="pointer-events-none absolute inset-y-0 right-0 z-[2] w-10 bg-gradient-to-l from-white to-transparent" />

          <div className="absolute inset-0 flex items-center justify-center">
            {orbThemes.map((preset, index) => {
              const offset = wrapOffset(index, selectedIndex, orbThemes.length);
              const visible = Math.abs(offset) <= Math.floor(ORB_VISIBLE / 2);
              const isActive = offset === 0;
              return (
                <motion.button
                  key={preset.id}
                  id={`orb-option-${preset.id}`}
                  type="button"
                  role="option"
                  aria-selected={isActive}
                  aria-label={`${preset.label} orb`}
                  tabIndex={isActive ? 0 : -1}
                  onClick={() => onChange(preset.id)}
                  initial={false}
                  animate={{
                    x: offset * ORB_SLOT,
                    scale: isActive ? 1 : 0.78,
                    opacity: visible ? (isActive ? 1 : 0.48) : 0,
                    filter: isActive ? "blur(0px)" : "blur(0.2px)",
                  }}
                  transition={transition}
                  style={{
                    position: "absolute",
                    width: ORB_SLOT,
                    height: ORB_SLOT,
                    zIndex: visible ? 10 - Math.abs(offset) : 0,
                    pointerEvents: visible ? "auto" : "none",
                  }}
                  className={cn(
                    "grid place-items-center rounded-full outline-none",
                    isActive && "ring-1 ring-slate-200/90 ring-offset-4 ring-offset-white",
                  )}
                >
                  <span className="pointer-events-none block h-[88px] w-[88px]">
                    <AiOrb colorTheme={preset.id} introActive={false} />
                  </span>
                </motion.button>
              );
            })}
          </div>
        </div>

        <button
          type="button"
          onClick={() => rotate(1)}
          aria-label="Next orb"
          className="grid h-9 w-9 place-items-center rounded-[10px] border border-slate-200/80 bg-white text-slate-500 transition-[color,background-color,border-color,transform] duration-150 hover:border-slate-300 hover:bg-[#f8fafc] hover:text-slate-900 active:scale-[0.97]"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>

      <div className="mt-3 flex flex-col items-center gap-3">
        <p className="text-[13.5px] font-semibold tracking-[-0.01em] text-slate-900">
          {orbThemes[selectedIndex]?.label}
        </p>
        <div className="flex items-center gap-1.5" role="tablist" aria-label="Orb pages">
          {orbThemes.map((preset, index) => {
            const active = index === selectedIndex;
            return (
              <button
                key={preset.id}
                type="button"
                role="tab"
                aria-selected={active}
                aria-label={`Go to ${preset.label}`}
                onClick={() => onChange(preset.id)}
                className="group relative grid h-5 w-5 place-items-center"
              >
                <motion.span
                  layout
                  className={cn(
                    "block rounded-full transition-colors duration-150",
                    active ? "h-1.5 w-4 bg-slate-900" : "h-1.5 w-1.5 bg-slate-300 group-hover:bg-slate-400",
                  )}
                  transition={reduceMotion ? { duration: 0.01 } : { duration: 0.28, ease: EASE }}
                />
              </button>
            );
          })}
        </div>
      </div>
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
  const [voicePreviewState, setVoicePreviewState] = useState<"idle" | "loading" | "error">("idle");
  const voicePreviewRef = useRef<{ audio: HTMLAudioElement; url: string } | null>(null);
  const chatCount = chats.length;
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
          data-invert-ignore={theme === "Dark" ? "true" : undefined}
          className="fixed inset-0 z-[100] grid place-items-center p-4 sm:p-6"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.16, ease: EASE }}
        >
          <motion.button
            type="button"
            aria-label="Close settings"
            className="absolute inset-0 bg-slate-950/10 backdrop-blur-[3px]"
            onClick={closeSettings}
            tabIndex={-1}
          />
          <motion.section
            role="dialog"
            aria-modal="true"
            aria-label="Settings"
            initial={{ opacity: 0, y: 14, scale: 0.988 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.992 }}
            transition={{ duration: 0.22, ease: EASE }}
            className="relative grid h-[min(680px,92vh)] w-full max-w-[840px] overflow-hidden rounded-[16px] border border-slate-200/80 bg-white shadow-[0_18px_48px_rgba(15,23,42,0.10)] sm:grid-cols-[236px_1fr]"
          >
            <aside className="hidden border-r border-slate-200/70 bg-[#f8fafc] p-3 sm:flex sm:flex-col">
              <div className="px-3 pb-5 pt-3">
                <p className="text-[18px] font-semibold tracking-[-0.02em] text-slate-900">Settings</p>
                <p className="mt-1 text-[12.5px] leading-snug text-slate-500">
                  How Clyra looks and behaves.
                </p>
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
                        "relative flex w-full items-center gap-2.5 rounded-[10px] px-3 py-2.5 text-left text-[13.5px] font-medium transition-colors duration-150",
                        active
                          ? "bg-white text-slate-900 shadow-[0_1px_2px_rgba(15,23,42,0.05)] ring-1 ring-slate-200/80"
                          : "text-slate-500 hover:bg-white/70 hover:text-slate-800",
                      )}
                    >
                      <Icon className={cn("h-4 w-4", active ? "text-slate-800" : "text-slate-400")} />
                      <span>{section.label}</span>
                    </button>
                  );
                })}
              </nav>
            </aside>

            <div className="flex min-h-0 flex-col bg-white">
              <header className="flex h-14 shrink-0 items-center justify-between border-b border-slate-200/70 px-5 sm:px-8">
                <div className="min-w-0">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-400">Preferences</p>
                  <h2 className="mt-0.5 text-[17px] font-semibold tracking-[-0.02em] text-slate-900">{activeMeta.label}</h2>
                </div>
                <button
                  type="button"
                  onClick={closeSettings}
                  className="grid h-8 w-8 place-items-center rounded-[8px] text-slate-500 transition-colors duration-150 hover:bg-[#f8fafc] hover:text-slate-900"
                  aria-label="Close settings"
                >
                  <X className="h-4 w-4" />
                </button>
              </header>

              <div className="flex gap-1 overflow-x-auto border-b border-slate-200/70 px-4 py-2 sm:hidden">
                {sections.map((section) => (
                  <button
                    key={section.id}
                    type="button"
                    onClick={() => setActiveSection(section.id)}
                    className={cn(
                      "rounded-[8px] px-3 py-1.5 text-[12.5px] font-semibold transition-colors duration-150",
                      section.id === activeSection
                        ? "bg-slate-900 text-white"
                        : "bg-[#f8fafc] text-slate-600 hover:text-slate-900",
                    )}
                  >
                    {section.label}
                  </button>
                ))}
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto px-5 py-2 sm:px-8">
                <motion.div
                  key={activeSection}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.18, ease: EASE }}
                  className="mx-auto max-w-[560px] pb-10"
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
                      <div className="border-b border-slate-200/70 py-5">
                        <p className="text-[14px] font-semibold tracking-[-0.01em] text-slate-900">User bubble</p>
                        <p className="mt-1 text-[13px] text-slate-500">Color for your chat messages.</p>
                        <div className="mt-4 flex flex-wrap items-center gap-2.5">
                          {bubbleColors.map((color) => (
                            <button
                              key={color.value}
                              type="button"
                              onClick={() => setUserBubbleColor(color.value)}
                              title={color.label}
                              className={cn(
                                "h-8 w-8 rounded-full border border-slate-200/80 transition-transform duration-150 hover:scale-[1.04]",
                                userBubbleColor === color.value && "ring-2 ring-slate-900 ring-offset-2",
                              )}
                              style={{ backgroundColor: color.value }}
                            />
                          ))}
                          <label
                            className={cn(
                              "relative grid h-8 w-8 cursor-pointer place-items-center overflow-hidden rounded-full border border-slate-200/80",
                              !bubbleColors.some((color) => color.value === userBubbleColor) &&
                                "ring-2 ring-slate-900 ring-offset-2",
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
                      <div className="py-5">
                        <p className="text-[14px] font-semibold tracking-[-0.01em] text-slate-900">Orb palette</p>
                        <p className="mt-1 text-[13px] text-slate-500">
                          Live orb used across chat and voice. Three at a time — use arrows or dots.
                        </p>
                        <div className="mt-2">
                          <OrbCarousel value={orbColorTheme} onChange={setOrbColorTheme} />
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
                        <span className="rounded-[8px] border border-emerald-200/80 bg-emerald-50 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-emerald-700">
                          Natural
                        </span>
                      </SettingRow>
                      <div className="grid gap-2 border-b border-slate-200/70 py-4 sm:grid-cols-3">
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
                                "rounded-[12px] border p-3 text-left transition-colors duration-150",
                                active
                                  ? "border-slate-900 bg-slate-900 text-white"
                                  : "border-slate-200/80 bg-white hover:bg-[#f8fafc]",
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
                                    "grid h-7 w-7 place-items-center rounded-[8px] transition-colors",
                                    active ? "bg-white/12 text-white" : "bg-[#f8fafc] text-slate-600",
                                  )}
                                >
                                  <Play className="h-3.5 w-3.5" />
                                </span>
                              </div>
                              <p className="mt-3 text-[13px] font-semibold">{preset.label}</p>
                              <p className={cn("mt-1 text-[12px]", active ? "text-white/65" : "text-slate-500")}>
                                {preset.detail}
                              </p>
                            </button>
                          );
                        })}
                      </div>
                      {voicePreviewState !== "idle" ? (
                        <p className={cn("-mt-1 text-[12px] font-medium", voicePreviewState === "error" ? "text-rose-500" : "text-slate-500")}>
                          {voicePreviewState === "loading" ? "Preparing Max voice preview…" : "Async Voice preview is unavailable. Check your server configuration."}
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
                      <div className="grid gap-2 border-b border-slate-200/70 py-4 sm:grid-cols-3">
                        {modelPresets.map((preset) => {
                          const active = Math.abs(temperature - preset.temperature) < 0.01;
                          return (
                            <button
                              key={preset.label}
                              type="button"
                              onClick={() => setTemperature(preset.temperature)}
                              className={cn(
                                "rounded-[12px] border p-3 text-left transition-colors duration-150",
                                active
                                  ? "border-slate-900 bg-slate-900 text-white"
                                  : "border-slate-200/80 bg-white text-slate-700 hover:bg-[#f8fafc]",
                              )}
                            >
                              <p className="text-[13px] font-semibold">{preset.label}</p>
                              <p className={cn("mt-1 text-[12px] leading-snug", active ? "text-white/65" : "text-slate-500")}>
                                {preset.detail}
                              </p>
                            </button>
                          );
                        })}
                      </div>
                      <div className="py-5">
                        <div className="mb-3 flex items-center gap-2">
                          <Type className="h-4 w-4 text-slate-400" />
                          <p className="text-[14px] font-semibold tracking-[-0.01em] text-slate-900">System prompt</p>
                        </div>
                        <textarea
                          value={systemPrompt}
                          onChange={(event) => setSystemPrompt(event.target.value)}
                          placeholder="Add persistent instructions for Clyra..."
                          spellCheck={false}
                          className="h-32 w-full resize-none rounded-[12px] border border-slate-200/80 bg-[#f8fafc] px-4 py-3 text-[14px] leading-relaxed text-slate-800 outline-none transition-colors placeholder:text-slate-400 focus:border-slate-300 focus:bg-white"
                        />
                      </div>
                      <div className="mb-4 flex flex-wrap gap-2">
                        {[
                          "Be concise and practical.",
                          "Ask one clarifying question when needed.",
                          "Prefer polished UI details.",
                        ].map((prompt) => (
                          <button
                            key={prompt}
                            type="button"
                            onClick={() => setSystemPrompt(prompt)}
                            className="rounded-full border border-slate-200/80 bg-white px-3 py-1.5 text-[12.5px] font-medium text-slate-600 transition-colors duration-150 hover:bg-[#f8fafc] hover:text-slate-900"
                          >
                            {prompt}
                          </button>
                        ))}
                      </div>
                      <div className="rounded-[12px] border border-slate-200/80 bg-[#f8fafc] p-3.5 text-[13px] leading-relaxed text-slate-500">
                        <Code2 className="mb-2 h-4 w-4 text-slate-400" />
                        Model routing stays automatic so the app preserves the existing OpenAI-compatible API behavior.
                      </div>
                    </>
                  ) : null}

                  {activeSection === "data" ? (
                    <>
                      <div className="mb-2 rounded-[12px] border border-slate-200/80 bg-[#f8fafc] p-4">
                        <p className="text-[15px] font-semibold tracking-[-0.01em] text-slate-900">{chatCount} saved chats</p>
                        <p className="mt-1 text-[13px] text-slate-500">Export a local copy or clear the current browser history.</p>
                      </div>
                      <SettingRow title="Export chats" detail="Download your chat list as JSON.">
                        <button
                          type="button"
                          onClick={exportChats}
                          className="inline-flex items-center gap-2 rounded-[10px] border border-slate-200/80 bg-white px-3.5 py-2 text-[13px] font-semibold text-slate-700 transition-colors duration-150 hover:bg-[#f8fafc]"
                        >
                          <Download className="h-4 w-4" />
                          Export
                        </button>
                      </SettingRow>
                      <SettingRow title="Clear chats" detail="Remove saved conversations from this browser.">
                        <button
                          type="button"
                          onClick={clearChats}
                          className="inline-flex items-center gap-2 rounded-[10px] bg-rose-600 px-3.5 py-2 text-[13px] font-semibold text-white transition-colors duration-150 hover:bg-rose-500"
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
                        className="mt-3 inline-flex items-center gap-2 rounded-[10px] border border-slate-200/80 px-3.5 py-2 text-[13px] font-semibold text-slate-600 transition-colors duration-150 hover:bg-[#f8fafc] hover:text-slate-900"
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
